import { describe, expect, it } from 'vitest';
import { NarrativeIndex, buildRefProfile, facetsFromKeywords, narrativeFromMeta, pairSimilarity, scoreMulti, similarityPercent, weakKind, type CatalogMeta } from '../../src/engine/narrative';
import { chooseTrailer } from '../../src/services/trailers';
import { countriesOf, matchesContent, DEFAULT_FILTERS, activeFilters } from '../../src/services/filters';
import { queryVariants } from '../../src/services/catalog';
import { sortRows } from '../../src/pages/Home';
import { PLATFORMS } from '../../src/constants';
import { platformOf } from '../../src/providers/tmdb';
import type { RecommendationItem, TitleKey, TitleMeta } from '../../src/types';

// Índice sintético pequeño: vectores de 4 dimensiones construidos a mano (NO es el modelo real; prueba la fórmula)
const DIM = 4;
function mkIndex(rows: { key: TitleKey; v: number[]; kw: [number, string][]; genres?: number[]; facets?: [string, number][]; collection?: number; people?: number[] }[], extraDocs = 200): NarrativeIndex {
  const kwNames: Record<string, string> = {};
  const df: CatalogMeta['df'] = { kw: {}, facet: {}, genre: {} };
  for (const r of rows) for (const [id, n] of r.kw) { kwNames[id] = n; df.kw[id] = (df.kw[id] ?? 0) + 1; }
  // palabras genéricas muy frecuentes en el «catálogo»
  df.kw[1] = 150; df.kw[2] = 120;
  const meta: CatalogMeta = {
    version: 'test', model: 'sintético', dim: DIM, embedded: rows.length, n: rows.length + extraDocs, semZ: 2.3,
    calib: { p50: 0.2, p90: 0.5, p99: 0.7, p999: 0.85, mean: 0.2 }, sources: {}, df, kwNames,
    titles: rows.map((r) => {
      const facets = r.facets ?? [...facetsFromKeywords(r.kw.map(([, n]) => n))].map(([id, e]) => [id, e.conf, e.kw, 0]);
      return [r.key, r.key, 2020, r.genres ?? [18], r.kw.map(([id]) => id), ['US'], 'en', r.collection ?? 0, r.people ?? [], [], [], 7, 500, 10, '', facets, 2, 800, [], 0, 0];
    }),
  };
  const emb = new Int8Array(rows.length * DIM);
  rows.forEach((r, i) => { const n = Math.hypot(...r.v); r.v.forEach((x, j) => { emb[i * DIM + j] = Math.round((x / n) * 127); }); });
  return new NarrativeIndex(meta, emb);
}

const SECRETS: [number, string][] = [[10, 'secrets'], [11, 'class conflict'], [12, 'dark comedy'], [13, 'whodunit'], [14, 'luxury resort'], [15, 'satire']];
const idx = mkIndex([
  { key: 'tv:1', v: [1, 0.1, 0, 0], kw: [...SECRETS, [1, 'based on novel or book'], [2, 'italy']] },
  { key: 'tv:2', v: [0.95, 0.2, 0.05, 0], kw: [[10, 'secrets'], [11, 'class conflict'], [12, 'dark comedy'], [16, 'dinner party']] },
  { key: 'tv:3', v: [0, 0, 1, 0.1], kw: [[1, 'based on novel or book'], [2, 'italy'], [17, 'zombie']] },
  { key: 'tv:4', v: [0.2, 1, 0, 0], kw: [[18, 'infidelity'], [19, 'temptation'], [20, 'couples']] },
  { key: 'tv:5', v: [0.6, 0.75, 0, 0], kw: [[10, 'secrets'], [18, 'infidelity'], [12, 'dark comedy']] },
  { key: 'movie:6', v: [0.99, 0.1, 0, 0], kw: [...SECRETS], collection: 77 },
  { key: 'movie:7', v: [0.98, 0.12, 0, 0], kw: [...SECRETS], collection: 77 },
  { key: 'tv:8', v: [0.5, 0.5, 0.5, 0.5], kw: [] },
]);
const n = (k: TitleKey) => idx.narrativeOf(k)!;

