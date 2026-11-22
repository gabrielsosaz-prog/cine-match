/**
 * Motor narrativo v3.1.
 *
 * Representación de cada título (cuando hay datos):
 *  - Vector semántico REAL: embedding del modelo bge-small-en-v1.5 (ONNX cuantizado) calculado sobre la sinopsis
 *    inglesa de TMDB y, cuando existe, la sección de argumento/premisa de Wikipedia. Se precalcula fuera del
 *    dispositivo (GitHub Actions) para un catálogo amplio; el texto fuente no se distribuye.
 *  - Rasgos narrativos (facets.json): conflicto, relaciones, poder, secretos, misterio, tono, ritmo, estructura…
 *    Cada rasgo lleva procedencia (palabras clave de TMDB y/o detección semántica) y confianza. Si no hay datos,
 *    el rasgo no existe para ese título: no se completa por suposición.
 *  - Palabras clave específicas ponderadas por rareza (IDF global del catálogo) y coincidencias débiles atenuadas.
 *
 * Similitud entre una referencia R y un candidato C (dirigida: «¿cuánto de lo que tiene R aparece en C?»):
 *  componentes en [0,1] → semántica (coseno calibrado contra pares al azar), rasgos (cobertura ponderada por
 *  rareza, fuerza y confianza), palabras clave (cobertura por IDF), personas (creación/guion) y género (mínimo).
 *  Los componentes sin datos se tratan como desconocidos: no suman ni restan, pero bajan la confianza y
 *  acotan el puntaje. 100 % se reserva a la identidad (mismo título).
 */
import FACET_DATA from './facets.json';
import type { TitleKey, TitleMeta } from '../../types';
import { weakFactor, weakKind } from './weak';

export interface FacetDef { id: string; dim: string; label: string; strength: 'strong' | 'medium' | 'weak'; kw: string[]; proto: string[]; opposite?: string[] }
export const FACETS: FacetDef[] = FACET_DATA.facets as FacetDef[];
export const FACET = new Map(FACETS.map((f) => [f.id, f]));
const STRENGTH = { strong: 1, medium: 0.6, weak: 0.15 } as const;
const KW_RULES = FACETS.map((f) => ({ id: f.id, set: new Set(f.kw.map((s) => s.toLowerCase())) }));
const WEAK_KW = new Set(FACET_DATA.weakKeywords.map((s) => s.toLowerCase()));

export interface FacetEvidence { conf: number; kw: string[]; z: number }
export interface Narrative {
  key: TitleKey;
  facets: Map<string, FacetEvidence>;
  kw: Map<number, string>;
  genres: number[];
  people: number[];
  writers: number[];
  collection?: number;
  /** fila del embedding en el catálogo (-1 = sin vector) */
  row: number;
  /** 2 = sinopsis + argumento de Wikipedia; 1 = sólo sinopsis; 0 = sin texto */
  textQ: number;
  textLen: number;
  inCatalog: boolean;
}

export interface CatalogTitle {
  key: TitleKey; title: string; year?: number; genres: number[]; kw: number[]; countries: string[]; lang: string;
  collection?: number; people: number[]; writers: number[]; cast: number[]; vote: number; votes: number; pop: number;
  poster?: string; facets: [string, number, string[], number][]; textQ: number; textLen: number; provAR: number[];
  runtime?: number; seasons?: number; row: number;
}

export interface CatalogMeta {
  version: string; model: string; dim: number; embedded: number; n: number; semZ: number;
  calib: { p50: number; p90: number; p99: number; p999: number; mean: number };
  sources: Record<string, string>;
  df: { kw: Record<string, number>; facet: Record<string, number>; genre: Record<string, number> };
  kwNames: Record<string, string>;
  titles: unknown[][];
}

