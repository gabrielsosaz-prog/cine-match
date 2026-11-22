import Dexie, { type Table } from 'dexie';
import { migrateRating } from './migrations';
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
    // v2: marca de visto independiente (watched) + lista de seguimiento (list). Migra sin perder datos.
    this.version(2)
      .stores({ ratings: 'id, profileId, key, updatedAt, [profileId+list]' })
      .upgrade((tx) => tx.table('ratings').toCollection().modify((r: any, ref: { value: unknown }) => { ref.value = migrateRating(r); }));
    // v3 (Cine Match v2.1): aspectos en estrellas 1-5 con respaldo de las notas 1-10, «No me interesa» propio
    // y comentario «Otros». Mismos índices; la migración es idempotente y no borra registros.
    this.version(3)
      .stores({ ratings: 'id, profileId, key, updatedAt, [profileId+list]' })
      .upgrade((tx) => tx.table('ratings').toCollection().modify((r: any, ref: { value: unknown }) => { ref.value = migrateRating(r); }));
    // Otra instancia de la app (p. ej. tras actualizarse la PWA) necesita una versión nueva de la base:
    // se avisa para recargar en vez de quedar con una conexión cerrada a mitad de un guardado.
    this.on('versionchange', () => { emitDbEvent('versionchange'); });
    this.on('blocked', () => { emitDbEvent('blocked'); });
  }
}

export type DbEvent = 'versionchange' | 'blocked';
const dbListeners = new Set<(e: DbEvent) => void>();
export function onDbEvent(fn: (e: DbEvent) => void) { dbListeners.add(fn); return () => { dbListeners.delete(fn); }; }
function emitDbEvent(e: DbEvent) { for (const fn of dbListeners) fn(e); }

export let db = new CineDB();

/** Sólo para pruebas: usar una base aislada */
export function useTestDb(name: string) {
  db = new CineDB(name);
  return db;
}
