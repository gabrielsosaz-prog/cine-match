import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// v4.2 · Tarjeta 3 × 2 (alternativa C), barra con «Recibidas», Ajustes reorganizado y uso sin cuenta (local-first).
// TMDB SIMULADO. El servicio social no se usa: sin cuenta no debe salir ninguna petición hacia Supabase.
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
const supabaseCalls: string[] = [];
async function blockSocial(page: Page) {
  await page.route(/supabase\.co/, (r) => { supabaseCalls.push(r.request().url()); return r.abort(); });
}

test('v4.2: tarjeta 3×2 en 360 px, Aspectos en la tarjeta, barra de 7 con Recibidas, Ajustes y uso sin cuenta', async ({ page }, info) => {
  test.setTimeout(120000);
  await blockSocial(page);
  await onboardQuick(page);
  const vw = await page.evaluate(() => window.innerWidth);

  // Barra inferior
  const nav = page.getByRole('navigation', { name: 'Navegación principal' });
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(['Inicio', 'Buscar', 'Similares', 'Quiero ver', 'Compartidas', 'Notas', 'Ajustes']);
  for (const l of await nav.getByRole('link').all()) {
    const b = (await l.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    expect(await l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0);
  await noHorizontalScroll(page);

  // Tarjeta: 6 acciones en 3 columnas × 2 filas, dentro de la tarjeta, táctiles ≥ 44 px, sin texto cortado
  const card = page.getByTestId('rec-item').first();
  const grid = card.getByTestId('card-actions');
  await expect(grid).toHaveAttribute('data-grid', '3x2');
  const ids = ['trailer-button', 'quick-want', 'share-main', 'quick-watched', 'quick-score', 'quick-aspects-grid'];
  const labels = ['Tráiler', 'Quiero verla', 'Compartir', 'Ya la vi', 'Puntuar', 'Aspectos'];
  const boxes = [];
  for (let i = 0; i < 6; i++) {
    const btn = grid.getByTestId(ids[i]);
    await expect(btn).toContainText(labels[i]);
    const b = (await btn.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44); expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
    expect(await btn.evaluate((e) => [...e.querySelectorAll('span')].every((s) => s.scrollWidth <= s.clientWidth + 1))).toBe(true);
    boxes.push(b);
  }
  const rows = [...new Set(boxes.map((b) => Math.round(b.y)))];
  expect(rows.length).toBe(2);
  expect(Math.round(boxes[0].y)).toBe(Math.round(boxes[2].y));
  expect(Math.round(boxes[3].y)).toBe(Math.round(boxes[5].y));
  // colores: Quiero verla amarillo, Compartir azul oscuro con texto celeste, Puntuar con estrella dorada
  expect(await grid.getByTestId('quick-want').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(244, 184, 63)');
  expect(await grid.getByTestId('share-main').evaluate((e) => { let n: Element | null = e; while (n && getComputedStyle(n).backgroundColor === 'rgba(0, 0, 0, 0)') n = n.parentElement; return n ? getComputedStyle(n).backgroundColor : ''; })).toBe('rgb(15, 39, 66)');
  expect(await grid.getByTestId('share-main').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(125, 211, 252)');
  await page.screenshot({ path: `test-results/${info.project.name}-v42-tarjeta.png` });

  // Aspectos abre el selector existente dentro de la tarjeta y guarda
  const key = await card.getAttribute('data-key');
  await grid.getByTestId('quick-aspects-grid').click();
  const panel = card.getByTestId('aspects-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('dim-acting').getByRole('radio', { name: /4 estrellas$/ }).click();
  await panel.getByTestId('aspects-save').click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => Object.keys((await page.evaluate(async (k) => {
    const req = indexedDB.open('cine-match');
    const dbh: IDBDatabase = await new Promise((res) => { req.onsuccess = () => res(req.result); });
    const all: { key: string; dimensions?: Record<string, number> }[] = await new Promise((res) => { const r = dbh.transaction('ratings').objectStore('ratings').getAll(); r.onsuccess = () => res(r.result); });
    dbh.close();
    return all.find((r) => r.key === k)?.dimensions ?? {};
  }, key))).length).toBeGreaterThan(0);
  await expect(card.getByTestId('quick-aspects-grid')).toContainText(/Aspectos 1\//);

  // Compartir sin cuenta: explica y no envía nada
  await grid.getByTestId('share-main').click();
  const sheet = page.getByTestId('share-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/cuenta|no están disponibles/);
  await noHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // Recibidas sin cuenta
  await page.getByTestId('nav-compartidas').click();
  await expect(page.getByText(/cuenta|no están disponibles/).first()).toBeVisible();
  await noHorizontalScroll(page);

  // Ajustes: menú con las secciones pedidas; Mis gustos se alcanza desde Ajustes
  await page.getByTestId('nav-ajustes').click();
  for (const t of ['settings-account', 'settings-taste', 'settings-contacts', 'settings-privacy', 'settings-notifications']) await expect(page.getByTestId(t)).toBeVisible();
  await expect(page.locator('#motor')).toHaveCount(1);
  await expect(page.locator('#copias')).toHaveCount(1);
  await page.getByTestId('settings-taste').click();
  await expect(page.getByText('Géneros preferidos')).toBeVisible();
  await noHorizontalScroll(page);

  // Quiero ver: tarjeta común con Compartir
  await page.getByTestId('nav-inicio').click();
  await page.getByTestId('rec-item').first().getByTestId('quick-want').click();
  await page.getByTestId('nav-pendientes').click();
  await expect(page.locator('[data-testid="card-actions"][data-grid="3x2"]').first()).toBeVisible();

  expect(supabaseCalls).toEqual([]);
});
