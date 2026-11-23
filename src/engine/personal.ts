/**
 * v3.5 · Modelo personal de gustos (experimental hasta validarlo).
 *
 * Idea: con 20-60 valoraciones de una sola persona no hay datos colaborativos ni para entrenar un modelo grande.
 * Lo que sí funciona con muestras chicas es un modelo bayesiano no paramétrico sobre representaciones de contenido
 * que ya existen: un PROCESO GAUSSIANO (regresión bayesiana con núcleos) que
 *  - parte de un modelo general conservador (la media de la persona + la calidad pública del título) y sólo se
 *    aparta de él cuando hay títulos parecidos valorados (con pocos datos, vuelve solo al modelo general);
 *  - combina varias similitudes (argumento por vectores semánticos, palabras clave, géneros, personas, saga, tipo)
 *    con pesos que se aprenden por máxima verosimilitud marginal: regularización automática, sin usar datos de
 *    evaluación;
 *  - da, además de la nota esperada, su INCERTIDUMBRE (para separar afinidad, incertidumbre y exploración).
 * Señales separadas: notas (regresión), «vista sin nota» y «no me interesa» (modelo de interés aparte, nunca como
 * notas), comentarios no se usan aquí. Todo es determinista y corre en el teléfono en milisegundos.
 */
import { FACETS, facetsFromKeywords, type NarrativeIndex } from './narrative';
import type { TitleKey, TitleMeta } from '../types';

export const PERSONAL_VERSION = 'personal-gp-3.5.0';

// ───────────────────────── rasgos ─────────────────────────
export interface ItemFeatures {
  key: TitleKey;
  emb?: Float32Array;
  genres: number[];
  /** palabras clave con peso tf-idf, norma 1 */
  kw: Map<number, number>;
  /** dirección, guion y 6 primeros del reparto (norma 1) */
  people: Map<number, number>;
  collection?: number;
  type: 'movie' | 'tv';
  /** nota pública bayesiana (0-10) */
  quality: number;
  year?: number;
  votes: number;
  kids: boolean;
  /** rasgos narrativos del catálogo (o de las palabras clave) con su confianza */
  facets: Map<string, number>;
  lang?: string;
}
const norm1 = (m: Map<number, number>) => { let s = 0; for (const v of m.values()) s += v * v; s = Math.sqrt(s) || 1; for (const [k, v] of m) m.set(k, v / s); return m; };
export const bayesQuality = (vote = 0, votes = 0) => (votes * vote + 300 * 6.4) / (votes + 300);
export function featuresOf(m: TitleMeta, idx?: NarrativeIndex): ItemFeatures {
  const c = idx?.get(m.key);
  const emb = c && c.row >= 0 ? idx!.rowVec(c.row) : undefined;
  const kwIds = m.keywords.length ? m.keywords.map((k) => k.id) : c?.kw ?? [];
  const kw = new Map<number, number>();
  for (const id of kwIds) kw.set(id, idx ? idx.kwIdf(id) : 1);
  const people = new Map<number, number>();
  for (const p of m.directors) people.set(p.id, 1);
  for (const p of m.writers ?? []) people.set(p.id, 0.8);
  for (const p of m.cast.slice(0, 6)) people.set(p.id, Math.max(people.get(p.id) ?? 0, 0.7));
  const genres = m.genres.map((g) => g.id);
  return {
    key: m.key, emb, genres, kw: norm1(kw), people: norm1(people), collection: m.collection?.id, type: m.type,
    quality: bayesQuality(m.voteAverage, m.voteCount), year: m.year, votes: m.voteCount ?? 0,
    kids: genres.includes(10762) || (genres.includes(16) && genres.includes(10751)),
    facets: c ? new Map(c.facets.filter((x) => x[2].length || x[3] > 0).map((x) => [x[0], x[1]])) : new Map([...facetsFromKeywords(m.keywords.map((k) => k.name.toLowerCase()))].map(([id, e]) => [id, e.conf])),
    lang: m.originalLanguage,
  };
}

