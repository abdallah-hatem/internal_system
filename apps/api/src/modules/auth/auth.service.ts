import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PortalLoginDto } from './dto/portal-login.dto';

import { badRequest, conflict, unauthorized } from '../../common/api-error';
@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { partner: true },
    });
    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    // The office login is not the shop's. Sending them to the right door is
    // kinder than a wrong-password error, and it means an internal token can
    // never be minted for a portal account even if the audience check on the
    // route were one day removed.
    if (user.role === 'SHOP_OWNER_PORTAL') {
      throw unauthorized('USE_PORTAL_LOGIN', 'Shop accounts sign in on the store, not here.');
    }

    if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_INACTIVE', 'Account is not active');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      data: {
        // `audience` is what SurfaceGuard reads. A token without one reaches
        // nothing, which is the point: every token now names the system it
        // was issued for.
        accessToken: this.jwtService.sign(payload, { audience: 'internal' }),
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          displayName: user.partner?.displayName,
        },
      },
    };
  }

  /**
   * The shop's door.
   *
   * The customer id goes into the token because every portal endpoint needs to
   * know whose data it is looking at, and taking it from the request instead
   * would mean twenty places that each have to remember to check. Ownership is
   * checked far less often than amounts; the way not to forget it is to make
   * naming someone else unrepresentable.
   *
   * Verification is reported, not enforced here. An unverified shop may sign
   * in and browse — it just cannot put anything on hold, and the services that
   * move money refuse it. Refusing the login instead would leave a shop that
   * has just signed up staring at a password box that will never work.
   */
  async portalLogin(dto: PortalLoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { portalCustomer: true },
    });
    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    if (user.role !== 'SHOP_OWNER_PORTAL') {
      throw unauthorized('USE_INTERNAL_LOGIN', 'Office accounts sign in on the internal system.');
    }
    if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_INACTIVE', 'Account is not active');

    const customer = user.portalCustomer;
    if (!customer) {
      // A portal user with no shop can be shown nothing. Saying so is what
      // stops the next person hunting for a typo in the password.
      throw unauthorized('PORTAL_ACCOUNT_INCOMPLETE', 'This account is not linked to a shop yet.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      data: {
        accessToken: this.jwtService.sign(
          { sub: user.id, email: user.email, role: user.role, customerId: customer.id },
          { audience: 'portal' },
        ),
        user: {
          id: user.id,
          email: user.email,
          customerId: customer.id,
          displayName: customer.displayName,
          verified: customer.verificationStatus === 'VERIFIED',
        },
      },
    };
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw conflict('EMAIL_TAKEN', 'Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        role: dto.role as any,
        partner: dto.role === 'CORE_PARTNER' ? {
          create: { displayName: dto.displayName },
        } : undefined,
      },
      include: { partner: true },
    });

    // No access token. This creates somebody else's account — handing the
    // caller a token for it would mean a partner adding a colleague walks away
    // able to act as them. Signing in is that person's own business.
    return {
      data: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.partner?.displayName,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { partner: true },
    });
    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'User not found');

    const { passwordHash, ...result } = user;
    return { data: result };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'User not found');

    const isPasswordValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isPasswordValid) throw badRequest('WRONG_CURRENT_PASSWORD', 'Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { data: { message: 'Password changed successfully' } };
  }
}
