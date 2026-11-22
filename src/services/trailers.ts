import type { VideoInfo } from '../providers/tmdb';
import type { TitleKey } from '../types';
import { parseKey } from '../types';
import { getClient as getTmdbClient } from './catalog';

/**
 * Tráileres (v3.2). Fuente: vídeos que TMDB lista para el título, que enlazan a YouTube o Vimeo. No se descarga ni
 * se redistribuye nada: se usa el reproductor embebido del sitio.
 *
 * Qué se puede verificar: TMDB informa el idioma del vídeo (iso_639_1: el idioma del audio o de la ficha, NO de los
 * subtítulos), si es oficial y su título. Ni TMDB ni el reproductor de YouTube informan qué pistas de subtítulos
 * tiene un vídeo (la API de datos de YouTube lo permitiría con una clave, que no se usa). Por eso «subtítulos en
 * español» sólo se afirma cuando el TÍTULO publicado del vídeo lo dice (p. ej. «Tráiler subtitulado»), y se aclara.
 *
 * Prioridad:
 *  1. Tráiler oficial con audio en español (idioma es y sin indicación de subtítulos).
 *  2. Tráiler oficial con subtítulos en español indicados en su título.
 *  3. Tráiler en español (doblado o subtitulado) listado en TMDB pero no marcado como oficial.
 *  4. Tráiler oficial en el idioma original (subtítulos no confirmados; se pide a YouTube mostrar los de español
 *     si existen).
 *  5. Otro vídeo oficial (teaser, clip…).
 * Si lo mejor disponible es 4 o 5 (o nada), se ofrece «Buscar tráiler subtitulado en YouTube»: abre una búsqueda,
 * nunca un vídeo no verificado.
 */
export interface TrailerChoice {
  video: VideoInfo;
  rank: 1 | 2 | 3 | 4 | 5;
  /** descripción honesta del idioma, para mostrar */
  audio: string;
  /** subtítulos en español indicados por el título del vídeo */
  subsEs: boolean;
  embedUrl: string;
  watchUrl: string;
}

const SUBS = /subtitulad|subtítulos|subtitulos|\bsub(s)?\b|\bsub\.? ?esp|vose|\bv\.?o\.?s\.?e?\b|legendado/i;
const DUB = /doblad|latino|castellano|español|espanol/i;
const TYPE_ES: Record<string, string> = { Trailer: 'tráiler', Teaser: 'avance (teaser)', Clip: 'clip', Featurette: 'featurette', 'Opening Credits': 'apertura', 'Behind the Scenes': 'detrás de escena', Bloopers: 'tomas falsas' };
const LANG_ES: Record<string, string> = { en: 'inglés', es: 'español', ko: 'coreano', ja: 'japonés', fr: 'francés', de: 'alemán', it: 'italiano', pt: 'portugués', sv: 'sueco', nl: 'neerlandés', da: 'danés', no: 'noruego', tr: 'turco', hi: 'hindi', zh: 'chino' };
/** ¿El título del vídeo dice que tiene subtítulos EN ESPAÑOL? («legendado» es portugués: no cuenta) */
const subsInSpanish = (v: VideoInfo) => SUBS.test(v.name) && !/legendado/i.test(v.name) && (v.language === 'es' || /espa(ñ|n)ol|castellano|latino|\bsub\.? ?esp|subtitulad/i.test(v.name));

