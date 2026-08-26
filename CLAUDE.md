# Working rules for this repository

Written 2026-08-22 after a run of bugs that a working feature test would never
have caught: a shop could pay 500 against a 300 balance, money could be
received a month in the future, and a discount larger than the line produced a
sale order totalling **-9,899**.

This is a business that runs on these numbers. A wrong figure here is not a
rendering glitch — it is a partner's settlement, a shop's balance, a landed
cost that decides whether a cycle made money.

---

## 0. Every feature's tests must include attempts to break it

**Standing rule, set by the owner 2026-08-22.** A test file for a new feature
is not finished when it shows the happy path working. It is finished when it
has also tried to abuse the feature and the edge cases are pinned down.

For each new feature, before calling it done, write tests for:

- **The happy path**, once. That is the cheapest part and the least valuable.
- **The limits.** Zero, negative, empty, more than exists, more than is owed,
  longer than the field, a date that has not arrived.
- **The wrong context.** The wrong customer, the wrong cycle, a closed record,
  a draft treated as real, someone else's data.
- **The second time.** Doing it twice, going back and editing, resuming after
  leaving. Most bugs found in this repo lived on the second visit, not the
  first — that is where a form discards edits or a stale cache lies.
- **The interaction the feature changes.** If it prefills a value, test that a
  value the user typed is never overwritten. If it applies money, test what
  happens when there is more of it than is needed.

A feature suite with only happy-path tests should be treated as untested.

---

## 1. Test that the rules cannot be broken, not that the feature works

Every suite here checked that something worked when used correctly. None of
them tried to put the system into a state that makes no sense, which is
precisely how all three bugs above survived.

**Two different tests, and both are needed:**

| Shape | Asks | Catches |
|---|---|---|
| Feature test | does this work when used properly? | broken buttons |
| Invariant test | can I make the system say something untrue? | wrong money |

`apps/web/tests/34-business-invariants.spec.ts` is the home for the second
kind. **Every agreed rule gets a test there.** A rule with no test is a rule
the code may already be breaking — that file exists because five such rules
were.

Before calling a money-touching feature done, deliberately try:

- **Too much.** Pay more than is owed, allocate more than the balance, return
  more than was sold, refund more than the order, discount more than the line.
- **Backwards in time.** Date a payment, an order or a shipment in the future.
  Records of things that happened cannot be dated forward.
- **Negative and zero.** Negative quantity, negative price, zero amount.
- **Things that do not exist.** A customer id that is not a customer. This
  must be a clear 400/404, never a 500 — a foreign key failing deep in Prisma
  surfaces as "An unexpected error occurred", which tells nobody anything.
- **The wrong owner.** One customer's payment against another's order; a leg
  on someone else's cycle. Ownership is checked far less often than amounts.

## 2. A test that passes against the broken code is not a test

**Always confirm a new test fails before the fix, and passes after.** Revert
the fix, run it, watch it fail, restore. This is not ceremony — it has caught
worthless tests repeatedly in this repo:

- A select-on-focus test that used `fill()`, which sets the value outright and
  passed whether the selection happened or not.
- A purchase-row test whose `input[type=number]` selector matched the FX Rate
  field above the items, so it asserted on the wrong element entirely.
- A field-defaults test that started from `0`, where typing `9` makes `"09"`
  and `Number()` turns it back into `9` — passing either way.
- A stale-list test that navigated with `page.goto()`, a full page load, which
  wipes the cache the bug lives in. Only clicking through reproduced it.

The pattern: **the test must reach the screen the way a person does**, and
assert on what they would see, not on what the API returns underneath.

## 3. Validate on the server, always

The UI is one caller. A guard that lives only in a form is not a rule, it is a
suggestion — and every one of these bugs was reachable straight from the API.
Put the check in the service, and let the form use the same wording.

## 4. Fixtures must build states the business recognises

A test fixture that creates an unconfirmed order and calls it debt is testing
something that cannot happen. A draft owes nothing; stock only exists via a
cycle, purchase order, shipping leg and verified receipt. Build it properly —
if that is laborious, that is information about the domain, not a reason to
skip it.

## 5. Do not decide business rules quietly

Where the BRD is silent, **ask or write it down as a guess** — do not pick and
move on. The overpayment behaviour was mine: I decided a surplus should be
kept as credit, wrote a test asserting it, and shipped a rule nobody agreed to.
The owner's reaction was that it "is not logical", and he was right.

Decisions live in `docs/business-rules.md`, dated, with open questions marked
open. If a rule reaches code before it reaches that file, it is a guess wearing
a uniform.

## 6. Never run the test suite against data being used

`globalSetup` snapshots the developer's database, reseeds, and restores. It is
not a licence to run tests while someone is entering real records: a failed run
once left the seeded state behind and the next run snapshotted *that* over the
only copy, and a morning's data entry was lost for good. Ask first.

## 7. Check the data, not only the code

Guards stop new bad records; they do nothing about what is already stored.
`scripts/check-data.sh` looks for records the business could not have produced
— money dated forward, a batch holding more than it received, an order worth
less than nothing, ledger rows pointing at things that were deleted. Every
count should be zero.

Run it after a data fix, after restoring a backup, and whenever a figure on
screen looks wrong. It found five orphaned ledger rows that a cleanup of mine
had left behind, which no test would ever have noticed.

## 8. Resetting the database

`npm run db:reset` rebuilds it from nothing at three levels:

| Level | Contains |
|---|---|
| `db:reset:minimal` | partner logins, money accounts, FX rates |
| `db:reset` (default) | the above plus two each of category, supplier, shipping provider, product and customer |
| `db:reset:demo` | the full worked example with cycles, sales and settlements |

