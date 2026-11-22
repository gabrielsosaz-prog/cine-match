// v3.2: investigación de búsqueda de personas, filmografías, reparto combinado y videos (TMDB real vía la app)
const APP = process.env.APP;
const get = async (p) => { const r = await fetch(`${APP}/api/tmdb/${p}`); if (!r.ok) return { error: r.status, path: p }; return r.json(); };
const qs = ['Michael Fox', 'Michael J. Fox', 'michael j fox', 'Leonardo DiCaprio', 'Leonardo Di Caprio', 'leonardo dicaprio', 'Leonardo Dicaprio', 'Leonard DiCaprio', 'DiCaprio', 'Ben Afleck', 'Ben Affleck', 'Jennifer Lopez', 'Jenifer Lopez', 'Ricardo Darin', 'Volver al futuro', 'Michael', 'Fox'];
for (const q of qs) {
  for (const ep of ['search/multi', 'search/person']) {
    const s = await get(`${ep}?query=${encodeURIComponent(q)}&language=es-MX`);
    if (s.error) { console.log(ep, q, 'ERROR', s.error); continue; }
    console.log(`\n### ${ep} «${q}» total ${s.total_results}`);
    for (const x of (s.results ?? []).slice(0, 8)) console.log(`- ${x.media_type ?? 'person'}:${x.id} «${x.title ?? x.name}» ${x.known_for_department ?? ''} pop ${x.popularity?.toFixed(1)} ${x.known_for ? 'kf: ' + x.known_for.map((k) => k.title ?? k.name).slice(0, 3).join(' / ') : ''}`);
  }
}
const p = await get('person/521?language=es-MX&append_to_response=combined_credits');
console.log('\nMJF', p.name, 'aka', (p.also_known_as ?? []).join(' | '));
const cc = p.combined_credits ?? (await get('person/521/combined_credits?language=es-MX'));
console.log('cast', cc.cast?.length, 'crew', cc.crew?.length, 'BTTF in cast?', cc.cast?.some((c) => c.id === 105 && c.media_type === 'movie'));
console.log('tv cast sample', JSON.stringify(cc.cast?.filter((c) => c.media_type === 'tv').slice(0, 4).map((c) => ({ id: c.id, n: c.name, ch: c.character, ep: c.episode_count, credit_id: c.credit_id }))));
for (const id of [6193]) { const d = await get(`person/${id}?language=es-MX`); console.log('DiCaprio aka', d.name, (d.also_known_as ?? []).join(' | ')); }
// Ben Affleck + Jennifer Lopez
const ba = await get('search/person?query=Ben%20Affleck'); const jl = await get('search/person?query=Jennifer%20Lopez');
const a = ba.results?.[0]?.id, b = jl.results?.[0]?.id; console.log('\nBA', a, ba.results?.[0]?.name, 'JL', b, jl.results?.[0]?.name);
for (const t of ['movie', 'tv']) {
  const d = await get(`discover/${t}?with_cast=${a},${b}&language=es-MX&sort_by=popularity.desc`);
  console.log(`discover ${t} with_cast=${a},${b} (AND)`, d.error ?? d.total_results, (d.results ?? []).map((x) => x.title ?? x.name).join(' / '));
  const d2 = await get(`discover/${t}?with_cast=${a}|${b}&language=es-MX&sort_by=popularity.desc`);
  console.log(`discover ${t} with_cast=${a}|${b} (OR)`, d2.error ?? d2.total_results);
  const d3 = await get(`discover/${t}?with_people=${a},${b}&language=es-MX`);
  console.log(`discover ${t} with_people AND`, d3.error ?? d3.total_results, (d3.results ?? []).map((x) => x.title ?? x.name).join(' / '));
}
const ca = await get(`person/${a}/combined_credits?language=es-MX`), cb = await get(`person/${b}/combined_credits?language=es-MX`);
const ka = new Set(ca.cast.map((c) => `${c.media_type}:${c.id}`)); const both = cb.cast.filter((c) => ka.has(`${c.media_type}:${c.id}`));
console.log('intersección de filmografías (cast):', both.map((c) => `${c.media_type}:${c.id} ${c.title ?? c.name} [${c.character}]`).join(' / '));
const crewBoth = cb.crew.filter((c) => ka.has(`${c.media_type}:${c.id}`) || new Set(ca.crew.map((x) => `${x.media_type}:${x.id}`)).has(`${c.media_type}:${c.id}`));
console.log('JL crew coincidente con BA:', crewBoth.slice(0, 8).map((c) => `${c.title ?? c.name} (${c.job})`).join(' / '));
// Videos
for (const [t, id] of [['movie', 105], ['movie', 27205], ['movie', 872585], ['tv', 1396], ['movie', 496243], ['tv', 111803], ['movie', 157336]]) {
  const v = await get(`${t}/${id}/videos?language=es-MX&include_video_language=es,en,null`);
  const all = await get(`${t}/${id}/videos`);
  console.log(`\nvideos ${t}:${id}`, (v.results ?? []).map((x) => `${x.iso_639_1}-${x.iso_3166_1}|${x.type}|${x.official}|${x.site}|${x.name}`).join(' ;; '));
  console.log(`  sin filtro`, (all.results ?? []).map((x) => `${x.iso_639_1}-${x.iso_3166_1}|${x.type}|${x.name}`).slice(0, 12).join(' ;; '));
}
