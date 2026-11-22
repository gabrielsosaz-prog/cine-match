// Identifica títulos por búsqueda en TMDB (a través de la app publicada) y muestra datos clave.
const APP = process.env.APP;
const get = async (p) => { const r = await fetch(`${APP}/api/tmdb/${p}`); if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); };
const queries = ['The White Lotus', 'El club gastronómico', 'El intercambio', 'Perfil falso', 'La novia', '56 días', 'El cuerpo en llamas', 'Love Story', 'American Horror Story'];
for (const q of queries) {
  const s = await get(`search/multi?query=${encodeURIComponent(q)}&language=es-MX`);
  console.log(`\n### ${q}`);
  for (const x of s.results.filter((x) => x.media_type !== 'person').slice(0, 5)) console.log(`- ${x.media_type}:${x.id} «${x.title ?? x.name}» / «${x.original_title ?? x.original_name}» ${(x.release_date ?? x.first_air_date ?? '').slice(0, 4)} votos ${x.vote_count} pop ${x.popularity?.toFixed(0)} países ${x.origin_country ?? ''}`);
}
for (const k of [['tv', 111803]]) {
  const d = await get(`${k[0]}/${k[1]}?language=es-MX&append_to_response=keywords,external_ids,videos,translations`);
  console.log(`\n## detalle ${k}`, d.name ?? d.title, '| wikidata', d.external_ids?.wikidata_id, '| origin', d.origin_country, '| prod', d.production_countries?.map((c) => c.iso_3166_1));
  console.log('keywords:', (d.keywords?.results ?? d.keywords?.keywords ?? []).map((x) => x.name).join(', '));
  console.log('videos:', d.videos?.results?.map((v) => `${v.type}|${v.iso_639_1}|${v.official}|${v.site}|${v.name}`).join(' ;; '));
  console.log('en overview:', d.translations?.translations?.find((t) => t.iso_639_1 === 'en')?.data?.overview?.slice(0, 200));
}
const prov = await get('discover/movie?watch_region=AR&with_watch_providers=531&language=es-MX&sort_by=popularity.desc');
console.log('\nParamount+ (531) en AR, películas:', prov.total_results, prov.results.slice(0, 5).map((x) => x.title));
for (const id of [531, 582, 1853, 633, 2303, 2616, 1748]) {
  const r = await get(`discover/tv?watch_region=AR&with_watch_providers=${id}&language=es-MX`);
  console.log('proveedor', id, 'series AR:', r.total_results);
}
const d2 = await get('movie/550?language=es-MX&append_to_response=watch/providers');
console.log('AR proveedores Fight Club:', JSON.stringify(d2['watch/providers']?.results?.AR));
