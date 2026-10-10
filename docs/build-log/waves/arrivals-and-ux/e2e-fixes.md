# E2E fixes after the arrivals + UX batch

Branch `fix/e2e-after-arrivals`, cut from `e05e8d7`. The full Playwright run on master had 44
failures. Each one is classed below as a **product bug** (the code was fixed) or an **outdated
test** (the test was moved to the decided behaviour, with a reason in the test). No test was
deleted or skipped.

## Product bugs (4)

| Cause | Fix | Evidence |
|---|---|---|
| **Mark lost dropped a quick click.** The confirm step ignored any submit within 400ms of Continue, but the button stayed enabled. A click that came too soon did nothing and showed nothing. | `MarkLostDialog`: the confirm button arrives disabled and enables itself after 400ms. Unit tests click it once it is enabled, and the double-click case checks that it is disabled. | 85 TC-SHP-01/07/08/13 failed, and no POST reached the API. After the fix, 85 passes 14/14. Vitest 22/22. |
| **A reloaded `/cycles/new` lost its draft (dev StrictMode).** The restore effect marked itself done before its cycle check answered. StrictMode runs each effect twice. The cleanup cancelled the first check, and the second run returned early. | `CycleWizard`: the cleanup un-marks the restore. Added a new unit case that renders under `<StrictMode>`. | Debug run: the draft was still in localStorage after the reload, there was 1 `GET /cycles/:id`, and the banner did not show. After the fix: banner and step 2 show. 39 and 47 pass 12/12. The unit case fails without the line and passes with it. |
| **The shipments page hid legs.** It searches and pages on the client, but it fetched the API's default 20 legs, ordered by `cycleId`, which is a random uuid. Once there were more than 20 legs, a new cycle's legs could be missing, and searching its code found nothing. | Web: fetch `limit: 200`, the API maximum, the same as the suppliers page. API: order legs newest cycle first, then `cycleId`, then `sequence`. | 85 TC-SHP-12 and 90 TC-CAT-02 failed only after other specs had created legs. Running spec 81 first reproduced it (1 failed). After the fix: 29/29. |
| **TC-RECENT-09 clicked too fast** *(test, not product)*. It clicked Dashboard while a cold `/customers` was still compiling, so the dashboard never remounted. | The test waits for each URL before the next click. | Cold-server trace: 1 recent-activity request, and the customers RSC was fetched but never shown. Fails on a cold server before the change and passes after. |

## Outdated tests (moved to the decided behaviour)

| Group | Cause | Fix |
|---|---|---|
| A — 89 (5), 90 (6) | Each new cycle starts with all active core partners on it (§8), so adding the partner afterwards was refused with `ALREADY_A_PARTICIPANT`. Spec 90's leg also left from `<tag> Dubai`, which `UAE_DIRECT_LEG_ROUTE` refuses. Spec 90 never passed. | Name the participants when creating the cycle; the doc says this overrides the default. The leg now leaves from `<tag> Dubai, UAE`. |
| B — 81 DL-60, 84 LR-31, 88 UR-08 | Since the portal fence (2026-08-30), registration only offers office roles. A shop owner's real token is a portal one, and the office API refuses it with `WRONG_SURFACE`. | One shared `refusedCallers()` in `support/fixtures.ts`: an investor gets `ROLE_NOT_ALLOWED`, the seeded shop owner's portal token gets `WRONG_SURFACE`. It replaces three copies of `accountWithRole`. |
| C — 73 SHIP-03 | R1: an investor gets 404 outside their own cycles. | SHIP-03 keeps the 403 for ADMIN_SUPPORT. The new SHIP-03b checks that an investor not on the cycle gets 404 `NOT_FOUND` for the cycle. Spec 87 covers an investor on the cycle getting 200. |
| D — 75 RECENT-05 | The fixture paid a customer who owed nothing, which is refused with `CUSTOMER_OWES_NOTHING`. | Create an owed order of 240 first. |
| E — 19 UI-09/12/14/15/17/18 | U2's payment form changed: the date starts on today and refuses future days, there is no currency picker, and the method list has 4 entries (which gets a search box). | UI-09 uses a new purchase order's ordered date, which still starts empty. UI-12 walks left instead of right. UI-14 to UI-18 use the ledger entry's three-currency Select (EGP, then type PURCHASE). |
| F — 40 I18N-03 | F1b's `wizard.orderLine` is `{qty} ×` in both locales, so there is nothing to translate. | A value identical to the English counts as untranslated only if it contains letters. |
| F — 51 QC-07/08/09 | Since U2, a payment settles what is owed. A customer created on the spot owes nothing, so the payment form has no customer `+` (rule 13). | QC-07 drops payments/customer. QC-08/09 use New Order, which has the `+`. |
| G — 74 "More the second time" | **Not a bug.** The failure screenshot shows the drawer open. Settings, at the foot of the drawer, is scrolled out of view because the menu has outgrown a 390×844 screen. | The test checks Suppliers instead, which the open drawer shows. |
| H — 76 CC-10/12 | On a phone, `openSales` picked the sidebar link inside the off-screen drawer. Playwright counts it as visible, so the click timed out with "outside of the viewport". | On a phone the test taps the bar's Sales link (U3). |
| H — 77 DASH-06/07 | The "Cancel" locator also matched the sales list's "Cancelled" filter chip, which comes first in the DOM, under the portalled form. | Match `exact: true`. |
| H — 77 DASH-10 | R1: an investor sees "Your cycles" and no business tiles. | Assert `your-cycles` is shown and no `tile-*` element exists. |

## Results

- Final group runs: `00–19`: 199 passed, 1 skipped. `35–54`: 141 passed. `55–79`: 225 passed (with
  the storefront on 3002). `80–99`: 124 passed. Groups 1 and 3 ran before the shipments fix. Every
  spec that touches the shipments list (12, 13, 15, 17, 50, 78) was run again afterwards: 64 passed.
- Web: Vitest 214/214, node 84/84, lint 0 errors (45 warnings, unchanged), typecheck clean.
  API: jest 806 passed + 9 skipped, lint and typecheck clean.

## Still open

- Other list pages also fetch the API's default page and then search on the client. Purchases,
  products and providers all call `api.get('/x')` without a limit. Same bug shape as the shipments
  page; each one depends on how its service orders and caps the list. Not changed here.
