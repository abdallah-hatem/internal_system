# Cycle Wizard Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the scattered per-entity create modals with a single guided 4-step wizard for the core import flow: Cycle → Purchase Order → Shipping Leg → Inventory Verification.

**Architecture:** A new full-page wizard at `/cycles/new` with a step indicator, auto-save per step, back navigation, and clickable progress bar. The Cycles list page gets a "New Cycle" button linking to the wizard. Each step calls the existing backend endpoints — no backend changes needed.

**Tech Stack:** Next.js App Router, React Query, Tailwind CSS, next-intl, lucide-react icons.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `apps/web/src/components/cycles/CycleWizard.tsx` | **Create** | Main wizard component with 4 steps, progress bar, navigation |
| `apps/web/src/app/[locale]/cycles/new/page.tsx` | **Create** | Page wrapper that renders CycleWizard |
| `apps/web/src/app/[locale]/cycles/page.tsx` | **Modify** | Change "New Cycle" button to link to `/cycles/new` instead of opening modal |
| `apps/web/src/i18n/locales/en.json` | **Modify** | Add `wizard` i18n keys |

---

## API Endpoints Used

| Step | Endpoint | Method | Body |
|------|----------|--------|------|
| 1 | `/cycles` | POST | `{ originType, currency, startedOn }` → returns `{ id, code }` |
| 2 | `/cycles/:cycleId/purchases` | POST | `{ supplierId, currency, fxRateToEgp, orderedOn, items: [...] }` → returns `{ id, reference }` |
| 3 | `/cycles/:cycleId/shipping-legs` | POST | `{ sequence, origin, destination, provider, trackingRef, departedOn, arrivedOn, amount }` |
| 4 | `/receipts/verify` | POST | `{ cycleId, items: [{ purchaseOrderItemId, productId, receivedQty, landedUnitCostEgp }] }` |

---

### Task 1: Add i18n keys for wizard

**Files:**
- Modify: `apps/web/src/i18n/locales/en.json`

**What to add:** A new `"wizard"` section with keys for step titles, labels, and completion messages. Also add keys under existing sections as needed.

```json
"wizard": {
  "title": "New Import Cycle",
  "step1Title": "Cycle Info",
  "step2Title": "Purchase Order",
  "step3Title": "Shipping Leg",
  "step4Title": "Receive Inventory",
  "saveAndContinue": "Save & Continue",
  "goBack": "Back",
  "complete": "Complete",
  "completed": "Completed",
  "stepComplete": "Step complete",
  "cycleCreated": "Cycle created",
  "purchaseCreated": "Purchase order created",
  "shippingCreated": "Shipping leg created",
  "inventoryVerified": "Inventory verified",
  "allDone": "All Steps Complete!",
  "allDoneDesc": "Your import cycle has been set up. You can now track it from the Cycles page.",
  "viewCycles": "View Cycles",
  "startOver": "Start Another Cycle",
  "skip": "Skip for now",
  "addItem": "Add Item",
  "removeItem": "Remove",
  "noItems": "No items added yet",
  "summary": "Summary",
  "cycleCode": "Cycle Code",
  "purchaseRef": "Purchase Reference",
  "supplier": "Supplier"
}
```

---

### Task 2: Create CycleWizard component

**Files:**
- Create: `apps/web/src/components/cycles/CycleWizard.tsx`

**This is the main deliverable.** A single component that manages 4 steps:

**Component structure:**
```tsx
'use client';
// Imports: useState, useMutation, useQuery, useQueryClient, useToast, useRouter, lucide icons

interface WizardState {
  currentStep: number;          // 0-3
  cycleId: string | null;       // set after step 1
  cycleCode: string | null;     // set after step 1
  poId: string | null;          // set after step 2
  poReference: string | null;   // set after step 2
}

export default function CycleWizard() { ... }
```

