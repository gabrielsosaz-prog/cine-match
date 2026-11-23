/**
 * v3.5 · Motor `hybrid-personal-3.5.0` (experimental hasta validarlo con datos reales).
 *
 * Tres etapas separadas:
 *  A. Recuperación de candidatos: la hace la app (ranking guardado, TMDB, catálogo, filmografías); este motor no
 *     recorta candidatos antes de puntuar.
 *  B. Afinidad: tres modelos que miran señales distintas, combinados en escala comparable (z):
 *     1. el motor v3.4 (canales de contenido, aspectos, comentarios, descartes parecidos);
 *     2. un modelo personal REGULARIZADO (ridge) sobre rasgos interpretables: géneros, formato, saga, popularidad,
 *        calidad pública, época, idioma y rasgos narrativos (misterio, tono, estructura…) — aprende QUÉ rasgos
 *        explican tus notas, en lugar de sólo «parecido a lo que te gustó»;
 *     3. un modelo de INTERÉS (logístico regularizado): títulos vistos (con o sin nota) frente a «No me interesa».
 *        No es una nota: aprende qué tipo de propuestas descartás sin ver.
 *     Con menos de 8 notas usa sólo v3.4 (no hay datos para el modelo personal); sin ≥ 3 descartes, sin interés.
 *  C. Ranking: el mismo de v3.4 (diversidad, tope por saga y por actor), con exploración personalizada.
 * La nota «Para vos» que se muestra sigue siendo la de v3.4 (calibrada en notas); el orden usa la combinación.
 */
import type { Rating, TitleKey, TitleMeta } from '../types';
import { hybridEngine, rank, scoreCandidates, getDefaultNarrative, type RecommenderEngine, type RankInput } from './recommender';
import { featuresOf, explicitVec, fitRidge, fitLogistic, type ItemFeatures } from './personal';

export const PERSONAL_ENGINE_VERSION = 'hybrid-personal-3.5.0';
export const PERSONAL_PARAMS = { minRatings: 8, minDiscards: 3, ridgeLambda: 8, logisticLambda: 3, interestWeight: 0.5, logitClip: 5 };

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
export interface PersonalScore { order: number; v34: number; lin?: number; interest?: number; linRating?: number }
/** Puntajes de afinidad v3.5 para candidatos (y para cualquier título con ficha). */
export function personalScores(input: RankInput, keys: TitleKey[]): Map<TitleKey, PersonalScore> {
  const idx = input.narrative === null ? undefined : input.narrative ?? getDefaultNarrative();
  const rated = input.ratings.filter((r) => r.overall !== undefined && r.overall !== null && !r.notInterested && input.titles.has(r.key));
  const discards = input.ratings.filter((r) => r.notInterested && input.titles.has(r.key));
  const watched = input.ratings.filter((r) => r.watched && (r.overall === undefined || r.overall === null) && !r.notInterested && input.titles.has(r.key));
  const feat = new Map<TitleKey, ItemFeatures>();
  const F = (k: TitleKey) => { let f = feat.get(k); if (!f) { f = featuresOf(input.titles.get(k)! as TitleMeta, idx ?? undefined); feat.set(k, f); } return f; };
  const all = [...new Set([...keys, ...rated.map((r) => r.key)])].filter((k) => input.titles.has(k));
  const v34 = new Map(scoreCandidates({ ...input, candidates: all }).map((s) => [s.key, s.predRaw]));
  const out = new Map<TitleKey, PersonalScore>();
  if (rated.length < PERSONAL_PARAMS.minRatings) {
    for (const k of keys) if (v34.has(k)) out.set(k, { order: v34.get(k)!, v34: v34.get(k)! });
    return out;
  }
  const ridge = fitRidge(rated.map((r) => explicitVec(F(r.key))), rated.map((r) => r.overall!), PERSONAL_PARAMS.ridgeLambda);
  const useInterest = discards.length >= PERSONAL_PARAMS.minDiscards;
  const pos = [...rated, ...watched];
  const logi = useInterest ? fitLogistic([...pos, ...discards].map((r) => explicitVec(F(r.key))), [...pos.map(() => 1), ...discards.map(() => 0)], PERSONAL_PARAMS.logisticLambda) : undefined;
  // escalas medidas sobre lo que la persona valoró
  const zOf = (xs: number[]) => { const m = mean(xs); const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) || 1; return { m, sd }; };
  const zv = zOf(rated.map((r) => v34.get(r.key)!)), lins = rated.map((r) => ridge.predict(explicitVec(F(r.key)))), zl = zOf(lins);
  const ratedMean = mean(rated.map((r) => r.overall!)), ratedSd = zOf(rated.map((r) => r.overall!)).sd;
  for (const k of keys) {
    if (!v34.has(k)) continue;
    const x = explicitVec(F(k));
    const lin = ridge.predict(x);
    const interest = logi ? Math.max(-PERSONAL_PARAMS.logitClip, Math.min(PERSONAL_PARAMS.logitClip, logi.predict(x))) : 0;
    const z = (v34.get(k)! - zv.m) / zv.sd + (lin - zl.m) / zl.sd + PERSONAL_PARAMS.interestWeight * interest;
    // a escala de nota para el MMR: media ± desvío de tus notas (la combinación de dos z tiene desvío ~1,4)
    out.set(k, { order: ratedMean + (ratedSd * z) / 1.4, v34: v34.get(k)!, lin: (lin - zl.m) / zl.sd, interest: logi ? interest : undefined, linRating: lin });
  }
  return out;
}
export const personalEngine: RecommenderEngine = {
  version: PERSONAL_ENGINE_VERSION,
  buildProfile: hybridEngine.buildProfile,
  rank: (input) => {
    const ps = personalScores(input, input.candidates);
    return rank({ ...input, orderScore: new Map([...ps].map(([k, v]) => [k, v.order])) });
  },
};
export type { Rating };
