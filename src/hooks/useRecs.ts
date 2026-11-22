import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { latestRun, refreshRecommendations } from '../services/recommendations';
import { friendlyError } from '../providers/errors';

let inflight: Promise<unknown> | null = null;

/** Último ranking calculado (en vivo) + acciones para recalcular. */
export function useRecommendations(profileId: string) {
  const run = useLiveQuery(() => latestRun(profileId), [profileId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async (rebuild = false) => {
    if (inflight) return;
    setBusy(true); setError(undefined);
    inflight = refreshRecommendations(profileId, { trigger: rebuild ? 'manual' : 'apertura', rebuildPool: rebuild })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => { inflight = null; setBusy(false); });
    await inflight;
  }, [profileId]);
  useEffect(() => {
    // Recalcular al abrir si no hay ranking, tiene más de 12 h o es de una versión anterior del motor
    latestRun(profileId).then((r) => { if (!r || Date.now() - r.createdAt > 12 * 3600 * 1000 || !r.algorithmVersion.startsWith('hybrid-aspects')) refresh(false); });
  }, [profileId, refresh]);
  return { run, busy, error, refresh };
}
