/**
 * v3.4 · Perfiles sintéticos explícitos para evaluar recomendaciones.
 *
 * Cada perfil define, con reglas escritas ANTES de mirar resultados, qué títulos le gustan (grado 2 = muy relevante,
 * 1 = relevante) y cuáles rechaza, usando SÓLO clasificaciones editoriales externas: categorías de Wikipedia en
 * inglés y afirmaciones de Wikidata (género, tema, candidaturas y premios). El motor no usa esas fuentes.
 * Las valoraciones del perfil se toman de títulos de «desarrollo» que cumplen esas reglas; la relevancia se juzga
 * en títulos de «evaluación final». Los perfiles prueban comportamientos esperados; no son usuarios reales.
 */
import type { CatalogTitle } from '../../src/engine/narrative';
import type { TitleKey } from '../../src/types';

export interface Ref { cats: string[]; genre: string[]; subject: string[]; audience: string[]; nominated: string[]; awards: string[]; hasWiki: boolean }
export interface EvalProfile {
  id: string; name: string; description: string;
  grade: (r: Ref, t: CatalogTitle) => 0 | 1 | 2;
  reject: (r: Ref, t: CatalogTitle) => boolean;
  likes: number; dislikes: number; neutral?: number; seedGrade?: 1 | 2;
  /** valoraciones adicionales (p. ej. contradictorias) */
  extra?: (dev: { k: TitleKey; ref?: Ref }[], r: () => number) => [TitleKey, number][];
}

const any = (xs: string[], re: RegExp) => xs.some((x) => re.test(x));
const cat = (r: Ref, re: RegExp) => any(r.cats, re);
const gen = (r: Ref, re: RegExp) => any(r.genre, re);
const CHILD = /children's|preschool/;
const ROMCOM = /romantic comedy/;
const WRITING = /screenplay|screenwriter|best writing|outstanding writing|writers guild/;
const RAZZIE = /golden raspberry/;

export const PROFILES: EvalProfile[] = [
  {
    id: 'p1-scifi-tiempo', name: 'Ciencia ficción compleja y viajes temporales',
    description: 'Le encantan las historias de viajes en el tiempo; le gusta la ciencia ficción en general; rechaza comedias románticas y obras infantiles.',
    grade: (r) => (cat(r, /time travel/) || any(r.subject, /time travel/) ? 2 : (gen(r, /science fiction/) || cat(r, /science fiction (films|television)/)) && !cat(r, CHILD) ? 1 : 0),
    reject: (r) => cat(r, ROMCOM) || gen(r, ROMCOM) || cat(r, CHILD) || gen(r, /children's/),
    likes: 15, dislikes: 6, neutral: 6,
  },
  {
    id: 'p2-thriller-psicologico', name: 'Thrillers psicológicos y misterio',
    description: 'Prefiere thrillers psicológicos; le gustan misterio y neo-noir; rechaza comedias románticas, sitcoms e infantiles.',
    grade: (r) => (cat(r, /psychological thriller/) || gen(r, /psychological thriller/) ? 2 : cat(r, /mystery|neo-noir/) || gen(r, /mystery|neo-noir|thriller/) ? 1 : 0),
    reject: (r) => cat(r, ROMCOM) || gen(r, /romantic comedy|sitcom/) || cat(r, CHILD),
    likes: 15, dislikes: 6, neutral: 6,
  },
  {
    id: 'p3-calidad-narrativa', name: 'Calidad narrativa por encima del género',
    description: 'Le gustan obras premiadas o candidatas por su guion (Óscar, BAFTA, Globo de Oro, WGA, Emmy de guion…), de cualquier género; rechaza obras candidatas a los Razzie.',
    grade: (r) => (any([...r.nominated, ...r.awards], WRITING) || cat(r, /whose writer won/) ? 2 : 0),
    reject: (r) => any([...r.nominated, ...r.awards], RAZZIE),
    likes: 20, dislikes: 8, neutral: 6,
  },
  {
    id: 'p4-poco-conocidas', name: 'Producciones poco conocidas',
    description: 'Busca obras poco votadas (cuartil inferior de votos en TMDB) con reconocimiento editorial (premio, candidatura, cine independiente o ópera prima); rechaza superhéroes.',
    grade: (r, t) => (t.votes <= LOW_VOTES && (r.nominated.length > 0 || r.awards.length > 0 || cat(r, /independent films|directorial debut|festival/)) ? 2 : t.votes <= LOW_VOTES && r.hasWiki && !cat(r, CHILD) ? 1 : 0),
    reject: (r) => gen(r, /superhero/) || cat(r, /superhero/),
    likes: 15, dislikes: 6, neutral: 6,
  },
  {
    id: 'p5-variado', name: 'Preferencias variadas',
    description: 'Le gustan tres grupos distintos: viajes en el tiempo, atracos y comedias románticas; rechaza slashers e infantiles.',
    grade: (r) => (cat(r, /time travel|heist/) || gen(r, /heist/) || cat(r, ROMCOM) || gen(r, ROMCOM) ? 2 : 0),
    reject: (r) => cat(r, /slasher/) || gen(r, /slasher/) || cat(r, CHILD),
    likes: 18, dislikes: 6, neutral: 6,
  },
  {
    id: 'p6-especifico', name: 'Gusto muy específico: películas de atracos',
    description: 'Sólo le interesan las historias de atracos; rechaza comedias románticas, musicales e infantiles.',
    grade: (r) => (cat(r, /heist/) || gen(r, /heist/) ? 2 : 0),
    reject: (r) => cat(r, ROMCOM) || gen(r, /musical|romantic comedy/) || cat(r, CHILD),
    likes: 10, dislikes: 6, neutral: 4,
  },
  {
    id: 'p7-usuario-nuevo', name: 'Usuario nuevo (3 valoraciones)',
    description: 'Mismo gusto que el perfil de thrillers psicológicos, pero con sólo 3 valoraciones.',
    grade: (r) => (cat(r, /psychological thriller/) || gen(r, /psychological thriller/) ? 2 : cat(r, /mystery|neo-noir/) || gen(r, /mystery|neo-noir|thriller/) ? 1 : 0),
    reject: (r) => cat(r, ROMCOM) || gen(r, /romantic comedy|sitcom/) || cat(r, CHILD),
    likes: 3, dislikes: 0, neutral: 0,
  },
  {
    id: 'p8-contradictorio', name: 'Muchas valoraciones y gustos contradictorios',
    description: 'Le gusta el terror sobrenatural y psicológico y también las comedias románticas, pero detesta los slashers (también terror); 20 valoraciones más con notas al azar.',
    grade: (r) => (cat(r, /supernatural horror|psychological horror|haunted house|ghost/) || gen(r, /ghost film|supernatural horror/) || cat(r, ROMCOM) || gen(r, ROMCOM) ? (cat(r, /slasher/) || gen(r, /slasher/) ? 0 : 2) : 0),
    reject: (r) => cat(r, /slasher/) || gen(r, /slasher/),
    likes: 30, dislikes: 12, neutral: 0,
    extra: (dev, r) => dev.filter((x) => x.ref && !cat(x.ref, /horror|romantic comedy|slasher/)).sort(() => 0).filter((_, i) => i % 97 === 3).slice(0, 20).map((x) => [x.k, 3 + Math.floor(r() * 7)]),
  },
];
/** Cuartil inferior de votos del catálogo (fijado con el catálogo 2026-11-22). */
export let LOW_VOTES = 0;
export const setLowVotes = (v: number) => { LOW_VOTES = v; };
