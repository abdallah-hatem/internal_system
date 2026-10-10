# Waves — partial arrivals + UX

- Wave 1: B1 ‖ U0 ‖ U3 ‖ S1 ‖ U4b, each in its own worktree. B2 U1 U4 wait on wave 1.
- S1 merged `f5002aa`: demo orders paid through the payment service; check-data 13.1.
- U0 merged `5fe27c6`: EmptyState, DatePicker disableFuture (Cairo), useDateFormat, useCodeLabel + `codes` namespace, Vitest (test:unit). Lockfile: +151 dev packages, 3 patch bumps, no core change.
