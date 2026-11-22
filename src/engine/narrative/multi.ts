/**
 * Similitud con VARIAS referencias (Similares v3.1).
 *
 * Modos:
 *  - «En común» (predeterminado): premia a los candidatos parecidos a TODAS las referencias (media armónica
 *    ponderada) y que comparten el núcleo común (rasgos y temáticas presentes en al menos dos referencias).
 *  - «Combinar»: premia a los candidatos que mezclan rasgos de distintas referencias aunque no estén en todas
 *    (mejores dos coincidencias + amplitud de referencias cubiertas).
 * Importancia por referencia: Menos (0,5), Normal (1), Más (2). Por defecto, todas iguales.
 * No se asume que todo lo de una referencia es deseado: el núcleo común pesa más que lo particular, las
 * coincidencias débiles casi no pesan y las diferencias se informan.
 */
import { FACET, narrativeQuality, pairSimilarity, type Narrative, type NarrativeIndex, type PairSimilarity } from './core';
import { weakKind } from './weak';

export type SimilarMode = 'common' | 'combine';
export interface RefIn { n: Narrative; weight: number }

export interface CoreFeature { kind: 'facet' | 'kw'; id: string; label: string; refs: string[]; weight: number }
export interface RefProfile {
  core: CoreFeature[];
  distinctive: Map<string, CoreFeature[]>;
  /** rasgos fuertes presentes en unas referencias y ausentes en otras */
  contrasts: { label: string; in: string[]; notIn: string[] }[];
  centroid?: Float32Array;
  /** calidad de datos de cada referencia (0-1); en «En común» una referencia con muy pocos datos pesa menos */
  quality: Map<string, number>;
}

/** Peso efectivo: importancia elegida × fiabilidad de los datos (0,35 a 1). Con datos completos = importancia. */
const reliability = (q: number) => 0.35 + 0.65 * Math.min(1, q / 0.6);

export function buildRefProfile(refs: RefIn[], idx?: NarrativeIndex): RefProfile {
  const n = refs.length;
  const fmap = new Map<string, CoreFeature>();
  const kmap = new Map<number, CoreFeature>();
  for (const r of refs) {
    for (const [id, ev] of r.n.facets) {
      const def = FACET.get(id);
      if (!def || ev.conf < 0.35) continue;
      const w = (def.strength === 'strong' ? 1 : def.strength === 'medium' ? 0.6 : 0.15) * ev.conf * r.weight * (idx ? idx.facetIdf(id) / 3 : 1);
      const c = fmap.get(id) ?? { kind: 'facet' as const, id, label: def.label, refs: [], weight: 0 };
      c.refs.push(r.n.key); c.weight += w; fmap.set(id, c);
    }
    for (const [id, name] of r.n.kw) {
      if (weakKind(name)) continue;
      const w = (idx ? idx.kwIdf(id) : 3) * r.weight * 0.25;
      const c = kmap.get(id) ?? { kind: 'kw' as const, id: String(id), label: name, refs: [], weight: 0 };
      c.refs.push(r.n.key); c.weight += w; kmap.set(id, c);
    }
  }
  const all = [...fmap.values(), ...kmap.values()];
  const core = (n === 1 ? all : all.filter((c) => c.refs.length >= 2)).sort((a, b) => b.weight * b.refs.length - a.weight * a.refs.length);
  const distinctive = new Map<string, CoreFeature[]>();
  if (n > 1) for (const r of refs) distinctive.set(r.n.key, all.filter((c) => c.refs.length === 1 && c.refs[0] === r.n.key).sort((a, b) => b.weight - a.weight).slice(0, 6));
  const contrasts: RefProfile['contrasts'] = [];
  if (n > 1) for (const c of fmap.values()) {
    const def = FACET.get(c.id)!;
    if (def.strength !== 'strong' || c.refs.length === n) continue;
    contrasts.push({ label: def.label, in: c.refs, notIn: refs.map((r) => r.n.key).filter((k) => !c.refs.includes(k)) });
  }
  let centroid: Float32Array | undefined;
  if (idx?.emb) {
    const rows = refs.filter((r) => r.n.row >= 0);
    if (rows.length) {
      centroid = new Float32Array(idx.meta.dim);
      for (const r of rows) { const v = idx.rowVec(r.n.row); const w = r.weight * reliability(narrativeQuality(r.n)); for (let i = 0; i < v.length; i++) centroid[i] += v[i] * w; }
      const norm = Math.hypot(...centroid) || 1;
      for (let i = 0; i < centroid.length; i++) centroid[i] /= norm;
    }
  }
  return { core: core.slice(0, 30), distinctive, contrasts: contrasts.slice(0, 6), centroid, quality: new Map(refs.map((r) => [r.n.key, narrativeQuality(r.n)])) };
}

