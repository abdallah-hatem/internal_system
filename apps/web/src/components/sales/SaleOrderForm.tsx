'use client';
import { localName, otherName } from '@/lib/localized-name';

import { useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle, Loader2, MinusCircle, PackageCheck, PackageOpen, Plus, Wallet } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { isOffered, isSellable } from '@/lib/product-status';
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
import { usePriceCheck } from '@/lib/price-check';
import { listPriceOf, type ListPrices } from '@/lib/list-price';
import { DefaultPriceHint } from '@/components/products/default-price-hint';
import { BelowCostLine, BelowCostTotal } from '@/components/sales/below-cost';
import { Dialog } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { businessToday } from '@/lib/dates';
import { useCustomerBranches } from '@/lib/customer-branches';

export interface SaleFormCustomer {
  id: string;
  displayName: string;
  type: string;
}

export interface SaleFormProduct {
  id: string;
  name: string;
  sku: string;
  status?: string | null;
  prices?: { channel: string; amount: number | string; effectiveTo?: string | null }[];
  /**
   * Each channel's price as the API resolved it — set, or the default landed +
   * markup (§3, 2026-10-18). What a line starts from; never saved as typed.
   */
  listPrices?: ListPrices | null;
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
  /** Samples left at the shop (§4, samples at shops): off the shelf, no sale. */
  samples: boolean;
  /** A samples order completed as a sale ("They're buying", §4 round 2). */
  fromSamples?: boolean;
}

/**
 * An open samples order, as "They're buying" opens the form on it (BUSINESS_LOGIC
 * §4, owner 2026-10-18 round 2): the shop, the channel and currency, and every
 * line that went out with the price noted when it was left.
 */
