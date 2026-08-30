# Learnings

Corrections recorded so they don't have to be repeated. Loaded at session start.

This is the customer-facing half of `internal_system` (`~/Desktop/Projects/Personal/internal_system`).
Its `CLAUDE.md` rules apply here too — particularly rule 9, that refusals carry a code the
client translates, and rule 11, that one rule gets one definition.

## Interface

- Never a native `<select>` or `<option>`. Use `components/ui/select.tsx`, vendored from the
  admin panel and kept byte-identical to it. The owner rejected the native dropdown twice.
  — 2026-08-30
- Every clickable element gets `cursor: pointer`, as a base rule in `globals.css` rather than
  a class per element. Tailwind v4's preflight no longer provides it. — 2026-08-30
- Arabic is the default locale, not a translation of an English app. Logical properties only
  — `ps-`/`pe-`/`ms-`/`me-`/`text-start` — never `pl-`/`pr-`/`text-left`. — 2026-08-30
- Alerts are offered, not buried in settings, and a browser that says no gets numbered steps
  per browser rather than a sentence saying it cannot be done. Never call
  `requestPermission()` on page load: an unprompted request is the one everybody denies, and
  a denial is permanent. — 2026-08-30

## Talking to the API

- Only `/portal/*` and `/auth/portal/*` are reachable. A 403 `WRONG_SURFACE` means this app
  asked for something the office owns — fix it here, not by widening the API. — 2026-08-30
- Read `err.response.data.error.code`; `data.message` is always undefined. `lib/api-error.ts`
  is copied verbatim from the admin panel — do not write a shorter version, next-intl returns
  the dotted key path rather than throwing on a missing key. — 2026-08-30
- Images on `/portal/imports/**` need the bearer token, so a plain `<img src>` 401s. Fetch as
  a blob through the axios client and revoke the object URL on unmount. Catalogue images are
  public and do not need this. — 2026-08-30
