'use client';

import { useEffect, useState } from 'react';

/**
 * The value once it has stopped changing.
 *
 * A request per keystroke on a workshop phone is a request per keystroke on a
 * workshop phone's connection, and the answers arrive out of order.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);

  return settled;
}
