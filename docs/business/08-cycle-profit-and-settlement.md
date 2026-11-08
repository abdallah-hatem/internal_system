> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 8. Cycle profit and settlement

**Profit is revenue less the cost of what actually sold**, less goods lost on
the way (§2), plus anything a supplier gave back. Revenue and cost are attributed through batch allocations,
not through the cycle's own transactions — a FIFO sale can span batches from
several cycles, so a sale's revenue is deliberately recorded without a cycle.

**Unsold stock keeps its cost with the cycle.** Profit therefore covers sold
units only, and the settlement screen says so.

**DECIDED 2026-08-23 — the three partners fund a cycle equally by default.**
A new cycle starts with all active core partners on it. Their contributions
begin at zero because the capital is not known yet — a cycle costs what its
goods and shipping come to — and "Split equally" fills them in from the landed
cost once it is, to the piastre, with the last partner absorbing the residual
so capital returned matches capital put in. A temporary investor's own money is
excluded from that split; the partners cover the remainder.

Equal contributions produce an equal split by construction, which is why no
profit percentage is set: three explicit 33.33s total 99.99 and are rejected,
and choosing which partner absorbs the extra 0.01 is not worth encoding.

Naming participants when creating a cycle overrides the default entirely.

**Distribution defaults to actual contribution.** 80k / 100k / 120k gives
26.67% / 33.33% / 40%. A custom split can be agreed per cycle.

**SUPERSEDED 2026-10-19 by the owner — see the next paragraph and §18 "The
partners repay the friend".** What follows was the rule from 2026-10-11 to
2026-10-19; the code no longer does it.

