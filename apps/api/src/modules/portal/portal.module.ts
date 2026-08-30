import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PortalCatalogueController } from './portal-catalogue.controller';
import { PortalCatalogueService } from './portal-catalogue.service';
import { PortalRequestsController } from './portal-requests.controller';
import { OrderRequestsController } from './order-requests.controller';
import { OrderRequestsService } from './order-requests.service';
import { OrderRequestDecisionsService } from './order-request-decisions.service';
import { SalesModule } from '../sales/sales.module';
import { PortalSignupController } from './portal-signup.controller';
import { PortalImagesController } from './portal-images.controller';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PortalAccountController } from './portal-account.controller';
import { PortalImportsController } from './portal-imports.controller';
import { ImportRequestsService } from './import-requests.service';
import { ImportRequestsAdminController } from './order-requests-imports.controller';
import { PortalSignupService } from './portal-signup.service';
import { OptionalPortalViewerGuard } from '../../common/guards/optional-portal-viewer.guard';

/**
 * Everything a shop owner can reach.
 *
 * Kept in one module rather than added to the existing ones so that what is
 * exposed to the internet is a list you can read in a single file. A portal
 * endpoint hidden among forty internal ones is a portal endpoint nobody
 * reviews.
 *
 * `AuthModule` is imported for `JwtModule`, which the viewer guard needs.
 */
@Module({
  imports: [PrismaModule, AuthModule, SalesModule, FilesModule, NotificationsModule],
  controllers: [
    PortalCatalogueController,
    PortalImagesController,
    PortalSignupController,
    PortalAccountController,
    PortalImportsController,
    PortalRequestsController,
    OrderRequestsController,
    ImportRequestsAdminController,
  ],
  providers: [
    PortalCatalogueService,
    PortalSignupService,
    OrderRequestsService,
    ImportRequestsService,
    OrderRequestDecisionsService,
    OptionalPortalViewerGuard,
  ],
})
export class PortalModule {}
