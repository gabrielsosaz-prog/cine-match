import { db } from '../db/db';
import { deleteRating, saveRating, type RatingPatch } from '../db/repo';
import { getEngine, refreshRecommendations } from './recommendations';
import type { TitleKey } from '../types';

/** ¿El cambio afecta lo que el motor aprende? Marcar «vista» no: no es una señal de gusto. */
export const affectsLearning = (p: RatingPatch) => p.overall !== undefined || p.dimensions !== undefined || p.list !== undefined;

/**
 * Guardar dispara el ciclo de aprendizaje:
 * 1) persistir, 2) registrar versión del algoritmo, 3-5) reconstruir perfil y ranking.
 */
export async function rateAndLearn(profileId: string, key: TitleKey, patch: RatingPatch) {
  const rating = await saveRating(profileId, key, patch);
  await db.logs.add({ profileId, at: Date.now(), type: 'rating_saved', key, algorithmVersion: getEngine().version, detail: JSON.stringify(Object.keys(patch)) });
  const run = affectsLearning(patch)
    ? await refreshRecommendations(profileId, { trigger: 'valoración', extraKeys: [key] }).catch(() => undefined)
    : undefined;
  return { rating, run };
}

/** Marca o desmarca «vista» con una sola acción, sin tocar la puntuación. */
export async function setWatched(profileId: string, key: TitleKey, watched: boolean) {
  return saveRating(profileId, key, { watched });
}

export async function removeAndLearn(profileId: string, key: TitleKey) {
  await deleteRating(profileId, key);
  await db.logs.add({ profileId, at: Date.now(), type: 'rating_deleted', key, algorithmVersion: getEngine().version });
  return refreshRecommendations(profileId, { trigger: 'valoración eliminada' }).catch(() => undefined);
}
