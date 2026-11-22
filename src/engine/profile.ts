import { DIMENSIONS } from '../constants';
import type { DimensionId, Person, Rating, TitleKey, TitleMeta } from '../types';
import { hasScore, starsToTen } from '../db/migrations';
import { rawFeatures } from './features';
import { buildConceptProfile, type ConceptPreference } from './comments';
import { buildRejectionModel, isRejection, type RejectionModel } from './rejections';

export const PRIOR_MEAN = 6.5;
/** Rasgos de contenido con los que se aprende cada aspecto (los genéricos, como década o idioma, no explican un aspecto). */
export const ASPECT_FAMILIES = new Set(['g', 'k', 'd', 'len', 'seas']);
/** El final se aprende además con las características de finales publicadas por TMDB (nunca se muestran). */
export const DIM_FAMILIES: Partial<Record<DimensionId, Set<string>>> = { ending: new Set([...ASPECT_FAMILIES, 'end']) };
const familiesFor = (d: DimensionId) => DIM_FAMILIES[d] ?? ASPECT_FAMILIES;
const DIM_IDS = DIMENSIONS.map((d) => d.id);

/** Estrellas de un aspecto llevadas a la escala 1-10 de la nota general (sólo para el cálculo). */
export const dimValue = (r: Pick<Rating, 'dimensions'>, d: DimensionId): number | undefined => {
  const v = r.dimensions[d];
  return v === undefined ? undefined : starsToTen(v);
};

/** Parámetros del aprendizaje (expuestos para poder ajustarlos y testearlos). */
export const LEARNING = {
  priorStrength: 2, // valoraciones "virtuales" que anclan la media del usuario
  shrinkage: 2.5, // λ: evidencia mínima para confiar en la afinidad de un rasgo
  dimShrinkage: 2.5, // λ por aspecto
  maxDeviation: 3.5, // recorte: una nota extrema no puede mover el perfil más que esto
  ridge: 4, // regularización de la regresión que estima la importancia de cada aspecto
  importancePrior: 5, // cuántas valoraciones hacen falta para confiar en la importancia aprendida
  dimOnlyWeight: 0.6, // peso de una valoración que sólo tiene aspectos (sin nota general)
  dimAnchor: 6, // cuántas notas "virtuales" iguales a tu media general anclan la referencia de cada aspecto
  dimEvidence: 4, // el peso personalizado de un aspecto crece como n / (n + 4): 0 si nunca lo puntuaste
  actorShrinkage: 2.5, // λ por actor: una sola actuación bien valorada no alcanza para un sesgo fuerte
  commentActorWeight: 0.7, // peso de una mención positiva/negativa a un actor en «Otros»
};

/**
 * Participación real de una persona en un título: en películas, por su orden en los créditos;
 * en series, combinando orden y proporción de episodios en los que aparece (TMDB aggregate_credits).
 */
export function participation(p: Person, t: TitleMeta): number {
  const order = p.order ?? t.cast.indexOf(p);
  const byOrder = 1 / (1 + 0.35 * Math.max(0, order));
  if (t.type === 'tv' && p.episodes && t.totalEpisodes) return 0.5 * byOrder + 0.5 * Math.min(1, p.episodes / t.totalEpisodes);
  return byOrder;
}

export interface ActorAffinity { id: number; name: string; affinity: number; evidence: number; count: number; positive: number; negative: number }

export interface Signal {
  key: TitleKey;
  value: number; // nota equivalente 1-10
  weight: number; // confianza de la señal
  kind: 'overall' | 'aspects' | 'abandoned' | 'want' | 'watching';
  explicit: boolean;
}

export interface DimensionStat {
  id: DimensionId;
  mean: number; // tu promedio en el aspecto (NaN si no hay datos)
  count: number;
  /** Peso relativo del aspecto en tu nota general (1 = promedio). Aprendido + ajuste manual. */
  importance: number;
  /** Proporción del canal de aspectos entre los aspectos puntuados (suman 1) */
  share: number;
  /** Confianza en el aspecto según cantidad y consistencia de la evidencia (0 = nunca puntuado) */
  reliability: number;
  /** Contribución personalizada al ranking = share × reliability. Es 0 si nunca lo puntuaste. */
  weight: number;
  /** Peso estimado por la regresión antes de mezclar con el prior (null si hay pocos datos) */
  learned: number | null;
  correlation: number | null;
}

export interface FeatureAffinity { affinity: number; evidence: number; count: number }

