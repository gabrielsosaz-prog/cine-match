import { DIMENSIONS } from '../constants';
import type { ChannelContribution, ChannelId, DimensionId, DimensionScores, ProfileSettings, Rating, RecommendationItem, TitleKey, TitleMeta } from '../types';
import { computeIdf, cosine, describeFeatures, family, FAMILY_WEIGHT, featureLabel, rawFeatures, weightedVector, type FeatureVec } from './features';
import { buildProfile, LEARNING, participation, type UserProfile } from './profile';
import { conceptsOfTitle } from './comments';
import { rejectionPenalty, type RejectionResult } from './rejections';
import { SPOILER_PATTERN } from './keywordsEs';
import { textCosine, textIdf, textVector, tokens } from './text';
import { narrativeFromMeta, pairSimilarity, type Narrative, type NarrativeIndex } from './narrative';

/**
 * v3.4.0: mismos canales, pesos y perfil que hybrid-narrative-3.1.0. Cambia sólo el ORDEN:
 *  1. ordena por la suma de canales sin recortar a 10 (antes muchos títulos empataban en 10 y el orden entre ellos
 *     lo decidía la diversidad, por eso quitar una valoración cambiaba hasta 9 de los 10 primeros);
 *  2. como máximo 1 título por saga de TMDB en el top 10.
 * La nota mostrada sigue recortada a 1-10. Decidido en el conjunto de desarrollo y confirmado en el de evaluación
 * contra una referencia editorial independiente (docs/eval-v3.4.md). `rankBy: 'capped', collectionCap: false`
 * reproduce exactamente el orden de 3.1.0.
 */
export const ALGORITHM_VERSION = 'hybrid-narrative-3.4.0';

/** Índice narrativo por defecto (lo fija la app al cargar el catálogo; en pruebas puede no existir). */
let defaultNarrative: NarrativeIndex | undefined;
export const setDefaultNarrative = (idx: NarrativeIndex | undefined) => { defaultNarrative = idx; };
export const getDefaultNarrative = () => defaultNarrative;

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
  /** false (predeterminado): excluye títulos marcados como vistos. true: sólo evalúa los candidatos dados. */
  includeWatched?: boolean;
  /** Candidatos que entraron por una búsqueda extra (filtros) y tienen poca evidencia propia */
  lowEvidence?: Set<TitleKey>;
  /** v3.1: índice narrativo (vectores semánticos y rasgos). Sin él, el canal narrativo queda en 0 (desconocido). */
  narrative?: NarrativeIndex | null;
  /**
   * Orden. Predeterminado (3.4.0): 'uncapped', la suma de canales sin recortar. 'capped' = orden de 3.1.0
   * (la nota mostrada siempre se recorta a 1-10, en ambos casos).
   */
  rankBy?: 'capped' | 'uncapped';
  /** Como máximo 1 título por saga/colección de TMDB en el top 10. Predeterminado (3.4.0): sí. */
  collectionCap?: boolean;
  /**
   * v3.5: puntaje de orden externo (escala de nota) de un modelo personal. Si está, ordena con él en lugar de la
   * suma de canales, y el puesto de exploración se elige por ese puntaje (personalizado) y no por la nota pública.
   */
  orderScore?: Map<TitleKey, number>;
  /** v4.0: contexto del motor de atractivo (perfil de gustos, respuestas de interés, catálogo). Otros motores lo ignoran. */
  attraction?: import('./attraction').AttractionContext;
}

/**
 * Canales del motor v3.0. Cada canal mide UNA fuente de evidencia, en puntos de nota respecto de tu media.
 * Peso previo (`prior`): el valor validado en v2.1 para la misma señal (o su reparto entre canales nuevos).
 * Con suficientes valoraciones los pesos se re-estiman con validación cruzada sobre TUS notas (ver learnChannelWeights),
 * regularizados hacia el previo y acotados por `max` para que ningún canal domine.
 */
