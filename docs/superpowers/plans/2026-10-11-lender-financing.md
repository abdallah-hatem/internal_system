# Plan — a purchase paid by a friend, repaid in pounds (L1)
Spec `docs/superpowers/specs/2026-10-11-lender-financing.md` · BUSINESS_LOGIC §18 (+ §2, §7, §8, §9)

| Wave | Tasks |
|---|---|
| 1 | L1.1 schema + migration (backend · logic) |
| 2 | L1.2 money math (backend · logic) ‖ L1.3 one schedule evaluator (backend · logic) |
| 3 | L1.4 lenders service + endpoints (backend · logic) |
| 4 | L1.5 profit, gates, funding, dashboard (backend · logic) ‖ L1.6 overdue (backend · logic) |
| 5 | L1.7 web: lenders, panel, repayment dialog (web · ui) ‖ L1.8 dashboard + settlement (web · surface) |
| 6 | L1.9 tests: 34 invariants, spec 98 (e2e · logic) · L1.10 check-data (scripts · logic) |

### L1.1 — Schema (backend · logic)
- [ ] Migration adds lenders, lender_financings, lender_repayments, lender_plans, lender_plan_instalments
- [ ] Partial unique: one standing financing per lender per order; one active plan per financing
- [ ] Run against the local DB before any Playwright run, never during one (LEARNINGS)

### L1.2 — Money math (backend · logic) — `common/lender-math.ts`, unit-tested branch by branch
- [ ] Part payment clears E ÷ r rounded DOWN; never more than the pounds bought
- [ ] E = settling amount clears exactly what is owed (final)
- [ ] E > settling amount → `LENDER_REPAYMENT_EXCEEDS_OWED`   (too much)
- [ ] E so small it clears 0.00 → `LENDER_REPAYMENT_CLEARS_NOTHING`   (zero)
- [ ] r ≤ 0 → `RATE_NOT_POSITIVE`; E ≤ 0 refused   (zero / negative, a rate of zero)
- [ ] Rate rose → exchange difference positive (a cost); rate fell → negative (a gain); same rate → 0
- [ ] Three repayments at three rates end at exactly 0 owed, and Σ at-order-rate = financing EGP exactly
- [ ] Final repayment's at-order-rate absorbs the rounding of the earlier ones

### L1.3 — One instalment evaluator (backend · logic)
- [ ] `PaymentPlansService.evaluate` and the lender plan both call `common/instalment-schedule.ts`; customer plan output unchanged (existing specs green)
- [ ] Cumulative, earliest first, due today is not overdue

### L1.4 — Lenders service + endpoints (backend · logic)
Edge cases:
- [ ] Financing more than the order's total → `FINANCING_EXCEEDS_ORDER`; across two friends too   (too much, second time)
- [ ] The same friend financing the same order twice → `LENDER_ALREADY_FINANCES_ORDER`   (second time)
- [ ] Zero / negative amount → refused; an order with no lines → `FINANCING_EXCEEDS_ORDER`   (zero)
- [ ] A date in the future → `DATE_IN_FUTURE`   (backwards in time)
- [ ] An order on a CLOSED, SETTLEMENT or CANCELLED cycle → `CYCLE_CLOSED_FOR_FINANCING`   (wrong context)
- [ ] An unknown lender / order id → 404 `NOT_FOUND`, never a 500   (things that do not exist)
- [ ] Repaying more than owed → refused, says the settling amount; repaying a removed financing → `FINANCING_REMOVED`
- [ ] Repayment before the friend paid → `LENDER_REPAYMENT_BEFORE_FINANCING`; future → `DATE_IN_FUTURE`
- [ ] Account not an active EGP account → `ACCOUNT_NOT_USABLE`
- [ ] Reversing twice → `LENDER_REPAYMENT_ALREADY_REVERSED`; reason required   (second time)
- [ ] Reversing a repayment on a settled/closed cycle → `CYCLE_SETTLED`   (wrong context)
- [ ] Removing a financing with a standing repayment → `FINANCING_HAS_REPAYMENTS`; removing twice → `FINANCING_REMOVED`   (second time)
- [ ] Repaying lender A's debt "with lender B": a repayment is against a financing id, so the lender is the financing's; a plan id/financing id from another lender is just not found   (wrong owner)
- [ ] Plan: instalments total more than owed → `LENDER_PLAN_EXCEEDS_OWED`; a second active plan → `LENDER_PLAN_EXISTS`; nothing owed → `LENDER_NOTHING_OWED`
- [ ] Every write: TEMP_INVESTOR → `ROLE_NOT_ALLOWED`; portal token → `WRONG_SURFACE`; CORE_PARTNER works   (rule 12, both directions)
- [ ] Ledger rows written in the same transaction; audit after commit; no service call inside `$transaction`

### L1.5 — Profit, gates, funding, dashboard (backend · logic)
- [ ] Exchange difference in settlement expenses (shown alone), cycle profitability, dashboard net profit — one function
- [ ] `lender_financing` / `lender_repayment` in `CAPITALISED_CATEGORIES`; not in totalExpenses, not in cycle "investment"
- [ ] Transition to SETTLEMENT and settlement approve refuse while owed (`LENDER_DEBT_OUTSTANDING`); pass once repaid
- [ ] Cancelling a cycle with a standing financing refused
- [x] A purchase line edited below the financed total — not reachable (lines cannot be edited, only added); check-data 19.1 watches for it
- [ ] Costing totals: `lenderFinancedEgp`, `toFundEgp`; "Split equally" asks partners only for the remainder
- [ ] Dashboard: owed to lenders per currency + EGP at today's rate; a currency with no rate says so

### L1.6 — Overdue (backend · logic)
- [ ] An overdue lender instalment tells every active core partner once; a second run sends nothing
- [ ] Reuses the daily job — no new cron

### L1.7 — Web: lenders, paid-by-a-friend, repayment (web · ui)
- [ ] Lenders page via `ENTITY_FORMS.lender`; `+` quick-create beside the lender picker
- [ ] Panel on the PO dialog and cycle details; investor sees it read-only
- [ ] Record repayment: rate prefilled from `/currency-rates`, editable, a typed rate never overwritten; settling amount for the rate entered; "pay all" fills it
- [ ] Reverse with reason; plan form
- [ ] Shared Select / DatePicker; logical properties; en + ar; 390 px

### L1.8 — Dashboard figure + settlement refusal (web · surface)
- [ ] "Owed to lenders" tile; settlement card shows who is owed what; approve refusal translated

### L1.9 — Tests (e2e · logic)
- [ ] 34: cannot clear more than owed; cash out = pounds paid; cycle profit includes the exchange difference and settlement + dashboard agree; cannot settle while owed
- [ ] 98-lender-financing: finance a PO from the cycle page with a `+`-created friend, three repayments at three rates, the last settles exactly, one reversed, the settlement gate, an investor refused
- [ ] Each new test seen failing before its code, passing after

### L1.10 — check-data (scripts · logic)
- [ ] A debt below zero (more cleared than lent) is counted; a repayment whose ledger row is missing is counted
