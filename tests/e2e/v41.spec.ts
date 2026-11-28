import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// v4.1 · Tarjeta común (Inicio, Similares y Quiero ver) y barra inferior de 7 accesos, en emulación Android.
// TMDB SIMULADO (los títulos del catálogo narrativo real que el simulador no conoce se responden como disponibles en
// Netflix). Los ids pares traen una sinopsis larga, para probar «Leer más».
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);
const LONG = 'Una sinopsis larga de prueba que describe la premisa del título con suficiente detalle como para superar el límite de la versión abreviada de la tarjeta, de modo que aparezca el botón para leer el resto sin salir del listado ni abrir la ficha completa.';

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const url = route.request().url();
    let { status, body } = await handler(url);
    const m = new URL(url).pathname.replace(/^\/3/, '').match(/^\/(movie|tv)\/(\d+)(\/watch\/providers)?$/);
    if (status === 404 && m) {
      const id = Number(m[2]);
      const prov = { id, results: { AR: { link: 'https://www.themoviedb.org/', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: null }] } } };
      status = 200;
      body = m[3] ? prov : { id, [m[1] === 'movie' ? 'title' : 'name']: `Título ${id}`, genres: [{ id: 18, name: 'Drama' }], overview: `Sinopsis del título ${id}.`, original_language: 'en', production_countries: [{ iso_3166_1: 'US' }], vote_average: 7, vote_count: 500, 'watch/providers': prov, credits: { cast: [], crew: [{ id: 5, name: 'Directora Prueba', job: 'Director', department: 'Directing' }] } };
    }
    if (m && !m[3] && status === 200 && Number(m[2]) % 2 === 0 && body && typeof body === 'object' && 'overview' in (body as object) && (body as { overview?: string }).overview) (body as { overview: string }).overview = LONG;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  await page.route('https://www.youtube-nocookie.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>reproductor</body></html>' }));
}
async function onboardQuick(page: Page) {
  await mockTmdb(page);
  await page.goto('/');
  await page.getByTestId('token-input').fill('eyJprueba');
  await page.getByTestId('save-token').click();
  await page.getByTestId('ob-next').click();
  const cards = page.getByTestId('quick-card');
  await expect(cards.first()).toBeVisible();
  for (let i = 0; i < 9; i++) await cards.nth(i).getByRole('button', { name: /: (9|8|7|6|5)$/ }).nth(i % 3).click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 20000 });
}
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
const dump = <T = Record<string, unknown>>(page: Page, store: string) => page.evaluate(async (s) => {
  const req = indexedDB.open('cine-match');
  const dbh: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all: unknown[] = await new Promise((res) => { const r = dbh.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
  dbh.close();
  return all;
}, store) as Promise<T[]>;
type R = { key: string; watched?: boolean; list?: string; overall?: number; dimensions?: Record<string, number>; comment?: string; notInterested?: boolean };
const ratingOf = async (page: Page, key: string) => (await dump<R>(page, 'ratings')).find((r) => r.key === key);
async function pickEngine(page: Page, e: 'v3.4' | 'v3.5' | 'v4.0') {
  await page.getByTestId('nav-ajustes').click();
  await page.getByTestId(`engine-${e}`).check();
  await page.getByTestId('nav-inicio').click();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', e, { timeout: 45000 });
}
/** Recuadros de puntuación: mismo tamaño, lado a lado, sólo nombre y valor, con los colores pedidos. */
async function checkBoxes(card: Locator, primary: string) {
  const a = card.getByTestId('box-primary'), b = card.getByTestId('score-public');
  await expect(a).toHaveAttribute('data-label', primary);
  const [ba, bb] = [await a.boundingBox(), await b.boundingBox()];
  expect(Math.abs(ba!.width - bb!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(ba!.height - bb!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(ba!.y - bb!.y)).toBeLessThanOrEqual(1);
  for (const t of [await a.innerText(), await b.innerText()]) expect(t).not.toMatch(/\/10|Público|fiable/i);
  expect(await a.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(48, 37, 25)');
  expect(await b.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(20, 45, 59)');
  expect(await a.locator('div').nth(1).evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).fontWeight])).toEqual(['rgb(255, 187, 56)', '800']);
  expect(await b.locator('div').nth(1).evaluate((e) => getComputedStyle(e).color)).toBe('rgb(69, 208, 255)');
}
/** Acciones de la tarjeta comunes a las tres pantallas. Devuelve la clave usada. */
async function exerciseCard(page: Page, card: Locator, name: string, shots: string, stars: [number, number] = [4, 5]) {
  const note = `Me atrapó la premisa (${name}).`;
  const key = (await card.getAttribute('data-key'))!;
  const y0 = await page.evaluate(() => window.scrollY);
  // Sinopsis visible sin abrir la ficha
  await expect(card.getByTestId('card-synopsis')).not.toContainText('Cargando', { timeout: 15000 });
  // Quiero verla: un toque, sin confirmación
  const want = card.getByTestId('quick-want');
  if ((await want.getAttribute('aria-pressed')) === 'true') { await want.click(); await expect(want).toHaveText(/Quiero verla/); }
  await want.click();
  await expect(want).toHaveText(/Guardada/);
  await expect.poll(async () => (await ratingOf(page, key))?.list).toBe('want');
  expect(await want.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color])).toEqual(['rgb(18, 50, 34)', 'rgb(74, 222, 128)']);
  // Ya la vi + deshacer: no toca la nota
  const before = await ratingOf(page, key);
  const w = card.getByTestId('quick-watched');
  for (const state of before?.watched ? [false, true] : [true, false]) {
    await w.click();
    await expect(w).toHaveText(state ? /Vista/ : /Ya la vi/);
    await expect.poll(async () => (await ratingOf(page, key))?.watched ?? false).toBe(state);
  }
  expect((await ratingOf(page, key))?.overall).toBe(before?.overall);
  // Interés: resaltado en amarillo, registrado aparte (no es una nota)
  await card.getByTestId('interest-si').click();
  await expect(card.getByTestId('interest-si')).toHaveAttribute('aria-checked', 'true');
  expect(await card.getByTestId('interest-si').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(244, 184, 63)');
  await expect(card.getByTestId('interest-visto')).toHaveCount(0);
  await expect.poll(async () => (await dump<{ key: string; answer: string }>(page, 'interests')).filter((i) => i.key === key).at(-1)?.answer).toBe('si');
  expect((await ratingOf(page, key))?.list).toBe('want'); // el interés no pisa el guardado
  // Tráiler: reproductor emergente y vuelta al mismo lugar
  const yT = await page.evaluate(() => window.scrollY);
  await card.getByTestId('trailer-button').click();
  const modal = page.getByTestId('trailer-modal');
  await expect(modal.or(card.getByTestId('trailer-none')).first()).toBeVisible();
  if (await modal.isVisible()) {
    await page.getByTestId('trailer-close').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(yT, -1);
  }
  // Puntuar: selector dentro de la tarjeta, número grande dorado, guardar marca vista
  await card.getByTestId('quick-score').click();
  await card.getByRole('button', { name: 'Nota general 8' }).click();
  await expect(card.getByTestId('score-big')).toHaveText('8');
  expect(await card.getByTestId('score-big').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 187, 56)');
  await card.getByTestId('score-save').click();
  await expect(card.getByTestId('quick-score')).toHaveText(/Tu nota 8/);
  await expect.poll(async () => { const r = await ratingOf(page, key); return [r?.overall, r?.watched]; }).toEqual([8, true]);
  // Editar la valoración existente
  await card.getByTestId('quick-score').click();
  await expect(card.getByTestId('score-big')).toHaveText('8');
  await card.getByRole('button', { name: 'Nota general 9' }).click();
  await card.getByTestId('score-save').click();
  await expect.poll(async () => (await ratingOf(page, key))?.overall).toBe(9);
  // Más información: cerrado al inicio, secciones en orden
  await expect(card.getByTestId('more-panel')).toHaveCount(0);
  await card.getByTestId('more-toggle').click();
  const panel = card.getByTestId('more-panel');
  await expect(panel).toBeVisible();
  const order = await panel.locator('section h4').allInnerTexts();
  expect(order.slice(0, 3)).toEqual(['Parecida a', 'Qué podría no gustarte', 'Información técnica']);
  await expect(panel.getByTestId('more-tech')).toContainText('Idioma original');
  await page.screenshot({ path: `test-results/${shots}-${name}-desplegada.png` });
  // Aspectos: siete en orden, se guardan sin salir
  await card.getByTestId('quick-aspects').click();
  const labels = await card.getByTestId('aspects-panel').locator('[role=radiogroup]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(labels.slice(0, 6)).toEqual(['Trama y guion', 'Actuaciones', 'Final o desenlace', 'Impacto emocional', 'Dirección y calidad visual', 'Ritmo narrativo']);
  await card.getByRole('radio', { name: `Trama y guion: ${stars[0]} estrellas` }).click();
  await card.getByRole('radio', { name: `Actuaciones: ${stars[1]} estrellas` }).click();
  await card.getByTestId('aspects-save').click();
  await expect.poll(async () => (await ratingOf(page, key))?.dimensions).toEqual({ story: stars[0], acting: stars[1] });
  // Comentario
  await card.getByTestId('card-comment').click();
  await card.getByTestId('comment').fill(note);
  await card.getByTestId('comment-save').click();
  await expect.poll(async () => (await ratingOf(page, key))?.comment).toBe(note);
  await card.getByTestId('card-comment').click();
  await expect(card.getByTestId('comment')).toHaveValue(note);
  await card.getByTestId('card-comment').click();
  // Mostrar menos
  await card.getByTestId('more-close').click();
  await expect(card.getByTestId('more-panel')).toHaveCount(0);
  await noHorizontalScroll(page);
  // todo lo anterior conservó el registro completo
  const end = await ratingOf(page, key);
  expect(end).toMatchObject({ list: 'want', overall: 9, watched: true, comment: note });
  // posición estable (la tarjeta sigue en la lista, en su lugar)
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y0)).toBeLessThan(2000);
  return key;
}

test('v4.1: tarjeta común en Inicio, Quiero ver y Similares, sincronizada y persistente; barra de 7 accesos', async ({ page }, info) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = info.project.name;
  await onboardQuick(page);

  // Barra inferior (v4.2): 7 accesos en orden (Mis gustos pasó a Ajustes), sin desplazamiento horizontal, áreas táctiles ≥ 44 px
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(['Inicio', 'Buscar', 'Similares', 'Quiero ver', 'Compartidas', 'Notas', 'Ajustes']);
  const vw = await page.evaluate(() => window.innerWidth);
  for (const l of await nav.getByRole('link').all()) {
    const b = (await l.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    expect(await l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
  expect(await page.getByTestId('nav-inicio').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(245, 184, 61)');
  expect(await page.getByTestId('nav-buscar').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(148, 163, 184)');
  await noHorizontalScroll(page);

  // ── Inicio (v3.4) ──
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.4', { timeout: 30000 });
  const first = page.getByTestId('rec-item').first();
  await checkBoxes(first, 'Para vos');
  await expect(first.getByTestId('card-meta')).toContainText(/Película|Serie/);
  await expect(first.getByTestId('more-toggle')).toHaveText(/Más información y acciones/);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${shots}-inicio-cerrada.png` });
  // «Leer más» en una sinopsis larga
  const longCard = page.getByTestId('rec-item').filter({ has: page.getByTestId('synopsis-more') }).first();
  await expect(longCard).toBeVisible({ timeout: 15000 });
  const short = await longCard.getByTestId('card-synopsis').innerText();
  await longCard.getByTestId('synopsis-more').click();
  await expect(longCard.getByTestId('card-synopsis')).toContainText('sin salir del listado');
  expect((await longCard.getByTestId('card-synopsis').innerText()).length).toBeGreaterThan(short.length);
  const target = page.getByTestId('rec-item').nth(2);
  await target.scrollIntoViewIfNeeded();
  const orderBefore = await page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  const homeKey = await exerciseCard(page, target, 'inicio', shots);
  // la tarjeta no se movió ni desapareció mientras se interactuaba
  expect(await page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(orderBefore);

  // ── Quiero ver: aparece «Guardada» y se sincroniza ──
  await page.getByTestId('nav-pendientes').click();
  const wcard = page.locator(`[data-testid="want-item"][data-key="${homeKey}"]`);
  await expect(wcard.getByTestId('quick-want')).toHaveText(/Guardada/);
  await checkBoxes(wcard, 'Para vos');
  await page.screenshot({ path: `test-results/${shots}-quiero-ver-cerrada.png` });
  await wcard.getByTestId('quick-want').click(); // quitar: la tarjeta sigue para poder deshacer
  await expect(wcard.getByTestId('quick-want')).toHaveText(/Quiero verla/);
  await expect.poll(async () => (await ratingOf(page, homeKey))?.list).toBeUndefined();
  expect((await ratingOf(page, homeKey))?.overall).toBe(9); // quitar de la lista no borra la nota
  await page.getByTestId('nav-inicio').click();
  await page.getByTestId('watched-filter-all').click();
  await expect(page.locator(`[data-testid="rec-item"][data-key="${homeKey}"]`).getByTestId('quick-want')).toHaveText(/Quiero verla/);
  await page.locator(`[data-testid="rec-item"][data-key="${homeKey}"]`).getByTestId('quick-want').click();
  await page.getByTestId('nav-pendientes').click();
  await expect(wcard.getByTestId('quick-want')).toHaveText(/Guardada/);
  await exerciseCard(page, wcard, 'quiero-ver', shots, [3, 4]);

  // ── Similares ──
  await page.getByTestId('nav-similares').click();
  await page.getByTestId('similar-search').fill('Thriller Film 1');
  await page.getByTestId('similar-hit').first().click();
  const scard = page.getByTestId('similar-item').nth(1);
  await expect(scard).toBeVisible({ timeout: 30000 });
  await expect(scard.getByTestId('card-compat')).toContainText('Similitud');
  await checkBoxes(scard, 'Para vos');
  await scard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${shots}-similares-cerrada.png` });
  const simKey = await exerciseCard(page, scard, 'similares', shots);
  await page.getByTestId('nav-pendientes').click();
  await expect(page.locator(`[data-testid="want-item"][data-key="${simKey}"]`).getByTestId('quick-want')).toHaveText(/Guardada/);

  // Persistencia al cerrar y reabrir
  const snapshot = JSON.stringify((await dump<R & { updatedAt: number }>(page, 'ratings')).sort((a, b) => a.key.localeCompare(b.key)));
  await page.reload();
  await expect(page.locator(`[data-testid="want-item"][data-key="${simKey}"]`).getByTestId('quick-want')).toHaveText(/Guardada/, { timeout: 15000 });
  await expect(page.locator(`[data-testid="want-item"][data-key="${homeKey}"]`).getByTestId('quick-score')).toHaveText(/Tu nota 9/);
  expect(JSON.stringify((await dump<R & { updatedAt: number }>(page, 'ratings')).sort((a, b) => a.key.localeCompare(b.key)))).toBe(snapshot);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('v4.1: la tarjeta se adapta a los tres motores sin mezclar puntajes; posición estable al desplegar', async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await onboardQuick(page);
  const card = () => page.getByTestId('rec-item').nth(1);
  // v3.4
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v3.4', { timeout: 30000 });
  await checkBoxes(card(), 'Para vos');
  // Posición estable al abrir y cerrar el desplegable de una tarjeta visible
  await card().scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  const top = (await card().boundingBox())!.y;
  await card().getByTestId('more-toggle').click();
  await expect(card().getByTestId('more-panel')).toBeVisible();
  expect(Math.abs((await card().boundingBox())!.y - top)).toBeLessThanOrEqual(1);
  await card().getByTestId('more-panel').getByTestId('more-close').scrollIntoViewIfNeeded();
  await card().getByTestId('more-close').click();
  await expect(card().getByTestId('more-panel')).toHaveCount(0);
  // la tarjeta queda a la vista (si su comienzo quedó arriba, se vuelve a él)
  await expect.poll(async () => (await card().boundingBox())!.y).toBeGreaterThanOrEqual(-1);
  expect((await card().boundingBox())!.y).toBeLessThan(await page.evaluate(() => window.innerHeight));
  console.log('[v4.1]', info.project.name, 'scroll antes/después del desplegable:', y, await page.evaluate(() => window.scrollY));
  // v3.5
  await pickEngine(page, 'v3.5');
  await checkBoxes(card(), 'Para vos');
  await card().getByTestId('more-toggle').click();
  await expect(card().getByTestId('more-reliability')).toContainText('v3.5');
  // v4.0: satisfacción propia, compatibilidad y advertencia de fiabilidad sólo en el desplegable
  await pickEngine(page, 'v4.0');
  await checkBoxes(card(), 'Satisfacción');
  await expect(card().getByTestId('card-compat')).toContainText('Compatibilidad');
  await expect(card().getByTestId('score-boxes')).not.toContainText('fiable');
  await card().getByTestId('more-toggle').click();
  await expect(card().getByTestId('more-reliability')).toContainText('poco fiable');
  await expect(card().getByTestId('more-reliability')).toContainText('No se considera fiable sólo por llegar a 8');
  // «Parecida a» nunca incluye el propio título
  const own = (await card().locator('h3').innerText()).trim();
  for (const t of await card().getByTestId('similar-ref-row').allInnerTexts()) expect(t.split('\n')[0].trim()).not.toBe(own);
  await card().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${info.project.name}-v40-desplegada.png` });
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});
