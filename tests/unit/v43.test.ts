/**
 * v4.3 · Intereses compartidos (lógica de la app). La seguridad real se prueba en Postgres (supabase/tests) y contra
 * la API de producción (scripts/social/security-v43.mjs).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { combinedLevel, compareMatches, dedupeMatches, joint, LEVEL_RANK, matchLevel, SHARED_ANSWERS, type RankItem, type SharedAnswer } from '../../src/social/interests';
import {
  __setForTests, exchangedWith, flushShared, getSocial, myState, onLocalAnswer, publishAnswer, refreshShared, setLocalSource, syncLocalRatings, theirState,
} from '../../src/social/store';
import type { SocialBackend } from '../../src/social/backend';
import { SocialError, type Contact, type PutItem, type PutResult, type SharedRow } from '../../src/social/types';
import type { TitleKey } from '../../src/types';

// Salida de _match_level en Postgres (supabase/tests/security-v43.sql), copiada tal cual
const SQL_TABLE = 'mucho+mucho=maxima mucho+no=sin mucho+quiza=posible mucho+si=muy_alta mucho+-=pendiente no+mucho=sin no+no=sin no+quiza=sin no+si=sin no+-=sin quiza+mucho=posible quiza+no=sin quiza+quiza=posible_baja quiza+si=posible quiza+-=pendiente si+mucho=muy_alta si+no=sin si+quiza=posible si+si=alta si+-=pendiente -+mucho=pendiente -+no=sin -+quiza=pendiente -+si=pendiente -+-=pendiente';

describe('clasificación de coincidencias', () => {
  const all: (SharedAnswer | undefined)[] = [...SHARED_ANSWERS, undefined];
  it('es idéntica a la del servidor en las 25 combinaciones', () => {
    for (const pair of SQL_TABLE.split(' ')) {
      const [xy, lvl] = pair.split('=');
      const [x, y] = xy.split('+').map((v) => (v === '-' ? undefined : (v as SharedAnswer)));
      expect(matchLevel(x, y), xy).toBe(lvl);
    }
  });
  it('es simétrica (también el nivel combinado)', () => {
    for (const x of all) for (const y of all) for (const w of [false, true]) {
      expect(matchLevel(x, y)).toBe(matchLevel(y, x));
      expect(combinedLevel({ mine: x, theirs: y, bothWant: w })).toBe(combinedLevel({ mine: y, theirs: x, bothWant: w }));
    }
  });
  it('sigue la tabla pedida', () => {
    expect(matchLevel('mucho', 'mucho')).toBe('maxima');
    expect(matchLevel('mucho', 'si')).toBe('muy_alta');
    expect(matchLevel('si', 'si')).toBe('alta');
    expect(matchLevel('mucho', 'quiza')).toBe('posible');
    expect(matchLevel('si', 'quiza')).toBe('posible');
    expect(matchLevel('quiza', 'quiza')).toBe('posible_baja');
    for (const a of SHARED_ANSWERS) expect(matchLevel(a, 'no')).toBe('sin');
    for (const a of ['quiza', 'si', 'mucho'] as const) expect(matchLevel(a, undefined)).toBe('pendiente');
  });
  it('un «No» excluye aunque ambos lo tengan en Quiero ver; sin interés explícito = «Ambos quieren verla»', () => {
    expect(combinedLevel({ mine: 'no', theirs: 'mucho', bothWant: true })).toBe('sin');
    expect(combinedLevel({ mine: 'mucho', theirs: 'no', bothWant: true })).toBe('sin');
    expect(combinedLevel({ bothWant: true })).toBe('ambos');
    expect(combinedLevel({ mine: 'quiza', theirs: 'quiza', bothWant: true })).toBe('ambos');
    expect(combinedLevel({ mine: 'si', theirs: 'si', bothWant: true })).toBe('alta');
  });
  it('un interés privado no se deduce ni se revela', () => {
    expect(combinedLevel({ mine: 'mucho', theirs: 'mucho', theirsPrivate: true })).toBe('privado');
    expect(combinedLevel({ mine: 'mucho', theirsPrivate: true, bothWant: true })).toBe('ambos');
  });
});

describe('orden de Para ver juntos', () => {
  const it0 = (key: string, level: RankItem['level'], o: Partial<RankItem> = {}): RankItem => ({ key: key as TitleKey, contact: 'c', level, ...o });
  it('interés explícito > Ambos quieren verla > posibles > pendientes > sin coincidencia', () => {
    const xs = [it0('movie:1', 'pendiente'), it0('movie:2', 'ambos', { myScore: 9.9, theirScore: 9.9 }), it0('movie:3', 'alta'), it0('movie:4', 'maxima'), it0('movie:5', 'sin'), it0('movie:6', 'posible_baja'), it0('movie:7', 'muy_alta'), it0('movie:8', 'posible')];
    expect([...xs].sort(compareMatches).map((x) => x.level)).toEqual(['maxima', 'muy_alta', 'alta', 'ambos', 'posible', 'posible_baja', 'pendiente', 'sin']);
  });
  it('dentro de la categoría: puntaje conjunto (si ambos existen) → TMDB → fecha → id; estable', () => {
    const xs = [it0('movie:1', 'alta', { tmdb: 9 }), it0('movie:2', 'alta', { myScore: 8, theirScore: 8 }), it0('movie:3', 'alta', { myScore: 10, theirScore: 6 }), it0('movie:4', 'alta', { tmdb: 7, at: 5 }), it0('movie:5', 'alta', { tmdb: 7, at: 9 }), it0('movie:6', 'alta')];
    expect(joint(10, 6)).toBe(7);
    const a = [...xs].sort(compareMatches).map((x) => x.key);
    expect(a).toEqual(['movie:2', 'movie:3', 'movie:1', 'movie:5', 'movie:4', 'movie:6']);
    expect([...xs].reverse().sort(compareMatches).map((x) => x.key)).toEqual(a);
  });
  it('deduplica por contacto + tipo + id conservando la mejor categoría', () => {
    const d = dedupeMatches([it0('movie:1', 'ambos'), it0('movie:1', 'maxima'), it0('movie:1', 'alta', { contact: 'otro' }), it0('tv:1', 'alta')]);
    expect(d.length).toBe(3);
    expect(d.find((x) => x.key === 'movie:1' && x.contact === 'c')!.level).toBe('maxima');
  });
  it('LEVEL_RANK cubre todas las categorías sin empates', () => {
    expect(new Set(Object.values(LEVEL_RANK)).size).toBe(Object.keys(LEVEL_RANK).length);
  });
});

// ───────────── sincronización con un servicio social simulado ─────────────
const K = 'movie:603' as TitleKey;
const contact = (o: Partial<Contact> = {}): Contact => ({ id: 'B', alias: 'Beto', favorite: false, blocked: false, shareMatches: false, shareScores: false, theirShareMatches: false, theirShareScores: false,
  shareInterests: true, shareRatings: false, notifyMatches: true, theirShareInterests: true, theirShareRatings: false, linked: true, createdAt: 0, ...o });
function fakeBackend() {
  const calls: PutItem[][] = [];
  let offline = false;
  let shared: SharedRow[] = [];
  const b = {
    kind: 'fake',
    putShared: async (items: PutItem[]) => { if (offline) throw new SocialError('network'); calls.push(items); return items.map((i): PutResult => ({ key: i.key, f: i.f, status: 'ok', events: [] })); },
    getShared: async () => { if (offline) throw new SocialError('network'); return shared; },
    getMatches: async () => [],
    notifyEvents: async () => undefined,
  } as unknown as SocialBackend;
  return { b, calls, setOffline: (v: boolean) => { offline = v; }, setShared: (r: SharedRow[]) => { shared = r; } };
}
const local = { answers: new Map<TitleKey, SharedAnswer>(), ratings: new Map<TitleKey, number>() };

describe('publicación de intereses', () => {
  let f: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    f = fakeBackend();
    local.answers.clear(); local.ratings.clear();
    setLocalSource({ profileId: 'p1', answers: async () => local.answers, ratings: async () => local.ratings });
    __setForTests(f.b, { phase: 'ready', user: { id: 'A' }, contacts: [contact()], sent: [{ id: 'r1', recipient: 'B', key: K, createdAt: Date.now() - 1000 }], inbox: [], outbox: [], shared: [], wantMatches: {}, pub: {} });
  });
  it('sólo se publica un título intercambiado con un contacto autorizado', async () => {
    expect(exchangedWith(K)).toEqual(['B']);
    expect(publishAnswer('movie:999' as TitleKey, 'si')).toBe(false);
    __setForTests(f.b, { contacts: [contact({ shareInterests: false })] });
    expect(publishAnswer(K, 'si')).toBe(false);
    expect(myState(K, getSocial().contacts[0], 'si')).toBe('private');
  });
  it('cambio desde cualquier pantalla → pendiente → compartido; otro perfil local no publica', async () => {
    onLocalAnswer('otro-perfil', K, 'mucho');
    expect(getSocial().pub[K]).toBeUndefined();
    onLocalAnswer('p1', K, 'visto');
    expect(getSocial().pub[K]).toBeUndefined();
    onLocalAnswer('p1', K, 'mucho');
    const c = getSocial().contacts[0];
    expect(myState(K, c, 'mucho')).toBe('pending');
    await flushShared();
    expect(f.calls.flat().map((i) => [i.key, i.f, i.v])).toEqual([[K, 'answer', 'mucho']]);
    expect(myState(K, getSocial().contacts[0], 'mucho')).toBe('shared');
  });
  it('sin conexión queda pendiente (no se muestra como compartido) y se envía al volver', async () => {
    f.setOffline(true);
    publishAnswer(K, 'si');
    await flushShared();
    expect(myState(K, getSocial().contacts[0], 'si')).toBe('pending');
    expect(getSocial().reachable).toBe(false);
    f.setOffline(false);
    await flushShared();
    expect(myState(K, getSocial().contacts[0], 'si')).toBe('shared');
    expect(f.calls.length).toBe(1);
  });
  it('dos cambios seguidos: se envía el último, con su hora (un viejo no pisa al nuevo)', async () => {
    f.setOffline(true);
    publishAnswer(K, 'si');
    await new Promise((r) => setTimeout(r, 5));
    publishAnswer(K, 'no');
    f.setOffline(false);
    await flushShared();
    expect(f.calls.flat().map((i) => i.v)).toEqual(['no']);
  });
  it('una respuesta vieja no se publica sola: aparece como «No compartido» hasta tocarla', () => {
    expect(myState(K, getSocial().contacts[0], 'mucho')).toBe('unshared');
  });
  it('la foto del servidor reemplaza la caché: al revocar, el interés del otro desaparece', async () => {
    f.setShared([{ contact: 'B', key: K, answer: 'si', answerAt: 1 }]);
    await refreshShared();
    expect(theirState(K, getSocial().contacts[0])).toMatchObject({ kind: 'answer', v: 'si' });
    f.setShared([]);
    __setForTests(f.b, { contacts: [contact({ theirShareInterests: false })] });
    await refreshShared();
    expect(theirState(K, getSocial().contacts[0])).toEqual({ kind: 'private', why: 'theirs' });
    expect(getSocial().shared).toEqual([]);
  });
  it('«Sin responder» se distingue de «privado»', () => {
    expect(theirState(K, contact())).toEqual({ kind: 'none' });
    expect(theirState(K, contact({ shareInterests: false }))).toEqual({ kind: 'private', why: 'mine' });
  });
  it('valoraciones: la primera vez es base (no se publica); los cambios posteriores sí', async () => {
    __setForTests(f.b, { contacts: [contact({ shareRatings: true, theirShareRatings: true })] });
    syncLocalRatings('p1', new Map([[K, 7]]));
    await flushShared();
    expect(f.calls.length).toBe(0);
    syncLocalRatings('p1', new Map([[K, 9]]));
    await flushShared();
    expect(f.calls.flat().map((i) => [i.f, i.v])).toEqual([['rating', '9']]);
  });
});
