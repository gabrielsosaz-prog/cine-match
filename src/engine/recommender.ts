import { DIMENSIONS } from '../constants';
import type { DimensionId, ProfileSettings, Rating, RecommendationItem, TitleKey, TitleMeta } from '../types';
import { computeIdf, cosine, describeFeatures, family, FAMILY_WEIGHT, featureLabel, rawFeatures, weightedVector, type FeatureVec } from './features';
import { buildProfile, LEARNING, type UserProfile } from './profile';

export const ALGORITHM_VERSION = 'hybrid-content-1.0.0';

/** Interfaz modular: cualquier motor que la implemente puede reemplazar al actual. */
export interface RecommenderEngine {
  version: string;
  buildProfile(ratings: Rating[], titles: Map<TitleKey, TitleMeta>, settings?: Partial<ProfileSettings>): UserProfile;
  rank(input: RankInput): RecommendationItem[];
}

export interface RankInput {
  profile: UserProfile;
  ratings: Rating[];
  titles: Map<TitleKey, TitleMeta>; // historial + candidatos
  candidates: TitleKey[];
  settings?: Partial<ProfileSettings>;
  limit?: number;
  /** semilla para la exploración (estable por día) */
  seed?: number;
}

export const PARAMS = {
  contentGain: 1.7,
  knnGain: 1.3,
  qualityGain: 0.3,
  knnK: 10,
  mmrLambda: 0.8,
  explorationEvery: 6, // 1 de cada N posiciones se reserva a exploración
  minExplorationQuality: 7.0,
};

interface Scored {
  key: TitleKey;
  pred: number;
  confidence: number;
  vec: FeatureVec;
  contributions: { f: string; c: number }[];
  neighbors: { key: TitleKey; sim: number; dev: number }[];
  quality: number;
  novelty: number;
}

function bayesQuality(t: TitleMeta): number {
  const va = t.voteAverage ?? 0, vc = t.voteCount ?? 0;
  return (va * vc + 6.6 * 300) / (vc + 300);
}

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function scoreCandidates(input: RankInput): Scored[] {
  const { profile, titles } = input;
  const rated = profile.signals.filter((s) => titles.has(s.key));
  const corpusKeys = [...new Set([...rated.map((s) => s.key), ...input.candidates])].filter((k) => titles.has(k));
  const raw = new Map(corpusKeys.map((k) => [k, rawFeatures(titles.get(k)!)]));
  const idf = computeIdf([...raw.values()]);
  const vecs = new Map([...raw].map(([k, fs]) => [k, weightedVector(fs, idf)]));

  const out: Scored[] = [];
  for (const key of input.candidates) {
    const t = titles.get(key);
    if (!t) continue;
    const vec = vecs.get(key)!;
    // 1) Afinidad basada en contenido: promedio ponderado de afinidades aprendidas
    let num = 0, den = 0, evid = 0;
    const contributions: { f: string; c: number }[] = [];
    for (const [f, w] of vec) {
      const fa = profile.features.get(f);
      if (!fa) continue;
      num += w * fa.affinity; den += w; evid += Math.min(fa.evidence, 4) * (FAMILY_WEIGHT[family(f)] ?? 0.3);
      contributions.push({ f, c: w * fa.affinity });
    }
    const content = den ? num / (den + 1.5) : 0;
    // 2) Similitud con títulos del historial (kNN ítem-ítem)
    const neigh = rated
      .map((s) => ({ key: s.key, sim: cosine(vec, vecs.get(s.key)!), dev: Math.max(-LEARNING.maxDeviation, Math.min(LEARNING.maxDeviation, s.value - profile.mean)), w: s.weight }))
      .filter((n) => n.sim > 0.05)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, PARAMS.knnK);
    let kn = 0, kd = 0.6;
    for (const n of neigh) { kn += n.sim * n.w * n.dev; kd += n.sim * n.w; }
    const knn = kn / kd;
    // 3) Calidad general (sólo como desempate suave; no domina el ranking)
    const quality = bayesQuality(t);
    const pred = Math.max(1, Math.min(10, profile.mean + PARAMS.contentGain * content + PARAMS.knnGain * knn + PARAMS.qualityGain * (quality - 6.6)));
    const simMass = neigh.reduce((a, n) => a + n.sim, 0);
    const confidence = (1 - Math.exp(-(evid + 3 * simMass) / 8)) * (1 - Math.exp(-profile.ratedCount / 6));
    out.push({ key, pred, confidence, vec, contributions: contributions.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)), neighbors: neigh.map(({ key, sim, dev }) => ({ key, sim, dev })), quality, novelty: 1 - Math.min(1, evid / 6) });
  }
  return out;
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