describe('v3.1 · similitud narrativa', () => {
  it('ninguna coincidencia entre títulos distintos llega a 100 %; 100 % queda para la identidad', () => {
    const s = pairSimilarity(n('movie:6'), n('movie:7'), idx);
    expect(s.score).toBeLessThan(1);
    expect(similarityPercent(s.score)).toBeLessThanOrEqual(99);
    expect(similarityPercent(1, true)).toBe(100);
  });
  it('compartir sólo etiquetas débiles (basada en un libro, Italia) da similitud baja', () => {
    const s = pairSimilarity(n('tv:1'), n('tv:3'), idx);
    expect(s.score).toBeLessThan(0.2);
    expect(s.weak.map((w) => w.name)).toEqual(expect.arrayContaining(['based on novel or book', 'italy']));
    expect(s.keywords).toHaveLength(0);
    expect(weakKind('Sicily')).toBe('geo');
    expect(weakKind('sicily, italy')).toBe('geo');
    expect(weakKind('stockholm archipelago')).toBe('geo');
    expect(weakKind('class conflict')).toBeUndefined();
    expect(weakKind('based on novel or book')).toBe('generic');
    expect(weakKind('class conflict')).toBeUndefined();
  });
  it('rasgos narrativos documentados compartidos pesan mucho más que el género', () => {
    const narr = pairSimilarity(n('tv:1'), n('tv:2'), idx);
    const genreOnly = pairSimilarity(n('tv:1'), n('tv:4'), idx);
    expect(narr.score).toBeGreaterThan(genreOnly.score + 0.3);
    expect(narr.facets.map((f) => f.id)).toEqual(expect.arrayContaining(['sec.secrets', 'conf.class', 'tone.dark-comedy']));
  });
  it('un candidato casi sin datos no recibe una similitud exagerada', () => {
    const s = pairSimilarity(n('tv:1'), n('tv:8'), idx);
    const thin = narrativeFromMeta({ key: 'tv:99', type: 'tv', tmdbId: 99, title: 'x', genres: [{ id: 18, name: 'Drama' }], keywords: [], cast: [], directors: [], completeness: 'basic', missing: [], source: '', fetchedAt: 0 } as TitleMeta);
    expect(pairSimilarity(n('tv:1'), thin, idx).score).toBeLessThan(0.1);
    expect(s.evidence).toBeLessThan(pairSimilarity(n('tv:1'), n('tv:2'), idx).evidence);
  });
  it('misma saga se detecta (para no monopolizar resultados)', () => {
    expect(pairSimilarity(n('movie:6'), n('movie:7'), idx).sameFranchise).toBe(true);
    expect(pairSimilarity(n('tv:1'), n('tv:2'), idx).sameFranchise).toBe(false);
  });
  it('rasgos a partir de palabras clave llevan procedencia y confianza; sin palabras clave no se inventan', () => {
    const f = facetsFromKeywords(['class conflict', 'whodunit']);
    expect(f.get('conf.class')).toMatchObject({ kw: ['class conflict'] });
    expect(f.get('conf.class')!.conf).toBeGreaterThan(0.5);
    expect(facetsFromKeywords([]).size).toBe(0);
  });
});

describe('v3.1 · varias referencias: En común vs Combinar', () => {
  const refs = [{ n: n('tv:1'), weight: 1 }, { n: n('tv:4'), weight: 1 }];
  const prof = buildRefProfile(refs, idx);
  it('Combinar premia mezclar rasgos de distintas referencias', () => {
    const mix = scoreMulti(refs, prof, n('tv:5'), 'combine', idx); // secretos + infidelidad
    const onlyOne = scoreMulti(refs, prof, n('tv:2'), 'combine', idx); // sólo como la primera
    expect(mix.score).toBeGreaterThan(onlyOne.score);
  });
  it('En común exige parecido con todas: un candidato parecido sólo a una baja', () => {
    const c1 = scoreMulti(refs, prof, n('tv:2'), 'common', idx);
    const c2 = scoreMulti(refs, prof, n('tv:5'), 'common', idx);
    expect(c2.score).toBeGreaterThan(c1.score);
  });
  it('la importancia de una referencia cambia el resultado', () => {
    const heavy = [{ n: n('tv:1'), weight: 2 }, { n: n('tv:4'), weight: 0.5 }];
    const p2 = buildRefProfile(heavy, idx);
    expect(scoreMulti(heavy, p2, n('tv:2'), 'combine', idx).score).toBeGreaterThan(scoreMulti(refs, prof, n('tv:2'), 'combine', idx).score);
  });
  it('perfil: rasgos distintivos por referencia y contrastes entre referencias', () => {
    expect(prof.distinctive.get('tv:1')!.length).toBeGreaterThan(0);
    expect(prof.contrasts.length).toBeGreaterThan(0);
  });
});