export interface UserProfile {
  ratedCount: number;
  signalCount: number;
  mean: number;
  features: Map<string, FeatureAffinity>;
  /** Afinidad por rasgo dentro de cada aspecto: desvío de tu nota del aspecto respecto de tu media en él */
  dimFeatures: Map<DimensionId, Map<string, FeatureAffinity>>;
  /** Compatibilidad v1: media por rasgo y aspecto (para explicaciones) */
  featureDims: Map<string, Partial<Record<DimensionId, { mean: number; n: number }>>>;
  dimensions: DimensionStat[];
  signals: Signal[];
  /** Afinidad por actor aprendida de las estrellas de Actuaciones (y menciones en «Otros») */
  actors: Map<number, ActorAffinity>;
  /** Preferencias temáticas extraídas de los comentarios «Otros» */
  concepts: Map<string, ConceptPreference>;
  /** Descartes («No me interesa») por saga, subgénero y género */
  rejections: RejectionModel;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 4) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Resuelve (A)x = b por eliminación gaussiana con pivoteo (A simétrica definida positiva por el ridge). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}

const shrunkMean = (vals: number[], prior: number, strength = 2) => (vals.reduce((a, b) => a + b, 0) + prior * strength) / (vals.length + strength);

/**
 * Importancia de cada aspecto: regresión ridge de tu nota general sobre tus notas por aspecto
 * (desvíos respecto de tus medias). Un aspecto sin puntuar aporta 0: la ausencia no es una nota baja.
 * Con pocos datos se mezcla con un prior uniforme. Luego se aplica el ajuste manual.
 */
export function dimensionStats(ratings: Rating[], manual: Partial<Record<DimensionId, number>> = {}, overallMean = PRIOR_MEAN): DimensionStat[] {
  const means = new Map<DimensionId, number>();
  const counts = new Map<DimensionId, number>();
  for (const d of DIM_IDS) {
    const vals = ratings.map((r) => dimValue(r, d)).filter((v): v is number => v !== undefined);
    counts.set(d, vals.length);
    // Referencia del aspecto anclada a tu escala general: con pocos datos, «alto» se mide contra tu nota media
    means.set(d, vals.length ? shrunkMean(vals, overallMean, LEARNING.dimAnchor) : NaN);
  }
  const rows = ratings.filter((r) => r.overall !== undefined && Object.keys(r.dimensions).length > 0);
  const n = DIM_IDS.length;
  let learned: number[] | null = null;
  if (rows.length >= 3) {
    const XtX = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? LEARNING.ridge : 0)));
    const Xty = new Array(n).fill(0);
    for (const r of rows) {
      const x = DIM_IDS.map((d) => (r.dimensions[d] !== undefined ? dimValue(r, d)! - (means.get(d) ?? overallMean) : 0));
      const y = r.overall! - overallMean;
      for (let i = 0; i < n; i++) { Xty[i] += x[i] * y; for (let j = 0; j < n; j++) XtX[i][j] += x[i] * x[j]; }
    }
    learned = solve(XtX, Xty).map((w) => Math.max(0, w));
  }
  const learnedSum = learned ? learned.reduce((a, b) => a + b, 0) : 0;
  const nRows = learnedSum > 0 ? rows.length : 0;
  const uniform = 1 / n;
  // Las proporciones se reparten sólo entre aspectos que alguna vez puntuaste
  const active = DIM_IDS.map((d) => (counts.get(d) ?? 0) > 0);
  const nActive = active.filter(Boolean).length;
  const raw = DIM_IDS.map((d, i) => {
    if (!active[i]) return 0;
    const l = learned && learnedSum > 0 ? learned[i] / learnedSum : uniform;
    const blended = (nRows * l + LEARNING.importancePrior * uniform) / (nRows + LEARNING.importancePrior);
    return blended * (manual[d] ?? 1);
  });
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  return DIM_IDS.map((id, i) => {
    const withOverall = ratings.filter((r) => r.dimensions[id] !== undefined && r.overall !== undefined);
    const n = counts.get(id)!;
    const correlation = pearson(withOverall.map((r) => dimValue(r, id)!), withOverall.map((r) => r.overall!));
    // Cantidad: n / (n + 4). Consistencia: cuánto acompaña el aspecto a tu nota general (si hay datos para medirlo).
    const consistency = correlation === null ? 0.75 : 0.4 + 0.6 * Math.max(0, correlation);
    const reliability = n ? (n / (n + LEARNING.dimEvidence)) * consistency : 0;
    const share = raw[i] / total;
    return {
      id,
      mean: means.get(id)!,
      count: n,
      share,
      reliability,
      weight: share * reliability,
      importance: active[i] ? share * nActive : manual[id] ?? 1,
      learned: learned && learnedSum > 0 ? learned[i] / learnedSum : null,
      correlation,
    };
  });
}

