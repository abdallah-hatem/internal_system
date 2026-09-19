import {
  connectionsFrom,
  type RefreshRow,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  redirectWith,
  s256,
  escapeHtml,
} from './oauth.pure';
import { isOpenOAuthPath } from '../../common/api-prefix';
import { publicBaseUrl } from '../../common/public-base-url';

describe('isAllowedRedirectUri — only Claude may receive a code', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost:6274/callback',
    'http://127.0.0.1:33418/callback',
    'http://[::1]:5000/cb',
  ])('accepts %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    ['another site', 'https://evil.example/cb'],
    ['a lookalike suffix', 'https://claude.ai.evil.example/cb'],
    ['a lookalike prefix', 'https://evilclaude.ai/cb'],
    ['a subdomain', 'https://x.claude.ai/cb'],
    ['plain http to Claude', 'http://claude.ai/api/mcp/auth_callback'],
    ['a non-default port on Claude', 'https://claude.ai:8443/cb'],
    ['credentials in the URL', 'https://user:pw@claude.ai/cb'],
    ['a fragment', 'https://claude.ai/cb#x'],
    ['a custom scheme', 'claude://callback'],
    ['javascript', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    ['empty', ''],
    ['too long', `https://claude.ai/${'a'.repeat(2100)}`],
  ])('refuses %s', (_why, uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('refuses a verifier shorter than 43 characters or with other characters', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier(undefined)).toBe(false);
  });

  it('accepts only a 43-character base64url challenge', () => {
    expect(isValidCodeChallenge(s256('a'.repeat(43)))).toBe(true);
    expect(isValidCodeChallenge('plain-verifier')).toBe(false);
    expect(isValidCodeChallenge(['x'])).toBe(false);
  });
});

describe('publicBaseUrl', () => {
  it('prefers PUBLIC_BASE_URL, without a trailing slash', () => {
    expect(
      publicBaseUrl('https://api.example.com/', {
        headers: { host: 'internal:3001' },
        protocol: 'http',
      }),
    ).toBe('https://api.example.com');
  });

  it('falls back to the forwarded protocol and host, first hop only', () => {
    expect(
      publicBaseUrl(undefined, {
        headers: {
          host: 'internal:3001',
          'x-forwarded-proto': 'https, http',
          'x-forwarded-host': 'api.example.com, proxy',
        },
        protocol: 'http',
      }),
    ).toBe('https://api.example.com');
  });

  it('falls back to the request itself with no proxy', () => {
    expect(
      publicBaseUrl('  ', {
        headers: { host: 'localhost:3001' },
        protocol: 'http',
      }),
    ).toBe('http://localhost:3001');
  });
});

describe('redirectWith', () => {
  it('keeps the registered query and adds the code and exact state', () => {
    const url = new URL(
      redirectWith('http://localhost:6274/cb?x=1', {
        code: 'c',
        state: 'a b&c=d',
        error: undefined,
      }),
    );
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('state')).toBe('a b&c=d');
    expect(url.searchParams.has('error')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('neutralises markup in anything echoed onto the page', () => {
    expect(escapeHtml(`"><script>alert('x')</script>`)).toBe(
      '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;',
    );
  });
});

describe('isOpenOAuthPath', () => {
  it('opens the metadata and token routes, not the sign-in page or the office API', () => {
    expect(isOpenOAuthPath('/.well-known/oauth-authorization-server')).toBe(
      true,
    );
    expect(isOpenOAuthPath('/oauth/token?x=1')).toBe(true);
    expect(isOpenOAuthPath('/oauth/authorize')).toBe(false);
    expect(isOpenOAuthPath('/api/v1/payments')).toBe(false);
    expect(isOpenOAuthPath(undefined)).toBe(false);
  });
});

describe('connectionsFrom — what Settings lists', () => {
  const NOW = new Date('2026-09-19T12:00:00Z');
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const LATER = at(24 * 20);

  let n = 0;
  const row = (over: Partial<RefreshRow>): RefreshRow => ({
    id: `r${++n}`,
    clientId: 'phone',
    clientName: 'Claude',
    createdAt: at(-1),
    expiresAt: LATER,
    lastUsedAt: null,
    revokedAt: null,
    replacedById: null,
    ...over,
  });

  it('a chain of rotations is one connection, from the first sign-in to the last refresh', () => {
    const c = row({ id: 'c', createdAt: at(-2) });
    const b = row({
      id: 'b',
      createdAt: at(-5),
      revokedAt: at(-2),
      lastUsedAt: at(-2),
      replacedById: 'c',
    });
    const a = row({
      id: 'a',
      createdAt: at(-9),
      revokedAt: at(-5),
      lastUsedAt: at(-5),
      replacedById: 'b',
    });
    expect(connectionsFrom([c, a, b], NOW)).toEqual([
      {
        id: 'phone',
        clientName: 'Claude',
        connectedAt: at(-9),
        lastRefreshedAt: at(-2),
      },
    ]);
  });

  it('an ended chain on the same client does not stretch the connection back', () => {
    // Signed in, disconnected, signed in again: connected from the second time.
    const old = row({ id: 'old', createdAt: at(-100), revokedAt: at(-50) });
    const fresh = row({ id: 'fresh', createdAt: at(-3) });
    expect(connectionsFrom([old, fresh], NOW)[0].connectedAt).toEqual(at(-3));
  });

  it('revoked and expired chains are not connections', () => {
    expect(
      connectionsFrom(
        [
          row({ clientId: 'gone', revokedAt: at(-1) }),
          row({ clientId: 'lapsed', expiresAt: NOW }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('two apps are two connections, newest sign-in first', () => {
    const list = connectionsFrom(
      [
        row({ clientId: 'phone', createdAt: at(-10) }),
        row({ clientId: 'laptop', clientName: null, createdAt: at(-1) }),
      ],
      NOW,
    );
    expect(list.map((c) => c.id)).toEqual(['laptop', 'phone']);
    expect(list[0].clientName).toBeNull();
  });

  it('a malformed chain that loops back on itself still ends', () => {
    const x = row({ id: 'x', replacedById: 'y', revokedAt: at(-1) });
    const y = row({ id: 'y', replacedById: 'x', createdAt: at(-4) });
    expect(connectionsFrom([x, y], NOW)).toHaveLength(1);
  });
});
