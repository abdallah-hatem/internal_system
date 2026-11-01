> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 22. Exchange rates  — DECIDED 2026-10-16 (owner asked for the page), details GUESSED

The owner, entering a past cycle with AED, CNY and USD, needs to see and set
the rates the forms start from. An office page, **Exchange rates** (`/fx-rates`),
at the foot of the menu beside Audit Logs and Settings.

| Question | Rule | Status |
|---|---|---|
| What it shows | Every currency, its rate to EGP (to four decimals) and when it last changed; "no rate yet" for a currency without one. One line: these rates only prefill forms — every order, payment and receipt keeps the rate it was recorded at, so a change here restates nothing. | DECIDED |
| Who | Every office role reads it (`GET /currency-rates` names no roles; the forms of every role prefill from it). Only a core partner changes a rate or adds a currency (`PUT`/`POST`, `@Roles('CORE_PARTNER')`). | GUESS |
| Changing a rate | `PUT /currency-rates/:code`, only for a currency already on the page (404 otherwise, so a typo in a URL makes no currency). Above zero, at most four decimals; EGP is fixed at 1. `null` still means "no rate known". | DECIDED |
| Adding a currency | `POST /currency-rates` with a three-letter code (upper-cased) and a rate, the same rules. A code already there is `CURRENCY_EXISTS`, also when two adds race. | GUESS (no removing a currency: one may be named by old records) |
| One definition | `common/fx-rate.ts` — the code and rate checks, shared with a friend's payment in his own currency (§18). | DECIDED |

