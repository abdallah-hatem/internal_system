'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  // Created in state, not at module scope: a client shared across requests on
  // the server would leak one visitor's cached catalogue to the next.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            // A price or a stock band that is quietly stale is worse than a
            // spinner. Refetching on focus is how a shop that left the tab
            // open for an hour does not act on yesterday's figure.
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
