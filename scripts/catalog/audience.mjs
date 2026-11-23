// Enriquecimiento del catálogo narrativo con SEÑALES de público objetivo (v3.3). Corre en GitHub Actions.
// No clasifica: guarda evidencia verificable que la app combina con reglas documentadas (src/services/audience.ts).
//  1. Clasificación por edad oficial de TMDB (release_dates de películas, content_ratings de series) para US, AR,
//     MX y ES. Es la edad RECOMENDADA por contenido, no el público objetivo: en la app es una señal auxiliar.
//  2. Similitud semántica de la sinopsis+argumento con descripciones prototipo de público (mismos vectores
//     bge-small-en-v1.5 del catálogo), como puntaje z sobre todo el catálogo. Es una inferencia.
// Salida: data/out/audience.json (+ report.md con casos conocidos).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.env.APP ?? 'https://cine-match-pied-tau.vercel.app';
const OUT = 'data/out';
const LIMIT = Number(process.env.CATALOG_LIMIT ?? 0);
mkdirSync(OUT, { recursive: true });
const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const meta = JSON.parse(readFileSync(join('public/catalog', man.meta), 'utf8'));
const emb = new Int8Array(readFileSync(join('public/catalog', man.emb)).buffer.slice(0));
const DIM = meta.dim;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'CineMatchAudience/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { if (i >= tries) { console.warn('falló', url.slice(0, 100), e.message); return null; } await sleep(800 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); if (++done % 500 === 0) console.log(`  ${done}/${items.length}`); } }));
}

const CASES = ['tv:85552', 'tv:66732', 'movie:10625', 'movie:466282', 'tv:81356', 'tv:69050', 'tv:82728', 'movie:862', 'movie:109445', 'movie:238', 'tv:1396', 'tv:1395',
  'tv:76669', 'movie:8966', 'movie:70160', 'tv:93405', 'movie:2108', 'movie:105', 'tv:1668', 'movie:597', 'movie:496243', 'tv:111803', 'tv:60625', 'tv:1434', 'movie:12',
  'movie:155', 'movie:11036', 'movie:4951', 'tv:46648', 'movie:76341', 'tv:119051', 'movie:313369', 'tv:71912', 'tv:1399', 'movie:12445', 'movie:671'];
let rows = meta.titles.map((t, i) => ({ key: t[0], title: t[1], year: t[2], genres: t[3], kw: t[4], i }));
if (LIMIT) rows = [...rows.filter((r) => CASES.includes(r.key)), ...rows.filter((r) => !CASES.includes(r.key)).slice(0, LIMIT)];
console.log('Títulos:', rows.length);

// 1) Clasificaciones por edad
const REG = ['US', 'AR', 'MX', 'ES'];
const certs = new Map();
await pool(rows, 10, async (r) => {
  const [type, id] = r.key.split(':');
  const d = await getJson(`${APP}/api/tmdb/${type}/${id}?append_to_response=${type === 'movie' ? 'release_dates' : 'content_ratings'}`);
  if (!d) return;
  const out = {};
  if (type === 'movie') {
    for (const x of d.release_dates?.results ?? []) if (REG.includes(x.iso_3166_1)) {
      // preferir estreno en cines (3) o digital (4); si no, el primero con certificación
      const rel = [...(x.release_dates ?? [])].filter((y) => y.certification).sort((a, b) => [3, 4, 2, 1, 5, 6].indexOf(a.type) - [3, 4, 2, 1, 5, 6].indexOf(b.type));
      if (rel[0]) out[x.iso_3166_1] = rel[0].certification.trim();
    }
  } else for (const x of d.content_ratings?.results ?? []) if (REG.includes(x.iso_3166_1) && x.rating) out[x.iso_3166_1] = x.rating.trim();
  certs.set(r.key, out);
});
console.log('Con alguna clasificación por edad:', [...certs.values()].filter((c) => Object.keys(c).length).length, 'con US:', [...certs.values()].filter((c) => c.US).length);

