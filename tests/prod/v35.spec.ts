import { expect, test } from '@playwright/test';

/**
 * v3.5 en PRODUCCIÓN con TMDB real (perfil nuevo, navegador limpio): el motor principal sigue siendo 3.4.0 y la
 * comparación a ciegas arma 12 títulos reales sin repetir, guarda respuestas y exporta sin credenciales.
 * Con un perfil nuevo (menos de 8 notas) el motor candidato usa el orden de 3.4.0: esto prueba la herramienta, no
 * compara calidad.
 */
const log = (...a: unknown[]) => console.log('[prod v3.5]', ...a);
test('producción v3.5: motor principal 3.4.0 y comparación a ciegas', async ({ page }, info) => {
  test.setTimeout(900000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const v = await (await page.request.get('/version.json')).json();
  log(info.project.name, JSON.stringify(v));
  expect(v).toMatchObject({ version: '3.5.0', algorithm: 'hybrid-narrative-3.4.0', candidate: 'hybrid-personal-3.5.0' });
  await page.goto('/');
  await expect(page.getByText('Paso 1 de 3')).toBeVisible();
  for (const p of ['netflix', 'prime', 'disney', 'max', 'paramount']) { const c = page.getByTestId(`ob-${p}`); if (await c.count() && (await c.getAttribute('aria-pressed')) === 'false') await c.click(); }
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-finish').click();
  await expect(page.getByRole('heading', { name: 'Para vos' })).toBeVisible({ timeout: 240000 });
  await expect(page.getByTestId('rec-item').first()).toBeVisible({ timeout: 240000 });
  await page.goto('/#/ajustes');
  await page.getByTestId('ab-link').click();
  const t0 = Date.now();
  await page.getByTestId('ab-start').click();
  await expect(page.getByTestId('ab-item').first().or(page.getByTestId('ab-msg'))).toBeVisible({ timeout: 120000 });
  const keys = await page.getByTestId('ab-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
  log('comparación:', keys.length, 'títulos en', Date.now() - t0, 'ms');
  expect(keys.length).toBe(12);
  expect(new Set(keys).size).toBe(12);
  await page.getByTestId('ab-item').first().getByTestId('ab-mucho').click();
  await page.getByTestId('ab-item').nth(1).getByTestId('ab-vista').click();
  await page.reload();
  await expect(page.getByTestId('ab-item').first()).toHaveAttribute('data-answer', 'mucho');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ab-export').click()]);
  const raw = Buffer.concat(await (await dl.createReadStream()).toArray()).toString('utf8');
  expect(/eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/.test(raw)).toBe(false);
  expect(JSON.parse(raw).summary.answered).toBe(2);
  await page.screenshot({ path: `test-results/prod-${info.project.name}-v35-comparar.png`, fullPage: true });
  expect(errors).toEqual([]);
});
