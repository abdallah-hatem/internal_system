import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { OAuthService } from './oauth.service';

/**
 * Settings → Claude connections, in the office app (BUSINESS_LOGIC §16:
 * revocable, one device or all, without changing the password).
 *
 * Internal surface — it declares none, so SurfaceGuard refuses an `mcp` token
 * with WRONG_SURFACE: the assistant cannot see or end its own grants. Core
 * partners only, because only they can connect Claude in the first place.
 *
 * Every read and write is scoped by the caller's id from the token. The `:id`
 * is a client id and says which of *their* connections, never whose.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER')
@Controller('auth/assistant-connections')
export class AssistantConnectionsController {
  constructor(private oauth: OAuthService) {}

  @Get()
  @ApiOperation({ summary: 'The Claude apps this partner has connected' })
  list(@CurrentUser() user: { id: string }) {
    return this.oauth.listConnections(user.id);
  }

  @Delete()
  @ApiOperation({
    summary: 'Disconnect every Claude app this partner connected',
  })
  disconnectAll(@CurrentUser() user: { id: string }) {
    return this.oauth.disconnectAll(user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Disconnect one Claude app' })
  disconnect(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.oauth.disconnect(user.id, id);
  }
}