/** Rasgos a partir de palabras clave de TMDB (misma regla que el constructor del catálogo). */
export function facetsFromKeywords(names: string[]): Map<string, FacetEvidence> {
  const out = new Map<string, FacetEvidence>();
  const low = names.map((n) => n.toLowerCase());
  for (const r of KW_RULES) {
    const hits = low.filter((n) => r.set.has(n));
    if (!hits.length) continue;
    let c = 0;
    for (const h of hits) c = 1 - (1 - c) * (1 - (WEAK_KW.has(h) || !h.includes(' ') ? 0.45 : 0.8));
    if (c >= 0.3) out.set(r.id, { conf: Math.round(Math.min(0.95, c) * 100) / 100, kw: hits.slice(0, 3), z: 0 });
  }
  return out;
}

export class NarrativeIndex {
  readonly meta: CatalogMeta;
  readonly emb?: Int8Array;
  readonly titles: CatalogTitle[];
  private byKey: Map<TitleKey, CatalogTitle>;
  private nDocs: number;

  constructor(meta: CatalogMeta, emb?: Int8Array) {
    this.meta = meta;
    this.emb = emb && emb.length >= meta.embedded * meta.dim ? emb : undefined;
    this.titles = meta.titles.map((r, i) => {
      const [key, title, year, genres, kw, countries, lang, collection, people, writers, cast, vote, votes, pop, poster, facets, textQ, textLen, provAR, runtime, seasons] = r as any[];
      return { key, title, year: year || undefined, genres, kw, countries, lang, collection: collection || undefined, people, writers, cast, vote, votes, pop, poster: poster || undefined, facets, textQ, textLen, provAR: provAR ?? [], runtime: runtime || undefined, seasons: seasons || undefined, row: i < meta.embedded && this.emb ? i : -1 };
    });
    this.byKey = new Map(this.titles.map((t) => [t.key, t]));
    this.nDocs = Math.max(1, meta.n);
  }

  get size() { return this.titles.length; }
  get(key: TitleKey) { return this.byKey.get(key); }
  kwName(id: number) { return this.meta.kwNames[id]; }

  /** IDF global: rasgos y palabras clave frecuentes en el catálogo pesan menos. */
  kwIdf(id: number) { return Math.log(1 + this.nDocs / ((this.meta.df.kw[id] ?? 0) + 1)); }
  facetIdf(id: string) { return Math.log(1 + this.nDocs / ((this.meta.df.facet[id] ?? 0) + 1)); }
  genreIdf(id: number) { return Math.log(1 + this.nDocs / ((this.meta.df.genre[id] ?? 0) + 1)); }

  /** Coseno entre dos filas del catálogo (vectores normalizados, int8). */
  cosRows(a: number, b: number): number {
    const e = this.emb!, d = this.meta.dim;
    let s = 0;
    const oa = a * d, ob = b * d;
    for (let i = 0; i < d; i++) s += e[oa + i] * e[ob + i];
    return s / (127 * 127);
  }
  cosVec(v: Float32Array, row: number): number {
    const e = this.emb!, d = this.meta.dim, o = row * d;
    let s = 0;
    for (let i = 0; i < d; i++) s += v[i] * e[o + i];
    return s / 127;
  }
  rowVec(row: number): Float32Array {
    const d = this.meta.dim, v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = this.emb![row * d + i] / 127;
    return v;
  }
  /**
   * Coseno → [0,1] calibrado con la distribución de pares al azar del catálogo:
   * 0 = como dos títulos cualquiera (mediana); 1 = tan parecido como el 0,1 % más parecido de los pares al azar.
   */
  semScore(cos: number): number {
    const { p50, p999 } = this.meta.calib;
    return Math.max(0, Math.min(1, (cos - p50) / Math.max(1e-6, p999 - p50)));
  }