export interface SamplesSource {
  id: string;
  orderNo: string;
  customerId: string;
  channel: string;
  currency: string;
  /** The Cairo day they were left: the sale cannot be dated before it. */
  leftOn?: string;
  items?: { productId: string; quantity: number | string; unitPrice: number | string }[];
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

/** A product's list price for a channel — set, else the default — or null. */
function listPrice(products: SaleFormProduct[], productId: string, channel: string): number | null {
  // Set, else the default landed + markup (§3, 2026-10-18): the same reading as a new line.
  const price = listPriceOf(products.find((p) => p.id === productId), channel);
  return price ? Number(price.amount) : null;
}

/**
 * The lines "They're buying" opens with (§4 round 2): every line that went
 * out, at its quantity, priced at the price noted when it was left — a typed
 * decision, kept whatever the channel does — else the product's price for the
 * order's channel, else empty.
 */
export function linesFromSamples(source: SamplesSource, products: SaleFormProduct[]): Line[] {
  return (source.items ?? []).map((item) => {
    const noted = Number(item.unitPrice);
    return {
      ...emptyLine(),
      productId: item.productId,
      quantity: Number(item.quantity),
      unitPrice: noted > 0 ? noted : (listPrice(products, item.productId, source.channel) ?? 0),
      priceTyped: noted > 0,
    };
  });
}

/** Units of a product out on the samples order: they count as available to this sale. */
export function outOnSamples(source: SamplesSource | undefined, productId: string): number {
  return (source?.items ?? [])
    .filter((i) => i.productId === productId)
    .reduce((s, i) => s + Number(i.quantity), 0);
}

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
 * **Samples — no charge yet** (BUSINESS_LOGIC §4, samples at shops, owner
 * 2026-10-18): the amber switch above the fields. With it on the units leave
 * the shelf and nothing is charged: prices are optional (one typed is noted
 * for the decision), there is no discount and no total, no draft, and the one
 * button reads "Leave samples". Samples go to a shop, so walk-in is not
 * offered beside it; turning samples on turns walk-in off.
 *
 * **From samples** (`fromSamples`, §4, owner 2026-10-18 round 2): "They're
 * buying" opens this same form on the samples order, pre-filled — the shop
 * (fixed: the samples were left with it), today, and every line that went out
 * with its price. Lines can be lowered, removed, raised and added exactly as on
 * a new order; a product's units out on the order count as available to it.
 * One button, "Complete sale", sends the lines to `…/samples/convert`, where
 * the server keeps what went out, puts the rest back and draws anything more.
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
  title,
  fromSamples,
}: {
  /** The dialog's title: the form renders in the shared dialog, its actions in the fixed footer. */
  title: string;
  customers: SaleFormCustomer[];
  products: SaleFormProduct[];
  stock: SaleFormStockRow[];
  initialCustomerId?: string;
  onCancel: () => void;
  onSaved: (saved: SavedOrder) => void;
  /** Complete this samples order as a sale ("They're buying", §4 round 2). */
  fromSamples?: SamplesSource;
}) {
  const codeLabel = useCodeLabel();
  const t = useTranslations('sales');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const tv = useTranslations('validation');
  const tb = useTranslations('branches');
  const locale = useLocale();
  const { formatNumber, formatAmount } = useNumberFormat();
  const apiError = useApiError();

  const channelOf = (id: string | undefined) => {
    const type = customers.find((c) => c.id === id)?.type;
    return type === 'B2B' || type === 'B2C' ? type : null;
  };

  const [customerId, setCustomerId] = useState(fromSamples?.customerId ?? initialCustomerId ?? '');
  const [channel, setChannel] = useState<string>(
    () => fromSamples?.channel ?? channelOf(initialCustomerId) ?? 'B2B',
  );
  const [currency, setCurrency] = useState(fromSamples?.currency ?? 'EGP');
  const [lines, setLines] = useState<Line[]>(() =>
    fromSamples ? linesFromSamples(fromSamples, products) : [emptyLine()],
  );
  /** Units that went out on the samples order, for the line under the title. */
  const unitsOut = fromSamples ? (fromSamples.items ?? []).reduce((s, i) => s + Number(i.quantity), 0) : 0;
  /** The server's refusal, translated. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** A submit was stopped for empty required fields, and they are still empty. */
  const [checked, setChecked] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [walkIn, setWalkIn] = useState(false);
  const [samples, setSamples] = useState(false);
  const [method, setMethod] = useState<string>('CASH');
  /**
   * The day the sale was made (§4, 2026-10-16): today unless an earlier sale
   * is being entered. Never a day that has not come — the picker greys them
   * out and the server refuses them.
   */
  const [orderedOn, setOrderedOn] = useState(businessToday);
  /**
   * The branch it is for (§7, 2026-10-25). Not required: left alone it is the
   * customer's default branch, which is also what the server does with an
   * order that names none. A branch the person picked is kept with the
   * customer it was picked for, and only a branch in the current customer's
   * own list is ever sent — so switching customer can never carry the last
   * one's branch along, even while the new one's branches are loading.
   */
  const [pickedBranch, setPickedBranch] = useState<{ customerId: string; branchId: string } | null>(null);
  const branchesFor = !walkIn && !fromSamples && customerId ? customerId : undefined;
  const { open: openBranches, defaultBranch } = useCustomerBranches(branchesFor);
  const branchId =
    pickedBranch && pickedBranch.customerId === customerId ? pickedBranch.branchId : (defaultBranch?.id ?? '');
  const chosenBranch = openBranches.some((b) => b.id === branchId) ? branchId : undefined;
  /** A customer with one branch picks none (§7): the server's default decides. */
  const showBranchPicker = !!branchesFor && openBranches.length > 1;
  /** The channel before walk-in fixed it to B2C, put back when it is turned off. */
  const channelBeforeWalkIn = useRef<string | null>(null);

  // Set synchronously on submit. `isPending` only disables the buttons after
  // React re-renders, and two clicks inside one frame both get through that.
  const submitting = useRef(false);
  const mode = useRef<'draft' | 'confirm'>('draft');

  /**
   * Units of a product available to sell right now: the shelf, plus — when
   * completing samples — the units of it out on that order, which the sale
   * keeps first.
   */
  const stockFor = (productId: string): number => {
    const row = stock.find((r) => r.productId === productId);
    return (row ? Number(row.availableStock ?? 0) : 0) + outOnSamples(fromSamples, productId);
  };

  /**
   * The product's price for a channel — the one set, else the default landed +
   * markup, as the API resolved it (§3, 2026-10-18) — or null when it has none.
   */
  const listFor = (productId: string, ch: string) =>
    listPriceOf(products.find((p) => p.id === productId), ch);
  const priceFor = (productId: string, ch: string): number | null => {
    const price = listFor(productId, ch);
    return price ? Number(price.amount) : null;
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
    // The last customer's branch goes with them, now — not when the next
    // customer's branches arrive.
    if (id !== customerId) setPickedBranch(null);
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

  /** Samples on: a shop's order with no charge; walk-in, if it was on, goes off. */
  const toggleSamples = () => {
    if (!samples && walkIn) toggleWalkIn();
    setSamples(!samples);
    setRefusal(null);
  };

  const update = (key: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totals = useMemo(() => saleOrderTotals(lines), [lines]);

  // Below cost (§4, 2026-10-11): asked of the server as the lines change, and
  // shown under each line and the total. A warning only — neither button
  // looks at it.
  // Only a back-dated sale names its day: today is the server's default.
  // Samples are not sold, so there is no price to check against cost.
  // Completing samples is not checked either: the units kept are costed at
  // what they left at, which the shelf's FIFO cost the check reads is not.
  const priceCheck = usePriceCheck(lines, currency, {
    enabled: !samples && !fromSamples,
    orderedOn: orderedOn < businessToday() ? orderedOn : undefined,
  });

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
      fromSamples
        ? api.post(`/sales/orders/${fromSamples.id}/samples/convert`, body)
        : api.post('/sales/orders', body, { headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: (res, body) => {
      const order = res.data?.data ?? res.data;
      onSaved({
        order,
        confirmed: body.confirm === true || !!fromSamples,
        walkIn: body.walkIn === true,
        samples: body.samples === true,
        fromSamples: !!fromSamples,
      });
    },
    onError: (err) => setRefusal(apiError(err, t('saveFailed'))),
    onSettled: () => {
      submitting.current = false;
    },
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    if (walkIn || samples || fromSamples) mode.current = 'confirm';
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
      fromSamples
        ? // Exactly the lines on screen: the server keeps what went out, puts
          // back what is not here, and draws anything more from the shelf.
          { customerId, channel, currency, orderedOn, items }
        : samples
        ? // Left at the shop: a price only where one was typed — it is noted
          // for the decision, nothing is charged — and never a discount.
          {
            samples: true,
            customerId,
            ...(chosenBranch ? { branchId: chosenBranch } : {}),
            channel,
            currency,
            orderedOn,
            items: lines.map(({ productId, quantity, unitPrice }) => ({
              productId,
              quantity,
              ...(Number(unitPrice) > 0 ? { unitPrice } : {}),
            })),
          }
        : walkIn
        ? // No customer and never a draft: the server confirms and records the
          // payment of the full total with the order, or does none of it.
          { walkIn: true, channel: 'B2C', currency, orderedOn, confirm: true, payment: { method }, items }
        : {
            customerId,
            ...(chosenBranch ? { branchId: chosenBranch } : {}),
            channel,
            currency,
            orderedOn,
            confirm: mode.current === 'confirm',
            items,
          },
    );
  };

  const pending = mutation.isPending;
  const formId = useId();
  const confirming =
    mutation.variables?.confirm === true || mutation.variables?.samples === true || !!fromSamples;
  /** One button only: walk-in, samples, and completing samples have no draft. */
  const single = walkIn || samples || !!fromSamples;
  const fieldClass =
    'w-full min-w-0 rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2';

  return (
    <Dialog
      title={title}
      onClose={onCancel}
      size="lg"
      busy={pending}
      // The test id names the whole dialog — fields, the refusal and the
      // actions in its fixed footer — as it named the form when they were all
      // inside it.
      cardProps={{ 'data-testid': 'sale-order-form' }}
      footer={
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-row sm:justify-end sm:gap-3">
              {/* On a phone: the sale on its own row, Cancel and the draft side
                  by side under it — three full-width rows took a third of the
                  screen from the form (owner 2026-10-17). */}
              <button
                type="button"
                onClick={onCancel}
                className={`min-h-11 rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted sm:min-h-0 ${single ? 'col-span-2' : ''}`}
              >
                {tc('cancel')}
              </button>
              {/* First in the DOM, so Enter in a field saves a draft rather than
                  confirming a sale — implicit submission clicks the first submit.
                  A walk-in has no draft (§4), so there it is not offered at all. */}
              {!single && (
                <button
                  type="submit"
                  form={formId}
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
                  form={formId}
                onClick={() => (mode.current = 'confirm')}
                disabled={pending}
                data-testid="sale-submit"
                className={`order-first col-span-2 inline-flex min-h-11 cursor-pointer sm:order-none items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 ${
                  samples
                    ? 'bg-accent-600 text-primary-foreground hover:bg-accent-700'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {pending && confirming ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : fromSamples ? (
                  <PackageCheck className="h-4 w-4" />
                ) : samples ? (
                  <PackageOpen className="h-4 w-4" />
                ) : walkIn ? (
                  <Wallet className="h-4 w-4" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                {fromSamples
                  ? t('samples.complete')
                  : samples
                  ? t('samples.leave')
                  : walkIn
                  ? t('sellAndTakePayment')
                  : t('createAndConfirm')}
              </button>
            </div>
      }
    >
    <form id={formId} onSubmit={submit} noValidate className="space-y-4" data-sale-order-form="">
      {fromSamples ? (
        // Completing samples: say so, and what removing a line means.
        <p
          data-testid="samples-convert-note"
          className="flex items-start gap-2 rounded-lg border border-accent-300 bg-accent-50 px-3 py-2.5 text-sm text-accent-900"
        >
          <PackageCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{t('samples.completeNote', { units: unitsOut })}</span>
        </p>
      ) : (
        <SamplesSwitch
          on={samples}
          onToggle={toggleSamples}
          label={t('samples.switch')}
          hint={t('samples.switchHint')}
        />
      )}
      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          {/* The label row holds the switch and keeps the height of the other
              labels; the switch's touch area reaches past it. */}
          <div className="mb-1 flex h-5 items-center justify-between gap-2">
            <label className="block text-sm font-medium text-foreground">
              {walkIn ? t('paymentMethod') : t('customer')}
              {!walkIn && <FieldMark required />}
            </label>
            {/* Samples go to a shop: no walk-in beside them. */}
            {!samples && !fromSamples && <WalkInSwitch on={walkIn} onToggle={toggleWalkIn} label={t('walkIn')} />}
          </div>
          {walkIn ? (
            <Select
              name="paymentMethod"
              value={method}
              placeholder={tph('choosePaymentMethod')}
              onChange={setMethod}
              options={PAYMENT_METHODS.map((m) => ({ value: m, label: codeLabel('paymentMethod', m) }))}
            />
          ) : fromSamples ? (
            // The samples were left with this shop: the sale is to it.
            <Select
              name="customerId"
              required
              disabled
              value={customerId}
              onChange={() => {}}
              placeholder={tph('chooseCustomer')}
              options={customers.map((c) => ({ value: c.id, label: c.displayName, hint: codeLabel('customerType', c.type) }))}
            />
          ) : (
            <FieldWithQuickCreate entity="customer" onCreated={(c) => onCustomerChange(c.id, c)}>
              <Select
                name="customerId"
                required
                value={customerId}
                onChange={(id) => onCustomerChange(id)}
                placeholder={tph('chooseCustomer')}
                searchPlaceholder={tph('searchCustomers')}
                options={customers.map((c) => ({ value: c.id, label: c.displayName, hint: codeLabel('customerType', c.type) }))}
              />
            </FieldWithQuickCreate>
          )}
        </div>
        {showBranchPicker && (
          <div data-testid="sale-branch">
            <label className="mb-1 block text-sm font-medium text-foreground">
              {tb('column')}
              <FieldMark optional />
            </label>
            <Select
              name="branchId"
              value={chosenBranch ?? ''}
              onChange={(id) => setPickedBranch({ customerId, branchId: id })}
              placeholder={tb('noBranch')}
              options={openBranches.map((b) => ({
                value: b.id,
                label: b.isDefault ? `${b.name} · ${tb('defaultTag')}` : b.name,
                hint: tb('owesAmount', { amount: formatAmount(b.owed) }),
              }))}
            />
            <p data-testid="sale-branch-hint" className="mt-1 text-[11px] text-muted-foreground">
              {defaultBranch ? (branchId === defaultBranch.id ? tb('pickedDefault') : null) : tb('noDefault')}
            </p>
          </div>
        )}
        <div>
          <label htmlFor={`${formId}-ordered-on`} className="mb-1 block text-sm font-medium text-foreground">
            {samples ? t('samples.leftOn') : t('saleDate')}
            <FieldMark required />
          </label>
          <DatePicker
            id={`${formId}-ordered-on`}
            name="orderedOn"
            required
            disableFuture
            // A sale from samples cannot predate the day they were left.
            min={fromSamples?.leftOn}
            value={orderedOn}
            onChange={(day) => {
              setOrderedOn(day || businessToday());
              // A refusal about the stock on another day no longer applies.
              setRefusal(null);
            }}
          />
          {orderedOn < businessToday() && !samples && (
            <p data-testid="back-dated-note" className="mt-1 text-[11px] text-muted-foreground">
              {t('backDatedNote')}
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('channel')}</label>
          <Select
            name="channel"
            value={channel}
            placeholder={tph('chooseChannel')}
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
            placeholder={tph('chooseCurrency')}
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
            const listPrice = line.productId ? listFor(line.productId, channel) : null;
            const list = listPrice ? Number(listPrice.amount) : null;
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
                      placeholder={tph('chooseProduct')}
                      searchPlaceholder={tph('searchProducts')}
                      options={products
                        // Switched off, it is sold from the shelf until the
                        // shelf is empty, then it leaves (§3, owner 2026-10-14).
                        .filter((p) => isSellable(p, stockFor(p.id)))
                        .map((p) => {
                        const available = stockFor(p.id);
                        return {
                          value: p.id,
                          label: localName(p, locale),
                          keywords: otherName(p, locale),
                          // The count belongs where the product is chosen, not
                          // in an error after the order is built.
                          // Tag last, so a hint in either language still starts with the SKU
                          // and lines up with its neighbours (the Arabic tag first flipped the line).
                          hint: `${p.sku} · ${formatNumber(available)} ${t('inStock')}${isOffered(p) ? '' : ` · ${t('inactiveTag')}`}`,
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
                <div
                  className={`field-row mt-2 grid gap-2 ${
                    samples
                      ? 'grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)]'
                      : 'grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)]'
                  }`}
                >
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">{t('quantity')}</label>
                    <input
                      type="number"
                      placeholder={tph('quantitySmall')}
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
                    <label className="mb-1 block text-xs text-muted-foreground">
                      {samples ? t('samples.priceOptional') : t('unitPrice')}
                    </label>
                    <MoneyInput
                      placeholder={tph('money')}
                      data-field="unitPrice"
                      value={line.unitPrice || ''}
                      onChange={(raw) =>
                        update(line.key, { unitPrice: Number(raw), priceTyped: true })
                      }
                      className={`${fieldClass} border-border text-start focus:ring-ring`}
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
                    {/* The line holds the default: say where it came from. */}
                    {line.productId && list != null && Number(line.unitPrice) === list && (
                      <DefaultPriceHint price={listPrice} className="mt-1 block text-[11px] text-muted-foreground" />
                    )}
                  </div>
                  {!samples && (
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">{t('discount')}</label>
                    <MoneyInput
                      placeholder={tph('discount')}
                      data-field="discount"
                      value={line.discount || ''}
                      onChange={(raw) => update(line.key, { discount: Number(raw) })}
                      aria-invalid={discountTooLarge || undefined}
                      className={`${fieldClass} text-start ${
                        discountTooLarge
                          ? 'border-destructive focus:ring-destructive'
                          : 'border-border focus:ring-ring'
                      }`}
                    />
                    {discountTooLarge && (
                      <p className="mt-1 text-[11px] text-destructive">{t('discountTooLarge')}</p>
                    )}
                  </div>
                  )}
                </div>

                {/* Samples have no line total: the order says "No charge yet" once. */}
                {!samples && (
                <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="text-xs text-muted-foreground">{t('lineTotal')}</span>
                  <span className="whitespace-nowrap font-medium text-foreground" data-testid="line-total">
                    <Money value={lineTotals.lineTotalCents / 100} currency={currency} />
                  </span>
                </div>
                )}
                {!samples && <BelowCostLine check={priceCheck?.lines[idx]} />}
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
              {samples ? (
                <span className="text-sm font-semibold text-accent-800">{t('samples.noCharge')}</span>
              ) : (
                <Money value={totals.subtotalCents / 100} currency={currency} />
              )}
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
        {!samples && <BelowCostTotal result={priceCheck} className="mt-2" />}
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
    </form>
    </Dialog>
  );
}

/**
 * The samples switch (§4, samples at shops): amber, the colour of "not a sale
 * yet", with its one-line explanation under the label. A typed `button` with
 * `role="switch"`, so it never submits the form it sits in; the whole row is
 * the touch target.
 *
 * Both lines are accent-900 on accent-50 when on (8.8:1; WCAG AA asks 4.5).
 * No `dark:` variants: the office has one light palette whatever the OS says,
 * and Tailwind's `dark:` follows the OS — on a Mac in dark mode it swapped the
 * text for accent-200/300 while the box stayed pale, which is the unreadable
 * pale-orange-on-pale-orange the owner sent (1.2:1 and 1.5:1, 2026-10-18).
 */
function SamplesSwitch({
  on,
  onToggle,
  label,
  hint,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="samples-switch"
      onClick={onToggle}
      className={`flex w-full cursor-pointer touch-manipulation select-none items-start gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        on
          ? 'border-accent-400 bg-accent-50'
          : 'border-border bg-background hover:bg-muted'
      }`}
    >
      <span
        aria-hidden
        className={`relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-accent-500' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block size-3 rounded-full bg-background shadow transition-transform duration-150 ${
            on ? 'translate-x-3.5 rtl:-translate-x-3.5' : 'translate-x-0.5 rtl:-translate-x-0.5'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className={`block text-sm font-medium ${on ? 'text-accent-900' : 'text-foreground'}`}>
          {label}
        </span>
        <span className={`block text-xs ${on ? 'text-accent-900' : 'text-muted-foreground'}`}>
          {hint}
        </span>
      </span>
    </button>
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
