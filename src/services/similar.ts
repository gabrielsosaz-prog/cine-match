import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { getSettings, listRatings } from '../db/repo';
import {
  buildRefProfile, confidenceLabel, narrativeFromMeta, scoreMulti, similarityPercent, weakKind,
  type CoreFeature, type MultiScore, type Narrative, type NarrativeIndex, type RefIn, type SimilarMode,
} from '../engine/narrative';
import { SPOILER_PATTERN, keywordLabel } from '../engine/keywordsEs';
import { friendlyError } from '../providers/errors';
import type { RecommendationItem, TitleKey, TitleMeta } from '../types';
import { matchesPlatforms } from './availability';
import { discoverCandidates, ensureFullTitles, genreNames, getTitle } from './catalog';
import { countriesOf, matchesContent, matchesWatched, smartNeeds, type Candidate, type RankFilters } from './filters';
import { loadAudienceData } from './audience';
import { loadWestern } from './regions';
import { loadNarrativeIndex, metaFromCatalog, narrativeCatalogError } from './narrativeCatalog';
import { latestRun, predictFor } from './recommendations';
import { peopleSets } from './peopleFilter';

/**
 * Sección «Similares» (v3.1): títulos parecidos a 1-5 referencias, por coincidencias NARRATIVAS relevantes.
 *
 * Etapa 1 (recuperación amplia): todo el catálogo narrativo precalculado (miles de títulos con vector semántico y
 * rasgos), más relacionados de TMDB, descubrimiento por las palabras clave más distintivas (no las genéricas),
 * por creadores/guionistas y tu conjunto de candidatos.
 * Etapa 2 (reordenamiento): similitud narrativa con cada referencia (engine/narrative), agregada según el modo
 * («En común» o «Combinar») y la importancia de cada referencia; filtros, disponibilidad y afinidad personal.
 *
 * Similitud ≠ afinidad ≠ calidad pública: se calculan y muestran por separado. La popularidad no entra en la similitud.
 */
export const MAX_REFS = 5;
export type RefWeight = 0.5 | 1 | 2;

export interface SimilarExplanation {
  /** coincidencias relevantes (rasgos y temáticas específicas), con las referencias con que coinciden */
  strong: { text: string; refs: TitleKey[]; source: string }[];
  semantic?: { text: string; refs: TitleKey[] };
  people: string[];
  /** coincidencias débiles: sólo información secundaria */
  weak: string[];
  differences: string[];
  evidence: string;
}

export interface SimilarResult {
  key: TitleKey;
  /** 0-1 absoluto (no relativo al mejor) */
  similarity: number;
  percent: number;
  confidence: 'alta' | 'media' | 'baja';
  perRef: { key: TitleKey; percent: number }[];
  affinity?: RecommendationItem;
  explanation: SimilarExplanation;
  sameFranchise: boolean;
  franchise?: string;
  inCatalog: boolean;
  /** orden «Relevancia»: similitud (y afinidad si hay historial) con variedad */
  order: number;
  /** compatibilidad v3.0 */
  rawSimilarity: number;
  tmdbRelated: TitleKey[];
}

