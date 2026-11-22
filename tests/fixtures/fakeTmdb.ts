/**
 * Catálogo SINTÉTICO que imita el formato de respuesta de la API de TMDB.
 * Sólo se usa en pruebas automáticas: no representa disponibilidad real.
 */
export type Cluster = 'thriller' | 'comedy' | 'animation' | 'scifi' | 'drama' | 'horror' | 'romance' | 'action';

export interface FakeTitle {
  id: number; type: 'movie' | 'tv'; name: string; cluster: Cluster; genres: number[]; keywords: number[];
  director: number; cast: number[]; year: number; runtime: number; vote: number; votes: number; popularity: number;
  providers: { id: number; name: string }[] | null; lang: string; overview: string;
}

export const GENRES: Record<number, string> = {
  28: 'Acción', 12: 'Aventura', 16: 'Animación', 35: 'Comedia', 80: 'Crimen', 18: 'Drama', 10751: 'Familia',
  14: 'Fantasía', 36: 'Historia', 27: 'Terror', 9648: 'Misterio', 10749: 'Romance', 878: 'Ciencia ficción', 53: 'Suspense', 10752: 'Bélica',
};

const KW: Record<number, string> = {
  1: 'detective', 2: 'serial killer', 3: 'investigation', 4: 'conspiracy', 5: 'small town', 6: 'sitcom', 7: 'workplace comedy',
  8: 'friendship', 9: 'family', 10: 'pixar', 11: 'coming of age', 12: 'time travel', 13: 'dystopia', 14: 'space',
  15: 'artificial intelligence', 16: 'biography', 17: 'world war ii', 18: 'politics', 19: 'ghost', 20: 'haunted house',
  21: 'possession', 22: 'love', 23: 'marriage', 24: 'romance', 25: 'superhero', 26: 'heist', 27: 'martial arts',
  28: 'plot twist', 29: 'dark comedy', 30: 'based on novel or book', 31: 'mafia', 32: 'grief', 33: 'magic', 34: 'robot',
};

const CLUSTERS: Record<Cluster, { genres: number[]; kws: number[]; directors: number[]; cast: number[]; runtime: [number, number] }> = {
  thriller: { genres: [53, 9648, 80], kws: [1, 2, 3, 4, 5, 28, 31], directors: [101, 102, 103], cast: [201, 202, 203, 204, 205], runtime: [110, 150] },
  comedy: { genres: [35], kws: [6, 7, 8, 9, 29], directors: [111, 112, 113], cast: [211, 212, 213, 214, 215], runtime: [85, 105] },
  animation: { genres: [16, 10751, 12], kws: [8, 9, 10, 11, 33], directors: [121, 122], cast: [221, 222, 223, 224], runtime: [80, 100] },
  scifi: { genres: [878, 12], kws: [12, 13, 14, 15, 34, 28], directors: [131, 132, 133], cast: [231, 232, 233, 234], runtime: [115, 160] },
  drama: { genres: [18, 36, 10752], kws: [16, 17, 18, 30, 32], directors: [141, 142, 143], cast: [241, 242, 243, 244], runtime: [120, 170] },
  horror: { genres: [27, 53], kws: [19, 20, 21, 5], directors: [151, 152], cast: [251, 252, 253], runtime: [85, 105] },
  romance: { genres: [10749, 18, 35], kws: [22, 23, 24, 8], directors: [161, 162], cast: [261, 262, 263, 264], runtime: [95, 120] },
  action: { genres: [28, 12, 14], kws: [25, 26, 27, 33], directors: [171, 172, 173], cast: [271, 272, 273, 274], runtime: [110, 145] },
};

const PROVIDERS = [{ id: 8, name: 'Netflix' }, { id: 119, name: 'Amazon Prime Video' }, { id: 337, name: 'Disney Plus' }, { id: 1899, name: 'Max' }, { id: 167, name: 'Claro video' }];

