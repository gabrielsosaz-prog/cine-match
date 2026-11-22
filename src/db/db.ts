import Dexie, { type Table } from 'dexie';
import type {
  ActivityLog, AppConfig, AvailabilityEvent, AvailabilitySnapshot, Profile, ProfileSettings,
  ProfileSnapshot, Rating, RecommendationRun, TitleMeta,
} from '../types';

/**
 * Persistencia local (IndexedDB). Se eligió frente a SQLite/PostgreSQL porque la v1 es de un único
 * usuario, debe funcionar sin servidor, sin costo y offline, y el mismo código sirve dentro de una APK
 * de Capacitor. Las tablas ya distinguen perfiles (profileId) para multiusuario.
 */
export class CineDB extends Dexie {
  titles!: Table<TitleMeta, string>;
  availability!: Table<AvailabilitySnapshot, string>;
  availabilityEvents!: Table<AvailabilityEvent, number>;
  ratings!: Table<Rating, string>;
  profiles!: Table<Profile, string>;
  settings!: Table<ProfileSettings, string>;
  config!: Table<AppConfig, string>;
  runs!: Table<RecommendationRun, number>;
  snapshots!: Table<ProfileSnapshot, number>;
  logs!: Table<ActivityLog, number>;

  constructor(name = 'cine-match') {
    super(name);
    this.version(1).stores({
      titles: 'key, type, fetchedAt',
      availability: 'id, key, country, checkedAt',
      availabilityEvents: '++id, key, country, detectedAt',
      ratings: 'id, profileId, key, status, updatedAt, [profileId+status]',
      profiles: 'id',
      settings: 'profileId',
      config: 'id',
      runs: '++id, profileId, createdAt',
      snapshots: '++id, profileId, at',
      logs: '++id, profileId, at, type',
    });
  }
}

export let db = new CineDB();

/** Sólo para pruebas: usar una base aislada */
export function useTestDb(name: string) {
  db = new CineDB(name);
  return db;
}
