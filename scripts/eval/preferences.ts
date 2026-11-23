/**
 * v3.4 · Validación de las preferencias flexibles contra categorías de Wikipedia (independientes de TMDB).
 * Uso: npx tsx scripts/eval/preferences.ts → docs/preferences-validation.json
 *
 * Para cada preferencia: precisión y recall de su evidencia (palabras clave/género de TMDB del catálogo) frente a
 * una categoría editorial, en desarrollo y en evaluación. Criterio de aplicación, fijado de antemano y decidido
 * SÓLO con desarrollo: precisión ≥ 0,30 y lift (precisión / tasa base) ≥ 3.
 * Además compara la evidencia por rasgos semánticos del catálogo (inferidos de la sinopsis) con la misma vara.
 * Luego mide el efecto en el ranking: con un perfil, cuánto sube la proporción de títulos de la categoría en el
 * top 10 y cuánto cambia su relevancia (P@10 del perfil), sin filtrar nada.
 */
import { writeFileSync } from 'node:fs';
import { idx, metaOf, refOf, split, build, relevanceMetrics } from './recs';
import { PROFILES } from './profiles';
import { PREFS, prefAdjust, reorderByPrefs } from '../../src/services/preferences';
import { hybridEngine } from '../../src/engine/recommender';
import type { TitleKey, TitleMeta } from '../../src/types';

const REF: Record<string, RegExp | null> = {
  'time-travel': /time travel/,
  nonlinear: /nonlinear narrative/,
  unsettling: /psychological thriller|psychological horror|supernatural horror|horror films|horror television/,
  'gradual-mystery': /mystery/,
  'less-romance': /romance|romantic/,
  twists: null,
  complex: /nonlinear narrative|puzzle|surrealist|mind-bending/,
};
const SEM: Record<string, string[]> = { 'time-travel': [], nonlinear: ['st.nonlinear'], unsettling: ['mys.psych', 'tone.horror', 'tone.tense'], 'gradual-mystery': ['mys.whodunit', 'mys.investigation'], 'less-romance': ['rom.central'], twists: [], complex: ['cx.puzzle'] };
const kwOf = (k: string) => idx.get(k as TitleKey)!.kw.map((id) => idx.kwName(id) ?? '');
const titles = new Map<TitleKey, TitleMeta>(idx.titles.map((t) => [t.key as TitleKey, metaOf(t.key as TitleKey)]));
const out: any = { rules: 'preferencias-1.0', criterion: 'precisión ≥ 0,30 y lift ≥ 3 en desarrollo', prefs: {} };
for (const p of PREFS) {
  const ref = REF[p.id];
  const row: any = { label: p.label, applied: p.applied };
  for (const ph of ['dev', 'test'] as const) {
    if (!ref) { row[ph] = null; continue; }
    let n = 0, pos = 0, tp = 0, pred = 0, stp = 0, spred = 0;
    for (const t of idx.titles) {
      if (split(t.key) !== ph) continue;
      const r = refOf(t.key as TitleKey);
      if (!r || !r.cats.length) continue;
      n++;
      const truth = r.cats.some((c) => ref.test(c));
      if (truth) pos++;
      const m = prefAdjust([{ ...p, applied: true }], titles.get(t.key as TitleKey)!, kwOf(t.key)).matches.length > 0;
      if (m) { pred++; if (truth) tp++; }
      const sem = t.facets.some((f) => SEM[p.id].includes(f[0]) && f[2].length === 0 && f[3] > 0);
      if (sem) { spred++; if (truth) stp++; }
    }
    const base = pos / n, prec = pred ? tp / pred : 0;
    row[ph] = { n, base: +base.toFixed(3), keywords: { matched: pred, precision: +prec.toFixed(2), recall: +(tp / Math.max(1, pos)).toFixed(2), lift: +(prec / base).toFixed(1) }, semantic: { matched: spred, precision: +(spred ? stp / spred : 0).toFixed(2), lift: +((spred ? stp / spred : 0) / base).toFixed(1) } };
  }
  row.passes = row.dev ? (p.polarity < 0 ? row.dev.keywords.precision >= 0.3 && row.dev.keywords.lift >= 3 : row.dev.keywords.precision >= 0.3 && row.dev.keywords.lift >= 3) : false;
  out.prefs[p.id] = row;
  console.log(p.id, JSON.stringify(row));
}
// Efecto en el ranking (evaluación final): perfil + preferencia
const CASES: [string, string, RegExp][] = [['p1-scifi-tiempo', 'nonlinear', /nonlinear narrative/], ['p2-thriller-psicologico', 'unsettling', REF.unsettling!], ['p2-thriller-psicologico', 'less-romance', /romance|romantic/], ['p1-scifi-tiempo', 'time-travel', /time travel/], ['p5-variado', 'gradual-mystery', /mystery/]];
out.ranking = [];
for (const [pid, prefId, re] of CASES) {
  const prof = PROFILES.find((x) => x.id === pid)!;
  const pref = PREFS.find((x) => x.id === prefId)!;
  for (const seed of [1, 2, 3]) {
    const b = build(prof, seed);
    const profile = hybridEngine.buildProfile(b.ratings, titles);
    const items = hybridEngine.rank({ profile, ratings: b.ratings, titles, candidates: b.candidates, limit: 60, seed: 7, narrative: idx });
    const base = items.slice(0, 10).map((i) => i.key);
    const adj = reorderByPrefs(items, (i) => prefAdjust([pref], titles.get(i.key)!, kwOf(i.key)).delta).slice(0, 10).map((x) => x.key);
    const share = (l: TitleKey[]) => l.filter((k) => refOf(k)?.cats.some((c) => re.test(c))).length / 10;
    const allGrades = b.candidates.map(b.grade).filter((g) => g > 0);
    out.ranking.push({ profile: pid, pref: prefId, seed, shareBefore: share(base), shareAfter: share(adj), p10Before: relevanceMetrics(base, b.grade, allGrades).p10, p10After: relevanceMetrics(adj, b.grade, allGrades).p10 });
  }
}
console.log(JSON.stringify(out.ranking));
writeFileSync('docs/preferences-validation.json', JSON.stringify(out, null, 1));
