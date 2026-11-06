> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 18. A purchase paid by a friend, repaid in pounds  — DECIDED 2026-10-11 (owner), details OPEN

**What happens in the business (owner, 2026-10-11).** Sometimes a friend pays a
supplier for us — the whole order, say 30,000 AED. We then pay him back in
Egyptian pounds over a few months (three, for example). Each repayment is worth
whatever the dirhams are worth **on the day we pay him**: what we owe him is
30,000 AED, not a fixed number of pounds.

**The guesses below are the code's current answer. Each is OPEN until the owner
confirms it.**

| Rule | Guess | Why |
|---|---|---|
| Who the friend is | A **lender**: a new kind of contact — not a partner, not a customer, not a supplier. He shares in no profit. | He is owed money; he does not own any of the cycle. |
| What he can pay for | All or part of one purchase order, in that order's currency. Never more than the order's total. **Replaced 2026-10-16: the cap is the cycle's cost still unpaid by friends — see the end of this section.** | The example is a supplier order in dirhams. Shipping legs paid by a friend can be added later. |
| What we owe | The amount he paid, **in his currency** (e.g. 30,000 AED), until it reaches zero. | The owner's rule: each payment is worth the rate on that day. |
| A repayment | We pay pounds on a date, at that day's rate (prefilled from the current rate, editable). It clears pounds ÷ rate of the debt. | — |
| Paying too much | Refused: a repayment cannot clear more than is still owed. The last one shows exactly how many pounds settle it at the rate entered. | Rule 1 of the working rules: too much is refused. |
| A plan | Optional: a number of instalments and their due dates (e.g. 10,000 AED a month for three months). An instalment past its due date alerts the partners once, like a customer's (§7). | Same habit as customer plans. |
| What the goods cost | **Unchanged**: the order's lines cost what they cost at the order's own rate, and the batches are costed from that as always (§2). Nothing is re-priced when a repayment happens. | A sale's cost is never changed after the fact (§3). |
| The rate moving | The pounds actually paid minus the debt valued at the order's rate is an **exchange difference**: a cost to the cycle when the dirham rose, a gain when it fell. It counts in that cycle's profit and in the dashboard's. It is not an operating expense and does not re-price stock. | It is a real cost of that cycle's purchase. |
| Cash | No cash leaves when the friend pays the supplier. Cash leaves on each repayment, for the pounds actually paid. | Cash flow follows the money (§9). |
| Settling the cycle | **A cycle cannot be settled while it still owes a lender.** The settlement screen says how much is left and to whom. | Profit is not known until the exchange difference is. Partners would otherwise split money that still has to go to the friend. |
| Partners' capital | ~~The amount the friend paid (at the order's rate) counts toward funding the cycle, so "Split equally" asks the partners for the rest only.~~ **Superseded 2026-10-19 (owner):** his payment is a loan to the partners; they fund the whole cycle, directly or by repaying him, and each partner's contribution is their share of it ("The partners repay the friend", end of this section). | The owner: "we split money among us to repay the lender". |
| Who can do it | Core partners. Others see it, read-only, where they can already see the cycle. | Money-moving rule (working rules §12). |
| A mistake | A repayment is reversed, never deleted or edited — with a reason, once only. The friend's payment can be removed only while nothing has been repaid. | Financial history is never rewritten (§9). |

**Where it shows**
- The purchase order and the cycle page: "Paid by <friend> — 30,000 AED; 18,000 AED still owed".
- A lender's own page: everything he paid for, every repayment with its rate, and what is still owed.
- The dashboard: what we owe lenders, in their currency and in pounds at today's rate.

**Settled while building it (L1, 2026-10-11) — guesses, each OPEN until the owner confirms.**

