import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PortalNotifier } from './portal-notifier.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PushService, PortalNotifier],
  exports: [NotificationsService, PushService, PortalNotifier],
})
export class NotificationsModule {}
