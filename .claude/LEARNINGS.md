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

- A field that names another record (a cycle, a customer) or one of a fixed set (a ledger category, a
  type) is a picker, never a text box — and the server checks the value is in the set. The ledger's New Entry
  form had Category and Cycle ID as free text and a Type list offering system types like Purchase, and the
  API saved whatever came, so a typed `contribution` or `purchase` row would have moved cash and profit.
  The owner: "how is there a category that is text? also cycle Id as text ???? insane". — 2026-10-11
  It happened again with the supplier's Country (free text) on 2026-10-16. When adding or reviewing a form, check every
  text input: if its valid values are a known list (countries, currencies, units, statuses), it is a picker.

- Lint the whole app (`npm run lint`), not the files you touched. This repo freezes old violations per file in
  `eslint-suppressions.json`; one new `any` in a spec pushes that file past its count and every frozen error in it
  reappears. I linted `src/` only after adding TC-ANA-08 and left 7 errors on master for the next agent. — 2026-10-11

- When one end of a flow happens in parts, check the other end. Arrivals were built in parts (deliveries,
  2026-10-10) while departures stayed one date per leg, so recording a departure put every product "on the way"
  even when part of the order was still at the supplier or in Dubai. The owner: "sometimes thats not the case as I
  said before, we can receive in batches". — 2026-10-12

- Never chain `ship-prod.sh migrate | tail -1 && git push`. The pipe's exit code is tail's, so a failed migration
  (Neon dropped the connection: P1001) still let the push deploy code ahead of its schema. Run migrate on its own,
  then `ship-prod.sh status` must print "Database schema is up to date!" before the push. It was harmless that time
  only because the migration dropped unused columns. — 2026-10-14

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
- Arabic is unconditional, and that took `localeDetection: false`. next-intl honours
  `Accept-Language` by default, which makes `defaultLocale` only a fallback — a phone set
  to English landed on `/en`. The owner decided 2026-08-31 that the store opens in Arabic
  for everyone (docs/BUSINESS_LOGIC.md §13). A rule about what happens when the browser has
  an opinion needs a test with a browser that has one: TC-STORE-15 used the default context
  and never asked for English, so it passed the whole time. — 2026-08-31
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

## Local environment

- "Close dev", "stop dev" and the like mean the whole stack and then Docker Desktop itself:
  the API, the web app, the storefront, `docker compose stop`, then quit the app with
  `osascript -e 'tell application "Docker Desktop" to quit'`. Stopping the container alone
  leaves the VM and a dozen helper processes running for nothing. Check nothing is
  mid-flight first — no `node.*playwright` — because the servers may belong to another
  session. — 2026-09-02