// ───────────────────────── rasgos explícitos (modelos lineales) ─────────────────────────
/** Géneros de series que equivalen a géneros de películas */
const GENRE_ALIAS: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752] };
const GENRES = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37, 10762, 10764, 10767];
export const EXPLICIT_NAMES = [
  ...GENRES.map((g) => `g:${g}`), 'serie', 'saga', 'popularidad', 'calidad', 'antes-1980', '1980s', '1990s', '2000s', '2010s', '2020s', 'idioma-ingles', 'infantil',
  ...FACETS.map((f) => `f:${f.id}`),
];
// Proyección semántica: componentes principales de los vectores del catálogo (direcciones de argumento).
let PROJ: { mean: Float32Array; comps: Float32Array[] } | undefined;
export const setSemanticProjection = (p?: { mean: number[] | Float32Array; comps: (number[] | Float32Array)[] }) => { PROJ = p ? { mean: Float32Array.from(p.mean), comps: p.comps.map((c) => Float32Array.from(c)) } : undefined; };
export const semanticProjection = () => PROJ;
/** Componentes principales por iteración de potencia con deflación (se calcula una vez, fuera del teléfono). */
export function computeProjection(vectors: Float32Array[], k: number, iters = 40) {
  const d = vectors[0].length, n = vectors.length;
  const mean = new Float32Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const X = vectors.map((v) => { const x = new Float32Array(d); for (let i = 0; i < d; i++) { x[i] = v[i] - mean[i]; } return x; });
  const comps: Float32Array[] = [];
  for (let c = 0; c < k; c++) {
    let w = new Float32Array(d).map((_, i) => Math.sin(i * 12.9898 + c * 78.233));
    for (let it = 0; it < iters; it++) {
      const nw = new Float32Array(d);
      for (const x of X) { let p = 0; for (let i = 0; i < d; i++) p += x[i] * w[i]; for (let i = 0; i < d; i++) nw[i] += p * x[i]; }
      for (const q of comps) { let p = 0; for (let i = 0; i < d; i++) p += nw[i] * q[i]; for (let i = 0; i < d; i++) nw[i] -= p * q[i]; }
      let nn = 0; for (let i = 0; i < d; i++) nn += nw[i] * nw[i]; nn = Math.sqrt(nn) || 1;
      w = nw.map((x) => x / nn);
    }
    // escala: desvío de los títulos sobre ese componente, para que cada uno quede en ~[-1, 1]
    let ss = 0; for (const x of X) { let p = 0; for (let i = 0; i < d; i++) p += x[i] * w[i]; ss += p * p; }
    const sd = Math.sqrt(ss / n) || 1;
    comps.push(w.map((x) => x / sd));
  }
  return { mean: Array.from(mean), comps: comps.map((c) => Array.from(c)) };
}
const projOf = (f: ItemFeatures) => {
  if (!PROJ) return [];
  if (!f.emb) return [...PROJ.comps.map(() => 0), 1];
  let nn = 0; for (let i = 0; i < f.emb.length; i++) nn += f.emb[i] * f.emb[i]; nn = Math.sqrt(nn) || 1;
  return [...PROJ.comps.map((c) => { let p = 0; for (let i = 0; i < c.length; i++) p += (f.emb![i] / nn - PROJ!.mean[i]) * c[i]; return Math.max(-3, Math.min(3, p)) * SEM_SCALE; }), 0];
};
let SEM_SCALE = 0.5;
export const setSemanticScale = (x: number) => { SEM_SCALE = x; };
/** Vector de rasgos interpretables: géneros, formato, saga, popularidad, calidad pública, época, idioma y rasgos narrativos. */
export function explicitVec(f: ItemFeatures): number[] {
  const gs = new Set(f.genres.flatMap((g) => [g, ...(GENRE_ALIAS[g] ?? [])]));
  const y = f.year ?? 2010;
  return [
    ...GENRES.map((g) => (gs.has(g) ? 1 : 0)), f.type === 'tv' ? 1 : 0, f.collection !== undefined ? 1 : 0,
    Math.log10(f.votes + 1) / 4, (f.quality - 6.8), y < 1980 ? 1 : 0, y >= 1980 && y < 1990 ? 1 : 0, y >= 1990 && y < 2000 ? 1 : 0, y >= 2000 && y < 2010 ? 1 : 0, y >= 2010 && y < 2020 ? 1 : 0, y >= 2020 ? 1 : 0,
    f.lang === 'en' ? 1 : 0, f.kids ? 1 : 0,
    ...FACETS.map((x) => f.facets.get(x.id) ?? 0),
    ...projOf(f),
  ];
}
/** Regresión ridge (forma cerrada) sobre rasgos explícitos; devuelve pesos y la media. */
export function fitRidge(X: number[][], y: number[], lambda: number) {
  const n = X.length, d = X[0]?.length ?? 0, ym = y.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const xm = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j], 0) / Math.max(1, n));
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? lambda : 0)));
  const b = new Array(d).fill(0);
  for (let r = 0; r < n; r++) for (let i = 0; i < d; i++) { const xi = X[r][i] - xm[i]; if (!xi) continue; b[i] += xi * (y[r] - ym); for (let j = 0; j < d; j++) A[i][j] += xi * (X[r][j] - xm[j]); }
  const L = cholesky(A)!;
  const w = solveLT(L, solveL(L, b));
  return { w, xm, ym, predict: (x: number[]) => ym + x.reduce((a, v, i) => a + (v - xm[i]) * w[i], 0) };
}
/** Regresión logística L2 balanceada por clase (descenso de gradiente). */
export function fitLogistic(X: number[][], y: number[], lambda: number, iters = 400) {
  const n = X.length, d = X[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  const np = y.filter((v) => v === 1).length, nn = n - np;
  if (!np || !nn) return { w, b: 0, predict: () => 0 };
  let b = 0, lr = 0.5;
  const cw = (v: number) => (v === 1 ? n / (2 * np) : n / (2 * nn));
  for (let it = 0; it < iters; it++) {
    const gw = w.map((x) => lambda * x), gbz = [0];
    for (let r = 0; r < n; r++) { const z = X[r].reduce((a, v, i) => a + v * w[i], b); const g = (1 / (1 + Math.exp(-z)) - y[r]) * cw(y[r]); for (let i = 0; i < d; i++) gw[i] += (g * X[r][i]); gbz[0] += g; }
    for (let i = 0; i < d; i++) w[i] -= (lr * gw[i]) / n;
    b -= (lr * gbz[0]) / n;
    if (it % 150 === 149) lr *= 0.6;
  }
  return { w, b, predict: (x: number[]) => x.reduce((a, v, i) => a + v * w[i], b) };
}

// ───────────────────────── núcleos ─────────────────────────
export interface KernelParams {
  /** escalas de cada similitud (varianza aportada) */
  sEmb: number; sKw: number; sGenre: number; sPeople: number; sColl: number; sType: number;
  /** largo de escala del núcleo semántico: exp((cos − 1) / ell) */
  ell: number;
  /** ruido de observación (varianza de la nota) */
  noise: number;
}
export const DEFAULT_KERNEL: KernelParams = { sEmb: 1.5, sKw: 0.5, sGenre: 0.5, sPeople: 0.3, sColl: 0.5, sType: 0.2, ell: 0.15, noise: 1.5 };
const dotMap = (a: Map<number, number>, b: Map<number, number>) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [k, v] of x) { const w = y.get(k); if (w) s += v * w; } return s; };
const tanimoto = (a: number[], b: number[]) => { if (!a.length && !b.length) return 1; let i = 0; for (const x of a) if (b.includes(x)) i++; return i / (a.length + b.length - i); };
export function cosEmb(a?: Float32Array, b?: Float32Array): number | undefined {
  if (!a || !b) return undefined;
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}
/** Componentes de similitud entre dos títulos (cada uno es un núcleo definido positivo). */
export function kernelParts(a: ItemFeatures, b: ItemFeatures) {
  const c = cosEmb(a.emb, b.emb);
  return {
    emb: c === undefined ? (a.key === b.key ? 1 : 0) : c,
    kw: a.key === b.key ? 1 : dotMap(a.kw, b.kw),
    genre: tanimoto(a.genres, b.genres),
    people: a.key === b.key ? 1 : dotMap(a.people, b.people),
    coll: a.key === b.key || (a.collection !== undefined && a.collection === b.collection) ? 1 : 0,
    type: a.type === b.type ? 1 : 0,
  };
}
export type Parts = ReturnType<typeof kernelParts>;
export const kernelOf = (p: Parts, h: KernelParams) =>
  h.sEmb * Math.exp((p.emb - 1) / h.ell) + h.sKw * p.kw + h.sGenre * p.genre + h.sPeople * p.people + h.sColl * p.coll + h.sType * p.type;

