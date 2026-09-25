import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Surface } from '../../common/surface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistantServer } from './assistant-server';
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter';
import type { AssistantUser } from './tool-kit';

/**
 * `/mcp` — the assistant's only door.
 *
 * `@Surface('mcp')` makes `SurfaceGuard` accept an assistant token here and
 * nowhere else, and admit only an active core partner, whom it leaves on the
 * request. The MCP transport writes the response itself (JSON-RPC, not the
 * API's envelope), which is why this controller takes the raw response.
 */
@Surface('mcp')
@UseFilters(McpAuthChallengeFilter)
@Controller('mcp')
export class McpController {
  constructor(private readonly assistant: AssistantServer) {}

  @Post()
  post(
    @Req() req: Request,
    // eslint-disable-next-line no-restricted-syntax -- the MCP transport streams its own JSON-RPC response; there is no value to return
    @Res() res: Response,
    @CurrentUser() user: AssistantUser,
  ): Promise<void> {
    return this.assistant.serve(req, res, user);
  }

  @Get()
  get(
    @Req() req: Request,
    // eslint-disable-next-line no-restricted-syntax -- the MCP transport streams its own JSON-RPC response; there is no value to return
    @Res() res: Response,
    @CurrentUser() user: AssistantUser,
  ): Promise<void> {
    return this.assistant.serve(req, res, user);
  }

  @Delete()
  delete(
    @Req() req: Request,
    // eslint-disable-next-line no-restricted-syntax -- the MCP transport streams its own JSON-RPC response; there is no value to return
    @Res() res: Response,
    @CurrentUser() user: AssistantUser,
  ): Promise<void> {
    return this.assistant.serve(req, res, user);
  }
}
