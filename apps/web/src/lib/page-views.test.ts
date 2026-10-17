import { describe, expect, it } from 'vitest';
import { PAGE_VIEWS, movedViewLanding, pageOfView, viewOf, viewPath } from './page-views';
import { NAV_GROUPS, SYSTEM_ITEMS } from '@/components/layout/nav-model';

describe('page views (owner, 2026-10-18)', () => {
  it('opens the named tab, and the first one for anything else', () => {
    expect(viewOf('cycles', 'shipments')).toBe('shipments');
    expect(viewOf('cycles', null)).toBe('cycles');
    expect(viewOf('cycles', '')).toBe('cycles');
    // A tab of another page is not a tab of this one.
    expect(viewOf('cycles', 'categories')).toBe('cycles');
    expect(viewOf('settings', 'FX-RATES')).toBe('settings');
  });

  it('gives the first tab its plain address and the others ?view=', () => {
    expect(viewPath('cycles')).toBe('/cycles');
    expect(viewPath('purchases')).toBe('/cycles?view=purchases');
    expect(viewPath('fx-rates')).toBe('/settings?view=fx-rates');
    expect(viewPath('settlements')).toBe('/partners?view=settlements');
  });

  it('keeps the other parameters and never doubles view', () => {
    expect(viewPath('purchases', { open: 'po1', view: 'shipments' })).toBe('/cycles?open=po1&view=purchases');
    expect(viewPath('cycles', { view: 'purchases' })).toBe('/cycles');
  });

  it('refuses a slug that is not a tab rather than building a dead link', () => {
    expect(() => viewPath('ledger')).toThrow();
    expect(pageOfView('ledger')).toBeUndefined();
  });

  it('lands every old address on its tab, locale and parameters kept', () => {
    expect(movedViewLanding('ar', 'purchases', { open: 'po1' })).toBe('/ar/cycles?open=po1&view=purchases');
    expect(movedViewLanding('en', 'audit-logs', { action: ['a', 'b'], skip: undefined })).toBe(
      '/en/settings?action=a&action=b&view=audit-logs',
    );
  });

  it('has each slug on exactly one page', () => {
    const slugs = Object.values(PAGE_VIEWS).flatMap((v) => v.map((d) => d.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps the merged tabs out of the menu, and every page that holds them in it', () => {
    const hrefs = [...NAV_GROUPS.flatMap((g) => g.items), ...SYSTEM_ITEMS].map((i) => i.href);
    for (const [page, views] of Object.entries(PAGE_VIEWS)) {
      expect(hrefs).toContain(`/${page}`);
      for (const v of views.slice(1)) expect(hrefs).not.toContain(`/${v.slug}`);
    }
    expect(hrefs).not.toContain('/notifications');
  });
});
