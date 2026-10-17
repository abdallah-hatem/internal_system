import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { NoMatch } from './no-match';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(cleanup);

const NAMES = ['Gulf Freight', 'Nile Customs Clearance', 'Wizard Sea Freight Ltd.'];

/** A list wired the way the pages are: a search box, a filter, and NoMatch. */
function List({ withFilter = false }: { withFilter?: boolean }) {
  const [search, setSearch] = useState('');
  const [onlyFreight, setOnlyFreight] = useState(withFilter);
  const rows = NAMES.filter(
    (n) => n.toLowerCase().includes(search.toLowerCase()) && (!onlyFreight || n.includes('Freight')),
  );
  return (
    <div>
      <input aria-label="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul>
        {rows.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {rows.length === 0 && (
        <NoMatch
          filtered={onlyFreight}
          onClear={() => {
            setSearch('');
            setOnlyFreight(false);
          }}
        />
      )}
    </div>
  );
}

function show(locale: 'en' | 'ar', ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('NoMatch', () => {
  it('a search with no matches shows the compact empty state, and Clear search brings every row back', () => {
    show('en', <List />);
    const box = screen.getByLabelText('search') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'zzzz-nothing' } });

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    const empty = document.querySelector('[data-slot="empty-state"]');
    expect(empty?.getAttribute('data-size')).toBe('compact');
    expect(screen.getByText('Nothing matches this search or filter')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box.value).toBe('');
    expect(screen.getAllByRole('listitem')).toHaveLength(NAMES.length);
    expect(document.querySelector('[data-slot="empty-state"]')).toBeNull();
  });

  it('when a filter is narrowing the list too, the button says so and clears both', () => {
    show('en', <List withFilter />);
    const box = screen.getByLabelText('search') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'Customs' } });
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(box.value).toBe('');
    // "Nile Customs Clearance" is back: the filter went too, not only the text.
    expect(screen.getAllByRole('listitem')).toHaveLength(NAMES.length);
  });

  it('the button is a button, so inside a form it never submits it', () => {
    show('en', <NoMatch onClear={() => {}} />);
    expect(screen.getByRole('button', { name: 'Clear search' }).getAttribute('type')).toBe('button');
  });

  it('reads in Arabic', () => {
    show('ar', <NoMatch onClear={() => {}} />);
    expect(screen.getByRole('button', { name: ar.common.clearSearch })).toBeTruthy();
    expect(screen.getByText(ar.common.noMatch)).toBeTruthy();
  });

  it('every list page with a search box uses it, and none keeps a bare no-match line', () => {
    const appDir = join(process.cwd(), 'src', 'app', '[locale]');
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === 'page.tsx') pages.push(path);
      }
    };
    walk(appDir);
    // Pages shown as tabs of another page live as views (lib/page-views.ts).
    const viewsDir = join(process.cwd(), 'src', 'components', 'views');
    for (const name of readdirSync(viewsDir)) if (name.endsWith('-view.tsx')) pages.push(join(viewsDir, name));
    const searching = pages.filter((p) => /const \[search, setSearch\]/.test(readFileSync(p, 'utf8')));
    expect(searching.length).toBeGreaterThan(10);
    for (const p of searching) {
      const source = readFileSync(p, 'utf8');
      expect(source, p).toMatch(/<NoMatch\b/);
      expect(source, p).not.toMatch(/title=\{t?c?\('noMatch'\)\}/);
    }
  });
});
