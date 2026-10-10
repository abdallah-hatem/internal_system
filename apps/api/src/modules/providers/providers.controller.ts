import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';

@ApiTags('Providers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('providers')
export class ProvidersController {
  constructor(private providersService: ProvidersService) {}

  // An investor reads only the providers that carried their cycles (R1).
  @Get()
  @ApiOperation({ summary: 'List all providers' })
  findAll(@CurrentUser() user: Viewer) {
    return this.providersService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get provider details' })
  findById(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.providersService.findById(id, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a provider (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.providersService.create(body, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a provider (CORE_PARTNER only)' })
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.providersService.update(id, body, user.id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Delete a provider (CORE_PARTNER only)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.providersService.remove(id, user.id);
  }
}
