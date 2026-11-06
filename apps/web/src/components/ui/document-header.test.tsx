import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DocumentHeader } from './document-header';

/**
 * The contract's and invoice's header on a phone (UI audit M15): side by side
 * at 375px the title wrapped a word a line and the contract number touched the
 * paper's edge. On a phone the details stack under the title; from `sm`, on
 * paper and in the PDF sheet the header is the side-by-side one it always was.
 */

afterEach(cleanup);

function header() {
  render(
    <DocumentHeader title="Installment sale contract" tagline="S&F — motorcycle parts and accessories">
      <div>
        <dt className="inline">Contract no.: </dt>
        <dd className="inline">CT-ORD-2026-00033</dd>
      </div>
    </DocumentHeader>,
  );
  return document.querySelector('header')!;
}

const classes = (el: Element) => el.className.split(/\s+/);

describe('the document header (UI audit M15)', () => {
  it('on a phone: the details stack under the title, nothing side by side', () => {
    const c = classes(header());
    expect(c).toContain('flex-col');
    // No unprefixed row layout to put the two halves beside each other.
    expect(c).not.toContain('flex-row');
    expect(c).not.toContain('justify-between');
  });

  it('from sm, on paper and in the PDF sheet: side by side, as before', () => {
    const c = classes(header());
    for (const at of ['sm', 'print', 'sheet']) {
      expect(c).toContain(`${at}:flex-row`);
      expect(c).toContain(`${at}:items-start`);
      expect(c).toContain(`${at}:justify-between`);
    }
  });

  it('the title, tagline and details are all still there, in that order', () => {
    const el = header();
    expect(el.querySelector('h1')?.textContent).toBe('Installment sale contract');
    expect(el.textContent).toMatch(/Installment sale contract.*motorcycle parts.*CT-ORD-2026-00033/);
  });
});