~~**DECIDED 2026-10-11 (owner) — a cycle a friend paid for entirely splits its
profit equally among its core partners.**~~ *Built 2026-10-11 (L2), removed 2026-10-19.* When every
participant's contribution is zero and friends' payments cover the cycle's whole
cost to fund (§18: the costing's "to fund" is zero and a friend paid something),
the profit — or the loss — goes equally to the cycle's core partners. A temporary
investor on it put in nothing and takes nothing (no share, no fee). A custom split
still overrides it. Every other cycle with no contributions still refuses
(`CYCLE_NOT_FUNDED`): a cycle a friend paid for only partly, or one nobody paid
for at all — rounding must never decide who gets the money (working rules §10).
Settlement preview, calculate/approve and the partners page all read the one
projection, so they agree. Guess made while building it (2026-10-11, open until
confirmed): the rounding residual goes to the last participant whose share is
not zero — not to an investor on the cycle who takes nothing; for every split
that already existed this is the same last line as before unless that line's
share was zero. (The residual rule stays: it applies to any split.)

**DECIDED 2026-10-19 (owner) — the partners repay a friend who paid for a
cycle, in shares they choose, and profit follows those shares.** After a friend
paid for a whole cycle, Split equally set every partner to 0 EGP. The owner: "no
but I need to show that we split money among us to repay the lender which means
that we pay, it looks vague as if we payed nothing, and it does not have to be
equally maybe 30,30,40". A friend's payment is a loan to the partners, not
funding that replaces theirs: what they fund is the whole cycle, and each
partner's contribution is their share of it — directly, or by repaying him.
Profit is split by contribution as on every other cycle (`CONTRIBUTIONS`); with
nothing entered, settling refuses `CYCLE_NOT_FUNDED` whether or not a friend
paid (the `LENDERS` basis is gone). A custom split still overrides. Details in
§18, "The partners repay the friend".

**A temporary investor's fee comes out of their profit, never their capital.**
50,000 gross profit at 15% is a 7,500 fee; the investor keeps 42,500 and their
capital is returned in full. The fee line shown against the investor is a memo
of a deduction already inside their profit share — it must not be subtracted
again when totalling a payout.

**Capital and profit are separate settlement components.**

**Settling pays out and closes.** Approving moves the cycle to SETTLEMENT.
Paying writes one ledger entry per participant and closes the cycle.

**DECIDED 2026-08-21 — closing with stock remaining is refused unless
explicitly accepted.** That stock's cost stays with the cycle, so closing writes
it off. The refusal makes it a decision rather than an accident.

**DECIDED 2026-10-11 (owner) — leftover stock can move to another cycle at its cost.** *Built 2026-10-12 (L5): API, screens, unit and e2e tests (99-leftover-transfer, TC-INV-51..53).*
Instead of writing leftovers off when a cycle closes, the partners can move them to another cycle that is still
open (or to a new cycle started for them). Exactly how:

- **When:** from a cycle in Selling or Settlement (not yet paid out), once every unit is accounted for (received or
  lost). The settlement's "still holds N units" refusal offers it in place.
- **What moves:** per product, all or some of the units on the shelf. The rest can still be written off by closing
  as today. A damaged unit is written off, not moved.
- **At what price:** exactly its landed cost, never re-priced. The moved units keep their original check-in date, so
  they still sell first (§3).
- **Cycle A (the one giving):** the units leave its stock and it recovers their cost, so they make no profit and no
  loss for A. Its partners get their capital back in full; nothing is written off.
- **Cycle B (the one receiving):** the units join its stock at that cost, and its cost to fund rises by the same
  amount — its partners fund them. When they sell, the revenue and profit are B's.
- **Recorded:** a transfer record (date, from, to, product, units, unit cost, who, why). A's page shows "moved to B",
  B's shows "from A", the original batch in A records the units leaving and B gets a new batch pointing back at it,
  and two matching ledger entries mark it as a transfer between cycles — not cash, not income, not an expense. The
  dashboard's cash and profit do not change.
- **Undo:** only while none of the moved units has sold in B and A has not been paid out. After that it is permanent.
- **Who:** core partners.

Settled while building it (L5, autonomous run 2026-10-11) — **guesses, each OPEN until the owner confirms**:

| Question | Guess built | Why |
|---|---|---|
| "On the shelf" | Verified batches' sellable units, less units held for a shop's request (`availableQty`'s reading). A held unit stays where the shop was promised it. | Never more than is on the shelf; a hold is a promise. |
| Which batch the units come from | Oldest check-in first, as a sale would draw; one transfer line per source batch, each at that batch's own landed cost. | The units that would have sold first move first; nothing is re-priced (§3). |
| The moved batch's check-in | The source batch's own (`createdAt`) and its arrival day. So in B the moved units sell before B's own later stock (§3 FIFO). | "They keep their original check-in date." |
| Allowed targets | Any cycle that is not being settled, closed or cancelled — including one still in planning or on the way. Never the giving cycle. | Its partners fund them; a cycle settling has already counted its stock. |
| "Not yet paid out" | The giving cycle is SELLING or SETTLEMENT and has no PAID settlement. | §8. |
| The record's "why" | Required (500 characters at most), as for every undo. The date defaults to Cairo's today and cannot be later. | Records of things that happened (rule 1). |
| Ledger | Two `cycle_transfer` rows: an INFLOW on the giving cycle (cost recovered), an OUTFLOW on the taking cycle (cost taken on), both pointing at the transfer (`relatedType` `STOCK_TRANSFER`), so neither can be reversed on its own (§9). `cycle_transfer` is in `CAPITALISED_CATEGORIES` and in a new `NOT_CASH_CATEGORIES` (`common/ledger-categories.ts`): not income, not an expense, and not cash — the dashboard's cash in, cash out and cash on hand leave it out through `common/cash-position.ts`. It cannot be typed by hand in the ledger (`LEDGER_CATEGORY_RESERVED`). | No money moved; the goods were paid for once. |
| The taking cycle's cost to fund | `CostingService.fundingFor`: landed cost + stock moved in (transfers that stand). Until 2026-10-19 it also took off what friends paid; it no longer does (§18, "The partners repay the friend"). "Split equally" uses it. The giving cycle's cost to fund is unchanged: its partners did fund those goods and get that capital back at settlement. | §8: "its cost to fund rises by the same amount". |
| Analytics' cycle "investment" | Nets transfers, signed: lower on the giving cycle, higher on the taking one. Profit is not touched on either side. | So the two cycles' figures agree with each other. |
| Paying out after a move | Paying a settlement reads what the cycle holds **now**, not the figures from when it was calculated, so leftovers moved after approval leave nothing to write off. A move and its undo also refresh the unsold figures on either cycle's open (draft or approved) settlement; profit and payouts do not change. | Otherwise the "still holds N units" refusal would describe stock that has left. |
| "None of the moved units has sold in B" | Strict: undo is refused once any sale ever drew from the moved batch — even one since cancelled — or any hold, return, or onward move touched it. The taking cycle must also not be settling, closed or cancelled. | The batch then has history of its own; undoing would erase it. |
| What undo does | Units back on the giving cycle's batches (movement `TRANSFER_IN`), the moved batch and its movements removed (nothing depends on them — the gate above), two balancing ledger rows pointing at the originals, the transfer kept and marked undone with who, when and why. | §9: history is never rewritten; the record stays. |
| Cancelling the taking cycle | Refused while it holds stock moved in (`CYCLE_HAS_TRANSFERS_IN`); undo the move first. | A cancelled cycle "never ordered anything" (§15). |
| Where the goods are | The giving cycle gains a **Moved to another cycle** place, so its units still add up to what it ordered; the taking cycle lists **From CYC-A** apart, with how many are still on its shelf, sold, or moved on — not inside its own ordered total. Recent activity did not list a moved batch as a receipt (the feed was removed 2026-10-17). | §8. |
| "Start a new cycle for them" | Opens the cycle wizard (`?leftoversFrom=`); once the new cycle exists, a link goes back to the giving cycle's page with Move leftovers open and the new cycle chosen. There is one Move form. | A cycle has no honest minimal form (CLAUDE.md §13). |
| The dialog's default | Every product starts at all of it on the shelf; a number typed is never overwritten. | The usual case is moving everything. |

**SUPERSEDED 2026-11-08 (see "investors pay for every cost too" below) — was DECIDED 2026-10-11 (owner): general running costs are the three core partners', equally, and come out of
their payouts.** *Built 2026-10-12 (L7): API, screens, unit, component and browser tests (99-running-costs, 34 TC-INV-59..64, 79 TC-RP-10).* An expense recorded with no cycle (rent, salaries, utilities…) is shared equally by
the active core partners; temporary investors never share it. It does **not** change any cycle's profit — that stays
the shipment's own. Instead, when a settlement is paid out, each core partner's third of the running costs recorded
since they were last charged is taken from his payout, on its own line. Each cost is charged once and records which
payout took it; what a payout cannot cover carries to the next one; reversing the settlement puts its running costs
back to waiting. They live on the Partners page as **Running costs**: what was spent, what has been taken from
payouts, what is still waiting.

**DECIDED 2026-11-08 (owner) — investors pay for every cost too; built 2026-11-08 on `feature/costs-to-selling-cycle`, details GUESSED where marked.** "No investor has to pay for everything as well, fuel, packaging etc... its all one process" and "there will be expenses not attached to a cycle lets say rent". **This replaces the 2026-10-11 rule above** (partners-only, from payouts): nothing is taken from a payout for running costs any more; settlements paid that way keep their `RUNNING_COSTS` lines as history.

| Question | Rule | Why |
|---|---|---|
| What a running cost is | Unchanged: an operating expense recorded with **no cycle** (rent, salaries, fuel, packaging…), not itself a reversal (`isRunningCostEntry`). The expense form does not change. | Owner: some expenses are not attached to a cycle. |
| Where it goes | **Shared to the cycles running when it is recorded** — every cycle **from the moment its goods are paid for** (its order confirmed: Preparing) through shipping, arrival and selling, until its settlement is approved — in equal parts to the piastre, the odd piastres on the last cycle (oldest started first). Stored once (`running_cost_allocations`), never moved. A part of nothing is no part (a piastre over two cycles goes whole to the last). | Owner 2026-11-08: "a cost is shared the moment we pay for the goods from china or uae, not when we start selling". "Paid for" read as the order confirmed (leaving Purchasing): **GUESS**. Equal split: **GUESS** (by sales is the alternative — OPEN). |
| Recorded on which day | When it is **recorded**, whatever day it is dated: there is no record of which cycles were running on a past day. **GUESS.** | No status history exists to read it. |
| None running | It **waits**, and goes whole to the cycles running when the next one's goods are paid for (a cycle moving into Preparing or later — or selling again after a settlement is reversed). Calculating any settlement shares what is waiting first. | |
| On the cycle | A cost like one charged to it: inside its expenses and profit, a `shared` line by category in the settlement's cost breakdown, in Analytics' cycle profitability and in what a partner may take early (profit draws read the settlement's projection). Every participant, investors included, bears it by share. Not part of the cycle's cost to fund (§18: goods, shipping, charges). | Rule 11: one reading for settlement, Analytics and profit draws. |
| The business's profit | Counted once, as the operating expense it always was (dashboard, P&L). | It is one expense. |
| A cycle being settled | Takes no new cost from approval on. A draft calculated before a cost was shared to it — or before one was undone — is refused at approval (`SETTLEMENT_STALE_COSTS`): calculate again. | The split is agreed at approval (§8 funding lock). |
| Undoing a cost | Takes its parts off the cycles — refused while any of them is being settled, settled, closed or cancelled (`RUNNING_COST_SETTLED`, naming the cycles): reverse that settlement first. An undone cost is never shared again. | History is not rewritten. |
| Taken the old way | A cost a payout already took (a standing `running_cost_charges` row, before 2026-11-08) is never shared again. Production had none standing (checked 2026-11-08). | Never charged twice. |
| The Partners page | **Running costs**: spent by category, shared to which cycles (each one's part), what waits for a selling cycle, and what payouts took the old way (history). No per-partner shares. | |

**DECIDED 2026-10-11 (owner) — a payout explains itself.** *Built 2026-10-12 (L7), as above.* The settlement screen (before approving),
and each partner's payout history, break the money down line by line: revenue; cost of the goods sold; each cycle
cost by kind (extra freight, customs, goods lost on the way, exchange difference on repaying friends, other charges
to the cycle); the investor's fee; the cycle's profit and this partner's share; capital back; his share of running
costs; what he was paid. No lump "expenses" line.

Settled while building it (L7, autonomous run 2026-10-12) — **guesses, each OPEN until the owner confirms**:

| Question | Guess built | Why |
|---|---|---|
| What a running cost is | An operating expense through the one definition (`operatingExpenseEgp`) recorded with **no cycle**, that is not itself a reversal; counted net of its reversal, so a reversed cost owes nothing. An old free-text expense with no cycle counts too. A cost charged to a cycle is that cycle's, inside its profit — never a running cost. | One definition (rule 11); §9 already says an entry with no cycle is a general cost. |
| Who shares it | **Revised 2026-10-12 after the alignment review — guess, OPEN.** Each running cost's shares are **fixed once**, over the core partners active on the cost's own day (`occurred_on`, else the Cairo day it was entered): a partner whose partner record is active, whose login is a core partner and active, and who had joined (his partner record's day) by then. A partner's share of a cost **never changes afterwards**. A temporary investor never shares, nor does a core partner's own money put in as an investor on a cycle — only his core-partner line is charged. His share comes out of the next payout **he** receives, from whichever cycle; a partner not on the cycle being paid waits for his own. | No one ever pays more than his own share, silently or otherwise. |
| His share, and the odd piastre | Each cost is split on its own, among that day's partners: every share rounded **down** to the piastre, the residual to the partner of that day who **joined last** (partner record oldest first, then id), so 100 is 33.33 / 33.33 / 33.34. The shares are stored (`running_cost_shares`), once. The Partners page names who takes the odd piastre on today's costs. | Working rules §10: rounding must never decide silently; mirrors "Split equally". |
| Which costs, in what order | Every running cost recorded by the time Mark paid is pressed and not yet charged to him, whatever day it was spent, **oldest first** (the day spent — `occurred_on`, else the Cairo day entered — then id). | "Since they were last charged" read as "not yet charged". |
| What caps it | His payout on that settlement: capital back + his profit share + any investors' fee he receives. **Capital counts**, so running costs can come out of capital handed back. A payout of nothing, or a loss, takes nothing; the rest waits. | "Capped at what his payout can cover"; a payout is capital and profit together (§8). |
| Charged once | A row per (cost, settlement, partner, amount) — `running_cost_charges`. What stands against a cost never exceeds it; check-data 22–22.3 watch for it. Two payouts at the same moment take turns (an advisory lock), and the second click on one Mark paid is refused. | The recommended shape. |
| What Mark paid leaves behind | The audit row of the payout (`PAY`) records `runningCostsCharged`: each charge's cost, partner and amount. A participant whose net payout comes to exactly zero — his running costs took all of it — is handed nothing, so **no payout row is written** for him; his `RUNNING_COSTS` line and his `running_cost_share` row still say what was taken. | The ledger records money that moved; the audit says what the payout took. |
| On the settlement | One `RUNNING_COSTS` line per charged partner, negative; what he is paid is the sum of the payable lines. | So the settlement's own lines say what he received. |
| In the ledger | The payout row (`settlement`) carries the cash actually handed over — net of his share. Beside it, a `running_cost_share` row (INFLOW, the settlement's cycle, pointing at the settlement) records the deduction. That category is in `CAPITALISED_CATEGORIES` and `NOT_CASH_CATEGORIES` (`common/ledger-categories.ts`): not income, not an expense — the cost was an expense the day it was recorded — and not cash. It cannot be typed by hand, and cannot be reversed on its own. | Cash and the partners' records agree; nothing counted twice. |
| Reversing the settlement | Mirrors the payout rows and the `running_cost_share` rows, and marks its charges released (`released_at`) — the rows stay. Those costs are waiting again and the next payout takes them. | §8: reversing puts its running costs back to waiting; §9: history is never rewritten. |
| Reversing a cost already taken from a payout | Refused (`RUNNING_COST_CHARGED`, naming the cycle) until the settlement that took it is reversed. | He was paid less for it; like a cost on a closed cycle (§9). |
| Before it is paid | Draft and approved settlements show what paying **today** would take, through the very plan Mark paid runs, marked "If paid today". Two approved settlements can both show the same waiting costs; whichever is paid first takes them. | The settlement screen explains the payout before approving (§8). |
| When the core partners change | **Revised 2026-10-12 (alignment review) — guess, OPEN.** A partner who **leaves** keeps owing his fixed share of every cost of his time; it is never moved onto the others. He is no longer charged from payouts (only an active core partner is), so his part **stays waiting**, shown on the Partners page as his, marked as no longer a partner. A partner who **joins** after a cost's day owes nothing of it. Two edges, stated: (1) the shares are stored the first time a cost is seen with write access — when it is recorded, or at the next Mark paid for costs recorded before this rule — over the partners active at that moment who had joined by the cost's day; nobody records when a partner left, so a partner who left before that moment is not among them. (2) A cost dated before any partner had joined (typed in from old books) is shared by all the active partners, rather than owed by nobody. How a leaving partner settles what he still owes is the owner's call. | The owner's rule as the review read it: a leaving partner's part is his, and nobody pays more than his share. |
| The Partners page | A **Running costs** section with a period picker (this month, this quarter — the default, in Cairo — last quarter, this year, all time): spent by category, taken from payouts, still waiting, each core partner's share / taken / waiting, the partner who takes the odd piastre, and what waits in all across every period. A period is the days the costs were **spent**; "taken" counts what payouts have taken of those costs, whenever. The totals row's new **Running costs** is what payouts have taken from the core partners so far, all time. | §8. |
| A payout explains itself | Calculating a settlement keeps its costs line by line (`settlements.cost_breakdown`), from the same rows the projection subtracts, adding up to its expenses exactly: each cycle-charged category (extra freight, customs, any other), goods lost on the way, the exchange difference on repaying friends, refunds and other income as gains. The settlement card drops the lump "Expenses"; under the participants each one's lines read: share of the cycle profit (%), investor's fee taken or received, capital back, share of running costs (period), paid. The Partners page lists each person's payouts with the same lines, read from the same settlement. Leftovers moved out are a note beside the figures (at cost: no profit, no loss), read live. A settlement calculated before this has no itemised costs and says so in one line until recalculated. | §8: no lump "expenses" line; every figure from the settlement's own projection. |

**Reversing a settlement writes balancing entries and reopens the cycle.** It
never rewrites history. A reason is required.

**Paying out is not a cycle expense.** It distributes profit already earned;
counting it as a cost re-charges the cycle for its own success.

**DECIDED 2026-10-10 — a cycle settles only once every unit is accounted for.**
*Built 2026-10-11 (B3).* Every unit ordered must be received into stock or marked lost before
the cycle can move to settlement or a settlement can be approved, by any route.
Goods still on the way make the cycle's profit a guess. A cycle with nothing
ordered has nothing to account for.

**DECIDED 2026-10-18 (owner) — nor while any of its units are out at shops as
samples** (`CYCLE_HAS_SAMPLES_OUT`, naming the units and the shops; §4 "Samples at
shops"). Units at shops count as unsold stock in every unsold figure.

### The wizard ends at the shipping; funding is asked for on the cycle page, and locks at approval — owner 2026-10-18

**DECIDED (owner, 2026-10-18):**

- **The new-cycle wizard has three steps** — Cycle info, Purchase order, Shipping leg.
  The Funding step is gone. Finishing the shipping step saves the legs, moves the
  cycle as far as its dates allow (§1, unchanged) and opens the cycle's details page.
  The cycle is created exactly as before: every active core partner on it with a
  contribution of 0 (§8 above).
- **A funding note on the cycle page.** While settling the cycle would be refused for
  want of a basis to split its profit on (`CYCLE_NOT_FUNDED`), an amber note near the
  top says "Funding not entered yet — needed to settle this cycle", with three actions:
  **Split equally** (the page's existing split), **Enter amounts** (each participant's
  contribution, edited in place on the Participants card) and **Paid by a lender** (the
  existing "a friend paid the supplier" form, §18). If a lender paid part and the
  partners nothing, it reads "A lender paid X of Y; enter the partners' share for the
  rest, or the settlement will be refused". It goes once the partners put money in, and
  never shows on a closed or cancelled cycle. (Until 2026-10-19 it also went once a
  lender paid the whole cost to fund; now it stays and asks who repays him — §18, "The
  partners repay the friend", for its wording.)
- **Funding locks once the settlement is approved.** From an APPROVED or PAID settlement,
  or a CLOSED cycle, a contribution or custom split cannot be edited (Split equally
  included), a participant cannot be added, and a friend's payment cannot be recorded or
  removed: `FUNDING_LOCKED_AFTER_SETTLEMENT`, naming why (`reason`: `SETTLEMENT_APPROVED`,
  `SETTLEMENT_PAID`, `CYCLE_CLOSED`). Reversing the settlement unlocks it (the cycle goes
  back to Selling). One definition, `apps/api/src/common/funding-lock.ts`; the cycle's
  `fundingLock` carries the reason to the page, whose controls stay visible, switched
  off, with the reason beside them.

**GUESSES (2026-10-18, built; open until the owner confirms):**

| Question | Guess built | Why |
|---|---|---|
| When the note shows | Exactly when settling would refuse: `profitBasis` on the landed-cost totals is `NONE`. That is `profitBasisOf` (settlement-math.ts) — the function the settlement's split itself branches on — over the participants (until 2026-10-19 also `fundingFor`'s `fundedByLenders`, removed with the `LENDERS` basis). A custom split on every participant is a basis, so no note. Hidden too while funding is locked. | One definition (CLAUDE.md §11): the note and the refusal can never disagree. |
| "Paid by a lender" with one order / several | One order: the form opens on it. Several: the order picker, nothing preselected. | The owner's rule. |
| Its prefilled amount | What friends may still pay of the cycle, the API's own `availableEgp` (the cap it enforces). In pounds as is; in another currency divided by the rate shown, **rounded down** to the piastre, so it is never above the cap. It follows the currency and rate until he types an amount; a typed amount is never overwritten. | Reuse the server's figure; never a second formula for the cap. In a foreign currency the rounded-down amount can leave a few piastres unfunded, so the note may stay with the partial text — the partners split those, or the amount is typed. |
| "Enter amounts" | There was no per-participant editing on the cycle page (only the wizard's Funding step had it), so it moved there: an **Edit amounts** button on the Participants card, the note's action opens it and scrolls to it. Save writes only what changed. *Since 2026-10-26: "Enter amounts" in the Funding card's Contributions, opening the same form in a dialog (below, "one Funding card").* | The smallest flow, on the screen where the person is. |
| Adding an investor | On the cycle page's existing Add participant (the wizard's own add-investor box went with the step). | Already there. |
| A closed cycle, adding a participant | Keeps its older refusal, `CYCLE_CLOSED_NO_PARTICIPANTS`; every other locked path says `FUNDING_LOCKED_AFTER_SETTLEMENT`. | Unchanged code for an unchanged case. |
| A friend's payment on a cycle in Settlement or Closed | Still `CYCLE_CLOSED_FOR_FINANCING` (unchanged, checked first); the lock catches what that misses — an approved settlement on a cycle not marked Settlement. Removing one, which had no status check at all, is now refused from approval on. | Removing one after the payout changed the basis the profit was split on. |
| A draft settlement calculated before funding changed | **Approval refuses it** (`SETTLEMENT_STALE_FUNDING`) when, since the draft's `calculatedAt`, a participant was added or edited (`createdAt`/`updatedAt`) or a friend's payment recorded or removed (`createdAt`/`removedAt`). Calculating again replaces the draft, as it always has. Nothing is marked or deleted when funding changes. | The smallest correct option: the settlement flow already supersedes drafts on recalculation; approval is the one moment a stale split would become agreed. An edit that writes the same value still counts as a change (re-calculate). |
| The wizard's other figures | The wizard's funded-versus-cost line, its "Cycle cost" and its Split equally are gone with the step (§18's rows above that name them describe the cycle page now). | — |


---

**What a partner has earned so far, on the Partners page — faster, same figures (2026-10-21).** The accrued profit
is still each open cycle's settlement projection (`project`), but only for the cycles where something can have moved
the profit — a sale or return on their stock, a ledger row in a category the projection reads, goods lost on the way, a
repayment to a friend (`cyclesWithProfitActivity`, beside `project`, which must name any new input). Every other open
cycle projects exactly zero, and is no longer asked. 6 s → 0.2 s with 200 open cycles.

**The Settlement button carries its cycle — built 2026-10-20 (owner 2026-10-19).** The Settlement button on a cycle's
page opens Partners → Settlements with that cycle already chosen in the Calculate picker
(`/partners?view=settlements&cycle=<id>`). The choice lives in the address, so a refresh keeps it; a cycle picked on
the tab replaces the address's; an address naming a cycle that is not in the list picks nothing (Calculate stays
disabled) rather than a blank picker.

**Calculate and Approve no longer race — fixed 2026-10-20** (seen 2026-10-11, L1). Approving a draft while a
recalculation replaced it answered 500 (Prisma P2025). Both now take the cycle's lock (`lockCycle`), so they run one
after the other: an Approve that waited finds its draft gone (`notFound('settlement')`) or already approved
(`ONLY_DRAFT_APPROVABLE`); a Calculate that waited for an Approve is refused `SETTLEMENT_LOCKED`. TC-SET-17.


### A running account per partner — DECIDED 2026-10-25 (owner: "a great idea an account"), built 2026-10-25 (phases 1 and 2), live 2026-10-26 (migration `20261025100000_partner_running_accounts`), details GUESSED
Funding a cycle starts before anyone has contributed: partners pay suppliers from their own pockets, in different
amounts, and sometimes want to fund from profit instead of cash. Decided: each partner has a running account — his
advances ("paid so far") and payouts left in add to it, contributions and withdrawals take from it — and cycle
contributions are drawn from those accounts. Also decided (owner, 2026-10-25: "equal thirds, no negative, paid
straight to supplier"): contributions default to **equal thirds**; an account **never goes negative** (no
contributing from profit yet to come — phase 3 is dropped); an advance is **paid straight to a supplier**, not cash in
the business, so cash on hand does not move.

**The old example no longer holds.** The Next up item's example (Shady advanced 1,000, Fares 400, the owner 600; equal
thirds of 2,000 leave Shady +333.33 and Fares **−266.67**) is now **refused**: Fares's third (666.67) is more than his
400, so the contribution is refused `ACCOUNT_BALANCE_TOO_LOW` naming the 266.67 short — he records it as a payment
first (in practice, what he settles with Shady), then the thirds go through.

**Built 2026-10-25** (branch `agent-partner-accounts`; API, office screens, Postgres and unit tests; e2e written, not
run — owner said not for now):

- **The balance** — one definition, `apps/api/src/common/partner-account.ts` (`accountBalances`, `balanceOf`): the
  standing movements of his account, + advances, + payouts left in, − contributions, − withdrawals. The Partners page,
  the cycle's funding panel, every check below and a settlement's reversal read it there. *Since 2026-10-26 it is
  split into pots, and each check reads the pot it may draw — see "Each cycle's funding is its own" below.*
- **An advance** (`POST /partner-accounts/:partnerUserId/advances`): a cycle, an amount above zero, the currency he
  paid in and that day's rate (required for any currency but EGP; the page's rate only prefills), the day he paid (not
  in the future), a note. Refused on a cycle in Settlement, Closed or Cancelled (`CYCLE_CLOSED_FOR_ACCOUNTS`) or once
  its funding is locked (`FUNDING_LOCKED_AFTER_SETTLEMENT`, §8 2026-10-18).
- **Paid so far, by whom** and **the funding target** (`GET /cycles/:id/account-funding`, `PUT
  /cycles/:id/funding-target`): the cycle page's Funding panel says "1,600.00 USD of 2,000.00 USD paid so far" with a
  bar, then each partner's payments. The target is optional, in a currency at a rate; cleared with `amount: null`.
- **Contributing from the accounts** (`POST /cycles/:id/account-contributions`): a total, split equally among the
  cycle's core partners (the default), or one amount per partner. All or nothing: one account short refuses the lot
  (`ACCOUNT_BALANCE_TOO_LOW`, with `partner`, `balance`, `amount`, `short`). Each share raises that partner's
  contribution and posts the same `contribution` ledger row an entered contribution always has.
- **Money taken out** (`POST /partner-accounts/:partnerUserId/withdrawals`): never more than the account holds.
- **A mistake** (`POST /partner-accounts/:partnerUserId/movements/:id/reverse`): once, with a reason; the row stays,
  marked reversed. Never when it would leave the account below zero; a contribution reversed comes back to the account
  and out of the cycle (a `contribution` OUTFLOW).
- **Phase 2 — a payout left in**: Mark paid takes `leaveInPartnerUserIds`; each named core partner's net payout goes
  into his account (`PAYOUT_LEFT_IN`). Reversing the settlement takes it back out — refused while that would leave
  his account below zero.
- **Who**: core partners only, every endpoint (`PARTNER_ACCOUNT_ROLES`).
- **An expense he paid** (2026-10-27, branch `feature/expense-paid-by`, not shipped): a business expense paid from his
  own pocket credits his account (`EXPENSE_PAID`, + his balance, untied money); it comes out only by reversing the
  expense in the ledger. See §9 "Paid by" on an expense.
- **Who owes whom between us**: does not fall out of the balances. With no negative account, nobody owes another
  partner through the accounts; a positive balance is the partners' money the business holds for him. Settling
  between partners stays outside the system.

| Question | Guess built | Why |
|---|---|---|
| What an account movement is in the ledger (CLAUDE.md §11) | **Nothing.** No movement is a ledger row: not cash, not income, not an expense. The cash event is the contribution — his money entering the cycle — which posts the `contribution` INFLOW it always has; the supplier's purchase OUTFLOW at receipt is matched by it, exactly as when partners paid suppliers and entered their contributions before accounts existed. Cash on hand, the P&L, the dashboard and each cycle's profitability are unchanged by an advance or a withdrawal (tested). | "Paid straight to supplier … cash on hand does not move." |
| A payout left in, in cash | The settlement's payout row stands as written — the business paid him — and his account holds it. The account is his money, not the business's cash, so while it sits there cash on hand reads as if he took it; drawing it into a cycle posts the contribution inflow as any contribution. OPEN: if the owner wants cash on hand to keep payouts left in, the payout and the contribution both need a different row. | One reading of every account movement: none is cash. |
| A withdrawal, in cash | No ledger row: the money is his, held outside the business's cash (above). | Same reading. |
| Entering a contribution by hand | Still possible (Split equally, Enter amounts, Add participant): money he put in from his pocket for that cycle, which never touches his account. The panel's Contribute is the way through the accounts. OPEN: whether every contribution must come through an account. | Production's cycle already has contributions with no accounts; refusing them would strand it. |
| Equal shares | Among the cycle's core partners on it, in the order they joined it, each rounded down to the piastre, the last taking the residual (333.33 / 333.33 / 333.34 of 1,000) — the same rule as Split equally. A share that rounds to zero is skipped. A total of zero or less is refused. | CLAUDE.md §10. |
| Who an account is | A core partner with a partner record. An investor, or anyone else, has none (`NOT_FOUND`, `partner`). | "Per partner." |
| Recording for another partner | Any core partner may record an advance, a withdrawal or a reversal on any partner's account, as the office enters every partner's records today. A movement is only reachable under its own partner's address (another partner's is `NOT_FOUND`). | One person keeps the books. |
| An advance on someone not on the cycle | Allowed: advances only track who paid. Contributing needs him on the cycle (`PARTNER_NOT_ON_CYCLE`). | "Advances only track who paid." |
| A target's progress in its currency | An advance paid in the target's currency counts at face value; any other counts its pounds at the target's rate. | "1,600 of 2,000" should read in dollars when they paid in dollars. |
| When a cycle stops taking any of it | Settlement, Closed, Cancelled, or once the settlement is approved — as for a friend's payment (§18). | Its funding is agreed. |
| Two writers at once | Each account is locked (its partner row) for the transaction, cycle first, then accounts in one order; two withdrawals of 600 against 700 cannot both pass. | Doubles are the second-time bug. |
| A contribution lowered by hand, then its account entry reversed | Refused (`CONTRIBUTION_ALREADY_LOWERED`): the contribution would go below zero. | Never a negative contribution. |
| Dates | Today in Cairo when left out; never later. | §7a. |

### Each cycle's funding is its own — DECIDED 2026-10-26 (owner: "each cycle has its own funding"), details GUESSED, live 2026-10-26 (`b8ab447`)
Found in production: CYC-2026-0001's own "paid so far" was empty, yet its Contribute form offered Abdallah 50,775 —
the advance he paid for CYC-2026-0002. **Decided:** an advance funds **only the cycle it was recorded on**; money tied
to no cycle (a payout left in) funds any cycle; the figure a cycle's form shows and checks is what **that cycle** can
draw, never the whole account.

Built (one definition, `apps/api/src/common/partner-account.ts`, `potsOf` — the balance is unchanged, only split):

- **His account is split into pots.** *A cycle's pot*: his standing advances on that cycle less what his contributions
  to that cycle drew from them. *Untied money*: payouts left in, less money taken out, less what contributions drew
  beyond their own cycle's advances. The pots add up to the balance exactly.
- **What a cycle can draw** (`GET /cycles/:id/account-funding` → `availableEgp` per partner): its own pot + untied
  money. The panel's "For this cycle" column and its shortfalls read it; his advances for other cycles are shown under it
  ("+ 50,775.00 EGP paid for other cycles"), never offered. The response also carries `ownAdvancesEgp`, `untiedEgp`,
  `elsewhereEgp` and the whole `balanceEgp`.
- **The server refuses** a contribution needing another cycle's advance, whatever the client sends (it names no pot;
  the server decides): `ACCOUNT_MONEY_FOR_OTHER_CYCLE` (`partner`, `cycle`, `available`, `elsewhere`, `amount`,
  `short`). With nothing held elsewhere it is the old `ACCOUNT_BALANCE_TOO_LOW`, its `balance` now what the cycle can
  draw.
- **The Partners page** still shows the whole balance, and under the figures the pots: "Tied to no cycle: … · For
  CYC-2026-0002: …".
- **Data check** 28.6 (`scripts/check-data.sh`; was 27.3, which the branches' check also used): a partner whose untied money is below zero — a contribution that drew
  another cycle's advance before this rule. **Production:** from the facts read on 2026-10-26 (Abdallah's 50,775 and
  Shady's 10,000 on CYC-2026-0002, nothing contributed through an account on CYC-2026-0001) no contribution drew another
  cycle's advance; run the check after deploying to confirm it reads 0.

| Question | Guess built | Why |
|---|---|---|
| Which pot a contribution draws | **Its own cycle's advances first, untied money for the rest.** Read from the standing movements as they are now, not in time order: per cycle, min(advances, contributions) came from its pot, the excess from untied money. So an advance recorded *after* a contribution that took untied money counts as having funded it, and frees that untied money. No column records the pot. | The smallest consistent rule; one sum, no stored state to drift. |
| A withdrawal | **Untied money only** (`ACCOUNT_MONEY_TIED_TO_CYCLES` with `available`, `tied`, `amount`). An advance paid a supplier for a cycle's goods; it is not cash to take out. | "Each cycle has its own funding." |
| Reversing an advance | Only while **its cycle's pot** still holds it (`ADVANCE_ALREADY_DRAWN` with `drawn`, `cycle`): reverse the contribution it funded first. Other cycles and untied money are never touched. Was: refused only if the whole account would go negative. | Never negative, per pot. |
| Reversing a settlement whose payout was left in | Takes the payout back from **untied money only** (`ACCOUNT_MONEY_TIED_TO_CYCLES`). | A payout left in is untied money. |
| A payout left in that names its cycle | Its `cycle_id` is the settled cycle it came from; it is **untied** all the same. | Owner: "only money tied to no cycle (a payout left in) funds any cycle". |
| Untied money below zero (records from before the rule) | Offers nothing; no cycle's pot is reduced to cover it. Check 28.6 finds it. | Do not let old data move new money. |
| OPEN: an advance left undrawn on a cycle that is settled, closed or cancelled | **Stays that cycle's** — stranded: no other cycle can draw it and it cannot be taken out. Shown on the Partners page as that cycle's pot. Whether it should then become untied is for the owner. Not in production today: CYC-2026-0001's one leftover advance (Abdallah's 10,000, paid beyond his 55,000 share) was untied by the owner's word on 2026-10-28 — money paid beyond a partner's share of a cycle is owed back to him as untied money. | Build for what exists. |

### The cycle page's money-in is one Funding card — DECIDED 2026-10-26 (owner, from a rendered sample: "build it like this"), details GUESSED, live 2026-10-26 (`105bd6b`; below the Shipment card since `8d0447a`)
One card replaces the Participants card and the separate funding panel (`components/cycles/funding-card.tsx`). A
re-arrangement of controls that existed — no new money rule; every server rule and refusal stands. Top to bottom:

1. **Target and paid so far.** "Target X" (set/changed where it was), "N paid so far · M to go" with the bar (no target:
   "N paid so far", no bar). "Paid so far on this cycle": one row per core partner — what he paid here, the day (or "N
   payments"), and **into capital**; a partner with nothing shows "—". "+ Record what I paid" (the advance dialog).
2. **Contributions.** Each core partner's equal share, "from his advances" (what this cycle can draw for him — its own
   pot and untied money, `availableEgp`), and a pill: "covered · N left over" or "N short". "Contribute equal thirds"
   (the accounts' contribute, now in a dialog: equal shares of a total, the server's all-or-nothing check), "Enter
   amounts" (`amounts-form.tsx`, in a dialog) and "Split equally" (by hand, unchanged). An investor keeps his own row.
   The "share of repaying the friend" line (§18) sits under the rows.
3. **Profit split and who is on the cycle.** "Equal thirds (33.33 / 33.33 / 33.34)", "By contribution (…)", "Agreed
   split (…)" or "nothing put in yet, so settling is refused"; "Change split"; "On this cycle: …"; "+ Add investor" (the
   old Add participant form, opening on the investor type; a core partner can still be chosen).

The funding note is one line at the card's top (its "friend paid — repay him" wording and §18's rule unchanged), with
"Paid by a lender" beside it; Split equally and Enter amounts are in section 2 just below. Locked (approved, paid,
closed): every control off, the reason at the top and on each control. A cycle in Settlement, Closed or Cancelled but
not locked: the accounts' controls (record, contribute, target) off with the accounts' reason; entering by hand stays.

| Question | Guess built | Why |
|---|---|---|
| What the equal shares are of | The **target in pounds** when one is set and not below the cost to fund; otherwise the **cost to fund** (`fundingFor`, the figure Split equally divides). Investors' money off first. `equalShares`, the last partner taking the odd piastre; nothing to fund gives every share zero (no pill). One definition: `contributionShares` in `common/partner-account.ts`, read by `GET /cycles/:id/account-funding` (`shares`, each partner's `shareEgp`/`stillToGiveEgp`/`coverEgp`). | The owner's sample: thirds of the 120,000 target (40,000 each). A target below the cost would leave part of the cost unshared. |
| Covered or short | What he **still has to give** (share less what he has already contributed, never below zero) against what this cycle can draw for him. Covered with the difference left over, or short by it. | So a partner who has already put in his share reads covered, not short. |
| "Into capital" | Of what he paid **on this cycle**, how much his contributions **to this cycle** drew from it: min(advances, contributions from the account) — the pots' own split (`potsOf` → `intoCapital`). A contribution entered by hand (Split equally, Enter amounts) draws no advance, so counts nothing here. *Superseded later on 2026-10-26: section 1 is "Put in so far" and into capital is his whole contribution (below, "Put in so far, shares of what was repaid").* | One definition with the pots. |
| "Contribute equal thirds" default | What the partners still have to give of their shares (`shares.stillEgp`), split equally by the server; a typed total is never overwritten. | The sample's button; the server's split is equal. |
| The profit-split line | `profitSplitView` (settlement-math.ts, beside `profitBasisOf`): a split by contribution shown to two places, the last line taking the rounding so it reads 100; a custom split as stored, with the refusal settling would give (partial / not 100). Display only — the settlement's own maths is unchanged. | One reading with the settlement. |
| "Change split" | Every participant's agreed %, adding up to 100, or none ("Split by contribution" clears them); Save waits for one of the two, since settling refuses anything else. Written through each participant's PUT. The server still checks only at settlement (unchanged). *Superseded 2026-10-27: saved whole through `PUT /cycles/:id/split`, checked at save time (below, "Change split saved and checked on the server").* | There was no way to edit a custom % after adding a participant. |
| Who sees the card | Core partners (`partnerAccount.read`), as the panel was; nobody else signs in to the office (LEARNINGS). | — |

