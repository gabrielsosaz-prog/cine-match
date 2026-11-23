/**
 * v3.4 · Evaluación reproducible de recomendaciones (offline, datos reales del repositorio).
 *
 * Uso: npx tsx scripts/eval/recs.ts [--quick]
 * Entradas: catálogo narrativo (public/catalog) + datos de referencia (eval/data/reference.json: Wikidata y
 * categorías de Wikipedia, obtenidos con scripts/research/reference.mjs). Salida: docs/eval-v3.4.json y .md.
 *
 * Principios:
 *  - Los juicios de relevancia salen de clasificaciones EDITORIALES externas (Wikidata, Wikipedia) que el motor no
 *    usa, nunca del puntaje del motor. No son juicios de personas: miden si cada algoritmo recupera lo que un
 *    perfil con gustos explícitos debería encontrar según esas fuentes.
 *  - Partición fija por título (hash): las valoraciones de los perfiles salen sólo de «desarrollo»; los candidatos
 *    y los juicios, sólo de «evaluación». Cualquier ajuste se hace mirando «desarrollo».
 *  - Mismos candidatos, mismas valoraciones y mismos datos para los cuatro algoritmos.
 *  - Si un perfil no tiene suficientes títulos relevantes juzgables, sus métricas de relevancia son «no disponibles».
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NarrativeIndex, type CatalogMeta } from '../../src/engine/narrative';
import { hybridEngine, ALGORITHM_VERSION } from '../../src/engine/recommender';
import type { Rating, TitleKey, TitleMeta } from '../../src/types';
import { PROFILES, setLowVotes, type EvalProfile, type Ref } from './profiles';

const QUICK = process.argv.includes('--quick');
/** --dev: candidatos y juicios del conjunto de desarrollo (para ajustar); predeterminado: evaluación final. */
const PHASE: 'dev' | 'test' = process.argv.includes('--dev') ? 'dev' : 'test';
const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const cm = JSON.parse(readFileSync(`public/catalog/${man.meta}`, 'utf8')) as CatalogMeta;
const buf = readFileSync(`public/catalog/${man.emb}`);
export const idx = new NarrativeIndex(cm, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
const refRaw = JSON.parse(readFileSync('eval/data/reference.json', 'utf8'));
{ const v = idx.titles.map((t) => t.votes).sort((a, b) => a - b); setLowVotes(v[Math.floor(v.length / 4)]); }

// ───────── datos ─────────
const GENRE_NAMES: Record<number, string> = { 28: 'Acción', 12: 'Aventura', 16: 'Animación', 35: 'Comedia', 80: 'Crimen', 99: 'Documental', 18: 'Drama', 10751: 'Familia', 14: 'Fantasía', 36: 'Historia', 27: 'Terror', 10402: 'Música', 9648: 'Misterio', 10749: 'Romance', 878: 'Ciencia ficción', 10770: 'Película de TV', 53: 'Suspense', 10752: 'Bélica', 37: 'Western', 10759: 'Acción y aventura', 10762: 'Infantil', 10763: 'Noticias', 10764: 'Reality', 10765: 'Ciencia ficción y fantasía', 10766: 'Telenovela', 10767: 'Talk show', 10768: 'Guerra y política' };
/** Ficha a partir del catálogo, con créditos por id (los nombres no influyen en el puntaje). */
export function metaOf(key: TitleKey): TitleMeta {
  const c = idx.get(key)!;
  const [type, id] = key.split(':');
  return {
    key, type: type as 'movie' | 'tv', tmdbId: Number(id), title: c.title, year: c.year,
    genres: c.genres.map((g) => ({ id: g, name: GENRE_NAMES[g] ?? `Género ${g}` })), keywords: c.kw.map((k) => ({ id: k, name: idx.kwName(k) ?? '' })),
    cast: c.cast.map((p, i) => ({ id: p, name: `p${p}`, order: i })), directors: c.people.map((p) => ({ id: p, name: `p${p}` })), writers: c.writers.map((p) => ({ id: p, name: `p${p}` })),
    runtime: c.runtime, numberOfSeasons: c.seasons, originalLanguage: c.lang, originCountry: c.countries, voteAverage: c.vote, voteCount: c.votes, popularity: c.pop,
    collection: c.collection ? { id: c.collection, name: '' } : undefined, completeness: 'full', missing: [], source: 'catálogo', fetchedAt: 0, metaVersion: 3,
  };
}
const labels: Record<string, string> = refRaw.labels;
const catNames: string[] = refRaw.cats;
/** Referencia editorial de un título (undefined = sin Wikidata: no juzgable). */
export function refOf(key: TitleKey): Ref | undefined {
  const r = refRaw.titles[key];
  if (!r) return undefined;
  const lab = (p: string) => (r[p] ?? []).map((q: string) => (labels[q] ?? q).toLowerCase());
  return { cats: (r.cats ?? []).map((i: number) => catNames[i].toLowerCase()), genre: lab('P136'), subject: lab('P921'), audience: lab('P2360'), nominated: lab('P1411'), awards: lab('P166'), hasWiki: Boolean(r.wiki) };
}
/** Partición fija: 50 % desarrollo / 50 % evaluación final, por hash del título. */
export function split(key: string): 'dev' | 'test' {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2 === 0 ? 'dev' : 'test';
}
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = <T>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ───────── algoritmos ─────────
export type AlgoId = 'A-popularidad' | 'B-generos' | 'C-contenido' | 'D-motor' | 'D-sin-datos-narrativos' | 'E-motor-sin-recorte' | 'F-sin-recorte-1-por-saga';
interface AlgoIn { ratings: Rating[]; titles: Map<TitleKey, TitleMeta>; candidates: TitleKey[]; k: number }
const meanOf = (rs: Rating[]) => { const v = rs.map((r) => r.overall!).filter((x) => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 6.5; };
const bayes = (t: TitleMeta) => ((t.voteAverage ?? 0) * (t.voteCount ?? 0) + 6.6 * 300) / ((t.voteCount ?? 0) + 300);
const topK = (scores: Map<TitleKey, number>, k: number) => [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map((x) => x[0]);
export const ALGOS: Record<AlgoId, (x: AlgoIn) => TitleKey[]> = {
  /** A: nota pública de TMDB (bayesiana, igual que la auxiliar del motor). No personaliza. */
  'A-popularidad': ({ titles, candidates, k }) => topK(new Map(candidates.map((c) => [c, bayes(titles.get(c)!)])), k),
  /** B: afinidad media por género (nota − tu media), contraída; desempate por nota pública. */
  'B-generos': ({ ratings, titles, candidates, k }) => {
    const m = meanOf(ratings);
    const aff = new Map<number, { s: number; n: number }>();
    for (const r of ratings) if (r.overall !== undefined) for (const g of titles.get(r.key)!.genres) { const a = aff.get(g.id) ?? { s: 0, n: 0 }; a.s += r.overall - m; a.n++; aff.set(g.id, a); }
    const sc = new Map(candidates.map((c) => { const gs = titles.get(c)!.genres; const v = gs.length ? gs.reduce((s, g) => { const a = aff.get(g.id); return s + (a ? a.s / (a.n + 2) : 0); }, 0) / gs.length : 0; return [c, v + 0.01 * bayes(titles.get(c)!)]; }));
    return topK(sc, k);
  },
  /** C: kNN por similitud de contenido (vectores semánticos del catálogo; sin vector, palabras clave). */
  'C-contenido': ({ ratings, candidates, k }) => {
    const m = meanOf(ratings);
    const rated = ratings.filter((r) => r.overall !== undefined).map((r) => ({ c: idx.get(r.key)!, dev: r.overall! - m }));
    const kwSet = (key: TitleKey) => new Set(idx.get(key)!.kw);
    const sc = new Map<TitleKey, number>();
    for (const key of candidates) {
      const c = idx.get(key)!;
      const sims = rated.map((r) => {
        let s: number;
        if (c.row >= 0 && r.c.row >= 0) s = idx.semScore(idx.cosRows(c.row, r.c.row));
        else { const a = kwSet(key), b = new Set(r.c.kw); const inter = [...a].filter((x) => b.has(x)).length; s = inter / Math.max(1, a.size + b.size - inter); }
        return { s, dev: r.dev };
      }).sort((a, b) => b.s - a.s).slice(0, 20);
      let num = 0, den = 0.5;
      for (const x of sims) { num += x.s * x.dev; den += x.s; }
      sc.set(key, num / den);
    }
    return topK(sc, k);
  },
  /** D: motor publicado en 3.3.0 (hybrid-narrative-3.1.0): perfil + canales + MMR + exploración con semilla fija. */
  'D-motor': ({ ratings, titles, candidates, k }) => {
    const profile = hybridEngine.buildProfile(ratings, titles);
    return hybridEngine.rank({ profile, ratings, titles, candidates, limit: k, seed: 7, narrative: idx, rankBy: 'capped', collectionCap: false }).map((i) => i.key);
  },
  /** E (experimento v3.4): el mismo motor, pero ordena por la suma de canales sin recortar a 10 (evita empates en 10). */
  'E-motor-sin-recorte': ({ ratings, titles, candidates, k }) => {
    const profile = hybridEngine.buildProfile(ratings, titles);
    return hybridEngine.rank({ profile, ratings, titles, candidates, limit: k, seed: 7, narrative: idx, rankBy: 'uncapped', collectionCap: false }).map((i) => i.key);
  },
  /** F (experimento v3.4, definido después de ver la redundancia de E): E + como máximo 1 título por saga en el top 10. */
  'F-sin-recorte-1-por-saga': ({ ratings, titles, candidates, k }) => {
    const profile = hybridEngine.buildProfile(ratings, titles);
    return hybridEngine.rank({ profile, ratings, titles, candidates, limit: k, seed: 7, narrative: idx, rankBy: 'uncapped', collectionCap: true }).map((i) => i.key);
  },
  /** Ablación (metadatos incompletos): el mismo motor sin vectores ni rasgos del catálogo y sin palabras clave en la mitad de los candidatos. */
  'D-sin-datos-narrativos': ({ ratings, titles, candidates, k }) => {
    const t2 = new Map(titles);
    for (const c of candidates) if (c.charCodeAt(c.length - 1) % 2 === 0) t2.set(c, { ...titles.get(c)!, keywords: [] });
    const profile = hybridEngine.buildProfile(ratings, t2);
    return hybridEngine.rank({ profile, ratings, titles: t2, candidates, limit: k, seed: 7, narrative: null, rankBy: 'capped', collectionCap: false }).map((i) => i.key);
  },
};

// ───────── métricas ─────────
const dcg = (gains: number[]) => gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
export function relevanceMetrics(list: TitleKey[], grade: (k: TitleKey) => number, allGrades: number[]) {
  const top5 = list.slice(0, 5), top10 = list.slice(0, 10);
  const ideal = [...allGrades].sort((a, b) => b - a).slice(0, 10);
  return {
    p5: top5.filter((k) => grade(k) > 0).length / 5,
    p10: top10.filter((k) => grade(k) > 0).length / 10,
    ndcg10: dcg(ideal) ? dcg(top10.map(grade)) / dcg(ideal) : 0,
  };
}
const jacc = (a: Set<unknown>, b: Set<unknown>) => { const i = [...a].filter((x) => b.has(x)).length; return i / Math.max(1, a.size + b.size - i); };
export function listMetrics(list: TitleKey[]) {
  const ts = list.map((k) => idx.get(k)!);
  let gd = 0, sd = 0, n = 0, ns = 0, same = 0;
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    n++; gd += 1 - jacc(new Set(ts[i].genres), new Set(ts[j].genres));
    if (ts[i].row >= 0 && ts[j].row >= 0) { ns++; sd += 1 - idx.cosRows(ts[i].row, ts[j].row); }
    if (ts[i].collection && ts[i].collection === ts[j].collection) same++;
  }
  const votes = ts.map((t) => t.votes);
  return {
    genreDiversity: n ? gd / n : 0,
    semanticDiversity: ns ? sd / ns : 0,
    /** pares de la misma saga (colección de TMDB) */
    sameCollectionPairs: same,
    /** novedad: −log10 de la popularidad relativa (votos / máximo del catálogo) */
    novelty: ts.length ? ts.reduce((s, t) => s - Math.log10(Math.max(1, t.votes) / MAXV), 0) / ts.length : 0,
    medianVotes: votes.sort((a, b) => a - b)[Math.floor(votes.length / 2)] ?? 0,
  };
}
const MAXV = Math.max(...idx.titles.map((t) => t.votes));

// ───────── perfiles → valoraciones ─────────
const now = Date.UTC(2026, 10, 1);
const rating = (profileId: string, key: TitleKey, overall: number): Rating => ({ id: `${profileId}|${key}`, profileId, key, watched: true, overall, dimensions: {}, createdAt: now, updatedAt: now, schema: 3 });
export interface Built { p: EvalProfile; ratings: Rating[]; candidates: TitleKey[]; grade: (k: TitleKey) => number; judged: { positives: number; negatives: number }; usable: boolean }
export function build(p: EvalProfile, seed = 1): Built {
  const r = rng(seed * 7919 + p.id.length);
  const all = idx.titles.map((t) => t.key as TitleKey);
  const withRef = all.map((k) => ({ k, ref: refOf(k) }));
  const devPool = withRef.filter((x) => split(x.k) === 'dev' && x.ref);
  const like = shuffle(devPool.filter((x) => p.grade(x.ref!, idx.get(x.k)!) >= (p.seedGrade ?? 2)), r).slice(0, p.likes);
  const dislike = shuffle(devPool.filter((x) => p.reject(x.ref!, idx.get(x.k)!)), r).slice(0, p.dislikes);
  const neutralPool = devPool.filter((x) => p.grade(x.ref!, idx.get(x.k)!) === 0 && !p.reject(x.ref!, idx.get(x.k)!));
  const neutral = shuffle(neutralPool, r).slice(0, p.neutral ?? 0);
  const ratings = [
    ...like.map((x) => rating(p.id, x.k, 8 + Math.floor(r() * 3))),
    ...dislike.map((x) => rating(p.id, x.k, 2 + Math.floor(r() * 3))),
    ...neutral.map((x) => rating(p.id, x.k, 5 + Math.floor(r() * 2))),
    ...(p.extra?.(devPool, r).map(([k, v]) => rating(p.id, k, v)) ?? []),
  ];
  const ratedSet = new Set(ratings.map((x) => x.key));
  // Candidatos: todo el conjunto de evaluación final (con y sin referencia: los sin referencia no se juzgan)
  const candidates = all.filter((k) => split(k) === PHASE && !ratedSet.has(k));
  const grades = new Map<TitleKey, number>();
  let negatives = 0;
  for (const k of candidates) { const ref = refOf(k); if (!ref) continue; const g = p.grade(ref, idx.get(k)!); if (g > 0) grades.set(k, g); if (p.reject(ref, idx.get(k)!)) negatives++; }
  return { p, ratings, candidates, grade: (k) => grades.get(k) ?? 0, judged: { positives: grades.size, negatives }, usable: grades.size >= 20 };
}

// ───────── ejecución ─────────
const SEEDS = QUICK ? [1] : [1, 2, 3];
if (process.argv[1]?.endsWith('recs.ts')) {
  const oi = process.argv.indexOf('--only');
  const ALG = (oi > 0 ? process.argv[oi + 1].split(',') : Object.keys(ALGOS)) as AlgoId[];
  /** --ref: algoritmo contra el que se comparan los demás (predeterminado: D-motor, el publicado en 3.3.0) */
  const REF = (process.argv.indexOf('--ref') > 0 ? process.argv[process.argv.indexOf('--ref') + 1] : 'D-motor') as AlgoId;
  const OUT = process.argv.indexOf('--out') > 0 ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
  const titles = new Map<TitleKey, TitleMeta>(idx.titles.map((t) => [t.key as TitleKey, metaOf(t.key as TitleKey)]));
  const profiles = QUICK ? PROFILES.slice(0, 2) : PROFILES;
  const runs: any[] = [];
  const lists: Record<string, Record<string, { key: TitleKey; title: string; grade: number; rejected: boolean }[]>> = {};
  for (const p of profiles) for (const seed of SEEDS) {
    const b = build(p, seed);
    const run: any = { profile: p.id, seed, ratings: b.ratings.length, liked: b.ratings.filter((x) => x.overall! >= 8).length, disliked: b.ratings.filter((x) => x.overall! <= 4).length, candidates: b.candidates.length, judged: b.judged, usable: b.usable, algos: {} };
    const allGrades = b.candidates.map(b.grade).filter((g) => g > 0);
    const isRej = (k: TitleKey) => { const ref = refOf(k); return ref ? p.reject(ref, idx.get(k)!) : false; };
    for (const a of ALG) {
      const t0 = performance.now();
      const list = ALGOS[a]({ ratings: b.ratings, titles, candidates: b.candidates, k: 10 });
      const ms = performance.now() - t0;
      if (seed === 1) (lists[p.id] ??= {})[a] = list.map((k) => ({ key: k, title: idx.get(k)!.title, grade: b.grade(k), rejected: isRej(k) }));
      const r = rng(99 + seed);
      const stab: number[] = [];
      for (let s = 0; s < (QUICK ? 1 : 2); s++) {
        const drop = Math.floor(r() * b.ratings.length);
        const l2 = ALGOS[a]({ ratings: b.ratings.filter((_, i) => i !== drop), titles, candidates: b.candidates, k: 10 });
        stab.push(jacc(new Set(list), new Set(l2)));
      }
      run.algos[a] = { ...(b.usable ? relevanceMetrics(list, b.grade, allGrades) : { p5: null, p10: null, ndcg10: null }), rejectedIn10: list.filter(isRej).length, judgedIn10: list.filter((k) => refOf(k)).length, ...listMetrics(list), stability: stab.reduce((x, y) => x + y, 0) / stab.length, ms: Math.round(ms), top: list };
      console.log(p.id, seed, a, JSON.stringify({ ...run.algos[a], top: undefined }));
    }
    runs.push(run);
  }
  const testSize = idx.titles.filter((t) => split(t.key) === PHASE).length;
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const METRICS = ['p5', 'p10', 'ndcg10', 'rejectedIn10', 'genreDiversity', 'semanticDiversity', 'sameCollectionPairs', 'novelty', 'medianVotes', 'stability', 'ms'];
  const byProfile = profiles.map((p) => {
    const rs = runs.filter((r) => r.profile === p.id);
    return { profile: p.id, name: p.name, description: p.description, ratings: rs[0].ratings, liked: rs[0].liked, disliked: rs[0].disliked, candidates: rs[0].candidates, judged: rs[0].judged, usable: rs.every((r) => r.usable),
      algos: Object.fromEntries(ALG.map((a) => [a, Object.fromEntries(METRICS.map((m) => [m, avg(rs.map((r) => r.algos[a][m]))]))])) };
  });
  // Bootstrap pareado (corridas perfil×semilla) de la diferencia de NDCG@10 entre el motor y cada alternativa
  const usableRuns = runs.filter((r) => r.usable);
  const boot = (a: AlgoId, m = 'ndcg10') => {
    const d = usableRuns.map((r) => r.algos[REF][m] - r.algos[a][m]);
    const r = rng(2026); const means: number[] = [];
    for (let i = 0; i < 2000; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(r() * d.length)]; means.push(s / d.length); }
    means.sort((x, y) => x - y);
    return { meanDiff: avg(d), ci95: [means[50], means[1949]], motorBetter: d.filter((x) => x > 0.001).length, motorWorse: d.filter((x) => x < -0.001).length, ties: d.filter((x) => Math.abs(x) <= 0.001).length, n: d.length };
  };
  const aggregate = Object.fromEntries(ALG.map((a) => [a, { ...Object.fromEntries(METRICS.map((m) => [m, avg(usableRuns.map((r) => r.algos[a][m]))])), coverage: new Set(runs.flatMap((r) => r.algos[a].top)).size / testSize }]));
  const comparison = Object.fromEntries(ALG.filter((a) => a !== REF).map((a) => [a, { ndcg10: boot(a), p10: boot(a, 'p10') }]));
  const out = { version: '3.4.0', comparedAgainst: REF, engine: ALGORITHM_VERSION, catalog: man.version, reference: refRaw.version, split: 'hash FNV-1a de la clave del título: 50 % desarrollo (valoraciones) / 50 % evaluación (candidatos y juicios)', seeds: SEEDS, lowVotes: idx.titles.map((t) => t.votes).sort((a, b) => a - b)[Math.floor(idx.titles.length / 4)], generatedAt: new Date().toISOString().slice(0, 10), byProfile, aggregate, comparison, lists };
  if (!QUICK) writeFileSync(OUT ?? (PHASE === 'test' ? 'docs/eval-v3.4.json' : 'docs/eval-v3.4-dev.json'), JSON.stringify({ phase: PHASE, ...out }, null, 1));
  console.log(JSON.stringify({ aggregate, comparison }, null, 1));
}
