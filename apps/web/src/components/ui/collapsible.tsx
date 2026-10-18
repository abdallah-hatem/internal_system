'use client';

import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

/**
 * A section that opens and closes in place (shadcn's Collapsible, on Radix).
 * The lint rule bans a native `<details>`, whose marker, animation and state
 * differ per browser; this one carries `aria-expanded` and `data-state` the
 * same everywhere. Its trigger is a `<button type="button">`, so inside a form
 * it never submits.
 */
export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;
