import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabBar } from './tab-bar';

/**
 * The tab bar scrolls sideways on a narrow phone, never up and down (owner,
 * 2026-10-21: a vertical scrollbar beside "Partners & Investors | Settlements").
 * `overflow-x-auto` alone makes the other axis scrollable too, and the tabs'
 * -mb-px underline overflows it by a pixel.
 */
describe('the tab bar', () => {
  it('scrolls sideways only', () => {
    render(
      <TabBar
        label="Partners"
        value="partners"
        onChange={() => {}}
        tabs={[
          { key: 'partners', label: 'Partners & Investors' },
          { key: 'settlements', label: 'Settlements' },
        ]}
      />,
    );
    const bar = screen.getByRole('tablist').className.split(/\s+/);
    expect(bar).toContain('overflow-x-auto');
    expect(bar).toContain('overflow-y-hidden');
  });
});