export const CHANNELS: { id: ChannelId; label: string; prior: number; max: number; learn: boolean }[] = [
  { id: 'theme', label: 'Temáticas y elementos narrativos', prior: 1.0, max: 2.5, learn: true },
  { id: 'comments', label: 'Lo que escribiste en «Otros»', prior: 0.9, max: 2, learn: true },
  { id: 'aspects', label: 'Aspectos que puntuaste', prior: 1.4, max: 3, learn: true },
  { id: 'actors', label: 'Actores', prior: 0.8, max: 2, learn: true },
  { id: 'crew', label: 'Dirección y guion', prior: 0.7, max: 2, learn: true },
  { id: 'narrative', label: 'Parecido narrativo con lo que puntuaste (argumento y rasgos)', prior: 1.2, max: 3, learn: true },
  { id: 'similar', label: 'Parecido con títulos que puntuaste (etiquetas)', prior: 0.9, max: 3, learn: true },
  { id: 'genre', label: 'Géneros (acotado)', prior: 0.6, max: 0.9, learn: true },
  { id: 'format', label: 'Formato, época e idioma', prior: 0.4, max: 0.8, learn: true },
  { id: 'rejection', label: 'Descartes («No me interesa»)', prior: 1, max: 1, learn: false },
  { id: 'quality', label: 'Valoración del público (auxiliar)', prior: 0.3, max: 0.35, learn: true },
];
export const CHANNEL_LABEL = Object.fromEntries(CHANNELS.map((c) => [c.id, c.label])) as Record<ChannelId, string>;
const CH_FAMILIES: Partial<Record<ChannelId, Set<string>>> = {
  theme: new Set(['k', 'end']),
  crew: new Set(['d', 'w']),
  genre: new Set(['g']),
  format: new Set(['t', 'era', 'len', 'lang', 'seas']),
};

export const PARAMS = {
  aspectEstimateGain: 1.8,
  /** tope del aporte del canal de géneros, en puntos: el género orienta pero no decide */
  genreCap: 1.0,
  knnK: 10,
  /** peso de la similitud léxica de sinopsis dentro del canal de similitud */
  textSimShare: 0.2,
  mmrLambda: 0.8,
  explorationEvery: 6, // 1 de cada N posiciones se reserva a exploración
  minExplorationQuality: 7.0,
  /** en el top 10, como máximo N títulos impulsados por un mismo actor */
  maxPerActorTop10: 2,
  // Compatibilidad con pruebas v2.1
  actorGain: 0.8,
};

export interface ChannelWeights {
  weights: Record<ChannelId, number>;
  learned: boolean;
  /** valoraciones usadas en la validación cruzada */
  n: number;
  /** error cuadrático medio fuera de muestra: sólo tu media vs. pesos previos; y ajuste de los pesos aprendidos */
  rmse?: { baseline: number; prior: number; learned: number };
  folds?: number;
}

export const priorWeights = (): Record<ChannelId, number> => Object.fromEntries(CHANNELS.map((c) => [c.id, c.prior])) as Record<ChannelId, number>;

interface Scored {
  key: TitleKey;
  pred: number;
  /** v3.4: suma sin recortar a 1-10 (se usa para ordenar; la nota mostrada es `pred`) */
  predRaw: number;
  confidence: number;
  vec: FeatureVec;
  /** valor crudo de cada canal (puntos, antes del peso) */
  raw: Record<ChannelId, number>;
  channels: ChannelContribution[];
  contributions: { f: string; c: number }[];
  neighbors: { key: TitleKey; sim: number; dev: number }[];
  narrNeighbors: { key: TitleKey; sim: number; dev: number }[];
  quality: number;
  novelty: number;
  aspects: { d: DimensionId; dev: number; evidence: number; weighted: number }[];
  dimensionEstimates: DimensionScores;
  actors: { id: number; name: string; c: number; count: number; actingCount: number }[];
  concepts: { id: string; label: string; c: number; sources: TitleKey[] }[];
  rejection: RejectionResult;
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
  const W0 = profile.channelWeights?.weights ?? priorWeights();
  const nidxAvail = input.narrative === null ? undefined : input.narrative ?? defaultNarrative;
  // Sin índice narrativo, el parecido por etiquetas vuelve a cargar con el peso que tenía en v3.0 (1,3)
  const W = nidxAvail ? W0 : { ...W0, similar: profile.channelWeights?.learned ? W0.similar : 1.3 };
  const rated = profile.signals.filter((s) => titles.has(s.key));
  const corpusKeys = [...new Set([...rated.map((s) => s.key), ...input.candidates])].filter((k) => titles.has(k));
  const raw = new Map(corpusKeys.map((k) => [k, rawFeatures(titles.get(k)!)]));
  const idf = computeIdf([...raw.values()]);
  const vecs = new Map([...raw].map(([k, fs]) => [k, weightedVector(fs, idf)]));
  // Sinopsis (similitud léxica, no semántica)
  const toks = new Map(corpusKeys.map((k) => [k, tokens(titles.get(k)!.overview)]));
  const tIdf = textIdf([...toks.values()]);
  const tvecs = new Map([...toks].map(([k, ts]) => [k, textVector(ts, tIdf)]));
  const ratedVecs = rated.map((s) => ({ s, vec: vecs.get(s.key)!, tv: tvecs.get(s.key)! }));
  // v3.1: representación narrativa (catálogo precalculado; si un título no está, sólo rasgos de sus palabras clave)
  const nidx = input.narrative === null ? undefined : input.narrative ?? defaultNarrative;
  const narrOf = new Map<TitleKey, Narrative>();
  const getNarr = (k: TitleKey) => { let n = narrOf.get(k); if (!n) { const m = titles.get(k)!; n = nidx ? nidx.narrativeOf(k, m)! : narrativeFromMeta(m); narrOf.set(k, n); } return n; };
  const ratedNarr = nidx ? rated.map((s) => ({ s, n: getNarr(s.key) })) : [];

