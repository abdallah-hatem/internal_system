import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { NotificationsService } from '../notifications/notifications.service';
import { Surface } from '../../common/surface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * A shop's own bell.
 *
 * `/notifications` is an internal-surface route, so a portal token is refused
 * there — the fence doing its job, and the second time this session that my own
 * URL was the thing that was wrong. A shop could be notified and then could not
 * read the notification.
 *
 * The service is the same one the office uses and it is already scoped by user
 * id, which is taken from the token here. There is no route on which a shop can
 * name someone else's notifications, because there is no parameter for it.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@Surface('portal')
@UseGuards(AuthGuard('jwt'))
@Controller('portal/notifications')
export class PortalNotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'This shop’s notifications, newest first' })
  list(
    @CurrentUser() user: { id: string },
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.findAll(user.id, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one as read' })
  markRead(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.notifications.markAsRead(id, user.id);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark everything read' })
  markAllRead(@CurrentUser() user: { id: string }) {
    return this.notifications.markAllAsRead(user.id);
  }
}
