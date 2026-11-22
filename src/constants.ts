import type { DimensionId, ListStatus, PlatformId } from './types';

/** Los siete aspectos, en el orden en que se muestran. Se puntúan con 1 a 5 estrellas. */
export const DIMENSIONS: { id: DimensionId; label: string; short: string }[] = [
  { id: 'story', label: 'Trama y guion', short: 'Guion' },
  { id: 'acting', label: 'Actuaciones', short: 'Actuaciones' },
  { id: 'ending', label: 'Final o desenlace', short: 'Final' },
  { id: 'emotion', label: 'Impacto emocional', short: 'Emoción' },
  { id: 'visuals', label: 'Dirección y calidad visual', short: 'Dirección' },
  { id: 'pacing', label: 'Ritmo narrativo', short: 'Ritmo' },
  { id: 'suspense', label: 'Suspenso o intriga', short: 'Suspenso' },
];
export const STAR_MAX = 5;
/** Aspectos retirados en la v2.1 (sus datos se conservan en `legacy.dimensions10`) */
export const RETIRED_DIMENSIONS: Record<string, string> = { characters: 'Personajes', originality: 'Originalidad' };
export const COMMENT_MAX = 500;

export const LIST_LABELS: Record<ListStatus, string> = {
  want: 'Quiero verla',
  watching: 'Viéndola',
  abandoned: 'Abandonada',
};
export const NOT_INTERESTED_LABEL = 'No me interesa';

export const PLATFORMS: { id: PlatformId; label: string; color: string; match: RegExp; tmdbIds: number[] }[] = [
  { id: 'netflix', label: 'Netflix', color: '#e50914', match: /^netflix/i, tmdbIds: [8, 1796] },
  { id: 'prime', label: 'Prime Video', color: '#00a8e1', match: /^amazon prime video|^prime video/i, tmdbIds: [119, 9] },
  { id: 'disney', label: 'Disney+', color: '#1f6feb', match: /^disney ?(\+|plus)/i, tmdbIds: [337] },
  { id: 'max', label: 'Max (HBO)', color: '#7b2ff7', match: /^(hbo )?max$|^hbo max/i, tmdbIds: [1899, 384] },
  // v3.1: Paramount+ (proveedor 531 de TMDB, verificado en Argentina). No incluye «Paramount Network» ni el canal
  // de Amazon («Paramount+ Amazon Channel», que se contrata dentro de Prime Video y se informa aparte).
  { id: 'paramount', label: 'Paramount+', color: '#0064ff', match: /^paramount ?(\+|plus)/i, tmdbIds: [531] },
];

export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'AR', name: 'Argentina' }, { code: 'UY', name: 'Uruguay' }, { code: 'CL', name: 'Chile' },
  { code: 'PY', name: 'Paraguay' }, { code: 'BO', name: 'Bolivia' }, { code: 'PE', name: 'Perú' },
  { code: 'CO', name: 'Colombia' }, { code: 'MX', name: 'México' }, { code: 'BR', name: 'Brasil' },
  { code: 'ES', name: 'España' }, { code: 'US', name: 'Estados Unidos' },
];

export const ABANDON_REASONS = [
  'Ritmo muy lento', 'Perdió calidad', 'No me atrapó la historia', 'Personajes poco interesantes',
  'Demasiado violenta o intensa', 'Muy predecible', 'Falta de tiempo', 'Otro',
];

/** Tiempo tras el cual la disponibilidad se considera desactualizada */
export const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const AVAILABILITY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const METADATA_TTL_MS = 14 * 24 * 60 * 60 * 1000;
