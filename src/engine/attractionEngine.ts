/**
 * v4.0 · Adaptador del motor de atractivo a la interfaz de motores de la app (RecommenderEngine).
 * El cálculo está en ./attraction (método ganador, sin cambios). Este archivo sólo arma los ítems que muestra la app.
 */
import { hybridEngine, type RankInput, type RecommenderEngine } from './recommender';
import { ATTRACTION_ENGINE_VERSION, compatibilityLevel, makeExplainer, rankAttraction, scoreAttraction } from './attraction';
import type { RecommendationItem, TitleKey } from '../types';

const clip = (x: number) => Math.max(1, Math.min(10, x));
/** Con menos de estas notas posteriores a recomendaciones de v4.0, la satisfacción estimada se marca «poco fiable». */
export const SATISFACTION_MIN_EVIDENCE = 8;

export function rankWithAttraction(input: RankInput): RecommendationItem[] {
  const ctx = input.attraction;
  if (!ctx) return [];
  const byKey = new Map(input.ratings.map((r) => [r.key, r]));
  const cands = input.candidates.filter((k) => {
    const r = byKey.get(k);
    if (r?.notInterested || r?.list === 'abandoned') return false;
    return input.includeWatched || !r?.watched;
  });
  const scores = scoreAttraction(ctx, cands);
  const sorted = scores.map((s) => s.attraction).sort((a, b) => a - b);
  const pct = (v: number) => { if (sorted.length < 2) return 1; let lo = 0; while (lo < sorted.length && sorted[lo] < v) lo++; return lo / (sorted.length - 1); };
  const ranked = rankAttraction(scores, ctx.idx, input.limit ?? 200);
  const explain = makeExplainer(ctx, (k: TitleKey) => input.titles.get(k)?.title);
  const reliable = false; // se habilita cuando haya evidencia (ver SATISFACTION_MIN_EVIDENCE y Estadísticas)
  return ranked.map((s, i) => {
    const ex = explain(s);
    const percentile = pct(s.attraction);
    const level = compatibilityLevel(percentile);
    const explanation: string[] = [];
    if (ex.pros.length) explanation.push(`Coincide con tu perfil: ${ex.pros.join(', ').toLowerCase()}.`);
    if (ex.similar.length) explanation.push(`Se parece a lo que te atrajo: ${ex.similar.join(' y ')}.`);
    if (ex.cons.length) explanation.push(`Podría no gustarte: ${ex.cons.join(', ').toLowerCase()}.`);
    if (!explanation.length) explanation.push('Se parece a títulos que te atrajeron (por argumento y rasgos narrativos).');
    return {
      key: s.key, rank: i + 1, score: clip(s.satisfaction), confidence: 0.3, confidenceLabel: 'baja' as const,
      explanation, exploration: false, provisional: true,
      attraction: { value: Math.round(s.attraction * 100) / 100, percentile, level, satisfaction: Math.round(clip(s.satisfaction) * 10) / 10, satisfactionReliable: reliable, pros: ex.pros, cons: ex.cons, similar: ex.similar },
    };
  });
}

export const attractionEngine: RecommenderEngine = {
  version: ATTRACTION_ENGINE_VERSION,
  buildProfile: hybridEngine.buildProfile,
  rank: rankWithAttraction,
};
