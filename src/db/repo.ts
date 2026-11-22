import { db } from './db';
import type {
  AppConfig, DimensionScores, Profile, ProfileSettings, Rating, TitleKey, WatchStatus,
} from '../types';

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

export interface RatingInput {
  status: WatchStatus;
  overall?: number;
  dimensions?: DimensionScores;
  abandonReason?: string;
}

/** Guarda o modifica una valoración. Normaliza valores y deduce el estado "puntuada". */
export async function saveRating(profileId: string, key: TitleKey, input: RatingInput): Promise<Rating> {
  const id = `${profileId}|${key}`;
  const prev = await db.ratings.get(id);
  const dims: DimensionScores = {};
  for (const [d, v] of Object.entries(input.dimensions ?? {})) {
    const c = clampScore(v);
    if (c !== undefined) dims[d as keyof DimensionScores] = c;
  }
  const overall = clampScore(input.overall);
  let status = input.status;
  const hasScore = overall !== undefined || Object.keys(dims).length > 0;
  if (status === 'watched' && hasScore) status = 'rated';
  if (status === 'rated' && !hasScore) status = 'watched';
  const now = Date.now();
  const rating: Rating = {
    id, profileId, key, status,
    overall, dimensions: dims,
    abandonReason: status === 'abandoned' ? input.abandonReason : undefined,
    seasons: prev?.seasons,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await db.ratings.put(rating);
  return rating;
}

export async function deleteRating(profileId: string, key: TitleKey) {
  await db.ratings.delete(`${profileId}|${key}`);
}

export async function listRatings(profileId: string): Promise<Rating[]> {
  return db.ratings.where('profileId').equals(profileId).toArray();
}
