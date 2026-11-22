import { beforeEach, describe, expect, it } from 'vitest';
import { CineDB, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, saveRating } from '../../src/db/repo';
import { deleteAllData, exportData, importData } from '../../src/services/dataPortability';

let n = 0;
beforeEach(async () => { useTestDb(`persist-${n++}`); await ensureBootstrap(); });
const P = 'p-principal';

describe('Persistencia de valoraciones', () => {
  it('guarda, modifica y conserva fecha de creación', async () => {
    const a = await saveRating(P, 'movie:1', { status: 'rated', overall: 8, dimensions: { story: 9 } });
    await new Promise((r) => setTimeout(r, 5));
    const b = await saveRating(P, 'movie:1', { status: 'rated', overall: 6, dimensions: { story: 7, ending: 4 } });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    const all = await listRatings(P);
    expect(all).toHaveLength(1);
    expect(all[0].overall).toBe(6);
    expect(all[0].dimensions).toEqual({ story: 7, ending: 4 });
  });
  it('dimensiones opcionales y general independiente', async () => {
    const r = await saveRating(P, 'tv:2', { status: 'rated', dimensions: { suspense: 10 } });
    expect(r.overall).toBeUndefined();
    expect(r.status).toBe('rated');
    const g = await saveRating(P, 'tv:3', { status: 'rated', overall: 3, dimensions: { visuals: 10, story: 10 } });
    expect(g.overall).toBe(3); // no se reemplaza por la media de aspectos
  });
  it('normaliza valores fuera de rango y deduce el estado', async () => {
    const r = await saveRating(P, 'movie:4', { status: 'watched', overall: 14, dimensions: { pacing: -2, story: NaN as any } });
    expect(r.overall).toBe(10);
    expect(r.dimensions).toEqual({ pacing: 1 });
    expect(r.status).toBe('rated');
    const w = await saveRating(P, 'movie:5', { status: 'rated' });
    expect(w.status).toBe('watched');
  });
  it('guarda motivo de abandono sólo para abandonadas', async () => {
    const a = await saveRating(P, 'tv:6', { status: 'abandoned', abandonReason: 'Ritmo muy lento' });
    expect(a.abandonReason).toBe('Ritmo muy lento');
    const b = await saveRating(P, 'tv:6', { status: 'watching', abandonReason: 'x' });
    expect(b.abandonReason).toBeUndefined();
  });
  it('los datos sobreviven a reabrir la base (entre sesiones)', async () => {
    const dbName = `reopen-${Date.now()}`;
    useTestDb(dbName); await ensureBootstrap();
    await saveRating(P, 'movie:77', { status: 'rated', overall: 9 });
    const reopened = new CineDB(dbName);
    expect((await reopened.ratings.get(`${P}|movie:77`))?.overall).toBe(9);
    reopened.close();
  });
  it('separa valoraciones por perfil', async () => {
    await saveRating(P, 'movie:1', { status: 'rated', overall: 9 });
    await saveRating('p-otro', 'movie:1', { status: 'rated', overall: 2 });
    expect((await listRatings(P))[0].overall).toBe(9);
    expect((await listRatings('p-otro'))[0].overall).toBe(2);
  });
});

describe('Exportación, importación y borrado', () => {
  it('exporta sin la clave e importa en una base limpia', async () => {
    const { updateConfig } = await import('../../src/db/repo');
    await updateConfig({ tmdbToken: 'secreto' });
    await saveRating(P, 'movie:1', { status: 'rated', overall: 9 });
    const data = await exportData();
    expect(JSON.stringify(data)).not.toContain('secreto');
    await deleteAllData();
    expect(await listRatings(P)).toHaveLength(0);
    const r = await importData(JSON.parse(JSON.stringify(data)));
    expect(r.ratings).toBe(1);
    expect((await listRatings(P))[0].overall).toBe(9);
  });
  it('rechaza archivos inválidos', async () => {
    await expect(importData({ foo: 1 })).rejects.toThrow();
  });
});