/** Nota equivalente cuando sólo hay aspectos: media ponderada por importancia de los aspectos puntuados. */
export function aspectsScore(r: Rating, dims: DimensionStat[]): number | undefined {
  const entries = Object.entries(r.dimensions) as [DimensionId, number][];
  if (!entries.length) return undefined;
  let s = 0, w = 0;
  for (const [d, v] of entries) { const imp = dims.find((x) => x.id === d)?.importance ?? 1; s += starsToTen(v) * imp; w += imp; }
  return w ? s / w : undefined;
}

/** v1: se mantiene para explicaciones y compatibilidad. La general nunca se reemplaza si existe. */
export function effectiveScore(r: Rating, dims: DimensionStat[]): number | undefined {
  return r.overall ?? aspectsScore(r, dims);
}

/**
 * Convierte el historial en señales de aprendizaje.
 * «Vista» sin nota no genera señal: haber visto algo no indica que haya gustado.
 * «No me interesa» tampoco alimenta el perfil de gustos: se modela aparte (rejections.ts), porque descartar
 * algo sin verlo no equivale a haberlo visto y puntuado bajo.
 */
export function buildSignals(ratings: Rating[], dims: DimensionStat[], mean: number): Signal[] {
  const out: Signal[] = [];
  for (const r of ratings) {
    const asp = r.overall === undefined ? aspectsScore(r, dims) : undefined;
    const score = r.overall ?? asp;
    if (r.list === 'abandoned') {
      out.push({ key: r.key, value: score !== undefined ? Math.min(score, mean - 1) : Math.min(4, mean - 2.5), weight: 0.85, kind: 'abandoned', explicit: true });
      continue;
    }
    if (isRejection(r)) continue;
    if (r.overall !== undefined) { out.push({ key: r.key, value: r.overall, weight: 1, kind: 'overall', explicit: true }); continue; }
    if (asp !== undefined) { out.push({ key: r.key, value: asp, weight: LEARNING.dimOnlyWeight, kind: 'aspects', explicit: true }); continue; }
    if (r.list === 'watching') out.push({ key: r.key, value: mean + 0.8, weight: 0.3, kind: 'watching', explicit: false });
    else if (r.list === 'want') out.push({ key: r.key, value: mean + 1, weight: 0.3, kind: 'want', explicit: false });
  }
  return out;
}

const clip = (x: number) => Math.max(-LEARNING.maxDeviation, Math.min(LEARNING.maxDeviation, x));

/**
 * Perfil dinámico:
 *  - Canal general: afinidad de cada rasgo = desvío medio (contraído) de tus notas respecto de tu media.
 *  - Canal por aspectos: lo mismo dentro de cada aspecto, usando sólo los títulos donde puntuaste ese aspecto.
 * Contracción bayesiana y recorte de extremos para que una única nota no distorsione el perfil.
 */
