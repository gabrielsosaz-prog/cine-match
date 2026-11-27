/**
 * v4.0 · Verificación de equivalencia: el motor integrado (src/engine/attraction) frente al ranking del prototipo
 * ganador («atractivo-puro» de la segunda cata), con los MISMOS datos y candidatos.
 *
 * PRIVADO: necesita el export personal y los archivos de la investigación, FUERA del repositorio. No escribe nada en
 * el repo. Uso:
 *   npx tsx scripts/attraction/equivalence.ts <export.json> <carpeta-investigacion>
 * donde la carpeta tiene blind-mapping.json, new-interest.json, new-seen.json, anchors.json (premisas elegidas) y rank5.json (salida del prototipo).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { idx } from '../eval/recs';
import { PREFS, rankAttraction, scoreAttraction, type AttractionContext } from '../../src/engine/attraction';
import type { InterestRecord, Rating, TasteProfile, TitleKey } from '../../src/types';

const [file, dir] = process.argv.slice(2);
if (!file || !dir) { console.error('Uso: equivalence.ts <export.json> <carpeta>'); process.exit(1); }
const ex = JSON.parse(readFileSync(file, 'utf8'));
const ratings: Rating[] = ex.ratings;
const cata1 = JSON.parse(readFileSync(join(dir, 'blind-mapping.json'), 'utf8'));
const inter: Record<string, number> = JSON.parse(readFileSync(join(dir, 'new-interest.json'), 'utf8'));
const seen: Record<string, number> = JSON.parse(readFileSync(join(dir, 'new-seen.json'), 'utf8'));
const proto = JSON.parse(readFileSync(join(dir, 'rank5.json'), 'utf8')).lists['atractivo-puro'] as { key: TitleKey; s: number }[];
const flagsRaw = JSON.parse(readFileSync('public/catalog/v2026-11-22/attraction-flags.json', 'utf8')).flags as Record<string, string[]>;
const flags = new Map(Object.entries(flagsRaw).map(([k, v]) => [k as TitleKey, new Set(v)]));
const ans = ['no', 'quiza', 'si'] as const;
const interests: InterestRecord[] = [
  ...Object.entries(inter).map(([k, v], i) => ({ id: `x|${k}`, profileId: 'p', key: k as TitleKey, answer: ans[v], at: i + 1 })),
  ...Object.entries(seen).map(([k, v], i) => ({ id: `y|${k}`, profileId: 'p', key: k as TitleKey, answer: 'visto' as const, seenRating: v, at: 100 + i })),
];
const taste: TasteProfile = { profileId: 'p', version: 1, updatedAt: 1, notes: [], prefs: Object.fromEntries(PREFS.map((p) => [p.id, 'on'])),
  anchors: JSON.parse(readFileSync(join(dir, 'anchors.json'), 'utf8')) as TitleKey[] };
const ctx: AttractionContext = { idx: idx as any, flags, ratings, interests, taste };
// candidatos idénticos a los del prototipo (proveedores del prototipo, ≥ 80 votos, sin historial ni títulos de la cata 1)
const PROV = new Set([8, 1796, 119, 9, 337, 1899, 384, 531, 582]);
const history = new Set(ratings.map((r) => r.key));
const excl = new Set([...Object.keys(cata1.mapping), ...Object.keys(seen)]);
const cands = idx.titles.filter((c: any) => !history.has(c.key) && !excl.has(c.key) && c.provAR.some((p: number) => PROV.has(p)) && c.votes >= 80).map((c: any) => c.key as TitleKey);
const t0 = performance.now();
const scores = scoreAttraction(ctx, cands);
const ranked = rankAttraction(scores, idx as any, 60);
const ms = performance.now() - t0;
let same = 0, firstDiff = -1, maxDelta = 0;
for (let i = 0; i < Math.min(proto.length, ranked.length); i++) {
  if (proto[i].key === ranked[i].key) same++; else if (firstDiff < 0) firstDiff = i;
  const s = scores.find((x) => x.key === proto[i].key);
  if (s) maxDelta = Math.max(maxDelta, Math.abs(s.order - proto[i].s));
}
console.log(JSON.stringify({ candidatos: cands.length, comparados: Math.min(proto.length, ranked.length), mismaPosicion: same, primeraDiferencia: firstDiff, maxDiferenciaPuntaje: maxDelta, msPuntuar: Math.round(ms) }));
if (same !== Math.min(proto.length, ranked.length)) { console.log('prototipo:', proto.slice(0, 15).map((x) => x.key).join(' ')); console.log('integrado:', ranked.slice(0, 15).map((x) => x.key).join(' ')); process.exit(2); }
