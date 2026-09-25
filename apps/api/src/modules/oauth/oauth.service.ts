import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from '../../prisma/unique-violation';
import { AuthService } from '../auth/auth.service';
import { OAuthFailure, protocolError } from './oauth-failure';
import {
  ACCESS_TTL_SECONDS,
  CODE_AUDIENCE,
  CODE_NONCE_KIND,
  CODE_TTL_SECONDS,
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  MAX_STATE_LENGTH,
  REFRESH_TTL_MS,
  connectionsFrom,
  hashToken,
  isAllowedRedirectUri,
  isUuid,
  isValidCodeChallenge,
  isValidCodeVerifier,
  newRefreshToken,
  param,
  redirectWith,
  verifierMatches,
} from './oauth.pure';
import { publicBaseUrl } from '../../common/public-base-url';
import { notFound } from '../../common/api-error';
import {
  PageError,
  PageLang,
  pageLang,
  renderErrorPage,
  renderSignInPage,
} from './sign-in-page';

/**
 * What time it is. Injected so the five-minute code and the thirty-day refresh
 * token can be tested at minute six and day thirty-one without waiting.
 */
export const OAUTH_CLOCK = Symbol('OAUTH_CLOCK');
export type Clock = () => Date;

type Params = Record<string, unknown>;

/** What the headers of the request that asked are, for the base URL. */
export interface RequestOrigin {
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
}

/** An authorization request that has passed every check. */
interface AuthorizeRequest {
  lang: PageLang;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** Carried through the form so the page can be shown again intact. */
  fields: Record<string, string | undefined>;
}

/** What a signed authorization code carries. Nothing about it is stored. */
interface CodeClaims {
  sub: string;
  /** The client it was issued to. */
  cid: string;
  /** The redirect URI it was issued for. */
  ru: string;
  /** The PKCE challenge the verifier must answer. */
  cc: string;
  jti: string;
  exp: number;
}

const invalidGrant = (why: string) => protocolError('invalid_grant', why);

/**
 * The OAuth 2.1 authorization server Claude signs partners in through.
 *
 * Public clients only: Claude cannot keep a secret, so PKCE (S256) is the proof
 * that whoever redeems a code is who asked for it. Codes are signed JWTs with a
 * jti spent into `UsedNonce`; refresh tokens are random, stored hashed, and
 * rotate on every use. Access tokens are `AuthService.issueAssistantToken` —
 * audience `mcp`, good on the assistant's routes and nowhere else.
 */