export function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function buildCatalog(perCluster = 25, seed = 42): FakeTitle[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: FakeTitle[] = [];
  let id = 1000;
  for (const cluster of Object.keys(CLUSTERS) as Cluster[]) {
    const c = CLUSTERS[cluster];
    for (let i = 0; i < perCluster; i++) {
      const type = r() < 0.4 ? 'tv' : 'movie';
      const genres = [...new Set([c.genres[0], ...c.genres.filter(() => r() < 0.5), ...(r() < 0.15 ? [pick(Object.keys(GENRES).map(Number))] : [])])];
      const keywords = [...new Set([...c.kws.filter(() => r() < 0.55), pick(c.kws), ...(r() < 0.3 ? [pick(Object.keys(KW).map(Number))] : [])])];
      const nProv = r();
      const providers = nProv < 0.08 ? null : PROVIDERS.filter(() => r() < 0.35);
      const vote = Math.round((5.5 + r() * 3.5) * 10) / 10;
      out.push({
        id: id++, type, name: `${cluster[0].toUpperCase()}${cluster.slice(1)} ${type === 'tv' ? 'Serie' : 'Film'} ${i + 1}`, cluster, genres, keywords,
        director: pick(c.directors), cast: c.cast.filter(() => r() < 0.5).slice(0, 3),
        year: 1985 + Math.floor(r() * 40), runtime: type === 'tv' ? (r() < 0.5 ? 30 : 55) : c.runtime[0] + Math.floor(r() * (c.runtime[1] - c.runtime[0])),
        vote, votes: Math.floor(200 + r() * 20000), popularity: Math.round(r() * 300), providers, lang: r() < 0.75 ? 'en' : pick(['es', 'ko', 'fr']),
        overview: r() < 0.1 ? '' : `Sinopsis sintética de un título de ${cluster}.`,
      });
    }
  }
  // Homónimos: misma denominación e id numérico, distinto tipo
  out.push({ ...out[0], id: 9000, type: 'movie', name: 'La Casa', year: 2012 });
  out.push({ ...out[30], id: 9000, type: 'tv', name: 'La Casa', year: 2020 });
  return out;
}

const listItem = (t: FakeTitle) => ({
  id: t.id, media_type: t.type, [t.type === 'movie' ? 'title' : 'name']: t.name, [t.type === 'movie' ? 'original_title' : 'original_name']: t.name,
  [t.type === 'movie' ? 'release_date' : 'first_air_date']: `${t.year}-05-01`, overview: t.overview, poster_path: null, genre_ids: t.genres,
  vote_average: t.vote, vote_count: t.votes, popularity: t.popularity, original_language: t.lang,
});

const providersPayload = (t: FakeTitle) => ({
  id: t.id,
  results: t.providers === null ? {} : { AR: { link: `https://www.themoviedb.org/${t.type}/${t.id}/watch?locale=AR`, flatrate: t.providers.map((p) => ({ provider_id: p.id, provider_name: p.name, logo_path: null })) } },
});

export interface FakeOptions { failRate?: number; status?: number; delayMs?: number }

