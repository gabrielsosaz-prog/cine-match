import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { getSettings, listRatings } from '../db/repo';
import { computeIdf, cosine, describeFeatures, family, featureLabel, rawFeatures, SIMILARITY_WEIGHT, type FeatureVec } from '../engine/features';
import { textCosine, textIdf, textVector, tokens } from '../engine/text';
import { friendlyError } from '../providers/errors';
import type { RecommendationItem, TitleKey, TitleMeta } from '../types';
import { matchesPlatforms } from './availability';
import { discoverCandidates, ensureFullTitles, getTitle } from './catalog';
import { matchesContent, matchesWatched, type Candidate, type RankFilters } from './filters';
import { getEngine, latestRun, predictFor } from './recommendations';

/**
 * Sección «Similares» (v3.0): títulos parecidos a 1-5 títulos de referencia.
 *
 * No se limita al endpoint «similar» de TMDB. Se arma un PERFIL TEMPORAL de similitud con lo que comparten las
 * referencias (temáticas/palabras clave, dirección, guion, reparto, subgéneros, formato y la sinopsis, de forma
 * léxica) y se buscan candidatos en varias fuentes: relacionados de TMDB, descubrimiento por palabras clave,
 * por reparto y por dirección/guion, y tu propio conjunto de candidatos.
 *
 * Similitud ≠ afinidad: la similitud mide cuánto se parece a las referencias; «Para vos» estima cuánto te gustaría.
 * No se asume que te gustó todo lo que comparten: si puntuaste una referencia, pesa según tu nota; y los rasgos
 * con afinidad negativa en tu historial se atenúan. Sin historial suficiente, el resultado no es personalizado y se avisa.
 */
export const MAX_REFS = 5;
const GENERIC = new Set(['t', 'era', 'lang', 'seas']);

export interface SharedFeature { f: string; label: string; family: string; refs: TitleKey[]; weight: number }
export interface SimilarResult {
  key: TitleKey;
  similarity: number; // 0-1, relativo al mejor candidato
  rawSimilarity: number;
  affinity?: RecommendationItem;
  shared: SharedFeature[];
  tmdbRelated: TitleKey[];
  order: number;
}
export interface SimilarResponse {
  results: SimilarResult[];
  personalized: boolean;
  ratedCount: number;
  candidates: number;
  profile: SharedFeature[];
  warning?: string;
}

const familyName: Record<string, string> = { k: 'temática', d: 'dirección', w: 'guion', c: 'reparto', g: 'género', len: 'duración', end: 'final' };

