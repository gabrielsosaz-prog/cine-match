/**
 * v3.5 · Evaluación con las valoraciones REALES de una persona (archivo exportado desde la app).
 *
 * Uso: npx tsx scripts/eval/personal.ts <export.json> [--phase dev|final] [--out <archivo>]
 *
 * PRIVACIDAD: el archivo exportado es privado. Este script lo lee de la ruta que se le indica (fuera del repositorio
 * o en `private/`, ignorada por git), no lo copia, no lo envía a ningún servicio y escribe los resultados sólo donde
 * se le indica (por defecto, /tmp). Nada de esto entra al despliegue.
 *
 * Señales, sin mezclarlas:
 *  - nota general (overall)          → lo que se predice y se evalúa;
 *  - vista sin nota                  → interés (eligió verla), NO gusto;
 *  - «no me interesa»                → falta de interés, NO una nota baja;
 *  - sin registro                    → desconocido (nunca negativo).
 *
 * Protocolo para muestras chicas:
 *  1. Grupos por saga o continuación (misma colección de TMDB o ≥ 2 de los 6 primeros del reparto en común), para
 *     que «Volver al futuro 2» no se prediga mirando «Volver al futuro 1».
 *  2. Reserva FINAL fija (semilla fija, estratificada por nota, por grupos): ~12 notas y ~10 descartes que no se usan
 *     en ningún experimento de desarrollo. Se elige una vez y se guarda junto al archivo privado.
 *  3. Desarrollo: validación cruzada por grupos, 5 particiones × 10 repeticiones, sólo con el resto.
 *  4. Final (una vez, con la arquitectura ya elegida): entrenar con todo el desarrollo y predecir la reserva; además,
 *     validación cruzada repetida sobre las 42 con el procedimiento ya fijado (estimación del procedimiento).
 *  Las predicciones fuera de muestra se promedian por título entre repeticiones y la incertidumbre se estima con
 *  bootstrap pareado sobre títulos.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { idx } from './recs';
import { hybridEngine, scoreCandidates } from '../../src/engine/recommender';
import { featuresOf, fitGP, predictGP, fitPairs, pairScore, fitInterest, interestLogit, explicitVec, fitRidge, fitLogistic, computeProjection, setSemanticProjection, setSemanticScale, type ItemFeatures } from '../../src/engine/personal';
import type { Rating, TitleKey, TitleMeta } from '../../src/types';
import { personalScores, type PersonalScore } from '../../src/engine/personalEngine';
import { metaOf } from './recs';

const args = process.argv.slice(2);
const FILE = args.find((a) => a.endsWith('.json') && !a.startsWith('--'));
if (!FILE || !existsSync(FILE)) { console.error('Indicá la ruta del archivo exportado.'); process.exit(1); }
const repo = resolve('.');
if (resolve(FILE).startsWith(repo) && !resolve(FILE).startsWith(resolve('private'))) { console.error('El archivo privado debe estar fuera del repositorio o en private/.'); process.exit(1); }
const PHASE = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'dev';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : `/tmp/cine-match-personal-${PHASE}.json`;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : undefined;

const SEMK = args.includes('--sem') ? Number(args[args.indexOf('--sem') + 1]) : 0;
if (SEMK) {
  const vs = idx.titles.filter((t) => t.row >= 0).map((t) => { const v = idx.rowVec(t.row); let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); });
  setSemanticProjection(computeProjection(vs, SEMK));
  if (args.includes('--semscale')) setSemanticScale(Number(args[args.indexOf('--semscale') + 1]));
}
const ex = JSON.parse(readFileSync(FILE, 'utf8'));
const metas = new Map<TitleKey, TitleMeta>(ex.titles.map((t: TitleMeta) => [t.key, t]));
const ratingsAll: Rating[] = ex.ratings;
const rated = ratingsAll.filter((r) => r.overall !== undefined && r.overall !== null && !r.notInterested);
const discards = ratingsAll.filter((r) => r.notInterested);
const watchedOnly = ratingsAll.filter((r) => r.watched && (r.overall === undefined || r.overall === null) && !r.notInterested);
const history = new Set(ratingsAll.map((r) => r.key));

// ───────── grupos (sagas, continuaciones, spin-offs) ─────────
const keys = [...new Set(ratingsAll.map((r) => r.key))];
const parent = new Map(keys.map((k) => [k, k]));
const find = (k: TitleKey): TitleKey => { let p = parent.get(k)!; while (p !== parent.get(p)) p = parent.get(p)!; parent.set(k, p); return p; };
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const a = metas.get(keys[i]), b = metas.get(keys[j]);
  if (!a || !b) continue;
  const coll = a.collection && a.collection.id === b.collection?.id;
  const ca = new Set(a.cast.slice(0, 6).map((p) => p.id));
  const shared = b.cast.slice(0, 6).filter((p) => ca.has(p.id)).length;
  const crew = new Set([...a.directors, ...a.writers].map((p) => p.id));
  const sharedCrew = [...b.directors, ...b.writers].some((p) => crew.has(p.id));
  if (coll || shared >= 2 || (sharedCrew && shared >= 1)) parent.set(find(keys[i]), find(keys[j]));
}
const groupOf = (k: TitleKey) => find(k);

// ───────── reserva final (fija) ─────────
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = <T>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const RES = `${FILE}.reserva.json`;
let reserve: { rated: TitleKey[]; discards: TitleKey[]; createdAt: string };
if (existsSync(RES)) reserve = JSON.parse(readFileSync(RES, 'utf8'));
else {
  const r = rng(35);
  // estratificar por nota: de cada nivel de nota se toma ~30 %, por grupos completos
  const byGroup = new Map<TitleKey, Rating[]>();
  for (const x of rated) byGroup.set(groupOf(x.key), [...(byGroup.get(groupOf(x.key)) ?? []), x]);
  const groups = shuffle([...byGroup.values()], r).sort((a, b) => a[0].overall! - b[0].overall!);
  const pick: TitleKey[] = [];
  // recorre por nota y toma 1 de cada ~3,5 grupos
  groups.forEach((g, i) => { if (i % 7 === 2 || i % 7 === 5) pick.push(...g.map((x) => x.key)); });
  const dg = shuffle(discards.map((d) => d.key), r).slice(0, 10);
  reserve = { rated: pick, discards: dg, createdAt: new Date().toISOString() };
  writeFileSync(RES, JSON.stringify(reserve, null, 1));
}
const reserved = new Set([...reserve.rated, ...reserve.discards]);

// ───────── rasgos ─────────
const metaFor = (k: TitleKey): TitleMeta => metas.get(k) ?? metaOf(k);
const feat = new Map<TitleKey, ItemFeatures>();
const F = (k: TitleKey) => { let f = feat.get(k); if (!f) { f = featuresOf(metaFor(k), idx); feat.set(k, f); } return f; };
const catalogKeys = idx.titles.map((t) => t.key as TitleKey).filter((k) => !history.has(k));
const allTitles = new Map<TitleKey, TitleMeta>([...metas, ...catalogKeys.map((k) => [k, metaOf(k)] as [TitleKey, TitleMeta])]);

// ───────── modelos ─────────
interface Train { rated: Rating[]; watched: Rating[]; discards: Rating[] }
type Scorer = (k: TitleKey) => number;
interface Model { id: string; fit: (t: Train) => { rating: Scorer; rank: Scorer } }
const meanR = (rs: Rating[]) => rs.reduce((a, r) => a + r.overall!, 0) / Math.max(1, rs.length);
const MODELS: Model[] = [
  { id: 'media', fit: (t) => { const m = meanR(t.rated); const s = (k: TitleKey) => m + 1e-3 * F(k).quality; return { rating: s, rank: s }; } },
  { id: 'calidad-publica', fit: (t) => { const m = meanR(t.rated); const s = (k: TitleKey) => m + 0.5 * (F(k).quality - 6.8); return { rating: s, rank: s }; } },
  { id: 'generos', fit: (t) => {
    const m = meanR(t.rated); const aff = new Map<number, { s: number; n: number }>();
    for (const r of t.rated) for (const g of F(r.key).genres) { const a = aff.get(g) ?? { s: 0, n: 0 }; a.s += r.overall! - m; a.n++; aff.set(g, a); }
    const s = (k: TitleKey) => { const gs = F(k).genres; return m + (gs.length ? gs.reduce((x, g) => { const a = aff.get(g); return x + (a ? a.s / (a.n + 2) : 0); }, 0) / gs.length : 0) + 1e-3 * F(k).quality; };
    return { rating: s, rank: s };
  } },
  { id: 'v3.4', fit: (t) => {
    const rs = [...t.rated, ...t.watched, ...t.discards];
    const profile = hybridEngine.buildProfile(rs, allTitles);
    const cache = new Map<TitleKey, { pred: number; raw: number }>();
    const get = (k: TitleKey) => { let c = cache.get(k); if (!c) { const s = scoreCandidates({ profile, ratings: rs, titles: allTitles, candidates: [k], narrative: idx })[0]; c = { pred: s.pred, raw: s.predRaw }; cache.set(k, c); } return c; };
    return { rating: (k) => get(k).pred, rank: (k) => get(k).raw, batch: (ks: TitleKey[]) => { for (const s of scoreCandidates({ profile, ratings: rs, titles: allTitles, candidates: ks.filter((k) => !cache.has(k)), narrative: idx })) cache.set(s.key, { pred: s.pred, raw: s.predRaw }); } } as any;
  } },
  { id: 'knn-semantico', fit: (t) => {
    const m = meanR(t.rated);
    const s = (k: TitleKey) => {
      const f = F(k);
      const sims = t.rated.map((r) => { const g = F(r.key); let c = 0; if (f.emb && g.emb) { let d = 0; for (let i = 0; i < f.emb.length; i++) d += f.emb[i] * g.emb[i]; c = d; } return { c, dev: r.overall! - m }; }).sort((a, b) => b.c - a.c).slice(0, 5);
      let num = 0, den = 0.3; for (const x of sims) { const w = Math.max(0, x.c) ** 3; num += w * x.dev; den += w; }
      return m + num / den;
    };
    return { rating: s, rank: s };
  } },
  { id: 'gp', fit: (t) => { const g = fitGP(t.rated.map((r) => F(r.key)), t.rated.map((r) => r.overall!)); const s = (k: TitleKey) => predictGP(g, F(k)).mean; return { rating: s, rank: s, gp: g } as any; } },
  { id: 'gp-sin-busqueda', fit: (t) => { const g = fitGP(t.rated.map((r) => F(r.key)), t.rated.map((r) => r.overall!), { search: false }); const s = (k: TitleKey) => predictGP(g, F(k)).mean; return { rating: s, rank: s }; } },
  { id: 'gp-sin-semantica', fit: (t) => { const g = fitGP(t.rated.map((r) => F(r.key)), t.rated.map((r) => r.overall!), { fixed: { sEmb: 1e-6 } }); const s = (k: TitleKey) => predictGP(g, F(k)).mean; return { rating: s, rank: s }; } },
  { id: 'pares', fit: (t) => {
    const fs = t.rated.map((r) => F(r.key)), y = t.rated.map((r) => r.overall!);
    const g = fitGP(fs, y); const p = fitPairs(fs, y, g.h);
    const sc = (k: TitleKey) => pairScore(p, F(k));
    return { rating: (k) => p.icpt + p.slope * sc(k), rank: sc };
  } },
  { id: 'gp+interes', fit: (t) => {
    const fs = t.rated.map((r) => F(r.key)), y = t.rated.map((r) => r.overall!);
    const g = fitGP(fs, y);
    const im = fitInterest([...t.rated, ...t.watched].map((r) => F(r.key)), t.discards.map((r) => F(r.key)), g.h);
    return { rating: (k) => predictGP(g, F(k)).mean, rank: (k) => predictGP(g, F(k)).mean + 0.5 * Math.max(-4, Math.min(4, interestLogit(im, F(k)))) };
  } },
  { id: 'interes-solo', fit: (t) => {
    const g = fitGP(t.rated.map((r) => F(r.key)), t.rated.map((r) => r.overall!));
    const im = fitInterest([...t.rated, ...t.watched].map((r) => F(r.key)), t.discards.map((r) => F(r.key)), g.h);
    const s = (k: TitleKey) => interestLogit(im, F(k));
    return { rating: (k) => meanR(t.rated), rank: s };
  } },
  { id: 'lin-nota', fit: (t) => { const r = fitRidge(t.rated.map((x) => explicitVec(F(x.key))), t.rated.map((x) => x.overall!), 8); const s = (k: TitleKey) => r.predict(explicitVec(F(k))); return { rating: s, rank: s }; } },
  ...[0.3, 0.6, 1].map((gamma) => ({ id: `calidad+lin-interes-${gamma}`, fit: (t: Train) => {
    const m = meanR(t.rated);
    const li = fitLogistic([...t.rated, ...t.watched, ...t.discards].map((x) => explicitVec(F(x.key))), [...t.rated.map(() => 1), ...t.watched.map(() => 1), ...t.discards.map(() => 0)], 3);
    const q = (k: TitleKey) => m + 0.5 * (F(k).quality - 6.8);
    return { rating: q, rank: (k: TitleKey) => q(k) + gamma * Math.max(-5, Math.min(5, li.predict(explicitVec(F(k))))) };
  } })),
  ...[0.3, 0.6, 1].map((gamma) => ({ id: `gp+lin-interes-${gamma}`, fit: (t: Train) => {
    const g = fitGP(t.rated.map((r) => F(r.key)), t.rated.map((r) => r.overall!));
    const li = fitLogistic([...t.rated, ...t.watched, ...t.discards].map((x) => explicitVec(F(x.key))), [...t.rated.map(() => 1), ...t.watched.map(() => 1), ...t.discards.map(() => 0)], 3);
    const mu = (k: TitleKey) => predictGP(g, F(k)).mean;
    return { rating: mu, rank: (k: TitleKey) => mu(k) + gamma * Math.max(-5, Math.min(5, li.predict(explicitVec(F(k))))) };
  } })),
  ...[0.15, 0.3, 0.6].map((gamma) => ({ id: `lin-nota+lin-interes-${gamma}`, fit: (t: Train) => {
    const r = fitRidge(t.rated.map((x) => explicitVec(F(x.key))), t.rated.map((x) => x.overall!), 8);
    const li = fitLogistic([...t.rated, ...t.watched, ...t.discards].map((x) => explicitVec(F(x.key))), [...t.rated.map(() => 1), ...t.watched.map(() => 1), ...t.discards.map(() => 0)], 3);
    const mu = (k: TitleKey) => r.predict(explicitVec(F(k)));
    return { rating: mu, rank: (k: TitleKey) => mu(k) + gamma * Math.max(-5, Math.min(5, li.predict(explicitVec(F(k))))) };
  } })),
  ...[3, 20].map((lam) => ({ id: `lin-nota-l${lam}`, fit: (t: Train) => { const r = fitRidge(t.rated.map((x) => explicitVec(F(x.key))), t.rated.map((x) => x.overall!), lam); const s = (k: TitleKey) => r.predict(explicitVec(F(k))); return { rating: s, rank: s }; } })),
  ...([['ens-v34+lin', 0, 0], ['ens-v34+lin+int', 0.5, 0], ['ens-v34+lin+gp', 0, 1], ['ens-lin+gp', 0, 1, true], ['ens-v34+lin+gp+int', 0.5, 1]] as [string, number, number, boolean?][]).map(([id, wi, wg, noV]) => ({ id, fit: (t: Train) => {
    const v = (MODELS.find((m) => m.id === 'v3.4')!.fit(t) as any);
    const r = fitRidge(t.rated.map((x) => explicitVec(F(x.key))), t.rated.map((x) => x.overall!), 8);
    const li = fitLogistic([...t.rated, ...t.watched, ...t.discards].map((x) => explicitVec(F(x.key))), [...t.rated.map(() => 1), ...t.watched.map(() => 1), ...t.discards.map(() => 0)], 3);
    const g = wg ? fitGP(t.rated.map((x) => F(x.key)), t.rated.map((x) => x.overall!)) : undefined;
    // escalas medidas sobre lo valorado en entrenamiento (sin mirar lo oculto)
    const tk = t.rated.map((x) => x.key);
    v.batch(tk);
    const zs = (f: (k: TitleKey) => number) => { const xs = tk.map(f); const m = avg(xs); const sd = Math.sqrt(avg(xs.map((x) => (x - m) ** 2))) || 1; return (k: TitleKey) => (f(k) - m) / sd; };
    const zv = zs((k) => v.rank(k)), zl = zs((k) => r.predict(explicitVec(F(k)))), zg = g ? zs((k) => predictGP(g, F(k)).mean) : () => 0;
    const lg = (k: TitleKey) => Math.max(-5, Math.min(5, li.predict(explicitVec(F(k)))));
    const m = meanR(t.rated);
    const score = (k: TitleKey) => (noV ? 0 : zv(k)) + zl(k) + wg * zg(k) + wi * lg(k);
    return { rating: (k: TitleKey) => r.predict(explicitVec(F(k))), rank: score, batch: (ks: TitleKey[]) => v.batch(ks) };
  } })),
  { id: 'motor-3.5', fit: (t) => {
    const rs = [...t.rated, ...t.watched, ...t.discards];
    const profile = hybridEngine.buildProfile(rs, allTitles);
    const cache = new Map<TitleKey, PersonalScore>();
    const batch = (ks: TitleKey[]) => { const miss = ks.filter((k) => !cache.has(k)); if (miss.length) for (const [k, v] of personalScores({ profile, ratings: rs, titles: allTitles, candidates: miss, narrative: idx }, miss)) cache.set(k, v); };
    return { rating: (k: TitleKey) => { batch([k]); return cache.get(k)!.linRating ?? cache.get(k)!.v34; }, rank: (k: TitleKey) => { batch([k]); return cache.get(k)!.order; }, batch } as any;
  } },
  { id: 'lin-interes-solo', fit: (t) => {
    const li = fitLogistic([...t.rated, ...t.watched, ...t.discards].map((x) => explicitVec(F(x.key))), [...t.rated.map(() => 1), ...t.watched.map(() => 1), ...t.discards.map(() => 0)], 3);
    return { rating: () => meanR(t.rated), rank: (k) => li.predict(explicitVec(F(k))) };
  } },
];

// ───────── métricas ─────────
const gain = (r: number) => Math.max(0, r - 6); // 10→4, 9→3, 8→2, 7→1, ≤6→0
const ndcgAt = (order: TitleKey[], truth: Map<TitleKey, number>, k = 10) => {
  const dcg = (gs: number[]) => gs.slice(0, k).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...truth.values()].map(gain).sort((a, b) => b - a));
  return ideal ? dcg(order.map((x) => gain(truth.get(x)!))) / ideal : 0;
};
function metrics(pred: Map<TitleKey, { rating: number; rank: number }>, truth: Map<TitleKey, number>, discardsKeys: TitleKey[], dscore: Map<TitleKey, number>) {
  const ks = [...truth.keys()];
  const order = [...ks].sort((a, b) => pred.get(b)!.rank - pred.get(a)!.rank);
  let mae = 0, se = 0; for (const k of ks) { const e = pred.get(k)!.rating - truth.get(k)!; mae += Math.abs(e); se += e * e; }
  let conc = 0, pairs = 0;
  for (let i = 0; i < ks.length; i++) for (let j = 0; j < ks.length; j++) {
    const ti = truth.get(ks[i])!, tj = truth.get(ks[j])!;
    if (ti <= tj) continue; pairs++;
    const d = pred.get(ks[i])!.rank - pred.get(ks[j])!.rank; conc += d > 0 ? 1 : d === 0 ? 0.5 : 0;
  }
  const liked = ks.filter((k) => truth.get(k)! >= 8);
  let auc = 0, an = 0;
  for (const l of liked) for (const d of discardsKeys) { an++; const x = pred.get(l)!.rank - dscore.get(d)!; auc += x > 0 ? 1 : x === 0 ? 0.5 : 0; }
  let aucAll = 0, aan = 0;
  for (const l of ks) for (const d of discardsKeys) { aan++; const x = pred.get(l)!.rank - dscore.get(d)!; aucAll += x > 0 ? 1 : x === 0 ? 0.5 : 0; }
  // ranking de todo lo oculto con lo que la persona interactuó: notas (ganancia por nota) + descartes (ganancia 0).
  // Un descarte no es una nota baja, pero tampoco es algo para recomendarle: para un recomendador es «no relevante».
  const mix = [...ks.map((k) => ({ k, s: pred.get(k)!.rank })), ...discardsKeys.map((k) => ({ k, s: dscore.get(k)! }))].sort((a, b) => b.s - a.s).map((x) => x.k);
  const ndcgMix = ndcgAt(mix.filter((k) => truth.has(k) || discardsKeys.includes(k)).map((k) => k), new Map([...truth, ...discardsKeys.map((k) => [k, 0] as [TitleKey, number])]));
  const p10mix = mix.slice(0, 10).filter((k) => (truth.get(k) ?? 0) >= 8).length / 10;
  const p10 = order.slice(0, 10).filter((k) => truth.get(k)! >= 8).length / 10;
  return { n: ks.length, ndcgMix, p10mix, mae: mae / ks.length, rmse: Math.sqrt(se / ks.length), pairwise: conc / Math.max(1, pairs), ndcg10: ndcgAt(order, truth), p10, aucLikedVsDiscard: an ? auc / an : null, aucRatedVsDiscard: aan ? aucAll / aan : null };
}

// ───────── validación cruzada por grupos ─────────
function folds<T extends { key: TitleKey }>(items: T[], K: number, seed: number): T[][] {
  const r = rng(seed);
  const gs = new Map<TitleKey, T[]>();
  for (const it of items) gs.set(groupOf(it.key), [...(gs.get(groupOf(it.key)) ?? []), it]);
  const out: T[][] = Array.from({ length: K }, () => []);
  // grupos ordenados por nota media con desempate aleatorio → reparto estratificado
  const ordered = shuffle([...gs.values()], r).sort((a, b) => ((a[0] as any).overall ?? 0) - ((b[0] as any).overall ?? 0));
  let i = Math.floor(r() * K);
  for (const g of ordered) { out[i % K].push(...g); i++; }
  return out;
}
interface Pooled { rating: number[]; rank: number[] }
function runCV(pool: { rated: Rating[]; watched: Rating[]; discards: Rating[] }, models: Model[], reps: number, K: number, catalog: boolean) {
  const out: Record<string, { pred: Map<TitleKey, Pooled>; dpred: Map<TitleKey, number[]>; ranks: number[]; perRep: any[]; ms: number[] }> = {};
  for (const m of models) out[m.id] = { pred: new Map(), dpred: new Map(), ranks: [], perRep: [], ms: [], within: { pc: 0, pn: 0, ac: 0, an: 0, mc: 0, mn: 0 } } as any;
  const everything = [...pool.rated.map((r) => ({ ...r, _t: 'r' })), ...pool.watched.map((r) => ({ ...r, _t: 'w' })), ...pool.discards.map((r) => ({ ...r, _t: 'd' }))];
  for (let rep = 0; rep < reps; rep++) {
    const fs = folds(everything, K, 1000 + rep);
    for (const m of models) {
      const repPred = new Map<TitleKey, { rating: number; rank: number }>(), repD = new Map<TitleKey, number>();
      for (let f = 0; f < K; f++) {
        const test = new Set(fs[f].map((x) => x.key));
        const tr: Train = { rated: pool.rated.filter((r) => !test.has(r.key)), watched: pool.watched.filter((r) => !test.has(r.key)), discards: pool.discards.filter((r) => !test.has(r.key)) };
        const t0 = performance.now();
        const fit = m.fit(tr) as any;
        const heldR = pool.rated.filter((r) => test.has(r.key)), heldD = pool.discards.filter((r) => test.has(r.key));
        if (fit.batch) fit.batch([...heldR, ...heldD].map((r) => r.key));
        for (const r of heldR) repPred.set(r.key, { rating: fit.rating(r.key), rank: fit.rank(r.key) });
        for (const d of heldD) repD.set(d.key, fit.rank(d.key));
        // métricas dentro de la partición: no dependen de que los puntajes de modelos distintos sean comparables
        const W = (out[m.id] as any).within;
        for (const a of heldR) for (const b of heldR) if (a.overall! > b.overall!) { W.pn++; const d = fit.rank(a.key) - fit.rank(b.key); W.pc += d > 0 ? 1 : d === 0 ? 0.5 : 0; }
        for (const a of heldR.filter((x) => x.overall! >= 8)) for (const d of heldD) { W.an++; const x = fit.rank(a.key) - fit.rank(d.key); W.ac += x > 0 ? 1 : x === 0 ? 0.5 : 0; }
        // nota ≥ 7 frente a nota ≤ 6 o descarte: ¿lo que le gustó queda arriba de lo que no le interesa o le gustó menos?
        const lo = [...heldR.filter((x) => x.overall! <= 6).map((x) => x.key), ...heldD.map((x) => x.key)];
        for (const a of heldR.filter((x) => x.overall! >= 7)) for (const b of lo) { W.mn++; const x = fit.rank(a.key) - fit.rank(b); W.mc += x > 0 ? 1 : x === 0 ? 0.5 : 0; }
        out[m.id].ms.push(performance.now() - t0);
        // recuperación: puesto de cada título muy valorado oculto frente a todo el catálogo no visto (desconocido ≠ negativo)
        if (catalog && rep < 2) {
          const liked = heldR.filter((r) => r.overall! >= 8);
          if (liked.length) {
            if (fit.batch) fit.batch(catalogKeys);
            const cs = catalogKeys.map((k) => fit.rank(k)).sort((a, b) => b - a);
            for (const l of liked) { const s = fit.rank(l.key); let lo = 0, hi = cs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cs[mid] > s) lo = mid + 1; else hi = mid; } out[m.id].ranks.push(lo + 1); }
          }
        }
      }
      for (const [k, v] of repPred) { const p = out[m.id].pred.get(k) ?? { rating: [], rank: [] }; p.rating.push(v.rating); p.rank.push(v.rank); out[m.id].pred.set(k, p); }
      for (const [k, v] of repD) out[m.id].dpred.set(k, [...(out[m.id].dpred.get(k) ?? []), v]);
      out[m.id].perRep.push(metrics(repPred, new Map(pool.rated.map((r) => [r.key, r.overall!])), pool.discards.map((d) => d.key), repD));
    }
    process.stderr.write(`rep ${rep + 1}/${reps}\n`);
  }
  return out;
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
function summarize(res: ReturnType<typeof runCV>, pool: { rated: Rating[]; discards: Rating[] }, ref = 'v3.4') {
  const truth = new Map(pool.rated.map((r) => [r.key, r.overall!]));
  const mean = (id: string) => new Map([...res[id].pred].map(([k, v]) => [k, { rating: avg(v.rating), rank: avg(v.rank) }]));
  const dmean = (id: string) => new Map([...res[id].dpred].map(([k, v]) => [k, avg(v)]));
  const summary: any = {};
  for (const id of Object.keys(res)) {
    const rs = res[id].ranks;
    const pr = res[id].perRep;
    summary[id] = {
      pooled: metrics(mean(id), truth, pool.discards.map((d) => d.key), dmean(id)),
      perRepMean: Object.fromEntries(['ndcgMix', 'p10mix', 'mae', 'pairwise', 'ndcg10', 'p10', 'aucLikedVsDiscard', 'aucRatedVsDiscard'].map((m) => [m, avg(pr.map((x: any) => x[m] ?? 0))])),
      perRepRange: Object.fromEntries(['ndcgMix', 'ndcg10', 'pairwise'].map((m) => { const v = pr.map((x: any) => x[m]).sort((a: number, b: number) => a - b); return [m, [v[0], v[v.length - 1]]]; })),
      retrieval: rs.length ? { n: rs.length, medianRank: [...rs].sort((a, b) => a - b)[Math.floor(rs.length / 2)], recall100: rs.filter((x) => x <= 100).length / rs.length, recall500: rs.filter((x) => x <= 500).length / rs.length, catalog: catalogKeys.length } : null,
      msPerFit: avg(res[id].ms),
      within: (() => { const W = (res[id] as any).within; return { pairwise: W.pc / W.pn, aucLikedVsDiscard: W.ac / W.an, aucGoodVsRest: W.mc / W.mn, pairs: W.pn }; })(),
      ...(args.includes('--diag') ? { mixTop: [...[...mean(id)].map(([k, v]) => ({ k, s: v.rank, t: String(truth.get(k)) })), ...[...dmean(id)].map(([k, v]) => ({ k, s: v, t: 'D' }))].sort((a, b) => b.s - a.s).slice(0, 14).map((x) => `${x.t}:${metas.get(x.k)?.title}`) } : {}),
    };
  }
  // bootstrap pareado sobre títulos de la diferencia contra la referencia
  const r = rng(7);
  const ks = [...truth.keys()], ds = pool.discards.map((d) => d.key);
  for (const id of Object.keys(res)) {
    if (id === ref) continue;
    const A = mean(id), B = mean(ref), dA = dmean(id), dB = dmean(ref);
    const diffs: Record<string, number[]> = { ndcgMix: [], ndcg10: [], pairwise: [], mae: [], aucLikedVsDiscard: [] };
    for (let b = 0; b < 2000; b++) {
      const s = ks.map(() => ks[Math.floor(r() * ks.length)]);
      const sd = ds.map(() => ds[Math.floor(r() * ds.length)]);
      // claves repetidas: se renombran para que cuenten varias veces
      const tA = new Map<TitleKey, number>(), pA = new Map(), pB = new Map(), dAA = new Map(), dBB = new Map();
      s.forEach((k, i) => { const kk = `${k}#${i}` as TitleKey; tA.set(kk, truth.get(k)!); pA.set(kk, A.get(k)); pB.set(kk, B.get(k)); });
      sd.forEach((k, i) => { const kk = `${k}#${i}` as TitleKey; dAA.set(kk, dA.get(k)); dBB.set(kk, dB.get(k)); });
      const mA = metrics(pA, tA, [...dAA.keys()], dAA), mB = metrics(pB, tA, [...dBB.keys()], dBB);
      for (const m of Object.keys(diffs)) diffs[m].push((mA as any)[m] - (mB as any)[m]);
    }
    summary[id].vsRef = Object.fromEntries(Object.entries(diffs).map(([m, v]) => { v.sort((a, b) => a - b); return [m, { mean: avg(v), ci95: [v[50], v[1949]] }]; }));
  }
  return summary;
}

// ───────── ejecución ─────────
const models = ONLY ? MODELS.filter((m) => ONLY.includes(m.id) || m.id === 'v3.4') : MODELS;
const info = { rated: rated.length, watchedOnly: watchedOnly.length, discards: discards.length, groups: new Set(rated.map((r) => groupOf(r.key))).size, reserved: { rated: reserve.rated.length, discards: reserve.discards.length }, multiGroups: [...new Set(rated.map((r) => groupOf(r.key)))].map((g) => rated.filter((r) => groupOf(r.key) === g).length).filter((n) => n > 1) };
let result: any;
if (PHASE === 'dev') {
  const pool = { rated: rated.filter((r) => !reserved.has(r.key)), watched: watchedOnly, discards: discards.filter((r) => !reserved.has(r.key)) };
  const res = runCV(pool, models, 10, 5, true);
  result = { phase: 'dev', info, summary: summarize(res, pool) };
} else {
  // 1) entrenar con desarrollo, predecir la reserva
  const tr: Train = { rated: rated.filter((r) => !reserved.has(r.key)), watched: watchedOnly, discards: discards.filter((r) => !reserved.has(r.key)) };
  const heldR = rated.filter((r) => reserved.has(r.key)), heldD = discards.filter((r) => reserved.has(r.key));
  const holdout: any = {};
  for (const m of models) {
    const fit = m.fit(tr) as any;
    if (fit.batch) fit.batch([...heldR, ...heldD].map((r) => r.key));
    holdout[m.id] = metrics(new Map(heldR.map((r) => [r.key, { rating: fit.rating(r.key), rank: fit.rank(r.key) }])), new Map(heldR.map((r) => [r.key, r.overall!])), heldD.map((d) => d.key), new Map(heldD.map((d) => [d.key, fit.rank(d.key)])));
  }
  // 2) procedimiento fijo, validación cruzada repetida sobre las 42
  const pool = { rated, watched: watchedOnly, discards };
  const res = runCV(pool, models, 10, 5, true);
  result = { phase: 'final', info, holdout, cvAll: summarize(res, pool) };
}
writeFileSync(OUT, JSON.stringify(result, null, 1));
if (args.includes('--diag')) for (const [id, s] of Object.entries<any>(result.summary ?? result.cvAll)) console.log(id, '→', s.mixTop?.join(' | '));
const S = result.summary ?? result.cvAll;
console.log(JSON.stringify(info));
if (result.holdout) for (const [id, m] of Object.entries<any>(result.holdout)) console.log('reserva', id.padEnd(24), `MIX ${m.ndcgMix.toFixed(3)} ndcg ${m.ndcg10.toFixed(3)} pares ${m.pairwise.toFixed(3)} mae ${m.mae.toFixed(2)} aucD ${m.aucLikedVsDiscard?.toFixed(2)}`);
for (const [id, s] of Object.entries<any>(S)) console.log(id.padEnd(24), `DENTRO pares ${s.within.pairwise.toFixed(3)} aucD ${s.within.aucLikedVsDiscard.toFixed(3)} bueno>resto ${s.within.aucGoodVsRest.toFixed(3)} || MIX ${s.pooled.ndcgMix.toFixed(3)} p10mix ${s.pooled.p10mix.toFixed(2)} | ndcg ${s.pooled.ndcg10.toFixed(3)} (rep ${s.perRepMean.ndcg10.toFixed(3)}) p10 ${s.pooled.p10.toFixed(2)} pares ${s.pooled.pairwise.toFixed(3)} mae ${s.pooled.mae.toFixed(2)} rmse ${s.pooled.rmse.toFixed(2)} aucGustaVsDesc ${s.pooled.aucLikedVsDiscard?.toFixed(2)} aucNotaVsDesc ${s.pooled.aucRatedVsDiscard?.toFixed(2)} recup ${s.retrieval ? `med ${s.retrieval.medianRank} r@100 ${s.retrieval.recall100.toFixed(2)} r@500 ${s.retrieval.recall500.toFixed(2)}` : '-'} ms ${s.msPerFit.toFixed(0)}`, s.vsRef ? `ΔMIX ${s.vsRef.ndcgMix.mean.toFixed(3)} [${s.vsRef.ndcgMix.ci95.map((x: number) => x.toFixed(3)).join(', ')}] Δndcg ${s.vsRef.ndcg10.mean.toFixed(3)} [${s.vsRef.ndcg10.ci95.map((x: number) => x.toFixed(3)).join(', ')}] Δpares ${s.vsRef.pairwise.mean.toFixed(3)} [${s.vsRef.pairwise.ci95.map((x: number) => x.toFixed(3)).join(', ')}]` : '');