/** Responde como la API de TMDB para el catálogo sintético. */
export function fakeTmdbHandler(catalog: FakeTitle[], opts: FakeOptions = {}) {
  const r = rng(7);
  const find = (type: string, id: number) => catalog.find((t) => t.type === type && t.id === id);
  return async (url: string): Promise<{ status: number; body: unknown }> => {
    if (opts.status) return { status: opts.status, body: { status_message: 'error simulado' } };
    if (opts.failRate && r() < opts.failRate) return { status: 500, body: {} };
    const u = new URL(url);
    const path = u.pathname.replace(/^\/3/, '');
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/genre\/(movie|tv)\/list$/))) return { status: 200, body: { genres: Object.entries(GENRES).map(([id, name]) => ({ id: Number(id), name })) } };
    if (path === '/search/multi') {
      const q = (u.searchParams.get('query') ?? '').toLowerCase();
      return { status: 200, body: { results: [{ id: 1, media_type: 'person', name: 'Persona' }, ...catalog.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 20).map(listItem)] } };
    }
    if (path === '/search/person') {
      const q = (u.searchParams.get('query') ?? '').toLowerCase();
      // Homónimos a propósito: dos personas «Actor 231» con distinto id y oficio
      const people = [...new Set(catalog.flatMap((t) => t.cast))].map((id) => ({ id, name: `Actor ${id}`, known_for_department: 'Acting', popularity: 10,
        known_for: catalog.filter((t) => t.cast.includes(id)).slice(0, 2).map((t) => ({ ...listItem(t), media_type: t.type })) }));
      people.push({ id: 99231, name: 'Actor 231', known_for_department: 'Directing', popularity: 1, known_for: [] });
      return { status: 200, body: { results: people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20) } };
    }
    if ((m = path.match(/^\/person\/(\d+)\/combined_credits$/))) {
      const id = Number(m[1]);
      const cast = catalog.filter((t) => t.cast.includes(id)).map((t) => ({ ...listItem(t), media_type: t.type, character: 'Personaje', order: t.cast.indexOf(id), episode_count: t.type === 'tv' ? 8 : undefined }));
      const crew = catalog.filter((t) => t.director === id).map((t) => ({ ...listItem(t), media_type: t.type, job: 'Director', department: 'Directing' }));
      return { status: 200, body: { id, cast, crew } };
    }
    if ((m = path.match(/^\/(trending)\/(movie|tv)\/week$/))) return { status: 200, body: { results: catalog.filter((t) => t.type === m![2]).slice(0, 20).map(listItem) } };
    if ((m = path.match(/^\/discover\/(movie|tv)$/))) {
      const type = m[1];
      const genres = u.searchParams.get('with_genres')?.split('|').map(Number);
      const prov = u.searchParams.get('with_watch_providers')?.split('|').map(Number);
      const kws = u.searchParams.get('with_keywords')?.split('|').map(Number);
      const castQ = u.searchParams.get('with_cast')?.split('|').map(Number);
      const crewQ = u.searchParams.get('with_crew')?.split('|').map(Number);
      const page = Number(u.searchParams.get('page') ?? 1);
      const sort = u.searchParams.get('sort_by') ?? 'popularity.desc';
      let list = catalog.filter((t) => t.type === type && (!genres || t.genres.some((g) => genres.includes(g))) && (!prov || (t.providers ?? []).some((p) => prov.includes(p.id)))
        && (!kws || t.keywords.some((k) => kws.includes(k))) && (!castQ || t.cast.some((c) => castQ.includes(c))) && (!crewQ || crewQ.includes(t.director) || crewQ.includes(t.director + 500)));
      list = list.sort((a, b) => sort.startsWith('vote_average') ? b.vote - a.vote : sort.startsWith('vote_count') ? b.votes - a.votes : b.popularity - a.popularity);
      return { status: 200, body: { results: list.slice((page - 1) * 20, page * 20).map(listItem) } };
    }
    if ((m = path.match(/^\/(movie|tv)\/(\d+)\/watch\/providers$/))) {
      const t = find(m[1], Number(m[2]));
      return t ? { status: 200, body: providersPayload(t) } : { status: 404, body: {} };
    }
    if ((m = path.match(/^\/(movie|tv)\/(\d+)$/))) {
      const t = find(m[1], Number(m[2]));
      if (!t) return { status: 404, body: { status_message: 'not found' } };
      const kws = t.keywords.map((k) => ({ id: k, name: KW[k] }));
      const related = catalog.filter((x) => x.type === t.type && x.cluster === t.cluster && x.id !== t.id).slice(0, 8).map(listItem);
      const lang = u.searchParams.get('language') ?? '';
      return {
        status: 200,
        body: {
          id: t.id, [t.type === 'movie' ? 'title' : 'name']: t.name, [t.type === 'movie' ? 'original_title' : 'original_name']: t.name,
          [t.type === 'movie' ? 'release_date' : 'first_air_date']: `${t.year}-05-01`,
          overview: lang.startsWith('en') ? `Synthetic overview (${t.cluster}).` : t.overview,
          poster_path: null, backdrop_path: null, genres: t.genres.map((g) => ({ id: g, name: GENRES[g] })),
          runtime: t.type === 'movie' ? t.runtime : undefined, episode_run_time: t.type === 'tv' ? [t.runtime] : undefined,
          number_of_seasons: t.type === 'tv' ? 1 + (t.id % 4) : undefined,
          seasons: t.type === 'tv' ? Array.from({ length: 1 + (t.id % 4) }, (_, i) => ({ season_number: i + 1, name: `Temporada ${i + 1}`, episode_count: 8 })) : undefined,
          created_by: t.type === 'tv' ? [{ id: t.director, name: `Creador ${t.director}` }] : undefined,
          vote_average: t.vote, vote_count: t.votes, popularity: t.popularity, original_language: t.lang,
          keywords: t.type === 'movie' ? { keywords: kws } : { results: kws },
          credits: { cast: t.cast.map((c) => ({ id: c, name: `Actor ${c}`, character: 'Personaje' })), crew: t.type === 'movie' ? [{ id: t.director, name: `Director ${t.director}`, job: 'Director', department: 'Directing' }, { id: t.director + 500, name: `Guionista ${t.director + 500}`, job: 'Screenplay', department: 'Writing' }] : [] },
          aggregate_credits: t.type === 'tv' ? { cast: t.cast.map((c, i) => ({ id: c, name: `Actor ${c}`, roles: [{ character: 'Personaje' }], order: i, total_episode_count: 8 })), crew: [{ id: t.director + 500, name: `Guionista ${t.director + 500}`, department: 'Writing', jobs: [{ job: 'Writer' }], total_episode_count: 8 }] } : undefined,
          recommendations: { results: related.slice(0, 5) }, similar: { results: related.slice(5) },
          'watch/providers': providersPayload(t),
        },
      };
    }
    return { status: 404, body: {} };
  };
}

/** Adaptador a la firma de fetch */
export function fakeFetch(catalog: FakeTitle[], opts: FakeOptions = {}) {
  const h = fakeTmdbHandler(catalog, opts);
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const { status, body } = await h(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return Object.assign(f, { calls });
}