export function buildProfile(ratings: Rating[], titles: Map<TitleKey, TitleMeta>, manualWeights: Partial<Record<DimensionId, number>> = {}): UserProfile {
  const overalls = ratings.filter((r) => r.overall !== undefined).map((r) => r.overall!);
  const prelimMean = shrunkMean(overalls, PRIOR_MEAN, LEARNING.priorStrength);
  const dims = dimensionStats(ratings, manualWeights, prelimMean);
  const aspOnly = ratings.filter((r) => r.overall === undefined && hasScore(r)).map((r) => aspectsScore(r, dims)!);
  const mean = shrunkMean([...overalls, ...aspOnly], PRIOR_MEAN, LEARNING.priorStrength);
  const signals = buildSignals(ratings, dims, mean);
  const ratedCount = ratings.filter((r) => hasScore(r)).length;

  const acc = new Map<string, { s: number; w: number; n: number }>();
  const featsOf = new Map<TitleKey, string[]>();
  const getFeats = (k: TitleKey) => { if (!featsOf.has(k)) { const t = titles.get(k); featsOf.set(k, t ? rawFeatures(t) : []); } return featsOf.get(k)!; };
  for (const sig of signals) {
    const fs = getFeats(sig.key);
    const dev = clip(sig.value - mean);
    for (const f of fs) {
      const a = acc.get(f) ?? { s: 0, w: 0, n: 0 };
      a.s += sig.weight * dev; a.w += sig.weight; a.n += 1; acc.set(f, a);
    }
  }
  const features = new Map<string, FeatureAffinity>();
  for (const [f, a] of acc) features.set(f, { affinity: a.s / (a.w + LEARNING.shrinkage), evidence: a.w, count: a.n });

  // Canal por aspectos: sólo títulos con ese aspecto puntuado (ausente ≠ negativo)
  const dimMean = new Map(dims.map((d) => [d.id, d.mean]));
  const dimFeatures = new Map<DimensionId, Map<string, FeatureAffinity>>();
  const fdAcc = new Map<string, Partial<Record<DimensionId, { s: number; n: number }>>>();
  for (const d of DIM_IDS) {
    const m = dimMean.get(d)!;
    if (Number.isNaN(m)) continue;
    const dAcc = new Map<string, { s: number; n: number }>();
    for (const r of ratings) {
      const v = dimValue(r, d);
      if (v === undefined) continue;
      const fams = familiesFor(d);
      for (const f of getFeats(r.key)) {
        // Sólo rasgos de contenido (géneros, temáticas, autores, formato); los genéricos (década, idioma) no explican un aspecto
        if (!fams.has(f.slice(0, f.indexOf(':')))) continue;
        const a = dAcc.get(f) ?? { s: 0, n: 0 }; a.s += clip(v - m); a.n += 1; dAcc.set(f, a);
        const rec = fdAcc.get(f) ?? {}; const cur = rec[d] ?? { s: 0, n: 0 }; cur.s += v; cur.n += 1; rec[d] = cur; fdAcc.set(f, rec);
      }
    }
    const map = new Map<string, FeatureAffinity>();
    for (const [f, a] of dAcc) map.set(f, { affinity: a.s / (a.n + LEARNING.dimShrinkage), evidence: a.n, count: a.n });
    dimFeatures.set(d, map);
  }
  const featureDims = new Map<string, Partial<Record<DimensionId, { mean: number; n: number }>>>();
  for (const [f, rec] of fdAcc) {
    const o: Partial<Record<DimensionId, { mean: number; n: number }>> = {};
    for (const [d, v] of Object.entries(rec) as [DimensionId, { s: number; n: number }][]) o[d] = { mean: v.s / v.n, n: v.n };
    featureDims.set(f, o);
  }
  // Actores: sólo con las estrellas de Actuaciones. El crédito se reparte según la participación real de cada
  // persona (protagonistas más que secundarios), con contracción por actor y evidencia negativa incluida.
  const actingMean = dims.find((d) => d.id === 'acting')!.mean;
  const actAcc = new Map<number, { s: number; w: number; n: number; pos: number; neg: number; name: string }>();
  const addActor = (p: Person, w: number, dev: number) => {
    const a = actAcc.get(p.id) ?? { s: 0, w: 0, n: 0, pos: 0, neg: 0, name: p.name };
    a.s += w * dev; a.w += w; a.n += 1; if (dev > 0) a.pos++; else if (dev < 0) a.neg++; actAcc.set(p.id, a);
  };
  if (!Number.isNaN(actingMean)) {
    for (const r of ratings) {
      const v = dimValue(r, 'acting');
      const t = titles.get(r.key);
      if (v === undefined || !t) continue;
      const dev = clip(v - actingMean);
      for (const p of t.cast.slice(0, 8)) addActor(p, participation(p, t), dev);
    }
  }
  const { concepts, people } = buildConceptProfile(ratings, titles);
  for (const [id, c] of people) {
    // Una mención explícita en «Otros» («la actuación de X fue impecable») cuenta como observación de esa persona
    const t = [...titles.values()].find((x) => x.cast.some((p) => p.id === id));
    const person = t?.cast.find((p) => p.id === id) ?? { id, name: c.name };
    addActor(person, LEARNING.commentActorWeight, clip(c.score * 4));
  }
  const actors = new Map<number, ActorAffinity>();
  for (const [id, a] of actAcc) actors.set(id, { id, name: a.name, affinity: a.s / (a.w + LEARNING.actorShrinkage), evidence: a.w, count: a.n, positive: a.pos, negative: a.neg });

  const liked = signals.filter((s) => (s.kind === 'overall' || s.kind === 'aspects') && s.value >= mean + 0.5).map((s) => s.key);
  const rejections = buildRejectionModel(ratings, titles, liked);
  return { ratedCount, signalCount: signals.length, mean, features, dimFeatures, featureDims, dimensions: dims, signals, actors, concepts, rejections };
}
