import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Redirect,
  Req,
  UseFilters,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { Surface } from '../../common/surface';
import { OAuthFailureFilter } from './oauth-failure';
import { OAuthService } from './oauth.service';

/**
 * Bodies and queries here are read as plain records, not DTOs, on purpose.
 * RFC 6749 §3.1 says an authorization server MUST ignore parameters it does
 * not recognise, and Claude sends some (`resource`, `scope`); the global
 * `forbidNonWhitelisted` pipe would refuse them in a shape no OAuth client
 * reads. Every parameter used is checked in the service, by `param()`.
 *
 * All of it is `public` to SurfaceGuard: these are the routes a client uses
 * before it has a token.
 */
type Params = Record<string, unknown>;

const origin = (req: Request) => ({
  headers: req.headers,
  protocol: req.protocol,
});

@ApiExcludeController()
@Surface('public')
@UseFilters(OAuthFailureFilter)
@Controller('.well-known')
export class WellKnownController {
  constructor(private oauth: OAuthService) {}

  /**
   * RFC 9728 lets a client ask at the bare path or at the resource's own path
   * appended (`/mcp`); both answer the same.
   */
  @Get(['oauth-protected-resource', 'oauth-protected-resource/mcp'])
  protectedResource(@Req() req: Request) {
    return this.oauth.protectedResource(origin(req));
  }

  @Get('oauth-authorization-server')
  authorizationServer(@Req() req: Request) {
    return this.oauth.authorizationServer(origin(req));
  }
}

@ApiExcludeController()
@Surface('public')
@UseFilters(OAuthFailureFilter)
@Controller('oauth')
export class OAuthController {
  constructor(private oauth: OAuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() body: Params) {
    return this.oauth.register(body);
  }

  @Get('authorize')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Frame-Options', 'DENY')
  @Header('Content-Security-Policy', "frame-ancestors 'none'")
  authorizePage(@Query() query: Params) {
    return this.oauth.authorizePage(query);
  }

  /** Back to Claude with a code; every refusal is thrown and drawn as a page. */
  @Post('authorize')
  @Redirect()
  async signIn(@Body() body: Params) {
    return { url: await this.oauth.signIn(body), statusCode: HttpStatus.FOUND };
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  token(@Body() body: Params) {
    return this.oauth.token(body);
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@Body() body: Params) {
    return this.oauth.revoke(body);
  }
}