// ───────────────────────── álgebra mínima ─────────────────────────
function cholesky(A: number[][]): number[][] | null {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 1e-10) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
const solveL = (L: number[][], b: number[]) => { const n = b.length, y = new Array(n); for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; } return y; };
const solveLT = (L: number[][], y: number[]) => { const n = y.length, x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; } return x; };

// ───────────────────────── proceso gaussiano ─────────────────────────
export interface PriorMean { mu: number; beta: number; qBar: number }
export interface GPModel {
  version: string;
  train: ItemFeatures[];
  h: KernelParams;
  prior: PriorMean;
  alpha: number[];
  L: number[][];
  logML: number;
  n: number;
}
const priorOf = (p: PriorMean, f: ItemFeatures) => p.mu + p.beta * (f.quality - p.qBar);
/** Media a priori: la media de la persona, contraída hacia 7, más un poco de calidad pública (ridge 1-D). */
export function fitPrior(fs: ItemFeatures[], y: number[]): PriorMean {
  const n = y.length;
  const mu = (y.reduce((a, b) => a + b, 0) + 7 * 3) / (n + 3);
  const qBar = fs.reduce((a, f) => a + f.quality, 0) / Math.max(1, n);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { const dx = fs[i].quality - qBar; sxy += dx * (y[i] - mu); sxx += dx * dx; }
  const beta = Math.max(0, Math.min(1.2, sxy / (sxx + 4)));
  return { mu, beta, qBar };
}
function fitWith(fs: ItemFeatures[], y: number[], parts: Parts[][], h: KernelParams, prior: PriorMean): GPModel | null {
  const n = fs.length;
  const K = parts.map((row, i) => row.map((p, j) => kernelOf(p, h) + (i === j ? h.noise : 0)));
  const L = cholesky(K);
  if (!L) return null;
  const r = y.map((v, i) => v - priorOf(prior, fs[i]));
  const alpha = solveLT(L, solveL(L, r));
  let logdet = 0; for (let i = 0; i < n; i++) logdet += Math.log(L[i][i]);
  const logML = -0.5 * r.reduce((a, v, i) => a + v * alpha[i], 0) - logdet - 0.5 * n * Math.log(2 * Math.PI);
  return { version: PERSONAL_VERSION, train: fs, h, prior, alpha, L, logML, n };
}
/** Hiperparámetros por máxima verosimilitud marginal (búsqueda por coordenadas en escala log). Sin datos de evaluación. */
export function fitGP(fs: ItemFeatures[], y: number[], o: { fixed?: Partial<KernelParams>; search?: boolean } = {}): GPModel {
  const prior = fitPrior(fs, y);
  const parts = fs.map((a) => fs.map((b) => kernelParts(a, b)));
  let h: KernelParams = { ...DEFAULT_KERNEL, ...o.fixed };
  let best = fitWith(fs, y, parts, h, prior)!;
  if (o.search === false || fs.length < 4) return best;
  const keys = (Object.keys(DEFAULT_KERNEL) as (keyof KernelParams)[]).filter((k) => !(o.fixed && k in o.fixed));
  // hiperprior débil (log-normal alrededor de los valores por defecto) para no sobreajustar con pocos datos
  const penalty = (x: KernelParams) => keys.reduce((a, k) => a + 0.5 * Math.log(x[k] / DEFAULT_KERNEL[k]) ** 2, 0);
  let bestObj = best.logML - penalty(h);
  for (let round = 0; round < 4; round++) {
    let improved = false;
    for (const k of keys) for (const f of [0.5, 0.7, 1.4, 2]) {
      const cand = { ...h, [k]: Math.min(k === 'ell' ? 1 : 20, Math.max(k === 'noise' ? 0.2 : 1e-3, h[k] * f)) };
      const m = fitWith(fs, y, parts, cand, prior);
      if (!m) continue;
      const obj = m.logML - penalty(cand);
      if (obj > bestObj + 1e-6) { bestObj = obj; best = m; h = cand; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}
export interface Prediction { mean: number; sd: number; prior: number; nearest: { key: TitleKey; k: number }[] }
export function predictGP(m: GPModel, f: ItemFeatures): Prediction {
  const ks = m.train.map((t) => kernelOf(kernelParts(f, t), m.h));
  const prior = priorOf(m.prior, f);
  const mean = prior + ks.reduce((a, k, i) => a + k * m.alpha[i], 0);
  const v = solveL(m.L, ks);
  const kss = kernelOf(kernelParts(f, f), m.h);
  const variance = Math.max(1e-6, kss - v.reduce((a, x) => a + x * x, 0));
  const nearest = m.train.map((t, i) => ({ key: t.key, k: ks[i] })).sort((a, b) => b.k - a.k).slice(0, 3);
  return { mean, sd: Math.sqrt(variance), prior, nearest };
}

// ───────────────────────── preferencias relativas (pares) ─────────────────────────
/**
 * Aprendizaje de ranking por pares con núcleos: f = K·a minimiza Σ w_ij · log(1 + e^−(f_i − f_j)) + λ/2 · aᵀKa
 * sobre los pares con notas distintas. Devuelve un puntaje (no una nota) y una calibración lineal a notas.
 */
export interface PairModel { train: ItemFeatures[]; h: KernelParams; a: number[]; slope: number; icpt: number }
export function fitPairs(fs: ItemFeatures[], y: number[], h: KernelParams, lambda = 1, iters = 300): PairModel {
  const n = fs.length;
  const K = fs.map((x) => fs.map((z) => kernelOf(kernelParts(x, z), h)));
  const a = new Array(n).fill(0);
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (y[i] > y[j]) pairs.push([i, j, Math.min(3, y[i] - y[j])]);
  const W = pairs.reduce((s, p) => s + p[2], 0) || 1;
  let lr = 0.5;
  for (let it = 0; it < iters; it++) {
    const f = K.map((row) => row.reduce((s, k, j) => s + k * a[j], 0));
    const gf = new Array(n).fill(0);
    for (const [i, j, w] of pairs) { const g = -w / (1 + Math.exp(f[i] - f[j])) / W; gf[i] += g; gf[j] -= g; }
    // gradiente respecto de a: K·gf + λ·K·a  (se aplica en el espacio de f: precondicionado)
    for (let i = 0; i < n; i++) a[i] -= lr * (gf[i] + lambda * a[i] / n);
    if (it % 100 === 99) lr *= 0.5;
  }
  const f = K.map((row) => row.reduce((s, k, j) => s + k * a[j], 0));
  const fm = f.reduce((s, v) => s + v, 0) / n, ym = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (f[i] - fm) * (y[i] - ym); sxx += (f[i] - fm) ** 2; }
  const slope = sxx > 1e-9 ? sxy / sxx : 0;
  return { train: fs, h, a, slope, icpt: ym - slope * fm };
}
export const pairScore = (m: PairModel, f: ItemFeatures) => m.train.reduce((s, t, i) => s + kernelOf(kernelParts(f, t), m.h) * m.a[i], 0);

// ───────────────────────── interés (vistos vs. «no me interesa») ─────────────────────────
/**
 * Probabilidad de que el título le interese lo suficiente para verlo. Positivos: títulos vistos (con o sin nota).
 * Negativos: «no me interesa». NO es una nota: un descarte dice «no quiero verla», no «es mala».
 * Regresión logística con núcleos y regularización fuerte; sin datos de descartes devuelve 0,5 (sin efecto).
 */
export interface InterestModel { train: ItemFeatures[]; h: KernelParams; a: number[]; b: number; n: number }
export function fitInterest(pos: ItemFeatures[], neg: ItemFeatures[], h: KernelParams, lambda = 2, iters = 300): InterestModel {
  const fs = [...pos, ...neg], y = [...pos.map(() => 1), ...neg.map(() => 0)], n = fs.length;
  if (!neg.length || !pos.length) return { train: [], h, a: [], b: 0, n: 0 };
  const K = fs.map((x) => fs.map((z) => kernelOf(kernelParts(x, z), h)));
  const a = new Array(n).fill(0);
  let b = Math.log(pos.length / neg.length), lr = 0.5;
  const wPos = n / (2 * pos.length), wNeg = n / (2 * neg.length);
  for (let it = 0; it < iters; it++) {
    const f = K.map((row) => row.reduce((s, k, j) => s + k * a[j], b));
    let gb = 0;
    for (let i = 0; i < n; i++) { const p = 1 / (1 + Math.exp(-f[i])); const g = (p - y[i]) * (y[i] ? wPos : wNeg) / n; a[i] -= lr * (g + lambda * a[i] / n); gb += g; }
    b -= lr * gb;
    if (it % 100 === 99) lr *= 0.5;
  }
  return { train: fs, h, a, b, n };
}
export const interestLogit = (m: InterestModel, f: ItemFeatures) => (m.n ? m.train.reduce((s, t, i) => s + kernelOf(kernelParts(f, t), m.h) * m.a[i], m.b) : 0);
