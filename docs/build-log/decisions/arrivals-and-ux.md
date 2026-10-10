# Partial arrivals + UX batch — decisions

- **[Ask] Run mode — fully autonomous.** The user's choice, 2026-10-10.
- **[Ask] Which legs can arrive in parts — any leg.** The user's choice: China→UAE and UAE→Egypt alike.
- **[Ask] Selling early — yes, as soon as checked.** The user's choice: each delivery into Egypt is
  verified into stock and can be sold right away. The cycle cannot settle until the whole shipment
  is accounted for.
- **[Ask] Goods that never arrive — the partner chooses each time.** The user's words: "you give me
  options then and i choose as i want maybe lost, maybe they will be shipped later". So the remainder
  stays in transit by default, and a partner can mark some or all of it lost at any time.
  Lost cost becomes a recorded loss on the cycle. It is NOT spread onto the batches that arrived:
  §3 says a batch's landed cost and a sale's COGS are never re-priced, and earlier deliveries may
  already be sold. So the rule is derived from an existing invariant, not a new guess.
  Alternatives: spread over the arrived goods (breaks §3); keep waiting with no way out (blocks
  settlement forever).
- **[Ask] The three UX rule decisions — "do all".** (1) A sale can be created and confirmed in one
  click; drafting stays available. (2) A payment can be recorded against a chosen order from that
  order; oldest-first stays the default elsewhere. (3) A draft order shows no amount owed.
- **[Ask] #6 search box — remove it.** The user's choice.
- **[Context] Branching stays as the repo does it.** A local `feature/` branch, verified, merged to
  `master` and pushed (which deploys). There is no `dev` branch, and previews are switched off.
  Why: the 2026-09-19 decision still holds.
- **[Plan review] CONFLICTS → resolved in the doc** (autonomous: the doc is the authority, so it was
  completed rather than the code bent). Losses are their own record, not ledger rows (§9: the ledger
  is money moving). A loss can be taken back until the cycle settles. Nothing is recorded during
  settlement. The settlement gate also lives in the transition, not only in approve. Receiving needs
  Arrived Egypt, and the walk to Selling runs each step's checks. A short count waits against its
  delivery and can be received in several goes. A loss is valued at the full unit cost on any leg; the
  final event on a line takes the rounding residual. A leg's cost is locked after the first receipt or
  loss. The migration's zero-cost losses are written down as the one exception to "never by itself".
  F1a and F1b are reclassed as logic, and U4's query fix is split out as U4b (logic). The cash for
  lost goods not showing in the ledger is recorded under "Still open" (it predates this change).
  Why each: the reviewer's findings 1–16; alternatives were a ledger `loss` category (breaks §9) and
  one batch per delivery line (strands short counts).
- **[Plan review, round 2] Seven stale lines fixed → ALIGNED.** The doc held; the plan and spec bodies
  still said "loss → ledger row", "unique delivery line", `DELIVERY_HAS_STOCK`, "stays on the way", and
  U4's cases sat under U4b. All were reworded to match the doc, and the missing role cases (receipts,
  taking a loss back) and the late-freight case were added.
- **[User, 2026-10-10] A loss can be refunded.** The owner said: "also a loss we can have a refund for it".
  Built on the existing supplier-refund path (§6), so there is one kind of refund, not two. A refund is
  recorded against the loss, from the leg's shipping company or the order's supplier, in any currency.
  It is a ledger inflow and a cost recovery, so it raises profit. Its cap is the loss cost, in EGP,
  counting earlier refunds. It is allowed in any cycle status, as supplier refunds already are. A
  refunded loss cannot be taken back. Found on the way: plain supplier refunds accept a future date
  (rule 1 gap) — fixed in the same task.
  Alternatives: no cap (pays a profit for losing goods); refuse on settled cycles (the money still
  arrives, and §9 records money as it moves).
- **[User, 2026-10-10] A temporary investor sees only their own cycles.** The owner chose this (I asked
  mid-run, which I shouldn't have in autonomous mode — recorded in global learnings). Server-enforced on
  every read path through one scope helper → task R1 (wave 5).
- **[Decided] One meaning of "low stock"** — active + minimum set + on hand below it; no minimum → never
  low. U4 found the dashboard and the inventory page used different rules (rule 11). Inventory follows in
  F1a. Alternative: keep "any batch under 10" (an arbitrary number, and it ignores the minimum the
  partner set).
- **[Decided] The sale idempotency key is stored, not in memory.** U1 kept it in memory for 10 minutes, which
  does not hold on Vercel, where requests land on different instances. It becomes a column on the order,
  unique per user (task U2). Alternative: button-disabling only (fails on a retry after a network drop).
- **[Decided] A negative discount is refused** (`DISCOUNT_NEGATIVE`), on the server. CLAUDE.md rule 1 lists
  negative values among the things to refuse, and a negative discount is a hidden price rise. Task U2.
- **[Release review] CONFLICTS → resolved.** Code: the low-stock rule had four copies (the receiving alert ignored
  "active" and used a different quantity) → task L2 makes one API definition and one pinned web copy. Doc: the
  behaviours the build shipped but the doc did not say are now written in (correcting a delivery, gates re-checked,
  deliveries from planning on, a loss without departure, the old one-date arrival; idempotent order creation; payment
  currency; negative discounts; refund date default and payer; recent activity; R1's two security fixes). The
  pre-existing reservations contradiction (§3 vs §12) is moved to Still open. System-written English ledger reasons
  stay queued (needs a migration). CHEQUE was already restored at the U2 merge.
- **[UI audit] Arabic screens use Latin digits everywhere**, with Arabic month names. Dates already did (U0); `Money`
  followed the browser and showed Arabic-Indic, so one screen mixed "30" with "٣٠" (finding #14). One system: Latin.
  Alternative: Arabic-Indic everywhere (would mean changing dates, inputs and the date picker too, and inputs accept Latin).
- **[UI audit] Dark mode is out of scope.** The app never had a dark theme; the audit confirmed it renders light. Logged.
