import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AssistantServer } from './assistant-server';
import { ConfirmationService } from './confirmation.service';
import { McpController } from './mcp.controller';

/**
 * The assistant: partners working through Claude (BUSINESS_LOGIC §16).
 *
 * Tools reach other domains' services through `AssistantContext.resolve`; a
 * tool task that needs one imports that service's module here.
 */
@Module({
  imports: [AuthModule],
  controllers: [McpController],
  providers: [AssistantServer, ConfirmationService],
})
export class AssistantModule {}
