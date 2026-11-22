import type { VideoInfo } from '../providers/tmdb';
import type { TitleKey } from '../types';
import { parseKey } from '../types';
import { getClient as getTmdbClient } from './catalog';

/**
 * Tráileres (v3.1). Fuente: vídeos de TMDB, que enlazan a los reproductores oficiales de YouTube o Vimeo.
 * No se descarga ni se redistribuye ningún vídeo: se usa el reproductor embebido del sitio.
 * Prioridad: 1) tráiler oficial con audio en español; 2) tráiler oficial con subtítulos en español (según el título
 * publicado en TMDB, p. ej. «[Subtitulado]»); 3) tráiler oficial en el idioma original; 4) otro avance oficial
 * (teaser, clip…), identificado por su tipo. Nunca se afirma que hay subtítulos si la fuente no lo dice.
 */
export interface TrailerChoice {
  video: VideoInfo;
  rank: 1 | 2 | 3 | 4;
  /** descripción honesta del idioma, para mostrar */
  audio: string;
  embedUrl: string;
  watchUrl: string;
}

const SUBS = /subtitulad|subtítulos|subtitulos|\bsub\b|subs\b|vose|\bv\.?o\.?s\b|legendado/i;
const DUB = /doblad|latino|castellano|español|espanol|en español/i;
const TYPE_ES: Record<string, string> = { Trailer: 'tráiler', Teaser: 'avance (teaser)', Clip: 'clip', Featurette: 'featurette', 'Opening Credits': 'apertura', 'Behind the Scenes': 'detrás de escena', Bloopers: 'tomas falsas' };
const LANG_ES: Record<string, string> = { en: 'inglés', es: 'español', ko: 'coreano', ja: 'japonés', fr: 'francés', de: 'alemán', it: 'italiano', pt: 'portugués', sv: 'sueco', nl: 'neerlandés', da: 'danés', no: 'noruego', tr: 'turco' };

export function chooseTrailer(videos: VideoInfo[], originalLanguage?: string, country = 'AR'): TrailerChoice | undefined {
  const official = videos.filter((v) => v.official);
  const latamFirst = (a: VideoInfo, b: VideoInfo) => {
    const score = (v: VideoInfo) => (v.region === country ? 3 : ['MX', 'AR', 'CO', 'CL', 'US'].includes(v.region ?? '') ? 2 : v.region === 'ES' ? 1 : 0) + (v.size ?? 0) / 10000;
    return score(b) - score(a) || String(b.publishedAt).localeCompare(String(a.publishedAt));
  };
  const trailers = official.filter((v) => v.type === 'Trailer');
  const es = trailers.filter((v) => v.language === 'es').sort(latamFirst);
  const dubbed = es.filter((v) => !SUBS.test(v.name));
  const subbed = es.filter((v) => SUBS.test(v.name));
  const pick = (v: VideoInfo, rank: TrailerChoice['rank'], audio: string): TrailerChoice => ({
    video: v, rank, audio,
    embedUrl: v.site === 'YouTube'
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.key)}?autoplay=1&rel=0&playsinline=1&hl=es&cc_lang_pref=es${rank >= 3 ? '&cc_load_policy=1' : ''}`
      : `https://player.vimeo.com/video/${encodeURIComponent(v.key)}?autoplay=1`,
    watchUrl: v.site === 'YouTube' ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.key)}` : `https://vimeo.com/${encodeURIComponent(v.key)}`,
  });
  if (dubbed[0]) return pick(dubbed[0], 1, DUB.test(dubbed[0].name) ? 'Audio en español' : 'En español (según TMDB)');
  if (subbed[0]) return pick(subbed[0], 2, 'Idioma original con subtítulos en español');
  const orig = trailers.filter((v) => v.language && v.language === originalLanguage).sort(latamFirst)[0] ?? trailers.filter((v) => v.language === 'en').sort(latamFirst)[0] ?? trailers[0];
  if (orig) return pick(orig, 3, `En ${LANG_ES[orig.language ?? ''] ?? 'idioma original'}; los subtítulos en español dependen de YouTube y no están confirmados`);
  const other = official.filter((v) => v.type !== 'Trailer').sort((a, b) => (a.language === 'es' ? -1 : 0) - (b.language === 'es' ? -1 : 0) || latamFirst(a, b))[0];
  if (other) return pick(other, 4, `${TYPE_ES[other.type] ?? other.type} oficial${other.language ? ` en ${LANG_ES[other.language] ?? other.language}` : ''} (no es el tráiler)`);
  return undefined;
}

const cache = new Map<TitleKey, { at: number; v?: TrailerChoice }>();
export async function findTrailer(key: TitleKey, originalLanguage?: string, country?: string): Promise<TrailerChoice | undefined> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.v;
  const { type, id } = parseKey(key);
  const client = await getTmdbClient();
  const v = chooseTrailer(await client.videos(type, id, originalLanguage), originalLanguage, country);
  cache.set(key, { at: Date.now(), v });
  return v;
}
