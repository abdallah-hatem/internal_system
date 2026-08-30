import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { PortalCatalogueService } from './portal-catalogue.service';
import { Surface } from '../../common/surface';
import { OptionalPortalViewerGuard } from '../../common/guards/optional-portal-viewer.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * The shop window.
 *
 * Public, so a visitor can see what is carried before deciding whether to sign
 * up — but a signed-in verified shop browsing the same pages sees its own
 * prices, which is what `OptionalPortalViewerGuard` is for. Neither route
 * accepts a customer id; the only way a price changes is by presenting a token
 * that says who you are.
 */
@ApiTags('Portal')
@Surface('public')
@UseGuards(OptionalPortalViewerGuard)
@Controller('portal')
export class PortalCatalogueController {
  constructor(private catalogue: PortalCatalogueService) {}

  @Get('catalogue')
  @ApiOperation({ summary: 'Browse the products on offer' })
  list(
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @CurrentUser() user?: { customerId?: string },
  ) {
    return this.catalogue.list(
      {
        search,
        categoryId,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
      user?.customerId,
    );
  }

  @Get('categories')
  @ApiOperation({ summary: 'The categories the catalogue can be filtered by' })
  categories() {
    return this.catalogue.categories();
  }

  @Get('catalogue/:sku')
  @ApiOperation({ summary: 'One product' })
  bySku(@Param('sku') sku: string, @CurrentUser() user?: { customerId?: string }) {
    return this.catalogue.bySku(sku, user?.customerId);
  }
}
