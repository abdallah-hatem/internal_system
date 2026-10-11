'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle, Loader2, MinusCircle, Plus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { selectOnFocus } from '@/lib/select-on-focus';
import { saleOrderTotals } from '@/lib/sale-totals';
import { Select } from '@/components/ui/select';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { useNumberFormat } from '@/lib/numbers';
import { FieldWithQuickCreate } from '@/components/ui/quick-create';
import { FieldMark, RowAction } from '@/components/ui/fields';
import { invalidFields } from '@/components/ui/validated-form';
import { useCodeLabel } from '@/lib/labels';
import { PAYMENT_METHODS } from '@/components/payments/RecordPaymentDialog';

export interface SaleFormCustomer {
  id: string;
  displayName: string;
  type: string;
}

export interface SaleFormProduct {
  id: string;
  name: string;
  sku: string;
  prices?: { channel: string; amount: number | string; effectiveTo?: string | null }[];
}

export interface SaleFormStockRow {
  productId: string;
  availableStock?: number | string;
}

interface Line {
  /** Stable across removals, so React does not hand one line's inputs to another. */
  key: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  /**
   * The seller typed this price. A typed price is a decision — a negotiated
   * price is still a price — and is never replaced by a list price, whether
   * the product or the channel changes afterwards.
   */
  priceTyped: boolean;
}

/**
 * What `onSaved` hands back: the order, whether it went out confirmed, and
 * whether it was a walk-in sale — confirmed and paid in the same step.
 */
export interface SavedOrder {
  order: { id: string; orderNo: string; status: string };
  confirmed: boolean;
  walkIn: boolean;
}

let lineSeq = 0;
const emptyLine = (): Line => ({
  key: `line-${++lineSeq}`,
  productId: '',
  quantity: 1,
  unitPrice: 0,
  discount: 0,
  priceTyped: false,
});

/**
 * One key per opened form. `crypto.randomUUID` only exists in a secure
 * context, and the office opens the dev server over the LAN by IP, so it has
 * a fallback — uniqueness per person and per minute is all the server needs.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The new-order form (UX #1, #2; BUSINESS_LOGIC §4).
 *
 * Starts with one empty line. Each line is a card on a phone — the product on
 * one row, quantity / price / discount on the next — so no input is squeezed
 * past the width of its own value in either language. A line total sits under
 * each card and the order total under the lines, both from `saleOrderTotals`,
 * the formula the server stores.
 *
 * Two ways out: **Save as draft** (first, so Enter in a field never confirms a
 * sale) and **Create & confirm** (primary), which the server does in one
 * transaction.
 *
 * **Walk-in** (BUSINESS_LOGIC §4, 2026-10-11): a buyer who is not a shop. The
 * switch beside Customer hides the customer, fixes the channel to B2C (so
 * untouched lines take the retail price; a typed price stays), and asks how
 * the money came in instead. There is no draft — the one button sells and
 * takes the payment, which the server does in one transaction. Turning it off
 * puts back the channel that was there before; the customer was never cleared. A refusal leaves the form open with every line as typed and
 * the reason shown, translated, above the buttons.
 *
 * Required pickers are checked the way `ValidatedForm` checks them — the
 * constraint API, so each empty picker shows its own "Required" and the first
 * takes the focus — but the line naming them is worked out from the form's
 * state on every render rather than stored at submit. A picker fires no
 * `input` event, so ValidatedForm's own clearing never saw it chosen, and the
 * banner outlived the problem (UI audit #5).
 */
