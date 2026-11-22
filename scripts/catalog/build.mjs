// Construye el catálogo narrativo precalculado de Cine Match (corre en GitHub Actions).
// Fuentes: TMDB (a través de la app publicada: el token queda en el servidor) y Wikipedia en inglés
// (argumento/premisa, CC BY-SA; el texto NO se publica: sólo se usa para calcular vectores y rasgos).
// Salida en data/out/: catalog-meta.json, catalog-emb.bin (int8, N×dim), report.md y el modelo usado.
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.env.APP ?? 'https://cine-match-pied-tau.vercel.app';
const OUT = 'data/out';
const LIMIT = Number(process.env.CATALOG_LIMIT ?? 0); // para pruebas rápidas
const MODEL = 'Xenova/bge-small-en-v1.5';
const UA = 'CineMatchCatalogBuilder/1.0 (https://github.com/gabrielsosaz-prog/cine-match)';
mkdirSync(OUT, { recursive: true });
const FACETS = JSON.parse(readFileSync('src/engine/narrative/facets.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i >= tries) { console.warn('falló', url.slice(0, 120), e.message); return null; }
      await sleep(800 * 2 ** i);
    }
  }
}
const tmdb = (p) => getJson(`${APP}/api/tmdb/${p}`);
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); if (++done % 500 === 0) console.log(`  ${done}/${items.length}`); } }));
  return out;
}

// 1) Selección de títulos
const PROVIDERS = '8|1796|119|9|337|1899|384|531|582';
const keys = new Map(); // key -> {fromPlatforms}
const addPage = async (type, q, tag) => { const r = await tmdb(`discover/${type}?${q}`); for (const x of r?.results ?? []) if (!keys.has(`${type}:${x.id}`)) keys.set(`${type}:${x.id}`, tag); return r?.total_pages ?? 0; };
const pages = async (type, q, max, tag) => { const tp = await addPage(type, `${q}&page=1`, tag); const n = Math.min(max, tp); await pool(Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 2), 6, (p) => addPage(type, `${q}&page=${p}`, tag)); };
console.log('Selección de títulos…');
await pages('movie', `watch_region=AR&with_watch_providers=${PROVIDERS}&sort_by=popularity.desc&vote_count.gte=20&language=en-US`, 150, 'plataformas');
await pages('tv', `watch_region=AR&with_watch_providers=${PROVIDERS}&sort_by=popularity.desc&vote_count.gte=10&language=en-US`, 150, 'plataformas');
await pages('movie', 'sort_by=vote_count.desc&language=en-US', 60, 'global');
await pages('tv', 'sort_by=vote_count.desc&language=en-US', 40, 'global');
const CASES = ['tv:111803', 'tv:325755', 'tv:336240', 'tv:227371', 'tv:253376', 'tv:241372', 'tv:229962', 'tv:131142', 'tv:1413'];
for (const k of CASES) if (!keys.has(k)) keys.set(k, 'caso');
let list = [...keys.keys()];
if (LIMIT) list = [...new Set([...CASES, ...list.slice(0, LIMIT)])];
console.log('Títulos seleccionados:', list.length);

