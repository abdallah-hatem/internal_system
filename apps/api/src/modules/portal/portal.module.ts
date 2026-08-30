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
  imports: [PrismaModule, AuthModule, SalesModule],
  controllers: [PortalCatalogueController, PortalRequestsController, OrderRequestsController],
  providers: [
    PortalCatalogueService,
    OrderRequestsService,
    OrderRequestDecisionsService,
    OptionalPortalViewerGuard,
  ],
})
export class PortalModule {}