| Question §18 left open | Guess built | Why |
|---|---|---|
| How much debt a part repayment clears | Pounds ÷ that day's rate, **rounded down** to the piastre of his currency. | Never clear more than the pounds actually bought. |
| Rounding left on the debt | At most 0.01 (of his currency) per part repayment. The repayment that pays it off is the exact "pays it off" figure shown — what is owed × the rate, to the piastre — and it clears all that is left, so the debt ends at exactly zero. | The last one settles exactly (rule 1: no hidden residue). |
| Paying a few piastres more than the "pays it off" figure | Refused, naming the figure. | Too much is refused. |
| A repayment so small it clears 0.00 | Refused. | A payment that changes nothing is a slip. |
| The exchange difference, exactly | Each repayment's pounds − what it cleared at the order's rate (to the piastre); the last one takes whatever keeps the total at the order's rate equal to what he paid at that rate. Over a repaid debt: pounds paid − his amount at the order's rate. | §2's residual habit. |
| Where it is kept | On each repayment, not as a ledger row — the ledger shows the pounds leaving; settlement, cycle profit and the dashboard read the difference from the repayments through one function. | A loss is handled the same way (§9). |
| Ledger | When he pays: money *in* (`lender_financing`) at the order's rate — the goods are booked out at receipt as always, and this says whose money paid. Each repayment: money *out* (`lender_repayment`) for the pounds ("Which account" below). Both are financing: not income, not an expense. | Keeps cash on hand true: we did not pay the supplier. |
| Which account | **DECIDED 2026-10-11 by the owner: none is asked; 2026-10-14: money accounts removed altogether.** On 2026-10-11 he said the step does not matter — customer payments, purchases and the other money flows never recorded an account, so a repayment was the only flow that asked. On 2026-10-14: "we don't need money accounts". There is no account to name: the office's Record repayment has no "From account" field, the lender page no account column, the assistant's `record_lender_repayment` no account parameter and `get_lender` no account on a repayment. A repayment body that names one is refused as an unknown field (`VALIDATION_FAILED`; the old `ACCOUNT_NOT_USABLE` refusal is gone with it). The stored links were dropped with the accounts (§9, "Money accounts — removed"). | The owner's rule; one flow behaving like the others. |
| One friend, one order | A friend's payment for an order is recorded once; to change it, remove it (only while nothing is repaid) and record it again. Two friends may share one order, never above its total. | Doubles are the second-time bug. |
| Which cycles | Not on a cycle in settlement, closed or cancelled. Cancelling a cycle whose order a friend paid for is refused until his payment is removed. An order with no lines (a draft from before PO_NEEDS_ITEM) takes no friend's payment. No guard stops a purchase line being cut below what friends paid — none is needed today, because a line cannot be edited once added; check-data 19.1 watches for it. | A cancelled cycle "never ordered anything" (§15). |
| Dates | His payment and each repayment cannot be in the future; a repayment cannot be dated before he paid. A date left out is today in Cairo, as a payment's is (§7a). | Records of things that happened. |
| Reversing a repayment on a settled or closed cycle | Refused — reverse the settlement first. | It would reopen a debt on a cycle already split. |
| Removing his payment once repayments were reversed | Allowed: only standing (not reversed) repayments block it. Removing it, with a reason, cancels his active plan on it and writes a balancing ledger outflow pointing at the original inflow; the row stays, marked removed. | Nothing has been repaid. |
| A plan | Per order he paid for; instalments in his currency, totalling no more than is owed. One active plan at a time; cancel and agree again. Progress counts repayments dated on or after the plan's day, cumulatively, earliest instalment first — the same function as a customer's plan (§7). | Same habit as customer plans. |
| Who is told when one is late | Every active core partner, once per instalment, by the existing morning job. | §7. |
| "Owed to lenders" on the dashboard | Each currency, and in pounds at the current rate on the exchange-rate page; a currency with no rate is shown without pounds and says so. | §18: "in pounds at today's rate". |
| "Split equally" | **Since 2026-10-19:** splits the cycle's whole cost (goods, legs, expenses charged to it, leftovers moved in) less investors' money — what friends paid is **not** taken off; on a cycle a friend paid for it is each partner's equal share of repaying him. Until then it took off what friends paid. | Owner 2026-10-19 ("The partners repay the friend"). |
| A cycle a friend paid for entirely | **SUPERSEDED 2026-10-19 by the owner.** ~~DECIDED 2026-10-11, built in L2: its profit is split equally among the cycle's core partners; a temporary investor on it gets nothing; a custom split still overrides. "Entirely" means every contribution is zero and the friends' payments leave nothing to fund (`toFundEgp` zero).~~ Now: the partners enter their shares of repaying him (any split — "it does not have to be equally maybe 30,30,40") and profit follows them; with nothing entered it refuses `CYCLE_NOT_FUNDED` like any other cycle, wholly or partly paid by a friend. A custom split still overrides. | The owner, 2026-10-19: "no but I need to show that we split money among us to repay the lender which means that we pay, it looks vague as if we payed nothing". |
| Through the assistant | **Built 2026-10-11 (L2).** `list_lenders`, `get_lender`, `record_lender_financing` and `record_lender_repayment` (§16), through the same `LendersService` methods and the same roles as the office. The rate left unsaid is today's on the exchange-rate page and the preview says so; no money account is asked (DECIDED 2026-10-11; accounts removed 2026-10-14, "Which account" above); a new friend is added only on the partner's yes. Guesses listed in §16. | One set of rules for both doors (working rules §3, §11). |
| Who sees the lenders list and a lender's page | Core partners and admin support, who can also ask what pays a debt off at a rate (the quote behind the repayment form). A temporary investor sees "Paid by" only on his own cycles' orders and cycle page. Every write is a core partner's. | §18: read-only where they already see the cycle. |

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — he pays in his own currency, at that day's rate.** The
owner's case: a friend paid the supplier in AED while the order is priced in
CNY or USD, and is repaid monthly in pounds at each month's AED rate. This
replaces "in that order's currency" above.

