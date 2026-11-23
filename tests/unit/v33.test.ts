/**
 * Pruebas de Cine Match v3.3: filtro de texto libre (reglas), público objetivo, regiones y países.
 *
 * Casos 1-16 y 18: pruebas FUNCIONALES con fichas armadas a mano y el proveedor SIMULADO. Verifican que las reglas
 * hacen lo que dicen; no miden si la clasificación de público es correcta en el mundo real.
 * Al final hay un DIAGNÓSTICO con datos reales (catálogo + señales de TMDB del repositorio) contra etiquetas que
 * asignó el desarrollador a 36 títulos conocidos: es una comparación con un criterio propio, no una validación.
 * Los casos 17 (rendimiento en Android) y 19 (compatibilidad con TMDB real) están en tests/e2e/v33.spec.ts y
 * tests/prod/v33.spec.ts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, useTestDb } from '../../src/db/db';
import { ensureBootstrap, listRatings, updateConfig, updateSettings } from '../../src/db/repo';
import { NarrativeIndex, type CatalogMeta } from '../../src/engine/narrative';
import { setFetch } from '../../src/services/catalog';
import { classifyAudience, matchesAudience, setAudienceData, type AudienceFilter, type AudienceId } from '../../src/services/audience';
import {
  activeFilters, audienceOf, contradictions, dataGaps, DEFAULT_FILTERS, filterLabel, loadFilters, matchesContent, saveFilters, without, withoutGroup, type RankFilters,
} from '../../src/services/filters';
import { metaFromCatalog, setNarrativeIndex } from '../../src/services/narrativeCatalog';
import { DEFAULT_WESTERN, expandRegions, loadWestern, regionCountries, regionsOfCountry, REGIONS, saveWestern } from '../../src/services/regions';
import { rateAndLearn } from '../../src/services/ratings';
import { resetRatingsStore } from '../../src/services/ratingsStore';
import { resetRecompute } from '../../src/services/recompute';
import { rankWithFilters, refreshRecommendations } from '../../src/services/recommendations';
import { condLabel, parseText, type ParsedText } from '../../src/services/textFilter';
import type { TitleKey, TitleMeta } from '../../src/types';
import { buildCatalog, countryOf, fakeFetch, type FakeTitle } from '../fixtures/fakeTmdb';

const P = 'p-principal';
const F = (o: Partial<RankFilters>): RankFilters => ({ ...DEFAULT_FILTERS, watched: 'all', ...o });
let n = 0;
const meta = (o: Partial<TitleMeta>): TitleMeta => ({
  key: `movie:${++n}` as TitleKey, type: 'movie', tmdbId: n, title: `T${n}`, genres: [], keywords: [], cast: [], directors: [], writers: [],
  completeness: 'full', missing: [], source: 't', fetchedAt: 0, metaVersion: 3, ...o,
});
const kw = (...names: string[]) => names.map((name, i) => ({ id: 9000 + i, name }));
const g = (...ids: number[]) => ids.map((id) => ({ id, name: `G${id}` }));
const ok = (t: TitleMeta, f: Partial<RankFilters>) => matchesContent({ meta: t }, F(f));
const labels = (p: ParsedText) => ({ inc: p.include.map(condLabel), exc: p.exclude.map((gr) => gr.map(condLabel)) });
const NOW = 2026;
const T = (s: string) => parseText(s, NOW);

// ═════════════ 1-5. Texto libre ═════════════
describe('v3.3 · texto libre (reglas, no comprensión del lenguaje)', () => {
  it('1. instrucciones simples: el ejemplo del pedido se convierte en condiciones explícitas', () => {
    const p = T('Películas de terror posteriores a 2015');
    expect(p.include).toEqual([{ k: 'type', v: 'movie' }, { k: 'genre', v: [27], name: 'Terror' }, { k: 'yearMin', v: 2016 }]);
    expect(p.exclude).toEqual([]);
    expect(p.unparsed).toEqual([]);
    expect(labels(T('Quiero un thriller adulto posterior a 2015')).inc).toEqual(['Género: Suspense', 'Público: Adulto (aprox.)', 'Año mínimo: 2016']);
    expect(labels(T('Series de ciencia ficción con viajes temporales')).inc).toEqual(['Tipo: serie', 'Género: Ciencia ficción', 'Tema: viajes en el tiempo (palabras clave de TMDB)']);
    const eu = T('Producciones europeas posteriores a 2010 con buena valoración pública');
    expect(labels(eu).inc).toEqual(['Región: Europa', 'Año mínimo: 2011', 'Nota TMDB: 7 o más']);
    expect(eu.notes.join(' ')).toMatch(/nota TMDB 7/); // se explica cómo se tradujo «buena valoración»
    expect(T('nota mayor a 7,5').include).toEqual([{ k: 'publicMin', v: 7.5 }]);
    expect(labels(T('dramas coreanos de los 90')).inc).toEqual(['Género: Drama', 'País: Corea del Sur', 'Año mínimo: 1990', 'Año máximo: 1999']);
  });

  it('2. negaciones: «sin», «excluir», «que no», «no quiero», «ni», «excepto»', () => {
    expect(labels(T('sin terror')).exc).toEqual([['Género: Terror']]);
    expect(labels(T('no quiero series')).exc).toEqual([['Tipo: serie']]);
    expect(T('no quiero series').include).toEqual([]);
    expect(labels(T('Excluir producciones significativamente enfocadas en público adolescente')).exc).toEqual([['Público: Adolescente / juvenil (aprox.)']]);
    const mis = T('Películas de misterio que no estén centradas en relaciones románticas');
    expect(labels(mis).inc).toEqual(['Tipo: película', 'Género: Misterio']);
    expect(labels(mis).exc).toEqual([['Tema: romance (palabras clave de TMDB)']]);
    expect(mis.notes.join(' ')).toMatch(/no se mide cuánto pesa en la trama/); // aproximación avisada
    // «ni» separa dos exclusiones independientes
    expect(labels(T('sin terror ni comedia')).exc).toEqual([['Género: Terror'], ['Género: Comedia']]);
    // «excepto» abre su propia cláusula negativa
    const eu = T('Incluir Europa, excepto España');
    expect(labels(eu)).toEqual({ inc: ['Región: Europa'], exc: [['País: España']] });
  });

  it('3. condiciones combinadas: «comedias románticas juveniles» excluye la combinación, no cada parte', () => {
    const p = T('Excluir comedias románticas juveniles');
    expect(p.exclude).toHaveLength(1);
    expect(labels(p).exc[0]).toEqual(['Género: Comedia', 'Género: Romance', 'Público: Adolescente / juvenil (aprox.)']);
    const teenRomcom = meta({ genres: g(35, 10749), keywords: kw('teen movie', 'high school') });
    const adultRomcom = meta({ genres: g(35, 10749), keywords: kw('marriage'), certifications: { US: 'R' } });
    const teenDrama = meta({ genres: g(18), keywords: kw('teen drama') });
    expect(ok(teenRomcom, { text: p })).toBe(false);
    expect(ok(adultRomcom, { text: p })).toBe(true); // comedia romántica, pero no juvenil
    expect(ok(teenDrama, { text: p })).toBe(true); // juvenil, pero no comedia romántica
    // Varias inclusiones en una misma clase = alcanza con una; clases distintas = todas
    const c = T('series coreanas o japonesas de ciencia ficción posteriores a 2015');
    const kr = meta({ type: 'tv', genres: g(10765), originCountry: ['KR'], year: 2019 });
    const jpOld = meta({ type: 'tv', genres: g(10765), originCountry: ['JP'], year: 2010 });
    const us = meta({ type: 'tv', genres: g(10765), originCountry: ['US'], year: 2019 });
    expect([ok(kr, { text: c }), ok(jpOld, { text: c }), ok(us, { text: c })]).toEqual([true, false, false]);
  });

  it('4. texto no interpretable: se informa lo que no se entendió y no se aplica', () => {
    const p = T('algo lindo para un domingo con onda');
    expect(p.include).toEqual([]);
    expect(p.exclude).toEqual([]);
    expect(p.unparsed).toEqual(['lindo domingo onda']);
    const mixed = T('películas de terror con mucha atmósfera opresiva');
    expect(labels(mixed).inc).toEqual(['Tipo: película', 'Género: Terror']);
    expect(mixed.unparsed.join(' ')).toMatch(/atmosfera opresiva/);
    // Categorías deshabilitadas, idioma y «asiático» se avisan; nunca se aplican en silencio
    expect(T('películas para mujeres').notes.join(' ')).toMatch(/deshabilitada/);
    expect(T('películas para mujeres').include).toEqual([{ k: 'type', v: 'movie' }]);
    expect(T('películas japonesas en inglés').notes.join(' ')).toMatch(/idioma no se usa como país/);
    const asia = T('películas asiáticas');
    expect(asia.include).toEqual([{ k: 'type', v: 'movie' }]);
    expect(asia.notes.join(' ')).toMatch(/ambiguo/);
    expect(T('').include).toEqual([]);
  });

  it('5. contradicciones: se avisan antes de aplicar y manda la exclusión', () => {
    expect(contradictions(F({}), T('películas de terror pero no de terror')).join(' ')).toMatch(/incluye y excluye/);
    expect(contradictions(F({}), T('películas y series de antes de 1990 después de 2000')).join(' ')).toMatch(/Años imposibles/);
    expect(contradictions(F({ types: ['tv'] }), T('películas de terror')).join(' ')).toMatch(/no puede haber resultados/);
    expect(contradictions(F({ excludeGenres: [27] }), T('películas de terror')).join(' ')).toMatch(/manda la exclusión/);
    expect(contradictions(F({ audience: { include: [], exclude: ['adult'] } }), T('thriller adulto')).join(' ')).toMatch(/excluye/);
    expect(contradictions(F({ excludeCountries: ['KR'] }), T('series coreanas')).join(' ')).toMatch(/excluidos/);
    expect(contradictions(F({ includeCountries: ['AR'] }), T('series coreanas')).join(' ')).toMatch(/no se superponen/);
    expect(contradictions(F({}), T('Películas de terror posteriores a 2015'))).toEqual([]);
    // al aplicar igual: la exclusión manda
    const horror = meta({ genres: g(27) });
    expect(ok(horror, { text: T('películas de terror pero no de terror') })).toBe(false);
    expect(ok(horror, { text: T('películas de terror'), excludeGenres: [27] })).toBe(false);
  });
});

// ═════════════ 6-10. Público objetivo ═════════════
describe('v3.3 · público objetivo', () => {
  const teenRom = meta({ genres: g(35, 10749), keywords: kw('teen movie', 'high school', 'teenage romance'), certifications: { US: 'PG-13' } });
  const adultTeenCast = meta({ genres: g(18), keywords: kw('coming of age', 'teenage girl', 'high school student', 'drug addiction'), certifications: { US: 'TV-MA' }, type: 'tv' });
  const crime = meta({ genres: g(80, 18), keywords: kw('mafia'), certifications: { US: 'R' } });
  const preschool = meta({ type: 'tv', genres: g(16, 10762, 10751), keywords: kw('kids', 'cartoon'), certifications: { US: 'TV-Y' } });
  const pixar = meta({ genres: g(16, 10751, 12), certifications: { US: 'G' } });
  const noData = meta({ genres: g(18), completeness: 'basic' });
  const weakTeen = meta({ genres: g(18), keywords: kw('high school', 'teenager'), certifications: { US: 'PG-13' } });
  const A = (inc: AudienceId[], exc: AudienceId[] = [], o: Partial<AudienceFilter> = {}): Partial<RankFilters> => ({ audience: { include: inc, exclude: exc, ...o } });

  it('6. incluir público adolescente: pasan las obras con etiqueta explícita de TMDB', () => {
    const s = classifyAudience(teenRom).scores.teen;
    expect(s.status).toBe('yes');
    expect(s.explicit).toBe(true);
    expect(s.evidence.some((e) => e.source === 'palabras clave de TMDB' && e.method === 'explícita')).toBe(true);
    expect(ok(teenRom, A(['teen']))).toBe(true);
    expect(ok(crime, A(['teen']))).toBe(false);
    expect(ok(noData, A(['teen']))).toBe(false); // sin datos no se afirma que coincida
  });

  it('7. excluir público adolescente: se quita sólo con evidencia suficiente', () => {
    expect(ok(teenRom, A([], ['teen']))).toBe(false);
    expect(ok(crime, A([], ['teen']))).toBe(true);
    expect(ok(noData, A([], ['teen']))).toBe(true); // sin datos: se mantiene (y se informa en dataGaps)
    expect(dataGaps([{ meta: noData }, { meta: crime }], F(A([], ['teen'])))?.noAudience).toBe(1);
  });

  it('8. protagonistas adolescentes en obras para adultos: no cuentan como público adolescente', () => {
    const p = classifyAudience(adultTeenCast);
    expect(p.scores.teen.status).not.toBe('yes');
    expect(p.scores.teen.evidence.map((e) => e.method)).toEqual(expect.arrayContaining(['protagonistas/ambiente', 'en contra']));
    expect(p.scores.adult.status).toBe('yes');
    expect(ok(adultTeenCast, A([], ['teen']))).toBe(true);
    // la clasificación por edad es auxiliar: PG-13 sola no hace juvenil a una obra
    expect(classifyAudience(meta({ genres: g(28), keywords: kw('superhero'), certifications: { US: 'PG-13' } })).scores.teen.status).toBe('no-evidence');
  });

  it('9. clasificaciones inciertas: umbral configurable y opción de contarlas', () => {
    const s = classifyAudience(weakTeen).scores.teen;
    expect(s.status).toBe('uncertain');
    expect(s.confidence).toBeGreaterThanOrEqual(0.2);
    expect(s.confidence).toBeLessThan(0.5);
    expect(ok(weakTeen, A([], ['teen']))).toBe(true); // incierta: se mantiene
    expect(ok(weakTeen, A([], ['teen'], { uncertainAsMatch: true }))).toBe(false);
    expect(ok(weakTeen, A(['teen']))).toBe(false);
    expect(ok(weakTeen, A(['teen'], [], { uncertainAsMatch: true }))).toBe(true);
    // umbral alto: una sola etiqueta explícita deja de alcanzar
    const one = meta({ genres: g(18), keywords: kw('teen drama') });
    expect(classifyAudience(one, [], 0.5).scores.teen.status).toBe('yes');
    expect(classifyAudience(one, [], 0.65).scores.teen.status).toBe('uncertain');
    expect(ok(one, A([], ['teen'], { threshold: 0.65 }))).toBe(true);
    // sin datos = desconocido, distinto de «sin evidencia»
    expect(classifyAudience(noData).scores.teen.status).toBe('unknown');
    expect(audienceOf(noData).hasData).toBe(false);
  });

  it('10. públicos superpuestos: infantil y familiar a la vez; incluir es «alguna», la exclusión manda', () => {
    const p = classifyAudience(preschool);
    expect(p.scores.kids.status).toBe('yes');
    expect(p.scores.family.status).toBe('yes');
    expect(p.scores.adult.status).toBe('no-evidence');
    expect(classifyAudience(pixar).scores.family.status).toBe('yes');
    expect(ok(preschool, A(['family']))).toBe(true);
    expect(ok(preschool, A(['family'], ['kids']))).toBe(false); // familiar pero también infantil: se excluye
    expect(ok(pixar, A(['family'], ['kids']))).toBe(true);
    expect(ok(teenRom, A(['kids', 'teen']))).toBe(true);
    // masculino/femenino: deshabilitadas, no filtran nada
    expect(classifyAudience(teenRom).scores.female.status).toBe('disabled');
    expect(matchesAudience(classifyAudience(teenRom), { include: ['female'], exclude: ['male'] })).toBe(true);
    // la animación para adultos no es infantil
    const adultAnim = meta({ type: 'tv', genres: g(16, 35), keywords: kw('adult animation'), certifications: { US: 'TV-14' } });
    expect(classifyAudience(adultAnim).scores.kids.status).toBe('no-evidence');
    expect(classifyAudience(adultAnim).scores.adult.status).toBe('yes');
  });
});

// ═════════════ 11-15. Regiones y países ═════════════
describe('v3.3 · regiones y países', () => {
  beforeEach(() => { localStorage.clear(); loadWestern(P); });
  const t = (o: string[], p: string[] = o) => meta({ originCountry: o, productionCountries: p });
  const es = t(['ES']); const fr = t(['FR']); const jp = t(['JP']); const kr = t(['KR']); const mx = t(['MX']); const us = t(['US']); const ir = t(['IR']); const eg = t(['EG']);
  const frEs = t(['FR'], ['FR', 'ES']); const usJp = t(['US'], ['US', 'JP']); const unknown = t([], []);

  it('11. regiones incluidas: la región se expande a países; no existe una «oriental» única', () => {
    expect(REGIONS.map((r) => r.id)).not.toContain('oriental');
    expect(ok(jp, { includeRegions: ['east-asia'] })).toBe(true);
    expect(ok(kr, { includeRegions: ['east-asia'] })).toBe(true);
    expect(ok(fr, { includeRegions: ['east-asia'] })).toBe(false);
    expect(ok(ir, { includeRegions: ['middle-east'] })).toBe(true);
    expect(ok(ir, { includeRegions: ['south-asia'] })).toBe(false); // decisión documentada: Irán en Medio Oriente
    expect(regionsOfCountry('EG')).toEqual(expect.arrayContaining(['africa', 'middle-east']));
    expect(ok(eg, { includeRegions: ['africa'] }) && ok(eg, { includeRegions: ['middle-east'] })).toBe(true);
    expect(ok(mx, { includeRegions: ['latam', 'europe'] })).toBe(true);
  });

  it('11b. «Occidental» está definido explícitamente y es editable por perfil', () => {
    expect(regionCountries('western')).toEqual(DEFAULT_WESTERN);
    expect(DEFAULT_WESTERN).toEqual(expect.arrayContaining(['US', 'CA', 'GB', 'FR', 'ES', 'AU', 'NZ']));
    expect(DEFAULT_WESTERN).not.toContain('MX');
    expect(ok(mx, { includeRegions: ['western'] })).toBe(false);
    saveWestern(P, [...DEFAULT_WESTERN, 'MX', 'AR']);
    expect(ok(mx, { includeRegions: ['western'] })).toBe(true);
    expect(loadWestern('otro-perfil')).toEqual(DEFAULT_WESTERN);
    expect(loadWestern(P)).toContain('MX');
  });

  it('12. regiones excluidas: se quita el título si participa un país de la región', () => {
    expect(ok(jp, { excludeRegions: ['east-asia'] })).toBe(false);
    expect(ok(us, { excludeRegions: ['east-asia'] })).toBe(true);
    expect(ok(usJp, { excludeRegions: ['east-asia'] })).toBe(false); // coproducción con Japón
  });

  it('13. países combinados con regiones: «Incluir Europa, excepto España»', () => {
    const f = { includeRegions: ['europe' as const], excludeCountries: ['ES'] };
    expect(ok(fr, f)).toBe(true);
    expect(ok(es, f)).toBe(false);
    expect(ok(frEs, f)).toBe(false); // coproducción con España: manda la exclusión
    expect(ok(us, f)).toBe(false);
    // lo mismo escrito como texto libre
    const txt = { text: T('Incluir Europa, excepto España') };
    expect([ok(fr, txt), ok(es, txt), ok(frEs, txt), ok(us, txt)]).toEqual([true, false, false, false]);
    // país incluido + región excluida que lo contiene: manda la exclusión
    expect(ok(fr, { includeCountries: ['FR'], excludeRegions: ['europe'] })).toBe(false);
    expect(expandRegions(['europe', 'western'])).toContain('US');
  });

  it('14. coproducciones: incluir = al menos un país; excluir = cualquier país; origen/producción respetados', () => {
    expect(ok(usJp, { includeRegions: ['east-asia'] })).toBe(true);
    expect(ok(usJp, { includeRegions: ['east-asia'], countryField: 'origin' })).toBe(false);
    expect(ok(usJp, { excludeRegions: ['east-asia'], countryField: 'origin' })).toBe(true);
    expect(ok(usJp, { includeRegions: ['western'], excludeRegions: ['east-asia'] })).toBe(false);
  });

  it('15. países desconocidos: no pasan una inclusión, no se quitan por una exclusión y se informan', () => {
    expect(ok(unknown, { includeRegions: ['europe'] })).toBe(false);
    expect(ok(unknown, { excludeRegions: ['europe'] })).toBe(true);
    expect(ok(unknown, { text: T('películas europeas') })).toBe(false);
    expect(ok(unknown, { text: T('sin producciones europeas') })).toBe(true);
    expect(dataGaps([{ meta: unknown }, { meta: fr }], F({ excludeRegions: ['europe'] }))?.noCountries).toBe(1);
  });
});

// ═════════════ 16 y 18. Persistencia y conservación de datos ═════════════
const catalog = buildCatalog(15);
const keyOf = (t: FakeTitle) => `${t.type}:${t.id}` as TitleKey;
async function freshDb(tag: string) {
  resetRecompute(); resetRatingsStore();
  useTestDb(`v33-${tag}-${Math.random().toString(36).slice(2)}`);
  setFetch(fakeFetch(catalog));
  await ensureBootstrap();
  await updateConfig({ tmdbToken: 'eyJtest' });
  await updateSettings(P, { platforms: ['netflix', 'prime', 'disney', 'max'], country: 'AR' });
}

describe('v3.3 · persistencia, grupos y conservación de datos', () => {
  beforeEach(() => freshDb('persist'));
  const full = () => F({
    text: T('Películas de terror posteriores a 2015'), audience: { include: ['adult'], exclude: ['teen'], threshold: 0.65, uncertainAsMatch: true },
    includeRegions: ['europe'], excludeRegions: ['east-asia'], excludeCountries: ['ES'], includeGenres: [27],
  });

  it('16. persistencia: texto interpretado, público y regiones se guardan y se recuperan', () => {
    const f = full();
    saveFilters(P, f);
    const back = loadFilters(P);
    expect(back).toEqual(f);
    expect(activeFilters(back)).toEqual(expect.arrayContaining(['text', 'includeAudience', 'excludeAudience', 'includeRegions', 'excludeRegions', 'excludeCountries', 'includeGenres']));
    // limpiar sólo el texto no toca lo demás
    const noText = without(back, 'text');
    expect(noText.text).toBeUndefined();
    expect(noText.audience).toEqual(f.audience);
    expect(noText.includeRegions).toEqual(['europe']);
    // limpiar un grupo entero
    const noPlaces = withoutGroup(back, 'places');
    expect([noPlaces.includeRegions ?? [], noPlaces.excludeRegions ?? [], noPlaces.excludeCountries ?? []]).toEqual([[], [], []]);
    expect(noPlaces.text).toEqual(f.text);
    expect(withoutGroup(back, 'audience').audience?.include ?? []).toEqual([]);
    // etiquetas del resumen
    const lab = (id: Parameters<typeof filterLabel>[0]) => filterLabel(id, back, (x) => `G${x}`, (x) => x);
    expect(lab('includeAudience')).toMatch(/aprox/);
    expect(lab('excludeRegions')).toMatch(/Asia oriental/);
    expect(lab('text')).toMatch(/terror/i);
  });

  it('integración: el ranking aplica región y texto con el proveedor simulado', async () => {
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    const base = await rankWithFilters(P, run, F({}), { discover: false });
    const cs = [...new Set(catalog.map(countryOf))];
    const target = cs.find((c) => regionsOfCountry(c).length) ?? cs[0];
    const region = regionsOfCountry(target)[0];
    const r = await rankWithFilters(P, run, F({ includeRegions: [region] }), { discover: false });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(base.items.length);
    // el simulador publica coproducciones con México en las películas de id múltiplo de 7
    for (const it of r.items) { const t = catalog.find((x) => keyOf(x) === it.key)!; const cs = [countryOf(t), ...(t.type === 'movie' && t.id % 7 === 0 ? ['MX'] : [])]; expect(cs.some((c) => regionCountries(region).includes(c))).toBe(true); }
    const rt = await rankWithFilters(P, run, F({ text: T('solo películas') }), { discover: false });
    expect(rt.items.every((i) => i.key.startsWith('movie:'))).toBe(true);
    expect(rt.dataGaps).toBeUndefined(); // el tipo no necesita datos que puedan faltar
  });

  it('18. filtrar por texto, público y regiones no modifica valoraciones ni ajustes', async () => {
    await rateAndLearn(P, keyOf(catalog[3]), { watched: true, overall: 8, dimensions: {} });
    await rateAndLearn(P, keyOf(catalog[4]), { watched: true, overall: 3, dimensions: {} });
    const before = JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.list, r.updatedAt]));
    const settingsBefore = JSON.stringify(await db.settings.toArray());
    const run = await refreshRecommendations(P, { trigger: 'apertura', rebuildPool: true });
    await rankWithFilters(P, run, full(), { discover: false });
    await rankWithFilters(P, run, F({ text: T('Excluir comedias románticas juveniles'), excludeRegions: ['western'] }), { discover: false });
    expect(JSON.stringify((await listRatings(P)).map((r) => [r.key, r.overall, r.watched, r.list, r.updatedAt]))).toBe(before);
    expect(JSON.stringify(await db.settings.toArray())).toBe(settingsBefore);
  });
});

// ═════════════ Diagnóstico con datos reales (no es validación) ═════════════
const MAN = 'public/catalog/manifest.json';
const man = existsSync(MAN) ? JSON.parse(readFileSync(MAN, 'utf8')) : undefined;
const haveReal = Boolean(man?.audience && existsSync(`public/catalog/${man.audience}`));
/**
 * Etiquetas del desarrollador (no de usuarios ni de una fuente externa), fijadas antes de mirar el resultado:
 * público al que la obra está dirigida principalmente, según su comercialización conocida. null = discutible.
 */
