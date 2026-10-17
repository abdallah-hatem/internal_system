'use client';

import { formatMoney, formatNumber } from '@/lib/numbers';
import { localName } from '@/lib/localized-name';
import { LatinText } from '@/components/ui/latin-text';
import { BrandMark } from '@/components/layout/brand-mark';
import { DOCUMENT_FONT } from '@/components/ui/document-language';
import { CONTRACT_TEXT, contractDay, type ContractLanguage } from './contract-text';

/** `GET /sales/orders/:id/contract` (api PaymentPlansService.saleContract). */
export interface SaleContract {
  saleId: string;
  orderNo: string;
  /** "CT-" + the order number. */
  number: string;
  /** The day the plan was agreed, YYYY-MM-DD. */
  date: string;
  currency: string;
  customer: { id: string; displayName: string; phone: string | null };
  lines: {
    id: string;
    product: string;
    productAr: string | null;
    sku: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    lineTotal: string;
  }[];
  total: string;
  paidAtSigning: string;
  remaining: string;
  plan: {
    id: string;
    reference: string;
    status: string;
    instalments: { id: string; sequence: number; dueOn: string; amount: string }[];
  };
}


/** The sheet itself, in the contract's language and direction. */
export function ContractDocument({
  contract: c,
  lang,
  sheet = false,
}: {
  contract: SaleContract;
  lang: ContractLanguage;
  /**
   * Flat — no card border, shadow or padding — for the PDF to draw inside
   * DocumentActions' A4 sheet (components/ui/document-actions.tsx).
   */
  sheet?: boolean;
}) {
  const w = CONTRACT_TEXT[lang];
  const money = (v: string) => <bdi dir="ltr" className="tabular-nums">{formatMoney(v, { locale: lang, currency: c.currency })}</bdi>;
  const num = (v: string | number) => <bdi dir="ltr" className="tabular-nums">{formatNumber(v, { locale: lang })}</bdi>;
  const day = (d: string) => <bdi dir="ltr" className="tabular-nums">{contractDay(d)}</bdi>;
  const cell = 'border border-border px-2 py-1.5 text-start align-top';
  const head = `${cell} bg-muted font-semibold`;
  const end = 'text-end';

  return (
    <article
      data-testid="contract"
      data-print-doc
      lang={lang}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      className={
        sheet
          ? 'bg-card text-start text-[12.5px] leading-relaxed text-foreground'
          : 'mx-auto max-w-[794px] rounded-xl border border-border bg-card px-6 py-8 text-start text-[12.5px] leading-relaxed text-foreground shadow-sm sm:px-12'
      }
      style={{ fontFamily: DOCUMENT_FONT }}
    >
      <header className="flex items-start justify-between gap-4 border-b-2 border-foreground pb-3" data-print-keep>
        <div className="flex items-center gap-3">
          <BrandMark size={44} />
          <div>
            <h1 className="text-[22px] font-bold leading-tight" data-testid="contract-title">{w.title}</h1>
            <p className="text-xs text-muted-foreground">{w.tagline}</p>
          </div>
        </div>
        <dl className="shrink-0 text-xs text-muted-foreground">
          <div>
            <dt className="inline">{w.number}: </dt>
            <dd className="inline whitespace-nowrap font-semibold text-foreground" data-testid="contract-number">
              <bdi dir="ltr">{c.number}</bdi>
            </dd>
          </div>
          <div>
            <dt className="inline">{w.date}: </dt>
            <dd className="inline" data-testid="contract-date">{day(c.date)}</dd>
          </div>
          <div>{w.city}</div>
        </dl>
      </header>

      <Section title={w.parties}>
        <div className="grid grid-cols-2 gap-4" data-print-keep>
          <div className="rounded-md border border-border px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">{w.seller}</p>
            <p className="font-semibold">{w.sellerName}</p>
            <Blank label={w.representative} />
            <Blank label={w.phone} />
          </div>
          <div className="rounded-md border border-border px-3 py-2" data-testid="contract-buyer">
            <p className="text-xs font-medium text-muted-foreground">{w.buyer}</p>
            <p className="font-semibold"><LatinText>{c.customer.displayName}</LatinText></p>
            {c.customer.phone ? (
              <p>
                {w.phone}: <bdi dir="ltr">{c.customer.phone}</bdi>
              </p>
            ) : (
              <Blank label={w.phone} />
            )}
            <Blank label={w.address} />
            <Blank label={w.idOrRegistration} />
          </div>
        </div>
      </Section>

      <Section title={w.goods}>
        <table className="w-full border-collapse text-xs" data-testid="contract-lines">
          <thead>
            <tr>
              <th className={`${head} w-9`}>{w.line}</th>
              <th className={head}>{w.item}</th>
              <th className={`${head} ${end} w-[70px]`}>{w.quantity}</th>
              <th className={`${head} ${end} w-[120px]`}>{w.unitPrice}</th>
              <th className={`${head} ${end} w-[130px]`}>{w.lineTotal}</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l, i) => (
              <tr key={l.id} data-testid="contract-line">
                <td className={cell}>{num(i + 1)}</td>
                <td className={cell}>
                  <LatinText>{localName({ name: l.product, nameAr: l.productAr }, lang)}</LatinText>
                </td>
                <td className={`${cell} ${end}`}>{num(l.quantity)}</td>
                <td className={`${cell} ${end}`}>{money(l.unitPrice)}</td>
                <td className={`${cell} ${end}`}>{money(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2.5 grid grid-cols-3 gap-2.5" data-print-keep>
          <Total label={w.totalPrice} value={money(c.total)} testId="contract-total" />
          <Total label={w.paidAtSigning} value={money(c.paidAtSigning)} testId="contract-paid" />
          <Total label={w.remaining} value={money(c.remaining)} testId="contract-remaining" />
        </div>
      </Section>

      <Section title={w.schedule}>
        <table className="w-full border-collapse text-xs" data-testid="contract-schedule">
          <thead>
            <tr>
              <th className={`${head} w-9`}>{w.line}</th>
              <th className={head}>{w.dueOn}</th>
              <th className={`${head} ${end}`}>{w.instalment}</th>
              <th className={`${head} w-[150px]`}>{w.receipt}</th>
            </tr>
          </thead>
          <tbody>
            {c.plan.instalments.map((i) => (
              <tr key={i.id} data-testid="contract-instalment">
                <td className={cell}>{num(i.sequence)}</td>
                <td className={cell}>{day(i.dueOn)}</td>
                <td className={`${cell} ${end}`}>{money(i.amount)}</td>
                <td className={cell} />
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={w.terms}>
        <ol className="list-decimal space-y-1 ps-5" data-testid="contract-terms" data-print-keep>
          {w.clauses.map((clause) => (
            <li key={clause}>{clause}</li>
          ))}
        </ol>
      </Section>

      {/* The signatures and the copies line are one block: a sheet never ends
          between them, leaving the line alone on a sheet of its own. */}
      <div data-print-keep>
        <div className="mt-7 grid grid-cols-2 gap-10 text-xs">
          <div className="border-t border-foreground pt-1.5">
            {w.sellerSigns}
            <br />
            {w.nameAndSignature}
          </div>
          <div className="border-t border-foreground pt-1.5">
            {w.buyerSigns}
            <br />
            {w.nameAndSignature}
          </div>
        </div>

        {/* Sheet numbers are not part of the document: the PDF draws them, and
            only when there is more than one sheet. */}
        <footer className="mt-5 text-[10.5px] text-muted-foreground">{w.copies}</footer>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 mt-5 border-b border-border pb-1 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A label and a dotted line to fill in by hand. */
function Blank({ label }: { label: string }) {
  return (
    <p className="flex items-end gap-1.5">
      <span className="min-w-0 sm:shrink-0">{label}:</span>
      <span className="mb-1 min-w-6 flex-1 border-b border-dotted border-muted-foreground sm:min-w-20" />
    </p>
  );
}

function Total({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-md border border-border px-2.5 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="text-[15px] font-bold" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}
