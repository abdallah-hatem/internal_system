import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import { AmountsForm, type AmountsParticipant } from './amounts-form';

/**
 * "Enter amounts" with a percentage beside each partner (owner 2026-10-19:
 * "it does not have to be equally maybe 30,30,40"). The partners repay the
 * friend who paid the cycle in whatever shares they agree; this is where the
 * shares are typed. Beyond the happy path (CLAUDE.md §0): percentages that
 * do not make 100, more than the cost, an investor's money, a typed amount
 * that must never be overwritten, and the cycle refetched underneath.
 */

afterEach(() => cleanup());

const partner = (n: number, contribution = '0'): AmountsParticipant & { name: string } => ({
  id: `p${n}`,
  participantType: 'CORE_PARTNER',
  contributionAmount: contribution,
  name: `Partner ${n}`,
});
const investor = (contribution: string): AmountsParticipant & { name: string } => ({
  id: 'inv',
  participantType: 'TEMP_INVESTOR',
  contributionAmount: contribution,
  name: 'Investor',
});

function mount(participants: (AmountsParticipant & { name: string })[], toFund: number) {
  const onSubmit = vi.fn();
  const ui = (ps: typeof participants) => (
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <AmountsForm
        participants={ps}
        toFund={toFund}
        nameOf={(p) => p.name}
        roleOf={(p) => p.participantType}
        pending={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>
  );
  const r = render(ui(participants));
  return { onSubmit, rerender: (ps: typeof participants) => r.rerender(ui(ps)) };
}

/** As a person types: focus, the keystrokes, leave the field. */
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const pct = (id: string) => document.querySelector<HTMLInputElement>(`input[data-field="pct-${id}"]`)!;
const amount = (id: string) => document.querySelector<HTMLInputElement>(`input[data-field="contribution-${id}"]`)!;
const amountOf = (id: string) => amount(id).value.replace(/,/g, '');
const text = (id: string) => screen.getByTestId(id).textContent?.replace(/ /g, ' ');
const save = () => fireEvent.click(screen.getByRole('button', { name: en.common.save }));

describe('the % and amount of each partner, kept in step', () => {
  it('an empty box shows this cycle\'s equal share as its example, not a generic figure', () => {
    mount([partner(1), partner(2), partner(3)], 172155.5);
    expect([amount('p1'), amount('p2'), amount('p3')].map((i) => i.placeholder)).toEqual([
      '57,385.16',
      '57,385.16',
      '57,385.18',
    ]);
    expect(pct('p1').placeholder).toBe('33.33');
    expect(amount('p1').value).toBe('');
  });

  it('30 / 30 / 40 % of 172,155.50: amounts to the piastre that sum exactly to the cost to fund', () => {
    const { onSubmit } = mount([partner(1), partner(2), partner(3)], 172155.5);
    typeInto(pct('p1'), '30');
    typeInto(pct('p2'), '30');
    typeInto(pct('p3'), '40');
    expect([amountOf('p1'), amountOf('p2'), amountOf('p3')]).toEqual(['51646.65', '51646.65', '68862.20']);
    expect(text('amounts-total')).toBe('Entered 172,155.50 EGP of 172,155.50 EGP to fund. Matches the cost to fund.');
    save();
    expect(onSubmit).toHaveBeenCalledWith({ p1: '51646.65', p2: '51646.65', p3: '68862.20' });
  });

  it('thirds do not divide: 33.33 / 33.33 / 33.34 % of 100,000.01 — the last absorbs the piastre, never one over or under', () => {
    mount([partner(1), partner(2), partner(3)], 100000.01);
    typeInto(pct('p1'), '33.33');
    typeInto(pct('p2'), '33.33');
    typeInto(pct('p3'), '33.34');
    const cents = ['p1', 'p2', 'p3'].map((id) => Math.round(Number(amountOf(id)) * 100));
    expect(cents.reduce((s, c) => s + c, 0)).toBe(10000001);
    expect(amountOf('p1')).toBe('33330.00');
    expect(text('amounts-gap')).toBe(en.cycles.amountsMatch);
  });

  it('typing the last % first still balances on the last partner, whatever order they are typed in', () => {
    mount([partner(1), partner(2), partner(3)], 172155.5);
    typeInto(pct('p3'), '40');
    typeInto(pct('p1'), '30');
    typeInto(pct('p2'), '30');
    expect([amountOf('p1'), amountOf('p2'), amountOf('p3')]).toEqual(['51646.65', '51646.65', '68862.20']);
  });

  it('typing an amount fills its %', () => {
    mount([partner(1), partner(2), partner(3)], 172155.5);
    typeInto(amount('p1'), '86077.75');
    expect(pct('p1').value).toBe('50.00');
  });

  it('% that do not add up to 100 are said, and the gap to the cost to fund is shown', () => {
    mount([partner(1), partner(2), partner(3)], 10000);
    typeInto(pct('p1'), '30');
    typeInto(pct('p2'), '30');
    typeInto(pct('p3'), '30');
    expect(text('amounts-pct-warning')).toBe('The percentages add up to 90.00%, not 100%.');
    expect(text('amounts-gap')).toBe('1,000.00 EGP still to enter.');
  });

  it('more than the cost to fund is said too — the partners repay more than the friend paid', () => {
    mount([partner(1), partner(2), partner(3)], 10000);
    typeInto(pct('p1'), '50');
    typeInto(pct('p2'), '50');
    typeInto(pct('p3'), '10');
    expect(text('amounts-pct-warning')).toBe('The percentages add up to 110.00%, not 100%.');
    expect(text('amounts-gap')).toBe('1,000.00 EGP more than the cost to fund.');
  });

  it('nothing typed in %: no % warning, only the total line', () => {
    mount([partner(1), partner(2)], 10000);
    expect(screen.queryByTestId('amounts-pct-warning')).toBeNull();
    expect(text('amounts-total')).toBe('Entered 0.00 EGP of 10,000.00 EGP to fund. 10,000.00 EGP still to enter.');
  });

  it('zero % is zero pounds; a blank % leaves the amount blank', () => {
    mount([partner(1), partner(2)], 10000);
    typeInto(pct('p1'), '0');
    expect(amountOf('p1')).toBe('0.00');
    typeInto(pct('p1'), '');
    expect(amountOf('p1')).toBe('');
  });

  it('a cost to fund of zero gives no % for an amount — nothing to be a share of', () => {
    mount([partner(1)], 0);
    typeInto(amount('p1'), '500');
    expect(pct('p1').value).toBe('');
  });
});

describe('what the person typed is theirs', () => {
  it('a typed amount on the last partner is never replaced to make the % come to 100', () => {
    mount([partner(1), partner(2), partner(3)], 172155.5);
    typeInto(amount('p3'), '70000');
    typeInto(pct('p1'), '30');
    typeInto(pct('p2'), '30');
    // p3's % reads 40.66, and 29.34 + 30 + 40.66 is exactly 100 — still his
    // typed figure stands: only an amount that came from a % is balanced.
    typeInto(pct('p1'), '29.34');
    expect(amountOf('p3')).toBe('70000');
  });

  it('tabbing through a field without changing it does not re-derive the other', () => {
    mount([partner(1), partner(2)], 10000);
    typeInto(pct('p1'), '33.33');
    expect(amountOf('p1')).toBe('3333.00');
    // Focus and leave the amount: MoneyInput reports the same value again.
    fireEvent.focus(amount('p1'));
    fireEvent.blur(amount('p1'));
    expect(pct('p1').value).toBe('33.33');
  });

  it('the cycle refetched underneath — new recorded figures — does not overwrite what was typed', () => {
    const { rerender } = mount([partner(1), partner(2)], 10000);
    typeInto(pct('p1'), '60');
    typeInto(pct('p2'), '40');
    rerender([partner(1, '1234'), partner(2, '5678')]);
    expect([amountOf('p1'), amountOf('p2')]).toEqual(['6000.00', '4000.00']);
  });

  it('the second time: it opens on what is recorded, with each partner’s % of it', () => {
    mount([partner(1, '51646.65'), partner(2, '51646.65'), partner(3, '68862.20')], 172155.5);
    expect([pct('p1').value, pct('p2').value, pct('p3').value]).toEqual(['30.00', '30.00', '40.00']);
    // ... and changing it to 50 / 25 / 25 hands back only new figures.
    typeInto(pct('p1'), '50');
    typeInto(pct('p2'), '25');
    typeInto(pct('p3'), '25');
    expect([amountOf('p1'), amountOf('p2'), amountOf('p3')]).toEqual(['86077.75', '43038.88', '43038.87']);
  });
});

describe('an investor on the cycle', () => {
  it('has an amount and no %; the partners’ 100% is what is left after his money', () => {
    const { onSubmit } = mount([partner(1), partner(2), investor('2000')], 10000);
    expect(document.querySelector('input[data-field="pct-inv"]')).toBeNull();
    typeInto(pct('p1'), '50');
    typeInto(pct('p2'), '50');
    expect([amountOf('p1'), amountOf('p2')]).toEqual(['4000.00', '4000.00']);
    expect(text('amounts-gap')).toBe(en.cycles.amountsMatch);
    save();
    expect(onSubmit).toHaveBeenCalledWith({ inv: '2000.00', p1: '4000.00', p2: '4000.00' });
  });
});

describe('the form is not a dead end, and not a trap (CLAUDE.md §13)', () => {
  it('every button says its type', () => {
    mount([partner(1)], 100);
    const form = screen.getByTestId('amounts-form');
    for (const b of within(form).getAllByRole('button')) expect(['button', 'submit']).toContain(b.getAttribute('type'));
  });
});
