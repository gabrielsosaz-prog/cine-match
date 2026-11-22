/**
 * Evaluación v3.1 con DATOS REALES (catálogo construido desde TMDB + Wikipedia) — no sintéticos.
 * Compara el motor de Similares v3.0 (rasgos de TMDB + coseno + sinopsis léxica, normalizado al mejor) con el v3.1
 * (vectores semánticos + rasgos narrativos + rareza). Casos fijados de antemano en eval/cases.json.
 * Limitación: las etiquetas positivo/señuelo las asignó el desarrollador a partir de sinopsis publicadas; no son
 * juicios de usuarios y el conjunto es pequeño. Si el catálogo no está en el repositorio, la prueba se omite.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NarrativeIndex, buildRefProfile, scoreMulti, similarityPercent, type CatalogMeta, type SimilarMode } from '../../src/engine/narrative';
import { computeIdf, cosine, family, rawFeatures, SIMILARITY_WEIGHT, type FeatureVec } from '../../src/engine/features';
import { textCosine, textIdf, textVector, tokens } from '../../src/engine/text';
import { metaFromCatalog } from '../../src/services/narrativeCatalog';
import type { TitleKey, TitleMeta } from '../../src/types';

const MAN = 'public/catalog/manifest.json';
const have = existsSync(MAN);
const cases = JSON.parse(readFileSync('eval/cases.json', 'utf8'));

function load(): { idx: NarrativeIndex; texts: Record<string, string> } {
  const man = JSON.parse(readFileSync(MAN, 'utf8'));
  const meta = JSON.parse(readFileSync(`public/catalog/${man.meta}`, 'utf8')) as CatalogMeta;
  const buf = readFileSync(`public/catalog/${man.emb}`);
  const idx = new NarrativeIndex(meta, new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const tp = 'eval/data/texts.json';
  return { idx, texts: existsSync(tp) ? JSON.parse(readFileSync(tp, 'utf8')) : {} };
}

/** Réplica del puntaje de Similares v3.0 (services/similar.ts de la versión 3.0.0). */
function v30Scores(refs: TitleMeta[], cands: TitleMeta[]): Map<TitleKey, number> {
  const GENERIC = new Set(['t', 'era', 'lang', 'seas']);
  const corpus = [...refs, ...cands];
  const idf = computeIdf(corpus.map(rawFeatures));
  const tIdf = textIdf(corpus.map((m) => tokens(m.overview)));
  const featCount = new Map<string, number>();
  for (const m of refs) for (const x of rawFeatures(m)) featCount.set(x, (featCount.get(x) ?? 0) + 1);
  const prof: FeatureVec = new Map();
  for (const [x, c] of featCount) { const fam = family(x); if (GENERIC.has(fam)) continue; prof.set(x, (c / refs.length) * (SIMILARITY_WEIGHT[fam] ?? 0.3) * (idf.get(x) ?? 1)); }
  const refText = new Map<string, number>();
  for (const m of refs) for (const [t, v] of textVector(tokens(m.overview), tIdf)) refText.set(t, (refText.get(t) ?? 0) + v);
  const out = new Map<TitleKey, number>();
  for (const m of cands) {
    const fs = rawFeatures(m).filter((x) => !GENERIC.has(family(x)));
    const v: FeatureVec = new Map(fs.map((x) => [x, (SIMILARITY_WEIGHT[family(x)] ?? 0.3) * (idf.get(x) ?? 1)]));
    out.set(m.key, 0.85 * cosine(prof, v) + 0.15 * textCosine(refText, textVector(tokens(m.overview), tIdf)));
  }
  return out;
}

const rankOf = (scores: Map<TitleKey, number>, k: TitleKey) => { const s = scores.get(k); if (s === undefined) return Infinity; let r = 1; for (const v of scores.values()) if (v > s) r++; return r; };

