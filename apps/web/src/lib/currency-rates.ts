import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * The current rate for turning each foreign currency into EGP.
 *
 * Kept on the server rather than in the bundle so a rate change is a row
 * update, not a redeploy — which is what lets a scheduled job maintain them
 * later without touching the app.
 */
export function useCurrencyRates() {
  const { data } = useQuery<Record<string, number>>({
    queryKey: ['currencyRates'],
    queryFn: () => api.get('/currency-rates/map').then((r) => r.data.data ?? r.data),
    // Rates move slowly; refetching on every form open is noise.
    staleTime: 10 * 60 * 1000,
  });
  return data ?? {};
}
