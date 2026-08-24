import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

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

    if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_INACTIVE', 'Account is not active');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      data: {
        accessToken: this.jwtService.sign(payload),
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          displayName: user.partner?.displayName,
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

    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      data: {
        accessToken: this.jwtService.sign(payload),
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          displayName: user.partner?.displayName,
        },
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
