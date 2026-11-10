import { useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from './api';

// Nothing in the UI refreshes on a timer. Data loads when a page opens, when you press Refresh, and
// when the server pushes a change over the WebSocket (a trade, a signal, the stream reconnecting).

/** The header (bot status, balances, SOL price, Helius credits): reloaded with every Refresh. */
export function refreshHeader(qc: QueryClient) {
  return Promise.all([qc.invalidateQueries({ queryKey: ['status'] }), qc.invalidateQueries({ queryKey: ['helius-usage'] })]);
}

// Per query: when it last asked the server for prices, and whether the next load should. Kept outside
// the component because the layout re-mounts a page once the SOL price is known, sometimes while its
// first load is still running – that re-mount must not ask for prices again.
const priced = new Map<string, { at: number | null; wanted: boolean }>();
const state = (id: string) => {
  let s = priced.get(id);
  if (!s) priced.set(id, (s = { at: null, wanted: false }));
  return s;
};

/**
 * Data that includes token prices (open positions, unrealized profit). Prices are fetched when the
 * page opens and on Refresh; reloads after a live trade re-read the database with the prices already
 * loaded, so the unrealized part only changes when you ask for it.
 */
export function usePricedQuery<T>(key: QueryKey, path: string, enabled = true) {
  const qc = useQueryClient();
  const id = JSON.stringify(key);
  const seen = useRef(new Set<string>());
  if (!seen.current.has(id)) {
    seen.current.add(id);
    const s = state(id);
    if (s.at == null || Date.now() - s.at > 3000) s.wanted = true;
  }
  const query = useQuery({
    queryKey: key,
    enabled,
    // Opening a page always loads, even if it was open a moment ago.
    refetchOnMount: 'always',
    queryFn: () => {
      const s = state(id);
      const withPrices = s.wanted;
      if (withPrices) {
        s.wanted = false;
        s.at = Date.now();
      }
      return api<T>(withPrices ? `${path}${path.includes('?') ? '&' : '?'}prices=1` : path);
    },
  });
  const refresh = async () => {
    state(id).wanted = true;
    await Promise.all([qc.refetchQueries({ queryKey: key, exact: true }), refreshHeader(qc)]);
  };
  return { ...query, pricedAt: state(id).at, refresh };
}
