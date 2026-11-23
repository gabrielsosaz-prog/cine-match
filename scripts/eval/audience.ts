/**
 * v3.4 · Validación del público objetivo contra un conjunto de referencia editorial externo.
 *
 * Uso: npx tsx scripts/eval/audience.ts   → docs/audience-validation.json y .md
 *
 * Fuente de referencia: categorías de Wikipedia en inglés y género de Wikidata (P136) de cada título
 * (eval/data/reference.json). Son decisiones editoriales de otras comunidades; las reglas de la app no las usan.
 * Wikidata casi no tiene «público destinatario» (P2360: 17 títulos, todos manga), así que se usan géneros y
 * categorías que, por definición, nombran al público (p. ej. «children's film», «teen comedy films»,
 * «adult animated television series»). Se separan de las que hablan de protagonistas («television series about
 * teenagers», «coming-of-age»), de la clasificación por edad y del género cinematográfico.
 *
 * Criterios de etiquetado (fijados antes de medir):
 *  - Infantil: género Wikidata «children's film/television series/animated…» o categoría «children's …»
 *    (no «based on children's books»: habla de la fuente, no del público) o «preschool».
 *  - Adolescente: género «teen film/drama/comedy/…» o categoría «teen …» (no «Teen Choice Award»: es un premio,
 *    ni «about teenagers»: son protagonistas) o «young adult» en género.
 *  - Familiar: género «family film» o categoría «family film(s)/family television».
 *  - Adulto: categoría o género «adult animat…», «erotic …», «pornographic …».
 *  - Un título puede tener varias. Negativo de una categoría SÓLO si tiene una etiqueta incompatible
 *    (Infantil/Familiar ↔ Adulto). Sin etiqueta ni incompatibilidad = indeterminado (no cuenta en la medición
 *    estricta). La medición «amplia» trata lo indeterminado como negativo y se informa aparte.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { classifyAudience, setAudienceData, AUDIENCE_RULES, type AudienceId } from '../../src/services/audience';
import { idx, metaOf, refOf, split } from './recs';
import type { TitleKey } from '../../src/types';
import type { Ref } from './profiles';

const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const aud = JSON.parse(readFileSync(`public/catalog/${man.audience}`, 'utf8'));
setAudienceData(aud);
const CATS: AudienceId[] = ['kids', 'teen', 'family', 'adult'];
const any = (xs: string[], re: RegExp) => xs.some((x) => re.test(x));
const strip = (xs: string[]) => xs.filter((x) => !/based on children's|teen choice|about teenagers|children's book|children's literature/.test(x));
export function referenceLabels(r: Ref) {
  const c = strip(r.cats), g = strip(r.genre);
  const L = {
    kids: any(g, /children's|preschool/) || any(c, /children's|preschool/),
    teen: any(g, /\bteen\b|teen film|young adult/) || any(c, /\bteen (comedy|drama|romance|horror|film|sitcom|animated|television|fantasy|musical|sex|slasher|superhero|adventure|mystery|thriller|science fiction|action)/),
    family: any(g, /family film|family television/) || any(c, /\bfamily films\b|family television series|family-oriented/),
    adult: any(g, /adult animat|erotic|pornograph/) || any(c, /adult animated|erotic|pornographic/),
  };
  const protagonists = any(r.cats, /about teenagers|coming-of-age|teenage protagonists|about children/);
  return { L, protagonists };
}
const incompatible = (id: AudienceId, L: Record<AudienceId, boolean>) => (id === 'adult' ? L.kids || L.family : id === 'kids' || id === 'family' ? L.adult : false);

interface Row { key: TitleKey; title: string; split: 'dev' | 'test'; labels: AudienceId[]; protagonists: boolean; pred: Record<string, string>; conf: Record<string, number>; cert?: string }
const rows: Row[] = [];
for (const t of idx.titles) {
  const ref = refOf(t.key as TitleKey);
  if (!ref) continue;
  const { L, protagonists } = referenceLabels(ref);
  const labels = CATS.filter((c) => L[c]);
  if (!labels.length) continue;
  const p = classifyAudience(metaOf(t.key as TitleKey));
  rows.push({ key: t.key as TitleKey, title: t.title, split: split(t.key), labels, protagonists, pred: Object.fromEntries(CATS.map((c) => [c, p.scores[c].status])), conf: Object.fromEntries(CATS.map((c) => [c, p.scores[c].confidence])), cert: Object.entries(aud.entries.find((e: any[]) => e[0] === t.key)?.[1] ?? {}).map(([k, v]) => `${k}:${v}`).join(' ') });
}

function measure(rs: Row[], id: AudienceId, mode: 'strict' | 'broad') {
  let tp = 0, fp = 0, fn = 0, tn = 0, unc = 0, unknown = 0, n = 0;
  for (const r of rs) {
    const L = Object.fromEntries(CATS.map((c) => [c, r.labels.includes(c)])) as Record<AudienceId, boolean>;
    const truth = L[id] ? true : incompatible(id, L) ? false : mode === 'broad' ? false : undefined;
    if (truth === undefined) continue;
    n++;
    const s = r.pred[id];
    if (s === 'unknown') { unknown++; continue; }
    if (s === 'uncertain') { unc++; if (truth) fn++; continue; }
    const yes = s === 'yes';
    if (yes && truth) tp++; else if (yes && !truth) fp++; else if (!yes && truth) fn++; else tn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : null, rec = tp + fn ? tp / (tp + fn) : null;
  return { n, positives: rs.filter((r) => r.labels.includes(id)).length, tp, fp, fn, tn, uncertain: unc, unknown, precision: prec, recall: rec, f1: prec !== null && rec !== null && prec + rec ? (2 * prec * rec) / (prec + rec) : null, coverage: n ? (n - unknown) / n : null, uncertainShare: n ? unc / n : null };
}
const report: any = { version: '3.4.0', rules: AUDIENCE_RULES, reference: 'categorías de Wikipedia + género de Wikidata (ver criterios en scripts/eval/audience.ts)', titles: rows.length, byCategory: {} };
for (const ph of ['dev', 'test'] as const) for (const mode of ['strict', 'broad'] as const) report.byCategory[`${ph}-${mode}`] = Object.fromEntries(CATS.map((c) => [c, measure(rows.filter((r) => r.split === ph), c, mode)]));
// Dimensiones separadas: protagonistas adolescentes vs. público adolescente
const prot = rows.filter((r) => r.protagonists);
report.protagonists = { titlesWithTeenOrChildProtagonists: prot.length, ofThemLabelledTeenAudience: prot.filter((r) => r.labels.includes('teen')).length, ofThemPredictedTeen: prot.filter((r) => r.pred.teen === 'yes').length };
// Casos pedidos
const CASES: [string, string][] = [['tv:85552', 'Euphoria'], ['movie:2108', 'El club de los cinco'], ['movie:862', 'Toy Story'], ['movie:109445', 'Frozen'], ['movie:12', 'Buscando a Nemo'], ['tv:82728', 'Bluey']];
report.cases = CASES.map(([k, name]) => {
  const ref = refOf(k as TitleKey);
  const lab = ref ? referenceLabels(ref) : undefined;
  const p = classifyAudience(metaOf(k as TitleKey));
  return { key: k, name, reference: lab ? CATS.filter((c) => lab.L[c]) : null, protagonists: lab?.protagonists, evidence: ref ? strip(ref.cats).filter((c) => /children|teen|family|adult|coming-of-age|teenagers/.test(c)).concat(ref.genre.filter((g) => /children|teen|family|adult/.test(g))) : [], predicted: Object.fromEntries(CATS.map((c) => [c, `${p.scores[c].status} ${p.scores[c].confidence}`])) };
});
// Desacuerdos (evaluación final, estrictos) con evidencia
report.disagreements = rows.filter((r) => r.split === 'test').flatMap((r) => CATS.filter((c) => {
  const L = Object.fromEntries(CATS.map((x) => [x, r.labels.includes(x)])) as Record<AudienceId, boolean>;
  return (L[c] && r.pred[c] !== 'yes' && r.pred[c] !== 'unknown') || (r.pred[c] === 'yes' && !L[c] && incompatible(c, L));
}).map((c) => ({ key: r.key, title: r.title, category: c, reference: r.labels, predicted: r.pred[c], confidence: r.conf[c], cert: r.cert }))).slice(0, 400);
writeFileSync('docs/audience-validation.json', JSON.stringify(report, null, 1));
const pct = (x: number | null) => (x === null ? 'n/d' : `${Math.round(x * 100)} %`);
let md = `# Validación del público objetivo (v3.4, reglas ${AUDIENCE_RULES})\n\nReferencia: ${report.reference}. Títulos con al menos una etiqueta de referencia: ${rows.length} (desarrollo ${rows.filter((r) => r.split === 'dev').length}, evaluación ${rows.filter((r) => r.split === 'test').length}).\n\n`;
for (const key of ['test-strict', 'test-broad']) {
  md += `## Evaluación final, medición ${key.endsWith('strict') ? 'estricta (sólo etiquetados o incompatibles)' : 'amplia (sin etiqueta = negativo)'}\n\n| Categoría | n | positivos | precisión | recall | F1 | FP | FN | inciertos | sin datos |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const c of CATS) { const m = report.byCategory[key][c]; md += `| ${c} | ${m.n} | ${m.positives} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${m.fp} | ${m.fn} | ${pct(m.uncertainShare)} | ${m.unknown} |\n`; }
  md += '\n';
}
if (existsSync('docs/audience-validation-publico-1.0.json')) {
  const old = JSON.parse(readFileSync('docs/audience-validation-publico-1.0.json', 'utf8'));
  md += `## Cambio respecto de público-1.0 (misma referencia)\n\n| Medición | Categoría | precisión 1.0 → 1.1 | recall 1.0 → 1.1 | F1 1.0 → 1.1 |\n|---|---|---|---|---|\n`;
  for (const key of ['dev-strict', 'test-strict', 'test-broad']) for (const c of CATS) {
    const a = old.byCategory[key][c], b = report.byCategory[key][c];
    if (JSON.stringify([a.precision, a.recall]) !== JSON.stringify([b.precision, b.recall])) md += `| ${key} | ${c} | ${pct(a.precision)} → ${pct(b.precision)} | ${pct(a.recall)} → ${pct(b.recall)} | ${pct(a.f1)} → ${pct(b.f1)} |\n`;
  }
  md += '\nEl cambio se decidió con desarrollo (dev) y se confirma en evaluación (test). Las demás categorías no cambiaron.\n\n';
}
md += `## Casos pedidos\n\n| Título | Referencia | Evidencia editorial | Reglas (estado, confianza) |\n|---|---|---|---|\n${report.cases.map((c: any) => `| ${c.name} | ${c.reference?.join(', ') || 'sin etiqueta'} | ${c.evidence.slice(0, 4).join('; ')} | ${Object.entries(c.predicted).map(([k, v]) => `${k}: ${v}`).join(' · ')} |`).join('\n')}\n`;
writeFileSync('docs/audience-validation.md', md);
console.log(md);
console.log(JSON.stringify(report.protagonists));