  const out: Scored[] = [];
  for (const key of input.candidates) {
    const t = titles.get(key);
    if (!t) continue;
    const vec = vecs.get(key)!;
    // A/D/F/formato) Afinidad por familia de rasgos: promedio ponderado de afinidades aprendidas, contraído
    const fam: Record<string, { num: number; den: number; evid: number }> = {};
    const contributions: { f: string; c: number }[] = [];
    let evid = 0;
    for (const [f, w] of vec) {
      const fa = profile.features.get(f);
      if (!fa) continue;
      const fm = family(f);
      const a = (fam[fm] ??= { num: 0, den: 0, evid: 0 });
      a.num += w * fa.affinity; a.den += w; a.evid += Math.min(fa.evidence, 4);
      evid += Math.min(fa.evidence, 4) * (FAMILY_WEIGHT[fm] ?? 0.3);
      contributions.push({ f, c: w * fa.affinity });
    }
    const famChannel = (id: ChannelId) => {
      let num = 0, den = 0, ev = 0;
      for (const fm of CH_FAMILIES[id]!) { const a = fam[fm]; if (a) { num += a.num; den += a.den; ev += a.evid; } }
      return { v: den ? num / (den + 1.5) : 0, ev };
    };
    const theme = famChannel('theme'), crew = famChannel('crew'), genre = famChannel('genre'), format = famChannel('format');
    // E) Parecido con títulos del historial (kNN ítem-ítem sobre rasgos + sinopsis léxica)
    const tv = tvecs.get(key)!;
    const neigh = ratedVecs
      .filter((r) => r.s.key !== key) // sin autorreferencia: un título visto no se recomienda por su propia nota
      .map((r) => ({ key: r.s.key, sim: (1 - PARAMS.textSimShare) * cosine(vec, r.vec) + PARAMS.textSimShare * textCosine(tv, r.tv), dev: Math.max(-LEARNING.maxDeviation, Math.min(LEARNING.maxDeviation, r.s.value - profile.mean)), w: r.s.weight }))
      .filter((n) => n.sim > 0.05)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, PARAMS.knnK);
    let kn = 0, kd = 0.6;
    for (const n of neigh) { kn += n.sim * n.w * n.dev; kd += n.sim * n.w; }
    const knn = kn / kd;
    // J) Parecido narrativo (v3.1): kNN sobre la similitud narrativa (semántica calibrada + rasgos + temáticas raras)
    let narrNum = 0, narrDen = 0.6, narrEvid = 0;
    const narrNeighbors: { key: TitleKey; sim: number; dev: number }[] = [];
    if (nidx && ratedNarr.length) {
      const cn = getNarr(key);
      const sims = ratedNarr.filter((r) => r.s.key !== key).map((r) => ({ key: r.s.key, sim: pairSimilarity(r.n, cn, nidx).score, dev: Math.max(-LEARNING.maxDeviation, Math.min(LEARNING.maxDeviation, r.s.value - profile.mean)), w: r.s.weight }))
        .filter((x) => x.sim > 0.2).sort((a, b) => b.sim - a.sim).slice(0, PARAMS.knnK);
      for (const x of sims) { narrNum += x.sim * x.w * x.dev; narrDen += x.sim * x.w; narrEvid += x.sim; narrNeighbors.push({ key: x.key, sim: x.sim, dev: x.dev }); }
    }
    const narrative = narrNum / narrDen;
    // B) Aspectos: qué tan bien te resultan, aspecto por aspecto, los rasgos de este título,
    //    ponderado por cuánto pesa cada aspecto en tus notas generales (0 si nunca lo puntuaste).
    const aspects: Scored['aspects'] = [];
    const dimensionEstimates: DimensionScores = {};
    let aspectChannel = 0, aspectEvid = 0;
    for (const ds of profile.dimensions) {
      const dmap = profile.dimFeatures.get(ds.id);
      if (!dmap || Number.isNaN(ds.mean)) continue;
      let dn = 0, dd = 0, dev_ = 0;
      for (const [f, w] of vec) { const fa = dmap.get(f); if (!fa) continue; dn += w * fa.affinity; dd += w; dev_ += Math.min(fa.evidence, 4) * (FAMILY_WEIGHT[family(f)] ?? 0.3); }
      if (!dd) continue;
      const dev = dn / (dd + 1.5);
      aspects.push({ d: ds.id, dev, evidence: dev_, weighted: ds.weight * dev });
      aspectChannel += ds.weight * dev; aspectEvid += dev_ * ds.weight;
      if (dev_ >= 1.5) dimensionEstimates[ds.id] = Math.round(Math.max(1, Math.min(5, 1 + ((ds.mean + PARAMS.aspectEstimateGain * dev - 1) * 4) / 9)) * 10) / 10;
    }
    aspects.sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted));
    // C) Actores: afinidad aprendida, ponderada por la participación del actor en ESTE título y por la confianza
    //    (cantidad de observaciones). Un actor visto una sola vez aporta poco.
    let actorNum = 0, actorDen = 1, actorEvid = 0;
    const actors: Scored['actors'] = [];
    for (const p of t.cast.slice(0, 8)) {
      const a = profile.actors.get(p.id);
      const part = participation(p, t);
      actorDen += part;
      if (!a) continue;
      const conf = a.count / (a.count + 1);
      const c = part * a.affinity * conf;
      actorNum += c; actorEvid += a.evidence;
      actors.push({ id: p.id, name: p.name, c, count: a.count, actingCount: a.actingCount ?? a.count });
    }
    const actorChannel = actorNum / actorDen;
    actors.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    // A') Comentarios «Otros»: conceptos que mencionaste, relacionados con palabras clave y géneros de TMDB del candidato
    const concepts: Scored['concepts'] = [];
    let commentChannel = 0;
    if (profile.concepts.size) {
      for (const id of conceptsOfTitle(t, (n) => SPOILER_PATTERN.test(n))) {
        const cp = profile.concepts.get(id);
        if (!cp) continue;
        concepts.push({ id, label: cp.label, c: cp.score, sources: cp.sources.filter((x) => x.key !== key && Math.sign(x.polarity) === Math.sign(cp.score)).map((x) => x.key) });
      }
      concepts.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
      commentChannel = concepts.reduce((acc, c, i) => acc + c.c / (1 + i), 0) / Math.max(1, Math.sqrt(concepts.length));
    }
    // G) Descartes jerárquicos (saga → subgénero → género), con excepciones positivas
    const rejection = rejectionPenalty(t, profile.rejections);
    // H) Calidad pública: auxiliar y acotada; nunca domina
    const quality = bayesQuality(t);
    const rawCh: Record<ChannelId, number> = {
      theme: theme.v, comments: commentChannel, aspects: aspectChannel, actors: actorChannel, crew: crew.v,
      narrative, similar: knn, genre: genre.v, format: format.v, rejection: rejection.penalty, quality: quality - 6.6,
    };
    const evidence: Record<ChannelId, number> = {
      theme: theme.ev, comments: concepts.length, aspects: aspectEvid, actors: actorEvid, crew: crew.ev,
      narrative: narrEvid, similar: neigh.reduce((a, n) => a + n.sim, 0), genre: genre.ev, format: format.ev, rejection: profile.rejections.count, quality: t.voteCount ?? 0,
    };
    const channels: ChannelContribution[] = CHANNELS.map((c) => {
      let contribution = W[c.id] * rawCh[c.id];
      if (c.id === 'genre') contribution = Math.max(-PARAMS.genreCap, Math.min(PARAMS.genreCap, contribution));
      return { id: c.id, value: rawCh[c.id], weight: W[c.id], contribution, evidence: evidence[c.id] };
    });
    const predRaw = profile.mean + channels.reduce((a, c) => a + c.contribution, 0);
    const pred = Math.max(1, Math.min(10, predRaw));
    const simMass = evidence.similar + evidence.narrative;
    const confidence = (1 - Math.exp(-(evid + 3 * simMass + 0.5 * Math.min(actorEvid, 4)) / 8)) * (1 - Math.exp(-profile.ratedCount / 6));
    out.push({ key, pred, predRaw, confidence, vec, raw: rawCh, channels, contributions: contributions.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)), neighbors: neigh.map(({ key, sim, dev }) => ({ key, sim, dev })), narrNeighbors, quality, novelty: 1 - Math.min(1, evid / 6), aspects, dimensionEstimates, actors, concepts, rejection });
  }
  return out;
}