// 2) Fichas TMDB
const toArr = (x) => (Array.isArray(x) ? x : []);
console.log('Fichas TMDB…');
const details = await pool(list, 10, async (key) => {
  const [type, id] = key.split(':');
  const d = await tmdb(`${type}/${id}?language=es-MX&append_to_response=keywords,credits,external_ids,translations,watch/providers`);
  if (!d || !d.id) return null;
  const tr = toArr(d.translations?.translations);
  const en = tr.find((t) => t.iso_639_1 === 'en' && t.iso_3166_1 === 'US') ?? tr.find((t) => t.iso_639_1 === 'en');
  const kws = toArr(d.keywords?.keywords ?? d.keywords?.results);
  const crew = toArr(d.credits?.crew);
  const people = type === 'tv' ? toArr(d.created_by).map((p) => p.id) : crew.filter((c) => c.job === 'Director').map((c) => c.id);
  const writers = crew.filter((c) => c.department === 'Writing').map((c) => c.id);
  const ar = d['watch/providers']?.results?.AR;
  return {
    key, type, id: d.id,
    title: d.title ?? d.name, original: d.original_title ?? d.original_name,
    titleEn: en?.data?.title ?? en?.data?.name ?? d.original_title ?? d.original_name,
    year: Number(String(d.release_date ?? d.first_air_date ?? '').slice(0, 4)) || undefined,
    genres: toArr(d.genres).map((g) => g.id),
    kw: kws.map((k) => [k.id, k.name]),
    countries: [...new Set([...toArr(d.origin_country), ...toArr(d.production_countries).map((c) => c.iso_3166_1)])],
    lang: d.original_language, collection: d.belongs_to_collection?.id,
    people: [...new Set(people)].slice(0, 4), writers: [...new Set(writers)].slice(0, 4), cast: toArr(d.credits?.cast).slice(0, 5).map((c) => c.id),
    runtime: d.runtime ?? toArr(d.episode_run_time)[0], seasons: d.number_of_seasons,
    vote: d.vote_average, votes: d.vote_count, pop: d.popularity, poster: d.poster_path,
    overviewEn: en?.data?.overview || '', taglineEn: en?.data?.tagline || '', overviewEs: d.overview || '',
    wikidata: d.external_ids?.wikidata_id,
    provAR: toArr(ar?.flatrate).map((p) => p.provider_id),
    src: keys.get(key),
  };
});
const titles = details.filter(Boolean);
console.log('Fichas OK:', titles.length);

// 3) Wikipedia: argumento / premisa
console.log('Wikipedia…');
const qids = [...new Set(titles.map((t) => t.wikidata).filter(Boolean))];
const enwiki = new Map();
for (let i = 0; i < qids.length; i += 50) {
  const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=${qids.slice(i, i + 50).join('|')}`);
  for (const [q, e] of Object.entries(r?.entities ?? {})) if (e.sitelinks?.enwiki?.title) enwiki.set(q, e.sitelinks.enwiki.title);
  await sleep(100);
}
const SECTION = /^(plot|premise|synopsis|plot summary|summary|storyline|story|overview|series overview|plot overview|premise and plot)$/i;
function plotOf(text) {
  const parts = text.split(/\n(?=={2,}[^=])/);
  for (const p of parts) {
    const m = p.match(/^={2,}\s*([^=]+?)\s*={2,}\n([\s\S]*)$/);
    if (m && SECTION.test(m[1].trim())) return m[2].replace(/\n={3,}[^=]+={3,}\n/g, '\n').replace(/\s+/g, ' ').trim();
  }
  return '';
}
await pool(titles, 8, async (t) => {
  const page = t.wikidata && enwiki.get(t.wikidata);
  if (!page) return;
  const r = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(page)}`);
  const pg = Object.values(r?.query?.pages ?? {})[0];
  const plot = pg?.extract ? plotOf('\n' + pg.extract) : '';
  if (plot.length > 120) { t.plot = plot.slice(0, 1600); t.wiki = page; }
});
console.log('Con argumento de Wikipedia:', titles.filter((t) => t.plot).length);

