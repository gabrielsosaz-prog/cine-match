import { db } from '../db/db';
import { migrateRating } from '../db/migrations';

export const EXPORT_FORMAT = 'cine-match-export/3';
/** Formatos que se pueden importar (las exportaciones v1 se migran al importar) */
export const IMPORT_FORMATS = ['cine-match-export/1', 'cine-match-export/2', 'cine-match-export/3'];

/** Exporta datos personales (no incluye la clave de TMDB). */
export async function exportData() {
  const [profiles, settings, ratings, snapshots, logs] = await Promise.all([
    db.profiles.toArray(), db.settings.toArray(), db.ratings.toArray().then((rs) => rs.map(migrateRating)), db.snapshots.toArray(), db.logs.toArray(),
  ]);
  const titles = await db.titles.bulkGet([...new Set(ratings.map((r) => r.key))]);
  return { format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), profiles, settings, ratings, snapshots, logs, titles: titles.filter(Boolean) };
}

export async function importData(json: unknown): Promise<{ ratings: number }> {
  const d = json as any;
  if (!d || !IMPORT_FORMATS.includes(d.format) || !Array.isArray(d.ratings)) throw new Error('El archivo no es una exportación válida de Cine Match.');
  const valid = (d.ratings as any[]).filter((r) => r && typeof r.id === 'string' && /^(movie|tv):\d+$/.test(r.key) && typeof r.profileId === 'string').map(migrateRating);
  await db.transaction('rw', [db.profiles, db.settings, db.ratings, db.titles, db.snapshots], async () => {
    if (Array.isArray(d.profiles)) await db.profiles.bulkPut(d.profiles);
    if (Array.isArray(d.settings)) await db.settings.bulkPut(d.settings);
    if (Array.isArray(d.titles)) await db.titles.bulkPut(d.titles);
    if (Array.isArray(d.snapshots)) await db.snapshots.bulkPut(d.snapshots.map(({ id: _id, ...s }: any) => s));
    await db.ratings.bulkPut(valid);
  });
  return { ratings: valid.length };
}

/** Elimina todos los datos personales y la caché del dispositivo. */
export async function deleteAllData() {
  await Promise.all(db.tables.map((t) => t.clear()));
}
