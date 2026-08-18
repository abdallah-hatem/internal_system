import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

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
    query: PaginationDto & {
      categoryId?: string;
      status?: string;
      search?: string;
    },
  ) {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product details' })
  findById(@Param('id') id: string) {
    return this.productsService.findById(id);
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
  @ApiOperation({ summary: 'List all categories' })
  findCategories() {
    return this.productsService.findCategories();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a category (CORE_PARTNER only)' })
  createCategory(@Body() body: { name: string; parentId?: string }, @CurrentUser() user: any) {
    return this.productsService.createCategory(body, user.id);
  }
}