| Rule | Now | Status |
|---|---|---|
| The currency he paid in | EGP, the order's currency, or any currency with a rate on the exchange-rate page (§22); anything else `NO_RATE_RECORDED`, a code that is not three letters `CURRENCY_CODE_INVALID`. Left out: the order's currency. | GUESS |
| The rate | The rate on the day he paid, as typed: above zero (`RATE_NOT_POSITIVE`), at most four decimals (`RATE_TOO_PRECISE`). EGP is 1 (`BASE_CURRENCY_RATE_FIXED`). Left out: the order's rate for the order's currency; for another currency it is required (`FINANCING_RATE_REQUIRED`) — a rate on the page is today's, not his day's, so it only prefills. | GUESS |
| His pounds | `amountEgp` = amount × his rate, half up to the piastre. The ledger inflow is those pounds, at his rate, with his amount and currency kept as the original. | DECIDED |
| The cap | Compared in pounds, and exactly: friends' amount × rate together never above the order's lines × the order's rate (`FINANCING_EXCEEDS_ORDER`, figures in EGP). Exactly, before rounding, so two friends paying exactly what is left in the order's currency are never refused by a piastre of rounding. **Superseded the same day: the cap is the cycle's cost (below); still exact, still in pounds.** | GUESS |
| What we owe him | His amount, in his currency. Repayments clear pounds ÷ the rate typed on the repayment. | DECIDED |
| The exchange difference | Pounds paid − what was cleared valued at **his** rate (the financing's own), not the order's. Over a repaid debt: pounds paid − his `amountEgp`. One definition, `common/lender-math.ts`. | GUESS |
| Partners' capital | ~~"Split equally" and the funding subtract his `amountEgp` (his pounds at his rate).~~ Superseded 2026-10-19: nothing is subtracted; his `amountEgp` is shown beside the cost to fund (`lenderFinancedEgp`) as what the partners repay. | DECIDED (2026-10-19) |
| The office form | Currency (EGP, the order's first, every currency with a rate) and "Rate to EGP on that day": the order's own rate for the order's currency, today's page rate for another, 1 for EGP; what it is worth in pounds shown as he types. | GUESS (the order's rate, not today's, prefills the order's currency, so an untouched form records what it always did) |
| The assistant | `record_lender_financing` takes currency and rate; unsaid, the order's rate for the order's currency, otherwise today's page rate, and the preview says which; the rate is bound to the confirmation. | GUESS |

No migration: a friend's payment already stored its own currency and rate (they
were copies of the order's). Production had no friend's payments.
`check-data` 19.1 now compares in pounds; 19.6 checks `amountEgp` is amount ×
rate.

**DECIDED 2026-10-16 (owner asked: "make the friend payment cover shipping and
fees too"; details a GUESS, the recommended option) — his payment may cover the
cycle's whole cost, not only the order's goods.** The real case: Mohammed paid an
Alibaba order by card, AED 8,302.60 in all — goods 6,509.80, China→UAE shipping
1,551.74 and the card processing fee 241.07. Until now only the goods could be
recorded as owed to him. This replaces "Never more than the order's total"
above and the 2026-10-16 "The cap" row.

| Rule | Now | Status |
|---|---|---|
| What it is linked to | Still the purchase order he paid (no schema change); one friend once per order, as before. | GUESS |
| The cycle's cost | Every purchase order's goods (lines × the order's rate) + every shipping leg's cost (its basis × its rate) + every ledger expense charged to the cycle, net of reversals (`operatingExpenseEgp`, the settlement's own reading), all in EGP. One definition: `CostingService.cycleCost`. | GUESS |
| The cap | All friends' payments on the cycle (amount × his rate, exactly, before rounding) never above the cycle's cost — so a friend may pay what is left of it, whichever order he is recorded against. Refused with `FINANCING_EXCEEDS_CYCLE_COST` (params in EGP: `amount`, `cycle`, `cost`, `financed`, `available`). `FINANCING_EXCEEDS_ORDER` is gone. Checked under the cycle's lock. | GUESS |
| A card or bank fee | Recorded as a manual ledger EXPENSE (`bank_fees`, or any other expense category) with the cycle picked: the ledger already accepted a cycle on every expense category; it counts in the cycle's cost from then on. Record it **before** the friend's payment, or his payment is refused as too much. An expense with no cycle (a running cost) or on another cycle does not raise the cap. | GUESS |
| Cost to fund | **Changed 2026-10-19 (owner):** what the partners fund (`fundingFor` → `toFundEgp`, the cycle page's Split equally and Enter amounts, the assistant previews' `partnersFundBefore/After`) = the cycle's cost (goods + legs + expenses charged to it) + leftovers moved in, floored at 0 — friends' payments are **no longer subtracted**; they are reported beside it (`fundingFor().financed`, the costing's `lenderFinancedEgp`). Split equally then takes investors' money off (`lib/funding-split`, one split). Until 2026-10-19: "… − friends' payments". | DECIDED (the rule), GUESS (the details) |
| Settlement | Unchanged arithmetic: a friend's payment is not income, the expenses still reduce profit, his exchange difference still applies. ~~"A friend paid for it entirely" (§8, `CYCLE_NOT_FUNDED` otherwise) now means his payments cover the cycle's cost **including its expenses**.~~ (That basis is gone, 2026-10-19: the partners' contributions are the basis.) | GUESS |
| A cost that moves after he paid | A leg or an expense added later: the partners fund the new part, and another friend may pay it. A leg corrected down or an expense reversed: cost to fund and what is available stop at zero, never negative; `check-data` 19.1 (now per cycle) will name that cycle for a look. | GUESS |
| Where it shows | `GET /purchases/:id/financings` and `GET /cycles/:id/financing` return `cycleGoodsEgp`, `cycleShippingEgp`, `cycleExpensesEgp`, `cycleCostEgp`, `cycleFinancedEgp` and `availableEgp` — now the cycle-wide room (the order's `orderTotalEgp` and `financedEgp` are kept). The landed-cost endpoint adds `expensesEgp` and `cycleCostEgp`. The office form says what is left of the cycle's cost and that his payment may cover shipping and fees; the wizard's "Cycle cost" is the cycle's cost. The assistant's `record_lender_financing` says the same and its preview shows the cycle's cost, what friends paid of it and what was available. | GUESS |
| The owner's existing 6,509.86 AED | Remove it (with a reason — allowed while nothing is repaid) and record it again at 8,302.60 once the fee is on the cycle. | DECIDED (owner's plan) |

(2026-10-18: the wizard's Funding step is gone — §8 "The wizard ends at the shipping". Where the "Cost to fund"
row above names the wizard's Split equally and funded-versus-cost line, read the cycle page's funding note and
Participants card.)

**Editing and deleting a lender — built 2026-10-18 (owner asked).** `PUT /lenders/:id` corrects his name, phone
and notes — the whole record is replaced, so a phone or note left out is cleared; a blank name is
`LENDER_NAME_REQUIRED`; no money changes; an UPDATE audit row keeps before and after. `DELETE /lenders/:id` is for
a lender added by mistake: refused with `LENDER_HAS_FINANCINGS` (`count`, `name`) while any payment of his still
stands — remove each first, with its reason. Deleting **hides** him (`deleted_at`, migration
`20261018100000_lender_deleted_at`), never erases him, so a removed payment's history still names him; he leaves
the lenders list, his page, the pickers, the assistant's matching and new payments; a DELETE audit row is written.
An unknown or deleted lender is `notFound('lender')`. Both: core partners only (`LENDER_WRITE_ROLES`); reading
lenders stays core partners and admin support. Edit and Delete sit beside his name on his page.

**DECIDED 2026-10-19 (owner) — the partners repay the friend; his payment is a loan to them.**
After a friend (Ahmad Eraiby, 172,155.50 EGP) paid for a whole cycle, pressing Split equally set every
partner to 0 EGP. The owner: "no but I need to show that we split money among us to repay the lender
which means that we pay, it looks vague as if we payed nothing, and it does not have to be equally maybe
30,30,40". So the partners fund the whole cycle, directly or by repaying him; a friend's payment does not
replace their funding. This replaces the 2026-10-11 equal split, the "Partners' capital" rows and the
2026-10-16 "Cost to fund" row above.

| Rule | Now | Status |
|---|---|---|
| What the partners fund | The cycle's cost (goods + legs + expenses charged to it) + leftovers moved in, floored at 0 — **not** less friends' payments. One definition, `CostingService.fundingFor` (→ `toFundEgp` in `common/stock-transfers.ts`); the friends' figure stays beside it (`financed`, the costing's `lenderFinancedEgp`). The landed-cost totals no longer carry `fundedByLenders`. | DECIDED |
| Split equally | Divides that whole figure among the core partners, investors' money off first (`lib/funding-split.ts`, unchanged code; the server figure changed). | DECIDED |
| Profit | Follows the contributions (`CONTRIBUTIONS`, settlement-math.ts). The `LENDERS` basis is removed, in the API and the web types: a cycle with no contributions refuses `CYCLE_NOT_FUNDED` whether or not a friend paid, wholly or in part. A custom split still overrides. | DECIDED |
| Capital at settlement | Each partner's contribution comes back as capital, as on every cycle. Settlement still refuses while a friend is owed (`assertLendersRepaid`, unchanged). | DECIDED |
| Cash and the ledger | Unchanged arithmetic. A contribution posts a `CAPITAL_CONTRIBUTION` INFLOW when entered (the delta, on every edit — 30/30/40 changed to 50/25/25 posts only the three differences); each repayment posts a `lender_repayment` OUTFLOW. Over the cycle's life: lender in (`lender_financing`, +X) + contributions in (+X) − purchase out (−X) − repayments out (−X) = 0 — the same timing every partner-funded cycle already has (the money comes in when it is entered, leaves when it is spent). Contributions entered before the repayments are made show cash on hand above what is in the bank until he is repaid; that is the same as a partner-funded cycle whose contributions are entered before the supplier is paid. | DECIDED (owner's rule); the timing reasoning is a GUESS |
| A cap on contributions | None existed and none is added: a contribution may exceed the cost to fund; the cycle page says so (below). | GUESS |
| The funding note | Shows while `profitBasis` is `NONE` — which now includes a friend-paid cycle with zero contributions. Fully paid by friends: "**Ahmad Eraiby paid 172,155.50 EGP for this cycle. Split who repays him between the partners.**" (AR: "دفع Ahmad Eraiby 172,155.50 جنيه لهذه الدورة. قسّم بين الشركاء من يسدّد له."), "them"/"لهم" for several friends, names joined in the reader's language. Partly paid: "X paid A of this cycle's B. Split the whole cost between the partners — they repay him and fund the rest." A hint under both: his payment is a loan, each amount is that partner's share of repaying it, and profit follows it. Before the names load, "A lender". Buttons unchanged: Split equally, Enter amounts, Paid by a lender. The names come from `GET /cycles/:id/financing` (the "Paid by a friend" section's own query). | GUESS (wording) |
| Enter amounts — any split | Each core partner's row has an amount **and a %**, kept in step: typing 30 in % fills 30% of what the partners fund; typing an amount fills its %. The partners' 100% is the cost to fund less investors' money as entered on the form (investors get an amount only), the same base Split equally uses. Amounts to the piastre. When the %s come to exactly 100 and the last partner's amount came from his %, he absorbs the rounding so the amounts sum exactly (30/30/40 of 172,155.50 = 51,646.65 + 51,646.65 + 68,862.20); an amount someone typed is never changed. A line under the rows: "Entered X of Y to fund." plus "Matches the cost to fund." / "Z still to enter." / "Z more than the cost to fund.", and "The percentages add up to N%, not 100%." when they do not. None of these block Save. Typed values are the form's own state, so a refetch underneath never overwrites them. Save still writes each changed contribution through `PUT /cycles/participants/:id`. Shared `MoneyInput` for both fields; no native controls. | GUESS (the % entry and its base) |
| The participants card | On a cycle a friend paid for, once contributions are entered, a short line under the participants: "Each partner's share of repaying Ahmad Eraiby:" (partly paid: "Each partner's share of the cycle, repaying X included:") with each core partner's amount and % of the partners' total. | GUESS (wording) |
| The assistant | `record_lender_financing`'s preview keeps `partnersFundBeforeEgp`/`partnersFundAfterEgp` (now equal) and says: "The partners still fund all X EGP of the cycle: what he paid is a loan to them, which they repay, each partner's contribution being their share of it." The confirmation still binds `partnersFundAfterEgp`, so a cost that moves in between still changes what was agreed. | GUESS (wording) |
| Adding a friend once friends paid it all | **DECIDED 2026-10-19 (owner: "if fully paid by a lender why give me the option to add another lender ?").** When friends' payments cover the cycle's whole cost, the funding note shows no "Paid by a lender" and the "Paid by a friend" card no "A friend paid for this"; the server already refused one (`FINANCING_EXCEEDS_CYCLE_COST`). Paid only in part, both stay so another friend can pay the rest. | DECIDED |
| CYC-2026-0001 (production) | Its partners' contributions are each partner's share of repaying both friends; the owner gives the split. Nothing is changed in production by this change. | Given by the owner 2026-10-27 — below |

**Part of a friend's loan staying in the cycle as his investment — GUESS (2026-10-27), from the owner's facts on
CYC-2026-0001; applied to production 2026-10-27 (`apps/api/prisma/one-off/2026-10-27-cyc-0001-funding.ts`).** The owner: the cycle's 201,168.99 EGP was funded by "Abdallah 55,000; Ahmad Eraiby as a temporary
investor 60,000; Mohammed Setta (temporary investor) 20,000; Shady and Fares the rest equally" (33,084.50 and
33,084.49, Fares last, absorbing the piastre). Eraiby's 60,000 "is part of his loan that stayed in the cycle as his
investment": he was repaid 141,168.92 EGP (141,168.99 less the 0.07 the pay-off rounding gives), not 201,168.99; Abdallah's and Setta's money went into repaying him.

| Question | Answer | Status |
|---|---|---|
| How it is recorded | As a **smaller friend's payment plus a temporary-investor contribution**: the part that stayed in leaves his loan and becomes his `TEMP_INVESTOR` contribution on the cycle, no fee, no custom split. Nothing new in the code — a friend may also be a participant; the two records are separate (`Lender` and a `User`). | GUESS |
| At what rate the part that stayed in leaves the loan | **The rate of the repayment it cut short.** On CYC-2026-0001 the 15 October repayment (69,064.93 at 14.9) was really 9,064.93 paid and 60,000 left in, so the loan shrinks by 60,000 ÷ 14.9 = 4,026.85 AED: 13,905.69 → **9,878.84 AED** at 13.9066 (paid 15 July). Its repayments are 64,893.22 @14 (15 Aug), 67,210.84 @14.5 (15 Sep) and the pay-off on 15 Oct. | GUESS |
| The pay-off figure | The service's own: owed × rate, half up — 608.38 AED × 14.9 = **9,064.86 EGP**, not 9,064.93. No two-place AED amount is worth exactly 9,064.93 at 14.9; the 0.07 is 4,026.85 AED being worth 60,000.07 at 14.9 while his investment is recorded at the owner's 60,000. So the repaid total reads 141,168.92 and the contributions 201,168.99. | GUESS (0.07 for the owner to accept) |
| What changes | Exchange difference on repaying him 7,788.12 → **3,787.84** EGP (141,168.92 repaid − 137,381.08 at his rate), now shared by the profit split across all five. Profit split by contribution: Eraiby 29.83%, Abdallah 27.34%, Shady 16.45%, Fares 16.45%, Setta 9.94% (money lines, each rounded alone — they sum to 100.01). The Funding card reads 29.82 / 27.34 / 16.45 / 16.45 / 9.94 by largest remainder since 2026-10-27 (§8, "Investors in the funding"); it used to truncate and read Setta 9.96. | follows |
| The investors' accounts | `TEMP_INVESTOR` users "Ahmad Eraiby" and "Mohammed Setta" with placeholder emails (`…@motoparts.invalid`) and a random password nobody holds; investors do not sign in (owner: only the three partners use the office). | GUESS |
| How it reached production | One-off `apps/api/prisma/one-off/2026-10-27-cyc-0001-funding.ts`, through the services: the three old repayments reversed and the old financing removed, each with a reason; the smaller financing and its repayments recorded again; contributions set by hand; the investors added. | done by script |
| The Funding card on such a cycle | Was OPEN: its equal shares were "of what was repaid" (141,168.92) less **all** investors' money (80,000) = 20,389.64 each, Eraiby's 60,000 taken off twice. **Closed 2026-10-27:** the partners' part is what was repaid or everything contributed, whichever is more, less investors (121,168.99), and with every partner's contribution in and adding up, each share is his own contribution, as agreed — §8 "Investors in the funding, the partners' part, shares as agreed, every percentage". | DECIDED 2026-10-27 |


**An exchange-rate loss reads as a loss — DECIDED 2026-11-06 (owner), on `feature/dashboard-cash-from-sales`, not
merged.** The owner, on Analytics: "Exchange-rate loss on the lender repayments −3,183.74 — this needs to show
that it's a loss, needs a redesign." The figure was labelled a neutral "Exchange difference" everywhere.

| Question | Answer | Status |
|---|---|---|
| The sign | Unchanged, one convention: `exchangeDiffEgp` / `exchangeDifferenceEgp` above zero is a **loss** (more pounds paid than the debt was worth at his rate — the rate rose), below zero a **gain**. | as built |
| The words | "Exchange-rate loss" / "Exchange-rate gain" ("خسارة فرق سعر الصرف" / "ربح فرق سعر الصرف"), never "Exchange difference". Under the label a muted line: "Paid back the lender at a higher rate than borrowed" / "…at a lower rate than borrowed" ("سُدِّد للمُقرض بسعر صرف أعلى/أقل من سعر الاقتراض"). | DECIDED (wording the agent's GUESS) |
| The figure | Signed as it moves profit: a loss "−3,183.74 EGP" in the destructive red, a gain "+1,200.00 EGP" in the success green; the existing tokens, one left-to-right run so the sign stays before the digits in Arabic. In an account with a − / + / = column, that column is left empty on this line so no second minus stands in front of a negative figure. | DECIDED |
| Zero | Hidden where it was hidden (Analytics' "How it adds up", a bar's breakdown, a settlement's cycle lines, the Funding card). | as before |
| Where | One component, `apps/web/src/components/lenders/exchange-result.tsx` (rule 11): Analytics' How it adds up and a bar's breakdown (the totals line and each repayment), a settlement's "How it was worked out", the cycle Funding card's sentence, and a lender's page (the financing's figure says loss or gain; the repayment column is "Rate gain / loss", each row signed and coloured). | built |