export interface MultiScore {
  score: number;
  perRef: { key: string; weight: number; s: PairSimilarity }[];
  coreHits: CoreFeature[];
  coreCoverage?: number;
  centroidSem?: number;
  evidence: number;
  sameFranchise: boolean;
}

export function scoreMulti(refs: RefIn[], prof: RefProfile, C: Narrative, mode: SimilarMode, idx?: NarrativeIndex): MultiScore {
  const perRef = refs.map((r) => ({ key: r.n.key, weight: r.weight, s: pairSimilarity(r.n, C, idx) }));
  const W = refs.reduce((a, r) => a + r.weight, 0) || 1;
  const coreHits = prof.core.filter((c) => (c.kind === 'facet' ? C.facets.has(c.id) : C.kw.has(Number(c.id))));
  const coreTot = prof.core.reduce((a, c) => a + c.weight, 0);
  const coreCoverage = prof.core.length ? coreHits.reduce((a, c) => a + c.weight, 0) / (coreTot + 0.8) : undefined;
  const centroidSem = prof.centroid && idx && C.row >= 0 ? idx.semScore(idx.cosVec(prof.centroid, C.row)) : undefined;
  const evidence = perRef.reduce((a, p) => a + p.weight * p.s.evidence, 0) / W;
  const sameFranchise = perRef.some((p) => p.s.sameFranchise);
  let score: number;
  if (refs.length === 1) score = perRef[0].s.score;
  else if (mode === 'common') {
    // Media armónica ponderada: exige parecido con todas, pero una referencia con muy pocos datos (sinopsis breve,
    // sin rasgos) pesa menos, para que su falta de información no hunda a los candidatos buenos.
    const ew = perRef.map((p) => p.weight * reliability(prof.quality.get(p.key) ?? 1));
    const harm = ew.reduce((a, w) => a + w, 0) / perRef.reduce((a, p, i) => a + ew[i] / Math.max(0.02, p.s.score), 0);
    const parts: [number, number | undefined][] = [[0.5, harm], [0.25, coreCoverage], [0.25, centroidSem]];
    const avail = parts.filter(([, v]) => v !== undefined) as [number, number][];
    score = avail.reduce((a, [w, v]) => a + w * v, 0) / avail.reduce((a, [w]) => a + w, 0);
    // Sin vector del candidato, el centroide no se puede verificar: tope prudente
    if (centroidSem === undefined) score = Math.min(score, harm + 0.1);
  } else {
    const sorted = [...perRef].sort((a, b) => b.s.score * b.weight - a.s.score * a.weight);
    const top2 = sorted.slice(0, 2);
    const top2mean = top2.reduce((a, p) => a + p.s.score * p.weight, 0) / top2.reduce((a, p) => a + p.weight, 0);
    const covered = perRef.filter((p) => p.s.score >= 0.3);
    const breadth = covered.reduce((a, p) => a + p.weight, 0) / W;
    const coveredMean = covered.length ? covered.reduce((a, p) => a + p.s.score, 0) / covered.length : 0;
    score = 0.45 * top2mean + 0.25 * sorted[0].s.score + 0.3 * breadth * coveredMean;
  }
  return { score: Math.max(0, Math.min(0.99, score)), perRef, coreHits, coreCoverage, centroidSem, evidence, sameFranchise };
}
