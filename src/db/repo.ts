import { db } from './db';
import type {
  AppConfig, DimensionScores, ListStatus, Profile, ProfileSettings, Rating, TitleKey,
} from '../types';
import { cleanDimensions, hasScore, migrateRating } from './migrations';

export const DEFAULT_PROFILE_ID = 'p-principal';

export function defaultSettings(profileId: string): ProfileSettings {
  return {
    profileId,
    country: 'AR',
    platforms: ['netflix', 'prime', 'disney', 'max'],
    language: 'es-MX',
    excludedGenres: [],
    includeUnconfirmed: false,
    dimensionWeights: {},
    onboarded: false,
  };
}

/** Crea el perfil principal y la configuración si no existen. */
export async function ensureBootstrap(): Promise<AppConfig> {
  return db.transaction('rw', db.config, db.profiles, db.settings, async () => {
    let cfg = await db.config.get('app');
    if (!cfg) {
      cfg = { id: 'app', activeProfileId: DEFAULT_PROFILE_ID };
      await db.config.put(cfg);
    }
    if (!(await db.profiles.get(cfg.activeProfileId))) {
      await db.profiles.put({ id: cfg.activeProfileId, name: 'Principal', createdAt: Date.now() });
    }
    if (!(await db.settings.get(cfg.activeProfileId))) {
      await db.settings.put(defaultSettings(cfg.activeProfileId));
    }
    return cfg;
  });
}

export async function getConfig(): Promise<AppConfig> {
  return (await db.config.get('app')) ?? (await ensureBootstrap());
}

export async function updateConfig(patch: Partial<AppConfig>) {
  const cfg = await getConfig();
  await db.config.put({ ...cfg, ...patch, id: 'app' });
}

export async function getSettings(profileId: string): Promise<ProfileSettings> {
  return (await db.settings.get(profileId)) ?? defaultSettings(profileId);
}

export async function updateSettings(profileId: string, patch: Partial<ProfileSettings>) {
  const s = await getSettings(profileId);
  await db.settings.put({ ...s, ...patch, profileId });
}

export async function createProfile(name: string): Promise<Profile> {
  const p: Profile = { id: `p-${Date.now().toString(36)}`, name: name.trim() || 'Perfil', createdAt: Date.now() };
  await db.profiles.put(p);
  await db.settings.put(defaultSettings(p.id));
  return p;
}

const clampScore = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(10, Math.max(1, Math.round(v * 2) / 2));
};

/**
 * Cambios parciales sobre el registro de un título. Lo que no se envía, no se toca:
 * así marcar «vista» no altera la puntuación y puntuar no marca «vista».
 * `null` borra el valor.
 */
export interface RatingPatch {
  watched?: boolean;
  list?: ListStatus | null;
  overall?: number | null;
  dimensions?: DimensionScores; // reemplaza el conjunto de aspectos
  abandonReason?: string | null;
}

/** Guarda o modifica. Si el registro queda vacío (no vista, sin lista ni notas) se elimina. */
export async function saveRating(profileId: string, key: TitleKey, patch: RatingPatch): Promise<Rating | undefined> {
  const id = `${profileId}|${key}`;
  const prevRaw = await db.ratings.get(id);
  const prev = prevRaw ? migrateRating(prevRaw) : undefined;
  const now = Date.now();
  const next: Rating = prev ? { ...prev } : { id, profileId, key, watched: false, dimensions: {}, createdAt: now, updatedAt: now, schema: 2 };
  if (patch.watched !== undefined) {
    if (patch.watched && !next.watched) next.watchedAt = now;
    if (!patch.watched) next.watchedAt = undefined;
    next.watched = patch.watched;
  }
  if (patch.list !== undefined) next.list = patch.list ?? undefined;
  if (patch.overall !== undefined) next.overall = patch.overall === null ? undefined : clampScore(patch.overall);
  if (patch.dimensions !== undefined) next.dimensions = cleanDimensions(patch.dimensions);
  if (patch.abandonReason !== undefined) next.abandonReason = patch.abandonReason ?? undefined;
  if (next.list !== 'abandoned') next.abandonReason = undefined;
  next.updatedAt = now;
  if (!next.watched && !next.list && !hasScore(next)) {
    await db.ratings.delete(id);
    return undefined;
  }
  await db.ratings.put(next);
  return next;
}

export async function deleteRating(profileId: string, key: TitleKey) {
  await db.ratings.delete(`${profileId}|${key}`);
}

export async function listRatings(profileId: string): Promise<Rating[]> {
  return (await db.ratings.where('profileId').equals(profileId).toArray()).map(migrateRating);
}
