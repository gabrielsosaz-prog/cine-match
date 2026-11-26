import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildCatalog, fakeTmdbHandler } from '../fixtures/fakeTmdb';

// v4.0 · Motor de atractivo con el catálogo narrativo REAL (public/catalog) y TMDB SIMULADO. Los títulos del catálogo
// que el simulador no conoce se responden como disponibles en Netflix. Valida integración en Android, no calidad.
const catalog = buildCatalog(15);
const handler = fakeTmdbHandler(catalog);
const meta = JSON.parse(readFileSync('public/catalog/v2026-11-22/meta.json', 'utf8')) as { titles: [string, string, number][] };
const yearOf = new Map(meta.titles.map((t) => [t[0], t[2]]));

async function mockTmdb(page: Page) {
  await page.route('https://api.themoviedb.org/**', async (route) => {
    const url = route.request().url();
    let { status, body } = await handler(url);
    const m = new URL(url).pathname.replace(/^\/3/, '').match(/^\/(movie|tv)\/(\d+)(\/watch\/providers)?$/);
    if (status === 404 && m) {
      const id = Number(m[2]);
      const prov = { id, results: { AR: { link: 'https://www.themoviedb.org/', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: null }] } } };
      status = 200;
      body = m[3] ? prov : { id, [m[1] === 'movie' ? 'title' : 'name']: `Título ${id}`, genres: [], vote_average: 7, vote_count: 500, 'watch/providers': prov, credits: { cast: [], crew: [] } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
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
const dump = (page: Page, store: string) => page.evaluate(async (s) => {
  const req = indexedDB.open('cine-match');
  const dbh: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all: unknown[] = await new Promise((res) => { const r = dbh.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
  dbh.close();
  return all;
}, store);
const homeKeys = async (page: Page) => {
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 30000 });
  return page.getByTestId('rec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
};
async function pickEngine(page: Page, e: 'v3.4' | 'v3.5' | 'v4.0') {
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByTestId(`engine-${e}`).check();
  await expect(page.getByTestId(`engine-${e}`)).toBeChecked();
  await page.getByRole('link', { name: 'Inicio' }).click();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', e, { timeout: 45000 });
}

test('v4.0: perfil importado, ranking por atractivo con tres puntuaciones, interés persistente, perfil editable y estadísticas', async ({ page }, info) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await onboardQuick(page);
  const ratingsBefore = JSON.stringify(await dump(page, 'ratings'));

  // Importación de un perfil de gustos SINTÉTICO (formato /4) sin pisar valoraciones
  const now = Date.now();
  const file = {
    format: 'cine-match-export/4', exportedAt: new Date(now).toISOString(), profiles: [{ id: 'p-principal', name: 'Principal', createdAt: 1 }], settings: [], ratings: [],
    taste: [{ profileId: 'p-principal', version: 1, prefs: { modern: 'strict', twists: 'on', psychThriller: 'on' }, anchors: ['movie:1726', 'movie:155'], notes: [{ q: 'Prueba', a: 'Respuesta sintética' }], source: 'e2e', updatedAt: now }],
    interests: [{ id: 'p-principal|movie:27205|1', profileId: 'p-principal', key: 'movie:27205', answer: 'mucho', at: now - 1000, source: 'e2e' }],
  };
  await page.goto('/#/recuperar');
  await page.getByTestId('recovery-file').setInputFiles({ name: 'perfil.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.getByTestId('recovery-plan')).toBeVisible();
  await expect(page.getByTestId('plan-taste')).toBeVisible();
  await expect(page.getByTestId('plan-interests')).toHaveText('1');
  await page.getByTestId('plan-apply').click();
  await expect(page.getByRole('status')).toBeVisible();
  await page.goto('/#/');
  expect(JSON.stringify(await dump(page, 'ratings'))).toBe(ratingsBefore);

  // Cambio a v4.0 con CPU ×4 (gama media)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await pickEngine(page, 'v4.0');
  console.log('[v4.0]', info.project.name, 'cambio a v4.0 y ranking visible con CPU ×4 (ms):', Date.now() - t0);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await expect(page.getByTestId('engine-badge')).toContainText('no una probabilidad');
  const keys = await homeKeys(page);
  expect(keys.length).toBeGreaterThanOrEqual(5);
  // exclusión estricta del perfil: nada anterior al 2000; ni lo valorado ni lo ya respondido «mucho» como visto
  for (const k of keys) expect(yearOf.get(k) ?? 2000, k).toBeGreaterThanOrEqual(2000);
  const rated = new Set((await dump(page, 'ratings') as { key: string }[]).map((r) => r.key));
  for (const k of keys) expect(rated.has(k), k).toBe(false);
  const first = page.getByTestId('rec-item').first();
  await expect(first.getByTestId('v4-compat')).toBeVisible();
  await expect(first.getByTestId('v4-satisfaction')).toContainText('poco fiable');
  await expect(first.getByTestId('v4-public')).toContainText('TMDB');
  await expect(first.getByTestId('v4-why')).toBeVisible();
  await noHorizontalScroll(page);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/${info.project.name}-v40-ranking.png`, fullPage: false });

  // Respuestas de interés: se guardan aparte con motor y puesto, sin tocar notas
  const k1 = keys[0], k2 = keys[1];
  await page.locator(`[data-testid="rec-item"][data-key="${k1}"]`).getByTestId('interest-mucho').click();
  await expect(page.locator(`[data-testid="rec-item"][data-key="${k1}"]`).getByTestId('interest-mucho')).toHaveAttribute('aria-checked', 'true');
  await page.locator(`[data-testid="rec-item"][data-key="${k2}"]`).getByTestId('interest-no').click();
  await expect(page.locator(`[data-testid="rec-item"][data-key="${k2}"]`)).toHaveAttribute('data-dismissed', 'true');
  // el recálculo en segundo plano (como al descartar con el botón de siempre) termina antes de cerrar la app
  await expect.poll(async () => (await dump(page, 'runs') as { trigger: string; algorithmVersion: string }[]).some((x) => x.trigger === 'interés' && x.algorithmVersion === 'attraction-4.0.0'), { timeout: 30000 }).toBe(true);
  const ints = await dump(page, 'interests') as { key: string; answer: string; engine?: string; rank?: number }[];
  expect(ints.find((i) => i.key === k1)).toMatchObject({ answer: 'mucho', engine: 'attraction-4.0.0', rank: 1 });
  expect(ints.find((i) => i.key === k2)?.answer).toBe('no');
  const r = await dump(page, 'ratings') as { key: string; overall?: number; notInterested?: boolean }[];
  expect(r.find((x) => x.key === k1)).toBeUndefined();
  expect(r.find((x) => x.key === k2)?.notInterested).toBe(true);

  // Persiste al cerrar y abrir; el descartado no vuelve a aparecer
  await page.reload();
  await expect(page.getByTestId('engine-badge')).toHaveAttribute('data-engine', 'v4.0', { timeout: 45000 });
  const after = await homeKeys(page);
  expect(after).not.toContain(k2);
  await expect(page.locator(`[data-testid="rec-item"][data-key="${k1}"]`).getByTestId('interest-mucho')).toHaveAttribute('aria-checked', 'true');

  // Mi perfil de gustos: lo importado está, se edita sin rehacer el cuestionario y persiste
  await page.getByRole('link', { name: 'Ajustes' }).click();
  await page.getByTestId('taste-link').click();
  await expect(page.getByTestId('taste-profile')).toBeVisible();
  await expect(page.getByTestId('pref-modern')).toHaveAttribute('data-level', 'strict');
  await expect(page.getByTestId('anchor-remove-movie:1726')).toBeVisible();
  await expect(page.getByTestId('anchor-remove-movie:155')).toBeVisible();
  await page.getByTestId('pref-modern-on').click();
  await expect(page.getByTestId('pref-modern')).toHaveAttribute('data-level', 'on');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/${info.project.name}-v40-perfil.png`, fullPage: false });
  await page.reload();
  await expect(page.getByTestId('pref-modern')).toHaveAttribute('data-level', 'on', { timeout: 15000 });

  // Estadísticas por motor
  await page.goto('/#/estadisticas');
  await expect(page.getByTestId('engine-stats')).toBeVisible();
  await expect(page.getByTestId('stats-v4.0')).toContainText('Mostrados');
  await expect(page.getByTestId('stats-v4.0').getByTestId('stat-interest')).toHaveText('50 %');
  await expect(page.getByTestId('stats-v4.0')).toContainText('poco fiable');
  await noHorizontalScroll(page);

  // Los otros motores siguen disponibles y se puede volver libremente
  await page.goto('/#/');
  await pickEngine(page, 'v3.4');
  await expect(page.getByTestId('rec-item').first().getByTestId('v4-scores')).toHaveCount(0);
  await pickEngine(page, 'v3.5');
  await pickEngine(page, 'v4.0');

  // Exportación con los datos nuevos
  await page.getByRole('link', { name: 'Ajustes' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup-now').click()]);
  const raw = Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8');
  const ex = JSON.parse(raw);
  expect(ex.format).toBe('cine-match-export/4');
  expect(ex.taste[0].prefs.modern).toBe('on');
  expect(ex.interests.length).toBeGreaterThanOrEqual(3);
  expect(ex.shown.length).toBeGreaterThan(0);
  expect(raw).not.toContain('eyJprueba');
  expect(errors).toEqual([]);
});