### Put in so far, shares of what was repaid, the exchange difference — DECIDED 2026-10-26 (owner), details GUESSED, live 2026-10-26 (`42d2272`)
The owner on production's CYC-2026-0001 (a friend, Ahmad Eraiby, paid it all; the partners repaid him 201,168.99 EGP in
three thirds at 14 / 14.50 / 14.90 and each entered 67,056.33 as his contribution, no advances): "a bit confusing, seeing
funding zero, while each one of us clearly paid 67,056.33 to ahmad"; "it shows we paid 64,460.76, while its 67,056.33 ??";
"it should state as well, the exchange difference". Three changes to the Funding card, display and the
`account-funding` endpoint only — nothing about how money is counted or settled changes.

| Rule | Built | Status |
|---|---|---|
| Section 1 is "Put in so far" | Per partner: his contribution on the cycle + his advances on it **not yet drawn** into a contribution (the cycle's pot, `potsOf`) — a drawn advance is inside the contribution and is never counted twice. One definition, `putInSoFar` (`common/partner-account.ts`). Columns: put in, into capital (his contribution), how it came in. Total "N put in so far", or "· M to go" against a target. Cycle 1 reads 201,168.99, 67,056.33 each. | DECIDED |
| How it came in | The contribution splits into drawn from his account (his CONTRIBUTION movements on the cycle: "from his account") and entered directly (the rest). Entered directly on a cycle a friend paid (any standing financing): "repaid Ahmad Eraiby"; otherwise "contributed". An undrawn advance: "paid {day}, not drawn yet", or "N payments, not drawn yet". The amount beside each part only when there is more than one. A contribution lowered by hand below what the account gave reads entered 0. | DECIDED (labels); the wording GUESS |
| A target in another currency | Put in, in the target's currency: the contribution at the target's rate, plus the undrawn share of his advances' face value (all of it when nothing is drawn, so an advance in the target's currency still counts at face). | GUESS |
| Shares on a cycle a friend paid | Once the partners have repaid him anything: equal shares of **what they repaid him in pounds** (`repaidOnCycleEgp` — the standing repayments `exchangeDifferenceEgp` reads), investors' money off first, instead of the cost to fund (`shares.basis` `REPAID`). Before any repayment: the cost to fund, as before. A target still wins when set and not below that figure. Covered/short measure against it. Cycle 1: 67,056.33 each, covered, nothing left over. | DECIDED; the target rule GUESS |
| A cycle friends paid only in part | The repaid basis then leaves out the part of the cost no friend paid (on cycle 1 that is 1.41 EGP: cost 193,382.28, his payment 193,380.87). Not handled: the owner's figures for cycle 1 ask for thirds of exactly the repaid sum. | OPEN |
| The exchange difference line | On a cycle with repayments and a difference that is not zero, under the shares: "Exchange difference on repaying Ahmad Eraiby: X EGP (Y each) — a cost to the cycle, taken from its profit; each partner still gets his full contribution back as capital." Negative: "Exchange gain on repaying …: X EGP (Y each) — the rate fell since he paid, so it adds to the cycle's profit; …", the figure shown without a minus. The figure is `exchangeDifferenceEgp` (`common/lender-debt.ts`) — the one settlement, cycle profit and the dashboard read. | DECIDED |
| Each partner's part of it | **By the profit split**, not plain thirds: settlement takes the difference off the cycle's profit before splitting it, so each one's part is `profitShareOf` (settlement-math.ts) — `distributeCycleProfit`'s own split of that amount, by contribution or the agreed percentages, before investors' fees. Equal contributions give equal parts ("each"); otherwise each name and amount. No basis (`CYCLE_NOT_FUNDED`, a partial or off-100 split): the figure alone. An investor bears his part too and is listed. | GUESS (follows the settlement's arithmetic) |
| Cycle 1's figure | Rebuilt from the figures above (AED 13,905.69 at 13.9066; dirham thirds of 4,635.23 repaid at 14 / 14.50 / 14.90) the reader gives **7,788.12** (201,168.99 repaid − his 193,380.87), 2,596.04 each. 7,786.71 is repaid − the cycle's cost (193,382.28), which is not how settlement counts it; production's stored repayments decide what the card shows there. Confirmed 2026-10-26: production's correction of 23 Oct recorded 7,788.12 (its rehearsal and run reports); 7,786.71 was a miscount in the chat. | DECIDED |
| Arabic | The new strings are the agent's wording, for the owner to correct. | GUESS |

