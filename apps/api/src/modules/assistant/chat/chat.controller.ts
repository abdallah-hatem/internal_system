import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../../common/guards/roles.guard';
import { AssistantChatService } from './chat.service';

/**
 * The office app's chat (owner 2026-10-20, built 2026-10-25). Core partners
 * only — the same as the assistant (§16), and since 2026-10-21 nobody else
 * signs in to the office anyway.
 */
@ApiTags('Assistant chat')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER')
@Controller('assistant/chat')
export class AssistantChatController {
  constructor(private readonly chat: AssistantChatService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Whether the chat is set up, and today’s allowance used',
  })
  readStatus() {
    return this.chat.currentStatus();
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Ask the assistant: the recent conversation in, its answer and any previews to confirm out. Nothing is written.',
  })
  ask(
    @CurrentUser() user: { id: string },
    @Body() body: { messages?: unknown },
  ) {
    return this.chat.chat(user.id, body);
  }

  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'The Confirm button: commit a preview the chat showed, with its token',
  })
  confirm(
    @CurrentUser() user: { id: string },
    @Body() body: { tool?: unknown; args?: unknown; token?: unknown },
  ) {
    return this.chat.confirm(user.id, body);
  }
}
