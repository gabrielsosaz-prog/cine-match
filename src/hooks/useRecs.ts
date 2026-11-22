import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getEngine, latestRun, refreshRecommendations, type DiscoverHints } from '../services/recommendations';
import { friendlyError } from '../providers/errors';

let inflight: Promise<unknown> | null = null;

/** Último ranking calculado (en vivo) + acciones para recalcular. */
export function useRecommendations(profileId: string) {
  const run = useLiveQuery(() => latestRun(profileId), [profileId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async (opt: boolean | { rebuild?: boolean; discover?: DiscoverHints; trigger?: string } = false) => {
    const o = typeof opt === 'boolean' ? { rebuild: opt } : opt;
    if (inflight) { await inflight; return; }
    setBusy(true); setError(undefined);
    inflight = refreshRecommendations(profileId, { trigger: o.trigger ?? (o.rebuild ? 'manual' : 'apertura'), rebuildPool: o.rebuild, discover: o.discover })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => { inflight = null; setBusy(false); });
    await inflight;
  }, [profileId]);
  useEffect(() => {
    // Recalcular al abrir si no hay ranking, tiene más de 12 h o es de una versión anterior del motor
    latestRun(profileId).then((r) => { if (!r || Date.now() - r.createdAt > 12 * 3600 * 1000 || r.algorithmVersion !== getEngine().version) refresh(false); });
  }, [profileId, refresh]);
  return { run, busy, error, refresh };
}