describe('v3.1 · orden estricto «Para vos»', () => {
  const item = (key: TitleKey, score: number, rank: number) => ({ key, item: { key, score, rank } as RecommendationItem, meta: undefined });
  it('ordena globalmente por la puntuación (también después de «Ver más»), aunque el motor haya diversificado', () => {
    const engineOrder = [item('tv:1', 7.5, 1), item('tv:2', 7.4, 2), item('tv:3', 7.3, 3), item('tv:4', 7.52, 4), item('tv:5', 6.1, 5), item('tv:6', 7.46, 6)];
    const sorted = sortRows(engineOrder, 'affinity', 'desc');
    const shown = sorted.map((r) => Math.round(r.item.score * 10) / 10);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeLessThanOrEqual(shown[i - 1]);
    // primera «página» de 3 y la siguiente: el orden se mantiene entre páginas
    expect(Math.min(...sorted.slice(0, 3).map((r) => r.item.score))).toBeGreaterThanOrEqual(Math.max(...sorted.slice(3).map((r) => r.item.score)));
    expect(sortRows(engineOrder, 'recommended', 'desc').map((r) => r.key)).toEqual(engineOrder.map((r) => r.key));
  });
  it('los títulos con información insuficiente («—») van al final, no intercalados', () => {
    const rows = [item('tv:1', 7.5, 1), { key: 'tv:9' as TitleKey, item: { key: 'tv:9', score: 8.9, rank: 2, confidence: 0.05 } as RecommendationItem, meta: undefined }, item('tv:2', 7.1, 3)];
    expect(sortRows(rows, 'affinity', 'desc').map((r) => r.key)).toEqual(['tv:1', 'tv:2', 'tv:9']);
  });
});

describe('v3.1 · tráileres', () => {
  const v = (o: Partial<Parameters<typeof chooseTrailer>[0][number]>) => ({ key: 'k' + Math.random(), site: 'YouTube' as const, name: 'Trailer', type: 'Trailer', official: true, ...o });
  it('prioriza audio en español, luego subtitulado, luego idioma original, luego otro avance', () => {
    expect(chooseTrailer([v({ language: 'en' }), v({ language: 'es', name: 'Tráiler Oficial [Subtitulado]' }), v({ language: 'es', name: 'Tráiler oficial doblado' })], 'en')!.rank).toBe(1);
    expect(chooseTrailer([v({ language: 'en' }), v({ language: 'es', name: 'Tráiler Oficial [Subtitulado]' })], 'en')!.rank).toBe(2);
    const orig = chooseTrailer([v({ language: 'en' })], 'en')!;
    // v3.2: el original pasa a 4, el avance a 5 y el tráiler no oficial en español a 3
    expect(orig.rank).toBe(4);
    expect(orig.audio).toMatch(/no confirmados/);
    expect(chooseTrailer([v({ language: 'en', type: 'Teaser' })], 'en')!.rank).toBe(5);
    expect(chooseTrailer([v({ language: 'es', official: false })], 'en')!.rank).toBe(3);
    expect(chooseTrailer([], 'en')).toBeUndefined();
    expect(orig.embedUrl).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//);
  });
});

describe('v3.1 · países, Paramount+ y búsqueda', () => {
  const t = (o: Partial<TitleMeta>) => ({ key: 'movie:1', type: 'movie', tmdbId: 1, title: 'x', genres: [], keywords: [], cast: [], directors: [], completeness: 'full', missing: [], source: '', fetchedAt: 0, ...o }) as TitleMeta;
  it('excluir México quita también coproducciones; sin país conocido se mantiene; incluir exige país', () => {
    const f = { ...DEFAULT_FILTERS, excludeCountries: ['MX'] };
    expect(matchesContent({ meta: t({ originCountry: ['US'], productionCountries: ['US', 'MX'] }) }, f)).toBe(false);
    expect(matchesContent({ meta: t({ originCountry: ['ES'] }) }, f)).toBe(true);
    expect(matchesContent({ meta: t({}) }, f)).toBe(true);
    expect(matchesContent({ meta: t({}) }, { ...DEFAULT_FILTERS, includeCountries: ['ES'] })).toBe(false);
    expect(countriesOf(t({ originCountry: ['US'], productionCountries: ['GB'] }))).toEqual(['US', 'GB']);
    expect(activeFilters(f)).toContain('excludeCountries');
  });
  it('Paramount+ usa el proveedor 531 y no se confunde con Paramount Network ni con el canal de Amazon', () => {
    expect(PLATFORMS.find((p) => p.id === 'paramount')!.tmdbIds).toEqual([531]);
    expect(platformOf(531, 'Paramount Plus')).toBe('paramount');
    expect(platformOf(582, 'Paramount+ Amazon Channel')).toBeNull();
    expect(platformOf(1748, 'Paramount Network')).toBeNull();
  });
  it('la búsqueda tolera variantes de escritura', () => {
    expect(queryVariants('Leonardo  DiCáprio')).toEqual(expect.arrayContaining(['Leonardo DiCáprio', 'Leonardo DiCaprio']));
    expect(queryVariants('Michael J. Fox')).toContain('Michael J Fox');
  });
});