@Injectable()
export class OAuthService {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
    private jwt: JwtService,
    private config: ConfigService,
    @Inject(OAUTH_CLOCK) private now: Clock,
  ) {}

  // ------------------------------------------------------------ metadata

  baseUrl(origin: RequestOrigin): string {
    return publicBaseUrl(this.config.get<string>('PUBLIC_BASE_URL'), origin);
  }

  /** RFC 9728: where the assistant is, and who issues its tokens. */
  protectedResource(origin: RequestOrigin) {
    const base = this.baseUrl(origin);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'MotoParts',
    };
  }

  /** RFC 8414: every URL absolute, on the host the client reached. */
  authorizationServer(origin: RequestOrigin) {
    const base = this.baseUrl(origin);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
    };
  }

  // ------------------------------------------------------------ register

  /**
   * RFC 7591 dynamic registration. Open, because claude.ai registers itself;
   * safe because the only redirect URIs it accepts are Claude's own.
   *
   * Grant types, response types and the auth method a client asks for are not
   * negotiated: the answer states what this server does, which is the one flow
   * Claude uses. A client asking for a secret gets `none` — there is none.
   */
  async register(body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Params;
    const uris = b.redirect_uris;

    if (!Array.isArray(uris) || uris.length === 0) {
      throw protocolError(
        'invalid_redirect_uri',
        'At least one redirect URI is required.',
      );
    }
    if (uris.length > MAX_REDIRECT_URIS) {
      throw protocolError(
        'invalid_redirect_uri',
        `At most ${MAX_REDIRECT_URIS} redirect URIs can be registered.`,
      );
    }
    for (const uri of uris) {
      if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
        throw protocolError(
          'invalid_redirect_uri',
          'Only Claude’s own callbacks can be registered.',
        );
      }
    }

    const name = b.client_name;
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length > MAX_CLIENT_NAME_LENGTH)
    ) {
      throw protocolError(
        'invalid_client_metadata',
        `client_name must be text of at most ${MAX_CLIENT_NAME_LENGTH} characters.`,
      );
    }

    const client = await this.prisma.oAuthClient.create({
      data: {
        clientName: name?.trim() || null,
        redirectUris: [...new Set(uris as string[])],
      },
      select: {
        id: true,
        clientName: true,
        redirectUris: true,
        createdAt: true,
      },
    });

    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      ...(client.clientName ? { client_name: client.clientName } : {}),
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ----------------------------------------------------------- authorize

  /** GET /oauth/authorize — the sign-in page, once the request checks out. */
  async authorizePage(query: Params): Promise<string> {
    const request = await this.checkAuthorizeRequest(query);
    return renderSignInPage({ lang: request.lang, fields: request.fields });
  }

  /**
   * POST /oauth/authorize — the partner's login. The whole request is checked
   * again: the form's hidden fields came back from the browser and are the
   * caller's to edit.
   *
   * Returns where to send the browser: back to Claude with a code.
   */
  async signIn(body: Params): Promise<string> {
    const request = await this.checkAuthorizeRequest(body);
    const email = param(body, 'email')?.trim() ?? '';
    const password = param(body, 'password') ?? '';

    const again = (status: number, error: PageError) =>
      new OAuthFailure({
        kind: 'html',
        status,
        html: renderSignInPage({
          lang: request.lang,
          fields: request.fields,
          error,
          email,
        }),
      });

    const user =
      email && password ? await this.auth.checkPassword(email, password) : null;
    if (!user) throw again(401, 'wrong_credentials');
    // Asked only once the password is right, so the page cannot be used to
    // find out what kind of account an email belongs to.
    if (user.role !== 'CORE_PARTNER') throw again(403, 'partners_only');
    if (user.status !== 'ACTIVE') throw again(403, 'inactive');

    const code = this.jwt.sign(
      {
        sub: user.id,
        cid: request.clientId,
        ru: request.redirectUri,
        cc: request.codeChallenge,
        iat: this.seconds(),
      },
      {
        audience: CODE_AUDIENCE,
        expiresIn: CODE_TTL_SECONDS,
        jwtid: randomUUID(),
      },
    );

    return redirectWith(request.redirectUri, { code, state: request.state });
  }

  /**
   * The order matters. Until the client and its redirect URI are verified,
   * every failure is a page: redirecting to an unverified address would hand
   * an attacker's site whatever came next. After that, failures go back to
   * the client as RFC 6749 §4.1.2.1 errors, which is how Claude hears them.
   */
  private async checkAuthorizeRequest(p: Params): Promise<AuthorizeRequest> {
    const lang = pageLang(param(p, 'lang'));
    const page = (error: PageError) =>
      new OAuthFailure({
        kind: 'html',
        status: 400,
        html: renderErrorPage(lang, error),
      });

    const clientId = param(p, 'client_id');
    const client = isUuid(clientId)
      ? await this.prisma.oAuthClient.findUnique({
          where: { id: clientId },
          select: { id: true, redirectUris: true },
        })
      : null;
    if (!client) throw page('unknown_client');

    const redirectUri = param(p, 'redirect_uri');
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw page('unregistered_redirect');
    }

    const rawState = param(p, 'state');
    const state =
      rawState !== undefined && rawState.length <= MAX_STATE_LENGTH
        ? rawState
        : undefined;
    const back = (error: string, description: string) =>
      new OAuthFailure({
        kind: 'redirect',
        url: redirectWith(redirectUri, {
          error,
          error_description: description,
          state,
        }),
      });

    if (rawState !== undefined && state === undefined) {
      throw back('invalid_request', 'state is too long.');
    }
    if (param(p, 'response_type') !== 'code') {
      throw back('unsupported_response_type', 'Only response_type=code.');
    }
    const codeChallenge = param(p, 'code_challenge');
    if (
      param(p, 'code_challenge_method') !== 'S256' ||
      !isValidCodeChallenge(codeChallenge)
    ) {
      throw back(
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required.',
      );
    }

    return {
      lang,
      clientId: client.id,
      redirectUri,
      codeChallenge,
      state,
      fields: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        scope: param(p, 'scope'),
        resource: param(p, 'resource'),
      },
    };
  }

  // --------------------------------------------------------------- token

  async token(body: Params) {
    switch (param(body, 'grant_type')) {
      case 'authorization_code':
        return this.redeemCode(body);
      case 'refresh_token':
        return this.refresh(body);
      default:
        throw protocolError(
          'unsupported_grant_type',
          'Use authorization_code or refresh_token.',
        );
    }
  }

  private async redeemCode(body: Params) {
    const clientId = await this.knownClient(param(body, 'client_id'));

    let claims: CodeClaims;
    try {
      claims = this.jwt.verify<CodeClaims>(param(body, 'code') ?? '', {
        audience: CODE_AUDIENCE,
        clockTimestamp: this.seconds(),
      });
    } catch {
      throw invalidGrant('The code is invalid or has expired.');
    }

    if (claims.cid !== clientId) {
      throw invalidGrant('The code was issued to another client.');
    }
    if (param(body, 'redirect_uri') !== claims.ru) {
      throw invalidGrant(
        'redirect_uri does not match the authorization request.',
      );
    }
    const verifier = param(body, 'code_verifier');
    if (
      !isValidCodeVerifier(verifier) ||
      !verifierMatches(verifier, claims.cc)
    ) {
      throw invalidGrant('code_verifier does not match the code_challenge.');
    }

    // Spent last, so a wrong verifier cannot burn someone else's code; and
    // spent by the primary key, so two redemptions at the same moment cannot
    // both pass a look-then-write check.
    try {
      await this.prisma.usedNonce.create({
        data: {
          jti: claims.jti,
          kind: CODE_NONCE_KIND,
          expiresAt: new Date(claims.exp * 1000),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw invalidGrant('The code has already been used.');
      }
      throw err;
    }

    await this.stillPartner(claims.sub);
    return this.issue(claims.sub, clientId);
  }

  /**
   * Rotation: the token presented is spent and a new one takes its place.
   *
   * A spent token presented again means two holders — the client and whoever
   * copied it — so every live token that partner holds on that client is
   * ended, and both must sign in again.
   */
  private async refresh(body: Params) {
    const clientId = param(body, 'client_id');
    const presented = param(body, 'refresh_token');
    if (!clientId || !presented) {
      throw protocolError(
        'invalid_request',
        'client_id and refresh_token are required.',
      );
    }

    const row = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
      select: {
        id: true,
        userId: true,
        clientId: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
      },
    });
    if (!row || row.clientId !== clientId) {
      throw invalidGrant('The refresh token is not valid.');
    }
    if (row.replacedById) {
      await this.endConnection(row.userId, row.clientId);
      throw invalidGrant('The refresh token has already been used.');
    }
    if (row.revokedAt) throw invalidGrant('The refresh token was revoked.');
    if (row.expiresAt <= this.now()) {
      throw invalidGrant('The refresh token has expired.');
    }

    try {
      await this.stillPartner(row.userId);
    } catch (err) {
      await this.endConnection(row.userId, row.clientId);
      throw err;
    }

    const now = this.now();
    const refreshToken = newRefreshToken();
    await this.prisma.$transaction(async (tx) => {
      const next = await tx.oAuthRefreshToken.create({
        data: {
          userId: row.userId,
          clientId: row.clientId,
          tokenHash: hashToken(refreshToken),
          expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        },
        select: { id: true },
      });
      // Conditional, so of two refreshes racing on one token exactly one
      // spends it; the other matches nothing and its new token rolls back.
      const spent = await tx.oAuthRefreshToken.updateMany({
        where: { id: row.id, revokedAt: null, replacedById: null },
        data: { revokedAt: now, lastUsedAt: now, replacedById: next.id },
      });
      if (spent.count !== 1) {
        throw invalidGrant('The refresh token has already been used.');
      }
    });

    return this.tokens(row.userId, refreshToken);
  }

  // -------------------------------------------------------------- revoke

  /**
   * RFC 7009. An unknown token is not an error — the answer must not tell a
   * caller which tokens exist. Revoking a refresh token ends the grant it
   * belongs to, so the rotated successor of an old token goes with it.
   * Access tokens are signed and not stored; they lapse within the hour, and
   * `SurfaceGuard` refuses them sooner for anyone no longer a partner.
   */
  async revoke(body: Params): Promise<void> {
    const token = param(body, 'token');
    if (!token) throw protocolError('invalid_request', 'token is required.');

    const row = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { userId: true, clientId: true },
    });
    if (!row) return;

    const clientId = param(body, 'client_id');
    if (clientId !== undefined && clientId !== row.clientId) {
      throw protocolError(
        'unauthorized_client',
        'The token was not issued to this client.',
      );
    }
    await this.endConnection(row.userId, row.clientId);
  }

  // ------------------------------------------------------------- helpers

  private seconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** RFC 6749 §5.2: a client that cannot be identified is `invalid_client`. */
  private async knownClient(clientId: string | undefined): Promise<string> {
    const client = isUuid(clientId)
      ? await this.prisma.oAuthClient.findUnique({
          where: { id: clientId },
          select: { id: true },
        })
      : null;
    if (!client) {
      throw protocolError('invalid_client', 'Unknown client.', 401);
    }
    return client.id;
  }

  /**
   * The role and status now, not when they signed in. A partner demoted or
   * switched off gets no new tokens (BUSINESS_LOGIC §16, "loses it at once").
   */
  private async stillPartner(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true },
    });
    if (!user || user.role !== 'CORE_PARTNER' || user.status !== 'ACTIVE') {
      throw invalidGrant('This account can no longer use the assistant.');
    }
  }

  /**
   * Every live refresh token one partner holds on one client. Returns how many
   * were ended, so a caller can tell "disconnected" from "nothing to end".
   */
  private async endConnection(
    userId: string,
    clientId: string,
  ): Promise<number> {
    const { count } = await this.prisma.oAuthRefreshToken.updateMany({
      where: { userId, clientId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    return count;
  }

  // ------------------------------------------------ Settings: connections

  /**
   * The Claude apps this partner has signed in and not disconnected
   * (BUSINESS_LOGIC §16). Scoped by the caller's id from the token — there is
   * no way to ask for anybody else's.
   *
   * Two reads: which clients have a live token, then every row on those
   * clients, so the rotation chain can be walked back to the sign-in without
   * loading the history of apps long since disconnected.
   */
  async listConnections(userId: string) {
    const now = this.now();
    const live = await this.prisma.oAuthRefreshToken.findMany({
      where: { userId, revokedAt: null },
      select: { clientId: true, expiresAt: true },
    });
    const clientIds = [
      ...new Set(live.filter((r) => r.expiresAt > now).map((r) => r.clientId)),
    ];
    if (clientIds.length === 0) return { data: [] };

    const rows = await this.prisma.oAuthRefreshToken.findMany({
      where: { userId, clientId: { in: clientIds } },
      select: {
        id: true,
        clientId: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        replacedById: true,
        client: { select: { clientName: true } },
      },
    });
    return {
      data: connectionsFrom(
        rows.map(({ client, ...row }) => ({
          ...row,
          clientName: client.clientName,
        })),
        now,
      ),
    };
  }

  /**
   * Disconnect one app. An id that is not this partner's live connection —
   * another partner's, one already disconnected, or not an id at all — is the
   * same 404, so the answer never says whether someone else's exists.
   */
  async disconnect(userId: string, connectionId: string) {
    const ended = isUuid(connectionId)
      ? await this.endConnection(userId, connectionId)
      : 0;
    if (ended === 0) throw notFound('assistantConnection');
    return { data: { id: connectionId } };
  }

  /** Disconnect every app this partner has signed in, and nobody else's. */
  async disconnectAll(userId: string) {
    const now = this.now();
    const live = await this.prisma.oAuthRefreshToken.findMany({
      where: { userId, revokedAt: null },
      select: { clientId: true, expiresAt: true },
    });
    const connections = new Set(
      live.filter((r) => r.expiresAt > now).map((r) => r.clientId),
    ).size;
    await this.prisma.oAuthRefreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { data: { disconnected: connections } };
  }

  private async issue(userId: string, clientId: string) {
    const refreshToken = newRefreshToken();
    await this.prisma.oAuthRefreshToken.create({
      data: {
        userId,
        clientId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(this.now().getTime() + REFRESH_TTL_MS),
      },
      select: { id: true },
    });
    return this.tokens(userId, refreshToken);
  }

  private tokens(userId: string, refreshToken: string) {
    return {
      access_token: this.auth.issueAssistantToken({ id: userId }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
    };
  }
}
