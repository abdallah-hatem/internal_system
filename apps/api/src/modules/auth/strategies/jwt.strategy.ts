import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

import { unauthorized } from '../../../common/api-error';
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { partner: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw unauthorized('SESSION_INVALID', 'Your session is no longer valid');
    }
    // `customerId` rides on portal tokens only, and is the shop whose data the
    // session may see. Read from the token rather than looked up per request:
    // it is signed, so it cannot be swapped, and having it here means no portal
    // endpoint ever needs to accept a customer id from the caller.
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      partner: user.partner,
      customerId: payload.customerId as string | undefined,
    };
  }
}
