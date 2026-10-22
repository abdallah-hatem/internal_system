import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DataTable, checkColumns, type Column } from './data-table';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  sku: string;
  amount: string;
}

const ROWS: Row[] = [
  { id: '1', name: 'Front brake disc for the long-range touring model, left side', sku: 'PRD-000001', amount: '123,456.00 EGP' },
  { id: '2', name: 'Chain', sku: 'PRD-000002', amount: '10.00 EGP' },
];

const COLUMNS: Column<Row>[] = [
  { key: 'sku', header: 'SKU', width: '7rem', kind: 'label', title: (r) => r.sku, cell: (r) => r.sku },
  { key: 'name', header: 'Name', width: 'auto', kind: 'name', title: (r) => r.name, cell: (r) => r.name },
  { key: 'amount', header: 'Amount', width: '9rem', kind: 'value', align: 'end', cell: (r) => r.amount },
  { key: 'status', header: 'Status', width: '6rem', skeleton: { kind: 'pill', share: 'w-3/4' }, cell: () => 'Active' },
  { key: 'actions', header: 'Actions', width: '8rem', skeleton: { kind: 'buttons', count: 3 }, cell: () => <button type="button">View</button> },
];

const table = () => screen.getByRole('table');
const headerCells = () => within(table()).getAllByRole('columnheader');

