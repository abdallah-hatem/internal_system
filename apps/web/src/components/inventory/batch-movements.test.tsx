import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { BatchMovementList, type BatchMovement } from './batch-movements';

/**
 * A batch's movements say who each went to and at what price (owner
 * 2026-11-06: "in movement I want to see the customer name and the price").
 * The API resolves both; this only says them.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const base = { occurredAt: '2026-11-01T10:00:00Z', referenceId: null };
const MOVEMENTS: BatchMovement[] = [
  {
    ...base, id: 'm-receive', movementType: 'RECEIVE', qtyDelta: '10', referenceType: 'PURCHASE_ORDER_ITEM',
    reference: { number: 'PO-2026-0003', purchaseOrderId: 'po-3' },
    customerName: null, walkIn: false, branchName: null, unitPrice: '412.50', priceKind: 'cost', currency: 'EGP',
  },
  {
    ...base, id: 'm-sale', movementType: 'SALE', qtyDelta: '-3', referenceType: 'SALE_ORDER',
    reference: { number: 'ORD-2026-0101', saleOrderId: 'so-1' },
    customerName: 'Koshary Motors', walkIn: false, branchName: 'Shubra', unitPrice: '966.67', priceKind: 'sale', currency: 'EGP',
  },
  {
    ...base, id: 'm-return', movementType: 'RETURN', qtyDelta: '1', referenceType: 'SALE_RETURN',
    reference: { number: 'RET-2026-0009', saleOrderId: 'so-1' },
    customerName: 'Koshary Motors', walkIn: false, branchName: 'Shubra', unitPrice: '20.50', priceKind: 'refund', currency: 'USD',
  },
  {
    ...base, id: 'm-samples', movementType: 'SAMPLE_OUT', qtyDelta: '-2', referenceType: 'SAMPLES_ORDER',
    reference: { number: 'ORD-2026-0103', saleOrderId: 'so-3' },
    customerName: 'Ali Shop', walkIn: false, branchName: null, unitPrice: null, priceKind: null, currency: null,
  },
  {
    ...base, id: 'm-walkin', movementType: 'SALE', qtyDelta: '-1', referenceType: 'SALE_ORDER',
    reference: { number: 'ORD-2026-0102', saleOrderId: 'so-2' },
    customerName: null, walkIn: true, branchName: null, unitPrice: '750.00', priceKind: 'sale', currency: 'EGP',
  },
  {
    ...base, id: 'm-adjust', movementType: 'ADJUSTMENT', qtyDelta: '-1', referenceType: null, reference: null,
    customerName: null, walkIn: false, branchName: null, unitPrice: null, priceKind: null, currency: null,
  },
];

afterEach(cleanup);

function renderList(layout: 'table' | 'cards', locale: 'en' | 'ar' = 'en', movements = MOVEMENTS, loading = false) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <BatchMovementList movements={movements} loading={loading} layout={layout} />
    </NextIntlClientProvider>,
  );
}

const rowOf = (id: string) => {
  const rows = screen.getAllByTestId('batch-movement');
  return rows[MOVEMENTS.findIndex((m) => m.id === id)];
};

describe.each(['table', 'cards'] as const)('movements as %s', (layout) => {
  it('a sale names the customer and branch, and the price charged', () => {
    renderList(layout);
    const row = rowOf('m-sale');
    expect(within(row).getByTestId('movement-customer').textContent).toContain('Koshary Motors');
    expect(within(row).getByTestId('movement-branch').textContent).toBe('Shubra');
    const price = within(row).getByTestId('movement-price');
    expect(price.getAttribute('data-kind')).toBe('sale');
    expect(price.textContent).toBe('966.67 EGP');
    expect(within(row).queryByTestId('movement-cost-label')).toBeNull();
  });

  it('a return names the order’s customer and the refund, in the order’s currency', () => {
    renderList(layout);
    const row = rowOf('m-return');
    expect(within(row).getByTestId('movement-customer').textContent).toContain('Koshary Motors');
    expect(within(row).getByTestId('movement-price').textContent).toBe('20.50 USD');
  });

  it('a receipt’s figure is marked as cost, never read as a selling price', () => {
    renderList(layout);
    const row = rowOf('m-receive');
    const price = within(row).getByTestId('movement-price');
    expect(price.getAttribute('data-kind')).toBe('cost');
    expect(within(price).getByTestId('movement-cost-label').textContent).toBe(en.inventory.movementCost);
    expect(price.textContent).toBe('412.50 EGP cost');
    // No customer on a receipt.
    expect(within(row).queryByTestId('movement-customer')).toBeNull();
  });

  it('samples and other movements have no price: "—"', () => {
    renderList(layout);
    expect(within(rowOf('m-samples')).getByTestId('movement-customer').textContent).toContain('Ali Shop');
    expect(within(rowOf('m-samples')).getByTestId('movement-price').textContent).toBe('—');
    expect(within(rowOf('m-adjust')).getByTestId('movement-price').textContent).toBe('—');
    expect(within(rowOf('m-adjust')).queryByTestId('movement-customer')).toBeNull();
  });

  it('a walk-in sale says Walk-in', () => {
    renderList(layout);
    expect(within(rowOf('m-walkin')).getByTestId('movement-customer').textContent).toBe(en.inventory.movementWalkIn);
  });

  it('in Arabic: the labels translate, the amounts stay isolated left-to-right', () => {
    renderList(layout, 'ar');
    const walkIn = within(rowOf('m-walkin')).getByTestId('movement-customer');
    expect(walkIn.textContent).toBe(ar.inventory.movementWalkIn);
    const cost = within(rowOf('m-receive')).getByTestId('movement-price');
    expect(within(cost).getByTestId('movement-cost-label').textContent).toBe(ar.inventory.movementCost);
    const money = cost.querySelector('[data-slot="money"]')!;
    expect(money.getAttribute('dir')).toBe('ltr');
    expect(money.textContent).toBe('412.50 EGP');
  });

  it('loading shows skeleton rows, not the list', () => {
    renderList(layout, 'en', [], true);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(2);
    expect(screen.queryByTestId('batch-movement')).toBeNull();
  });
});

describe('the table', () => {
  it('has a Customer and a Price column, in both languages', () => {
    renderList('table');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      en.inventory.movementColumn, en.inventory.movementCustomer, en.inventory.movementPrice,
      en.inventory.movementRecord, en.inventory.movementDate,
    ]);
    cleanup();
    renderList('table', 'ar');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      ar.inventory.movementColumn, ar.inventory.movementCustomer, ar.inventory.movementPrice,
      ar.inventory.movementRecord, ar.inventory.movementDate,
    ]);
  });

  it('goes through the shared table, the price column never wrapping', () => {
    renderList('table');
    const table = screen.getByTestId('batch-movements');
    expect(table.getAttribute('data-slot')).toBe('data-table');
    const price = within(rowOf('m-sale')).getByTestId('movement-price');
    expect(price.className).toContain('whitespace-nowrap');
  });

  it('the skeleton has a cell for every column', () => {
    renderList('table', 'en', [], true);
    const [row] = screen.getAllByTestId('skeleton-row');
    expect(row.querySelectorAll('td')).toHaveLength(5);
  });
});

it('every new label is in both languages', () => {
  for (const key of ['movementColumn', 'movementCustomer', 'movementPrice', 'movementRecord', 'movementDate', 'movementWalkIn', 'movementCost', 'movementCostHint', 'movementPriceHint'] as const) {
    expect(en.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).not.toBe(en.inventory[key]);
  }
});

/**
 * UI re-check, 2026-11-06 (product page, Part 2). jsdom lays nothing out, so
 * these pin the structure that decides what a phone shows; the screenshots
 * check the result.
 */
