> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 14. What "when stock arrived" means  — DECIDED 2026-09-09

**Two dates, shown separately on inventory and on the product page.**

| shown as | is | source |
|---|---|---|
| **Arrived** | when the delivery that brought this batch landed in Egypt | the batch's own delivery date (until 2026-10-10: the cycle's last dated leg) |
| **Received** | when it was verified into stock and became sellable | the batch's own creation |

They are routinely days apart — the reference seed has them five days apart —
and the gap is the useful part: a wide one is stock that sat somewhere before
anybody booked it in. Collapsing them into a single "arrived" would hide
exactly that, so both are shown.

**Arrived is the last leg, not the first.** A CHINA cycle runs
China → UAE → Egypt, and leg 1 arriving is a box in a Dubai warehouse, not
stock a shop can buy. Reading `shippingLegs[0]` would look correct against
every UAE_DIRECT cycle and be wrong for every China one — which is most of the
business. TC-ARR-02 pins this with a two-leg cycle whose legs are dated three
weeks apart.

**Arrived is reliable, not hopeful.** The API already refuses to advance a
cycle whose leg carries no arrival date (`LEG_NOT_ARRIVED`), so stock cannot be
received from an undated leg at all. The screens still handle a null — a cycle
with no legs, or data predating that guard, reaches the same place — and say
"Not dated" rather than showing a dash, because a dash reads as "no data" when
it means "nobody entered it yet". TC-ARR-03 pins the refusal.

Both screens read the same `/inventory` endpoint, so there is one definition of
arrival rather than two (rule 11). TC-ARR-05 asserts they agree.

**DECIDED 2026-10-10 — each batch has its own arrival.** *Built 2026-10-11 (B3).* With
deliveries (§1), Arrived is the date of the delivery that brought the batch into
Egypt, not the cycle's last leg date. Two batches of one product from one cycle
can show two dates. Still the last leg, never the first.

---

