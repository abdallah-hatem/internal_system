'use client';

/**
 * A batch reference such as "#a1b2c3d4".
 *
 * "#" is a bidi-neutral character, so in an Arabic (RTL) paragraph it drifts to
 * the far side of the id and renders as "a1b2c3d4#". The id is an LTR run;
 * isolate it so the marker stays attached.
 */
export function BatchRef({ id, className }: { id?: string | null; className?: string }) {
  if (!id) return <span className={className}>—</span>;
  return (
    <span className={className} dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      #{id.slice(0, 8)}
    </span>
  );
}
