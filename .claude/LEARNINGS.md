# Learnings

Corrections recorded so they don't have to be repeated. Loaded at session start.

## Interface

- Never a native `<select>`, `<option>` or browser date picker. Use the shared
  `components/ui/select.tsx` (Radix Popover + cmdk) and `date-picker.tsx`. The owner
  rejected the native controls once for the admin panel and again when an agent used a
  native dropdown in the storefront. The shared one is also searchable and carries a hint
  line, which `<option>` cannot. — 2026-08-30
- Every clickable element gets `cursor: pointer`. Tailwind v4's preflight dropped it, so a
  scaffolded project has arrows on every button. Put it in `globals.css` as a base rule over
  `button, a, summary, [role=button]…`, never as a class per element — the class is what
  gets forgotten on the next button. — 2026-08-30
- A permission or capability the person cannot use yet gets steps, not a sentence saying
  they cannot. "Add it to your home screen first" is true and reads as a refusal; four
  numbered steps with the share icon shown is a way in. Steps differ per browser, so name
  the browser. — 2026-08-30

## New apps in this product family

- Copy the conventions, do not re-derive them. The storefront was scaffolded fresh and so
  arrived without the cursor rule, without the shared Select, and with its own weaker copy
  of `api-error.ts` that trusted `t()` to throw on a missing key — next-intl returns the key
  path instead, so `errors.SOME_CODE` would have reached a customer's screen. Port the file;
  do not write a shorter one. — 2026-08-30

## Migrations and the test harness

- Never run `prisma migrate` while the Playwright suite is running. `globalTeardown` restores
  with `pg_dump --clean`, which is a schema-level rollback: it drops the new column and the
  `_prisma_migrations` row with it, and every request touching that column then 500s.
  — 2026-08-30

## Editing by script

- Assert the specific outcome, never `file != before`. A multi-part `str.replace` where one
  part silently fails to match still changes the file, so the aggregate assert passes and the
  edit looks done. Assert on the thing being removed or added — and pick a marker that does
  not also appear in the prose you just wrote (`</select>`, not `<select>`). — 2026-08-30

## The storefront (apps/storefront)

- Arabic is the default locale there, not a translation of an English app. Logical
  properties only — `ps-`/`pe-`/`ms-`/`me-`/`text-start`. — 2026-08-30
- "Default" means the fallback, not what most people get. next-intl honours
  `Accept-Language`, so a phone set to English lands on `/en` and only a browser with
  no preference we publish gets `/ar`. Whether that is wanted is open — see
  `docs/business-rules.md` §13. `localeDetection: false` is the switch. — 2026-08-31
- Only `/portal/*` and `/auth/portal/*` are reachable. A 403 `WRONG_SURFACE` means this app
  asked for something the office owns — fix it here, not by widening the API. — 2026-08-30
- Read `err.response.data.error.code`; `data.message` is always undefined. `lib/api-error.ts`
  is copied verbatim from the admin panel — do not write a shorter version, next-intl returns
  the dotted key path rather than throwing on a missing key. — 2026-08-30
- Images on `/portal/imports/**` need the bearer token, so a plain `<img src>` 401s. Fetch as
  a blob through the axios client and revoke the object URL on unmount. Catalogue images are
  public and do not need this. — 2026-08-30
- The two apps are separate origins, so a token stored by one is invisible to the
  other. That is correct, not an inconvenience. — 2026-08-30

## Configuration that fails silently

- A missing secret is not a crash, it is a forgery. `configService.get('JWT_SECRET')!`
  with nothing set makes @nestjs/jwt sign and verify with `undefined`: every login works,
  every request is authorised, and any token is forgeable. Neither end looks wrong. Check
  values like this at boot and refuse to start — `common/jwt-secret.ts`. The same shape
  applies to any config read with a `!`. — 2026-08-30
- Match placeholders on the value with case and punctuation stripped, not the literal
  string. The first list stored `change_me_in_production`, so the hyphenated spelling
  missed it entirely and a 40-character placeholder would have been accepted. Its own
  test caught that. — 2026-08-30

