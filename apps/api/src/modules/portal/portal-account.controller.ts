import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { PushService } from '../notifications/push.service';
import { notFound } from '../../common/api-error';
import { Surface } from '../../common/surface';
import { CurrentShop } from '../../common/decorators/current-shop.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * The shop's own account, and the devices it wants alerts on.
 *
 * The VAPID key is served rather than baked into the storefront's build: it is
 * public by definition, but shipping it as a build-time constant means rotating
 * it requires a redeploy of the store rather than a restart of the API.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@Surface('portal')
@UseGuards(AuthGuard('jwt'))
@Controller('portal')
export class PortalAccountController {
  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'This shop, and whether it has been verified' })
  async me(@CurrentShop() customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        displayName: true,
        type: true,
        phone: true,
        email: true,
        verificationStatus: true,
      },
    });
    if (!customer) throw notFound('customer');

    return {
      data: {
        id: customer.id,
        displayName: customer.displayName,
        phone: customer.phone,
        email: customer.email,
        verified: customer.verificationStatus === 'VERIFIED',
        // The key the browser needs to subscribe. Null when push is not
        // configured, which the account screen reads as "do not offer alerts"
        // rather than showing a button that cannot work.
        pushPublicKey: this.push.publicKey(),
      },
    };
  }

  @Post('push-subscriptions')
  @ApiOperation({ summary: 'Register this browser for alerts' })
  subscribe(
    @CurrentUser() user: { id: string },
    @Req() req: Request,
    @Body() body: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    return this.push.subscribe(user.id, body, req.headers['user-agent']);
  }

  @Delete('push-subscriptions')
  @ApiOperation({ summary: 'Stop alerts on this browser' })
  unsubscribe(@CurrentUser() user: { id: string }, @Body() body: { endpoint: string }) {
    return this.push.unsubscribe(user.id, body.endpoint);
  }
}
