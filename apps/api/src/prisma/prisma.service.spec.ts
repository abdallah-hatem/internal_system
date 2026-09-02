import { tunedDatabaseUrl } from './prisma.service';

/**
 * Wrong in either direction and nothing looks broken: too many connections and
 * requests hang waiting on Neon with nothing in the log, because the request
 * never reaches a handler; applied locally and every query serialises behind a
 * single connection.
 */
describe('tunedDatabaseUrl', () => {
  const original = process.env.VERCEL;
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  });

  const URL_IN = 'postgresql://u:p@host.neon.tech/db?sslmode=require';

  it('leaves the URL untouched when not on Vercel', () => {
    delete process.env.VERCEL;
    expect(tunedDatabaseUrl(URL_IN)).toBe(URL_IN);
  });

  it('bounds the pool on Vercel', () => {
    process.env.VERCEL = '1';
    const out = new URL(tunedDatabaseUrl(URL_IN)!);
    expect(out.searchParams.get('connection_limit')).toBe('1');
    expect(out.searchParams.get('pool_timeout')).toBe('20');
    // And keeps what was already there — dropping sslmode would break the
    // connection entirely.
    expect(out.searchParams.get('sslmode')).toBe('require');
  });

  it('does not overwrite a limit somebody set deliberately', () => {
    process.env.VERCEL = '1';
    const out = new URL(tunedDatabaseUrl(`${URL_IN}&connection_limit=5`)!);
    expect(out.searchParams.get('connection_limit')).toBe('5');
  });

  it('passes undefined through rather than inventing a URL', () => {
    process.env.VERCEL = '1';
    expect(tunedDatabaseUrl(undefined)).toBeUndefined();
  });

  it('returns a malformed URL unchanged instead of throwing at boot', () => {
    process.env.VERCEL = '1';
    expect(tunedDatabaseUrl('not-a-url')).toBe('not-a-url');
  });
});
