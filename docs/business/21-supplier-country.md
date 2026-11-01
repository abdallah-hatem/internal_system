> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 21. A supplier's country  — raised 2026-10-16 (owner), details GUESSED

The owner, 2026-10-16: the New Supplier popup took the country as free text — "that's not good". One supplier
said "China", the next "CN", a third "الصين", and nothing could tell they were the same place.

| Question | Rule | Status |
|---|---|---|
| What is stored | The **ISO 3166-1 alpha-2 code** (`CN`, `AE`, `EG`), never the words typed. The column stays text; no schema change. | **GUESS** (recommended option, taken without asking) |
| Which countries | All 249 ISO codes. One list, `apps/api/src/common/countries.ts`; the office keeps a copy of the codes in `apps/web/src/lib/countries.ts`, pinned to the API's by `countries.test.ts`. | **GUESS** |
| What a reader sees | The country's name in the language being read — Arabic on /ar, English on /en — from the browser's own `Intl.DisplayNames`, so no names are stored or translated by hand. Never the raw code. The Suppliers list and the supplier card show it; no other screen shows a supplier's country today. | **GUESS** |
| The form | A searchable picker, on the Suppliers page and the `+` beside a supplier picker alike (one form, `entity-forms.tsx`). Found by its name in either language or by its code. **China, the Emirates, Egypt, Turkey and India first**, then the rest A–Z in the reader's language. Required. | **GUESS** — the first five are where the goods come from, home, and the next most likely; change the list in `PREFERRED_COUNTRIES`. |
| What the API accepts | A code from the list, any case (`cn` is saved as `CN`). Anything else is refused, `COUNTRY_UNKNOWN`; empty is refused, `COUNTRY_REQUIRED` — on create, and on edit when a country is sent. A name sent straight to the API is refused: the form sends codes, and a second, looser way in would let free text back. | **GUESS** |
| The assistant | Takes a country however the partner says it — "China", "الصين", "cn", "U.A.E.", "Dubai" — and saves the code. Exact match only, never a guess from a fragment: "Chin" is refused, naming China (CN) as the likely one, so the assistant asks. It reports both the code and the English name (`find_suppliers`, `create_supplier`, a new supplier on `create_purchase_order`). | **GUESS** |
| Suppliers already on file | Migration `20261016100000_supplier_country_codes` converts each country that spells one — any code, any English name, and the aliases in `countries.ts` (UAE, Dubai, Türkiye, the Arabic names of the countries the business deals with…), compared ignoring case, punctuation, spacing and Arabic spelling. Anything else is **left as it was**, shown as typed, and counted by `scripts/check-data.sh` (check 24) to be put right by hand: open the supplier and choose its country — the picker will not save until one is chosen. | **GUESS** |
| Searching suppliers by country | The Suppliers list box and `GET /suppliers?search=` find a supplier by its country's name in either language or by its code. | **GUESS** |

Not changed: a shipping leg's origin and destination are fixed places, not countries; shipping providers and
customers have no country.

