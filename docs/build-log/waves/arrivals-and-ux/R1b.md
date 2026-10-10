# R1b — An investor reads; they are offered nothing to act on

Branch `fix/r1b-investor-ui`, from `4c5e1ab`. Code commits `fbb2784` (api) and
`8ae7cff` (web). Follows R1's "Left for others" and the owner's decision
(2026-10-10, BUSINESS_LOGIC roles): a temporary investor sees only their own
cycles, and reads rather than acts.

## One map of who may act

`apps/web/src/lib/permissions.ts` — `ACTION_ROLES`, each action copied from the
`@Roles` on the endpoint it calls, and `can(role, action)`. `lib/can.ts` is the
hook, `useCan(action)`. An unknown or still-loading role may do nothing.

`apps/web/unit/can-roles.test.mjs` (node:test, in `test:unit`, the same shape as
`nav-roles.test.mjs`) reads each endpoint's decorators out of the controller
and fails when the map differs, or when an endpoint has no RolesGuard. Revert
check: `settlement.pay` widened to admin support → that case fails.

| Action | Endpoint | Roles |
|---|---|---|
| `cycle.create` | `POST /cycles` | CORE_PARTNER |
| `cycle.transition` | `POST /cycles/:id/transition` | CORE_PARTNER |
| `cycle.addParticipant` / `editParticipant` | `POST /cycles/:id/participants`, `PUT /cycles/participants/:id` | CORE_PARTNER |
| `shipment.recordDelivery` / `deleteDelivery` / `markLost` / `takeBack` / `recordRefund` | `/shipping/...` | CORE_PARTNER |
| `shipment.undoRefund` | `POST /purchases/refunds/:id/reverse` | CORE_PARTNER |
| `inventory.receive` | `POST /receipts/verify` | CORE_PARTNER |
| `settlement.calculate` / `approve` / `pay` / `reverse` | `/settlements/...` | CORE_PARTNER |
| `users.list` | `GET /users` | CORE_PARTNER, ADMIN_SUPPORT |

## Hidden

- **Shipment panel**: record delivery, mark lost, receive into stock, delete
  delivery, record refund, undo refund, take back, "Move to Arrived Egypt".
  Every count, delivery, loss and refund still shows.
- **Cycle details**: add participant and split equally (contributions).
  `GET /users` is asked only when the picker can be offered, so an investor's
  cycle page no longer gets a 403.
- **Settlements**: calculate (and its cycle picker, whose `GET /cycles` is no
  longer fetched), approve, mark paid, reverse.
- **Inventory**: the "Receive stock" toggle and list.
- **Cycles list**: New Cycle (header and empty state), the transition button in
  the phone slide-over; a cycle still in a wizard status opens its details, not
  the wizard. `/cycles/new` and `/cycles/:id` (the wizard) are wrapped in
  `WizardGate`, which sends a role that cannot write to the list or the details.

These follow the endpoints, so admin support loses the same buttons — every one
of these writes was already CORE_PARTNER only.

## Rule 9 — params that are codes

`ledger.service.ts` sent `owner: 'sale return'`. It sends `owner: 'SALE_RETURN'`.
The sweep (a TypeScript-AST pass over every `badRequest/conflict/forbidden`
call's params in `apps/api/src`) found one more: `DATE_IN_FUTURE` sent
`label: 'A departure date'` (seven phrases). `assertNotFuture` now takes a code
from `DATE_FIELDS` in `common/dates.ts` (`CYCLE_START`, `PAYMENT_RECEIVED`,
`ORDER_PLACED`, `REFUND_RECEIVED`, `DEPARTURE`, `ARRIVAL`, `DELIVERY`); the
English phrase stays in the message only.

Web: `resolveApiError` takes an optional `codeLabel`, and `PARAM_KINDS` names,
per refusal, which params are codes and which `codes.<kind>` says them —
`owner` → `referenceType`, `label` → the new `dateField` kind (en + ar), and the
cycle/settlement/order statuses that `BAD_STATUS_TRANSITION`,
`CYCLE_STATUS_CHANGED`, `CYCLE_NOT_ARRIVED`, `CYCLE_STATUS_BLOCKS_PO`,
`CYCLE_FINAL_NO_LEGS`, `SETTLEMENT_LOCKED` and `ONLY_CONFIRMED_RETURNABLE` put
raw (`SELLING`) into Arabic sentences. `useApiError()` passes `useCodeLabel()`.

## Lint

`eslint . --prune-suppressions` in both apps: counts only went down. The API's
one unused `eslint-disable` (`files/storage.ts`) is gone. Both apps: 0 errors.

## Tests

- `unit/can-roles.test.mjs` — 21 cases (map ↔ `@Roles`, investor none, partner
  all, unknown role none).
- `src/lib/investor-readonly.test.tsx` (Vitest, 8) — panel, settlements and the
  cycle page, investor and partner on the same data; the investor never asks
  `/users` or `/cycles`. Against the pre-fix pages, the 5 investor cases fail
  and the 3 partner cases pass.
- `src/lib/api-error.test.ts` (Vitest, 6) — the Arabic sentence says «مرتجع
  بيع», no raw status survives a transition refusal, `dateField` matches the
  API's `DATE_FIELDS` read from source.
- `src/common/refusal-params.spec.ts` (jest, 11) — the ledger refusal sends the
  code for four owners; each date field sends its code. With the old ledger
  line restored, the four owner cases fail.
- The three shipment Vitest files now mock a core partner's auth.
- `tests/89-investor-readonly.spec.ts` (Playwright, **not run**): investor opens
  their cycle and settlement by clicking — no action buttons, no participant
  form, no `GET /users`, no 403/5xx; partner on the same records still sees
  them; investor has no Receive stock / New Cycle, and the wizard URLs send them
  back.
- web: test:unit Vitest 186 + node 66 pass, lint 0 errors, typecheck clean.
  api: jest 800 passed (9 skipped), lint 0 errors, typecheck clean.

## Guesses

- Admin support also loses these buttons (they follow `@Roles`).
- A cycle in a wizard status opens its details for an investor; the wizard URL
  redirects rather than showing a refusal.
- `VALIDATION_FAILED`'s `fields` (field identifiers) and `BAD_PARTICIPANT_TYPE`'s
  `value` (what was sent) were left as they are — identifiers and echoes, not
  English words.

## Left for others

- The catalogue pages an investor can open still offer partner-only writes:
  products, categories, suppliers, providers (create/edit/delete), purchases
  (new order, record refund), shipments (new leg, edit leg). Each is
  CORE_PARTNER on the API; they need entries in `ACTION_ROLES` and `useCan` at
  each button.
- Settlement `warnings` are English sentences from the service (rule 9).