describe('DataTable', () => {
  it('refuses a table without exactly one auto column', () => {
    expect(() => checkColumns([{ key: 'a', width: '4rem' }, { key: 'b', width: '5rem' }])).toThrow(/exactly one column must be 'auto'.*got 0/);
    expect(() => checkColumns([{ key: 'a', width: 'auto' }, { key: 'b', width: 'auto' }])).toThrow(/got 2 \(a, b\)/);
    expect(() => checkColumns([{ key: 'a', width: 'auto' }, { key: 'b', width: '5rem' }])).not.toThrow();
    // And on render, in development.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(<DataTable columns={COLUMNS.map((c) => ({ ...c, width: '5rem' }))} rows={ROWS} rowKey={(r) => r.id} />),
    ).toThrow(/exactly one column/);
    quiet.mockRestore();
  });

  it('gives the header, the skeleton and the real rows one set of columns', () => {
    const { rerender, container } = render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} isLoading />);
    const cols = [...container.querySelectorAll('colgroup col')].map((c) => (c as HTMLElement).style.width);
    expect(cols).toEqual(['7rem', '', '9rem', '6rem', '8rem']);
    expect(table().className).toContain('table-fixed');
    expect(headerCells()).toHaveLength(COLUMNS.length);

    const skeletonRows = screen.getAllByTestId('skeleton-row');
    expect(skeletonRows).toHaveLength(10); // a page
    for (const row of skeletonRows) expect(row.querySelectorAll('td')).toHaveLength(COLUMNS.length);
    // Bars are a share of their column, the buttons their real size.
    expect(skeletonRows[0].querySelectorAll('td')[3].innerHTML).toContain('w-3/4');
    expect(skeletonRows[0].querySelectorAll('td')[4].querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);

    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.queryAllByTestId('skeleton-row')).toHaveLength(0);
    const firstRow = within(table()).getAllByRole('row')[1];
    expect(firstRow.querySelectorAll('td')).toHaveLength(COLUMNS.length);
    expect([...container.querySelectorAll('colgroup col')].map((c) => (c as HTMLElement).style.width)).toEqual(cols);
  });

  it('keeps every header title on one line', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    for (const th of headerCells()) expect(th.className).toContain('whitespace-nowrap');
  });

  it('spans the empty state across every column', () => {
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} empty={<p>Nothing yet</p>} />);
    const cell = screen.getByText('Nothing yet').closest('td')!;
    expect(cell.getAttribute('colspan')).toBe(String(COLUMNS.length));
  });

  it('cuts a name after two lines, a label after one, and never a value — the whole of it on hover', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const cells = within(table()).getAllByRole('row')[1].querySelectorAll('td');
    const [sku, name, amount] = [...cells];

    const cut = sku.querySelector('div')!;
    expect(cut.className).toContain('truncate');
    // Cut at the text's own end, whichever way the page reads.
    expect(cut.getAttribute('dir')).toBe('auto');
    // As wide as its text, so a short one sits on the row's start edge.
    expect(cut.className).toContain('w-fit');
    expect(sku.getAttribute('title')).toBe('PRD-000001');

    expect(name.querySelector('div')!.className).toContain('line-clamp-2');
    expect(name.querySelector('div')!.className).toContain('break-words');
    expect(name.getAttribute('title')).toBe(ROWS[0].name);

    expect(amount.className).toContain('whitespace-nowrap');
    expect(amount.className).not.toContain('truncate');
    expect(amount.className).toContain('text-end');
    expect(amount.getAttribute('title')).toBeNull();
  });

  it('dims a stale table and keeps its rows', () => {
    const { rerender, container } = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.getAttribute('aria-busy')).toBe('false');

    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} stale />);
    expect(outer.getAttribute('aria-busy')).toBe('true');
    expect(outer.className).toContain('opacity-60');
    expect(screen.getByText('Chain')).toBeTruthy();
    expect(screen.queryAllByTestId('skeleton-row')).toHaveLength(0);
  });

  it('hides a column with its width on a phone, and prints it', () => {
    const cols: Column<Row>[] = [
      { key: 'name', header: 'Name', width: 'auto', cell: (r) => r.name },
      { key: 'amount', header: 'Amount', width: '9rem', hiddenBelow: 'sm', cell: (r) => r.amount },
    ];
    const { container } = render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} />);
    const col = container.querySelectorAll('colgroup col')[1];
    expect(col.className).toContain('hidden');
    expect(col.className).toContain('sm:table-column');
    expect(col.className).toContain('print:table-column');
    expect(headerCells()[1].className).toContain('sm:table-cell');
    expect(within(table()).getAllByRole('row')[1].querySelectorAll('td')[1].className).toContain('print:table-cell');
  });

  it('opens a row on click, and carries the row attributes a page gives it', () => {
    const open = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        onRowClick={open}
        rowProps={(r) => ({ 'data-testid': 'my-row', 'data-product': r.name })}
      />,
    );
    const rows = screen.getAllByTestId('my-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].getAttribute('data-product')).toBe('Chain');
    rows[1].click();
    expect(open).toHaveBeenCalledWith(ROWS[1]);
  });

  it('can leave its skeleton rows unmarked when its section counts something else', () => {
    render(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} isLoading skeletonRows={2} skeletonRowTestId={null} />);
    expect(screen.queryAllByTestId('skeleton-row')).toHaveLength(0);
    // The skeleton body is hidden from assistive technology, so count by tag.
    expect(table().querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('on a phone the narrowest it gets counts only the columns a phone shows (2026-10-22)', () => {
    // The order popup's Items: four columns hidden below sm counted toward the
    // minimum anyway, so at 375 px the table scrolled sideways and Line total
    // sat out of sight.
    const cols: Column<Row>[] = [
      { key: 'name', header: 'Name', width: 'auto', kind: 'name', cell: (r) => r.name },
      { key: 'sku', header: 'SKU', width: '7rem', hiddenBelow: 'sm', cell: (r) => r.sku },
      { key: 'status', header: 'Status', width: '6rem', hiddenBelow: 'md', cell: () => 'Active' },
      { key: 'amount', header: 'Amount', width: '9rem', kind: 'value', align: 'end', cell: (r) => r.amount },
    ];
    render(<DataTable columns={cols} rows={ROWS} rowKey={(r) => r.id} autoMin="9rem" />);
    const style = table().style;
    expect(style.getPropertyValue('--dt-min-xs')).toBe('calc(9rem + 9rem)');
    expect(style.getPropertyValue('--dt-min-sm')).toBe('calc(9rem + 7rem + 9rem)');
    expect(style.getPropertyValue('--dt-min')).toBe('calc(9rem + 7rem + 6rem + 9rem)');
    expect(table().className).toContain('min-w-(--dt-min-xs)');
    expect(table().className).toContain('sm:min-w-(--dt-min-sm)');
    expect(table().className).toContain('md:min-w-(--dt-min)');
  });
});