## Claims about security

- Verify before repeating an alarming claim. I told the owner several times that the JWT
  secret was committed to a public repo. It never was — `.env` has never been tracked and
  the value is nowhere in history. The claim came from an earlier session's notes and I
  passed it on as fact. `git log --all -S "<value>"` is two seconds and settles it. An
  invented emergency spends the owner's attention on nothing and hides the real backlog.
  — 2026-08-30

## Moving a repo in with subtree

- `git log -- apps/<name>` shows almost nothing afterwards, because the merged commits
  carry the old paths. That is not lost history. Check it properly:
  `git merge-base --is-ancestor <old-main-sha> HEAD`. — 2026-08-30
- Whatever the old repo did not track cannot come across. Next's generated `.gitignore`
  has `.env*`, which swallows `.env.example`, so the storefront arrived with no record of
  what it needs to start. Diff the two working trees after the move, not just the git
  histories. — 2026-08-30
- `git check-ignore -v` prints the matching rule for a negation (`!.env.example`) as
  readily as for an exclusion, and its exit code is what distinguishes them. Reading the
  output as proof of exclusion is wrong. `git add --dry-run` answers the actual question.
  — 2026-08-30

## Sweep tests

- A test that loads many pages gets slower as the suite around it grows, because by file
  50 the database holds what the previous 49 created. TC-DATE-02 swept 18 pages behind a
  blind `waitForTimeout(900)`: fine alone at 20s, dead past the 60s limit in a full run.
  A fixed wait also reads the screen mid-render, so the leak it hunts can be on a row that
  has not painted. Wait for the page to stop loading instead — 4.8s, and it still catches
  an injected timestamp. — 2026-08-30

## Tests that read the clock

- Date arithmetic is checked against many dates or it is not checked. `getRevenueByMonth`
  dropped the current month from the chart on 24 days of 2026, at particular hours of those
  days — 1.5% of day/hour combinations. TC-ANA-01 reads the real clock, so it samples one
  point a day and was green for weeks. Pull the arithmetic into a function and run it over
  a multi-year span in a unit test. — 2026-08-31
- `setMonth`/`getMonth` are **local** time. Keys cut from `toISOString()` are **UTC**. Mixing
  them makes the code disagree with its own labels near midnight. And a date carrying a
  day-of-month cannot be stepped by months — from the 31st it lands where there is no 31st
  and drifts. Anchor to day 1 and let `Date.UTC` normalise the overflow. — 2026-08-31
- Write the explanation after measuring, not before. I blamed February's short month,
  committed that reasoning in a comment, then measured and found the local/UTC mix was the
  larger half. A confident wrong comment is worse than none. — 2026-08-31

## Running a suite against another suite

- Run the combination, not the parts. Two Playwright projects in one config share a database:
  the office project creates ~90 products before the storefront project starts, so a
  catalogue that serves a page of ten no longer holds the seeded SKUs. Three storefront
  tests named `[data-sku="PRD-0000NN"]` and passed alone, forever. `--project=x` proves that
  project in isolation and nothing about the run that ships. — 2026-08-31
- A fixture should own what it asserts on. Filter to a category created for the test and the
  count is exact whatever else exists; name a seeded SKU and the test is a statement about
  how big the seed happens to be. — 2026-08-31

## Subagent reports

- "All green" from an agent means green on what it ran. Ask which command produced it. The
  storefront suite was reported 17/17 with every test break-verified, and that was true —
  it had run `--project=storefront` only, and said so in its caveats. The combined run had
  five failures. Read the caveats as the finding, not the footnote. — 2026-08-31
- Kill leftover watcher shells. A polling loop written as
  `until ! pgrep -f "playwright test"` matches its own command line and waits on itself
  forever. It also makes the next `pgrep` guard report a run in progress when there is
  none — which is how a rule-6 check ends up refusing to run for no reason. Match on
  `node.*playwright`, not the bare string. — 2026-08-31