### Investors in the funding, the partners' part, shares as agreed, every percentage — DECIDED 2026-10-27 (owner), details GUESSED, live 2026-10-27 (`962ab07`)
The owner on CYC-2026-0001 after its funding was corrected (Abdallah 55,000, Shady 33,084.50, Fares 33,084.49; Ahmad
Eraiby 60,000 and Mohammed Setta 20,000 as temporary investors; repaid 141,168.92): "they should be added to funding as
well right? also this: Each partner's share of the cycle? something looks off" → "fix it". The card read 121,168.99 put
in (the partners only), "equal thirds of what was repaid to Ahmad Eraiby, 141,168.92" at 20,389.64 each, and
"Abdallah 55,000 (45.39%) · Shady (27.3%) · Fares (27.3%)". Display and the `account-funding` endpoint only — no
settlement figure moves.

| Rule | Built | Status |
|---|---|---|
| Put in so far counts everyone | The total and the list hold **every participant's** contribution: the core partners first, then the investors (`participantType` `TEMP_INVESTOR` on the row, "invested" / "استثمر" as how it came in — never "repaid {friend}"), then anyone not on the cycle who paid for it. Cycle 1 reads **201,168.99**. | DECIDED (owner) |
| A target's progress | Counts investors' money too (their contribution at the target's rate), because the target's shares take investors' money off the target — the target is what the whole cycle is funded with. | GUESS |
| The partners' part | What funds the cycle less investors' money. What funds it: the target (set, not below the next figure) or the cost to fund — and on a cycle a friend paid, once anything is repaid him, **what was repaid him or everything contributed to the cycle, whichever is more** (`shares.basis` `REPAID` / `PUT_IN`). Repaid alone took Eraiby's 60,000 off twice: it never went into repaying him, yet came off the repaid figure as investors' money (141,168.92 − 80,000 = 61,168.92). Every contribution is capital the settlement hands back, so together they are the money funding the cycle; the repaid figure stays the floor while contributions are still being entered. One definition, `contributionShares`. Cycle 1: 201,168.99 − 80,000 = **121,168.99**. | DECIDED (the double subtraction is a bug); the rule chosen is a GUESS |
| Why not "repaid − only investors' money that repaid him" | The system does not record whose investment went into repaying the friend (a lender and a user are separate records), and on cycle 1 it gives 121,168.92 — 0.07 short of what the partners entered, because of the pay-off's 0.07 (§18) — so nobody would ever read "as agreed". | GUESS |
| Each share | When **every core partner's contribution is entered** (above zero) **and together they make up the partners' part to the piastre**, each share is what he contributed — "as agreed" (`shares.agreed`), heading "Contributions — as the partners agreed, 121,168.99 EGP between them" / "المساهمات — كما اتفق الشركاء، … بينهم". Otherwise equal shares stay the suggestion, as before; on the `PUT_IN` basis the heading is "equal thirds of everything put into the cycle". Cycle 1: 55,000 / 33,084.50 / 33,084.49, all covered. 30 / 30 / 40 of the cost to fund entered exactly also reads as agreed. | DECIDED (owner: show what was agreed); the "to the piastre, all entered" test is a GUESS |
| Known limit | Before the partners enter anything, a cycle whose investors include the friend's own loan still reads the repaid floor less every investor (cycle 1 with only the investors in: 61,168.92). Nothing records which investor's money repaid him; it corrects itself as the partners' contributions are entered. | OPEN |
| Each one's share of the cycle | The grey box lists **every participant**, investors included — "Each one's share of the cycle, repaying {friend} included:" when there are investors — at the **profit split's own percentages** (`profitSplitView`, the server's `participants[].profitPct`), not a second sum over the partners. No basis (nothing contributed, a partial custom split): amounts without percentages. | DECIDED (owner) |
| "Contribute equal thirds" | Hidden when it has nothing to do: the shares are as agreed, or there is a share to give and every partner has already given it (`shares.stillEgp` 0). Still shown while shares are still to give, and while there is nothing to share yet (advances can be drawn in before a cost exists). "Enter amounts" and "Split equally" stay as the secondary buttons. | DECIDED (owner, 2026-10-27); the nothing-to-share case a GUESS |
| First column of both lists | "Name" / "الاسم" instead of "Partner": investors are listed there too. | DECIDED (owner, 2026-10-27) |
| Percentage rounding | `percentagesOf` (settlement-math.ts), used by `profitSplitView`: **largest remainder** at two places — every row starts at its share rounded down, the missing hundredths go to the rows that lost most, ties to the later row (thirds still read 33.33 / 33.33 / 33.34). They always sum to 100.00 and every row is within a hundredth of its true share. Before, rows were truncated and the last absorbed the rest (Setta read 9.96 for a true 9.9419; 80k/100k/120k read 26.66 / 33.33 / 40.01, now 26.67 / 33.33 / 40.00). Cycle 1 reads **27.34 / 16.45 / 16.45 / 29.82 / 9.94**: each rounded on its own they come to 100.01, so one row gives a hundredth — Eraiby, whose .57 is the smallest rounding-up of the three (Shady and Fares .61). Money lines (`distributeCycleProfit`, 4-place `sharePct`) unchanged. | DECIDED (owner: largest remainder); cycle 1's 29.82 rather than 29.83 follows from it |

### A new temporary investor from the Funding card — DECIDED 2026-10-26 (owner: "add the fix to next up"), live 2026-10-27, details GUESSED
"+ Add investor" picked only existing `TEMP_INVESTOR` accounts and no screen made one, so the first investor met an
empty list. A `+` beside the person picker (`FieldWithQuickCreate`, the registry's `investor` entry in
`components/entities/entity-forms.tsx`) opens a form with a name alone; saving makes the investor, refreshes the
people list and selects him. The participant form underneath keeps what was typed; Cancel on either form leaves
nothing chosen, and the next visit starts empty.

| Rule | Built | Status |
|---|---|---|
| The endpoint | `POST /users/investors`, a name alone (`displayName`), **not** `POST /users`: that one takes the role from the caller, so a `+` reusing it would be a way to make a partner (CLAUDE.md §12). Only core partners may call it (`@Roles('CORE_PARTNER')`; ADMIN_SUPPORT may list users but not create them). | DECIDED (owner: role fixed); the separate endpoint is the agent's choice |
| The role | Always `TEMP_INVESTOR`. Anything else sent (`role`, `email`, `password`) is ignored, not refused — only `displayName` is read. | DECIDED (owner: "role fixed to TEMP_INVESTOR") |
| No office login | The email is made up and never used: `investor-<uuid>@investors.invalid` (`.invalid` is reserved never to exist, so nothing is ever sent there and it is nobody's address). The password is 32 random bytes, stored only as its bcrypt hash and shown to nobody. An investor is refused at login anyway (`OFFICE_NOT_FOR_INVESTORS`, §12). | DECIDED (owner); the address's shape a GUESS |
| The name | Trimmed, inner runs of spaces made one. Empty: `INVESTOR_NAME_REQUIRED`. Longer than **80** characters: `INVESTOR_NAME_TOO_LONG` (`{max}`) — the same limit as a branch name; the form stops at 80 too (`users/new-investor.ts`). | DECIDED (a coded refusal); 80 a GUESS |
| A name already used | **Refused**, `INVESTOR_NAME_TAKEN` (409, `{name}`), when any partner or investor already has it, ignoring case — the picker lists people by name, and two "Ahmad Eraiby"s there cannot be told apart, so the second would be picked by chance. Choose him from the list instead. Two of the same name at once: one is made, the other refused (an advisory lock around the check). | GUESS (2026-10-27) — the owner may prefer two people with one name allowed |
| Arabic | The new strings ("مستثمر جديد", the hint and the refusals) are the agent's wording, for the owner to correct. | GUESS |

### The Partners page's cards show Put in so far — DECIDED 2026-10-28 (owner, from production: "not synced"), built on `feature/partner-cards-put-in`, NOT merged, details GUESSED
Each core partner card read "Capital in" — his contributions only. On production cycle 2 (PURCHASING) had contribution
0 for all three while each had paid advances for it not yet drawn (Abdallah 50,775, Shady 72,100, Fares 51,207): they
showed in the Running accounts and on cycle 2's Funding card, and not on the cards. Display and `GET /users/participation`
only — capital, profit shares, settlements and every money check are unchanged.

| Rule | Built | Status |
|---|---|---|
| The card's money figure | **Put in so far**: over each cycle he is on, the Funding card's own figure — `putInSoFar` (`common/partner-account.ts`) over the same pots (`accountPots` → `byCycle`): his contribution + his advances on that cycle not yet drawn. A drawn advance is inside the contribution, never counted twice (advance 100, 60 drawn → 100, not 160). Computed in the API, returned as `putInEgp` / `undrawnAdvancesEgp` per person and per cycle; `contributedEgp` stays (capital, what settlement hands back). Production-like: Abdallah 55,000 + 50,775 = **105,775** (after the 10,000 is untied), Shady **105,184.50**, Fares **84,291.49**. | DECIDED (owner) |
| Not put in | An advance tied to no cycle (untied money, e.g. the 10,000 being moved off cycle 1), a reversed advance, payouts left in, expenses he paid: they stay in the Running account only. | DECIDED (follows §8's pots) |
| A temporary investor | No account: put in so far is his contribution. | DECIDED |
| An advance on a cycle he is not on | Counted, under that cycle, with capital 0 — the Funding card lists "anyone not on the cycle who paid for it", so the two agree. The cycle then appears in his card's list and its count. | GUESS |
| The sub-line | Only when put in so far differs from capital: "Capital {x} · {y} paid, not drawn yet" / "رأس المال {x} · {y} مدفوع ولم يُسحب بعد", amounts as left-to-right runs. | GUESS (wording) |
| The page's total and the export | The first total tile is "Put in so far" across the core partners, with the same sub-line. The CSV keeps "Capital in" and adds a "Put in so far" column before it (per cycle row, or per person when he has no cycle). | GUESS |
| "Still in play" | Unchanged: capital less capital returned. An undrawn advance is money out too but is not capital; whether it belongs here is | OPEN |

### Change split saved and checked on the server — DECIDED 2026-10-26 (owner), live 2026-10-27, details GUESSED
The Funding card's Change split wrote each participant's % through its own participant PUT and only the dialog checked
they added up to 100; the server refused a partial or off-100 split only at settlement, weeks later (CLAUDE.md §3). One
endpoint now saves the whole split: `PUT /cycles/:id/split` with `{ split: [{ participantId, customProfitPct }] }`
(`customProfitPct` null for none). The dialog sends it once; a refusal is said in the dialog's toast and the dialog
stays open with what was typed.

| Rule | Built | Status |
|---|---|---|
| All or none | Every participant of the cycle a percentage, or none (profit then follows the contributions). A participant not named in the list has none — so leaving one out of a split is `PARTIAL_CUSTOM_SPLIT`, and an empty list clears the split. | DECIDED (owner) |
| Adding to 100 | Exactly 100.0000 between them, else `SPLIT_NOT_100` with `{total}` (99.99 and 100.01 are both refused). One definition: `customSplitProblem` / `assertCustomSplit` (settlement-math.ts), which settling (`resolveShares`) and the card's split line (`profitSplitView`) now ask too (CLAUDE.md §11). | DECIDED (owner) |
| Each percentage | A number from 0 to 100 with at most **four** decimals (what `custom_profit_pct` holds, so nothing is rounded between the check and the store), else `SPLIT_PCT_INVALID`. 0 is allowed (a participant agreed to take no profit). A negative one is refused even when the total is 100. | 0–100 DECIDED; four places and 0 allowed GUESS |
| Wrong participants | One not on this cycle — another cycle's, nobody's, or not an id — `SPLIT_PARTICIPANT_NOT_ON_CYCLE`; the same one twice `SPLIT_PARTICIPANT_TWICE`. A cycle that does not exist is a 404. | DECIDED (coded, never a 500) |
| Locked | Under the cycle's lock, refused once the settlement is approved or paid or the cycle closed (`FUNDING_LOCKED_AFTER_SETTLEMENT`, `assertFundingOpen`). | DECIDED (owner 2026-10-18) |
| All or nothing | One transaction: a refusal, or a failure halfway through the writes, leaves every participant as it was. | DECIDED (owner: "all or none") |
| Saving the same split again | Only rows whose percentage changes are written, so the second save changes nothing — and a draft settlement calculated in between stays approvable (`fundingChangedSince` reads the rows' `updatedAt`). One audit row (`UPDATE_PROFIT_SPLIT`, before/after) per save that changed anything. | GUESS |
| Who | Core partners (`@Roles('CORE_PARTNER')`, `cycle.saveSplit` in the office's permissions). | DECIDED |
| The participant PUT | `PUT /cycles/participants/:id` still accepts one participant's `customProfitPct` (an e2e invariant and older callers use it); settling still refuses what it leaves partial. The office no longer calls it for the split. | OPEN — narrow it once nothing else sends a % |


### Profit taken before a cycle is settled — DECIDED 2026-11-08 (owner), on `dev` 2026-11-08, not shipped, details GUESSED where marked

Raised 2026-11-07 ("not now but keep in mind"), decided 2026-11-08: "I think its a normal thing I am allowed to take some
of my share profit any time mid cycle and its recorded of course, and the profit we made does not change". Then, from
the options put to him: up to his **share of the profit already collected**; if he took more than his final payout,
**he owes it back** — taken off his next payout; **any core partner** may record it for any core partner. Called a
*profit draw* in the code ("Profit taken" on screen) because *advance* already means paying a supplier for a cycle.

| Question | Rule | Why |
|---|---|---|
| Who | A core partner on the cycle (`PROFIT_DRAW_NOT_ON_CYCLE` otherwise). A temporary investor cannot (`NOT_FOUND` partner). Any core partner records it for any core partner. | Owner 2026-11-08. Investors: GUESS — their fee is a share of their own profit, settled at the end. |
| How much | His share of the **profit collected**, less his standing draws on that cycle, less anything he still owes from an earlier payout (`PROFIT_DRAW_OVER_AVAILABLE` with `available`, `share`, `drawn`, `owed`). His share is the settlement's own split of the collected profit (by contribution or the agreed percentages), to the piastre. | Owner 2026-11-08: "share of collected". |
| Profit collected | The cycle's profit as the settlement reads it now, less what customers still owe on its sales, never below zero. What is owed is counted against profit first, and the cycle's part of an order is read before returns. | **GUESS** — both err low, so a partner can never take profit the business has not received. |
| Funding not entered, a broken split, a loss | Nothing to take: the split's refusal (`CYCLE_NOT_FUNDED`, `PARTIAL_CUSTOM_SPLIT`, `SPLIT_NOT_100`), or zero collected. | No basis, no share (CLAUDE.md §10). |
| The amount and the day | Above zero, at most two decimals (`PROFIT_DRAW_AMOUNT_NOT_POSITIVE`, `PROFIT_DRAW_AMOUNT_PRECISION`), in pounds; the day today or earlier (`DATE_IN_FUTURE`, label `PROFIT_DRAWN`). | GUESS: EGP only. |
| In the ledger | One OUTFLOW, category `profit_draw`, type `PROFIT_DRAW`, on the cycle, owned by the draw (the ledger will not undo it on its own). **Cash on hand goes down; the cycle's profit, the P&L's profit and the dashboard's profit do not change**; Analytics' "investment" leaves it out. | "The profit we made does not change." |
| When | Until the cycle's settlement is approved; refused once it is being settled, settled, closed or cancelled (`PROFIT_DRAW_CYCLE_LOCKED`). GUESS: no check against cash on hand. | The split is agreed at approval (§8, funding lock). |
| At settlement | Calculating writes his draws (and anything he owes from before) as a `PROFIT_DRAWN` line off his payout. A draw or an undo after calculating makes the draft stale: approval and payment refuse (`SETTLEMENT_STALE_DRAWS`) until it is calculated again. Paying marks the draws settled. What the business pays out in all — draws plus payouts — is what it would have paid with no draws. | One reading of the payout (rule 11). |
| Took more than his payout | No cash is pretended in. The payout is nothing, and what his draws came to beyond it is carried (`CARRIED`, on no cycle) and taken off his **next payout on any cycle**; it also lowers what he may take meanwhile. Never more than he drew: a loss beyond that is the payout's, as it always was. GUESS: not taken from his running account. | Owner 2026-11-08: "they owe it back". |
| Undo | Once, with a reason (`PROFIT_DRAW_REASON_REQUIRED`, `PROFIT_DRAW_ALREADY_REVERSED`); an INFLOW pointing at the original puts the cash back. Not once a paid settlement took it (`PROFIT_DRAW_SETTLED`); something owed is undone with its settlement only (`PROFIT_DRAW_CARRIED_NOT_REVERSIBLE`). | History is not rewritten (BRD 10). |
| Reversing a settlement | Frees the draws it took (they stand again, to come off the next settlement) and undoes what it left owing — refused while a later paid settlement holds that (`SETTLEMENT_OWED_TAKEN_LATER`): reverse that one first. | Never a debt taken twice or lost. |
| Two at once | The cycle, then the partner's account, locked for each draw; two draws against the same room cannot both pass. | Doubles are the second-time bug. |