const LABELS: Record<string, { title: string; teen: boolean | null; kids: boolean | null; adult: boolean | null }> = {
  'tv:85552': { title: 'Euphoria', teen: false, kids: false, adult: true },
  'tv:66732': { title: 'Stranger Things', teen: null, kids: false, adult: null },
  'movie:10625': { title: 'Chicas pesadas', teen: true, kids: false, adult: false },
  'movie:466282': { title: 'A todos los chicos…', teen: true, kids: false, adult: false },
  'tv:81356': { title: 'Sex Education', teen: null, kids: false, adult: null },
  'tv:69050': { title: 'Riverdale', teen: true, kids: false, adult: false },
  'tv:82728': { title: 'Bluey', teen: false, kids: true, adult: false },
  'movie:862': { title: 'Toy Story', teen: false, kids: true, adult: false },
  'movie:109445': { title: 'Frozen', teen: false, kids: true, adult: false },
  'movie:238': { title: 'El Padrino', teen: false, kids: false, adult: true },
  'tv:1396': { title: 'Breaking Bad', teen: false, kids: false, adult: true },
  'tv:1395': { title: 'Gossip Girl', teen: true, kids: false, adult: false },
  'tv:76669': { title: 'Élite', teen: true, kids: false, adult: null },
  'movie:8966': { title: 'Crepúsculo', teen: true, kids: false, adult: false },
  'movie:70160': { title: 'Los juegos del hambre', teen: true, kids: false, adult: false },
  'tv:93405': { title: 'El juego del calamar', teen: false, kids: false, adult: true },
  'movie:2108': { title: 'El club de los cinco', teen: true, kids: false, adult: false },
  'movie:105': { title: 'Volver al futuro', teen: null, kids: false, adult: false },
  'tv:1668': { title: 'Friends', teen: false, kids: false, adult: null },
  'movie:597': { title: 'Titanic', teen: null, kids: false, adult: null },
  'movie:496243': { title: 'Parásitos', teen: false, kids: false, adult: true },
  'tv:111803': { title: 'The White Lotus', teen: false, kids: false, adult: true },
  'tv:60625': { title: 'Rick y Morty', teen: false, kids: false, adult: true },
  'tv:1434': { title: 'Padre de familia', teen: false, kids: false, adult: true },
  'movie:12': { title: 'Buscando a Nemo', teen: false, kids: true, adult: false },
  'movie:155': { title: 'Batman: El caballero de la noche', teen: false, kids: false, adult: null },
  'movie:11036': { title: 'Diario de una pasión', teen: false, kids: false, adult: null },
  'movie:4951': { title: '10 cosas que odio de ti', teen: true, kids: false, adult: false },
  'tv:46648': { title: 'True Detective', teen: false, kids: false, adult: true },
  'movie:76341': { title: 'Mad Max: Furia en el camino', teen: false, kids: false, adult: true },
  'tv:119051': { title: 'Merlina', teen: true, kids: false, adult: false },
  'movie:313369': { title: 'La La Land', teen: false, kids: false, adult: null },
  'tv:71912': { title: 'The Witcher', teen: false, kids: false, adult: true },
  'tv:1399': { title: 'Juego de tronos', teen: false, kids: false, adult: true },
  'movie:12445': { title: 'Harry Potter 7.2', teen: true, kids: false, adult: false },
  'movie:671': { title: 'Harry Potter 1', teen: null, kids: true, adult: false },
};

