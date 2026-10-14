# Spec — a purchase paid by a friend, repaid in pounds (L1)

> Superseded in part: money accounts were removed by the owner on 2026-10-14 (BUSINESS_LOGIC §9,
> "Money accounts — removed"). The repayment's account, `GET /ledger/accounts` and
> `ACCOUNT_NOT_USABLE` below are history, not the current system.

BUSINESS_LOGIC §18 is the rule; this is how it is built. Every choice §18 does not
already state is recorded in §18 as a guess (OPEN until the owner confirms).

## 1. Data model

```
Lender            id · name · phone? · notes? · createdAt/updatedAt
LenderFinancing   id · lenderId · purchaseOrderId · cycleId (the order's, never changes)
                  currency (the order's) · amount NUMERIC(18,2) in that currency
                  fxRateToEgp NUMERIC(18,4)  — the ORDER's rate, copied when recorded
                  amountEgp NUMERIC(18,2)    — amount × that rate, half up
                  paidOn DATE · note? · createdBy
                  ledgerTransactionId        — its lender_financing INFLOW
                  removedAt? · removedBy? · removalReason? · removalTransactionId?
                  unique (lenderId, purchaseOrderId) WHERE removed_at IS NULL
LenderRepayment   id · financingId · paidOn DATE · accountId (an active EGP money account)
                  amountEgp NUMERIC(18,2)    — pounds actually paid
                  rateToEgp NUMERIC(18,4)    — that day's rate
                  cleared NUMERIC(18,2)      — debt cleared, in the debt's currency
                  clearedAtOrderRateEgp NUMERIC(18,2) — what `cleared` cost at the order's rate
                  exchangeDiffEgp NUMERIC(18,2)       — amountEgp − clearedAtOrderRateEgp
                  note? · createdBy · ledgerTransactionId (OUTFLOW)
                  reversedAt? · reversedBy? · reversalReason? · reversalTransactionId?
LenderPlan        id · financingId · agreedOn DATE · status ACTIVE|COMPLETED|CANCELLED · note?
                  unique (financingId) WHERE status = 'ACTIVE'
LenderPlanInstalment id · planId · sequence · dueOn DATE · amount NUMERIC(18,2) (debt currency)
```

A *standing* financing has no `removedAt`; a *standing* repayment has no `reversedAt`.
Only standing rows count anywhere.

## 2. The money math (`apps/api/src/common/lender-math.ts`, pure)

- **Owed** = financing.amount − Σ standing repayments' `cleared`. In the order's currency.
- **Settling amount** at rate r = `owed × r`, rounded half up to the piastre. It is what
  the record-repayment dialog offers as "pays it off".
- **A repayment of E pounds at rate r**:
  - r ≤ 0 → `RATE_NOT_POSITIVE`; E ≤ 0 → validation.
  - E > settling amount → `LENDER_REPAYMENT_EXCEEDS_OWED` (names the settling amount).
  - E = settling amount → **final**: `cleared = owed` exactly.
  - otherwise `cleared = E ÷ r` **rounded down** to the currency's two places, so a
    part payment never clears more than the pounds bought. If that is 0.00 →
    `LENDER_REPAYMENT_CLEARS_NOTHING`.
  - Rounding down leaves at most 0.01 of the currency per part payment on the debt; the
    final repayment's settling amount includes it, so the debt always ends at exactly 0.
- **At the order's rate**: part payment `round_half_up(cleared × orderRate, 2)`; final
  repayment `financing.amountEgp − Σ the other standing repayments' clearedAtOrderRateEgp`,
  so the parts re-sum to the financing's own EGP figure exactly (the §2 residual habit).
- **Exchange difference** = E − at-order-rate. Positive: the dirham rose, a cost to the
  cycle. Negative: it fell, a gain. Over a fully repaid debt it sums to
  Σ pounds paid − financing.amountEgp exactly.

## 3. Ledger (`common/ledger-categories.ts`, one list)

| Event | Row | Category | Counts as |
|---|---|---|---|
| Friend pays the supplier | INFLOW amountEgp, no account | `lender_financing` | capitalised — financing, not income |
| Financing removed | OUTFLOW same, `reversalOfId` → the inflow | `lender_financing` | — |
| Repayment | OUTFLOW E pounds, the chosen account | `lender_repayment` | capitalised — financing, not expense |
| Repayment reversed | INFLOW same, `reversalOfId` → the outflow | `lender_repayment` | — |

Both are added to `CAPITALISED_CATEGORIES` (not operating expenses). The purchase itself
is booked at receipt as today (`purchase` OUTFLOW of the landed line cost), so the
financing INFLOW is what keeps "cash on hand" true: the goods were paid with the friend's
money, not ours. After a full repayment the ledger nets to −(exchange difference), which is
the real cost.

