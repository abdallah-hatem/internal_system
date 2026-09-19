import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AssistantConnectionsController } from './assistant-connections.controller';
import { OAuthController, WellKnownController } from './oauth.controller';
import { OAUTH_CLOCK, OAuthService, type Clock } from './oauth.service';

/**
 * The door Claude signs partners in through. `main.ts` keeps its routes out
 * of the `api/v1` prefix, where OAuth clients look for them.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    WellKnownController,
    OAuthController,
    AssistantConnectionsController,
  ],
  providers: [
    OAuthService,
    { provide: OAUTH_CLOCK, useValue: (() => new Date()) satisfies Clock },
  ],
})
export class OAuthModule {}
