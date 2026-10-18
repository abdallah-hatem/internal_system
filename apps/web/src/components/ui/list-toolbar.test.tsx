import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilterPills, ListToolbar, SearchField } from './list-toolbar';

afterEach(cleanup);

/** A list wired the way the pages are: search resets the page, a filter beside it. */
function List() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE'>('ACTIVE');
  return (
    <>
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: 'Search products...' }}>
        <FilterPills
          label="Status"
          testId="status-filter"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'ALL', label: 'All' },
          ]}
        />
      </ListToolbar>
      <output data-testid="state">{`${search}|${status}`}</output>
    </>
  );
}

const PHYSICAL = /(^|\s)(?:[a-z]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|border-l|border-r|rounded-l|rounded-r)-/;

describe('ListToolbar', () => {
  it('draws one search box, typed into, reported to the page', () => {
    render(<List />);
    const box = screen.getByPlaceholderText('Search products...') as HTMLInputElement;
    expect(box.type).toBe('text');
    // Named for a screen reader by its placeholder.
    expect(screen.getByRole('textbox', { name: 'Search products...' })).toBe(box);
    fireEvent.change(box, { target: { value: 'brake' } });
    expect(box.value).toBe('brake');
    expect(screen.getByTestId('state').textContent).toBe('brake|ACTIVE');
  });

  it('puts the filters in the same row as the search, and stacks them on a phone', () => {
    const { container } = render(<List />);
    const row = container.querySelector('[data-slot="list-toolbar"]')!;
    expect(row.querySelector('[data-slot="search-field"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="status-filter"]')?.parentElement).toBe(row);
    // Column on a phone, a wrapping row from sm up.
    expect(row.className).toMatch(/(^|\s)flex-col(\s|$)/);
    expect(row.className).toMatch(/sm:flex-row/);
    expect(row.className).toMatch(/sm:flex-wrap/);
    // No card around it: the toolbar sits on the page.
    expect(row.className).not.toMatch(/\b(bg-white|bg-card|border|p-4)\b/);
  });

  it('shows what goes under the row below it, not beside it', () => {
    render(
      <ListToolbar
        search={{ value: '', onChange: () => {}, placeholder: 'Search' }}
        after={<p role="alert">Pick an earlier start</p>}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.closest('[data-slot="list-toolbar"]')).toBeNull();
  });

  it('uses logical sides only, so the glass sits at the start in Arabic', () => {
    const { container } = render(
      <div dir="rtl">
        <SearchField value="" onChange={() => {}} placeholder="بحث" />
      </div>,
    );
    const icon = container.querySelector('svg')!;
    const input = container.querySelector('input')!;
    expect(icon.getAttribute('class')).toMatch(/(^|\s)start-3(\s|$)/);
    expect(input.className).toMatch(/(^|\s)ps-10(\s|$)/);
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('class') ?? '', el.tagName).not.toMatch(PHYSICAL);
    }
  });
});

describe('FilterPills', () => {
  it('marks the chosen pill pressed and switches on click', () => {
    render(<List />);
    const group = screen.getByTestId('status-filter');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Status');
    const active = screen.getByRole('button', { name: 'Active' });
    const all = screen.getByRole('button', { name: 'All' });
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(all);
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(active.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('state').textContent).toBe('|ALL');
  });

  it('never submits a form it sits in', () => {
    render(<List />);
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type')).toBe('button');
  });
});

// ─── The sweep ──────────────────────────────────────────────────────────
// Every office list draws its search through ListToolbar. A page that writes
// its own `<input … setSearch …>` again, or its own glass icon, or its own
// status pills, is the drift this file exists to stop.

function listSources(): string[] {
  const src = join(process.cwd(), 'src');
  const files: string[] = [];
  const walk = (dir: string, keep: (name: string) => boolean) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, keep);
      else if (keep(name)) files.push(path);
    }
  };
  walk(join(src, 'app', '[locale]'), (n) => n === 'page.tsx');
  walk(join(src, 'components'), (n) => n.endsWith('.tsx') && !n.endsWith('.test.tsx') && !n.includes('list-toolbar'));
  return files;
}

describe('every list uses the shared toolbar', () => {
  const files = listSources().map((f) => ({ f, source: readFileSync(f, 'utf8') }));

  it('finds the lists it is meant to check', () => {
    expect(files.filter(({ source }) => /const \[search, setSearch\]/.test(source)).length).toBeGreaterThanOrEqual(14);
  });

  it('no file hand-draws a search input', () => {
    const offenders = files
      .filter(({ source }) =>
        [...source.matchAll(/<input\b[\s\S]*?\/>/g)].some((m) => /setSearch\(|placeholder=\{t\('search'\)\}/.test(m[0])),
      )
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it('no file draws its own search glass', () => {
    const offenders = files.filter(({ source }) => /<Search\s+className="[^"]*\babsolute\b/.test(source)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it('every file holding a search state renders it through ListToolbar', () => {
    const offenders = files
      .filter(({ source }) => /const \[search, setSearch\]/.test(source) && !/<ListToolbar\b/.test(source))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it('no list draws its own status pills', () => {
    const offenders = files.filter(({ source }) => /aria-pressed=\{\w*[Ff]ilter\b/.test(source)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