/** Explicaciones basadas sólo en rasgos reales del título y en el historial efectivo. Sin spoilers. */
export function explain(s: Scored, input: RankInput, info: ReturnType<typeof describeFeatures>, exploration: boolean): string[] {
  const { profile, titles } = input;
  const lines: string[] = [];
  const ratingByKey = new Map(input.ratings.map((r) => [r.key, r]));
  if (exploration) {
    lines.push(`Exploración: es distinto de lo que solés ver y el público lo valora bien (${fmt(titles.get(s.key)?.voteAverage ?? 0)} en TMDB). Sirve para descubrir gustos nuevos.`);
  }
  const pos = s.contributions.filter((c) => c.c > 0.05 && !info.get(c.f)?.spoiler && ['g', 'k', 'd', 'c'].includes(family(c.f)));
  const genres = pos.filter((c) => family(c.f) === 'g').slice(0, 2);
  const themes = pos.filter((c) => family(c.f) === 'k').slice(0, 2);
  const people = pos.filter((c) => family(c.f) === 'd' || family(c.f) === 'c').slice(0, 1);
  if (genres.length) {
    const parts = genres.map((g) => featureLabel(g.f, info));
    const fa = profile.features.get(genres[0].f)!;
    lines.push(`Coincide con géneros que puntuás alto: ${list(parts)} (${fa.count} ${fa.count === 1 ? 'título' : 'títulos'} en tu historial).`);
  }
  if (themes.length) lines.push(`Comparte temáticas que te gustaron: ${list(themes.map((t) => `«${featureLabel(t.f, info)}»`))}.`);
  if (people.length) {
    const f = people[0].f;
    lines.push(`${family(f) === 'd' ? (titles.get(s.key)?.type === 'tv' ? 'De' : 'Dirigida por') : 'Con'} ${featureLabel(f, info)}, presente en títulos que valoraste bien.`);
  }
  const good = s.neighbors.filter((n) => n.dev > 0.5 && n.sim > 0.2).slice(0, 3);
  if (good.length) {
    const names = good.map((n) => {
      const r = ratingByKey.get(n.key);
      const t = titles.get(n.key)?.title ?? 'un título';
      return r?.overall !== undefined ? `${t} (${fmt(r.overall)})` : t;
    });
    lines.push(`Se parece a ${list(names)}, que ${good.length === 1 ? 'puntuaste' : 'puntuaste'} por encima de tu media.`);
  }
  // Dimensión destacada: dónde puntuás más alto en títulos con los rasgos que comparte
  const dimAgg = new Map<DimensionId, { s: number; n: number }>();
  for (const c of pos.slice(0, 6)) {
    const fd = profile.featureDims.get(c.f);
    if (!fd) continue;
    for (const [d, v] of Object.entries(fd) as [DimensionId, { mean: number; n: number }][]) {
      const a = dimAgg.get(d) ?? { s: 0, n: 0 }; a.s += v.mean * v.n; a.n += v.n; dimAgg.set(d, a);
    }
  }
  const bestDim = [...dimAgg].map(([d, a]) => ({ d, mean: a.s / a.n, n: a.n })).filter((x) => x.n >= 2)
    .map((x) => ({ ...x, lift: x.mean - (profile.dimensions.find((d) => d.id === x.d)?.mean ?? x.mean) }))
    .sort((a, b) => b.mean + b.lift - (a.mean + a.lift))[0];
  if (bestDim && bestDim.mean >= 7.5) {
    const label = DIMENSIONS.find((d) => d.id === bestDim.d)!.label.toLowerCase();
    lines.push(`En títulos con estos rasgos valoraste especialmente ${label} (${fmt(bestDim.mean)} de promedio).`);
  }
  const neg = s.contributions.filter((c) => c.c < -0.15 && !info.get(c.f)?.spoiler && ['g', 'k'].includes(family(c.f))).slice(0, 2);
  if (neg.length && !exploration) lines.push(`A tener en cuenta: incluye ${list(neg.map((n) => featureLabel(n.f, info)))}, que solés puntuar más bajo.`);
  if (!lines.length || (lines.length === 1 && exploration)) {
    if (profile.ratedCount === 0) lines.push('Elegida por su buena valoración del público y su disponibilidad en tus plataformas.');
    else if (!exploration) lines.push('Coincidencias leves con tu historial; la nota estimada se apoya sobre todo en la valoración del público.');
  }
  if (profile.ratedCount < 5) lines.push(`Recomendación provisional: tenés ${profile.ratedCount} ${profile.ratedCount === 1 ? 'valoración' : 'valoraciones'}; mejora a medida que puntuás más.`);
  return lines;
}

