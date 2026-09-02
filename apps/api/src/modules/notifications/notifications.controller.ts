import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('notifications')
export class NotificationsController {
  constructor(
    private notificationsService: NotificationsService,
    private push: PushService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get current user notifications' })
  findAll(
    @CurrentUser() user: any,
    @Query() query: PaginationDto & { unreadOnly?: boolean },
  ) {
    return this.notificationsService.findAll(user.id, query);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  markAsRead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.notificationsService.markAsRead(id, user.id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllAsRead(@CurrentUser() user: any) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  /**
   * Web push for the office, the same machinery the storefront already uses.
   *
   * `PushService` was never portal-specific — it keys subscriptions on a user
   * id — so this is three routes rather than a second implementation. What the
   * office needs it for is different: a shop asking to buy, or asking for an
   * import, is time-sensitive in a way the bell alone does not convey when
   * nobody has the tab open.
   */
  @Get('push-key')
  @ApiOperation({
    summary:
      'The VAPID public key this browser needs to subscribe. Null when push ' +
      'is not configured, which the client reads as "do not offer alerts".',
  })
  pushKey() {
    return { data: { publicKey: this.push.publicKey() } };
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