**Progress bar:** Horizontal row of 4 steps. Each step shows:
- ✅ Green check if completed
- 🔵 Blue circle if current
- ⚪ Gray circle if future
- Step title below
- Clickable to jump back to completed steps

**Step 1 — Cycle Info form:**
- Fields: `originType` (select: CHINA/UAE_DIRECT), `currency` (select: CNY/AED/USD), `startedOn` (date input)
- On submit: `POST /cycles` → save `cycleId` and `cycleCode` → advance to step 2

**Step 2 — Purchase Order form:**
- Fields: `supplierId` (select, fetched from `/suppliers`), `currency` (select), `fxRateToEgp` (number), `orderedOn` (date)
- Line items: dynamic list with product select, orderedQty, unitPrice, discount
- "Add Item" button to add rows
- On submit: `POST /cycles/:cycleId/purchases` → save `poId` and `poReference` → advance to step 3

**Step 3 — Shipping Leg form:**
- Fields: `sequence` (number, default 1), `origin` (text), `destination` (text), `provider` (text), `trackingRef` (text, optional), `departedOn` (date, optional), `arrivedOn` (date, optional), `amount` (number, optional)
- On submit: `POST /cycles/:cycleId/shipping-legs` → advance to step 4

**Step 4 — Inventory Verification form:**
- Fetches PO items from `/purchases/:poId` to display what was ordered
- For each item: product name, orderedQty (display), receivedQty (number input), landedUnitCostEgp (number input)
- On submit: `POST /receipts/verify` → show completion screen

**Completion screen (step 4 after submit):**
- Green checkmark icon
- "All Steps Complete!" heading
- Summary: cycle code, PO reference, shipping info
- Two buttons: "View Cycles" (navigate to /cycles) and "Start Another Cycle" (reset wizard)

**Error handling:**
- All mutations have `onError` with toast notifications
- Loading states on submit buttons
- Disabled form during submission

**Back button:**
- Each step (except step 1) shows a "Back" button
- Going back does NOT undo the save — data is already persisted

---

### Task 3: Create wizard page

**Files:**
- Create: `apps/web/src/app/[locale]/cycles/new/page.tsx`

Simple wrapper:
```tsx
'use client';
import CycleWizard from '../../../../components/cycles/CycleWizard';

export default function NewCyclePage() {
  return <CycleWizard />;
}
```

---

### Task 4: Update Cycles list page

**Files:**
- Modify: `apps/web/src/app/[locale]/cycles/page.tsx`

**Changes:**
1. Import `Link` from `../../../i18n/navigation` (or use `useRouter`)
2. Change the "New Cycle" button from `onClick={() => setShowCreateModal(true)}` to a `Link` that navigates to `/cycles/new`
3. Remove the create modal (the `<Modal title={t('create')}...>` block and `showCreateModal` state)
4. Remove the `createMutation` since cycle creation is now in the wizard
5. Keep the `showTransitionModal` and `viewingCycle` functionality

**Before:**
```tsx
<button
  onClick={() => setShowCreateModal(true)}
  className="..."
>
  <Plus className="h-4 w-4" />
  {t('create')}
</button>
```

**After:**
```tsx
<Link
  href="/cycles/new"
  className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
>
  <Plus className="h-4 w-4" />
  {t('create')}
</Link>
```

---

### Task 5: Verify in browser

1. Navigate to `/cycles` — confirm "New Cycle" button links to `/cycles/new`
2. Click "New Cycle" — wizard page loads with step 1
3. Fill step 1 form → click "Save & Continue" → step 2 loads
4. Fill step 2 form with line items → click "Save & Continue" → step 3 loads
5. Fill step 3 form → click "Save & Continue" → step 4 loads
6. Fill step 4 form → click "Complete" → completion screen shows
7. Click "View Cycles" → navigates to cycles list with new cycle visible
8. Verify back button works on each step
9. Verify progress bar shows completed steps
10. Verify toast notifications on errors
