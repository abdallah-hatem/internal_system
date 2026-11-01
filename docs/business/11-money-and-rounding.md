> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 11. Money and rounding

- Monetary values are `NUMERIC(18,2)`, unit costs and FX `NUMERIC(18,4)`,
  quantities `NUMERIC(18,3)`.
- All arithmetic uses decimals, never floating point. A float rounding drift in
  COGS would quietly misstate every settlement.
- Everything reports in EGP. Foreign amounts convert at the rate recorded on the
  document.
- Displayed money always carries thousands separators and two decimals, and
  stays left-to-right in Arabic.

---