describe.skipIf(!have)('Evaluación v3.1 con catálogo real', () => {
  it('compara v3.0 y v3.1 en los casos fijados', () => {
    const { idx, texts } = load();
    const names = new Map<number, string>();
    const metaOf = (k: TitleKey): TitleMeta | undefined => { const m = metaFromCatalog(idx, k, names); if (m) { m.overview = texts[k]; const c = idx.get(k)!; m.directors = c.people.map((id) => ({ id, name: '' })); m.writers = c.writers.map((id) => ({ id, name: '' })); m.cast = c.cast.map((id) => ({ id, name: '' })); } return m; };
    const allMetas = idx.titles.map((t) => metaOf(t.key)!);
    const report: any = { catalog: idx.meta.version, model: idx.meta.model, titles: idx.size, embedded: idx.meta.embedded, overviewsForV30: Object.keys(texts).length, triples: [], sequel: [], diagnostic: {}, perf: {} };
    let ok30 = 0, ok31 = 0, rr30 = 0, rr31 = 0, n = 0;
    const byConf: Record<string, { n: number; ok: number }> = {};
    for (const t of cases.triples) {
      const refs = t.refs as TitleKey[];
      if (!refs.every((k) => idx.get(k)) || !idx.get(t.positive) || !idx.get(t.negative)) { report.triples.push({ id: t.id, skipped: 'fuera del catálogo' }); continue; }
      n++;
      const refMetas = refs.map((k) => metaOf(k)!);
      const cands = allMetas.filter((m) => !refs.includes(m.key));
      const t0 = Date.now();
      const s30 = v30Scores(refMetas, cands);
      const ms30 = Date.now() - t0;
      const refIn = refs.map((k) => ({ n: idx.narrativeOf(k)!, weight: 1 }));
      const prof = buildRefProfile(refIn, idx);
      const mode: SimilarMode = t.mode ?? 'common';
      const t1 = Date.now();
      const s31 = new Map<TitleKey, number>();
      const full = new Map<TitleKey, ReturnType<typeof scoreMulti>>();
      for (const c of idx.titles) { if (refs.includes(c.key)) continue; const r = scoreMulti(refIn, prof, idx.narrativeOf(c.key)!, mode, idx); s31.set(c.key, r.score); full.set(c.key, r); }
      const ms31 = Date.now() - t1;
      const p30 = rankOf(s30, t.positive), p31 = rankOf(s31, t.positive);
      const win30 = (s30.get(t.positive) ?? 0) > (s30.get(t.negative) ?? 0), win31 = (s31.get(t.positive) ?? 0) > (s31.get(t.negative) ?? 0);
      ok30 += +win30; ok31 += +win31; rr30 += 1 / p30; rr31 += 1 / p31;
      const conf = full.get(t.positive)!.evidence >= 0.7 ? 'alta' : full.get(t.positive)!.evidence >= 0.45 ? 'media' : 'baja';
      byConf[conf] ??= { n: 0, ok: 0 }; byConf[conf].n++; byConf[conf].ok += +win31;
      const top = (s: Map<TitleKey, number>) => [...s].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${idx.get(k)?.title} ${(v * 100).toFixed(0)}`);
      report.triples.push({ id: t.id, kind: t.kind, v30: { posRank: p30, posBeatsNeg: win30, pos: s30.get(t.positive), neg: s30.get(t.negative), top: top(s30) }, v31: { posRank: p31, posBeatsNeg: win31, pos: similarityPercent(s31.get(t.positive)!), neg: similarityPercent(s31.get(t.negative)!), confidence: conf, top: top(s31) }, ms: { v30: ms30, v31: ms31 } });
    }
    // Secuelas: cuántos de los 10 primeros son de la misma saga
    for (const c of cases.sequelChecks) {
      const refs = c.refs as TitleKey[];
      if (!refs.every((k) => idx.get(k))) continue;
      const col = idx.get(refs[0])!.collection;
      const refMetas = refs.map((k) => metaOf(k)!);
      const s30 = v30Scores(refMetas, allMetas.filter((m) => !refs.includes(m.key)));
      const refIn = refs.map((k) => ({ n: idx.narrativeOf(k)!, weight: 1 }));
      const prof = buildRefProfile(refIn, idx);
      const s31 = new Map(idx.titles.filter((x) => !refs.includes(x.key)).map((x) => [x.key, scoreMulti(refIn, prof, idx.narrativeOf(x.key)!, 'common', idx).score] as [TitleKey, number]));
      const top10 = (s: Map<TitleKey, number>) => [...s].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
      // v3.1 aplica además la variedad por saga en el orden «Relevancia» (services/similar.ts:diversify); aquí se mide el puntaje crudo
      report.sequel.push({ id: c.id, v30SameSagaTop10: top10(s30).filter((k) => idx.get(k)?.collection === col).length, v31SameSagaTop10Raw: top10(s31).filter((k) => idx.get(k)?.collection === col).length });
    }
    // Diagnóstico White Lotus
    const d = cases.diagnostic;
    if (d.refs.every((k: TitleKey) => idx.get(k))) {
      const refs = d.refs as TitleKey[];
      const refMetas = refs.map((k) => metaOf(k)!);
      const s30 = v30Scores(refMetas, allMetas.filter((m) => !refs.includes(m.key)));
      const max30 = Math.max(...s30.values());
      const refIn = refs.map((k) => ({ n: idx.narrativeOf(k)!, weight: 1 }));
      const prof = buildRefProfile(refIn, idx);
      const out: any = { profileCore: prof.core.slice(0, 10).map((c) => `${c.label} [${c.refs.length}]`), contrasts: prof.contrasts.map((c) => c.label) };
      for (const mode of ['common', 'combine'] as SimilarMode[]) {
        const s = idx.titles.filter((x) => !refs.includes(x.key)).map((x) => ({ k: x.key, r: scoreMulti(refIn, prof, idx.narrativeOf(x.key)!, mode, idx) })).sort((a, b) => b.r.score - a.r.score);
        out[mode] = { top15: s.slice(0, 15).map((x) => `${idx.get(x.k)?.title} ${similarityPercent(x.r.score)}% (${x.r.perRef.map((p) => similarityPercent(p.s.score)).join('/')})`), reported: d.reported.map((k: TitleKey) => { const i = s.findIndex((x) => x.k === k); return `${idx.get(k)?.title ?? k}: puesto ${i + 1} · ${i >= 0 ? similarityPercent(s[i].r.score) : '-'}%`; }) };
      }
      out.v30 = { top15: [...s30].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${idx.get(k)?.title} ${Math.round((v / max30) * 100)}% (relativo al mejor, como mostraba v3.0)`), reported: d.reported.map((k: TitleKey) => `${idx.get(k)?.title ?? k}: puesto ${rankOf(s30, k)} · ${Math.round(((s30.get(k) ?? 0) / max30) * 100)}%`) };
      report.diagnostic = out;
    }
    report.summary = { cases: n, pairwiseAccuracy: { v30: ok30 / n, v31: ok31 / n }, mrrPositive: { v30: rr30 / n, v31: rr31 / n }, accuracyByConfidenceV31: byConf };
    writeFileSync('docs/eval-v3.1.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.summary, null, 1));
    expect(n).toBeGreaterThan(5);
  }, 600000);
});