export function SaleOrderForm({
  customers,
  products,
  stock,
  initialCustomerId,
  onCancel,
  onSaved,
}: {
  customers: SaleFormCustomer[];
  products: SaleFormProduct[];
  stock: SaleFormStockRow[];
  initialCustomerId?: string;
  onCancel: () => void;
  onSaved: (saved: SavedOrder) => void;
}) {
  const codeLabel = useCodeLabel();
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const tv = useTranslations('validation');
  const locale = useLocale();
  const { formatNumber } = useNumberFormat();
  const apiError = useApiError();

  const channelOf = (id: string | undefined) => {
    const type = customers.find((c) => c.id === id)?.type;
    return type === 'B2B' || type === 'B2C' ? type : null;
  };

  const [customerId, setCustomerId] = useState(initialCustomerId ?? '');
  const [channel, setChannel] = useState<string>(() => channelOf(initialCustomerId) ?? 'B2B');
  const [currency, setCurrency] = useState('EGP');
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()]);
  /** The server's refusal, translated. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A submit was stopped for empty required fields, and they are still empty. */
  const [checked, setChecked] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [walkIn, setWalkIn] = useState(false);
  const [method, setMethod] = useState<string>('CASH');
  /** The channel before walk-in fixed it to B2C, put back when it is turned off. */
  const channelBeforeWalkIn = useRef<string | null>(null);

  // Set synchronously on submit. `isPending` only disables the buttons after
  // React re-renders, and two clicks inside one frame both get through that.
  const submitting = useRef(false);
  const mode = useRef<'draft' | 'confirm'>('draft');

  /** Units of a product available to sell right now. */
  const stockFor = (productId: string): number => {
    const row = stock.find((r) => r.productId === productId);
    return row ? Number(row.availableStock ?? 0) : 0;
  };

  /** The product's current list price for a channel, or null if none is set. */
  const priceFor = (productId: string, ch: string): number | null => {
    const active = products
      .find((p) => p.id === productId)
      ?.prices?.find((pr) => pr.channel === ch && !pr.effectiveTo);
    return active ? Number(active.amount) : null;
  };

  /** Switch channel and re-price every line whose price nobody typed. */
  const applyChannel = (next: string) => {
    setLines((prev) =>
      prev.map((line) =>
        line.productId && !line.priceTyped
          ? { ...line, unitPrice: priceFor(line.productId, next) ?? line.unitPrice }
          : line,
      ),
    );
    setChannel(next);
  };

  /**
   * Choosing a customer sets the channel to the kind of customer they are. A
   * shop is B2B and a walk-in is B2C; it stays changeable — a shop
   * occasionally buys at retail. A customer just made through the `+` is not
   * in `customers` yet, so its own record is read first.
   */
  const onCustomerChange = (id: string, record?: { type?: string }) => {
    setCustomerId(id);
    const type = record?.type === 'B2B' || record?.type === 'B2C' ? record.type : channelOf(id);
    if (type) applyChannel(type);
  };

  /** Walk-in on: B2C, no customer. Off: the channel it found, and the customer it hid. */
  const toggleWalkIn = () => {
    if (!walkIn) {
      channelBeforeWalkIn.current = channel;
      applyChannel('B2C');
    } else {
      applyChannel(channelBeforeWalkIn.current ?? channelOf(customerId) ?? 'B2B');
      channelBeforeWalkIn.current = null;
    }
    setWalkIn(!walkIn);
    // A refusal was about the other kind of sale.
    setRefusal(null);
  };

  const update = (key: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totals = useMemo(() => saleOrderTotals(lines), [lines]);

  // What is still empty, from state — never a snapshot taken at submit.
  const missing = [
    !walkIn && !customerId && t('customer'),
    lines.some((l) => !l.productId) && t('product'),
  ].filter((f): f is string => !!f);
  // Once everything is filled the check is spent: a line added afterwards is
  // not nagged about until the next submit.
  if (checked && missing.length === 0) setChecked(false);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post('/sales/orders', body, { headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: (res, body) => {
      const order = res.data?.data ?? res.data;
      onSaved({ order, confirmed: body.confirm === true, walkIn: body.walkIn === true });
    },
    onError: (err) => setRefusal(apiError(err, t('saveFailed'))),
    onSettled: () => {
      submitting.current = false;
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    if (walkIn) mode.current = 'confirm';
    // The form is noValidate (the browser would answer in English); the
    // pickers' `required` is checked here instead, in the reader's language.
    if (missing.length > 0) {
      // Fires `invalid` on each empty picker, which marks it under itself.
      const invalid = invalidFields(e.currentTarget);
      invalid[0]?.parentElement?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
      setRefusal(null);
      setChecked(true);
      return;
    }
    submitting.current = true;
    setChecked(false);
    setRefusal(null);
    const items = lines.map(({ productId, quantity, unitPrice, discount }) => ({
      productId,
      quantity,
      unitPrice,
      discount,
    }));
    mutation.mutate(
      walkIn
        ? // No customer and never a draft: the server confirms and records the
          // payment of the full total with the order, or does none of it.
          { walkIn: true, channel: 'B2C', currency, confirm: true, payment: { method }, items }
        : { customerId, channel, currency, confirm: mode.current === 'confirm', items },
    );
  };

  const pending = mutation.isPending;
  const confirming = mutation.variables?.confirm === true;
  const fieldClass =
    'w-full min-w-0 rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2';

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="sale-order-form">
      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          {/* The label row holds the switch and keeps the height of the other
              labels; the switch's touch area reaches past it. */}
          <div className="mb-1 flex h-5 items-center justify-between gap-2">
            <label className="block text-sm font-medium text-foreground">
              {walkIn ? t('paymentMethod') : t('customer')}
              {!walkIn && <FieldMark required />}
            </label>
            <WalkInSwitch on={walkIn} onToggle={toggleWalkIn} label={t('walkIn')} />
          </div>
          {walkIn ? (
            <Select
              name="paymentMethod"
              value={method}
              onChange={setMethod}
              options={PAYMENT_METHODS.map((m) => ({ value: m, label: codeLabel('paymentMethod', m) }))}
            />
          ) : (
            <FieldWithQuickCreate entity="customer" onCreated={(c) => onCustomerChange(c.id, c)}>
              <Select
                name="customerId"
                required
                value={customerId}
                onChange={(id) => onCustomerChange(id)}
                placeholder={t('customer')}
                searchPlaceholder={tc('search')}
                options={customers.map((c) => ({ value: c.id, label: c.displayName, hint: codeLabel('customerType', c.type) }))}
              />
            </FieldWithQuickCreate>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('channel')}</label>
          <Select
            name="channel"
            value={channel}
            onChange={applyChannel}
            // A walk-in buys at retail; the server refuses anything else.
            disabled={walkIn}
            options={[
              { value: 'B2B', label: t('b2b') },
              { value: 'B2C', label: t('b2c') },
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('currency')}</label>
          <Select
            name="currency"
            value={currency}
            onChange={setCurrency}
            options={['EGP', 'USD', 'AED'].map((c) => ({ value: c, label: c }))}
          />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t('items')}</h3>
          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, emptyLine()])}
            className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 sm:min-h-0"
          >
            <Plus className="h-3.5 w-3.5" /> {t('addItem')}
          </button>
        </div>

        <ul className="space-y-3">
          {lines.map((line, idx) => {
            const inStock = line.productId ? stockFor(line.productId) : 0;
            const overStock = !!line.productId && line.quantity > inStock;
            const lineTotals = totals.lines[idx];
            const discountTooLarge = lineTotals.discountCents > lineTotals.grossCents;
            const list = line.productId ? priceFor(line.productId, channel) : null;
            return (
              <li
                key={line.key}
                data-testid="sale-line"
                className="rounded-lg bg-muted p-3"
              >
                {/* Row 1 at every width: the product, and the way to remove it.
                    Sharing a row with the numbers left the product ~75px on a
                    desktop dialog, too narrow to read a name (UI audit #4). */}
                <div className="field-row flex gap-2">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs text-muted-foreground">
                      {t('product')}
                      <FieldMark required />
                    </label>
                    <Select
                      required
                      value={line.productId}
                      onChange={(v) =>
                        setLines((prev) =>
                          prev.map((l) =>
                            l.key === line.key
                              ? {
                                  ...l,
                                  productId: v,
                                  // List price only where nobody typed one.
                                  unitPrice: l.priceTyped
                                    ? l.unitPrice
                                    : (priceFor(v, channel) ?? l.unitPrice),
                                }
                              : l,
                          ),
                        )
                      }
                      placeholder={t('product')}
                      searchPlaceholder={tc('search')}
                      options={products.map((p) => {
                        const available = stockFor(p.id);
                        return {
                          value: p.id,
                          label: p.name,
                          // The count belongs where the product is chosen, not
                          // in an error after the order is built.
                          hint: `${p.sku} · ${formatNumber(available)} ${t('inStock')}`,
                          disabled: available <= 0,
                        };
                      })}
                    />
                  </div>
                  <RowAction labelClassName="mb-1 block text-xs">
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      aria-label={t('removeItem')}
                      title={t('removeItem')}
                      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-destructive hover:text-destructive/80 sm:size-9"
                    >
                      <MinusCircle className="h-4 w-4" />
                    </button>
                  </RowAction>
                </div>

                {/* Row 2: quantity / price / discount, with room for their values. */}
                <div className="field-row mt-2 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">{t('quantity')}</label>
                    <input
                      type="number"
                      placeholder="0"
                      data-field="quantity"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: Number(e.target.value) })}
                      {...selectOnFocus}
                      className={`${fieldClass} ${
                        overStock
                          ? 'border-destructive focus:ring-destructive'
                          : 'border-border focus:ring-ring'
                      }`}
                    />
                    {overStock && (
                      <p className="mt-1 text-[11px] text-destructive">
                        {formatNumber(inStock)} {t('inStock')}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">{t('unitPrice')}</label>
                    <MoneyInput
                      placeholder="0.00"
                      data-field="unitPrice"
                      value={line.unitPrice}
                      onChange={(raw) =>
                        update(line.key, { unitPrice: Number(raw), priceTyped: true })
                      }
                      className={`${fieldClass} border-border text-end focus:ring-ring`}
                    />
                    {line.productId && list == null && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t('noChannelPrice', { channel: codeLabel('channel', channel) })}
                      </p>
                    )}
                    {line.productId && list != null && Number(line.unitPrice) !== list && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {codeLabel('channel', channel)} <span dir="ltr">{formatNumber(list, { maximumFractionDigits: 2 })}</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">{t('discount')}</label>
                    <MoneyInput
                      placeholder="0.00"
                      data-field="discount"
                      value={line.discount}
                      onChange={(raw) => update(line.key, { discount: Number(raw) })}
                      aria-invalid={discountTooLarge || undefined}
                      className={`${fieldClass} text-end ${
                        discountTooLarge
                          ? 'border-destructive focus:ring-destructive'
                          : 'border-border focus:ring-ring'
                      }`}
                    />
                    {discountTooLarge && (
                      <p className="mt-1 text-[11px] text-destructive">{t('discountTooLarge')}</p>
                    )}
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="text-xs text-muted-foreground">{t('lineTotal')}</span>
                  <span className="whitespace-nowrap font-medium text-foreground" data-testid="line-total">
                    <Money value={lineTotals.lineTotalCents / 100} currency={currency} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-sm font-semibold text-foreground">{t('orderTotal')}</span>
          <span className="flex items-center gap-2">
            {walkIn && (
              <span
                data-testid="walk-in-paid-badge"
                className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
              >
                {t('paid')}
              </span>
            )}
            <span className="text-base font-bold text-foreground" data-testid="order-total">
              <Money value={totals.subtotalCents / 100} currency={currency} />
            </span>
          </span>
        </div>
        {walkIn && (
          <p
            data-testid="walk-in-paid"
            className="mt-1 flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
          >
            <Wallet className="h-3.5 w-3.5 shrink-0" />
            {t('walkInPaidBy', { method: codeLabel('paymentMethod', method) })}
          </p>
        )}
      </div>

      {checked && missing.length > 0 ? (
        <p
          role="alert"
          data-testid="form-problem"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {tv('requiredNamed', { fields: missing.join(locale === 'ar' ? '، ' : ', ') })}
        </p>
      ) : (
        refusal && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {refusal}
          </p>
        )
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end sm:gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-11 rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted sm:min-h-0"
        >
          {tc('cancel')}
        </button>
        {/* First in the DOM, so Enter in a field saves a draft rather than
            confirming a sale — implicit submission clicks the first submit.
            A walk-in has no draft (§4), so there it is not offered at all. */}
        {!walkIn && (
          <button
            type="submit"
            onClick={() => (mode.current = 'draft')}
            disabled={pending}
            className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            {pending && !confirming && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('saveDraft')}
          </button>
        )}
        <button
          type="submit"
          onClick={() => (mode.current = 'confirm')}
          disabled={pending}
          className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
        >
          {pending && confirming ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : walkIn ? (
            <Wallet className="h-4 w-4" />
          ) : (
            <CheckCircle className="h-4 w-4" />
          )}
          {walkIn ? t('sellAndTakePayment') : t('createAndConfirm')}
        </button>
      </div>
    </form>
  );
}

/**
 * The walk-in switch: a `button` with `role="switch"`, typed so it never
 * submits the form it sits in. The visible track is small enough to share the
 * label row; the `before:` layer stretches the touch area to 44px tall.
 */
function WalkInSwitch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="walk-in-switch"
      onClick={onToggle}
      className="relative inline-flex cursor-pointer touch-manipulation select-none items-center gap-2 rounded-full text-xs font-medium text-foreground before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <span
        aria-hidden
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block size-3 rounded-full bg-background shadow transition-transform duration-150 ${
            on ? 'translate-x-3.5 rtl:-translate-x-3.5' : 'translate-x-0.5 rtl:-translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}