// 2) Prototipos semánticos
const PROTOS = {
  kids: ['A cartoon made for young children, with simple stories about friendship, sharing and learning.', 'A preschool animated series for little kids.'],
  teen: ['A teen movie made for a teenage audience about high school cliques, first crushes and prom.', 'A young adult drama for teen viewers about dating, popularity and fitting in at school.'],
  family: ['A family-friendly adventure for all ages that parents and children can enjoy together.'],
  adult: ['A mature drama for adult audiences with graphic violence, sexuality and morally complex characters.'],
};
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = './.hf-cache';
const embed = await pipeline('feature-extraction', meta.model, { dtype: 'q8' });
const QUERY = 'Represent this sentence for searching relevant passages: ';
const pv = {};
for (const [k, ps] of Object.entries(PROTOS)) { const o = await embed(ps.map((p) => QUERY + p), { pooling: 'cls', normalize: true }); pv[k] = ps.map((_, j) => Float32Array.from(o.data.slice(j * DIM, (j + 1) * DIM))); }
const vec = (i) => { const v = new Float32Array(DIM); for (let j = 0; j < DIM; j++) v[j] = emb[i * DIM + j] / 127; return v; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const raw = {};
for (const k of Object.keys(PROTOS)) raw[k] = new Map();
for (let i = 0; i < meta.embedded; i++) { const v = vec(i); for (const k of Object.keys(PROTOS)) raw[k].set(meta.titles[i][0], Math.max(...pv[k].map((p) => dot(v, p)))); }
const z = {};
for (const k of Object.keys(PROTOS)) {
  const vals = [...raw[k].values()]; const m = vals.reduce((a, b) => a + b, 0) / vals.length; const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1;
  z[k] = (key) => (raw[k].has(key) ? Math.round(((raw[k].get(key) - m) / sd) * 10) / 10 : null);
}

// 3) Escritura: [key, {cert}, zKids, zTeen, zFamily, zAdult] (z null = sin vector)
const version = new Date().toISOString().slice(0, 10);
const entries = rows.map((r) => [r.key, certs.get(r.key) ?? {}, z.kids(r.key), z.teen(r.key), z.family(r.key), z.adult(r.key)]);
writeFileSync(join(OUT, 'audience.json'), JSON.stringify({
  version, catalog: man.version, model: meta.model, protos: PROTOS, regions: REG,
  sources: { certification: 'TMDB release_dates (películas) y content_ratings (series): clasificación por edad oficial de cada país', semantic: 'similitud de los vectores del catálogo (sinopsis TMDB + argumento de Wikipedia) con descripciones prototipo; z sobre todo el catálogo' },
  entries,
}));
const kwName = (id) => meta.kwNames[id] ?? id;
let rep = `# Señales de público ${version} (catálogo ${man.version})\n\nTítulos: ${rows.length} · con clasificación por edad: ${[...certs.values()].filter((c) => Object.keys(c).length).length} · con vector: ${entries.filter((e) => e[2] !== null).length}\n\n`;
const dist = {};
for (const c of certs.values()) if (c.US) dist[c.US] = (dist[c.US] ?? 0) + 1;
rep += `Clasificaciones de EE. UU.: ${JSON.stringify(dist)}\n\n| Título | Clasif. | z niños/adolesc./familia/adulto | Géneros | Palabras clave de público |\n|---|---|---|---|---|\n`;
const AUD_KW = /teen|young adult|high school|coming of age|kids|children|cartoon|family|adult animation|erotic|teenage|youth|adolescence/i;
for (const k of CASES) {
  const r = rows.find((x) => x.key === k); if (!r) { rep += `| ${k} (no está) | | | | |\n`; continue; }
  const e = entries.find((x) => x[0] === k);
  rep += `| ${r.title} (${k}, ${r.year}) | ${JSON.stringify(e[1])} | ${e.slice(2).join(' / ')} | ${r.genres.join(',')} | ${r.kw.map(kwName).filter((n) => AUD_KW.test(n)).join(', ')} |\n`;
}
writeFileSync(join(OUT, 'report.md'), rep);
console.log(rep);