// 4) Embeddings reales (modelo bge-small-en-v1.5 cuantizado, ejecutado localmente con ONNX)
console.log('Embeddings…');
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = './.hf-cache';
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const docText = (t) => [t.overviewEn || '', t.taglineEn || '', t.plot || ''].join(' ').replace(/\s+/g, ' ').trim();
const withText = titles.filter((t) => docText(t).length >= 40);
const DIM = 384;
const vecs = new Map();
const t0 = Date.now();
for (let i = 0; i < withText.length; i += 16) {
  const batch = withText.slice(i, i + 16);
  const out = await embed(batch.map(docText), { pooling: 'cls', normalize: true });
  const data = out.data;
  batch.forEach((t, j) => vecs.set(t.key, Float32Array.from(data.slice(j * DIM, (j + 1) * DIM))));
  if (i % 800 === 0) console.log(`  ${i}/${withText.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const embMs = Date.now() - t0;
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Distribución de fondo (pares al azar) para calibrar
const vk = [...vecs.keys()];
const sample = [];
for (let i = 0; i < 30000 && vk.length > 2; i++) { const a = vk[(Math.random() * vk.length) | 0], b = vk[(Math.random() * vk.length) | 0]; if (a !== b) sample.push(dot(vecs.get(a), vecs.get(b))); }
sample.sort((a, b) => a - b);
const pct = (p) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
const calib = { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999), mean: sample.reduce((a, b) => a + b, 0) / sample.length };
console.log('Calibración coseno:', calib);

// 5) Rasgos narrativos: palabras clave (evidencia TMDB) + detección semántica (inferencia)
const weak = new Set(FACETS.weakKeywords.map((s) => s.toLowerCase()));
const kwRules = FACETS.facets.map((f) => ({ id: f.id, set: new Set(f.kw.map((s) => s.toLowerCase())) }));
const QUERY = 'Represent this sentence for searching relevant passages: ';
const protoVecs = new Map();
for (const f of FACETS.facets) {
  if (!f.proto.length) continue;
  const o = await embed(f.proto.map((p) => QUERY + p), { pooling: 'cls', normalize: true });
  protoVecs.set(f.id, f.proto.map((_, j) => Float32Array.from(o.data.slice(j * DIM, (j + 1) * DIM))));
}
// Distribución por rasgo para fijar umbrales (z-score sobre todo el catálogo)
const semStats = new Map();
for (const [id, pv] of protoVecs) {
  const vals = vk.map((k) => Math.max(...pv.map((p) => dot(vecs.get(k), p))));
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1;
  semStats.set(id, { m, sd });
}
const SEM_Z = 2.3;
for (const t of titles) {
  const facets = [];
  const names = t.kw.map(([, n]) => n.toLowerCase());
  for (const r of kwRules) {
    const hits = names.filter((n) => r.set.has(n));
    let kwConf = 0;
    for (const h of hits) kwConf = 1 - (1 - kwConf) * (1 - (weak.has(h) || !h.includes(' ') ? 0.45 : 0.8));
    let semConf = 0, z = 0;
    const v = vecs.get(t.key), pv = protoVecs.get(r.id);
    const textLen = docText(t).length;
    if (v && pv && textLen >= 150) {
      const st = semStats.get(r.id);
      z = (Math.max(...pv.map((p) => dot(v, p))) - st.m) / st.sd;
      if (z >= SEM_Z) semConf = Math.min(0.6, 0.3 + 0.12 * (z - SEM_Z)) * (t.plot ? 1 : 0.8);
    }
    const conf = 1 - (1 - kwConf) * (1 - semConf);
    if (conf >= 0.3) facets.push([r.id, Math.round(Math.min(0.95, conf) * 100) / 100, hits.length ? hits.slice(0, 3) : [], semConf > 0 ? Math.round(z * 10) / 10 : 0]);
  }
  t.facets = facets;
}

// 6) Frecuencias de documento (para IDF global)
const df = { kw: {}, facet: {}, genre: {} };
for (const t of titles) {
  for (const [id] of t.kw) df.kw[id] = (df.kw[id] ?? 0) + 1;
  for (const [id] of t.facets) df.facet[id] = (df.facet[id] ?? 0) + 1;
  for (const g of t.genres) df.genre[g] = (df.genre[g] ?? 0) + 1;
}

// 7) Escritura (sin textos de Wikipedia ni sinopsis completas)
const order = titles.filter((t) => vecs.has(t.key)).concat(titles.filter((t) => !vecs.has(t.key)));
const kwNames = {};
for (const t of order) for (const [id, n] of t.kw) kwNames[id] = n;
const meta = {
  version: new Date().toISOString().slice(0, 10), model: MODEL, dim: DIM, embedded: order.filter((t) => vecs.has(t.key)).length, calib, semZ: SEM_Z,
  sources: { tmdb: 'TMDB API (fichas, palabras clave, créditos, traducción inglesa de la sinopsis)', wikipedia: 'Wikipedia en inglés, sección de argumento/premisa (CC BY-SA 4.0), usada sólo para calcular vectores y rasgos; el texto no se distribuye.' },
  df, n: order.length, kwNames,
  titles: order.map((t) => [t.key, t.title, t.year ?? 0, t.genres, t.kw.map(([id]) => id), t.countries, t.lang ?? '', t.collection ?? 0, t.people, t.writers, t.cast, Math.round((t.vote ?? 0) * 10) / 10, t.votes ?? 0, Math.round(t.pop ?? 0), t.poster ?? '', t.facets, t.plot ? 2 : t.overviewEn ? 1 : 0, docText(t).length, t.provAR, t.runtime ?? 0, t.seasons ?? 0]),
};
writeFileSync(join(OUT, 'catalog-meta.json'), JSON.stringify(meta));
const buf = new Int8Array(meta.embedded * DIM);
order.slice(0, meta.embedded).forEach((t, i) => { const v = vecs.get(t.key); for (let j = 0; j < DIM; j++) buf[i * DIM + j] = Math.max(-127, Math.min(127, Math.round(v[j] * 127))); });
writeFileSync(join(OUT, 'catalog-emb.bin'), Buffer.from(buf.buffer));
// Sólo para la evaluación comparativa con v3.0 (que usaba la sinopsis en español); no se publica en la app
writeFileSync(join(OUT, 'eval-texts.json'), JSON.stringify(Object.fromEntries(order.map((t) => [t.key, t.overviewEs]))));

// 8) Informe y casos diagnósticos
const idx = new Map(order.map((t, i) => [t.key, i]));
const nn = (key, k = 15) => { const v = vecs.get(key); if (!v) return []; return order.slice(0, meta.embedded).filter((t) => t.key !== key).map((t) => [t, dot(v, vecs.get(t.key))]).sort((a, b) => b[1] - a[1]).slice(0, k); };
let rep = `# Catálogo narrativo ${meta.version}\n\nTítulos: ${order.length} · con vector: ${meta.embedded} · con argumento de Wikipedia: ${titles.filter((t) => t.plot).length} · tiempo de embeddings: ${(embMs / 1000).toFixed(0)} s\n\nCalibración coseno (pares al azar): ${JSON.stringify(calib)}\n\n`;
for (const k of ['tv:111803', 'tv:325755', 'tv:336240', 'tv:227371', 'tv:1413', 'tv:253376']) {
  const t = order[idx.get(k)];
  if (!t) { rep += `## ${k}: no está\n\n`; continue; }
  rep += `## ${t.title} (${k}, ${t.year}) · texto: ${t.plot ? 'TMDB + Wikipedia «' + t.wiki + '»' : 'sólo TMDB'} (${docText(t).length} car.)\n\nPalabras clave: ${t.kw.map(([, n]) => n).join(', ')}\n\nRasgos: ${t.facets.map(([id, c, h, z]) => `${id} ${c}${h.length ? ' kw[' + h.join('/') + ']' : ''}${z ? ' z' + z : ''}`).join(' · ')}\n\nVecinos semánticos: ${nn(k, 12).map(([x, s]) => `${x.title} ${s.toFixed(3)}`).join(' · ')}\n\n`;
}
writeFileSync(join(OUT, 'report.md'), rep);
console.log(rep);
// Modelo (para uso local reproducible)
const mdir = join('.hf-cache', MODEL);
if (existsSync(mdir)) cpSync(mdir, join(OUT, 'model'), { recursive: true });
console.log('Listo.');
