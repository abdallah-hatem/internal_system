# U4c — The audit log is open to every role; the menu ignores roles

Branch `fix/roles-audit-and-menu`, from `2e40a7e`. Code commit `e1309a5`.

## The audit log

`AuditController` now carries `@UseGuards(AuthGuard('jwt'), RolesGuard)` and
`@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')` at class level, so both
`GET /audit-logs` and `GET /audit-logs/:id` refuse a temporary investor with
403 `ROLE_NOT_ALLOWED` (the guard's own coded refusal, already translated).
A shop token never reaches it: `SurfaceGuard` refuses portal tokens on office
routes before any controller guard runs.

**Why admin support:** it is the role that already reads sales, payments, the
ledger, settlements and recent activity. An audit row is the same books in
another shape. Written down, dated, in `docs/BUSINESS_LOGIC.md`.

## The menu

Each entry in `nav-model.ts` carries the roles of the endpoint its page lists
from, copied from the controllers; nothing was invented.

| Entry | Endpoint | Roles |
|---|---|---|
| dashboard, analytics | `/analytics/dashboard`, `/analytics/revenue-by-month` | all (no guard) |
| cycles, purchases, suppliers, shipments, providers | `/cycles`, `/purchases`, `/suppliers`, `/shipping/legs`, `/providers` | all (no guard) |
| products, categories, inventory | `/products`, `/categories`, `/inventory` | all (no guard) |
| customers, paymentPlans | `/customers`, `/payment-plans` | all (no guard) |
| notifications, settings | `/notifications`, `/auth/profile` | all (no guard) |
| orderRequests, importRequests, sales | `/order-requests/pending`, `/import-requests`, `/sales/orders` | CORE_PARTNER, ADMIN_SUPPORT |
| payments, ledger, partners, settlements, auditLogs | `/payments`, `/ledger`, `/users/participation`, `/settlements`, `/audit-logs` | CORE_PARTNER, ADMIN_SUPPORT |

So: core partner and admin support see all 22; a temporary investor sees 14,
and the Partners group disappears. Their phone bar is Dashboard, Customers,
Inventory, Cycles, More. Every role keeps Dashboard and Settings. The sidebar,
the phone bar and More all read `navForRole` / `phoneBarItems`, unchanged.

`unit/nav-roles.test.mjs` reads `@Roles` and `RolesGuard` straight out of the
API controller source for each entry's endpoint and compares, so a controller
changed without the menu fails a unit test (rule 11).

## Rule-12 findings (not fixed — other controllers)

Office endpoints with no `RolesGuard`, so readable by a temporary investor:
`/analytics/dashboard|revenue-by-month|top-products|cycle-profitability`
(revenue, cash on hand, profit), `/customers` (every shop and balance),
`/payment-plans` and `/payment-plans/overdue`, `/returns`, `/costing/...`,
`/cycles`, `/purchases`, `/suppliers`, `/providers`, `/shipping/legs`,
`/products`, `/categories`, `/inventory`, `/currency-rates`, `/files`.
Write routes on those are guarded; the reads are not. Whether an investor
should see customers and payment plans is marked *Open* in the business doc.

## For U4

The dashboard's activity panel still reads `/audit-logs?limit=5`; an investor
now gets 403 there (silently — the list stays empty, no toast). Switching it to
`/analytics/recent-activity` (also partner/support only) and hiding the panel
for an investor is U4's. `78-menu-by-role` allow-lists exactly those two URLs.

## Tests

- `apps/api/src/modules/audit/audit.controller.spec.ts`, 13 cases: list and one,
  investor and shop refused with 403 `ROLE_NOT_ALLOWED`, an unknown role and no
  user refused, core partner and admin support let through, the guard attached.
  Revert check: `@Roles` removed → 8 fail; restored → 13 pass.
- `apps/web/unit/nav-roles.test.mjs`, 33 cases: every entry's roles equal its
  endpoint's; 22 for partner and support; the investor's exact 14; the hidden
  set; the emptied group gone; the investor's bar; shop sees nothing
  restricted; Dashboard and Settings for every role; unknown or loading role;
  bar ⊂ menu for every role. Revert checks: nav-model without roles → 13 fail;
  `@Roles` removed from the audit controller → the `auditLogs` case fails.
- `apps/web/tests/78-menu-by-role.spec.ts` (Playwright, **not run**): investor's
  sidebar is exactly the 14; each opened by clicking with no 403; each hidden
  page's endpoint refuses an investor with the code; audit log both directions;
  admin support sees 22 and opens the restricted ones with no 403; phone bar
  and More for an investor; core partner still 22.
- api jest 446/446, lint 0 errors, typecheck clean. web test:unit (Vitest 20,
  node 43) pass, lint 0 errors, typecheck clean.

Nothing started by this task is still running.
