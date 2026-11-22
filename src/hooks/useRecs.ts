import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getEngine, latestRun, type DiscoverHints } from '../services/recommendations';
import { getRecomputeState, requestRecompute, subscribeRecompute } from '../services/recompute';

/** Estado del recálculo en segundo plano (compartido por toda la app). */
export function useRecomputeState() {
  return useSyncExternalStore(subscribeRecompute, getRecomputeState, getRecomputeState);
}

/** Último ranking calculado (en vivo) + acciones para recalcular. Los recálculos pasan por una única cola. */
export function useRecommendations(profileId: string) {
  const run = useLiveQuery(() => latestRun(profileId), [profileId]);
  const rs = useRecomputeState();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async (opt: boolean | { rebuild?: boolean; discover?: DiscoverHints; trigger?: string } = false) => {
    const o = typeof opt === 'boolean' ? { rebuild: opt } : opt;
    setError(undefined);
    const r = await requestRecompute(profileId, { trigger: o.trigger ?? (o.rebuild ? 'manual' : 'apertura'), rebuildPool: o.rebuild, discover: o.discover, actorDiscovery: o.rebuild });
    if (!r) setError(getRecomputeState().lastError);
    return r;
  }, [profileId]);
  useEffect(() => {
    // Recalcular al abrir si no hay ranking, tiene más de 12 h o es de una versión anterior del motor
    latestRun(profileId).then((r) => {
      const stale = !r || Date.now() - r.createdAt > 12 * 3600 * 1000 || r.algorithmVersion !== getEngine().version;
      if (stale) refresh({ trigger: 'apertura', rebuild: !r || r.algorithmVersion !== getEngine().version });
    }).catch(() => undefined);
  }, [profileId, refresh]);
  return { run, busy: rs.running || rs.queued, error: error ?? rs.lastError, refresh };
}