/** Resuelve A x = b (A simétrica definida positiva por la regularización). */
function solveSym(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}

export const STACKING = {
  /** valoraciones explícitas mínimas para re-estimar pesos (con menos, se usan los previos) */
  minRatings: 12,
  folds: 5,
  /** el previo equivale a N valoraciones: hacen falta muchas notas para alejar un peso de su valor justificado */
  priorStrength: 10,
};

let cwCache: { sig: string; value: ChannelWeights } | undefined;

/**
 * Pesos de canal personalizados por validación cruzada («stacking» regularizado):
 *  1) se separan tus valoraciones en 5 grupos; para cada grupo se aprende el perfil con los otros 4;
 *  2) se calcula, para cada título del grupo, el valor de cada canal SIN haber visto su nota (fuera de muestra);
 *  3) regresión ridge de tu desvío real sobre esos valores, regularizada hacia los pesos previos
 *     (λ_c = priorStrength × E[x_c²]), con pesos no negativos y topes por canal.
 * Así un canal sólo gana peso si predice TUS notas mejor de lo esperado. Con menos de 12 valoraciones se usan los previos.
 */
export function learnChannelWeights(ratings: Rating[], allTitles: Map<TitleKey, TitleMeta>, manual: Partial<Record<DimensionId, number>> = {}): ChannelWeights {
  const prior = priorWeights();
  // Sólo hacen falta las fichas de tu historial (el resultado no depende de qué candidatos haya en memoria)
  const titles = new Map<TitleKey, TitleMeta>();
  for (const r of ratings) { const t = allTitles.get(r.key); if (t) titles.set(r.key, t); }
  const explicit = ratings.filter((r) => (r.overall !== undefined || Object.keys(r.dimensions).length > 0) && titles.has(r.key) && !r.notInterested);
  if (explicit.length < STACKING.minRatings) return { weights: prior, learned: false, n: explicit.length };
  const sig = ratings.map((r) => `${r.key}:${r.updatedAt}:${titles.get(r.key)?.fetchedAt ?? 0}`).sort().join('|') + `#${JSON.stringify(manual)}`;
  if (cwCache?.sig === sig) return cwCache.value;
  const keys = explicit.map((r) => r.key).sort();
  // Asignación determinística a grupos (hash de la clave): mismo resultado en cada cálculo
  const fold = (k: string) => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; return Math.abs(h) % STACKING.folds; };
  const learnIds = CHANNELS.filter((c) => c.learn).map((c) => c.id);
  const allSignals = buildProfile(ratings, titles, manual).signals.filter((s) => s.kind === 'overall' || s.kind === 'aspects');
  const X: number[][] = [], Y: number[] = [], Wt: number[] = [], fixed: number[] = [];
  for (let f = 0; f < STACKING.folds; f++) {
    const held = new Set(keys.filter((k) => fold(k) === f));
    if (!held.size) continue;
    const train = ratings.filter((r) => !held.has(r.key));
    const p = buildProfile(train, titles, manual);
    const heldSignals = allSignals.filter((s) => held.has(s.key));
    const scored = scoreCandidates({ profile: p, ratings: train, titles, candidates: heldSignals.map((s) => s.key) });
    const byKey = new Map(scored.map((s) => [s.key, s]));
    for (const s of heldSignals) {
      const sc = byKey.get(s.key);
      if (!sc) continue;
      X.push(learnIds.map((id) => sc.raw[id]));
      Y.push(s.value - p.mean);
      Wt.push(s.weight);
      fixed.push(sc.raw.rejection * prior.rejection);
    }
  }
  const n = Y.length, m = learnIds.length;
  if (n < STACKING.minRatings) return { weights: prior, learned: false, n };
  const w0 = learnIds.map((id) => prior[id]);
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  const ex2 = new Array(m).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < m; a++) ex2[a] += X[i][a] ** 2 / n;
  for (let i = 0; i < n; i++) {
    const y = Y[i] - fixed[i];
    for (let a = 0; a < m; a++) { b[a] += Wt[i] * X[i][a] * y; for (let c = 0; c < m; c++) A[a][c] += Wt[i] * X[i][a] * X[i][c]; }
  }
  for (let a = 0; a < m; a++) { const lam = STACKING.priorStrength * Math.max(ex2[a], 1e-4); A[a][a] += lam; b[a] += lam * w0[a]; }
  const sol = solveSym(A, b);
  const weights = { ...prior };
  learnIds.forEach((id, a) => { const max = CHANNELS.find((c) => c.id === id)!.max; weights[id] = Math.max(0, Math.min(max, Number.isFinite(sol[a]) ? sol[a] : prior[id])); });
  const rmse = (w: Record<ChannelId, number> | null) => Math.sqrt(X.reduce((acc, x, i) => {
    const pr = w ? learnIds.reduce((s2, id, a) => s2 + w[id] * x[a], 0) + fixed[i] : 0;
    return acc + (Y[i] - pr) ** 2;
  }, 0) / n);
  const value: ChannelWeights = { weights, learned: true, n, folds: STACKING.folds, rmse: { baseline: rmse(null), prior: rmse(prior), learned: rmse(weights) } };
  cwCache = { sig, value };
  return value;
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
  const pos = s.contributions.filter((c) => c.c > 0.05 && !info.get(c.f)?.spoiler && ['g', 'k', 'd', 'w'].includes(family(c.f)));
  const genres = pos.filter((c) => family(c.f) === 'g').slice(0, 2);
  const themes = pos.filter((c) => family(c.f) === 'k').slice(0, 3);
  const people = pos.filter((c) => family(c.f) === 'd' || family(c.f) === 'w').slice(0, 1);
  const genreContribution = s.channels.find((c) => c.id === 'genre')?.contribution ?? 0;
  // v3.0: primero lo específico (temáticas, autores); el género sólo se menciona si de verdad aporta
  if (themes.length) lines.push(`Comparte temáticas que te gustaron: ${list(themes.map((t) => `«${featureLabel(t.f, info)}»`))}.`);
  if (genres.length && genreContribution > 0.15) {
    const parts = genres.map((g) => featureLabel(g.f, info));
    const fa = profile.features.get(genres[0].f)!;
    lines.push(`Coincide con géneros que puntuás alto: ${list(parts)} (${fa.count} ${fa.count === 1 ? 'título' : 'títulos'} en tu historial).`);
  }
  if (people.length) {
    const f = people[0].f;
    lines.push(`${family(f) === 'd' ? (titles.get(s.key)?.type === 'tv' ? 'De' : 'Dirigida por') : 'Con guion de'} ${featureLabel(f, info)}, presente en títulos que valoraste bien.`);
  }
  const narrGood = s.narrNeighbors.filter((n) => n.dev > 0.5 && n.sim >= 0.35).slice(0, 3);
  if (narrGood.length) {
    const names = narrGood.map((n) => { const r = ratingByKey.get(n.key); const t = titles.get(n.key)?.title ?? 'un título'; return r?.overall !== undefined ? `${t} (${fmt(r.overall)})` : t; });
    lines.push(`Narrativamente parecida a ${list(names)}, que puntuaste por encima de tu media (argumento y rasgos narrativos, análisis semántico).`);
  }
  const good = s.neighbors.filter((n) => n.dev > 0.5 && n.sim > 0.2 && !narrGood.some((g) => g.key === n.key)).slice(0, 3);
  if (good.length) {
    const names = good.map((n) => {
      const r = ratingByKey.get(n.key);
      const t = titles.get(n.key)?.title ?? 'un título';
      return r?.overall !== undefined ? `${t} (${fmt(r.overall)})` : t;
    });
    lines.push(`Se parece a ${list(names)}, que ${good.length === 1 ? 'puntuaste' : 'puntuaste'} por encima de tu media.`);
  }
  // Aspectos: lo que más pesa en tus notas y cómo te resultan títulos con estos rasgos
  const label = (d: DimensionId) => DIMENSIONS.find((x) => x.id === d)!.label.toLowerCase();
  const topImp = [...profile.dimensions].filter((d) => d.count > 0).sort((a, b) => b.weight - a.weight).slice(0, 3).map((d) => d.id);
  const posAsp = s.aspects.filter((a) => a.dev > 0.25 && a.evidence >= 1.5 && s.dimensionEstimates[a.d] !== undefined).slice(0, 2);
  if (posAsp.length) {
    const parts = posAsp.map((a) => `${label(a.d)} (≈${fmt(s.dimensionEstimates[a.d]!)}★)`);
    const key = posAsp.find((a) => topImp.includes(a.d));
    lines.push(`En títulos con rasgos parecidos puntuás alto ${list(parts)}${key ? `; ${label(key.d)} es de lo que más pesa en tus notas` : ''}.`);
  }
  const negAsp = s.aspects.filter((a) => a.dev < -0.35 && a.evidence >= 1.5 && s.dimensionEstimates[a.d] !== undefined).slice(0, 1);
  if (negAsp.length && !exploration) lines.push(`Ojo: en títulos parecidos solés puntuar bajo ${label(negAsp[0].d)} (≈${fmt(s.dimensionEstimates[negAsp[0].d]!)}★).`);
  // Actores con evidencia repetida (nunca por una única actuación)
  const goodActors = s.actors.filter((a) => a.c > 0.12 && a.count >= 2).slice(0, 2);
  if (goodActors.length) {
    const a0 = goodActors[0];
    lines.push(a0.actingCount >= 2
      ? `Actúa ${list(goodActors.map((a) => a.name))}: puntuaste alto sus actuaciones en ${a0.actingCount} títulos.`
      : `Actúa ${list(goodActors.map((a) => a.name))}, presente en ${a0.count} títulos que puntuaste alto (sin estrellas de Actuaciones: evidencia más débil).`);
  }
  // Comentarios «Otros»
  const posC = s.concepts.filter((c) => c.c > 0.2).slice(0, 2);
  if (posC.length) {
    const src = posC[0].sources.map((k) => titles.get(k)?.title).filter(Boolean).slice(0, 2) as string[];
    lines.push(`Según tus comentarios en «Otros», te interesan ${list(posC.map((c) => `«${c.label}»`))}${src.length ? ` (lo escribiste sobre ${list(src)})` : ''}, y este título lo trata según TMDB.`);
  }
  const negC = s.concepts.filter((c) => c.c < -0.2).slice(0, 1);
  if (negC.length && !exploration) lines.push(`En tus comentarios dijiste que no te gusta «${negC[0].label}», que aparece en este título.`);
  if (s.rejection.penalty < -0.25 && !exploration) {
    const r = s.rejection;
    if (r.level === 'collection') lines.push(`Baja un poco: descartaste otros títulos de la saga ${r.collectionName}.`);
    else if (r.level === 'keyword') lines.push(`Baja un poco: descartaste varios títulos con ${list(r.keywordIds.map((id) => featureLabel(`k:${id}`, info)).filter((l) => !/^k:/.test(l)).slice(0, 2)) || 'rasgos parecidos'}.`);
    else lines.push(`Baja un poco: descartaste varios títulos de ${featureLabel(`g:${r.genreIds[0]}`, info)}.`);
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
  // Rechazadas y abandonadas nunca se recomiendan; las vistas se excluyen salvo que se pidan explícitamente
  const excluded = new Set(input.ratings.filter((r) => r.notInterested || r.list === 'abandoned' || (!input.includeWatched && r.watched)).map((r) => r.key));
  const excludedGenres = new Set(input.settings?.excludedGenres ?? []);
  const candidates = [...new Set(input.candidates)].filter((k) => !excluded.has(k) && input.titles.has(k))
    .filter((k) => !input.titles.get(k)!.genres.some((g) => excludedGenres.has(g.id)));
  const scored = scoreCandidates({ ...input, candidates });
  const limit = Math.min(input.limit ?? 30, scored.length);
  const info = describeFeatures([...input.titles.values()]);
  const rand = mulberry32(input.seed ?? 1);

  const os = input.orderScore;
  const order = (s: Scored) => (os?.has(s.key) ? os.get(s.key)! : (input.rankBy ?? 'uncapped') === 'uncapped' ? s.predRaw : s.pred);
  const pool = [...scored].sort((a, b) => order(b) - order(a) || (a.key < b.key ? -1 : 1));
  const explorePool = os
    // v3.5: exploración personalizada: entre lo poco parecido al historial, lo que el modelo personal ubica más alto
    ? scored.filter((s) => s.novelty > 0.6 && s.quality >= PARAMS.minExplorationQuality && os.has(s.key)).sort((a, b) => order(b) - order(a))
    : scored
      .filter((s) => s.novelty > 0.6 && s.quality >= PARAMS.minExplorationQuality)
      .map((s) => ({ s, r: s.quality * (0.8 + 0.4 * rand()) }))
      .sort((a, b) => b.r - a.r).map((x) => x.s);
  const selected: { s: Scored; exploration: boolean }[] = [];
  const used = new Set<TitleKey>();
  // MMR incremental: la similitud máxima con lo ya elegido se actualiza al elegir (O(n²) en total, no O(n³))
  const maxSim = new Map<TitleKey, number>(pool.map((s) => [s.key, 0]));
  const choose = (x: Scored, exploration: boolean) => {
    selected.push({ s: x, exploration }); used.add(x.key);
    for (const s of pool) if (!used.has(s.key)) { const c = cosine(s.vec, x.vec); if (c > maxSim.get(s.key)!) maxSim.set(s.key, c); }
  };
  // Actores: con evidencia suficiente pueden subir títulos, pero no monopolizar el top 10
  const actorCount = new Map<number, number>();
  const leadActor = (s: Scored) => s.actors.find((a) => a.c > 0.08)?.id;
  const useExploration = input.profile.ratedCount >= 3;
  const usedCollections = new Set<number>();

  while (selected.length < limit && used.size < scored.length) {
    const pos = selected.length + 1;
    if (useExploration && pos % PARAMS.explorationEvery === 0) {
      const e = explorePool.find((x) => !used.has(x.key));
      if (e) { choose(e, true); continue; }
    }
    const capActive = pos <= 10;
    let best: Scored | undefined, bestVal = -Infinity, fallback: Scored | undefined, fallbackVal = -Infinity;
    for (const s of pool) {
      if (used.has(s.key)) continue;
      const upper = PARAMS.mmrLambda * ((order(s) - 1) / 9);
      if (upper < bestVal) break; // poda exacta: el resto tiene menor nota y la diversidad sólo resta
      const val = upper - (1 - PARAMS.mmrLambda) * maxSim.get(s.key)!;
      const la = capActive ? leadActor(s) : undefined;
      if (la !== undefined && (actorCount.get(la) ?? 0) >= PARAMS.maxPerActorTop10) { if (val > fallbackVal) { fallbackVal = val; fallback = s; } continue; }
      const col = capActive && (input.collectionCap ?? true) ? input.titles.get(s.key)!.collection?.id : undefined;
      if (col !== undefined && usedCollections.has(col)) { if (val > fallbackVal) { fallbackVal = val; fallback = s; } continue; }
      if (val > bestVal) { bestVal = val; best = s; }
    }
    const pick = best ?? fallback;
    if (!pick) break;
    if (capActive) { const la = leadActor(pick); if (la !== undefined) actorCount.set(la, (actorCount.get(la) ?? 0) + 1); }
    const pc = input.titles.get(pick.key)!.collection?.id;
    if (pc !== undefined) usedCollections.add(pc);
    choose(pick, false);
  }

  const r2 = (x: number) => Math.round(x * 100) / 100;
  return selected.map(({ s, exploration }, i) => ({
    key: s.key,
    rank: i + 1,
    score: Math.round(s.pred * 10) / 10,
    confidence: r2(s.confidence),
    confidenceLabel: s.confidence < 0.35 ? 'baja' : s.confidence < 0.65 ? 'media' : 'alta',
    explanation: explain(s, input, info, exploration),
    exploration,
    provisional: input.profile.ratedCount < 5 || s.confidence < 0.35,
    dimensionEstimates: s.dimensionEstimates,
    rejectionPenalty: s.rejection.penalty < 0 ? r2(s.rejection.penalty) : undefined,
    channels: s.channels.filter((c) => Math.abs(c.contribution) >= 0.005).map((c) => ({ id: c.id, value: r2(c.value), weight: r2(c.weight), contribution: r2(c.contribution), evidence: r2(c.evidence) })),
    base: r2(input.profile.mean),
    lowEvidence: input.lowEvidence?.has(s.key) && s.confidence < 0.35 ? true : undefined,
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
  buildProfile: (ratings, titles, settings) => {
    const p = buildProfile(ratings, titles, settings?.dimensionWeights);
    p.channelWeights = learnChannelWeights(ratings, titles, settings?.dimensionWeights);
    return p;
  },
  rank,
};
