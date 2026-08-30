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