const LONG: BatchMovement[] = [
  {
    ...base, id: 'm-out', movementType: 'SAMPLE_OUT', qtyDelta: '-3', referenceType: 'SAMPLES_ORDER',
    reference: { number: 'ORD-2026-00071', saleOrderId: 'so-71' },
    customerName: 'Al-Mansoura Gear & Accessories Trading Co.', walkIn: false, branchName: 'Mit Ghamr Industrial Zone',
    unitPrice: null, priceKind: null, currency: null,
  },
  {
    ...base, id: 'm-ar', movementType: 'SAMPLE_BACK', qtyDelta: '1', referenceType: 'SAMPLES_ORDER',
    reference: { number: 'ORD-2026-00072', saleOrderId: 'so-72' },
    customerName: 'مؤسسة الدلتا الكبرى لإكسسوارات الدراجات النارية', walkIn: false, branchName: null,
    unitPrice: null, priceKind: null, currency: null,
  },
];

function renderLong(layout: 'table' | 'cards', locale: 'en' | 'ar') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <BatchMovementList movements={LONG} layout={layout} />
    </NextIntlClientProvider>,
  );
}

const CUT = /\b(truncate|line-clamp-\d|text-ellipsis|whitespace-nowrap)\b/;

/** Every element from `el` up to its row (the card's li, the table's td). */
function upToRow(el: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let at: HTMLElement | null = el; at && at.tagName !== 'LI' && at.tagName !== 'TR'; at = at.parentElement) chain.push(at);
  return chain;
}