The reference level is the one for manual testing: everything needed before a
cycle can be started, and nothing that a test would be about. No cycles,
orders or payments — those you create yourself.

It backs up first, and runs the consistency check afterwards. Every seed is
idempotent, so running one twice changes nothing.

The API caches its database connection, so restart it (`npm run dev`) after a
reset or it will keep talking to the database that no longer exists.

## 9. Refusals carry a code; the client says them

Nothing user-facing is written in English inside a service. A refusal names
itself with a stable code and the web app translates it, because the API cannot
know which language the reader chose and the app already does, from the URL.

```ts
throw badRequest('NOT_ENOUGH_STOCK', `Only ${available} of ${name} is in stock.`, {
  available, product: name,
});
throw notFound('purchaseOrder');   // one code for all 57 of these
```

The English argument is not optional and is not decoration: it is what the logs
record, what the tests read, and what a client falls back to for a code it has
never heard of. Drop it and a new refusal shows an empty toast.

Adding a code means adding it to `errors` in **both** `en.json` and `ar.json`.
`41-error-messages` fails if a thrown code has no translation, or if a
translation survives a code that nothing throws any more.

Two things that look right and are not:

- **Never branch on the message text.** `/still holds|remaining/.test(message)`
  stops matching the moment the reader is on Arabic. Branch on `error.code`.
- **`err.response.data.message` is always undefined.** The body is
  `{ error: { code, message, params } }`. Thirty-six call sites read one level
  too shallow, so every refusal fell through to a generic fallback and the API's
  explanation reached nobody — with a toast still appearing, so nothing looked
  broken. Use `useApiError()`, never reach into the response by hand.

## 10. A number nobody entered is still a number

`resolveShares` used to return all-zero shares for a cycle nobody had funded.
That reads as harmless — nothing to split, so split nothing — and it was not.
Every line then rounds to zero except the last, which absorbs the rounding
residual, so the whole profit landed on whichever participant happened to be
created last. Three equal partners, 90,000 of profit, answer 0 / 0 / 90,000.

The test guarding that path passed a profit of **zero**, so every line was zero
whatever the shares were. It only ever proved the code did not divide by zero.

- When a calculation has no valid basis, refuse. Do not return a neutral-looking
  value and let rounding decide who gets the money.
- Test a distribution with a non-zero total. Zero hides every share bug there is.
- If a figure is required for a later step to be correct, ask for it in the flow
  that produces it. Contributions lived on a different page from the wizard, so
  they were a step you could finish without — and nothing said so until
  settlement, weeks later.

## 11. One rule, one definition

`CAPITALISED_CATEGORIES` — the ledger categories that are not operating
expenses — existed twice, once in the settlements service and once in analytics.
Adding `contribution` to one and not the other meant handing a partner their
capital back was charged against the dashboard's net profit as an expense, while
the settlement itself had it right. The same question, asked twice, answered
differently.

It lives in `apps/api/src/common/ledger-categories.ts` now, imported by both.

- A rule the business states once should be written down once. Two copies drift
  on the first change, and the drift shows up as a wrong figure on one screen
  and a right one on another — which reads as a display bug, not an arithmetic
  one, and gets looked for in the wrong place.
- When adding a ledger category, ask what it is NOT: not income, not an expense,
  not a cost recovery. Money moving is not the same as money earned or spent.

## 12. Being logged in is not being allowed

`POST /auth/register` had no guard and the caller chose their own role, so
anyone who could reach the API could make themselves a CORE_PARTNER. Settlements,
sales, payments and ledger carried no `RolesGuard` at all, so any account —
including a temporary investor's — could approve a settlement or reverse a
ledger entry.

- Every endpoint that moves money names the roles allowed to call it. The guard
  defaults to allowing when no roles are set, so silence means open.
- A refusal from the guard throws a coded error like any other. Returning
  `false` gives Nest's bare "Forbidden resource", which carries no code and
  cannot be translated.
- Test both directions: that the wrong role is refused, and that the right one
  still works. A guard that refuses everybody passes half a test suite.

## 13. A form must not be a dead end

Adding a product needed a category that did not exist yet, and the only way to
get one was to abandon the half-filled form, go to Categories, create it, come
back and start again. The same dead end sat behind every picker in the app.

`FieldWithQuickCreate` puts a `+` beside the field. It opens **the entity's own
create form** — the same one its tab shows — saves it, refreshes the list the
picker reads, and selects it, leaving the form underneath untouched.

The form is defined once in `components/entities/entity-forms.tsx` and rendered
in both places. The first attempt gave quick-create its own cut-down fields, and
that is a second definition of a form that already exists: add a field to
Customers and the `+` beside a sale quietly keeps making customers without it.
A new picker is one entry in that registry, not a modal copied into a page.

Four things that are easy to get wrong, and all of them were:

- **The trigger sits inside another form.** A bare `<button>` defaults to
  `type="submit"`, so reaching for a category would save the half-filled
  product. Every button inside a form states its type.
- **The modal has to leave the tree.** Rendering it where it sits puts a
  `<form>` inside a `<form>` — invalid markup, and the inner submit bubbles to
  the outer one. It portals to `document.body`.
- **Refetch before handing the id back.** Select an id the picker's list does
  not yet contain and the field renders blank: created, and apparently not.
- **Clear the selection on every close path, not just on success.** Cancel left
  the last choice behind and the next record opened already filled in. Route
  open and close through one helper rather than calling the setter at each site.

Not every picker should have one. A cycle is built by a four-step wizard and has
no honest minimal form; a category's own parent picker is already inside the
category form. A `+` that creates a half-formed record is worse than the detour.
