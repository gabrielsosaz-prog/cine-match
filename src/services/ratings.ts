import { db } from '../db/db';
import { deleteRating, saveRating, type RatingInput } from '../db/repo';
import { getEngine, refreshRecommendations } from './recommendations';
import type { TitleKey } from '../types';

/**
 * Guardar una valoración dispara el ciclo de aprendizaje:
 * 1) persistir, 2) registrar versión del algoritmo, 3-5) reconstruir perfil y ranking.
 */
export async function rateAndLearn(profileId: string, key: TitleKey, input: RatingInput) {
  const rating = await saveRating(profileId, key, input);
  await db.logs.add({ profileId, at: Date.now(), type: 'rating_saved', key, algorithmVersion: getEngine().version, detail: rating.status });
  const run = await refreshRecommendations(profileId, { trigger: 'valoración', extraKeys: [key] }).catch(() => undefined);
  return { rating, run };
}

export async function removeAndLearn(profileId: string, key: TitleKey) {
  await deleteRating(profileId, key);
  await db.logs.add({ profileId, at: Date.now(), type: 'rating_deleted', key, algorithmVersion: getEngine().version });
  return refreshRecommendations(profileId, { trigger: 'valoración eliminada' }).catch(() => undefined);
}
