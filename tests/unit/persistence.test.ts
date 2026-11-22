import { beforeEach, describe, expect, it } from 'vitest';
import { CineDB, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, saveRating } from '../../src/db/repo';
import { deleteAllData, exportData, importData } from '../../src/services/dataPortability';

let n = 0;
beforeEach(async () => { useTestDb(`persist-${n++}`); await ensureBootstrap(); });
const P = 'p-principal';

describe('Persistencia de valoraciones', () => {
  it('guarda, modifica y conserva fecha de creación', async () => {
    const a = (await saveRating(P, 'movie:1', { overall: 8, dimensions: { story: 4 } }))!;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await saveRating(P, 'movie:1', { overall: 6, dimensions: { story: 3, ending: 2, acting: 5 } }))!;
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    const all = await listRatings(P);
    expect(all).toHaveLength(1);
    expect(all[0].overall).toBe(6);
    expect(all[0].dimensions).toEqual({ story: 3, ending: 2, acting: 5 });
  });
  it('dimensiones opcionales y general independiente', async () => {
    const r = (await saveRating(P, 'tv:2', { dimensions: { suspense: 5 } }))!;
    expect(r.overall).toBeUndefined();
    const g = (await saveRating(P, 'tv:3', { overall: 3, dimensions: { visuals: 5, story: 5, acting: 5 } }))!;
    expect(g.overall).toBe(3); // no se reemplaza por la media de aspectos
    const only = (await saveRating(P, 'tv:4', { overall: 7 }))!;
    expect(only.dimensions).toEqual({});
  });
  it('normaliza valores fuera de rango y descarta aspectos desconocidos o retirados', async () => {
    const r = (await saveRating(P, 'movie:4', { overall: 14, dimensions: { pacing: -2, story: NaN as any, foo: 5, acting: 9, characters: 4 } as any }))!;
    expect(r.overall).toBe(10);
    expect(r.dimensions).toEqual({ pacing: 1, acting: 5 }); // estrellas 1-5
  });
  it('guarda motivo de abandono sólo para abandonadas', async () => {
    const a = (await saveRating(P, 'tv:6', { list: 'abandoned', abandonReason: 'Ritmo muy lento' }))!;
    expect(a.abandonReason).toBe('Ritmo muy lento');
    const b = (await saveRating(P, 'tv:6', { list: 'watching' }))!;
    expect(b.abandonReason).toBeUndefined();
  });
  it('los datos sobreviven a reabrir la base (entre sesiones)', async () => {
    const dbName = `reopen-${Date.now()}`;
    useTestDb(dbName); await ensureBootstrap();
    await saveRating(P, 'movie:77', { overall: 9, watched: true });
    const reopened = new CineDB(dbName);
    const r = await reopened.ratings.get(`${P}|movie:77`);
    expect(r?.overall).toBe(9);
    expect(r?.watched).toBe(true);
    reopened.close();
  });
  it('separa valoraciones por perfil', async () => {
    await saveRating(P, 'movie:1', { overall: 9 });
    await saveRating('p-otro', 'movie:1', { overall: 2 });
    expect((await listRatings(P))[0].overall).toBe(9);
    expect((await listRatings('p-otro'))[0].overall).toBe(2);
  });
});

describe('Visto independiente de la puntuación', () => {
  it('marcar vista sin puntuar', async () => {
    const r = (await saveRating(P, 'movie:10', { watched: true }))!;
    expect(r.watched).toBe(true);
    expect(r.overall).toBeUndefined();
    expect(r.watchedAt).toBeDefined();
  });
  it('puntuar no marca vista', async () => {
    const r = (await saveRating(P, 'movie:11', { overall: 9, dimensions: { suspense: 4 } }))!;
    expect(r.watched).toBe(false);
  });
  it('cambiar el estado de visto no toca la puntuación, y viceversa', async () => {
    await saveRating(P, 'movie:12', { overall: 7, dimensions: { acting: 4 } });
    const w = (await saveRating(P, 'movie:12', { watched: true }))!;
    expect(w).toMatchObject({ watched: true, overall: 7, dimensions: { acting: 4 } });
    const u = (await saveRating(P, 'movie:12', { watched: false }))!;
    expect(u).toMatchObject({ watched: false, overall: 7 });
    const s = (await saveRating(P, 'movie:12', { overall: 4 }))!;
    expect(s.watched).toBe(false);
    const cleared = (await saveRating(P, 'movie:12', { overall: null, watched: true }))!;
    expect(cleared.overall).toBeUndefined();
    expect(cleared.dimensions).toEqual({ acting: 4 });
  });
  it('un registro vacío (no vista, sin lista ni notas) se elimina', async () => {
    await saveRating(P, 'movie:13', { watched: true });
    expect(await saveRating(P, 'movie:13', { watched: false })).toBeUndefined();
    expect(await listRatings(P)).toHaveLength(0);
  });
  it('consultar los títulos vistos', async () => {
    await saveRating(P, 'movie:20', { watched: true });
    await saveRating(P, 'movie:21', { overall: 8 });
    await saveRating(P, 'tv:22', { watched: true, overall: 6 });
    const vistos = (await listRatings(P)).filter((r) => r.watched).map((r) => r.key).sort();
    expect(vistos).toEqual(['movie:20', 'tv:22']);
  });
});

describe('Exportación, importación y borrado', () => {
  it('exporta sin la clave e importa en una base limpia', async () => {
    const { updateConfig } = await import('../../src/db/repo');
    await updateConfig({ tmdbToken: 'secreto' });
    await saveRating(P, 'movie:1', { overall: 9, watched: true });
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
