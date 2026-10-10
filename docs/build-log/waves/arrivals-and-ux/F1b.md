# F1b: the wizard ends at "in transit"; the cycle list shows profit

Branch `feature/arrivals-f1b`, based on `c292c78`. Code commit `b872190`, plus this log.
Rules: BUSINESS_LOGIC §1 and §15 (DECIDED 2026-10-10). Spec UX #5, #7 and the quick wins.

## What finishing does now

Step 4 "Receive Inventory" is gone. Step 4 is the money step (contributions, add an investor).
**Finish** saves any contributions typed but not saved. It then reads the cycle fresh, asks
`statusesToWalk` (`components/cycles/wizard-walk.ts`) which transitions the recorded dates allow,
posts them in order, and opens `/cycles/:id/details`.

| Recorded | China cycle ends at | UAE-direct ends at |
|---|---|---|
| no dates | PURCHASING, order DRAFT (§15) | PURCHASING, order DRAFT |
| leg 1 departed | IN_TRANSIT (order CONFIRMED) | IN_TRANSIT_TO_EGYPT (via ARRIVED_UAE) |
| leg 1 has a delivery | ARRIVED_UAE | — |
| last leg departed | IN_TRANSIT_TO_EGYPT | — |
| last leg has a delivery | ARRIVED_EGYPT | ARRIVED_EGYPT |

A delivery is read from the leg's derived status (PARTLY_ARRIVED / ARRIVED). The arrival dates
typed on step 3 become deliveries through B2's `PUT` and `POST` leg compatibility path. The
wizard never asks for VERIFICATION or SELLING and never calls `/receipts/verify`. A refused
step stops the walk, shows the translated refusal, and keeps the wizard open. A cycle already as
far as its dates go is not moved.

## Other changes

- **Resume** reads every order and every leg. A resumed cycle with orders shows each one
  read-only on step 2: reference, supplier, date, status and lines. The old form silently
  dropped edits to a saved order. Legs are matched by sequence, and a new leg's piece count is
  seeded from all orders. A cycle past ARRIVED_EGYPT opens on its details page instead of the
  old success screen.
- **Step 2**: the order date is Cairo's today (`businessToday`, `disableFuture`, controlled).
  The order starts with one item row. The FX rate is controlled now, so it survives Back.
- **Step 3**: dates stay optional, and both pickers use `disableFuture`. Unsaved leg fields
  (only the ones that differ from what the form opened with) are kept per cycle in the draft
  store (`legFields`) and cleared when the legs are saved. Going back, or leaving for the list
  and clicking back in, keeps them. Hardcoded "Departed On / Arrived On / (Optional) / … cost /
  Current rate" are translated.
- **Removed**: the receive rows, landed-cost seeding, "Already received" panel, the client-side
  "not arrived" refusal, the success screen, and `receiveItems` and `shipping*` from the draft.
  The draft's `draftIsWorthKeeping` now counts a row only once a product is chosen.
- **Cycle list**: Profit and ROI columns (and on the phone cards) come from
  `GET /analytics/cycle-profitability`, the Analytics page's figure, joined by cycle code. A
  dash shows where the figure has no row (nothing received) or no ROI. The first chip reads
  "All". "Click to resume", "Resume" and "Tap to resume" are translated, and so are the toasts.
  Statuses (cycle, order, leg) go through `useCodeLabel`; before, they showed raw keys like
  `purchasing`. `EmptyState` shows when there are no cycles (with New Cycle) and when nothing
  matches. `WIZARD_STATUSES` is defined once in `wizard-walk.ts` and read by both the list and
  the wizard.
- Locale keys under `wizard` / `cycles` only, in en and ar (parity checked). Wizard keys that
  nothing reads any more were removed.

## Tests

- Vitest `CycleWizard.test.tsx`, 21 cases. They cover finishing with no dates (FUNDING,
  PURCHASING only, no receipts call, navigates to details), a departure, deliveries on both
  legs (ARRIVED_EGYPT at most), a departed leg with no delivery, finishing a second time (no
  calls), a refused step (stops, says why, stays), double-click, and no Receive step. Four
  pure `statusesToWalk` cases. Resume with two orders and two legs shows both. Piece count
  from every order. SELLING redirects. The order date is Cairo's today at 23:30 UTC, with one
  row. A typed qty and FX survive Back. A typed tracking ref survives Back, unmount and
  remount, and is cleared on save. An untouched form keeps nothing.
- Revert checks (each failed, then passed once restored). Walk ignoring dates: 8 fail.
  Snapshot off, first order only, UTC date, uncontrolled FX: 6 fail. Removing the
  `isFinishing` guard alone did not fail the double-click test, because the disabled button
  already blocks the second click. The guard is kept as a second line.
- `npm run test:unit`: vitest 107/107, node 43/43. Typecheck clean. Lint: no errors in
  F1b files. Suppressions for the wizard and list were pruned (counts fell). The 3 remaining
  lint errors are `no-explicit-any` in `tests/81-deliveries-and-losses.spec.ts` (B2's, untouched).
- Playwright, **written, not run**: `tests/80-wizard-ends-in-transit.spec.ts`, 10 cases. Finish
  with no dates through the whole wizard by clicking leaves PURCHASING with a DRAFT order, and
  the list shows Purchasing. A departure gives IN_TRANSIT and CONFIRMED. Arrival dates give
  ARRIVED_EGYPT with no batches. Finishing twice moves nothing more. Leaving at step 3 and
  clicking back keeps the tracking ref and date. Two orders are shown on resume. Profit and ROI
  match the analytics figure. A dash with nothing sold. Arabic shows "All" and translated
  resume and status words. An empty search says so.
- Existing specs changed only where step 4's removal changed them:
  - `17` TC-COST-05: no "Add item" click (the order starts with one row; a second empty
    required row would block the submit).
  - `29` TC-RT-08: no "Already received"/"Done". Finish now opens details and the cycle stays
    ARRIVED_EGYPT. Stock is still received through the API fixture.
  - `40` TC-I18N-05: the English title list has "Funding" in place of "Receive Inventory".
  - Read and left alone: `02`, `38`, `39`, `44`, `47` (extra old draft fields are ignored),
    `48` (funding is still step 4).

## Guesses (open until confirmed)

1. **UAE-direct with no departure stays PURCHASING.** The machine only lets UAE-direct leave
   PURCHASING through ARRIVED_UAE, which the server does not gate. The wizard waits for leg 1's
   departure before taking it, so "no dates → PURCHASING, order DRAFT" holds for both origins.
2. **Finishing saves typed contributions** rather than dropping them. Same rule as the form.
3. **A saved order is shown read-only on resume.** Adding or editing lines on a saved draft
   order is left to the Purchases page.
4. **The list's profit is joined by cycle code**, because the analytics row carries no id.
5. **Resume stays offered up to ARRIVED_EGYPT**, as before. Past it, the wizard sends the
   reader to the details page.
6. **"Cycle page" means `/cycles/:id/details`**, where F1a puts the Shipment panel.
