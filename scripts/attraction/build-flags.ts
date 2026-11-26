/**
 * v4.0 · Marcas de categorías de Wikipedia que usa el motor de atractivo (las mismas expresiones del prototipo
 * ganador de la segunda cata). Entrada: eval/data/reference.json (categorías de Wikipedia, CC BY-SA, ya en el repo).
 * Salida: public/catalog/<versión>/attraction-flags.json → { "movie:123": ["war", …] } (sólo títulos con alguna marca).
 * Uso: npx tsx scripts/attraction/build-flags.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ATTRACTION_TAG_FLAGS } from '../../src/engine/attraction';

const man = JSON.parse(readFileSync('public/catalog/manifest.json', 'utf8'));
const ref = JSON.parse(readFileSync('eval/data/reference.json', 'utf8'));
// Normalización idéntica a la del prototipo (scripts de investigación 4.0, models4.inc.ts)
const DROP = /shot |Studios|Pictures|Award|award|IMAX|4DX|3D films|Dolby|ScreenX|D-Box|scored by|produced by|debuts|endings$|Netflix|Warner|Universal|Fox|Paramount|Lucasfilm|Marvel|Feige|postponed|strike|Emmy|Peabody|Choice|BAFTA|Saturn|Entertainment|Productions|Films$|original programming|television shows set in|Television shows filmed|Films set in \d|^\d{4}|Amblin|New Line|Legendary|Disney|DreamWorks|Pixar|HBO|Hulu|Prime Video|Apple TV|Peacock|Max original|Columbia|Lionsgate|A24|Focus Features|Miramax|Summit|Blumhouse|Annapurna|Searchlight|Sony|MGM|Orion|Regency|Village Roadshow|Relativity|TriStar|Touchstone|StudioCanal|Constantin|Gaumont|Pathé|Toho|Toei|Madhouse|Sunrise|Bones|Production I.G|Kyoto Animation|CloverWorks|MAPPA|Wit Studio|David Production|A-1|ufotable/;
const NAT = /^(American|English-language|British|Canadian|Australian|French|German|Spanish|Spanish-language|Italian|Japanese|Japanese-language|Korean|Korean-language|South Korean|Argentine|Mexican|Indian|Hindi-language|Chinese|Hong Kong|New Zealand|Irish|Scottish|Danish|Swedish|Norwegian|Belgian|Dutch|Brazilian|Colombian|Turkish|Polish|Russian|Israeli|Thai|Filipino|German-language|French-language|Italian-language|Portuguese-language|Mandarin-language|Cantonese-language|Swedish-language|Danish-language|Norwegian-language|Turkish-language|Polish-language|Russian-language|Hebrew-language|Thai-language|Tagalog-language|Arabic-language|Persian-language|Icelandic-language|Finnish-language|Dutch-language|Czech-language|Hungarian-language|Greek-language|Indonesian-language|Telugu-language|Tamil-language|Malayalam-language|Kannada-language|Marathi-language|Bengali-language|Punjabi-language|Urdu-language|Vietnamese-language|Romanian-language|Serbian-language|Croatian-language|Ukrainian-language)\s+/;
function normCat(c: string): string | null {
  if (DROP.test(c)) return null;
  let s = c.replace(/^(\d{4}s|\d{4})\s+/, '');
  for (let i = 0; i < 3; i++) s = s.replace(NAT, '').replace(/^(\d{4}s|\d{4})\s+/, '');
  s = s.replace(/\s+(films|film series|television series|television shows|television programs|television programmes|television miniseries|miniseries|anime and manga|works)$/i, '').trim().toLowerCase();
  if (!s || s.length < 4 || /^(films|television|series)$/.test(s)) return null;
  return s;
}
const out: Record<string, string[]> = {};
for (const [k, v] of Object.entries<any>(ref.titles)) {
  const tags = new Set<string>();
  for (const c of v.cats ?? []) { const n = normCat(ref.cats[c]); if (n) tags.add(n); }
  const flags = Object.entries(ATTRACTION_TAG_FLAGS).filter(([, re]) => [...tags].some((t) => re.test(t))).map(([f]) => f);
  if (flags.length) out[k] = flags;
}
const file = `public/catalog/v${man.version}/attraction-flags.json`;
writeFileSync(file, JSON.stringify({ version: man.version, source: 'Categorías de Wikipedia (CC BY-SA 4.0) normalizadas; sólo marcas', flags: out }));
console.log(file, Object.keys(out).length, 'títulos con marcas');
