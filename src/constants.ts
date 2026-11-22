import type { DimensionId, PlatformId, WatchStatus } from './types';

export const DIMENSIONS: { id: DimensionId; label: string; short: string }[] = [
  { id: 'story', label: 'Historia y guion', short: 'Guion' },
  { id: 'characters', label: 'Desarrollo de personajes', short: 'Personajes' },
  { id: 'pacing', label: 'Ritmo narrativo', short: 'Ritmo' },
  { id: 'suspense', label: 'Suspenso e intriga', short: 'Suspenso' },
  { id: 'originality', label: 'Originalidad', short: 'Originalidad' },
  { id: 'emotion', label: 'Impacto emocional', short: 'Emoción' },
  { id: 'visuals', label: 'Calidad visual y dirección', short: 'Visual' },
  { id: 'ending', label: 'Final o desenlace', short: 'Final' },
];

export const STATUS_LABELS: Record<WatchStatus, string> = {
  rated: 'Vista y puntuada',
  watched: 'Vista sin puntuar',
  want: 'Quiero verla',
  watching: 'Viéndola',
  abandoned: 'Abandonada',
  not_interested: 'No me interesa',
};

export const PLATFORMS: { id: PlatformId; label: string; color: string; match: RegExp; tmdbIds: number[] }[] = [
  { id: 'netflix', label: 'Netflix', color: '#e50914', match: /^netflix/i, tmdbIds: [8, 1796] },
  { id: 'prime', label: 'Prime Video', color: '#00a8e1', match: /^amazon prime video|^prime video/i, tmdbIds: [119, 9] },
  { id: 'disney', label: 'Disney+', color: '#1f6feb', match: /^disney ?(\+|plus)/i, tmdbIds: [337] },
  { id: 'max', label: 'Max (HBO)', color: '#7b2ff7', match: /^(hbo )?max$|^hbo max/i, tmdbIds: [1899, 384] },
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
