import { describe, expect, it } from 'vitest';
import { requestsEnabled } from './features';
import { requestsLanding, requestsPath, requestsViewOf } from './requests-route';

/**
 * The Requests page is hidden in production for now (owner, 2026-10-17). The
 * flag decides it; a production deploy with the flag unset must come out off,
 * and every other build on.
 */
describe('requestsEnabled', () => {
  it('a production deploy with no flag hides the page', () => {
    expect(requestsEnabled({ deployEnv: 'production' })).toBe(false);
    expect(requestsEnabled({ flag: '', deployEnv: 'production' })).toBe(false);
    expect(requestsEnabled({ flag: '  ', deployEnv: 'production' })).toBe(false);
  });

  it('local dev and preview deploys with no flag show it', () => {
    expect(requestsEnabled({})).toBe(true);
    expect(requestsEnabled({ deployEnv: 'preview' })).toBe(true);
    expect(requestsEnabled({ deployEnv: 'development' })).toBe(true);
  });

  it.each(['on', 'ON', 'true', '1', ' on '])('flag "%s" shows it, production included', (flag) => {
    expect(requestsEnabled({ flag, deployEnv: 'production' })).toBe(true);
  });

  it.each(['off', 'false', '0', 'OFF'])('flag "%s" hides it everywhere', (flag) => {
    expect(requestsEnabled({ flag })).toBe(false);
    expect(requestsEnabled({ flag, deployEnv: 'preview' })).toBe(false);
  });

  it('a value it does not know falls back to the deploy, rather than switching it on', () => {
    expect(requestsEnabled({ flag: 'yes please', deployEnv: 'production' })).toBe(false);
    expect(requestsEnabled({ flag: 'yes please' })).toBe(true);
  });

  it('"Production" spelled another way is not production — Vercel writes it lower-case', () => {
    // Pinned so a change to the comparison is a decision, not an accident.
    expect(requestsEnabled({ deployEnv: 'production' })).toBe(false);
    expect(requestsEnabled({ deployEnv: 'PRODUCTION' })).toBe(true);
  });
});

describe('where the Requests page and its old addresses lead', () => {
  it('order requests are the first tab, with no parameter; import requests are ?view=imports', () => {
    expect(requestsPath('orders')).toBe('/requests');
    expect(requestsPath('imports')).toBe('/requests?view=imports');
  });

  it('only view=imports opens the second tab; anything else is the first', () => {
    expect(requestsViewOf('imports')).toBe('imports');
    for (const v of [null, undefined, '', 'orders', 'IMPORTS', 'plans', 'imports ']) {
      expect(requestsViewOf(v)).toBe('orders');
    }
  });

  it.each(['en', 'ar'])('switched on, each old address lands on its own tab (%s)', (locale) => {
    expect(requestsLanding(locale, 'orders', true)).toBe(`/${locale}/requests`);
    expect(requestsLanding(locale, 'imports', true)).toBe(`/${locale}/requests?view=imports`);
  });

  it.each(['en', 'ar'])('switched off, every address goes to the dashboard (%s)', (locale) => {
    expect(requestsLanding(locale, 'orders', false)).toBe(`/${locale}/dashboard`);
    expect(requestsLanding(locale, 'imports', false)).toBe(`/${locale}/dashboard`);
  });
});