/** Ranking final: afinidad, exclusiones, diversificación (MMR) y espacios de exploración. */
export function rank(input: RankInput): RecommendationItem[] {
  const limit = input.limit ?? 30;
  const excluded = new Set(input.ratings.map((r) => r.key)); // vistas, puntuadas, pendientes y rechazadas
  const excludedGenres = new Set(input.settings?.excludedGenres ?? []);
  const candidates = [...new Set(input.candidates)].filter((k) => !excluded.has(k) && input.titles.has(k))
    .filter((k) => !input.titles.get(k)!.genres.some((g) => excludedGenres.has(g.id)));
  const scored = scoreCandidates({ ...input, candidates });
  const info = describeFeatures([...input.titles.values()]);
  const rand = mulberry32(input.seed ?? 1);

  const pool = [...scored].sort((a, b) => b.pred - a.pred);
  const explorePool = scored
    .filter((s) => s.novelty > 0.6 && s.quality >= PARAMS.minExplorationQuality)
    .sort((a, b) => b.quality * (0.8 + 0.4 * rand()) - a.quality * (0.8 + 0.4 * rand()));
  const selected: { s: Scored; exploration: boolean }[] = [];
  const used = new Set<TitleKey>();
  const maxSim = (s: Scored) => selected.reduce((m, x) => Math.max(m, cosine(s.vec, x.s.vec)), 0);
  const useExploration = input.profile.ratedCount >= 3;

  while (selected.length < limit && used.size < scored.length) {
    const pos = selected.length + 1;
    if (useExploration && pos % PARAMS.explorationEvery === 0) {
      const e = explorePool.find((x) => !used.has(x.key));
      if (e) { selected.push({ s: e, exploration: true }); used.add(e.key); continue; }
    }
    let best: Scored | undefined, bestVal = -Infinity;
    for (const s of pool) {
      if (used.has(s.key)) continue;
      const val = PARAMS.mmrLambda * ((s.pred - 1) / 9) - (1 - PARAMS.mmrLambda) * maxSim(s);
      if (val > bestVal) { bestVal = val; best = s; }
      if (s.pred < (best?.pred ?? 0) - 2.5) break; // poda: el resto ya no puede ganar
    }
    if (!best) break;
    selected.push({ s: best, exploration: false }); used.add(best.key);
  }

  return selected.map(({ s, exploration }, i) => ({
    key: s.key,
    rank: i + 1,
    score: Math.round(s.pred * 10) / 10,
    confidence: Math.round(s.confidence * 100) / 100,
    confidenceLabel: s.confidence < 0.35 ? 'baja' : s.confidence < 0.65 ? 'media' : 'alta',
    explanation: explain(s, input, info, exploration),
    exploration,
    provisional: input.profile.ratedCount < 5,
  }));
}

/** Títulos similares a uno dado (para la ficha), con el mismo modelo de rasgos. */
export function similarTo(key: TitleKey, titles: Map<TitleKey, TitleMeta>, candidates: TitleKey[], limit = 10): { key: TitleKey; sim: number }[] {
  const keys = [key, ...candidates.filter((k) => k !== key && titles.has(k))];
  const raw = new Map(keys.map((k) => [k, rawFeatures(titles.get(k)!)]));
  const idf = computeIdf([...raw.values()]);
  const base = weightedVector(raw.get(key)!, idf);
  return keys.slice(1).map((k) => ({ key: k, sim: cosine(base, weightedVector(raw.get(k)!, idf)) })).sort((a, b) => b.sim - a.sim).slice(0, limit);
}

export const hybridEngine: RecommenderEngine = {
  version: ALGORITHM_VERSION,
  buildProfile: (ratings, titles, settings) => buildProfile(ratings, titles, settings?.dimensionWeights),
  rank,
};
