import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { publicBaseUrl } from '../../common/public-base-url';

/**
 * A 401 on `/mcp` tells the client where to sign in.
 *
 * An MCP client that is refused reads `WWW-Authenticate` for the protected
 * resource's metadata, and from there finds the authorization server. Without
 * the header, claude.ai has no way to start the OAuth flow and the connector
 * simply fails. The refusal itself — AUTH_REQUIRED or SESSION_INVALID from
 * `SurfaceGuard` — is rendered exactly as everywhere else.
 *
 * Scoped to the MCP controller, it still sees the global guard's refusal: Nest
 * runs guards inside the route's exception zone.
 */
@Injectable()
@Catch(UnauthorizedException)
export class McpAuthChallengeFilter implements ExceptionFilter {
  private readonly render = new AllExceptionsFilter();

  constructor(private readonly config: ConfigService) {}

  catch(exception: UnauthorizedException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const base = publicBaseUrl(
      this.config.get<string>('PUBLIC_BASE_URL'),
      request,
    );
    http
      .getResponse<Response>()
      .setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      );
    this.render.catch(exception, host);
  }
}
