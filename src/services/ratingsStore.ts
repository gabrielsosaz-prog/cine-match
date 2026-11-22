import { liveQuery, type Subscription } from 'dexie';
import { db } from '../db/db';
import { migrateRating } from '../db/migrations';
import type { Rating } from '../types';

/**
 * Vista en memoria de tus valoraciones, compartida por todas las pantallas.
 *
 * Problema que resuelve (v3.0): las pantallas leían la base con `useLiveQuery(...) ?? []`. Mientras una lectura
 * estaba demorada (base ocupada, conexión cerrada por el sistema, pestaña en segundo plano) el resultado era
 * `undefined` y se mostraba como «sin valoraciones». Además, si la lectura fallaba, el error rompía la pantalla.
 *
 * Reglas:
 *  - «cargando» y «vacío» son estados distintos: nunca se muestra una lista vacía si no se confirmó que lo está;
 *  - si una lectura falla, se conserva la última lista confirmada y se reintenta (no se reemplaza por vacío);
 *  - nada de esto escribe en la base: es sólo lectura.
 */
export interface RatingsState { status: 'loading' | 'ready' | 'error'; ratings: Rating[]; error?: string; updatedAt?: number; stale: boolean }

interface Entry { state: RatingsState; listeners: Set<() => void>; sub?: Subscription; retry?: ReturnType<typeof setTimeout>; attempts: number }
const entries = new Map<string, Entry>();
const INITIAL: RatingsState = { status: 'loading', ratings: [], stale: false };

function entry(profileId: string): Entry {
  let e = entries.get(profileId);
  if (!e) { e = { state: INITIAL, listeners: new Set(), attempts: 0 }; entries.set(profileId, e); }
  return e;
}
const emit = (e: Entry, s: Partial<RatingsState>) => { e.state = { ...e.state, ...s }; for (const l of e.listeners) l(); };

function start(profileId: string) {
  const e = entry(profileId);
  e.sub?.unsubscribe();
  e.sub = liveQuery(() => db.ratings.where('profileId').equals(profileId).toArray()).subscribe({
    next: (rows) => { e.attempts = 0; emit(e, { status: 'ready', ratings: rows.map(migrateRating), error: undefined, updatedAt: Date.now(), stale: false }); },
    error: (err) => {
      // Se conserva lo último confirmado; si nunca se cargó nada, se informa el error (no «vacío»)
      emit(e, { status: e.state.updatedAt ? 'ready' : 'error', stale: true, error: (err as Error)?.message ?? String(err) });
      e.attempts++;
      if (e.retry) clearTimeout(e.retry);
      e.retry = setTimeout(() => { if (e.listeners.size) reconnect(profileId); }, Math.min(15000, 1000 * 2 ** e.attempts));
    },
  });
}

/** Reabre la conexión si el sistema la cerró y vuelve a suscribirse. Nunca borra ni escribe datos. */
export async function reconnect(profileId: string) {
  try { if (!db.isOpen()) await db.open(); } catch { /* el próximo intento lo vuelve a probar */ }
  start(profileId);
}

export function subscribeRatings(profileId: string, fn: () => void) {
  const e = entry(profileId);
  e.listeners.add(fn);
  if (!e.sub) start(profileId);
  return () => {
    e.listeners.delete(fn);
    // Se mantiene la suscripción viva un rato para que cambiar de pantalla no vuelva a «cargando»
    if (!e.listeners.size) setTimeout(() => { if (!e.listeners.size) { e.sub?.unsubscribe(); e.sub = undefined; } }, 30000);
  };
}
export const getRatingsState = (profileId: string) => entry(profileId).state;

/** Sólo para pruebas */
export function resetRatingsStore() { for (const e of entries.values()) { e.sub?.unsubscribe(); if (e.retry) clearTimeout(e.retry); } entries.clear(); }
