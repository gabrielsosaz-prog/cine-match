/**
 * Latencia y memoria de los motores con el tamaño que usa la app (≈250 candidatos, 42 notas, 30 descartes,
 * catálogo semántico real). Historial sintético al azar: mide costo, no calidad. Uso: node --expose-gc --import tsx scripts/eval/latency35.ts
 */
import { readFileSync } from 'node:fs';
import { NarrativeIndex, type CatalogMeta } from '../../src/engine/narrative';
import { hybridEngine, setDefaultNarrative } from '../../src/engine/recommender';
import { personalEngine } from '../../src/engine/personalEngine';
import type { Rating, TitleKey, TitleMeta } from '../../src/types';

const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const cm = JSON.parse(readFileSync(`public/catalog/${man.meta}`, 'utf8')) as CatalogMeta;
const buf = readFileSync(`public/catalog/${man.emb}`);
const idx = new NarrativeIndex(cm, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
let seed = 7; const r = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const keys = idx.titles.map((t) => t.key as TitleKey).sort(() => r() - 0.5);
const meta = (key: TitleKey): TitleMeta => { const c = idx.get(key)!; const [type, id] = key.split(':');
  return { key, type: type as 'movie' | 'tv', tmdbId: Number(id), title: c.title, year: c.year, genres: c.genres.map((g) => ({ id: g, name: String(g) })), keywords: c.kw.map((k) => ({ id: k, name: idx.kwName(k) ?? '' })),
    cast: c.cast.map((p, i) => ({ id: p, name: `p${p}`, order: i })), directors: c.people.map((p) => ({ id: p, name: `p${p}` })), writers: c.writers.map((p) => ({ id: p, name: `p${p}` })), runtime: c.runtime, numberOfSeasons: c.seasons,
    originalLanguage: c.lang, originCountry: c.countries, voteAverage: c.vote, voteCount: c.votes, popularity: c.pop, collection: c.collection ? { id: c.collection, name: '' } : undefined, completeness: 'full', missing: [], source: 'catálogo', fetchedAt: 0, metaVersion: 3 }; };
const titles = new Map(keys.slice(0, 400).map((k) => [k, meta(k)]));
const mk = (k: TitleKey, o: Partial<Rating>): Rating => ({ id: `b|${k}`, profileId: 'b', key: k, watched: true, dimensions: {}, createdAt: 0, updatedAt: 0, schema: 3, ...o } as Rating);
const ratings = [...keys.slice(0, 42).map((k) => mk(k, { overall: 3 + Math.round(r() * 7) })), ...keys.slice(42, 65).map((k) => mk(k, {})), ...keys.slice(65, 98).map((k) => mk(k, { watched: false, notInterested: true }))];
const candidates = keys.slice(100, 350);
setDefaultNarrative(idx);
for (const [name, e] of [['v3.4', hybridEngine], ['v3.5', personalEngine]] as const) {
  const profile = e.buildProfile(ratings, titles, {});
  const t: number[] = []; const gc = (globalThis as { gc?: () => void }).gc; gc?.(); let peak = 0; const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 7; i++) { const s = performance.now(); e.rank({ profile, ratings, titles, candidates, limit: 40, seed: 1 }); t.push(performance.now() - s); peak = Math.max(peak, process.memoryUsage().heapUsed - h0); gc?.(); }
  t.sort((a, b) => a - b);
  console.log(name, `mediana ${t[3].toFixed(0)} ms (mín ${t[0].toFixed(0)}, máx ${t[6].toFixed(0)}) · memoria transitoria máx. ${(peak / 1e6).toFixed(1)} MB`);
}
