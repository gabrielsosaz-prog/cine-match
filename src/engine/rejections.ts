import type { Rating, TitleKey, TitleMeta } from '../types';

/**
 * Aprendizaje por descartes («No me interesa»): modelo jerárquico de preferencias.
 *
 *   1. Título individual   → se excluye del ranking (en recommender.rank).
 *   2. Saga o franquicia   → colección oficial de TMDB (`belongs_to_collection`). No se infieren sagas.
 *   3. Subgénero/temática  → palabras clave de TMDB (p. ej. «superhero», «based on comic»).
 *   4. Género general      → géneros de TMDB, con contracción fuerte: un solo descarte casi no pesa.
 *
 * Cada nivel compara descartes contra títulos que te gustaron con el mismo rasgo: la evidencia positiva
 * diluye la penalización (recuperación) y, si coincide un rasgo específico que puntuaste bien sin descartes
 * (la misma saga, una palabra clave como «batman», el mismo director), se trata como excepción positiva
 * y se atenúan los niveles generales. «No me interesa» no es una mala nota: no alimenta el perfil de gustos.
 */
export const REJECTION = {
  collectionGain: 0.8,
  collectionLambda: 1,
  keywordGain: 0.9,
  keywordLambda: 3,
  genreGain: 0.6,
  genreLambda: 6,
  positiveWeight: 1.5,
  maxPenalty: 2,
};

interface Counter { rej: number; pos: number }
export interface RejectionModel {
  count: number;
  collections: Map<number, Counter & { name: string }>;
  keywords: Map<number, Counter>;
  genres: Map<number, Counter>;
  directors: Map<number, Counter>;
}

export interface RejectionResult {
  penalty: number; // ≤ 0
  level?: 'collection' | 'keyword' | 'genre';
  collectionName?: string;
  /** Rasgo específico que cuenta como excepción positiva */
  exception?: { kind: 'collection' | 'keyword' | 'director'; id: number };
  keywordIds: number[];
  genreIds: number[];
}

const bump = <K,>(m: Map<K, Counter>, k: K, field: keyof Counter, v = 1) => {
  const c = m.get(k) ?? { rej: 0, pos: 0 };
  c[field] += v; m.set(k, c);
};

export const isRejection = (r: Rating) => Boolean(r.notInterested) && r.overall === undefined;

/**
 * @param liked títulos con señal claramente positiva (nota por encima de tu media)
 */
export function buildRejectionModel(ratings: Rating[], titles: Map<TitleKey, TitleMeta>, liked: TitleKey[]): RejectionModel {
  const m: RejectionModel = { count: 0, collections: new Map(), keywords: new Map(), genres: new Map(), directors: new Map() };
  const add = (t: TitleMeta, field: keyof Counter) => {
    if (t.collection) {
      const c = m.collections.get(t.collection.id) ?? { rej: 0, pos: 0, name: t.collection.name };
      c[field] += 1; m.collections.set(t.collection.id, c);
    }
    for (const k of t.keywords.slice(0, 25)) bump(m.keywords, k.id, field);
    for (const g of t.genres) bump(m.genres, g.id, field);
    for (const d of t.directors.slice(0, 3)) bump(m.directors, d.id, field);
  };
  for (const r of ratings) {
    if (!isRejection(r)) continue;
    const t = titles.get(r.key);
    m.count++;
    if (t) add(t, 'rej');
  }
  for (const k of liked) { const t = titles.get(k); if (t) add(t, 'pos'); }
  return m;
}

const net = (c: Counter | undefined, lambda: number) => (c && c.rej ? -c.rej / (c.rej + REJECTION.positiveWeight * c.pos + lambda) : 0);

export function rejectionPenalty(t: TitleMeta, m: RejectionModel): RejectionResult {
  const res: RejectionResult = { penalty: 0, keywordIds: [], genreIds: [] };
  if (!m.count) return res;
  // Excepciones positivas: rasgos específicos que te gustaron y nunca descartaste
  let exception = 0;
  const consider = (kind: 'collection' | 'keyword' | 'director', id: number, c?: Counter) => {
    if (!c || c.pos === 0 || c.rej > 0) return;
    const e = c.pos / (c.pos + 1);
    if (e > exception) { exception = e; res.exception = { kind, id }; }
  };
  const col = t.collection ? m.collections.get(t.collection.id) : undefined;
  if (t.collection) consider('collection', t.collection.id, col);
  for (const k of t.keywords.slice(0, 25)) { const c = m.keywords.get(k.id); if (c && c.pos >= 2) consider('keyword', k.id, c); }
  for (const d of t.directors.slice(0, 3)) consider('director', d.id, m.directors.get(d.id));

  const colPen = REJECTION.collectionGain * net(col, REJECTION.collectionLambda);
  const kw = t.keywords.slice(0, 25).map((k) => ({ id: k.id, v: net(m.keywords.get(k.id), REJECTION.keywordLambda) })).filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 2);
  const kwPen = kw.length ? REJECTION.keywordGain * (kw.reduce((a, b) => a + b.v, 0) / kw.length) : 0;
  const gn = t.genres.map((g) => ({ id: g.id, v: net(m.genres.get(g.id), REJECTION.genreLambda) })).filter((x) => x.v < 0).sort((a, b) => a.v - b.v);
  const genrePen = gn.length ? REJECTION.genreGain * gn[0].v : 0;
  const penalty = Math.max(-REJECTION.maxPenalty, colPen + (1 - exception) * (kwPen + genrePen));
  res.penalty = penalty;
  res.keywordIds = kw.map((x) => x.id);
  res.genreIds = gn.slice(0, 1).map((x) => x.id);
  if (penalty < 0) {
    res.level = colPen <= Math.min(kwPen, genrePen) && colPen < 0 ? 'collection' : kwPen <= genrePen ? 'keyword' : 'genre';
    if (res.level === 'collection') res.collectionName = t.collection?.name;
  }
  return res;
}
