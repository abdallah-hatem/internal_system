# Waves — partial arrivals + UX

- Wave 1: B1 ‖ U0 ‖ U3 ‖ S1 ‖ U4b, each in its own worktree. B2 U1 U4 wait on wave 1.
- S1 merged `f5002aa`: demo orders paid through the payment service; check-data 13.1.
- U0 merged `5fe27c6`: EmptyState, DatePicker disableFuture (Cairo), useDateFormat, useCodeLabel + `codes` namespace, Vitest (test:unit). Lockfile: +151 dev packages, 3 patch bumps, no core change.
- Wave 2 (early): U1 ‖ U4 dispatched from `d62a531` (they needed only U0). B2 waits on B1.
- U3 merged `7b580b7` (+ `0dec50b`: one `test:unit` runs Vitest and node:test). Bottom bar, no search, BackLink.
  Open: the sidebar has no role filtering — every role sees all 22 entries. Which ones investors see is
  a business question → logged.
- U4b merged: recent activity comes from `GET /analytics/recent-activity` (confirmed sales, unreversed
  payments, receipts; core partner + admin support). Root cause: it read the audit log, which seeds never
  write and which counts drafts. Found: `/audit-logs` has no RolesGuard → task U4c.
