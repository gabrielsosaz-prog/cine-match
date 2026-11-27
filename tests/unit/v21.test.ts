/**
 * Pruebas de Cine Match v2.1: estrellas, migración v1/v2 → v3, aspectos con peso cero si nunca se puntuaron,
 * actores, finales, «Otros», «No me interesa» con modelo jerárquico, filtros combinados y completitud.
 *
 * Los escenarios usan títulos SINTÉTICOS construidos a mano con el formato de TMDB: muestran cómo responde
 * el motor ante casos controlados. No son una validación de su precisión con usuarios reales.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../src/db/db';
import { aspectCompletion, migrateRating, starsToTen, tenToStars } from '../../src/db/migrations';
import { ensureBootstrap, getSettings, listRatings, saveRating, updateSettings } from '../../src/db/repo';
import { localRulesExtractor } from '../../src/engine/comments';
import { endingTraits, rawFeatures } from '../../src/engine/features';
import { buildProfile } from '../../src/engine/profile';
import { rank, scoreCandidates } from '../../src/engine/recommender';
import { rejectionPenalty } from '../../src/engine/rejections';
import { mapDetails } from '../../src/providers/tmdb';
import { ALLOWED_PATH } from '../../server/tmdbProxy.js';
import { exportData, importData } from '../../src/services/dataPortability';
import { DEFAULT_FILTERS, activeCount, diagnose, isGeneral, matchesAll, matchesContent, type Candidate } from '../../src/services/filters';
import { matchesView, sortRatings } from '../../src/pages/Ratings';
import type { AvailabilitySnapshot, DimensionScores, Person, Rating, TitleKey, TitleMeta } from '../../src/types';

const report: Record<string, unknown> = {};
const P = 'p-principal';

// ---------- Utilidades: títulos sintéticos con formato TMDB ----------
interface MkOpts { type?: 'movie' | 'tv'; genres?: number[]; keywords?: [number, string][]; cast?: (number | [number, number?])[]; director?: number; year?: number; runtime?: number; collection?: [number, string]; vote?: number }
function mk(id: number, o: MkOpts = {}): TitleMeta {
  const type = o.type ?? 'movie';
  const cast: Person[] = (o.cast ?? []).map((c, i) => (Array.isArray(c) ? { id: c[0], name: `Actor ${c[0]}`, order: c[1] ?? i } : { id: c, name: `Actor ${c}`, order: i }));
  return {
    key: `${type}:${id}` as TitleKey, type, tmdbId: id, title: `Título ${id}`, year: o.year ?? 2015, genres: (o.genres ?? [18]).map((g) => ({ id: g, name: `G${g}` })),
    keywords: (o.keywords ?? []).map(([kid, name]) => ({ id: kid, name })), cast, directors: o.director ? [{ id: o.director, name: `Dir ${o.director}` }] : [],
    runtime: o.runtime ?? 110, collection: o.collection ? { id: o.collection[0], name: o.collection[1] } : undefined,
    voteAverage: o.vote ?? 7, voteCount: 2000, completeness: 'full', missing: [], source: 'test', fetchedAt: 0, metaVersion: 2,
  };
}
const R = (key: TitleKey, overall: number | undefined, dims: DimensionScores = {}, extra: Partial<Rating> = {}): Rating =>
  ({ id: `p|${key}`, profileId: 'p', key, watched: overall !== undefined, overall, dimensions: dims, createdAt: 0, updatedAt: 0, schema: 3, ...extra });
const mapOf = (ts: TitleMeta[]) => new Map(ts.map((t) => [t.key, t]));
const pred = (ratings: Rating[], titles: Map<TitleKey, TitleMeta>, key: TitleKey) => {
  const profile = buildProfile(ratings, titles);
  return scoreCandidates({ profile, ratings, titles, candidates: [key] })[0];
};

// ---------- 1. Conversión de escala ----------
describe('1. Conversión 1-10 → estrellas 1-5', () => {
  it('conserva extremos y orden, con la tabla documentada', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(tenToStars)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(tenToStars(1)).toBe(1);
    expect(tenToStars(10)).toBe(5);
    for (let v = 1; v < 10; v += 0.5) expect(tenToStars(v + 0.5)).toBeGreaterThanOrEqual(tenToStars(v)); // monótona
    expect([1, 2, 3, 4, 5].map(starsToTen)).toEqual([1, 3.25, 5.5, 7.75, 10]);
  });
});

// ---------- 2 y 9. Migración versionada e idempotente desde v1 y v2 ----------
const V1 = {
  titles: 'key, type, fetchedAt', availability: 'id, key, country, checkedAt', availabilityEvents: '++id, key, country, detectedAt',
  ratings: 'id, profileId, key, status, updatedAt, [profileId+status]', profiles: 'id', settings: 'profileId', config: 'id',
  runs: '++id, profileId, createdAt', snapshots: '++id, profileId, at', logs: '++id, profileId, at, type',
};
const V2 = { ...V1, ratings: 'id, profileId, key, updatedAt, [profileId+list]' };

describe('2. Migración a la v2.1 sin pérdida de datos', () => {
  it('una base v2 real (Dexie 2) se abre como v3 conservando todo', async () => {
    const name = `mig21-${Date.now()}`;
    const old = new Dexie(name);
    old.version(1).stores(V1);
    old.version(2).stores(V2);
    await old.open();
    const v2 = (key: string, extra: object) => ({ id: `${P}|${key}`, profileId: P, key, watched: false, dimensions: {}, createdAt: 1000, updatedAt: 2000, schema: 2, ...extra });
    await old.table('ratings').bulkPut([
      v2('movie:1', { watched: true, watchedAt: 1500, overall: 8.5, dimensions: { story: 9, characters: 7, originality: 10, acting: 6, ending: 2, pacing: 5.5 } }),
      v2('movie:2', { watched: true }),
      v2('tv:3', { list: 'want' }),
      v2('tv:4', { list: 'not_interested' }),
      v2('movie:5', { list: 'abandoned', abandonReason: 'Ritmo muy lento', overall: 3 }),
      v2('movie:6', { dimensions: { characters: 8 } }), // sólo un aspecto retirado
    ]);
    await old.table('settings').put({ profileId: P, country: 'AR', platforms: ['netflix'], language: 'es-MX', excludedGenres: [27], includeUnconfirmed: false, dimensionWeights: { acting: 1.5, characters: 2 }, onboarded: true });
    old.close();

    const db3 = useTestDb(name);
    await ensureBootstrap();
    expect(db3.verno).toBe(4) // v4.0 suma tablas nuevas; las valoraciones se conservan igual;
    const rs = new Map((await listRatings(P)).map((r) => [r.key, r]));
    expect(rs.size).toBe(6); // no se borró ninguna
    const m1 = rs.get('movie:1')!;
    expect(m1).toMatchObject({ watched: true, watchedAt: 1500, overall: 8.5, schema: 3, createdAt: 1000, updatedAt: 2000 });
    expect(m1.dimensions).toEqual({ story: 5, acting: 3, ending: 1, pacing: 3 });
    expect(m1.legacy?.dimensions10).toEqual({ story: 9, characters: 7, originality: 10, acting: 6, ending: 2, pacing: 5.5 });
    expect(rs.get('tv:3')).toMatchObject({ list: 'want', watched: false });
    expect(rs.get('tv:4')).toMatchObject({ notInterested: true });
    expect(rs.get('tv:4')!.list).toBeUndefined();
    expect(rs.get('movie:5')).toMatchObject({ list: 'abandoned', abandonReason: 'Ritmo muy lento', overall: 3 });
    expect(rs.get('movie:6')).toMatchObject({ dimensions: {}, legacy: { dimensions10: { characters: 8 } } });
    const st = await getSettings(P);
    expect(st).toMatchObject({ excludedGenres: [27], dimensionWeights: { acting: 1.5, characters: 2 }, onboarded: true });
    // Idempotencia: volver a migrar no cambia nada
    for (const r of rs.values()) expect(migrateRating(migrateRating(r))).toEqual(r);
    // Un aspecto retirado no entra al motor
    const p = buildProfile([...rs.values()], new Map(), st.dimensionWeights);
    expect(p.dimensions.map((d) => d.id)).toEqual(['story', 'acting', 'ending', 'emotion', 'visuals', 'pacing', 'suspense']);
  });

  it('importa exportaciones v2 (aspectos 1-10) y exporta v3 con respaldo', async () => {
    useTestDb(`imp21-${Date.now()}`); await ensureBootstrap();
    await importData({ format: 'cine-match-export/2', ratings: [{ id: `${P}|movie:7`, profileId: P, key: 'movie:7', watched: true, overall: 9, dimensions: { suspense: 8, originality: 9 }, createdAt: 1, updatedAt: 2, schema: 2 }] });
    const [r] = await listRatings(P);
    expect(r).toMatchObject({ overall: 9, dimensions: { suspense: 4 }, legacy: { dimensions10: { suspense: 8, originality: 9 } } });
    const out = await exportData();
    expect(out.format).toBe('cine-match-export/4');
    // Reimportar el export v3 no vuelve a convertir (idempotente)
    useTestDb(`imp21b-${Date.now()}`); await ensureBootstrap();
    await importData(JSON.parse(JSON.stringify(out)));
    expect((await listRatings(P))[0].dimensions).toEqual({ suspense: 4 });
  });
});

// ---------- 3, 7, 8, 18. Persistencia ----------
describe('3/7/8/18. Aspectos opcionales, «Otros», «No me interesa» y exportación', () => {
  it('aspectos opcionales y quitar una estrella ya asignada', async () => {
    useTestDb(`opt-${Date.now()}`); await ensureBootstrap();
    const a = (await saveRating(P, 'movie:1', { overall: 7 }))!;
    expect(a.dimensions).toEqual({});
    await saveRating(P, 'movie:1', { dimensions: { story: 4, ending: 2 } });
    const b = (await saveRating(P, 'movie:1', { dimensions: { story: 4 } }))!; // se quitó «Final»
    expect(b.dimensions).toEqual({ story: 4 });
    expect(b.overall).toBe(7); // la general no cambia
  });
  it('guarda la observación «Otros» original y la exporta/importa', async () => {
    useTestDb(`com-${Date.now()}`); await ensureBootstrap();
    const text = 'Me gustó la idea de que en realidad vivimos dentro de una simulación.';
    await saveRating(P, 'movie:603', { overall: 9, comment: text });
    expect((await listRatings(P))[0].comment).toBe(text);
    const out = await exportData();
    useTestDb(`com2-${Date.now()}`); await ensureBootstrap();
    await importData(JSON.parse(JSON.stringify(out)));
    expect((await listRatings(P))[0].comment).toBe(text);
    const cleared = (await saveRating(P, 'movie:603', { comment: '' }))!;
    expect(cleared.comment).toBeUndefined();
  });
  it('«No me interesa» es independiente de vista, nota, aspectos y «Quiero verla», y se puede revertir', async () => {
    useTestDb(`ni-${Date.now()}`); await ensureBootstrap();
    await saveRating(P, 'movie:20', { list: 'want', overall: 6, dimensions: { story: 3 }, watched: true });
    const r = (await saveRating(P, 'movie:20', { notInterested: true }))!;
    expect(r).toMatchObject({ notInterested: true, list: 'want', overall: 6, watched: true, dimensions: { story: 3 } });
    expect(matchesView(r, 'dismissed')).toBe(true);
    const back = (await saveRating(P, 'movie:20', { notInterested: false }))!;
    expect(back.notInterested).toBeUndefined();
    expect(back).toMatchObject({ list: 'want', overall: 6 });
    // Sólo descartado (sin nada más) y revertido → el registro desaparece
    await saveRating(P, 'movie:21', { notInterested: true });
    expect(await saveRating(P, 'movie:21', { notInterested: false })).toBeUndefined();
  });
});

// ---------- 4. Peso cero de aspectos nunca puntuados ----------
describe('4. Aspectos nunca puntuados', () => {
  const ts = Array.from({ length: 12 }, (_, i) => mk(100 + i, { genres: [i % 2 ? 53 : 18], keywords: [[i % 2 ? 1 : 2, i % 2 ? 'detective' : 'family']] }));
  const titles = mapOf(ts);
  it('tienen contribución personalizada cero y la influencia crece con la evidencia', () => {
    const only = (n: number) => buildProfile(ts.slice(0, n).map((t, i) => R(t.key, 6 + (i % 4), { suspense: 2 + (i % 4) })), titles);
    const p = only(8);
    for (const d of p.dimensions.filter((x) => x.id !== 'suspense')) { expect(d.weight).toBe(0); expect(d.count).toBe(0); }
    const w = [1, 3, 8].map((n) => only(n).dimensions.find((d) => d.id === 'suspense')!.weight);
    report['Influencia del suspenso según cantidad de títulos puntuados'] = { '1 título': w[0], '3 títulos': w[1], '8 títulos': w[2] };
    expect(w[0]).toBeGreaterThan(0);
    expect(w[1]).toBeGreaterThan(w[0]);
    expect(w[2]).toBeGreaterThan(w[1]);
    // Sin ningún aspecto, el canal de aspectos no mueve la predicción
    const plain = ts.slice(0, 8).map((t) => R(t.key, 8));
    const s = scoreCandidates({ profile: buildProfile(plain, titles), ratings: plain, titles, candidates: [ts[10].key] })[0];
    expect(s.aspects).toHaveLength(0);
  });
  it('conserva el peso manual existente (compatible con las reglas)', () => {
    const rs = ts.slice(0, 6).map((t, i) => R(t.key, 7, { story: 3 + (i % 2), ending: 3 + (i % 2) }));
    const p = buildProfile(rs, titles, { ending: 2, acting: 2 });
    const end = p.dimensions.find((d) => d.id === 'ending')!, story = p.dimensions.find((d) => d.id === 'story')!;
    expect(end.weight).toBeGreaterThan(story.weight);
    expect(p.dimensions.find((d) => d.id === 'acting')!.weight).toBe(0); // manual 2 × nunca puntuado = 0
  });
});

// ---------- 5. Actores ----------
describe('5. Preferencias por actores', () => {
  const A = 501; // actor que aparece en varios títulos
  const hist = Array.from({ length: 6 }, (_, i) => mk(200 + i, { genres: [18], cast: [A, 600 + i, 700 + i] }));
  const filler = Array.from({ length: 6 }, (_, i) => mk(220 + i, { genres: [18], cast: [800 + i] }));
  const leadCand = mk(250, { genres: [18], cast: [A, 900] });
  const supportCand = mk(251, { genres: [18], cast: [901, 902, 903, 904, 905, 906, [A, 7]] });
  const noActor = mk(252, { genres: [18], cast: [907] });
  const titles = mapOf([...hist, ...filler, leadCand, supportCand, noActor]);
  const base = filler.map((t) => R(t.key, 7, { acting: 3 }));
  const withActor = (n: number, stars = 5) => [...base, ...hist.slice(0, n).map((t) => R(t.key, 7, { acting: stars }))];
  it('varias actuaciones bien valoradas suben moderadamente; una sola casi no pesa', () => {
    const p0 = pred(base, titles, leadCand.key).pred;
    const p1 = pred(withActor(1), titles, leadCand.key).pred;
    const p4 = pred(withActor(4), titles, leadCand.key).pred;
    const n0 = pred(withActor(4), titles, noActor.key).pred;
    const prof1 = buildProfile(withActor(1), titles), prof4 = buildProfile(withActor(4), titles);
    report['Escenario actor: películas con el actor A'] = {
      afinidadConUnaActuacion: prof1.actors.get(A)!.affinity, afinidadConCuatro: prof4.actors.get(A)!.affinity,
      prediccionSinDatos: p0, conUnaActuacion5Estrellas: p1, conCuatro: p4, tituloSinElActor: n0,
    };
    expect(prof4.actors.get(A)!.affinity).toBeGreaterThan(prof1.actors.get(A)!.affinity);
    // El canal de actores aislado (los demás canales también reaccionan a la nota del título)
    const one = pred(withActor(1), titles, leadCand.key), four = pred(withActor(4), titles, leadCand.key);
    const ch = (s: typeof one, n: number) => (0.8 * s.actors.reduce((a, x) => a + x.c, 0)) / (1 + n);
    const den = 1 + 1 + 1 / 1.35; // participación de los dos actores del candidato
    report['Escenario actor: películas con el actor A'] = { ...(report['Escenario actor: películas con el actor A'] as object), aporteActorUna: ch(one, den - 1), aporteActorCuatro: ch(four, den - 1) };
    expect(ch(one, den - 1)).toBeLessThan(0.25); // una sola observación: efecto acotado
    expect(ch(four, den - 1)).toBeGreaterThan(ch(one, den - 1));
    expect(ch(four, den - 1)).toBeLessThan(1); // moderado
  });
  it('considera la participación real: un secundario recibe menos que un protagonista', () => {
    const rs = withActor(4);
    const lead = pred(rs, titles, leadCand.key).actors.find((a) => a.id === A)!.c;
    const sup = pred(rs, titles, supportCand.key).actors.find((a) => a.id === A)!.c;
    expect(sup).toBeLessThan(lead);
  });
  it('no asume que todo el reparto actuó igual y usa evidencia negativa', () => {
    const rs = withActor(4);
    const p = buildProfile(rs, titles);
    // Los secundarios (orden 2) de esos títulos reciben menos crédito que el protagonista
    expect(p.actors.get(700)!.affinity).toBeLessThan(p.actors.get(A)!.affinity);
    const neg = buildProfile([...base, ...hist.slice(0, 4).map((t) => R(t.key, 7, { acting: 1 }))], titles);
    expect(neg.actors.get(A)!.affinity).toBeLessThan(0);
    expect(neg.actors.get(A)!.negative).toBe(4);
  });
  it('en series usa la proporción de episodios (aggregate_credits de TMDB)', () => {
    const tv = mapDetails({
      id: 77, name: 'Serie', first_air_date: '2020-01-01', genres: [{ id: 18, name: 'Drama' }], number_of_episodes: 20,
      aggregate_credits: { cast: [{ id: 1, name: 'Prota', order: 0, total_episode_count: 20, roles: [{ character: 'X' }] }, { id: 2, name: 'Invitado', order: 1, total_episode_count: 1, roles: [] }] },
    }, 'tv', 'es-MX');
    expect(tv.cast[0]).toMatchObject({ id: 1, episodes: 20, order: 0 });
    expect(tv.totalEpisodes).toBe(20);
  });
});

// ---------- 6. Finales ----------
describe('6. Preferencias narrativas del final (verificables)', () => {
  const twist = Array.from({ length: 6 }, (_, i) => mk(300 + i, { genres: [53], keywords: [[28, 'plot twist'], [40 + i, `tema ${i}`]] }));
  const plain = Array.from({ length: 6 }, (_, i) => mk(320 + i, { genres: [53], keywords: [[60 + i, `otro ${i}`]] }));
  const candTwist = mk(350, { genres: [53], keywords: [[28, 'plot twist']] });
  const candPlain = mk(351, { genres: [53], keywords: [[99, 'algo']] });
  const titles = mapOf([...twist, ...plain, candTwist, candPlain]);
  it('extrae rasgos de final sólo de palabras clave de TMDB; sin datos, no hay componente', () => {
    expect(endingTraits(candTwist)).toEqual(['twist']);
    expect(endingTraits(candPlain)).toEqual([]);
    expect(rawFeatures(candPlain).some((f) => f.startsWith('end:'))).toBe(false);
  });
  it('aprende del aspecto Final y no revela el tipo de final en la explicación', () => {
    const rs = [...twist.map((t) => R(t.key, 8, { ending: 5 })), ...plain.map((t) => R(t.key, 8, { ending: 2 }))];
    const profile = buildProfile(rs, titles);
    expect(profile.dimFeatures.get('ending')!.get('end:twist')!.affinity).toBeGreaterThan(0);
    expect(profile.dimFeatures.get('suspense')).toBeUndefined(); // nunca puntuado
    const a = pred(rs, titles, candTwist.key), b = pred(rs, titles, candPlain.key);
    report['Escenario final: finales con giro puntuados 5★ vs. otros 2★'] = { conGiro: a.pred, sinDatosDeFinal: b.pred };
    expect(a.pred).toBeGreaterThan(b.pred);
    const items = rank({ profile, ratings: rs, titles, candidates: [candTwist.key, candPlain.key], limit: 2 });
    expect(items.flatMap((i) => i.explanation).join(' ')).not.toMatch(/giro|twist/i);
  });
});

// ---------- 7. «Otros» ----------
describe('7. Comentarios «Otros»', () => {
  it('extrae preferencias estructuradas con polaridad, negación y contraste', () => {
    const ex = (t: string, o?: number) => localRulesExtractor.extract(t, { overall: o });
    expect(ex('Me gustó la idea de que en realidad vivimos dentro de una simulación.')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'concept', id: 'simulation', polarity: 1, strength: 1 })]));
    const mixed = ex('La historia de viajes en el tiempo me encantó, pero el ritmo fue muy lento');
    expect(mixed).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'time_travel', polarity: 1 }), expect.objectContaining({ kind: 'aspect', id: 'pacing', polarity: -1 })]));
    expect(ex('La parte de superhéroes no fue interesante')).toEqual([expect.objectContaining({ id: 'superhero', polarity: -1 })]);
    // Sin palabras de valoración: hereda la nota general con fuerza reducida; sin nota, no se infiere nada
    expect(ex('Trata sobre zombis', 9)[0]).toMatchObject({ id: 'zombies', polarity: 1, strength: 0.5 });
    expect(ex('Trata sobre zombis')).toEqual([]);
  });
  it('relaciona la preferencia con palabras clave de otros títulos, la usa en el ranking y lo explica', () => {
    const matrix = mk(603, { genres: [878, 28], keywords: [[1, 'simulated reality'], [2, 'artificial intelligence']] });
    const others = Array.from({ length: 5 }, (_, i) => mk(610 + i, { genres: [878] }));
    const candSim = mk(650, { genres: [878], keywords: [[3, 'virtual reality']] });
    const candNo = mk(651, { genres: [878], keywords: [[4, 'space']] });
    const titles = mapOf([matrix, ...others, candSim, candNo]);
    const base = [...others.map((t) => R(t.key, 7)), R(matrix.key, 9)];
    const withComment = [...others.map((t) => R(t.key, 7)), R(matrix.key, 9, {}, { comment: 'Me gustó la idea de que en realidad vivimos dentro de una simulación.' })];
    const p = buildProfile(withComment, titles);
    expect(p.concepts.get('simulation')).toMatchObject({ count: 1 });
    expect(p.concepts.get('simulation')!.score).toBeGreaterThan(0);
    const before = pred(base, titles, candSim.key).pred, after = pred(withComment, titles, candSim.key).pred;
    const unrelated = pred(withComment, titles, candNo.key).pred - pred(base, titles, candNo.key).pred;
    report['Escenario «Otros»: comentario sobre la simulación en un título puntuado 9'] = { tituloConRealidadVirtual: { antes: before, despues: after }, tituloSinRelacion: { cambio: unrelated } };
    expect(after).toBeGreaterThan(before + 0.2);
    expect(Math.abs(unrelated)).toBeLessThan(0.05);
    const items = rank({ profile: p, ratings: withComment, titles, candidates: [candSim.key], limit: 1 });
    expect(items[0].explanation.join(' ')).toMatch(/«Otros».*realidad simulada.*Título 603/);
  });
  it('una mención a un actor en «Otros» cuenta como evidencia sobre esa persona', () => {
    const t = mk(700, { genres: [18], cast: [[11, 0], [12, 1]] });
    t.cast[0].name = 'Keanu Reeves';
    const p = buildProfile([R(t.key, 8, {}, { comment: 'La actuación de Keanu Reeves es impecable' })], mapOf([t]));
    expect(p.actors.get(11)!.affinity).toBeGreaterThan(0);
    // v3.0: el resto del reparto recibe sólo evidencia débil de la nota general (sin estrellas de Actuaciones)
    expect(p.actors.get(12)!.actingCount).toBe(0);
    expect(p.actors.get(12)!.affinity).toBeLessThan(p.actors.get(11)!.affinity / 2);
  });
});

// ---------- 8, 9, 10. Descartes jerárquicos ----------
describe('8-10. «No me interesa» y modelo jerárquico', () => {
  const SUPER: [number, string] = [9715, 'superhero'], COMIC: [number, string] = [9717, 'based on comic'], BATKW: [number, string] = [380, 'batman'];
  const avengers = (id: number) => mk(id, { genres: [28, 878], keywords: [SUPER, COMIC], collection: [86311, 'The Avengers Collection'] });
  const endgame = avengers(299534), infinity = avengers(299536);
  const otherHeroes = Array.from({ length: 5 }, (_, i) => mk(400 + i, { genres: [28, 878], keywords: [SUPER, COMIC] }));
  const batmans = Array.from({ length: 3 }, (_, i) => mk(450 + i, { genres: [28, 80], keywords: [SUPER, COMIC, BATKW], collection: [263, 'The Dark Knight Collection'], director: 525 }));
  const batCand = mk(460, { genres: [28, 80], keywords: [SUPER, COMIC, BATKW], collection: [263, 'The Dark Knight Collection'], director: 525 });
  const heroCand = mk(461, { genres: [28, 878], keywords: [SUPER, COMIC] });
  const actionCand = mk(462, { genres: [28], keywords: [[1, 'heist']] });
  const liked = Array.from({ length: 4 }, (_, i) => mk(470 + i, { genres: [28], keywords: [[2, 'car chase']] }));
  const titles = mapOf([endgame, infinity, ...otherHeroes, ...batmans, batCand, heroCand, actionCand, ...liked]);
  const NI = (t: TitleMeta) => R(t.key, undefined, {}, { notInterested: true, watched: false });
  const baseLikes = liked.map((t) => R(t.key, 8));

  it('excluye el título descartado y lo vuelve a recomendar al revertir', () => {
    const rs = [...baseLikes, NI(endgame)];
    const cands = [endgame.key, infinity.key, actionCand.key];
    expect(rank({ profile: buildProfile(rs, titles), ratings: rs, titles, candidates: cands }).map((i) => i.key)).not.toContain(endgame.key);
    const reverted = [...baseLikes];
    expect(rank({ profile: buildProfile(reverted, titles), ratings: reverted, titles, candidates: cands }).map((i) => i.key)).toContain(endgame.key);
  });
  it('baja moderadamente la misma saga (colección de TMDB), no lo no relacionado, y no es una mala nota', () => {
    const rs = [...baseLikes, NI(endgame)];
    const p = buildProfile(rs, titles);
    const saga = rejectionPenalty(infinity, p.rejections);
    const unrelated = rejectionPenalty(actionCand, p.rejections);
    report['Escenario saga: descartar Avengers: Endgame'] = { penalizacionMismaSaga: saga.penalty, penalizacionAccionNoRelacionada: unrelated.penalty };
    expect(saga.level).toBe('collection');
    expect(saga.penalty).toBeLessThan(-0.3);
    expect(saga.penalty).toBeGreaterThan(-1.5); // moderada
    expect(Math.abs(unrelated.penalty)).toBeLessThan(0.15); // un solo descarte casi no toca el género
    expect(p.features.get('g:28')?.affinity).toBeGreaterThan(0); // el gusto aprendido por acción no baja
    const it0 = rank({ profile: p, ratings: rs, titles, candidates: [infinity.key], limit: 1 })[0];
    expect(it0.explanation.join(' ')).toMatch(/saga The Avengers Collection/);
  });
  it('descartes repetidos de superhéroes bajan progresivamente el subgénero', () => {
    const pen = (n: number) => rejectionPenalty(heroCand, buildProfile([...baseLikes, ...otherHeroes.slice(0, n).map(NI)], titles).rejections).penalty;
    const p1 = pen(1), p3 = pen(3), p5 = pen(5);
    report['Escenario subgénero: descartes de superhéroes'] = { unDescarte: p1, tres: p3, cinco: p5 };
    expect(p3).toBeLessThan(p1);
    expect(p5).toBeLessThan(p3);
    expect(p5).toBeGreaterThan(-2);
  });
  it('varias películas de Batman bien puntuadas son una excepción positiva', () => {
    const rejections = [...otherHeroes.map(NI), NI(endgame)];
    const rs = [...baseLikes, ...rejections, ...batmans.map((t) => R(t.key, 9))];
    const p = buildProfile(rs, titles);
    const bat = rejectionPenalty(batCand, p.rejections), hero = rejectionPenalty(heroCand, p.rejections);
    const scored = scoreCandidates({ profile: p, ratings: rs, titles, candidates: [batCand.key, heroCand.key] });
    report['Escenario excepción: rechazos de superhéroes + Batman puntuadas 9'] = { penalizacionBatman: bat.penalty, penalizacionOtroSuperheroe: hero.penalty, prediccionBatman: scored[0].pred, prediccionOtroSuperheroe: scored[1].pred };
    expect(bat.exception).toBeDefined();
    expect(bat.penalty).toBeGreaterThan(hero.penalty + 0.3);
    expect(scored[0].pred).toBeGreaterThan(scored[1].pred + 1);
    // Recuperación: nuevas valoraciones positivas de superhéroes reducen la penalización general
    const newFans = Array.from({ length: 3 }, (_, i) => mk(480 + i, { genres: [28, 878], keywords: [SUPER, COMIC] }));
    newFans.forEach((t) => titles.set(t.key, t));
    const recovered = buildProfile([...rs, ...newFans.map((t) => R(t.key, 9))], titles);
    expect(rejectionPenalty(heroCand, recovered.rejections).penalty).toBeGreaterThan(hero.penalty);
  });
});

// ---------- 11. Filtros combinados ----------
describe('11. Filtros combinados', () => {
  const snap = (key: TitleKey, ids: number[]): AvailabilitySnapshot => ({ id: `${key}|AR`, key, country: 'AR', status: 'ok', source: 'test', checkedAt: Date.now(),
    offers: ids.map((id) => ({ providerId: id, providerName: id === 8 ? 'Netflix' : 'Max', platform: id === 8 ? 'netflix' : 'max', kind: 'flatrate' })) });
  const c = (m: TitleMeta, prov: number[], rating?: Partial<Rating>): Candidate => ({ meta: m, snap: snap(m.key, prov), rating: rating ? R(m.key, undefined, {}, rating) : undefined });
  const scifiTv2018 = c(mk(1, { type: 'tv', genres: [10765], year: 2018, runtime: 50 }), [8]);
  const scifiTv2012 = c(mk(2, { type: 'tv', genres: [10765], year: 2012 }), [8]);
  const horrorMovie = c(mk(3, { genres: [27], year: 2019, runtime: 90 }), [1899]);
  const horrorOld = c(mk(4, { genres: [27, 35], year: 2005, runtime: 140 }), [8], { watched: true });
  const all = [scifiTv2018, scifiTv2012, horrorMovie, horrorOld];
  const pass = (f: Partial<typeof DEFAULT_FILTERS>) => all.filter((x) => matchesAll(x, { ...DEFAULT_FILTERS, watched: 'all', ...f })).map((x) => x.meta.tmdbId);
  it('combina tipo, género, años y plataforma', () => {
    expect(pass({ types: ['movie'], includeGenres: [27] })).toEqual([3, 4]); // «sólo películas de terror»
    expect(pass({ types: ['movie'], yearMin: 2010 })).toEqual([3]); // «desde 2010»
    expect(pass({ types: ['tv'], includeGenres: [10765], yearMin: 2015, platforms: ['netflix'] })).toEqual([1]);
    expect(pass({ excludeGenres: [35] })).toEqual([1, 2, 3]);
    expect(pass({ runtimeMax: 95 })).toEqual([1, 3]);
    const noRuntime = c({ ...mk(5, { genres: [27] }), runtime: undefined }, [8]);
    expect(matchesAll(noRuntime, { ...DEFAULT_FILTERS, runtimeMax: 95 })).toBe(true); // sin dato de duración no se descarta
  });
  it('respeta el filtro de vistos y la afinidad mínima', () => {
    expect(all.filter((x) => matchesAll(x, { ...DEFAULT_FILTERS })).map((x) => x.meta.tmdbId)).toEqual([1, 2, 3]);
    expect(all.filter((x) => matchesAll(x, { ...DEFAULT_FILTERS, watched: 'watched' })).map((x) => x.meta.tmdbId)).toEqual([4]);
    expect(matchesAll({ ...horrorMovie, score: 6.9 }, { ...DEFAULT_FILTERS, minScore: 7 })).toBe(false);
  });
  it('indica qué filtros restringen cuando no hay resultados', () => {
    const f = { ...DEFAULT_FILTERS, watched: 'all' as const, types: ['tv' as const], includeGenres: [27] };
    expect(all.filter((x) => matchesAll(x, f))).toHaveLength(0);
    const d = diagnose(all, f);
    expect(d.map((x) => x.id)).toEqual(expect.arrayContaining(['types', 'includeGenres']));
  });
  it('predeterminado = recomendaciones generales; contar filtros activos', () => {
    expect(isGeneral(DEFAULT_FILTERS)).toBe(true);
    expect(activeCount({ ...DEFAULT_FILTERS, yearMin: 2010, platforms: ['netflix'], watched: 'all' })).toBe(3);
    expect(matchesContent(scifiTv2018, DEFAULT_FILTERS)).toBe(true);
  });
  it('un filtro temporal no altera lo aprendido', async () => {
    useTestDb(`filt-${Date.now()}`); await ensureBootstrap();
    await updateSettings(P, { excludedGenres: [] });
    const before = await getSettings(P);
    // Los filtros viven fuera de los ajustes del perfil (localStorage del dispositivo)
    expect(Object.keys(before)).not.toContain('filters');
  });
});

// ---------- 15. Completitud ----------
describe('15. Porcentaje de aspectos completados', () => {
  it('aspectos / 7 × 100, sin contar la general ni «Otros»', () => {
    const r = (n: number) => ({ dimensions: Object.fromEntries(['story', 'acting', 'ending', 'emotion', 'visuals', 'pacing', 'suspense'].slice(0, n).map((d) => [d, 3])) });
    expect([0, 3, 5, 7].map((n) => aspectCompletion(r(n)).percent)).toEqual([0, 43, 71, 100]);
    expect(aspectCompletion({ ...R('movie:1', 9, { story: 4 }, { comment: 'x' }) }).percent).toBe(14);
  });
  it('filtra y ordena por completitud', () => {
    const rs = [R('movie:1', 8, { story: 4 }), R('movie:2', 7, { story: 4, acting: 4, ending: 4, emotion: 4, visuals: 4, pacing: 4, suspense: 4 }), R('movie:3', 6)];
    expect(rs.filter((r) => matchesView(r, 'complete')).map((r) => r.key)).toEqual(['movie:2']);
    expect(rs.filter((r) => matchesView(r, 'incomplete')).map((r) => r.key)).toEqual(['movie:1', 'movie:3']);
    expect(sortRatings(rs, 'completion-desc', () => '').map((r) => r.key)).toEqual(['movie:2', 'movie:1', 'movie:3']);
    expect(sortRatings(rs, 'completion-asc', () => '')[0].key).toBe('movie:3');
  });
});

// ---------- 17. Compatibilidad con TMDB ----------
describe('17. TMDB', () => {
  it('mapea colección, orden del reparto y versión de ficha', () => {
    const m = mapDetails({ id: 299534, title: 'Avengers: Endgame', release_date: '2019-04-24', genres: [{ id: 28, name: 'Acción' }], belongs_to_collection: { id: 86311, name: 'The Avengers Collection' },
      credits: { cast: [{ id: 2, name: 'B', order: 1 }, { id: 1, name: 'A', order: 0 }], crew: [] }, keywords: { keywords: [{ id: 9715, name: 'superhero' }] } }, 'movie', 'es-MX');
    expect(m.collection).toEqual({ id: 86311, name: 'The Avengers Collection' });
    expect(m.cast.map((c) => c.id)).toEqual([1, 2]);
    expect(m.metaVersion).toBe(3);
  });
  it('el proxy sigue limitando rutas (los parámetros nuevos de discover son sólo de filtrado)', () => {
    expect(ALLOWED_PATH.test('/discover/movie')).toBe(true);
    expect(ALLOWED_PATH.test('/account')).toBe(false);
  });
});

it('escribe el informe de escenarios v2.1', () => {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/v21-scenarios.json', JSON.stringify({ aviso: 'Escenarios sintéticos construidos a mano: muestran cómo responde el motor, no validan su precisión con usuarios reales.', escenarios: report }, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 2));
  expect(Object.keys(report).length).toBeGreaterThanOrEqual(7);
});
