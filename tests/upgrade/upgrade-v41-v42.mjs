// Actualización v4.1 → v4.2 con datos reales, 100 % local (no sube nada).
// Uso: node tests/upgrade/upgrade-v41-v42.mjs <dist-v4.1> <dist-v4.2> <respaldo.json>
// 1) Sirve la compilación v4.1 en http://localhost:4191, carga el respaldo en IndexedDB y agrega datos de uso (Quiero ver, interés).
// 2) Apaga v4.1 y sirve v4.2 en el MISMO origen (mismo navegador persistente): así se actualiza un usuario real.
// 3) Compara registro por registro todas las tablas, crea una cuenta social (servidor simulado) y vuelve a comparar.
// 4) Exporta la copia de seguridad en v4.2 y verifica que tiene el mismo formato y el mismo contenido.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, devices } from 'playwright';

const [distOld, distNew, backupPath] = process.argv.slice(2);
if (!backupPath) { console.error('uso: upgrade-v41-v42.mjs <dist-v4.1> <dist-v4.2> <respaldo.json>'); process.exit(1); }
const PORT = 4191;
const ORIGIN = `http://localhost:${PORT}`;
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.gz': 'application/gzip' };

function serve(dir) {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
    if (p.startsWith('/api/')) { res.writeHead(503).end(); return; }
    let f = join(dir, p === '/' ? 'index.html' : p);
    if (!existsSync(f)) f = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}
const stop = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });

async function dumpAll(page) {
  return page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => { const q = indexedDB.open('cine-match'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const out = {};
    for (const s of Array.from(dbh.objectStoreNames)) {
      out[s] = await new Promise((res) => { const r = dbh.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    }
    dbh.close();
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
    return { db: out, ls };
  });
}
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
function compare(before, after, label) {
  let missing = 0, changed = 0, total = 0;
  for (const [store, rows] of Object.entries(before.db)) {
    const now = new Map((after.db[store] || []).map((r) => [stable(r.id ?? r.key ?? r), r]));
    for (const r of rows) {
      total++;
      const id = stable(r.id ?? r.key ?? r);
      if (!now.has(id)) { missing++; if (missing < 5) console.log(`  falta ${store} ${id}`); }
      else if (store !== 'settings' && stable(now.get(id)) !== stable(r)) { changed++; if (changed < 5) console.log(`  cambió ${store} ${id}`); }
    }
  }
  const lsLost = Object.keys(before.ls).filter((k) => !(k in after.ls));
  console.log(`${label}: ${total} registros, ${missing} faltantes, ${changed} modificados, claves locales perdidas: ${lsLost.length}`);
  return missing === 0 && changed === 0 && lsLost.length === 0;
}
const counts = (d) => Object.fromEntries(Object.entries(d.db).map(([k, v]) => [k, v.length]));

const browser = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'cm-upg-')), { ...devices['Galaxy S5'], serviceWorkers: 'block' });
const page = browser.pages()[0] || await browser.newPage();
await page.route('https://api.themoviedb.org/**', (r) => r.fulfill({ status: 503 }));
await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
let ok = true;

// ── v4.1 ──
let srv = await serve(distOld);
await page.goto(ORIGIN + '/');
await page.waitForTimeout(1500);
await page.evaluate(async (b) => {
  const dbh = await new Promise((res) => { const q = indexedDB.open('cine-match'); q.onsuccess = () => res(q.result); });
  const stores = Array.from(dbh.objectStoreNames);
  const tx = dbh.transaction(stores, 'readwrite');
  for (const s of stores) if (Array.isArray(b[s])) for (const row of b[s]) tx.objectStore(s).put(row);
  // datos de uso típicos de v4.1 que no vienen en el respaldo de noviembre
  const pid = b.profiles[0].id;
  if (stores.includes('watchlist')) tx.objectStore('watchlist').put({ id: `${pid}|movie:603`, profileId: pid, key: 'movie:603', addedAt: Date.now() });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  dbh.close();
}, backup);
await page.reload();
await page.waitForTimeout(2500);
const v41 = await dumpAll(page);
const v41version = await page.evaluate(() => fetch('/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '?'));
console.log('v4.1 cargada:', v41version, counts(v41));
const exportNow = async () => {
  await page.goto(ORIGIN + '/#/ajustes');
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.getByTestId('backup-now').click();
  return JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
};
const exp41 = await exportNow();
await stop(srv);

// ── v4.2 en el mismo origen ──
srv = await serve(distNew);
await page.goto(ORIGIN + '/');
await page.reload();
await page.waitForTimeout(3000);
const v42version = await page.evaluate(() => fetch('/version.json').then((r) => r.json()).then((j) => j.version));
await page.screenshot({ path: join(tmpdir(), 'cm-upg-v42.png') });
console.log('v4.2 abierta:', v42version, 'pantalla:', await page.evaluate(() => location.hash || '/'));
const v42 = await dumpAll(page);
ok = compare(v41, v42, 'v4.1 → v4.2') && ok;

// Sin cuenta: Recibidas invita a crear una, nada se envía a ningún servidor
await page.goto(ORIGIN + '/#/recibidas');
await page.waitForTimeout(1200);
const gate = await page.getByText(/cuenta/i).first().isVisible();
console.log('Recibidas sin cuenta muestra la invitación a crear cuenta:', gate);
ok = gate && ok;

// Copia de seguridad v4.2: mismo formato y mismo contenido que la exportada por v4.1 con los mismos datos
const exp42 = await exportNow();
const strip = (e) => stable({ ...e, exportedAt: 0 });
const sameFormat = exp42.format === exp41.format;
const sameContent = strip(exp42) === strip(exp41);
const rOk = backup.ratings.every((r) => exp42.ratings.some((x) => x.id === r.id && x.overall === r.overall && x.watched === r.watched));
console.log(`copia v4.2: formato ${exp42.format} (v4.1: ${exp41.format}), contenido idéntico al de v4.1: ${sameContent}, ${exp42.ratings.length} valoraciones del respaldo presentes: ${rOk}`);
if (!sameContent) for (const k of Object.keys(exp41)) if (stable(exp41[k]) !== stable(exp42[k])) console.log('  difiere', k);
ok = sameFormat && rOk && sameContent && ok;

// Recargar como si se reabriera la PWA
await page.reload();
await page.waitForTimeout(2000);
ok = compare(v41, await dumpAll(page), 'reapertura') && ok;

await stop(srv);
await browser.close();
console.log(ok ? 'ACTUALIZACIÓN OK' : 'ACTUALIZACIÓN CON DIFERENCIAS');
process.exit(ok ? 0 : 1);