- `npm run dev` is for the owner: it opens a visible Terminal window per server. When the stack is only for my own
  check (headless screenshots, a PDF), start the servers in the background with no windows (`scripts/agent-servers.sh`,
  or each app's dev command as a background task) and stop them and Docker when the check ends. On 2026-10-17 I opened
  the windows to check the invoice PDF and he asked "why did you open the terminals i did not tell you that i will test
  locally this time ?". — 2026-10-17
- Do not test for Docker with `pgrep -x Docker`. The exact-name match hits nothing while
  `Docker Desktop`, `com.docker.backend` and the rest are all running, so it reports a
  clean shutdown that did not happen. Ask the engine (`docker info`) or match the bundle
  path (`pgrep -f "Docker.app|com.docker"`). — 2026-09-02

## Deployment

- Never call another service from inside `$transaction`. `connection_limit: 1` is right for
  a serverless host and it means the transaction holds the only connection there is, so
  `this.audit.log()` or a notifier in there waits for a second connection that cannot arrive
  until the transaction ends — which it cannot, until the call returns. It surfaces as P2028
  at *exactly* the ceiling: 5000 ms, then 15008 ms when the ceiling was raised. Always
  precisely the limit, never near it, is the shape of a hang and not of slow work. Four
  endpoints were dead in production this way — receiving stock, confirming a sale,
  cancelling one, allocating a payment — and every one passed locally, where the pool is
  large enough to hand out a second connection. Pass `tx`, or do it after the commit.
- Local passes prove nothing about the deployed runtime. Those four had green suites for
  weeks. `API_BASE=<deployed api>` points the existing flow suites at production and found
  all of them in one run; globalSetup leaves the local database alone when the run is not
  aimed at it. — 2026-09-07


- Local `.env` says nothing about production. All three apps deploy to Vercel
  (`internal-system-api`, `-web`, `-store`) with Neon attached to the API, and I read
  `apps/api/.env` — `DATABASE_URL=localhost` — and told the owner there was no production
  database at all. `vercel projects ls` and `vercel env ls` from the app directory are the
  source of truth; check them before any claim about what is deployed. Note `.vercel/` sits
  in each app folder, so looking in one app proves nothing about the others. — 2026-09-02
- Prove a change against localhost before it goes anywhere near production, and never reach
  for production to prove it works. Checking the URL is not enough: `.env.production.local`
  now sits in `apps/api`, so a local API can be pointed at Neon by one env swap and a suite
  that writes — portal signups, seeds — would land real rows in it. Confirm which database
  the local API holds (`docker ps` for `motorcycle_parts_db`, and what `DATABASE_URL` the
  running process actually has) before running anything that writes. — 2026-09-02

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

## How much of the suite to run

- Run the tests the change touches, not all 466. The full run is 13 minutes and the owner
  has asked for it to stop being the default — a label change does not need the ledger
  tests. `-g "TC-X-01|TC-X-02"` or a single spec file. — 2026-09-02
- No e2e runs unless the owner asks (2026-10-15: "testing should be done on affected parts not full e2e", then
  "remember no e2e test"). Prove a change with unit/service tests, component tests, lint, tsc and a screenshot of the
  real screen. The rule below about running everything before a push is superseded by this. — 2026-10-15
- Run everything before a push or a deploy, and when the change is cross-cutting: a guard,
  a shared component, an error code, anything in `common/`. That is what the rule below is
  about, and it is not in tension with the one above — narrow while iterating, wide before
  it ships. — 2026-09-02

## Tests that click the moment a page changes

- A nav click starts a client navigation; it does not finish one. TC-RP-06 clicked the
  customers link and then `getByText(<shop>)` — which, late in a full run with a slow route
  change, matched the shop's name in the *dashboard's* recent activity (plain text), clicked
  it, and the customer list arrived afterwards: "left on the list". Wait for the URL, and
  look inside `getByRole('main')` for the thing a person would click. Reproduced by delaying
  the route with `page.route`: 3/3 fail before, 3/3 pass after. — 2026-10-11
- `page.goto` to a page wrapped in `<Suspense>` streams it: for a moment after `load` the
  page is a `<div hidden id="S:0">` copy beside the one being swapped in, so an id matches
  twice ("strict mode violation … resolved to 2 elements", spec 57, 1 in 140) or the click
  lands before React attached the handler. Reach the page through the menu, wait for a row
  the API sent, scope to `main`. Found from the failure's trace snapshot, not by guessing.
  — 2026-10-11

## Parallel agents and the test database

- One database and fixed ports serialise every agent behind a lock: a night of parallel work became hours of waiting
  for `/tmp/motoparts-e2e.lock`. Each agent gets its own: `eval "$(scripts/agent-env.sh <name>)"` (database copied from
  `motorcycle_parts_template` in about a second, ports 31N1–31N3), `scripts/agent-servers.sh <name> start|stop`, and
  `--drop` at the end. Addresses live in one module, `apps/web/tests/support/env.ts`; a spec that writes
  `localhost:3001` again silently aims at the developer's API from inside someone else's environment. `grep -rn
  "localhost:300" apps/web/tests` must list only that file. — 2026-10-12
- One stack per checkout. `next dev` locks the app's `.next`, and Nest's watch builds into `dist`, both inside the
  worktree, so a second agent needs a second worktree, not a second port. Stop servers by the process groups the
  script recorded, never by a machine-wide pattern: that kills every other agent's stack. — 2026-10-12

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


## Build and deploy
- `apps/web` unit tests may import `apps/api/src` to pin a shared rule (sale totals, low stock, settlement warnings,
  notification messages). Vercel installs only the web app's packages, so anything that type-checks those tests breaks
  the web build ("Cannot find module '@prisma/client'"). The build uses `tsconfig.build.json`, which excludes tests.
  When a subagent reports "2 errors, @prisma/client not found" in a web typecheck, that is exactly this; reproduce with
  `apps/api/node_modules` moved aside and `next build` before calling it a worktree artifact. — 2026-10-11

## iPhone Safari

- iOS 26 Safari colours the status-bar strip from a fixed element touching the top of the page, and the drawer's
  dark overlay left it dark after closing. Inside Safari's own window `env(safe-area-inset-top)` is 0, so offsetting
  by the notch changed nothing (it only matters in the home-screen app); starting the overlay below the header
  (`top-16`) fixed it. The iOS simulator's Safari never showed the tint, so it can't confirm a fix here: ship, and
  have the owner check on his phone. — 2026-10-14

## Agent environments in the shell

- Never pipe `eval "$(scripts/agent-env.sh <name>)"` into anything (`| tail`). A pipe runs the eval in a subshell, so
  nothing is exported and the next Playwright run snapshots and reseeds the developer's `motorcycle_parts` instead.
  It happened 2026-10-15; the snapshot restored it intact. Eval on its own, then refuse to run unless
  `$DATABASE_URL` names the agent's database: `case "$DATABASE_URL" in *motorcycle_parts_<name>*) ;; *) exit 1;; esac`.
  — 2026-10-15
- A deploy-wait loop that requires the deploy to be "under N minutes old" can miss a deploy that finished before
  the loop started, and then polls for ten minutes. Compare the deploy's commit or creation time with the push
  time instead, or just check status once after the push. — 2026-10-15

## Loading states

- A list or detail screen loading its data shows a skeleton that traces its rows (building-frontends
  ui-patterns "Skeletons"), never `<Loader2/> Loading...`. 28 office screens and 9 storefront components still had the
  spinner on 2026-10-15 and the owner had to ask. Spinners stay only inside buttons that are saving. — 2026-10-15

## Who is signed in, at first paint

- The server must know who is signed in when it draws a page. The token lives in localStorage, which the server
  never sees, so every page rendered signed-out and the account card and partner-only buttons flashed away on each
  refresh until the scripts read storage (owner, 2026-10-15: "server side session or cookie awareness is a must").
  `lib/session-cookie.ts` mirrors id/email/name/role into `sf_session_user`; the [locale] layout reads it with
  `cookies()` and seeds `AuthProvider`. It is display-only — the API authorises from the token — and the provider
  rewrites or clears it to match storage on every load, sign-in, sign-out, 401 and cross-tab sign-out. Freeze the
  server's paint in a test by aborting `/_next/static/*.js` and reloading (99-no-flash-on-refresh). — 2026-10-15

## Tables

- Every table goes through `components/ui/data-table.tsx`. There were 29 hand-written `<table>`s, so fixing column
  widths (skeleton → data jump, wrapping headers) meant the same change 29 times; the owner asked "aren't all the
  tables using one table component?". Grep `components/ui` before writing a table, a list, a card or a dialog —
  the skill's "second occurrence extracts". — 2026-10-15
- The same for dialogs: about 20 pages each carried a local `Modal`, none had `scrollbar-clean`, and the New Product
  dialog's bar ran over the rounded edge with Create scrolling away (owner, 2026-10-15). One shared dialog in
  `components/ui`; only its body scrolls, inset from the card's sides; title and actions fixed. — 2026-10-15

- `scripts/ship-prod.sh` exits 1 with no output in a worktree: `.vercel/` is untracked, so `vercel env pull` has no
  project link and `set -e` stops the script before it can say so. Copy `apps/api/.vercel/project.json` from the main
  checkout into the worktree's `apps/api/.vercel/` (it stays ignored), then run `status`. — 2026-10-17

## Keep flows small

- Build the smallest flow that does the job, from the screen where the person already is. The first contract design
  (a Settings page for terms, frozen contract records with numbers and a list, new customer fields, a button on the
  shop page) was approved on paper and rejected on use: "This is too much and too complicated — just on the sale order
  popup add a button Contract, it shows another popup to create the plan, then it creates the contract". Propose the
  one-button version first; add settings, records and lists only when he asks for them. — 2026-10-16

## Documents as PDF

- A printed document gets its PDF from `lib/document-pdf.ts`, never a second copy of that code. html-to-image pins each
  copy to the page's measured width and height and shrinks every font size to `floor(size) - 0.1`; together they made
  the contract number wrap over the date, a blank line in the terms, and page breaks in the wrong place. The helper
  restores the sizes (both `font-size` and the `font:` shorthand), leaves sizes out of the copied styles, and pins
  full-width tables, and leaves out grid row sizes; every face the document uses must be in DOCUMENT_FONT_FACES (an
  invoice number in Plex Mono drew in a wider fallback and wrapped). Check a PDF by opening the PDF itself at 36 instalments in both languages, not the screen.
  Timings from a hidden browser pane are meaningless: it paused `requestAnimationFrame` and made a 0.3 s PDF take 30 s.
  — 2026-10-17

## Numbers the system already knows

- Never ask for a number the system already holds; show it and use it. A per-piece leg asked for "number of pieces"
  while the shipment knew 230 went on it: the owner typed 100, the cycle was re-costed on 100, and a hint was not
  enough ("why not force the 230?"). Derive it on the server for every caller and show it read-only. Check every
  count, total or date in a form against what the records already say before making it a field. — 2026-10-17

## Who uses the office app

- Only the three partners use the office app; no investor or other role signs in. Don't build role-based visibility
  (hidden tabs, per-role menus, investor-only views) into new features. The tab merge got per-tab role checks so "an
  investor sees only Settlements", and the owner: "no investor can access the system, its only the 3 of us, no roles
  needed". The existing API guards stay (rule 12); this is about not adding more UI for roles nobody has. — 2026-10-18

## Delivery channels

- A "send a test" button proves the pipe, not that anything uses it. Office push alerts shipped with a working test
  push while no office notification ever called `PushService`; the owner found it with a real low-stock sale
  (2026-10-18). When adding a channel, test that a real event reaches it, from the service that raises the event.
