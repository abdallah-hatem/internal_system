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
import { SuppliersService } from './suppliers.service';
import type { ListQuery } from '../../common/list-query';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';

@ApiTags('Suppliers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('suppliers')
export class SuppliersController {
  constructor(private suppliersService: SuppliersService) {}

  // An investor reads only the suppliers their cycles bought from (R1).
  @Get()
  @ApiOperation({ summary: 'List suppliers with pagination' })
  findAll(@Query() query: ListQuery, @CurrentUser() user: Viewer) {
    return this.suppliersService.findAll(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get supplier details' })
  findById(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.suppliersService.findById(id, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a supplier (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.suppliersService.create(body, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a supplier (CORE_PARTNER only)' })
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.suppliersService.update(id, body, user.id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Delete an unused supplier (CORE_PARTNER only)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.suppliersService.remove(id, user.id);
  }
}