  /** Representación narrativa: del catálogo si está; si no, desde la ficha (sólo palabras clave, sin vector). */
  narrativeOf(key: TitleKey, meta?: TitleMeta): Narrative | undefined {
    const c = this.byKey.get(key);
    if (c) {
      const facets = new Map<string, FacetEvidence>(c.facets.map(([id, conf, kw, z]) => [id, { conf, kw, z }]));
      return { key, facets, kw: new Map(c.kw.map((id) => [id, this.kwName(id) ?? ''])), genres: c.genres, people: c.people, writers: c.writers, collection: c.collection, row: c.row, textQ: c.textQ, textLen: c.textLen, inCatalog: true };
    }
    return meta ? narrativeFromMeta(meta) : undefined;
  }
}

export function narrativeFromMeta(m: TitleMeta): Narrative {
  return {
    key: m.key, facets: facetsFromKeywords(m.keywords.map((k) => k.name)), kw: new Map(m.keywords.map((k) => [k.id, k.name])),
    genres: m.genres.map((g) => g.id), people: m.directors.map((p) => p.id), writers: (m.writers ?? []).map((p) => p.id),
    collection: m.collection?.id, row: -1, textQ: m.overview ? 1 : 0, textLen: m.overview?.length ?? 0, inCatalog: false,
  };
}

export type ComponentId = 'sem' | 'facets' | 'kw' | 'people' | 'genre';
export const COMPONENT_WEIGHT: Record<ComponentId, number> = { sem: 0.45, facets: 0.25, kw: 0.18, people: 0.07, genre: 0.05 };
export const COMPONENT_LABEL: Record<ComponentId, string> = { sem: 'argumento (análisis semántico)', facets: 'rasgos narrativos', kw: 'temáticas específicas', people: 'creación y guion', genre: 'género' };

export interface SharedFacet { id: string; label: string; dim: string; strength: FacetDef['strength']; weight: number; confRef: number; confCand: number; kw: string[]; semantic: boolean }
export interface SharedKw { id: number; name: string; weight: number; weak: boolean }
export interface PairSimilarity {
  score: number;
  components: Partial<Record<ComponentId, number>>;
  facets: SharedFacet[];
  keywords: SharedKw[];
  weak: SharedKw[];
  people: number[];
  /** diferencias relevantes: rasgos fuertes de la referencia ausentes en el candidato o tonos opuestos */
  differences: { kind: 'missing' | 'opposite'; facet: string; label: string; other?: string }[];
  sameFranchise: boolean;
  /** 0-1: cuánta evidencia respalda la comparación */
  evidence: number;
}

const facetWeight = (idx: NarrativeIndex | undefined, id: string) => STRENGTH[FACET.get(id)?.strength ?? 'weak'] * (idx ? idx.facetIdf(id) / 3 : 1);
const kwWeight = (idx: NarrativeIndex | undefined, id: number, name: string) => (idx ? idx.kwIdf(id) : 3) * weakFactor(weakKind(name));