export interface SimilarResponse {
  results: SimilarResult[];
  mode: SimilarMode;
  personalized: boolean;
  ratedCount: number;
  candidates: number;
  semantic: { available: boolean; refsWithVector: number; catalog?: string; model?: string; titles?: number };
  profile: { core: { label: string; refs: TitleKey[] }[]; distinctive: { key: TitleKey; labels: string[] }[]; contrasts: string[] };
  warning?: string;
  timing: { ms: number };
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
const normTitle = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();

export async function findSimilar(profileId: string, refKeys: TitleKey[], f: RankFilters, o: { onlyMyPlatforms?: boolean; mode?: SimilarMode; weights?: Partial<Record<TitleKey, RefWeight>> } = {}): Promise<SimilarResponse> {
  const t0 = Date.now();
  loadWestern(profileId);
  const mode = o.mode ?? 'common';
  const refsIn = [...new Set(refKeys)].slice(0, MAX_REFS);
  const settings = await getSettings(profileId);
  const opts = { language: settings.language, country: settings.country };
  const ratings = await listRatings(profileId);
  const byKey = new Map(ratings.map((r) => [r.key, r]));
  let warning: string | undefined;
  const empty = (w: string): SimilarResponse => ({ results: [], mode, personalized: false, ratedCount: 0, candidates: 0, semantic: { available: false, refsWithVector: 0 }, profile: { core: [], distinctive: [], contrasts: [] }, warning: w, timing: { ms: Date.now() - t0 } });

  // 1) Referencias + catálogo narrativo (en paralelo)
  const [refMetasRaw, idx, names] = await Promise.all([
    Promise.all(refsIn.map(async (k) => { const r = await getTitle(k, opts); if (r.error) warning ??= friendlyError(r.error); return r.meta; })),
    withTimeout(loadNarrativeIndex(), 12000),
    genreNames(settings.language).catch(() => new Map<number, string>()),
  ]);
  const refMetas = refMetasRaw.filter((m): m is TitleMeta => Boolean(m));
  if (!refMetas.length) return empty(warning ?? 'No se pudieron cargar los títulos de referencia.');
  if (!idx) warning ??= `No se pudo cargar el catálogo narrativo (${narrativeCatalogError() ?? 'sin conexión'}): la similitud usa sólo rasgos de TMDB, con menos precisión.`;
  const refs = new Set(refMetas.map((m) => m.key));
  const narr = (k: TitleKey, m?: TitleMeta): Narrative | undefined => (idx ? idx.narrativeOf(k, m) : m ? narrativeFromMeta(m) : undefined);
  const refIn: RefIn[] = refMetas.map((m) => {
    const n = narr(m.key, m)!;
    // Si la ficha trae palabras clave que el catálogo no tiene, se suman (misma fuente: TMDB)
    for (const k of m.keywords) if (!n.kw.has(k.id)) n.kw.set(k.id, k.name);
    return { n, weight: o.weights?.[m.key] ?? 1 };
  });
  const prof = buildRefProfile(refIn, idx);

  // 2) Recuperación amplia de candidatos
  const cand = new Set<TitleKey>();
  const tmdbRel = new Map<TitleKey, TitleKey[]>();
  for (const m of refMetas) for (const k of m.related ?? []) { cand.add(k); tmdbRel.set(k, [...(tmdbRel.get(k) ?? []), m.key]); }
  let catalogTop: { key: TitleKey; s: MultiScore }[] = [];
  if (idx) {
    const scored: { key: TitleKey; s: MultiScore }[] = [];
    for (const c of idx.titles) {
      if (refs.has(c.key)) continue;
      const n = idx.narrativeOf(c.key)!;
      const s = scoreMulti(refIn, prof, n, mode, idx);
      if (s.score > 0.08) scored.push({ key: c.key, s });
    }
    catalogTop = scored.sort((a, b) => b.s.score - a.s.score).slice(0, 300);
    for (const x of catalogTop) cand.add(x.key);
  }
  // Descubrimiento en TMDB por lo distintivo (no por etiquetas genéricas ni lugares)
  const distinctiveKw = prof.core.filter((c) => c.kind === 'kw').slice(0, 5).map((c) => c.id);
  const perRefKw = refIn.flatMap((r) => [...r.n.kw].filter(([, n]) => !weakKind(n)).sort((a, b) => (idx ? idx.kwIdf(b[0]) - idx.kwIdf(a[0]) : 0)).slice(0, 2).map(([id]) => String(id)));
  const kw = [...new Set([...distinctiveKw, ...perRefKw])].slice(0, 6);
  const crew = [...new Set(refMetas.flatMap((m) => [...m.directors.slice(0, 1), ...(m.writers ?? []).slice(0, 1)].map((p) => p.id)))].slice(0, 4);
  const types = [...new Set(refMetas.map((m) => m.type))];
  const ids = o.onlyMyPlatforms === false ? [] : PLATFORMS.filter((p) => settings.platforms.includes(p.id)).flatMap((p) => p.tmdbIds);
  const jobs: Promise<unknown>[] = [];
  for (const type of types) {
    const base = { type, ...opts, providerIds: ids, sort: 'vote_average.desc', minVotes: 30 };
    if (kw.length) jobs.push(discoverCandidates({ ...base, extra: { with_keywords: kw.join('|') } }).then((r) => r.forEach((x) => cand.add(x.key))));
    if (type === 'movie' && crew.length) jobs.push(discoverCandidates({ ...base, extra: { with_crew: crew.join('|') } }).then((r) => r.forEach((x) => cand.add(x.key))));
  }
  const res = await Promise.allSettled(jobs);
  const failed = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) warning ??= friendlyError(failed.reason);
  const run = await latestRun(profileId);
  for (const k of run?.pool ?? []) cand.add(k);
  for (const k of refs) cand.delete(k);

