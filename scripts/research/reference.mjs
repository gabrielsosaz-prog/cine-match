// v3.4: datos de REFERENCIA independientes del motor para evaluar recomendaciones y público objetivo.
// Corre en GitHub Actions. Para cada título del catálogo:
//  1. TMDB (vía la app publicada; el token queda en el servidor): id de Wikidata (external_ids).
//  2. Wikidata (API wbgetentities, CC0): género (P136), tema principal (P921), público destinatario (P2360),
//     candidaturas (P1411) y premios (P166), con sus etiquetas en inglés.
//  3. Wikipedia en inglés (API, categorías visibles del artículo): p. ej. «Films about time travel»,
//     «Nonlinear narrative films», «American teen comedy films», «Adult animated television series».
// Son clasificaciones editoriales de otras comunidades: el motor no las usa. No es scraping: sólo APIs públicas.
// Salida: data/out/reference.json (+ report.md con coberturas).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.env.APP ?? 'https://cine-match-pied-tau.vercel.app';
const OUT = 'data/out';
const LIMIT = Number(process.env.CATALOG_LIMIT ?? 0);
const UA = 'CineMatchEvaluation/1.0 (https://github.com/gabrielsosaz-prog/cine-match)';
mkdirSync(OUT, { recursive: true });
const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const meta = JSON.parse(readFileSync(join('public/catalog', man.meta), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { if (i >= tries) { console.warn('falló', url.slice(0, 110), e.message); return null; } await sleep(1000 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); if (++done % 1000 === 0) console.log(`  ${done}/${items.length}`); } }));
}

let keys = meta.titles.map((t) => t[0]);
if (LIMIT) keys = keys.slice(0, LIMIT);
console.log('Títulos:', keys.length);

// 1) Wikidata ids
const qid = new Map();
await pool(keys, 10, async (k) => {
  const [type, id] = k.split(':');
  const d = await getJson(`${APP}/api/tmdb/${type}/${id}?append_to_response=external_ids`);
  if (d?.external_ids?.wikidata_id) qid.set(k, d.external_ids.wikidata_id);
});
console.log('Con Wikidata:', qid.size);

// 2) Wikidata: afirmaciones
const PROPS = ['P136', 'P921', 'P2360', 'P1411', 'P166'];
const claims = new Map(); // qid -> {P: [Q...]}
const enwiki = new Map();
const qs = [...new Set(qid.values())];
for (let i = 0; i < qs.length; i += 50) {
  const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks&sitefilter=enwiki&ids=${qs.slice(i, i + 50).join('|')}`);
  for (const [q, e] of Object.entries(r?.entities ?? {})) {
    const c = {};
    for (const p of PROPS) {
      const v = (e.claims?.[p] ?? []).filter((s) => s.rank !== 'deprecated').map((s) => s.mainsnak?.datavalue?.value?.id).filter(Boolean);
      if (v.length) c[p] = [...new Set(v)];
    }
    claims.set(q, c);
    if (e.sitelinks?.enwiki?.title) enwiki.set(q, e.sitelinks.enwiki.title);
  }
  await sleep(80);
}
// etiquetas en inglés de los valores
const vals = [...new Set([...claims.values()].flatMap((c) => Object.values(c).flat()))];
const label = new Map();
for (let i = 0; i < vals.length; i += 50) {
  const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${vals.slice(i, i + 50).join('|')}`);
  for (const [q, e] of Object.entries(r?.entities ?? {})) label.set(q, e.labels?.en?.value ?? q);
  await sleep(80);
}
console.log('Afirmaciones:', claims.size, 'etiquetas:', label.size);

// 3) Categorías de Wikipedia (visibles, no ocultas)
const cats = new Map();
await pool(keys.filter((k) => enwiki.has(qid.get(k))), 8, async (k) => {
  const page = enwiki.get(qid.get(k));
  const out = [];
  let cont = '';
  for (let n = 0; n < 4; n++) {
    const r = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=categories&clshow=!hidden&cllimit=max&redirects=1&titles=${encodeURIComponent(page)}${cont}`);
    const pg = Object.values(r?.query?.pages ?? {})[0];
    for (const c of pg?.categories ?? []) out.push(c.title.replace(/^Category:/, ''));
    if (!r?.continue?.clcontinue) break;
    cont = `&clcontinue=${encodeURIComponent(r.continue.clcontinue)}`;
  }
  if (out.length) cats.set(k, out);
});
console.log('Con categorías de Wikipedia:', cats.size);

// 4) Salida compacta (diccionarios)
const catDict = [...new Set([...cats.values()].flat())].sort();
const catIx = new Map(catDict.map((c, i) => [c, i]));
const wdDict = [...label.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const titles = {};
for (const k of keys) {
  const q = qid.get(k);
  if (!q) continue;
  const c = claims.get(q) ?? {};
  titles[k] = { q, wiki: enwiki.get(q), cats: (cats.get(k) ?? []).map((x) => catIx.get(x)), ...Object.fromEntries(Object.entries(c)) };
}
const version = new Date().toISOString().slice(0, 10);
writeFileSync(join(OUT, 'reference.json'), JSON.stringify({
  version, catalog: man.version,
  sources: { wikidata: 'Wikidata (CC0) vía API wbgetentities: P136 género, P921 tema principal, P2360 público destinatario, P1411 candidatura, P166 premio', wikipedia: 'Wikipedia en inglés vía API: categorías visibles del artículo', tmdb: 'TMDB external_ids (vía el proxy de la app) para enlazar cada título con Wikidata' },
  labels: Object.fromEntries(wdDict), cats: catDict, titles,
}));
const cnt = (p) => Object.values(titles).filter((t) => t[p]?.length).length;
const rep = `# Datos de referencia ${version} (catálogo ${man.version})\n\nTítulos: ${keys.length} · con Wikidata: ${qid.size} · con artículo en inglés: ${[...qid.values()].filter((q) => enwiki.has(q)).length} · con categorías: ${cats.size}\n\nCon P136 género: ${cnt('P136')} · P921 tema: ${cnt('P921')} · P2360 público: ${cnt('P2360')} · P1411 candidaturas: ${cnt('P1411')} · P166 premios: ${cnt('P166')}\n\nCategorías distintas: ${catDict.length}\n\nPúblico destinatario (P2360) más frecuente: ${JSON.stringify(Object.entries(Object.values(titles).flatMap((t) => t.P2360 ?? []).reduce((a, q) => ((a[label.get(q)] = (a[label.get(q)] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 15))}\n`;
writeFileSync(join(OUT, 'report.md'), rep);
console.log(rep);
