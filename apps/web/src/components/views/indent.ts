import type { CSSProperties } from 'react';

/**
 * How far a category row sits in from the start edge for its depth in the tree.
 *
 * Logical, not physical: `paddingInlineStart` is the left in English and the
 * right in Arabic. A `paddingLeft` here padded the wrong side under RTL, so the
 * hierarchy vanished and the deepest child's name was clipped from its start.
 */
export function categoryIndent(depth: number): CSSProperties {
  return { paddingInlineStart: `${16 + Math.max(0, depth) * 24}px` };
}
