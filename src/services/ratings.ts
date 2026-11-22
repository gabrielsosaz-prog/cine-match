import { db } from '../db/db';
import { deleteRating, saveRating, type RatingPatch } from '../db/repo';
import { getEngine } from './recommendations';
import { requestRecompute } from './recompute';
import type { Rating, RecommendationRun, TitleKey } from '../types';

/** ¿El cambio afecta lo que el motor aprende? Marcar «vista» no: no es una señal de gusto. */
export const affectsLearning = (p: RatingPatch) =>
  p.overall !== undefined || p.dimensions !== undefined || p.list !== undefined || p.notInterested !== undefined || p.comment !== undefined;

export class SaveError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = 'SaveError'; }
}

export const SAVE_TIMING = { timeoutMs: 10000 };
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new SaveError('La base local no respondió a tiempo. Tus datos anteriores siguen guardados; probá de nuevo.')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface SaveResult {
  rating?: Rating;
  /** true cuando se releyó el registro y coincide con lo guardado */
  confirmed: boolean;
  /** Recálculo del modelo en segundo plano (no bloquea el guardado) */
  recompute?: Promise<RecommendationRun | undefined>;
  /** Sólo si se pidió esperar el recálculo */
  run?: RecommendationRun;
}

/**
 * Guardado en dos pasos separados:
 * 1) persistir y CONFIRMAR (se relee de la base) — rápido, sin red;
 * 2) recalcular el modelo en segundo plano, agrupando pedidos seguidos.
 * Un error en el paso 1 se informa sin tocar los datos existentes; un error en el paso 2 no afecta lo guardado.
 */
export async function rateAndLearn(profileId: string, key: TitleKey, patch: RatingPatch, opts: { wait?: boolean; debounceMs?: number } = {}): Promise<SaveResult> {
  let rating: Rating | undefined;
  try {
    rating = await withTimeout(saveRating(profileId, key, patch), SAVE_TIMING.timeoutMs);
  } catch (e) {
    throw e instanceof SaveError ? e : new SaveError('No se pudo guardar. Tus datos anteriores siguen intactos; probá de nuevo.', e);
  }
  const stored = await withTimeout(db.ratings.get(`${profileId}|${key}`), SAVE_TIMING.timeoutMs).catch(() => undefined);
  // Confirmado si el registro guardado es el nuestro o uno posterior (otra escritura que partió del nuestro, dentro
  // de la misma transacción atómica de lectura-modificación-escritura)
  const confirmed = rating ? Boolean(stored && stored.updatedAt >= rating.updatedAt) : !stored || stored.updatedAt > Date.now() - 60000;
  if (!confirmed) throw new SaveError('No se pudo confirmar el guardado. Probá de nuevo.');
  db.logs.add({ profileId, at: Date.now(), type: 'rating_saved', key, algorithmVersion: getEngine().version, detail: JSON.stringify(Object.keys(patch)) }).catch(() => undefined);
  const res: SaveResult = { rating, confirmed };
  if (affectsLearning(patch)) {
    res.recompute = requestRecompute(profileId, { trigger: 'valoración', extraKeys: [key] }, opts.wait ? 0 : opts.debounceMs ?? 600);
    if (opts.wait) res.run = await res.recompute;
  }
  return res;
}

/** Marca o desmarca «vista» con una sola acción, sin tocar la puntuación. */
export async function setWatched(profileId: string, key: TitleKey, watched: boolean) {
  return (await rateAndLearn(profileId, key, { watched })).rating;
}

/** «No me interesa» (o revertirlo) sin tocar vista, nota, aspectos ni listas. Recalcula el modelo. */
export async function setNotInterested(profileId: string, key: TitleKey, value: boolean) {
  return rateAndLearn(profileId, key, { notInterested: value });
}

export async function removeAndLearn(profileId: string, key: TitleKey) {
  await deleteRating(profileId, key);
  await db.logs.add({ profileId, at: Date.now(), type: 'rating_deleted', key, algorithmVersion: getEngine().version });
  return requestRecompute(profileId, { trigger: 'valoración eliminada' }, 600);
}
