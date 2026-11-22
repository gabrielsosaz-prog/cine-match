// Copia el catálogo generado (rama catalog-data, ya descargada en una carpeta) a public/catalog/v<versión>/
// y escribe public/catalog/manifest.json. Uso: node scripts/catalog/import.mjs <carpeta>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const src = process.argv[2];
const meta = JSON.parse(readFileSync(join(src, 'catalog-meta.json'), 'utf8'));
const v = `v${meta.version}`;
const dir = join('public/catalog', v);
for (const d of existsSync('public/catalog') ? readdirSync('public/catalog') : []) if (d.startsWith('v') && d !== v) rmSync(join('public/catalog', d), { recursive: true });
mkdirSync(dir, { recursive: true });
cpSync(join(src, 'catalog-meta.json'), join(dir, 'meta.json'));
cpSync(join(src, 'catalog-emb.bin'), join(dir, 'emb.bin'));
writeFileSync('public/catalog/manifest.json', JSON.stringify({ version: meta.version, meta: `${v}/meta.json`, emb: `${v}/emb.bin`, titles: meta.n, embedded: meta.embedded, model: meta.model }, null, 1));
if (existsSync(join(src, 'eval-texts.json'))) { mkdirSync('eval/data', { recursive: true }); cpSync(join(src, 'eval-texts.json'), 'eval/data/texts.json'); }
if (existsSync(join(src, 'report.md'))) cpSync(join(src, 'report.md'), 'docs/catalog-report.md');
console.log('Catálogo', meta.version, meta.n, 'títulos,', meta.embedded, 'con vector →', dir);
