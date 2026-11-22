import { DIMENSIONS } from '../constants';
import type { DimensionId, Rating, TitleKey, TitleMeta } from '../types';
import { rawFeatures } from './features';

export const PRIOR_MEAN = 6.5;

/** Parámetros del aprendizaje (expuestos para poder ajustarlos y testearlos). */
export const LEARNING = {
  priorStrength: 2, // valoraciones "virtuales" que anclan la media del usuario
  shrinkage: 2.5, // λ: evidencia mínima para confiar en la afinidad de un rasgo
  maxDeviation: 3.5, // recorte: una nota extrema no puede mover el perfil más que esto
  overallWeight: 0.75, // peso de la nota general frente a la media ponderada de dimensiones
};

export interface Signal {
  key: TitleKey;
  value: number; // nota equivalente 1-10
  weight: number; // confianza de la señal
  kind: Rating['status'];
  explicit: boolean;
}

export interface DimensionStat { id: DimensionId; mean: number; count: number; importance: number; correlation: number | null }

export interface FeatureAffinity { affinity: number; evidence: number; count: number }

export interface UserProfile {
  ratedCount: number;
  signalCount: number;
  mean: number;
  features: Map<string, FeatureAffinity>;
  /** afinidad por rasgo y dimensión (para explicaciones: "en títulos con X valorás alto el suspenso") */
  featureDims: Map<string, Partial<Record<DimensionId, { mean: number; n: number }>>>;
  dimensions: DimensionStat[];
  signals: Signal[];
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

/** Importancia de cada dimensión: cuánto se relaciona con tu nota general, por el ajuste manual. */
export function dimensionStats(ratings: Rating[], manual: Partial<Record<DimensionId, number>> = {}): DimensionStat[] {
  return DIMENSIONS.map(({ id }) => {
    const pairs = ratings.filter((r) => r.dimensions[id] !== undefined);
    const vals = pairs.map((r) => r.dimensions[id]!);
    const withOverall = pairs.filter((r) => r.overall !== undefined);
    const corr = pearson(withOverall.map((r) => r.dimensions[id]!), withOverall.map((r) => r.overall!));
    const learned = corr === null ? 1 : 1 + Math.max(-0.5, Math.min(1, corr));
    return {
      id,
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN,
      count: vals.length,
      correlation: corr,
      importance: learned * (manual[id] ?? 1),
    };
  });
}

/** Nota efectiva de una valoración: general + dimensiones ponderadas (la general nunca se reemplaza si existe). */
export function effectiveScore(r: Rating, dims: DimensionStat[]): number | undefined {
  const entries = Object.entries(r.dimensions) as [DimensionId, number][];
  let dimScore: number | undefined;
  if (entries.length) {
    let s = 0, w = 0;
    for (const [d, v] of entries) { const imp = dims.find((x) => x.id === d)?.importance ?? 1; s += v * imp; w += imp; }
    dimScore = w ? s / w : undefined;
  }
  if (r.overall !== undefined && dimScore !== undefined) return LEARNING.overallWeight * r.overall + (1 - LEARNING.overallWeight) * dimScore;
  return r.overall ?? dimScore;
}

/** Convierte historial (explícito e implícito) en señales de aprendizaje. */
export function buildSignals(ratings: Rating[], dims: DimensionStat[], mean: number): Signal[] {
  const out: Signal[] = [];
  for (const r of ratings) {
    const eff = effectiveScore(r, dims);
    switch (r.status) {
      case 'rated': if (eff !== undefined) out.push({ key: r.key, value: eff, weight: 1, kind: r.status, explicit: true }); break;
      case 'watched': out.push({ key: r.key, value: mean + 0.4, weight: 0.25, kind: r.status, explicit: false }); break;
      case 'watching': out.push({ key: r.key, value: eff ?? mean + 1, weight: eff !== undefined ? 0.7 : 0.35, kind: r.status, explicit: eff !== undefined }); break;
      case 'want': out.push({ key: r.key, value: mean + 1, weight: 0.3, kind: r.status, explicit: false }); break;
      case 'abandoned': out.push({ key: r.key, value: eff !== undefined ? Math.min(eff, mean - 1) : Math.min(4, mean - 2.5), weight: 0.85, kind: r.status, explicit: true }); break;
      case 'not_interested': out.push({ key: r.key, value: mean - 2, weight: 0.5, kind: r.status, explicit: true }); break;
    }
  }
  return out;
}

/**
 * Perfil dinámico: para cada rasgo, desvío medio (respecto de tu media) de los títulos que lo tienen,
 * con contracción bayesiana (λ) y recorte de extremos para que una única nota no distorsione el perfil.
 */
export function buildProfile(ratings: Rating[], titles: Map<TitleKey, TitleMeta>, manualWeights: Partial<Record<DimensionId, number>> = {}): UserProfile {
  const dims = dimensionStats(ratings, manualWeights);
  const explicitScores = ratings.filter((r) => r.status === 'rated').map((r) => effectiveScore(r, dims)).filter((x): x is number => x !== undefined);
  const mean = (explicitScores.reduce((a, b) => a + b, 0) + PRIOR_MEAN * LEARNING.priorStrength) / (explicitScores.length + LEARNING.priorStrength);
  const signals = buildSignals(ratings, dims, mean);

  const acc = new Map<string, { s: number; w: number; n: number }>();
  const fdAcc = new Map<string, Partial<Record<DimensionId, { s: number; n: number }>>>();
  const dimMean = new Map(dims.map((d) => [d.id, d.mean]));
  const byKey = new Map(ratings.map((r) => [r.key, r]));
  for (const sig of signals) {
    const t = titles.get(sig.key);
    if (!t) continue;
    const dev = Math.max(-LEARNING.maxDeviation, Math.min(LEARNING.maxDeviation, sig.value - mean));
    const fs = rawFeatures(t);
    const r = byKey.get(sig.key);
    for (const f of fs) {
      const a = acc.get(f) ?? { s: 0, w: 0, n: 0 };
      a.s += sig.weight * dev; a.w += sig.weight; a.n += 1;
      acc.set(f, a);
      if (r && sig.explicit) {
        for (const [d, v] of Object.entries(r.dimensions) as [DimensionId, number][]) {
          const m = dimMean.get(d);
          if (m === undefined || Number.isNaN(m)) continue;
          const rec = fdAcc.get(f) ?? {};
          const cur = rec[d] ?? { s: 0, n: 0 };
          cur.s += v; cur.n += 1; rec[d] = cur; fdAcc.set(f, rec);
        }
      }
    }
  }
  const features = new Map<string, FeatureAffinity>();
  for (const [f, a] of acc) features.set(f, { affinity: a.s / (a.w + LEARNING.shrinkage), evidence: a.w, count: a.n });
  const featureDims = new Map<string, Partial<Record<DimensionId, { mean: number; n: number }>>>();
  for (const [f, rec] of fdAcc) {
    const o: Partial<Record<DimensionId, { mean: number; n: number }>> = {};
    for (const [d, v] of Object.entries(rec) as [DimensionId, { s: number; n: number }][]) o[d] = { mean: v.s / v.n, n: v.n };
    featureDims.set(f, o);
  }
  return { ratedCount: explicitScores.length, signalCount: signals.length, mean, features, featureDims, dimensions: dims, signals };
}