export function rankTrailers(videos: VideoInfo[], originalLanguage?: string, country = 'AR'): TrailerChoice[] {
  const regionScore = (v: VideoInfo) => (v.region === country ? 3 : ['MX', 'AR', 'CO', 'CL', 'US'].includes(v.region ?? '') ? 2 : v.region === 'ES' ? 1 : 0) + (v.size ?? 0) / 10000;
  const byRegion = (a: VideoInfo, b: VideoInfo) => regionScore(b) - regionScore(a) || String(b.publishedAt).localeCompare(String(a.publishedAt));
  const pick = (v: VideoInfo, rank: TrailerChoice['rank'], audio: string, subsEs = false): TrailerChoice => ({
    video: v, rank, audio, subsEs,
    embedUrl: v.site === 'YouTube'
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.key)}?autoplay=1&rel=0&playsinline=1&hl=es&cc_lang_pref=es${rank >= 4 ? '&cc_load_policy=1' : ''}`
      : `https://player.vimeo.com/video/${encodeURIComponent(v.key)}?autoplay=1`,
    watchUrl: v.site === 'YouTube' ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.key)}` : `https://vimeo.com/${encodeURIComponent(v.key)}`,
  });
  const out: TrailerChoice[] = [];
  const seen = new Set<string>();
  const push = (c: TrailerChoice) => { if (!seen.has(c.video.key)) { seen.add(c.video.key); out.push(c); } };
  const trailers = videos.filter((v) => v.type === 'Trailer').sort(byRegion);
  const official = trailers.filter((v) => v.official);
  for (const v of official) if (v.language === 'es' && !SUBS.test(v.name)) push(pick(v, 1, DUB.test(v.name) ? 'Audio en español (oficial)' : 'En español según TMDB (oficial)'));
  for (const v of official) if (subsInSpanish(v)) push(pick(v, 2, 'Subtítulos en español indicados en el título del vídeo (oficial)', true));
  for (const v of trailers) if (!v.official && (v.language === 'es' || subsInSpanish(v))) {
    const subs = subsInSpanish(v);
    push(pick(v, 3, subs ? 'Subtítulos en español indicados en el título del vídeo (listado en TMDB, no marcado como oficial)' : 'En español según TMDB (listado en TMDB, no marcado como oficial)', subs));
  }
  const origFirst = (a: VideoInfo, b: VideoInfo) => (b.language === originalLanguage ? 1 : 0) - (a.language === originalLanguage ? 1 : 0) || (b.language === 'en' ? 1 : 0) - (a.language === 'en' ? 1 : 0) || byRegion(a, b);
  for (const v of [...official].sort(origFirst)) push(pick(v, 4, `En ${LANG_ES[v.language ?? ''] ?? 'idioma original'} (oficial); subtítulos en español no confirmados`));
  const others = videos.filter((v) => v.official && v.type !== 'Trailer' && ['Teaser', 'Clip', 'Featurette'].includes(v.type))
    .sort((a, b) => (b.language === 'es' ? 1 : 0) - (a.language === 'es' ? 1 : 0) || (a.type === 'Teaser' ? -1 : 0) - (b.type === 'Teaser' ? -1 : 0) || byRegion(a, b));
  for (const v of others.slice(0, 3)) push(pick(v, 5, `${TYPE_ES[v.type] ?? v.type} oficial${v.language ? ` en ${LANG_ES[v.language] ?? v.language}` : ''} (no es el tráiler)`));
  return out;
}

export function chooseTrailer(videos: VideoInfo[], originalLanguage?: string, country = 'AR'): TrailerChoice | undefined {
  return rankTrailers(videos, originalLanguage, country)[0];
}

/** Búsqueda de YouTube (no abre ningún vídeo): «<título> <año> tráiler subtitulado español». */
export function youtubeSearchUrl(title: string, year?: number): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title}${year ? ` ${year}` : ''} tráiler subtitulado español`)}`;
}
/** ¿Conviene ofrecer la búsqueda externa? Cuando no hay una versión en español ni con subtítulos indicados. */
export const needsExternalSearch = (list: TrailerChoice[]) => !list.some((c) => c.rank <= 3);

const cache = new Map<TitleKey, { at: number; v: TrailerChoice[] }>();
export async function findTrailers(key: TitleKey, originalLanguage?: string, country?: string): Promise<TrailerChoice[]> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.v;
  const { type, id } = parseKey(key);
  const client = await getTmdbClient();
  const v = rankTrailers(await client.videos(type, id, originalLanguage), originalLanguage, country);
  cache.set(key, { at: Date.now(), v });
  return v;
}
export async function findTrailer(key: TitleKey, originalLanguage?: string, country?: string): Promise<TrailerChoice | undefined> {
  return (await findTrailers(key, originalLanguage, country))[0];
}
