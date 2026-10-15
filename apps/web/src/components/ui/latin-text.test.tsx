import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { LatinText } from './latin-text';
import { ProductLink } from './entity-link';

vi.mock('next/navigation', () => ({ useParams: () => ({ locale: 'ar' }) }));

afterEach(cleanup);

function rtl(ui: ReactNode) {
  return render(<div dir="rtl" data-testid="row">{ui}</div>);
}

/**
 * What decides where a Latin name's ellipsis and full stop land in an Arabic
 * row is the isolation and direction of the element holding it. jsdom does not
 * lay out text, so these pin the attributes; the screenshots check the result.
 */
describe('LatinText', () => {
  it('isolates a plain value in a <bdi> that reads its own direction', () => {
    rtl(<LatinText>Wizard Sea Freight Ltd.</LatinText>);
    const el = screen.getByText('Wizard Sea Freight Ltd.');
    expect(el.tagName).toBe('BDI');
    expect(el.getAttribute('dir')).toBe('auto');
    // The full stop is part of the isolated run, not a sibling the row can move.
    expect(el.textContent).toBe('Wizard Sea Freight Ltd.');
    expect(el.parentElement?.getAttribute('dir')).toBe('rtl');
  });

  it('a truncated value is its own direction box, so the ellipsis lands at the end of the text', () => {
    rtl(<LatinText truncate>Audit Partial Front Disc Brake Rotor 220mm Stainless Steel Heavy Duty</LatinText>);
    const el = screen.getByText(/^Audit Partial/);
    expect(el.getAttribute('dir')).toBe('auto');
    expect(el.className).toMatch(/\btruncate\b/);
    expect(el.className).toMatch(/\bblock\b/);
    // Placed by the row, not aligned by its own (left-to-right) direction: as
    // wide as its text, so it sits on the row's start edge in Arabic. Not
    // match-parent, which Chromium resolves against the element's own direction.
    expect(el.className).toMatch(/\bw-fit\b/);
    expect(el.className).toMatch(/\bmax-w-full\b/);
    expect(el.className).toContain('[unicode-bidi:isolate]');
    // Cut off on screen, still readable on hover.
    expect(el.getAttribute('title')).toBe('Audit Partial Front Disc Brake Rotor 220mm Stainless Steel Heavy Duty');
  });

  it('forces left to right for a phone number, which has no letters to decide by', () => {
    rtl(<LatinText dir="ltr">+201000000777</LatinText>);
    const el = screen.getByText('+201000000777');
    expect(el.tagName).toBe('BDI');
    expect(el.getAttribute('dir')).toBe('ltr');
  });

  it('a long value is never cut when truncate is off', () => {
    rtl(<LatinText>Audit Partial Freight & Logistics Co.</LatinText>);
    const el = screen.getByText('Audit Partial Freight & Logistics Co.');
    expect(el.className).not.toMatch(/truncate/);
    expect(el.hasAttribute('title')).toBe(false);
  });

  it('a truncated product link truncates the name inside the link, not the link around it', () => {
    rtl(<ProductLink truncate id="p1" name="Honda CBR Brake Pad" />);
    const name = screen.getByText('Honda CBR Brake Pad');
    expect(name.getAttribute('dir')).toBe('auto');
    expect(name.className).toMatch(/\btruncate\b/);
    expect(name.closest('a')?.getAttribute('href')).toBe('/ar/products/p1');
  });

  it('an Arabic value keeps right to left inside the same component', () => {
    rtl(<LatinText truncate>قطع غيار الدراجات</LatinText>);
    expect(screen.getByText('قطع غيار الدراجات').getAttribute('dir')).toBe('auto');
  });
});
