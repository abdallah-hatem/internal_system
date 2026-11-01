> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 17. Selling on Amazon  — PLANNED, raised 2026-10-08

The owner wants to sell on Amazon as well, at some point. **Nothing is built and
nothing is decided.** This section exists so the idea is not lost, and so the
questions that shape it are asked before any of it reaches code.

What already holds and would not change: marketplace sales are already a kind
of sale (§3). Stock is allocated FIFO from cycle batches when a sale is
confirmed, and that cost is never re-priced. So an Amazon sale would count
toward the profit of the cycle its stock came from, like any other sale, unless
decided otherwise.

Open — each changes the design, so each needs an answer first:

| Question | Why it matters |
|---|---|
| **Which Amazon** — **DECIDED 2026-10-08: both Egypt and the UAE** | Two currencies, Egyptian pounds and dirhams, each with its own payouts. |
| **Where UAE stock comes from** — OPEN | Goods already pass through the UAE on their way to Egypt. Today stock can only be sold once it has been received and checked in Egypt. Selling on Amazon UAE means either selling some goods before they reach Egypt, or sending stock back out of Egypt. |
| **Who ships** — Amazon holds our stock (FBA), or we ship each order — OPEN | With FBA, stock sits in Amazon's warehouse but is still ours until sold. The system has one place stock can be today; this would make it two. |
| **How orders arrive** — recorded by hand, or pulled from Amazon automatically — OPEN | By hand works with today's sales screens. Automatic needs an Amazon seller account connected, and decides when a sale counts as confirmed. |
| **Amazon's fees and payouts** — OPEN | Amazon pays out later and net of its fees. The fee is a selling expense, not part of the goods' cost. Until the payout arrives, the money is owed by Amazon, which is not a shop. |
| **Price per channel** — OPEN | Whether a product can have a different price on Amazon than at the counter. |
| **Returns through Amazon** — OPEN | Whether §5 applies unchanged when the buyer returns to Amazon rather than to us. |
| **What a listing needs** — OPEN | Amazon asks for barcodes, images and weights that most products do not have yet. |

---

