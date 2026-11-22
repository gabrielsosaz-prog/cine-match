import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getRatingsState, reconnect, subscribeRatings } from '../services/ratingsStore';
import type { Rating, TitleKey } from '../types';

/** Valoraciones con estado explícito: `loading` nunca se confunde con «no hay valoraciones». */
export function useRatings(profileId: string) {
  const sub = useCallback((fn: () => void) => subscribeRatings(profileId, fn), [profileId]);
  const get = useCallback(() => getRatingsState(profileId), [profileId]);
  const state = useSyncExternalStore(sub, get, get);
  const byKey = useMemo(() => new Map<TitleKey, Rating>(state.ratings.map((r) => [r.key, r])), [state.ratings]);
  // Si la primera lectura tarda demasiado, se ofrece reintentar en lugar de mostrar una lista vacía
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (state.status !== 'loading') { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [state.status]);
  return { ...state, byKey, slow, retry: () => reconnect(profileId) };
}