describe.skipIf(!haveReal)('v3.3 · diagnóstico de público con datos reales del catálogo (criterio del desarrollador)', () => {
  afterAll(() => { setAudienceData(undefined); setNarrativeIndex(undefined); });
  it('compara la clasificación con 36 etiquetas propias y guarda el resultado', () => {
    const cm = JSON.parse(readFileSync(`public/catalog/${man.meta}`, 'utf8')) as CatalogMeta;
    const buf = readFileSync(`public/catalog/${man.emb}`);
    const idx = new NarrativeIndex(cm, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    setNarrativeIndex(idx);
    setAudienceData(JSON.parse(readFileSync(`public/catalog/${man.audience}`, 'utf8')));
    const rows: string[] = [];
    const tally: Record<string, { tp: number; fp: number; fn: number; tn: number; unc: number; skip: number }> = {};
    for (const [key, lab] of Object.entries(LABELS)) {
      const m = metaFromCatalog(idx, key as TitleKey, new Map());
      expect(m, key).toBeDefined();
      const p = audienceOf(m!);
      const cells: string[] = [];
      for (const id of ['teen', 'kids', 'adult'] as const) {
        const s = p.scores[id];
        const want = lab[id];
        const t = (tally[id] ??= { tp: 0, fp: 0, fn: 0, tn: 0, unc: 0, skip: 0 });
        if (want === null) t.skip++;
        else if (s.status === 'uncertain') t.unc++;
        else if (s.status === 'yes') want ? t.tp++ : t.fp++;
        else want ? t.fn++ : t.tn++;
        cells.push(`${s.status === 'yes' ? 'sí' : s.status === 'uncertain' ? 'incierto' : s.status === 'unknown' ? 'sin datos' : 'no'} ${s.confidence.toFixed(2)} (esperado: ${want === null ? 'discutible' : want ? 'sí' : 'no'})`);
      }
      rows.push(`| ${lab.title} | ${cells.join(' | ')} |`);
    }
    const sum = Object.entries(tally).map(([id, t]) => `- ${id}: aciertos sí ${t.tp}, falsos sí ${t.fp}, sí no detectados ${t.fn}, aciertos no ${t.tn}, inciertos ${t.unc}, discutibles ${t.skip}`).join('\n');
    writeFileSync('docs/audience-agreement.md', `# Diagnóstico de público objetivo (${p0()})\n\nCompara las reglas ${'`'}público-1.0${'`'} (umbral 0,5) con etiquetas que asignó el desarrollador a 36 títulos conocidos.\n**No es una validación de precisión**: las etiquetas no vienen de usuarios ni de una fuente independiente, y la muestra es chica y elegida a mano.\n\n${sum}\n\n| Título | Adolescente | Infantil | Adulto |\n|---|---|---|---|\n${rows.join('\n')}\n`);
    console.log(sum);
    // Guardas mínimas (de comportamiento, no de precisión): ninguna obra para adultos marcada como infantil o juvenil
    expect(tally.kids.fp).toBe(0);
    expect(tally.teen.fp).toBe(0);
    function p0() { return `catálogo ${man.version}, señales ${man.audience.split('/').pop()}`; }
  });
});