describe.each(['table', 'cards'] as const)('nothing a phone cannot hover is cut (%s)', (layout) => {
  it.each(['en', 'ar'] as const)('P1: the whole movement label shows, wrapping, never truncated (%s)', (locale) => {
    renderLong(layout, locale);
    const msgs = locale === 'ar' ? ar : en;
    const labels = screen.getAllByTestId('movement-label');
    expect(labels.map((l) => l.textContent)).toEqual([msgs.codes.movementType.SAMPLE_OUT, msgs.codes.movementType.SAMPLE_BACK]);
    for (const label of labels) {
      // Nothing between the label and its row may cut it.
      for (const el of upToRow(label)) {
        expect(el.className).not.toMatch(CUT);
        expect(el.className).not.toMatch(/overflow-hidden/);
      }
      expect(label.className).toContain('break-words');
      // The badge and its quantity wrap rather than squeeze the label.
      expect(label.closest('[data-testid="movement-kind"]')!.className).toContain('flex-wrap');
      // No `title` standing in for the text: it is all on screen.
      expect(label.parentElement!.hasAttribute('title')).toBe(false);
    }
  });

  it.each(['en', 'ar'] as const)('P2/P3: a customer name and branch wrap, each its own direction box (%s)', (locale) => {
    renderLong(layout, locale);
    for (const [i, mov] of LONG.entries()) {
      const row = screen.getAllByTestId('batch-movement')[i];
      const name = within(row).getByTestId('movement-customer-name');
      expect(name.textContent).toBe(mov.customerName);
      const box = name.closest('[data-slot="latin-text"]') as HTMLElement;
      expect(box).not.toBeNull();
      expect(box.getAttribute('dir')).toBe('auto');
      expect(box.className).toContain('break-words');
      for (const el of upToRow(name)) expect(el.className).not.toMatch(CUT);
    }
    const branch = screen.getAllByTestId('movement-branch')[0];
    for (const el of upToRow(branch)) expect(el.className).not.toMatch(CUT);
    expect(branch.querySelector('[data-slot="latin-text"]')!.getAttribute('dir')).toBe('auto');
  });

  it('P6: the record link has a hit area of at least 32px, from padding not text', () => {
    renderLong(layout, 'en');
    for (const link of screen.getAllByTestId('movement-reference')) {
      // A 15px line + 2 x 10px padding = 35px, the margin giving the room back.
      expect(link.className).toMatch(/(^| )py-2\.5( |$)/);
      expect(link.className).toMatch(/(^| )-my-2\.5( |$)/);
      expect(link.className).toContain('inline-block');
      expect(link.className).not.toMatch(/text-(sm|base|lg)/);
    }
  });
});

describe('the cards on a phone', () => {
  it('P1: the date drops under the badge rather than squeezing it', () => {
    renderLong('cards', 'en');
    const top = screen.getAllByTestId('movement-kind')[0].parentElement!;
    expect(top.className).toContain('flex-wrap');
  });

  it('P2: the name keeps 8rem; a wide price goes under it', () => {
    renderList('cards');
    const name = within(rowOf('m-sale')).getByTestId('movement-customer');
    expect(name.parentElement!.className).toContain('flex-[1_1_8rem]');
    expect(name.parentElement!.parentElement!.className).toContain('flex-wrap');
  });
});