**The exchange difference is not a ledger row** (like a loss, §9): it is read from the
standing repayments through one function, `exchangeDifferenceEgp(db, cycleId | null)` in
`common/lender-debt.ts`, which settlement (`project`), the cycle profitability and the
dashboard's net profit all call. Settlement puts it inside `expensesEgp` and shows it on its
own (`exchangeDifferenceEgp`), as it does losses; the dashboard subtracts it from net profit
and shows it on its own; it is never in `totalExpenses` (not an operating expense).

## 4. Gates

- `assertLendersRepaid(db, cycleId)` beside `assertShipmentAccounted`, called by the plain
  transition to SETTLEMENT and by settlement `approve`. Refusal `LENDER_DEBT_OUTSTANDING`
  with `{ cycle, owed: "Ahmed 12,000.00 AED; Sami 500.00 AED" }`.
- Cancelling a cycle with a standing financing → `CYCLE_HAS_LENDER_FINANCING`.
- Editing a purchase line so the order totals less than its standing financings →
  `FINANCING_EXCEEDS_ORDER`.

## 5. Endpoints

| Method | Path | Roles | Body → response |
|---|---|---|---|
| GET | /lenders | CORE_PARTNER, ADMIN_SUPPORT | → `{ data: [{ id, name, phone, notes, owed: [{ currency, owed }], financings }] }` |
| GET | /lenders/:id | CORE_PARTNER, ADMIN_SUPPORT | → `{ data: { lender, financings: [FinancingView], owed: [...] } }` |
| POST | /lenders | CORE_PARTNER | `{ name, phone?, notes? }` → lender |
| GET | /purchases/:id/financings | any office role, investor scoped | → `{ data: { orderTotal, currency, financed, financings: [FinancingView] } }` |
| POST | /purchases/:id/financings | CORE_PARTNER | `{ lenderId, amount, paidOn?, note? }` → FinancingView |
| GET | /cycles/:id/financing | any office role, investor scoped | → `{ data: { financedEgp, owed: [{ lender, currency, owed }], financings: [FinancingView] } }` |
| POST | /lender-financings/:id/remove | CORE_PARTNER | `{ reason }` |
| GET | /lender-financings/:id/quote?rateToEgp= | CORE_PARTNER, ADMIN_SUPPORT | → `{ owed, currency, settlingEgp }` |
| POST | /lender-financings/:id/repayments | CORE_PARTNER | `{ amountEgp, rateToEgp, accountId, paidOn?, note? }` |
| POST | /lender-repayments/:id/reverse | CORE_PARTNER | `{ reason }` |
| POST | /lender-financings/:id/plan | CORE_PARTNER | `{ agreedOn?, note?, instalments: [{ dueOn, amount }] }` |
| POST | /lender-plans/:id/cancel | CORE_PARTNER | `{ reason }` |
| GET | /ledger/accounts | CORE_PARTNER, ADMIN_SUPPORT | → active money accounts |

`FinancingView` = `{ id, lender, purchaseOrder{ id, reference }, cycle{ id, code, status },
currency, amount, fxRateToEgp, amountEgp, paidOn, removedAt, repaid, owed, exchangeDiffEgp,
repayments[], plan (evaluated, §7 shape) }`. Money as strings with two places.

Costing's `GET /costing/cycles/:id/landed-cost` gains `totals.lenderFinancedEgp` and
`totals.toFundEgp` (= landed − financed, never below zero): the one figure "Split equally"
and the wizard's funded-versus-cost line read.

The dashboard KPIs gain `owedToLenders: { lines: [{ currency, owed, rateToEgp, owedEgp }],
totalEgp, missingRate }` and `exchangeDifferenceEgp`.

## 6. Overdue

The daily job (`GET /jobs/overdue-payments` and the `@Cron`) also runs
`LendersService.notifyOverdue()`. A lender plan is evaluated exactly like a customer plan
(one function, `common/instalment-schedule.ts`, now used by both): cumulative, earliest
first, due today is not overdue. Paid-to-date is what standing repayments dated on or after
the plan's agreed day cleared. Each active core partner is told once per instalment
(`LENDER_INSTALMENT_OVERDUE`, payload `lenderInstalmentId`).

## 7. Screens

- **Lenders** (Money group): list with what each is owed; create through the shared
  `entity-forms` registry, so the `+` beside a lender picker opens the same form.
- **A lender's page**: per financing — order, cycle, amount, owed, plan; repayments with
  date, pounds, rate, cleared, exchange difference, account, reversed state; "Record
  repayment" (rate prefilled from the current FX rate, editable; the settling amount shown
  for the rate entered; "pay it all" fills it), "Reverse" (reason), "Set a plan".
- **Paid by a friend** panel on the purchase order dialog and on cycle details: "Paid by
  <friend> — 30,000.00 AED; 18,000.00 AED still owed", and the add form (lender picker with
  `+`, amount, date; the order picker on the cycle page).
- **Dashboard**: "Owed to lenders" — each currency, and pounds at today's rate.
- **Settlements**: a cycle that still owes shows who and how much on its card; approving
  is refused with the same.
