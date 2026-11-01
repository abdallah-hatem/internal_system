> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 13. Open questions — the storefront

### Which language a shop owner gets  — DECIDED 2026-08-31

**The store opens in Arabic for everyone. English is a choice the reader
makes, not one their phone makes for them.**

The rule recorded on 2026-08-30 was "Arabic default", and what was built was
next-intl's ordinary behaviour, which is not the same thing: `defaultLocale`
is only the fallback, and `Accept-Language` beats it. Measured before the
change:

| the phone asks for | it landed on |
|---|---|
| Arabic | `/ar` |
| English | `/en` |
| French | `/ar` |
| nothing | `/ar` |

So a shop owner whose phone was set to English — common here, and often set
by whoever sold the phone rather than by its owner — got an English store and
might never have seen the Arabic one.

`localeDetection: false` in `apps/storefront/src/i18n/routing.ts`. Every
browser now lands on `/ar` whatever it asks for, and the language switch is
one tap away.

TC-STORE-18 pins it, using browser contexts that explicitly request `en-US`,
`en-GB` and `fr-FR`. TC-STORE-15 could not have caught this: it uses the
default context, which never asks for English, so it passed throughout.

### Where a shop sends its basket from  — OPEN, raised 2026-08-31

`<BasketLauncher />` is rendered only by the "My orders" page. A shop that adds
parts while browsing the catalogue sees "Added to your request" and then has no
visible way to review or send it without finding that tab.

`basket-sheet.tsx`'s own comment says the sheet exists "so a shop adding a fifth
part does not lose its place in the catalogue", which reads as the intent being a
launcher visible while browsing. **Not changed** — where a persistent basket
button belongs is a design decision, not a defect to fix quietly.

---

