import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CATEGORY_CREATE_ROLES } from './category-roles';
import { type ListQuery, pageOf } from '../../common/list-query';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import type { ProductListFilters } from './product-list-where';

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List products with filtering and pagination' })
  findAll(
    @Query()
    query: ListQuery & {
      categoryId?: string;
      status?: string;
    },
    @CurrentUser() user: Viewer,
  ) {
    return this.productsService.findAll(query, user);
  }

  /**
   * The Products tab's cards: how many products the list's filters match and
   * the units they hold in stock, for the whole filtered set. Stock is the
   * office's, as the Inventory tab's card (core partners and support).
   */
  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({
    summary:
      'Products matching the list’s search, category and status, and their units in stock',
  })
  summary(@Query() query: ProductListFilters) {
    return this.productsService.summary(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product details' })
  findById(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.productsService.findById(id, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a new product (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.productsService.create(body, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a product (CORE_PARTNER only)' })
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.productsService.update(id, body, user.id);
  }

  @Put(':id/status')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Deactivate or reactivate a product: { status: ACTIVE | INACTIVE } (CORE_PARTNER only)',
  })
  setStatus(
    @Param('id') id: string,
    @Body() body: { status?: unknown },
    @CurrentUser() user: { id: string },
  ) {
    return this.productsService.setStatus(id, body?.status, user.id);
  }

  @Post(':id/prices')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Set price for a product channel' })
  setPrice(
    @Param('id') id: string,
    @Body()
    body: { channel: string; currency: string; amount: number },
    @CurrentUser() user: any,
  ) {
    return this.productsService.setPrice(id, body, user.id);
  }

  @Get(':id/prices')
  @ApiOperation({ summary: 'Get price history for a product' })
  getPriceHistory(@Param('id') id: string) {
    return this.productsService.getPriceHistory(id);
  }
}

@ApiTags('Categories')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('categories')
export class CategoriesController {
  constructor(private productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all categories; with page/pageSize, the list as a tree a page at a time',
  })
  findCategories(@Query() query: ListQuery & { collapsed?: string }) {
    return pageOf(query)
      ? this.productsService.categoryPage(query)
      : this.productsService.findCategories();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get category by ID' })
  findCategoryById(@Param('id') id: string) {
    return this.productsService.findCategoryById(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(...CATEGORY_CREATE_ROLES)
  @ApiOperation({ summary: 'Create a category (CORE_PARTNER only)' })
  createCategory(
    @Body() body: { name: string; nameAr?: string | null; parentId?: string },
    @CurrentUser() user: any,
  ) {
    return this.productsService.createCategory(body, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a category (CORE_PARTNER only)' })
  updateCategory(
    @Param('id') id: string,
    @Body()
    body: { name?: string; nameAr?: string | null; parentId?: string | null },
    @CurrentUser() user: any,
  ) {
    return this.productsService.updateCategory(id, body, user.id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Delete a category (CORE_PARTNER only)' })
  removeCategory(@Param('id') id: string, @CurrentUser() user: any) {
    return this.productsService.removeCategory(id, user.id);
  }
}