  // 3) Fichas: las del dispositivo, y del catálogo para las que falten
  const loadMetas = async () => new Map((await db.titles.bulkGet([...cand])).filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
  let metas = await loadMetas();
  if (idx) {
    const add: TitleMeta[] = [];
    for (const k of cand) if (!metas.has(k)) { const m = metaFromCatalog(idx, k, names); if (m) { add.push(m); metas.set(k, m); } }
    if (add.length) await db.titles.bulkPut(add).catch(() => undefined);
  }
  const scoreAll = () => [...cand].filter((k) => metas.has(k)).map((k) => {
    const n = narr(k, metas.get(k))!;
    const pre = catalogTop.find((x) => x.key === k);
    return { key: k, s: pre && n.inCatalog ? pre.s : scoreMulti(refIn, prof, n, mode, idx), n };
  });
  let scored = scoreAll().sort((a, b) => b.s.score - a.s.score);
  // Ficha completa (palabras clave, créditos, disponibilidad) para los mejores
  const needFull = scored.filter((x) => metas.get(x.key)?.completeness !== 'full').slice(0, 45).map((x) => x.key);
  if (needFull.length) {
    try { await ensureFullTitles(needFull, opts, 45); } catch (e) { warning ??= friendlyError(e); }
    metas = await loadMetas();
    scored = scoreAll().sort((a, b) => b.s.score - a.s.score);
  }

  // 4) Filtros, disponibilidad y exclusiones
  const keys = scored.map((x) => x.key);
  const snaps = await db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`));
  const snapOf = new Map(keys.map((k, i) => [k, snaps[i]]));
  let people: Awaited<ReturnType<typeof peopleSets>>;
  try { people = await peopleSets(f, settings.language); } catch (e) { warning ??= friendlyError(e); }
  if (smartNeeds(f).audience) await loadAudienceData();
  const passing = scored.filter((x) => {
    if (people && (people.deny.has(x.key) || (people.allow && !people.allow.has(x.key)))) return false;
    let meta = metas.get(x.key)!;
    // Las listas de TMDB no traen el país de las películas: se completa con el catálogo narrativo si hace falta
    if (!countriesOf(meta).length && idx?.get(x.key)?.countries.length) meta = { ...meta, productionCountries: idx.get(x.key)!.countries };
    const c: Candidate = { meta, snap: snapOf.get(x.key), rating: byKey.get(x.key) };
    if (c.rating?.notInterested) return false;
    if (o.onlyMyPlatforms !== false && !matchesPlatforms(c.snap, settings.platforms, settings.includeUnconfirmed)) return false;
    return matchesContent(c, f) && matchesWatched(c, f);
  }).filter((x) => x.s.score >= 0.12).slice(0, 120);

  // 5) Afinidad personal separada
  const preds = await predictFor(profileId, passing.map((x) => x.key));
  const profileRated = ratings.filter((r) => r.overall !== undefined).length;
  const personalized = profileRated >= 5;
  const refTitle = new Map(refMetas.map((m) => [m.key, m.title]));
  let results: SimilarResult[] = passing.map((x) => {
    const m = metas.get(x.key)!;
    const fr = m.collection?.id ? `c${m.collection.id}` : m.type === 'tv' && m.directors[0] ? `p${m.directors[0].id}:${normTitle(m.title).slice(0, 8)}` : undefined;
    return {
      key: x.key, similarity: x.s.score, rawSimilarity: x.s.score, percent: similarityPercent(x.s.score), confidence: confidenceLabel(x.s.evidence),
      perRef: x.s.perRef.map((p) => ({ key: p.key as TitleKey, percent: similarityPercent(p.s.score) })),
      affinity: preds.get(x.key), explanation: explain(x.s, x.n, refIn, refTitle), sameFranchise: x.s.sameFranchise, franchise: fr,
      inCatalog: x.n.inCatalog, order: 0, tmdbRelated: tmdbRel.get(x.key) ?? [],
    };
  });
  if (f.minScore) results = results.filter((r) => (r.affinity?.score ?? 0) >= f.minScore!);
  for (const r of results) r.order = personalized && r.affinity ? 0.8 * r.similarity + 0.2 * ((r.affinity.score - 1) / 9) : r.similarity;
  results = diversify(results, idx);
  return {
    results, mode, personalized, ratedCount: profileRated, candidates: cand.size,
    semantic: { available: Boolean(idx?.emb), refsWithVector: refIn.filter((r) => r.n.row >= 0).length, catalog: idx?.meta.version, model: idx?.meta.model, titles: idx?.size },
    profile: {
      core: prof.core.filter((c) => c.kind === 'facet' || !SPOILER_PATTERN.test(c.label)).slice(0, 8).map((c) => ({ label: c.kind === 'kw' ? keywordLabel(c.label) : c.label, refs: c.refs as TitleKey[] })),
      distinctive: [...prof.distinctive].map(([k, list]) => ({ key: k as TitleKey, labels: list.filter((c) => !SPOILER_PATTERN.test(c.label)).slice(0, 4).map((c) => (c.kind === 'kw' ? keywordLabel(c.label) : c.label)) })),
      contrasts: prof.contrasts.map((c) => `${c.label}: en ${c.in.map((k) => refTitle.get(k as TitleKey) ?? k).join(', ')}, no en ${c.notIn.map((k) => refTitle.get(k as TitleKey) ?? k).join(', ')}`),
    },
    warning, timing: { ms: Date.now() - t0 },
  };
}

/** Variedad para el orden «Relevancia»: una saga no monopoliza los primeros puestos y se evita la redundancia semántica. */
export function diversify(results: SimilarResult[], idx?: NarrativeIndex): SimilarResult[] {
  const pool = [...results].sort((a, b) => b.order - a.order);
  const out: SimilarResult[] = [];
  const seenFr = new Map<string, number>();
  const rowOf = (k: TitleKey) => idx?.get(k)?.row ?? -1;
  while (pool.length) {
    let best = 0, bestV = -Infinity;
    for (let i = 0; i < Math.min(pool.length, 40); i++) {
      const r = pool[i];
      let red = 0;
      const ri = rowOf(r.key);
      if (idx?.emb && ri >= 0) for (const s of out.slice(-10)) { const rs = rowOf(s.key); if (rs >= 0) red = Math.max(red, idx.semScore(idx.cosRows(ri, rs))); }
      const frPen = r.franchise && seenFr.has(r.franchise) ? 0.25 * seenFr.get(r.franchise)! : 0;
      const v = 0.88 * r.order - 0.12 * red - frPen;
      if (v > bestV) { bestV = v; best = i; }
    }
    const [r] = pool.splice(best, 1);
    if (r.franchise) seenFr.set(r.franchise, (seenFr.get(r.franchise) ?? 0) + 1);
    out.push(r);
  }
  out.forEach((r, i) => { r.order = out.length - i; });
  return out;
}

function explain(s: MultiScore, C: Narrative, refs: RefIn[], refTitle: Map<TitleKey, string>): SimilarExplanation {
  const nRefs = refs.length;
  const names = (ks: string[]) => ks.map((k) => refTitle.get(k as TitleKey) ?? k).join(', ');
  // Rasgos compartidos, agrupados por rasgo con las referencias que lo tienen
  const facetMap = new Map<string, { label: string; refs: string[]; kw: Set<string>; semantic: boolean; w: number; strength: string }>();
  const kwMap = new Map<number, { name: string; refs: string[]; w: number }>();
  const weakSet = new Set<string>();
  const people = new Set<string>();
  for (const p of s.perRef) {
    for (const fc of p.s.facets) {
      if (fc.strength === 'weak') { weakSet.add(fc.label); continue; }
      const e = facetMap.get(fc.id) ?? { label: fc.label, refs: [], kw: new Set<string>(), semantic: false, w: 0, strength: fc.strength };
      e.refs.push(p.key); fc.kw.forEach((k) => e.kw.add(k)); e.semantic ||= fc.semantic; e.w += fc.weight * p.weight; facetMap.set(fc.id, e);
    }
    for (const k of p.s.keywords) {
      if (SPOILER_PATTERN.test(k.name)) continue;
      const e = kwMap.get(k.id) ?? { name: k.name, refs: [], w: 0 };
      e.refs.push(p.key); e.w += k.weight * p.weight; kwMap.set(k.id, e);
    }
    for (const k of p.s.weak) if (!SPOILER_PATTERN.test(k.name)) weakSet.add(keywordLabel(k.name));
    if (p.s.people.length) people.add(`mismo equipo creativo que ${names([p.key])}`);
  }
  const strong: SimilarExplanation['strong'] = [...facetMap.values()].sort((a, b) => b.w * b.refs.length - a.w * a.refs.length).slice(0, 4).map((e) => ({
    text: e.label, refs: e.refs as TitleKey[],
    source: [e.kw.size ? `palabras clave de TMDB: ${[...e.kw].slice(0, 2).map(keywordLabel).join(', ')}` : '', e.semantic ? 'detectado en la sinopsis/argumento (inferido)' : ''].filter(Boolean).join(' · ') || 'palabras clave de TMDB',
  }));
  const specificKw = [...kwMap.values()].sort((a, b) => b.w * b.refs.length - a.w * a.refs.length).slice(0, 3);
  if (specificKw.length) strong.push({ text: `temáticas específicas: ${specificKw.map((k) => keywordLabel(k.name)).join(', ')}`, refs: [...new Set(specificKw.flatMap((k) => k.refs))] as TitleKey[], source: 'palabras clave de TMDB poco frecuentes en el catálogo' });
  let semantic: SimilarExplanation['semantic'];
  const semRefs = s.perRef.filter((p) => (p.s.components.sem ?? 0) >= 0.45).sort((a, b) => (b.s.components.sem ?? 0) - (a.s.components.sem ?? 0));
  if (semRefs.length) {
    const top = semRefs[0].s.components.sem!;
    semantic = { text: `argumento ${top >= 0.75 ? 'muy parecido' : top >= 0.6 ? 'parecido' : 'algo parecido'} según el análisis semántico de sinopsis${C.textQ === 2 ? ' y argumento' : ''}`, refs: semRefs.map((p) => p.key) as TitleKey[] };
  }
  // Diferencias relevantes
  const differences: string[] = [];
  const seenD = new Set<string>();
  for (const p of s.perRef) for (const d of p.s.differences) {
    const t = d.kind === 'opposite' ? `tono distinto: ${d.other} (en lugar de ${d.label}${nRefs > 1 ? `, de ${names([p.key])}` : ''})` : `no tiene ${d.label}${nRefs > 1 ? ` (de ${names([p.key])})` : ''}`;
    if (!seenD.has(t)) { seenD.add(t); differences.push(t); }
  }
  if (nRefs > 1) {
    const weakRefs = s.perRef.filter((p) => p.s.score < 0.2).map((p) => p.key);
    if (weakRefs.length && weakRefs.length < nRefs) differences.push(`se parece poco a ${names(weakRefs)}`);
  }
  const ev = s.evidence;
  const evidence = `Confianza ${confidenceLabel(ev)}: ${C.row >= 0 ? `vector semántico (${C.textQ === 2 ? 'sinopsis + argumento de Wikipedia' : 'sólo sinopsis'})` : 'sin vector semántico'}, ${C.facets.size} rasgos narrativos, ${C.kw.size} palabras clave de TMDB.`;
  return { strong, semantic, people: [...people], weak: [...weakSet].slice(0, 4), differences: differences.slice(0, 3), evidence };
}

/** Líneas de explicación para la tarjeta (las débiles van al final y nunca solas como justificación). */
export function explainSimilar(r: SimilarResult, refTitle: (k: TitleKey) => string, nRefs: number): string[] {
  const e = r.explanation;
  const withRefs = (refs: TitleKey[]) => (nRefs > 1 && refs.length ? ` (con ${[...new Set(refs)].map(refTitle).join(', ')})` : '');
  const lines: string[] = [];
  if (e.semantic) lines.push(`${cap(e.semantic.text)}${withRefs(e.semantic.refs)}.`);
  for (const s of e.strong) lines.push(`Comparte ${s.text}${withRefs(s.refs)}. Fuente: ${s.source}.`);
  for (const p of e.people) lines.push(`${cap(p)}.`);
  if (!lines.length) lines.push('Parecido leve: comparte pocos rasgos narrativos específicos con las referencias.');
  for (const d of e.differences) lines.push(`Diferencia: ${d}.`);
  if (e.weak.length) lines.push(`Coincidencias secundarias (no justifican la similitud): ${e.weak.join(', ')}.`);
  lines.push(e.evidence);
  return lines;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export type { SimilarMode };
export type { CoreFeature };
