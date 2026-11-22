import { friendlyError } from '../providers/errors';
import type { RecommendationRun } from '../types';
import { refreshRecommendations, type RefreshOptions } from './recommendations';

/**
 * Cola única de recálculos del modelo.
 * - Nunca hay dos recálculos simultáneos (evita escrituras concurrentes de rankings y picos de red).
 * - Varios pedidos seguidos (p. ej. puntuar cinco títulos rápido) se agrupan en uno solo.
 * - Un recálculo que falla no toca las valoraciones: sólo se informa el error.
 */
export interface RecomputeState { running: boolean; queued: boolean; lastError?: string; lastRunAt?: number }

let state: RecomputeState = { running: false, queued: false };
const listeners = new Set<() => void>();
const set = (p: Partial<RecomputeState>) => { state = { ...state, ...p }; for (const l of listeners) l(); };
export const getRecomputeState = () => state;
export function subscribeRecompute(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

let inflight: Promise<void> | null = null;
let next: { profileId: string; opts: RefreshOptions; waiters: ((r: RecommendationRun | undefined) => void)[] } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function merge(a: RefreshOptions, b: RefreshOptions): RefreshOptions {
  return {
    trigger: b.trigger,
    rebuildPool: a.rebuildPool || b.rebuildPool,
    extraKeys: [...new Set([...(a.extraKeys ?? []), ...(b.extraKeys ?? [])])],
    discover: b.discover ?? a.discover,
    actorDiscovery: a.actorDiscovery || b.actorDiscovery,
  };
}

async function runLoop() {
  while (next) {
    const job = next; next = null;
    set({ running: true, queued: false });
    let run: RecommendationRun | undefined;
    try {
      run = await refreshRecommendations(job.profileId, job.opts);
      set({ lastError: undefined, lastRunAt: Date.now() });
    } catch (e) {
      set({ lastError: friendlyError(e) });
    }
    for (const w of job.waiters) w(run);
  }
  set({ running: false });
  inflight = null;
}

/** Pide un recálculo. `debounceMs` agrupa pedidos cercanos. Devuelve el ranking resultante (o undefined si falló). */
export function requestRecompute(profileId: string, opts: RefreshOptions, debounceMs = 0): Promise<RecommendationRun | undefined> {
  return new Promise((resolve) => {
    if (next && next.profileId === profileId) { next.opts = merge(next.opts, opts); next.waiters.push(resolve); }
    else next = { profileId, opts, waiters: [resolve] };
    set({ queued: true });
    if (timer) clearTimeout(timer);
    const start = () => { timer = undefined; if (!inflight) inflight = runLoop(); };
    if (debounceMs > 0) timer = setTimeout(start, debounceMs); else start();
  });
}

/** Sólo para pruebas */
export function resetRecompute() { next = null; inflight = null; if (timer) clearTimeout(timer); timer = undefined; state = { running: false, queued: false }; }
