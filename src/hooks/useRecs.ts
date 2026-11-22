import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { latestRun, refreshRecommendations } from '../services/recommendations';
import { friendlyError } from '../providers/errors';

let inflight: Promise<unknown> | null = null;

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
    // Recalcular al abrir si no hay ranking o tiene más de 12 h
    latestRun(profileId).then((r) => { if (!r || Date.now() - r.createdAt > 12 * 3600 * 1000) refresh(false); });
  }, [profileId, refresh]);
  const keys = run?.items.map((i) => i.key) ?? [];
  const titles = useLiveQuery(() => db.titles.bulkGet(keys), [run?.id]);
  return { run, titles, busy: busy || run === undefined && busy, error, refresh };
}
