> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 6. Supplier refunds

**DECIDED 2026-08-21.** A refund recovers cost. It reaches the ledger as an
inflow on the cycle and reduces that cycle's investment, improving its profit.

**It does not re-price batches.** Units already sold keep the cost they were
sold at, and a settlement may already have been agreed on those figures.

Refunding more than the order was worth, counting refunds already recorded, is
refused.

**DECIDED 2026-10-10 — goods lost on the way can be refunded.** *Built 2026-10-11 (B5, B5b).* Asked
for by the owner. Whoever lost them — the shipping company, or the supplier — may
pay some or all of it back. A refund is recorded against **the loss itself**, from
the leg's shipping company or the order's supplier, in any currency with its FX
rate, and works like any supplier refund: it is money arriving, so it reaches the
ledger as an inflow on the cycle and recovers cost, raising the cycle's profit by
what it brings in.

- Refunds on one loss can never total more than the loss cost, counting earlier
  ones — compensation is recovery, not a profit on losing goods.
- Like any supplier refund it can be recorded whenever the money arrives, even
  after the cycle is settled or closed.
- A loss that has been refunded cannot be taken back: the goods turning up after
  being paid for would be counted twice. If they do turn up, the refund is undone
  first — money handed back is a ledger correction — and then the loss.
- Neither kind of refund can be dated in the future. Left blank, it is dated
  today, Cairo time.
- The shipping company that pays must be that leg's own provider, as recorded on
  the leg; a leg whose company was typed in rather than chosen can only be
  refunded by the supplier.

**2026-10-10 — undoing a refund.** *Built (B5b).* A supplier refund or a loss
refund can be undone when the money is handed back, by a core partner, with a
reason. Nothing is edited away: the refund stays on record, marked undone, and
a balancing ledger outflow points back at its original inflow (§9). An undone
refund counts toward no cap and no profit, so the loss is unrecovered again
and the cycle's profit falls by it on every screen. Undoing twice is refused.
Once every refund on a loss is undone, the loss can be taken back.
Guesses, open until confirmed:
- An undo is allowed in any cycle status, settled or closed included, as
  recording a refund is — money moves when it moves.
- When a loss is taken back, its undone refunds stop naming it (the database
  would otherwise refuse the take-back); which loss they were for is kept in
  the take-back's audit entry.
- A refund recorded before refunds reached the ledger has no inflow to
  balance; undoing it only marks it.
- The undo is dated when it is done; there is no separate "handed back on"
  date.

---

