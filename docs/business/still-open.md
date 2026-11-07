> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## Still open

These are **not decided**. The code's current behaviour is stated so nobody
mistakes it for an agreement.

| Question | What the code does today |
|---|---|
| How partners split a temporary investor's fee | Recorded against a named recipient participant; the split itself is manual. BRD §19 assumes equal but does not lock it. |
| Whether leftover stock can move from a closed cycle to general inventory | It cannot. Batches stay owned by their source cycle. |
| ~~Payment account and reconciliation workflow~~ | **DECIDED 2026-10-14 by the owner: none** — "we don't need money accounts". The accounts and the unused reconciliation table were removed (§9, "Money accounts — removed"). Kept here so the question is not raised again as open. |
| Late penalties or interest on overdue balances | None. Overdue flags and notifies only. |
| Whether a shop can pay a deposit before an order exists | It cannot — a payment above what is owed is refused. If prepayment is real here, it needs its own concept rather than a loosened rule. |
| A cycle's "investment" on Analytics after running costs | Analytics sums a cycle's money out as its investment, and that has always included the settlement payout rows. Since L7 a payout row is the cash handed over, net of the partners' running costs, so a paid cycle's investment reads lower by their share. Raised 2026-10-12 (L7); whether payouts belong in "investment" at all is the question. |
| Where the cash for lost goods shows in the ledger | Nowhere. Goods are booked into the ledger when they are received, so units lost on the way never appear in it, though they were paid for. Raised 2026-10-10. |
| Whether stock is held for an order request | §3 says reservations are not in use and reserved quantity is zero; §12 says an order request holds its stock for 48 hours. The two predate 2026-10-10 and disagree. Raised by the 2026-10-10 release review. |
| Blocking sales to a shop that is behind | Not blocked. Deliberate — see §7. |
| Whether a shop that is behind on payment may hold stock | It may. A request checks verification and stock, not the balance. Raised 2026-08-30 with the storefront; not decided. |
| A customer with branches and no default branch (§7) | A new order stays on the owner, with no branch. GUESS; Ahmad Zogmar has no default until the owner picks Mokattam, Master or LS2. |
| "On the owner" in the Sales list's branch filter; the highest page (§3) | Always offered; pages run 1 to 1,000,000. GUESS. |
| A partner's payout left in his account, in cash on hand (§8) | Counted as paid out to him, though it sits in his account. OPEN. |
| Whether every contribution must come from a partner's account (§8) | No: contributions entered by hand still work and touch no account. OPEN. |
| Taking profit before a cycle is settled — an advance on a payout (raised 2026-11-07, owner: "not now but keep in mind") | Not possible. Profit leaves only through a settlement, which refuses while the cycle holds stock; a withdrawal draws untied money only. Idea offered: record an advance against a partner and cycle, cash goes down, profit unchanged, taken off his payout at settlement, capped at his share of profit already collected. Not built. |

---