describe('the table, re-checked', () => {
  it('P4: its first and last cells keep 16px from its own border, header too', () => {
    renderList('table');
    const table = screen.getByTestId('batch-movements');
    for (const cell of [...Array.from(table.querySelectorAll('th')), ...within(rowOf('m-sale')).getAllByRole('cell')]) {
      expect(cell.className).toContain('first:ps-4');
      expect(cell.className).toContain('last:pe-4');
      expect(cell.className).not.toMatch(/first:ps-0|last:pe-0/);
    }
  });

  it('P5: fits the product page batch row at 1024 beside the sidebar (about 682px), so it never scrolls sideways', () => {
    renderList('table');
    const table = screen.getByTestId('batch-movements');
    const min = table.style.getPropertyValue('--dt-min');
    const rems = [...min.matchAll(/([\d.]+)rem/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(rems).toBeGreaterThan(30);
    expect(rems * 16).toBeLessThanOrEqual(682);
  });

  it('P5: the date sits over its time, two short lines', () => {
    renderList('table');
    const date = within(rowOf('m-sale')).getByTestId('movement-date');
    const [day, time] = Array.from(date.children).map((c) => c.textContent);
    expect(day).toBe('Nov 1, 2026');
    expect(time).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    // The same moment the cards give on one line.
    cleanup();
    renderList('cards');
    expect(rowOf('m-sale').textContent).toContain(`${day}, ${time}`);
  });
});

describe('P7: a long list shows the first 10, with All / Fewer under it', () => {
  const many = (n: number): BatchMovement[] =>
    Array.from({ length: n }, (_, i) => ({
      ...MOVEMENTS[1],
      id: `m-${i}`,
      reference: { number: `ORD-2026-${String(i).padStart(5, '0')}`, saleOrderId: `so-${i}` },
    }));

  function renderMany(n: number, layout: 'table' | 'cards', locale: 'en' | 'ar' = 'en', loading = false) {
    return render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <BatchMovementList movements={many(n)} layout={layout} loading={loading} />
      </NextIntlClientProvider>,
    );
  }

  const below = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it.each(['table', 'cards'] as const)('%s: 20 show 10; All opens the rest; Fewer folds them back; again', (layout) => {
    renderMany(20, layout);
    let rows = screen.getAllByTestId('batch-movement');
    expect(rows).toHaveLength(10);
    const button = screen.getByTestId('movements-show-all');
    // Under the list, where a long list ends, not above it.
    expect(below(rows[rows.length - 1], button)).toBe(true);
    expect(button.textContent).toBe('All 20 movements');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    rows = screen.getAllByTestId('batch-movement');
    expect(rows).toHaveLength(20);
    expect(button.textContent).toBe(en.inventory.movementsShowFewer);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(below(rows[19], button)).toBe(true);
    fireEvent.click(button);
    expect(screen.getAllByTestId('batch-movement')).toHaveLength(10);
    fireEvent.click(button);
    expect(screen.getAllByTestId('batch-movement')).toHaveLength(20);
  });

  it('exactly 10 shows them all with no button; 11 has one', () => {
    renderMany(10, 'cards');
    expect(screen.getAllByTestId('batch-movement')).toHaveLength(10);
    expect(screen.queryByTestId('movements-show-all')).toBeNull();
    cleanup();
    renderMany(11, 'cards');
    expect(screen.getAllByTestId('batch-movement')).toHaveLength(10);
    expect(screen.getByTestId('movements-show-all').textContent).toBe('All 11 movements');
  });

  it('no button while loading', () => {
    renderMany(0, 'cards', 'en', true);
    expect(screen.queryByTestId('movements-show-all')).toBeNull();
  });

  it('in Arabic, and a 44px target on a phone', () => {
    renderMany(12, 'cards', 'ar');
    const button = screen.getByTestId('movements-show-all');
    expect(button.textContent).toBe(ar.inventory.movementsShowAll.replace('{count}', '12'));
    expect(button.className).toContain('min-h-11');
    fireEvent.click(button);
    expect(button.textContent).toBe(ar.inventory.movementsShowFewer);
  });
});

it('the All / Fewer labels are in both languages', () => {
  for (const key of ['movementsShowAll', 'movementsShowFewer'] as const) {
    expect(en.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).not.toBe(en.inventory[key]);
  }
  expect(ar.inventory.movementsShowAll).toContain('{count}');
});