/** Similitud dirigida R → C. */
export function pairSimilarity(R: Narrative, C: Narrative, idx?: NarrativeIndex): PairSimilarity {
  const comp: Partial<Record<ComponentId, number>> = {};
  // Semántica
  let semOk = false;
  if (idx?.emb && R.row >= 0 && C.row >= 0) { comp.sem = idx.semScore(idx.cosRows(R.row, C.row)); semOk = true; }
  // Rasgos
  const facets: SharedFacet[] = [];
  let fTot = 0, fHit = 0;
  for (const [id, ev] of R.facets) {
    const w = facetWeight(idx, id) * ev.conf;
    fTot += w;
    const c = C.facets.get(id);
    if (c) {
      const hit = w * Math.min(1, c.conf / Math.max(0.3, ev.conf));
      fHit += hit;
      const def = FACET.get(id)!;
      facets.push({ id, label: def.label, dim: def.dim, strength: def.strength, weight: hit, confRef: ev.conf, confCand: c.conf, kw: [...new Set([...ev.kw, ...c.kw])].filter((k) => ev.kw.includes(k) && c.kw.includes(k)), semantic: ev.z > 0 || c.z > 0 });
    }
  }
  if (R.facets.size) comp.facets = fHit / (fTot + 0.6);
  // Palabras clave
  const keywords: SharedKw[] = [], weak: SharedKw[] = [];
  let kTot = 0, kHit = 0;
  for (const [id, name] of R.kw) {
    const w = kwWeight(idx, id, name);
    kTot += w;
    if (C.kw.has(id)) {
      kHit += w;
      const wk = weakKind(name) !== undefined;
      (wk ? weak : keywords).push({ id, name, weight: w, weak: wk });
    }
  }
  if (R.kw.size) comp.kw = kHit / (kTot + 4);
  // Personas (creación/dirección y guion)
  const people = [...new Set([...R.people, ...R.writers])].filter((p) => C.people.includes(p) || C.writers.includes(p));
  if (R.people.length || R.writers.length) comp.people = Math.min(1, people.length * 0.5);
  // Género (mínimo, ponderado por rareza)
  if (R.genres.length && C.genres.length) {
    const wg = (g: number) => (idx ? idx.genreIdf(g) : 1);
    const inter = R.genres.filter((g) => C.genres.includes(g)).reduce((a, g) => a + wg(g), 0);
    const uni = [...new Set([...R.genres, ...C.genres])].reduce((a, g) => a + wg(g), 0);
    comp.genre = uni ? inter / uni : 0;
  }
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(comp) as [ComponentId, number][]) { num += COMPONENT_WEIGHT[k] * v; den += COMPONENT_WEIGHT[k]; }
  const availShare = den; // suma de pesos disponibles (máx. 1)
  // Evidencia faltante = desconocida: se renormaliza pero se acota el puntaje (evita 90 % con dos etiquetas)
  let score = den ? (num / den) * (0.55 + 0.45 * availShare) : 0;
  // Sin vector semántico, el puntaje se apoya en etiquetas: tope prudente
  if (!semOk) score = Math.min(score, 0.75);
  // Candidato casi sin datos: no puede parecer muy similar
  const thin = C.kw.size < 3 && C.facets.size === 0 && C.row < 0;
  if (thin) score *= 0.5;
  const sameFranchise = Boolean(R.collection && R.collection === C.collection);
  // Diferencias: rasgos fuertes y seguros de R ausentes en C; tonos/ritmos opuestos
  const differences: PairSimilarity['differences'] = [];
  for (const [id, ev] of R.facets) {
    const def = FACET.get(id)!;
    if (def.strength === 'strong' && ev.conf >= 0.6 && !C.facets.has(id) && C.facets.size >= 2) differences.push({ kind: 'missing', facet: id, label: def.label });
    for (const o of def.opposite ?? []) if ((C.facets.get(o)?.conf ?? 0) >= 0.5) differences.push({ kind: 'opposite', facet: id, label: def.label, other: FACET.get(o)?.label });
  }
  const evidence = Math.min(1, (semOk ? 0.35 + 0.1 * Math.min(R.textQ, C.textQ) : 0) + 0.25 * Math.min(1, facets.length / 3) + 0.15 * Math.min(1, Math.min(R.kw.size, C.kw.size) / 8) + 0.15 * Math.min(1, fTot / 2));
  facets.sort((a, b) => b.weight - a.weight);
  keywords.sort((a, b) => b.weight - a.weight);
  return { score: Math.max(0, Math.min(0.99, score)), components: comp, facets, keywords, weak, people, differences: differences.slice(0, 3), sameFranchise, evidence };
}

export const confidenceLabel = (e: number) => (e >= 0.7 ? 'alta' : e >= 0.45 ? 'media' : 'baja');

/** Porcentaje mostrado: 100 % sólo para el mismo título. */
export const similarityPercent = (score: number, identical = false) => (identical ? 100 : Math.min(99, Math.round(score * 100)));
