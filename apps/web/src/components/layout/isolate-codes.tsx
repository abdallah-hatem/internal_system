import { Fragment, type ReactNode } from 'react';

/**
 * A record code — CYC-2026-0007, PO-12, REQ-2026-0031 — written as one
 * unbreakable left-to-right run.
 *
 * Inside a sentence the browser breaks a code at its hyphens, and in Arabic the
 * bidi algorithm reorders the pieces so the hyphen lands on the far side
 * ("0007-CYC-2026"). Wrapping each code in an isolated LTR span that does not
 * wrap keeps it whole and in order in both languages (UI audit 2026-10-10, #35).
 */
export const RECORD_CODE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

export function isolateCodes(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(RECORD_CODE)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <bdi key={at} dir="ltr" className="whitespace-nowrap">
        {match[0]}
      </bdi>,
    );
    last = at + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}
