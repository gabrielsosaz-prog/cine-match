import { expect, test, type Page } from '@playwright/test';
import { catalog, deleteAccounts, FAKE, link, noHScroll, noticeText, onboard, phone, signUp } from './helpers';

/**
 * v4.3 · Intereses compartidos entre DOS sesiones independientes: A (Pixel 7) y B (pantalla de 360 px).
 *  - Local: servidor social simulado (FAKE_SOCIAL=1) y TMDB simulado.
 *  - CI «e2e»: Supabase de PRODUCCIÓN + TMDB real (proxy publicado), compilación de la rama.
 *  - CI «prodlive»: la app publicada, Supabase y TMDB reales.
 * Cubre el flujo principal pedido (vincular, permisos, compartir, responder, ver la respuesta, coincidencia máxima con
 * aviso, «No», volver a cambiar desde Buscar, sentido inverso, orden en Para ver juntos, revocar). C (tercero sin
 * permiso) se prueba contra la API directa en scripts/social/security-v43.mjs. Capturas v43-*.png sin datos personales.
 */
async function shot(page: Page, name: string, keepNotices = false) {
  // Los avisos flotantes tapan la tarjeta: se cierran antes de la captura (salvo en la del aviso)
  if (!keepNotices) for (const x of await page.getByRole('button', { name: 'Cerrar aviso' }).all()) await x.click({ timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(450); // fin de transiciones
  await page.screenshot({ path: test.info().outputPath(`v43-${name}.png`) });
}
const byKey = (p: Page, testId: string, key: string) => p.locator(`[data-testid="${testId}"][data-key="${key}"]`);

async function enableInterests(p: Page) {
  await p.goto('./#/ajustes/privacidad');
  const box = p.getByTestId('privacy-interests');
  await expect(box).toBeVisible({ timeout: 30000 });
  await expect(box).not.toBeChecked(); // todo arranca desactivado
  await box.click(); // no se activa hasta confirmar
  const consent = p.getByTestId('privacy-consent');
  await expect(consent).toHaveAttribute('data-what', 'interests');
  await expect(consent).toContainText('Muchas ganas');
  await p.getByTestId('privacy-consent-new').click();
  await expect(box).toBeChecked({ timeout: 20000 });
}

test('v4.3 · dos teléfonos: intereses compartidos de punta a punta', async ({ browser }) => {
  test.setTimeout(900000);
  if (FAKE) await fetch('http://localhost:4174/admin/reset', { method: 'POST' });
  const A = await phone(browser, 'Pixel 7', 'A');
  const B = await phone(browser, 'Galaxy S5', 'B');
  const a = A.page, b = B.page;
  try {
    await Promise.all([onboard(a), onboard(b)]);
    // Sin cuenta: ninguna tarjeta muestra el bloque social ni hay pedidos al servicio social
    await expect(a.getByTestId('shared-interests')).toHaveCount(0);
    await expect(a.getByTestId('rec-item').first().getByTestId('interest-row')).toBeVisible();

    await signUp(a, 'Ana Prueba', 'a');
    await signUp(b, 'Beto Prueba', 'b');
    // 1. A y B se vinculan
    await link(a, b, 'Ana');

    // 2-3. Permisos: arrancan apagados; ambos activan «Compartir intereses» (con explicación y consentimiento)
    await enableInterests(a);
    await enableInterests(b);
    await a.reload();
    await expect(a.getByTestId('privacy-row').first()).toContainText('Beto Prueba lo activó', { timeout: 30000 });
    await shot(a, 'permisos');
    // A quiere avisos de coincidencias nuevas y máximas (opcionales, apagados por defecto)
    await a.goto('./#/ajustes/notificaciones');
    for (const k of ['notifyMatches', 'notifyMax']) {
      const t = a.getByTestId(`pref-${k}`);
      await expect(t).not.toBeChecked();
      await t.check();
      await expect(t).toBeChecked();
    }
    await expect(a.getByTestId('pref-notifyRecs')).toBeChecked();

    // 4-5. A marca «Muchas ganas» en Inicio y lo comparte con su favorito
    await a.getByTestId('nav-inicio').click();
    const first = a.getByTestId('rec-item').first();
    const key = (await first.getAttribute('data-key'))!;
    const title = (await first.locator('h3').innerText()).trim();
    const ca = byKey(a, 'rec-item', key);
    await ca.getByTestId('interest-mucho').click();
    await expect(ca.getByTestId('interest-mucho')).toHaveAttribute('aria-checked', 'true');
    await expect(ca.getByTestId('shared-interests')).toHaveCount(0); // antes de compartir no es socialmente relevante
    await ca.getByTestId('share-main').click();
    await expect(noticeText(a)).toContainText('Recomendación enviada a Beto Prueba');
    await expect(noticeText(a)).toContainText('con tu interés');
    // 6. Compartir no es interés: B todavía no respondió → «Esperando respuesta» (no «privado»)
    const sa = ca.getByTestId('shared-interests');
    await expect(sa).toBeVisible();
    await expect(sa.getByTestId('shared-mine')).toHaveAttribute('data-answer', 'mucho');
    await expect(sa.getByTestId('shared-mine')).toHaveAttribute('data-state', 'shared', { timeout: 30000 });
    await expect(sa.getByTestId('shared-theirs')).toHaveAttribute('data-state', 'none');
    await expect(sa.getByTestId('shared-verdict')).toHaveText(/Esperando respuesta/);
    await ca.getByTestId('interest-row').scrollIntoViewIfNeeded();
    await shot(a, 'respuesta-pendiente');

    // 7-8. B la recibe en Compartidas › Recibidas y ve «Muchas ganas» de Ana sin haber respondido
    await b.getByTestId('nav-inicio').click();
    await expect(b.getByTestId('inbox-badge')).toHaveText('1', { timeout: 30000 });
    await b.getByTestId('nav-compartidas').click();
    await expect(b.getByTestId('inbox-tab-recibidas')).toHaveAttribute('aria-selected', 'true');
    const ib = byKey(b, 'inbox-item', key);
    await expect(ib.getByTestId('shared-theirs')).toHaveAttribute('data-answer', 'mucho', { timeout: 30000 });
    await expect(ib.getByTestId('shared-mine')).toHaveAttribute('data-state', 'none');
    // 9. B responde «Me interesa» con los botones de siempre
    await ib.getByTestId('interest-si').click();
    await expect(ib.getByTestId('shared-mine')).toHaveAttribute('data-state', 'shared', { timeout: 30000 });
    await expect(ib.getByTestId('shared-verdict')).toHaveText(/^Les interesa a ambos/);
    await expect(ib).toHaveAttribute('data-level', 'muy_alta');
    await ib.getByTestId('shared-interests').scrollIntoViewIfNeeded();
    await shot(b, 'recibidas');
    await noHScroll(b);

    // 10. A lo ve en Inicio (tiempo real, sin recargar) y con el aviso de coincidencia nueva
    await expect(sa.getByTestId('shared-theirs')).toHaveAttribute('data-answer', 'si', { timeout: 30000 });
    await expect(sa.getByTestId('shared-verdict')).toHaveText(/^Les interesa a ambos/);
    await expect(a.getByTestId('notice-info').filter({ hasText: 'Nueva coincidencia' })).toBeVisible({ timeout: 30000 });
    await ca.getByTestId('interest-row').scrollIntoViewIfNeeded();
    await shot(a, 'tarjeta-ambos-intereses');

    // 11. A en Enviadas: destinatario, respuesta, coincidencia, resumen y filtros por respuesta
    await a.getByTestId('nav-compartidas').click();
    await a.getByTestId('inbox-tab-enviadas').click();
    const sent = byKey(a, 'sent-item', key);
    await expect(sent).toHaveAttribute('data-their', 'si', { timeout: 30000 });
    await expect(sent).toHaveAttribute('data-level', 'muy_alta');
    await expect(sent.getByTestId('sent-to-name')).toHaveText('Beto Prueba');
    await expect(a.getByTestId('sent-summary')).toBeVisible();
    await sent.getByTestId('interest-row').scrollIntoViewIfNeeded();
    await shot(a, 'enviadas');
    await a.getByTestId('sent-filter-si').click();
    await expect(a.getByTestId('sent-item')).toHaveCount(1);
    await shot(a, 'enviadas-filtro-respuesta');
    await a.getByTestId('sent-filter-no').click();
    await expect(a.getByTestId('sent-item')).toHaveCount(0);
    await a.getByTestId('sent-filter-todas').click();

    // 12-13. B cambia a «Muchas ganas» → coincidencia máxima, un único aviso para A
    await ib.getByTestId('interest-mucho').click();
    await expect(ib).toHaveAttribute('data-level', 'maxima', { timeout: 30000 });
    await expect(a.getByTestId('notice-info').filter({ hasText: 'Ambos tienen muchas ganas' })).toBeVisible({ timeout: 30000 });
    await shot(a, 'aviso-coincidencia', true);
    // El aviso lleva a Para ver juntos con el título destacado
    await a.getByTestId('notice-info').filter({ hasText: 'Ambos tienen muchas ganas' }).getByTestId('notice-info-action').click();
    await expect(a).toHaveURL(/tab=juntos/);
    const ta = byKey(a, 'together-item', key);
    await expect(ta).toBeVisible({ timeout: 60000 });
    await expect(ta.getByTestId('together-level')).toHaveText(/Coincidencia máxima|máxima/i);
    await expect(a.getByTestId('together-n-max')).toHaveText(/1/);
    await ta.scrollIntoViewIfNeeded();
    await shot(a, 'coincidencia-maxima');

    // 14. Sentido inverso: B recomienda dos títulos a Ana desde Buscar; ambos responden
    const others: { key: string; mine: 'si' | 'mucho'; theirs: 'si' | 'quiza' }[] = [];
    for (const [i, q] of (FAKE ? [catalog[3].name, catalog[5].name] : ['Breaking Bad', 'Dark']).entries()) {
      await b.getByTestId('nav-buscar').click();
      await b.getByTestId('search-input').fill(q);
      const hit = b.getByTestId('search-result').first();
      await expect(hit).toBeVisible({ timeout: 30000 });
      const k2 = (await hit.getAttribute('data-key'))!;
      if (k2 === key || others.some((o) => o.key === k2)) continue;
      await hit.getByTestId('share-icon').click();
      await b.getByTestId('share-send').click();
      await expect(noticeText(b)).toContainText('Recomendación enviada a Ana');
      // En Buscar aparece el bloque compartido sólo para el título ya intercambiado
      const strip = byKey(b, 'search-result', k2).getByTestId('social-strip');
      await expect(strip).toBeVisible();
      const theirs = i === 0 ? 'si' : 'quiza';
      await strip.getByTestId(`interest-${theirs}`).click();
      await expect(strip.getByTestId('shared-mine')).toHaveAttribute('data-state', 'shared', { timeout: 30000 });
      others.push({ key: k2, mine: i === 0 ? 'si' : 'mucho', theirs });
    }
    expect(others.length).toBeGreaterThan(0);
    await a.getByTestId('nav-compartidas').click();
    await a.getByTestId('inbox-tab-recibidas').click();
    for (const o of others) {
      const it = byKey(a, 'inbox-item', o.key);
      await expect(it.getByTestId('shared-theirs')).toHaveAttribute('data-answer', o.theirs, { timeout: 60000 });
      await it.getByTestId(`interest-${o.mine}`).click();
      await expect(it.getByTestId('shared-mine')).toHaveAttribute('data-state', 'shared', { timeout: 30000 });
    }
    // Filtro de Recibidas por coincidencia
    await a.getByTestId('inbox-match').selectOption('posibles');
    if (others.length > 1) await expect(byKey(a, 'inbox-item', others[1].key)).toBeVisible();
    await expect(byKey(a, 'inbox-item', others[0].key)).toHaveCount(0);
    await a.getByTestId('inbox-match').selectOption('all');

    // 15. Para ver juntos ordenado por coincidencia: máxima → alta → (posibles fuera de «positivas»)
    await a.getByTestId('inbox-tab-juntos').click();
    await a.getByTestId('together-filter-todas').click();
    await expect(byKey(a, 'together-item', others[0].key)).toBeVisible({ timeout: 60000 });
    const levels = await a.getByTestId('together-level').evaluateAll((xs) => xs.map((x) => x.getAttribute('data-level')));
    const RANK = ['maxima', 'muy_alta', 'alta', 'ambos', 'posible', 'posible_baja', 'pendiente', 'sin'];
    expect(levels[0]).toBe('maxima');
    expect([...levels].sort((x, y) => RANK.indexOf(x!) - RANK.indexOf(y!))).toEqual(levels);
    await a.getByTestId('together-summary').scrollIntoViewIfNeeded();
    await a.evaluate(() => window.scrollBy(0, (document.querySelector('[data-testid="together-level"]')?.getBoundingClientRect().top ?? 0) - 260));
    await shot(a, 'para-ver-juntos-orden');
    await a.getByTestId('together-filter-positivas').click();
    if (others.length > 1) await expect(byKey(a, 'together-item', others[1].key)).toHaveCount(0);

    // 16-17. B responde «No» al primero → sin coincidencia, sin aviso; sale de las positivas
    await b.getByTestId('nav-compartidas').click();
    await byKey(b, 'inbox-item', key).getByTestId('interest-no').click();
    await expect(byKey(b, 'inbox-item', key)).toHaveAttribute('data-level', 'sin', { timeout: 30000 });
    await expect(byKey(a, 'together-item', key)).toHaveCount(0, { timeout: 30000 });
    await a.getByTestId('inbox-tab-enviadas').click();
    await expect(byKey(a, 'sent-item', key)).toHaveAttribute('data-their', 'no', { timeout: 30000 });
    await expect(byKey(a, 'sent-item', key).getByTestId('shared-verdict')).toHaveText(/^No hay coincidencia/);
    await byKey(a, 'sent-item', key).getByTestId('interest-row').scrollIntoViewIfNeeded();
    await shot(a, 'respuesta-negativa');
    await expect(a.getByTestId('notice-info').filter({ hasText: /coincidencia/i })).toHaveCount(0);

    // 18. B vuelve a «Me interesa» desde Buscar → la coincidencia reaparece
    await b.getByTestId('nav-buscar').click();
    await b.getByTestId('search-input').fill(title);
    await expect(b.getByTestId('search-result').first()).toBeVisible({ timeout: 30000 });
    const back = byKey(b, 'search-result', key);
    if (await back.count()) {
      await back.getByTestId('social-strip').getByTestId('interest-si').click();
    } else {
      // Si la búsqueda no lo devuelve (TMDB real), se cambia desde la ficha, que tiene el mismo bloque
      await b.goto(`./#/t/${key.replace(':', '/')}`);
      await b.getByTestId('social-strip').getByTestId('interest-si').click();
    }
    await expect(byKey(a, 'sent-item', key)).toHaveAttribute('data-their', 'si', { timeout: 30000 });
    await expect(byKey(a, 'sent-item', key)).toHaveAttribute('data-level', 'muy_alta');

    // 19. Barra inferior de 360 px con «Compartidas»
    await b.getByTestId('nav-inicio').click();
    await noHScroll(b);
    await shot(b, 'barra-360');

    // 20. B revoca «Compartir intereses»: A deja de ver su respuesta (privado, no se deduce)
    await b.goto('./#/ajustes/privacidad');
    await b.getByTestId('privacy-interests').click(); // se apaga al confirmarlo el servidor
    await expect(b.getByTestId('privacy-interests')).not.toBeChecked({ timeout: 20000 });
    await a.reload();
    await a.getByTestId('inbox-tab-enviadas').click();
    await expect(byKey(a, 'sent-item', key).getByTestId('shared-theirs')).toHaveAttribute('data-state', 'private-theirs', { timeout: 30000 });
    await expect(byKey(a, 'sent-item', key).getByTestId('shared-theirs')).toHaveAttribute('data-answer', '');
    // Los datos locales siguen intactos: la respuesta propia de A no cambió
    await expect(byKey(a, 'sent-item', key).getByTestId('shared-mine')).toHaveAttribute('data-answer', 'mucho');
  } finally {
    await deleteAccounts([a, b]);
    await A.ctx.close(); await B.ctx.close();
  }
});
