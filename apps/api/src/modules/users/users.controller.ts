import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'List all users' })
  findAll(@Query() query: PaginationDto & { role?: string; status?: string }) {
    return this.usersService.findAll(query);
  }

  // Declared before ':id' — Nest matches routes in order, so the other way
  // round "participation" is read as a user id and returns a 404.
  @Get('participation')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Per-partner capital, profit share and cycles' })
  participation() {
    return this.usersService.participation();
  }

  /**
   * A temporary investor from a name alone — the `+` beside the Funding
   * card's person picker (§8, owner 2026-10-26). Only `displayName` is read:
   * the role is always TEMP_INVESTOR whatever else is sent, so this is never
   * a way to make a partner (CLAUDE.md §12). The body is not a DTO class on
   * purpose — the global pipe would refuse an extra `role` outright, where
   * the rule is that it is ignored.
   */
  @Post('investors')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a temporary investor from a name' })
  createInvestor(@Body() body: { displayName?: unknown }) {
    return this.usersService.createInvestor(body?.displayName);
  }

  @Get(':id')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Post()
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a new user' })
  create(@Body() body: { email: string; password: string; role: string; displayName?: string }) {
    return this.usersService.create(body);
  }

  @Put(':id')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update user' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.usersService.update(id, body);
  }

  @Delete(':id')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Deactivate user' })
  deactivate(@Param('id') id: string) {
    return this.usersService.deactivate(id);
  }
}
