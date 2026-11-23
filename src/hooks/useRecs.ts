import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { currentRun, engineFor, latestRun, type DiscoverHints } from '../services/recommendations';
import { useApp } from './useApp';
import { getRecomputeState, requestRecompute, subscribeRecompute } from '../services/recompute';

/** Estado del recálculo en segundo plano (compartido por toda la app). */
export function useRecomputeState() {
  return useSyncExternalStore(subscribeRecompute, getRecomputeState, getRecomputeState);
}

/**
 * Último ranking calculado (en vivo) CON EL MOTOR ELEGIDO + acciones para recalcular. Los recálculos pasan por una
 * única cola. Un ranking de otro motor, o anterior al último cambio de motor, no se devuelve (se recalcula).
 */
export function useRecommendations(profileId: string) {
  const { settings } = useApp();
  const engineKey = `${settings.engine ?? 'v3.4'}|${settings.engineChangedAt ?? 0}`;
  const run = useLiveQuery(() => currentRun(profileId, settings), [profileId, engineKey]);
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
    // Recalcular al abrir si no hay ranking del motor elegido o tiene más de 12 h. El conjunto de candidatos se
    // reconstruye sólo si no hay ninguno o el último es de una versión desconocida del motor.
    Promise.all([currentRun(profileId, settings), latestRun(profileId)]).then(([r, any]) => {
      const stale = !r || Date.now() - r.createdAt > 12 * 3600 * 1000;
      const known = any && [engineFor({ engine: 'v3.4' }).version, engineFor({ engine: 'v3.5' }).version].includes(any.algorithmVersion);
      if (stale) refresh({ trigger: 'apertura', rebuild: !any || !known });
    }).catch(() => undefined);
  }, [profileId, refresh, engineKey]);
  return { run, busy: rs.running || rs.queued, error: error ?? rs.lastError, refresh };
}
