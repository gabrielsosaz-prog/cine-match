// Verifica la identidad de cada título del conjunto de evaluación por su ID de TMDB y muestra su sinopsis inglesa.
import { readFileSync } from 'node:fs';
const APP = process.env.APP;
const cases = JSON.parse(readFileSync('eval/cases.json', 'utf8'));
const keys = new Set();
for (const t of cases.triples) { t.refs.forEach((k) => keys.add(k)); keys.add(t.positive); keys.add(t.negative); }
for (const c of cases.sequelChecks) c.refs.forEach((k) => keys.add(k));
cases.diagnostic.refs.forEach((k) => keys.add(k)); cases.diagnostic.reported.forEach((k) => keys.add(k));
for (const k of keys) {
  const [type, id] = k.split(':');
  const r = await fetch(`${APP}/api/tmdb/${type}/${id}?language=en-US&append_to_response=keywords`);
  const d = await r.json();
  const kw = (d.keywords?.keywords ?? d.keywords?.results ?? []).map((x) => x.name).join(', ');
  console.log(`\n${k} | ${d.title ?? d.name} (${(d.release_date ?? d.first_air_date ?? '').slice(0, 4)}) | ${d.original_title ?? d.original_name}\n  ${d.overview}\n  kw: ${kw}`);
}