export async function findSimilar(profileId: string, refKeys: TitleKey[], f: RankFilters, o: { onlyMyPlatforms?: boolean } = {}): Promise<SimilarResponse> {
  const refsIn = [...new Set(refKeys)].slice(0, MAX_REFS);
  const settings = await getSettings(profileId);
  const opts = { language: settings.language, country: settings.country };
  const ratings = await listRatings(profileId);
  const byKey = new Map(ratings.map((r) => [r.key, r]));
  let warning: string | undefined;
  // 1) Fichas completas de las referencias
  const refMetas = (await Promise.all(refsIn.map(async (k) => { const r = await getTitle(k, opts); if (r.error) warning ??= friendlyError(r.error); return r.meta; })))
    .filter((m): m is TitleMeta => Boolean(m));
  if (!refMetas.length) return { results: [], personalized: false, ratedCount: 0, candidates: 0, profile: [], warning: warning ?? 'No se pudieron cargar los títulos de referencia.' };
  const refs = new Set(refMetas.map((m) => m.key));

  // 2) Perfil personal (si existe) para ponderar referencias y rasgos
  const histTitles = new Map((await db.titles.bulkGet(ratings.map((r) => r.key))).filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
  for (const m of refMetas) histTitles.set(m.key, m);
  const profile = getEngine().buildProfile(ratings, histTitles, settings);
  const personalized = profile.ratedCount >= 5;
  const refWeight = (m: TitleMeta) => {
    const r = byKey.get(m.key);
    if (r?.overall === undefined) return 1;
    return Math.max(0.3, Math.min(1.8, 1 + (r.overall - profile.mean) / 3));
  };

  // 3) Candidatos de varias fuentes
  const cand = new Set<TitleKey>();
  const tmdbRel = new Map<TitleKey, TitleKey[]>();
  for (const m of refMetas) for (const k of m.related ?? []) { cand.add(k); tmdbRel.set(k, [...(tmdbRel.get(k) ?? []), m.key]); }
  const featCount = new Map<string, number>();
  for (const m of refMetas) for (const x of rawFeatures(m)) featCount.set(x, (featCount.get(x) ?? 0) + refWeight(m));
  const top = (fam: string, n: number) => [...featCount].filter(([x]) => family(x) === fam).sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => Number(x.slice(x.indexOf(':') + 1)));
  const kw = top('k', 4), cast = top('c', 2), crew = [...top('d', 2), ...top('w', 1)];
  const types = [...new Set(refMetas.map((m) => m.type))];
  const ids = o.onlyMyPlatforms === false ? [] : PLATFORMS.filter((p) => settings.platforms.includes(p.id)).flatMap((p) => p.tmdbIds);
  const jobs: Promise<unknown>[] = [];
  for (const type of types) {
    const base = { type, ...opts, providerIds: ids, sort: 'vote_count.desc', minVotes: 50 };
    if (kw.length) jobs.push(discoverCandidates({ ...base, extra: { with_keywords: kw.join('|') } }).then((r) => r.forEach((x) => cand.add(x.key))));
    if (type === 'movie' && cast.length) jobs.push(discoverCandidates({ ...base, extra: { with_cast: cast.join('|') } }).then((r) => r.forEach((x) => cand.add(x.key))));
    if (type === 'movie' && crew.length) jobs.push(discoverCandidates({ ...base, extra: { with_crew: crew.join('|') } }).then((r) => r.forEach((x) => cand.add(x.key))));
  }
  const res = await Promise.allSettled(jobs);
  const failed = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) warning ??= friendlyError(failed.reason);
  const run = await latestRun(profileId);
  for (const k of run?.pool ?? []) cand.add(k);
  for (const k of refs) cand.delete(k);

  // 4) Preselección con lo que ya hay y ficha completa para los mejores
  const score = (metas: Map<TitleKey, TitleMeta>) => {
    const keys = [...cand].filter((k) => metas.has(k));
    const corpus = [...refMetas, ...keys.map((k) => metas.get(k)!)];
    const idf = computeIdf(corpus.map(rawFeatures));
    const tIdf = textIdf(corpus.map((m) => tokens(m.overview)));
    // Perfil temporal: rasgos compartidos ponderados por cuántas referencias los tienen (y cuánto te gustó cada una)
    const totalW = refMetas.reduce((a, m) => a + refWeight(m), 0);
    const prof: FeatureVec = new Map();
    const shared: SharedFeature[] = [];
    for (const [x, c] of featCount) {
      const fam = family(x);
      if (GENERIC.has(fam)) continue;
      let w = (c / totalW) * (SIMILARITY_WEIGHT[fam] ?? 0.3) * (idf.get(x) ?? 1);
      const fa = profile.features.get(x);
      // No se asume que te gustó todo lo compartido: los rasgos que solés puntuar bajo pesan menos
      if (fa && fa.count >= 2) w *= 1 + Math.max(-0.6, Math.min(0.6, fa.affinity / 2));
      prof.set(x, w);
      shared.push({ f: x, label: '', family: fam, refs: refMetas.filter((m) => rawFeatures(m).includes(x)).map((m) => m.key), weight: w });
    }
    const refText = new Map<string, number>();
    for (const m of refMetas) for (const [t, v] of textVector(tokens(m.overview), tIdf)) refText.set(t, (refText.get(t) ?? 0) + v * refWeight(m));
    const out = keys.map((k) => {
      const m = metas.get(k)!;
      const fs = rawFeatures(m).filter((x) => !GENERIC.has(family(x)));
      const v: FeatureVec = new Map(fs.map((x) => [x, (SIMILARITY_WEIGHT[family(x)] ?? 0.3) * (idf.get(x) ?? 1)]));
      const raw = 0.85 * cosine(prof, v) + 0.15 * textCosine(refText, textVector(tokens(m.overview), tIdf)) + (tmdbRel.has(k) ? 0.03 * tmdbRel.get(k)!.length : 0);
      return { key: k, raw, fs };
    });
    return { out, prof, shared };
  };
  let metas = new Map((await db.titles.bulkGet([...cand])).filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
  const pre = score(metas).out.sort((a, b) => b.raw - a.raw);
  const needFull = pre.filter((x) => metas.get(x.key)?.completeness !== 'full').slice(0, 40).map((x) => x.key);
  const relFirst = [...tmdbRel.keys()].filter((k) => metas.get(k)?.completeness !== 'full' && !needFull.includes(k)).slice(0, 10);
  if (needFull.length || relFirst.length) {
    try { await ensureFullTitles([...needFull, ...relFirst], opts, 50); } catch (e) { warning ??= friendlyError(e); }
    metas = new Map((await db.titles.bulkGet([...cand])).filter((m): m is TitleMeta => Boolean(m)).map((m) => [m.key, m]));
  }
  const { out, shared } = score(metas);
  const info = describeFeatures([...refMetas, ...metas.values()]);
  for (const s of shared) s.label = featureLabel(s.f, info);

  // 5) Filtros avanzados + disponibilidad + exclusiones
  const keys = out.map((x) => x.key);
  const snaps = await db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`));
  const snapOf = new Map(keys.map((k, i) => [k, snaps[i]]));
  const passing = out.filter((x) => {
    const c: Candidate = { meta: metas.get(x.key)!, snap: snapOf.get(x.key), rating: byKey.get(x.key) };
    if (c.rating?.notInterested) return false;
    if (o.onlyMyPlatforms !== false && !matchesPlatforms(c.snap, settings.platforms, settings.includeUnconfirmed)) return false;
    return matchesContent(c, f) && matchesWatched(c, f);
  }).filter((x) => x.raw > 0.02).sort((a, b) => b.raw - a.raw).slice(0, 120);

  // 6) Afinidad personal («Para vos») separada de la similitud
  const preds = await predictFor(profileId, passing.map((x) => x.key));
  const maxRaw = Math.max(1e-6, ...passing.map((x) => x.raw));
  const sharedByF = new Map(shared.map((s) => [s.f, s]));
  let results: SimilarResult[] = passing.map((x) => ({
    key: x.key,
    rawSimilarity: x.raw,
    similarity: x.raw / maxRaw,
    affinity: preds.get(x.key),
    shared: x.fs.map((f2) => sharedByF.get(f2)).filter((s): s is SharedFeature => Boolean(s) && !info.get(s!.f)?.spoiler && s!.family !== 'end')
      .sort((a, b) => b.weight - a.weight).slice(0, 5),
    tmdbRelated: tmdbRel.get(x.key) ?? [],
    order: 0,
  }));
  if (f.minScore) results = results.filter((r) => (r.affinity?.score ?? 0) >= f.minScore!);
  // Orden combinado: con historial suficiente, la similitud se combina con tu afinidad; sin historial, sólo similitud
  for (const r of results) r.order = personalized && r.affinity ? 0.7 * r.similarity + 0.3 * ((r.affinity.score - 1) / 9) : r.similarity;
  results.sort((a, b) => b.order - a.order);
  return { results, personalized, ratedCount: profile.ratedCount, candidates: cand.size, profile: shared.sort((a, b) => b.weight - a.weight).slice(0, 12), warning };
}

export function explainSimilar(r: SimilarResult, refTitle: (k: TitleKey) => string, nRefs: number): string[] {
  const lines: string[] = [];
  const byFam = (fams: string[]) => r.shared.filter((s) => fams.includes(s.family));
  const themes = byFam(['k']).slice(0, 3), people = byFam(['d', 'w', 'c']).slice(0, 2), genres = byFam(['g']).slice(0, 2);
  const refsOf = (s: SharedFeature[]) => [...new Set(s.flatMap((x) => x.refs))].map(refTitle);
  if (themes.length) lines.push(`Comparte ${themes.map((t) => `«${t.label}»`).join(', ')}${nRefs > 1 ? ` (con ${refsOf(themes).join(', ')})` : ''}.`);
  if (people.length) lines.push(`Mismo equipo o reparto: ${people.map((p) => `${p.label} (${familyName[p.family]})`).join(', ')}.`);
  if (genres.length && !themes.length) lines.push(`Coincide en género: ${genres.map((g) => g.label).join(', ')} (similitud más general).`);
  if (r.tmdbRelated.length) lines.push(`TMDB la relaciona con ${r.tmdbRelated.map(refTitle).join(', ')}.`);
  if (!lines.length) lines.push('Parecido leve: comparte pocos rasgos específicos con las referencias.');
  return lines;
}
