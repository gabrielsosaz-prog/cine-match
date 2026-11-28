// v4.3 · Pruebas funcionales y de seguridad de los intereses compartidos contra el backend REAL (Supabase de producción),
// con cuatro usuarios efímeros A, B, C y D usando la API directamente (no la interfaz). Incluye tiempo real y avisos.
// Al final se eliminan las cuentas de prueba (y con ellas, en cascada, todos sus datos).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { findProject, sql } from './mgmt.mjs';

const cfg = readFileSync('src/social/config.ts', 'utf8');
const URL_ = cfg.match(/url: '([^']+)'/)?.[1];
const KEY = cfg.match(/anonKey: '([^']+)'/)?.[1];
const ref = (await findProject()).id;
const run = Date.now().toString(36);
const results = [];
const ok = (cond, name) => { results.push([Boolean(cond), name]); console.log(`${cond ? '✓' : '✗'} ${name}`); };
const fails = async (p, re, name) => {
  let msg = '';
  try { const r = await p; if (r?.error) msg = r.error.message ?? JSON.stringify(r.error); } catch (e) { msg = String(e?.message ?? e); }
  ok(msg && re.test(msg), `${name} (${msg ? msg.slice(0, 80) : 'sin error'})`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function user(tag, name) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `cmtest-${tag}-${run}@example.com`;
  const { data, error } = await c.auth.signUp({ email, password: `Prueba-${run}-${tag}!` });
  if (error || !data.session) throw new Error(`signUp ${tag}: ${error?.message ?? 'sin sesión'}`);
  await c.rpc('set_display_name', { p_name: name });
  return { c, id: data.user.id };
}
async function link(X, Y) {
  const inv = (await X.c.rpc('create_invite')).data[0];
  const r = await Y.c.rpc('accept_invite', { p_code: inv.code });
  if (r.error) throw new Error(r.error.message);
}
let clock = Date.now() + 1000;
const put = async (U, mt, id, f, v) => {
  const r = await U.c.rpc('put_shared', { p_items: [{ t: mt, id, f, v, at: new Date(clock += 1000).toISOString() }] });
  if (r.error) return { status: `error: ${r.error.message}` };
  return r.data[0];
};
const their = async (U, contact, id) => ((await U.c.rpc('get_shared')).data ?? []).find((g) => g.contact === contact && g.tmdb_id === id)?.answer ?? '∅';
const events = async (U, kind, id) => ((await U.c.from('social_events').select('id, kind, tmdb_id, title').eq('kind', kind).eq('tmdb_id', id)).data ?? []);
const perms = (U, contact, patch) => U.c.from('contacts').update(patch).eq('owner', U.id).eq('contact', contact);

const t0 = Date.now();
const A = await user('a', 'Ana Prueba'), B = await user('b', 'Beto Prueba'), C = await user('c', 'Carla Prueba'), D = await user('d', 'Dani Prueba');
const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
const timings = {};
try {
  await link(A, B); await link(B, C); await link(A, D);
  await fails(anon.rpc('get_shared'), /permission|not_authenticated|JWT/i, 'anon: sin acceso a get_shared');
  await fails(anon.from('shared_interests').select('*'), /permission/i, 'anon: sin acceso a intereses');
  const cA = (await A.c.from('contacts').select('share_interests, share_ratings, notify_matches').eq('contact', B.id)).data?.[0];
  ok(cA && !cA.share_interests && !cA.share_ratings, 'permisos nuevos desactivados al inicio');

  // Flujo principal (pasos 1-17)
  await A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 329865, p_title: 'La llegada', p_year: 2016 });
  ok((await put(A, 'movie', 329865, 'answer', 'mucho')).status === 'not_shared', 'sin autorización el interés no se guarda');
  await perms(A, B.id, { share_interests: true });
  ok((await put(A, 'movie', 329865, 'answer', 'mucho')).status === 'ok', '3. A marca Muchas ganas (autorizado)');
  ok(await their(B, A.id, 329865) === '∅', 'autorización unilateral: B no ve nada');
  await perms(B, A.id, { share_interests: true });
  ok(await their(B, A.id, 329865) === 'mucho', '6. con autorización mutua B ve el interés de A');

  // Tiempo real: A escucha sus eventos; C intenta escuchar los de A
  const got = [], spy = [];
  const chA = A.c.channel(`t-${run}-a`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_events', filter: `user_id=eq.${A.id}` }, (p) => got.push(p.new)).subscribe();
  const chC = C.c.channel(`t-${run}-c`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_events', filter: `user_id=eq.${A.id}` }, (p) => spy.push(p.new)).subscribe();
  // Los clientes de prueba necesitan el token para que el tiempo real aplique RLS
  A.c.realtime.setAuth((await A.c.auth.getSession()).data.session.access_token);
  C.c.realtime.setAuth((await C.c.auth.getSession()).data.session.access_token);
  await wait(4000);
  const tPut = Date.now();
  const r7 = await put(B, 'movie', 329865, 'answer', 'si');
  timings.put_shared_ms = Date.now() - tPut;
  ok(r7.status === 'ok' && r7.events?.length === 1, '7. B marca Me interesa → un evento de coincidencia');
  const tGet = Date.now();
  ok(await their(A, B.id, 329865) === 'si', '8. A ve la respuesta de B');
  timings.get_shared_ms = Date.now() - tGet;
  for (let i = 0; i < 20 && !got.some((e) => e.kind === 'match'); i++) await wait(500);
  const rt = got.find((e) => e.kind === 'match');
  ok(rt && rt.title === 'La llegada', `tiempo real: A recibe la coincidencia en vivo (${rt ? 'sí' : 'no'})`);
  ok(rt && rt.pushed_at === undefined && rt.user_id === A.id, 'tiempo real: sólo viaja el evento propio, sin control interno');
  ok(!spy.length, 'tiempo real: C no recibe eventos de A');
  const n1 = await B.c.functions.invoke('notify', { body: { event_ids: r7.events } });
  ok(!n1.error && n1.data?.sent === 0 && n1.data?.reasons?.includes('muted'), `aviso push: respeta que A no activó avisos de coincidencias (${JSON.stringify(n1.data ?? n1.error?.message)})`);
  const n2 = await B.c.functions.invoke('notify', { body: { event_ids: r7.events } });
  ok(n2.data?.reason === 'not_applicable', 'aviso push: no se repite para el mismo evento');
  const n3 = await C.c.functions.invoke('notify', { body: { event_ids: r7.events } });
  ok(n3.data?.reason === 'not_applicable', 'aviso push: C no puede dispararlo');

  ok((await put(B, 'movie', 329865, 'answer', 'mucho')).status === 'ok', '10. B cambia a Muchas ganas');
  ok(await their(A, B.id, 329865) === 'mucho', '11. A ve Muchas ganas');
  ok((await events(A, 'match_max', 329865)).length === 1, '12. un único aviso de coincidencia máxima');
  const dup = await B.c.rpc('put_shared', { p_items: [{ t: 'movie', id: 329865, f: 'answer', v: 'mucho', at: new Date(clock).toISOString() }] });
  ok(dup.data?.[0]?.status === 'stale', 'reenvío idéntico (reconexión) = idempotente');
  const old = await B.c.rpc('put_shared', { p_items: [{ t: 'movie', id: 329865, f: 'answer', v: 'no', at: new Date(Date.now() - 3600e3).toISOString() }] });
  ok(old.data?.[0]?.status === 'stale', 'cambio viejo que llega tarde no pisa al nuevo');
  ok((await events(A, 'match_max', 329865)).length === 1, 'sin avisos duplicados');
  ok((await put(B, 'movie', 329865, 'answer', 'no')).status === 'ok', '13. B cambia a No');
  ok(await their(A, B.id, 329865) === 'no', '15. A ve la respuesta negativa');
  ok((await A.c.from('social_events').select('id').neq('kind', 'shared')).data?.length === 2, 'marcar No no genera avisos');
  ok((await put(B, 'movie', 329865, 'answer', 'si')).status === 'ok', '16. B vuelve a Me interesa');
  ok(await their(A, B.id, 329865) === 'si', '17. la coincidencia reaparece');

  // Concurrencia: dos cambios simultáneos del mismo dueño → gana el de hora más nueva
  const late = new Date(clock + 5000).toISOString(), early = new Date(clock + 4000).toISOString(); clock += 6000;
  await Promise.all([B.c.rpc('put_shared', { p_items: [{ t: 'movie', id: 329865, f: 'answer', v: 'mucho', at: late }] }), B.c.rpc('put_shared', { p_items: [{ t: 'movie', id: 329865, f: 'answer', v: 'quiza', at: early }] })]);
  ok(await their(A, B.id, 329865) === 'mucho', 'actualizaciones simultáneas: gana la más nueva');

  // 18-19. Sentido inverso
  await B.c.rpc('send_recommendation', { p_recipient: A.id, p_media_type: 'tv', p_tmdb_id: 1396, p_title: 'Breaking Bad', p_year: 2008 });
  ok((await put(B, 'tv', 1396, 'answer', 'mucho')).status === 'ok', '18. B comparte otro título con A');
  ok(await their(A, B.id, 1396) === 'mucho', '19. A ve el interés de B');
  await put(A, 'tv', 1396, 'answer', 'mucho');
  ok((await events(B, 'match_max', 1396)).length === 1, '19. B recibe la coincidencia máxima (sentido inverso)');

  // 20. C: sin acceso
  ok(((await C.c.rpc('get_shared')).data ?? []).length === 0, '20. C: get_shared vacío');
  ok(((await C.c.from('shared_interests').select('*')).data ?? []).length === 0, '20. C: no lee intereses ajenos');
  ok(((await C.c.from('social_events').select('id')).data ?? []).length === 0, '20. C: no ve avisos ajenos');
  await fails(C.c.from('shared_interests').insert({ owner: A.id, media_type: 'movie', tmdb_id: 1, answer: 'si' }), /permission|denied/i, '20. C: no escribe a nombre de A');
  await fails(C.c.rpc('_prune_shared', { p_owner: A.id }), /permission|not find|does not exist/i, '20. C: funciones internas inaccesibles');
  ok((await put(C, 'movie', 329865, 'answer', 'si')).status === 'not_shared', '20. C no publica sobre títulos no intercambiados');
  // Enumeración: C envía a B el mismo título; no ve respuestas viejas de B
  await perms(C, B.id, { share_interests: true }); await perms(B, C.id, { share_interests: true });
  await C.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 329865, p_title: 'La llegada' });
  ok(await their(C, B.id, 329865) === '∅', 'enumeración: enviar un título no revela respuestas anteriores');
  ok(((await C.c.rpc('get_shared')).data ?? []).every((g) => g.contact !== A.id), 'C nunca ve datos de A');

  // Múltiples contactos: D no ve lo que A compartió con B
  await perms(A, D.id, { share_interests: true }); await perms(D, A.id, { share_interests: true });
  ok(await their(D, A.id, 329865) === '∅', 'múltiples contactos: D no ve el interés de A en un título de A y B');

  // Valoraciones posteriores: permiso aparte y mutuo
  await perms(A, B.id, { share_ratings: true });
  ok((await put(A, 'movie', 329865, 'rating', '8.5')).status === 'ok', 'A comparte su valoración posterior');
  ok(((await B.c.rpc('get_shared')).data ?? []).find((g) => g.tmdb_id === 329865)?.rating == null, 'valoración unilateral: B no la ve');
  await perms(B, A.id, { share_ratings: true });
  ok(Number(((await B.c.rpc('get_shared')).data ?? []).find((g) => g.tmdb_id === 329865)?.rating) === 8.5, 'con permiso mutuo B ve la valoración real de A');

  // Revocación
  await perms(B, A.id, { share_interests: false });
  ok(await their(A, B.id, 329865) === '∅' && await their(A, B.id, 1396) === '∅', 'revocar corta el acceso de inmediato');
  const leftover = await sql(ref, `select count(*)::int as n from public.shared_interests where owner = '${B.id}' and tmdb_id = 1396 and answer is not null`);
  ok(leftover?.[0]?.n === 0, 'revocar borra del servidor lo que ya no corresponde');
  ok(((await A.c.from('social_events').select('id').neq('kind', 'shared')).data ?? []).length === 0, 'revocar borra los avisos de coincidencias entre ambos');
  ok((await put(B, 'tv', 1396, 'answer', 'si')).status === 'not_shared', 'una operación pendiente no restablece el permiso');
  // Bloqueo
  await B.c.rpc('block_contact', { p_contact: C.id });
  ok(((await C.c.rpc('get_shared')).data ?? []).length === 0, 'bloqueo: el bloqueado no recibe más actualizaciones');
  ok((await put(C, 'movie', 329865, 'answer', 'mucho')).status === 'not_shared', 'bloqueo: no puede publicar hacia B');
  // Preferencias de avisos
  await A.c.from('social_profiles').update({ notify_matches: true, notify_max: true }).eq('user_id', A.id);
  const pr = (await A.c.from('social_profiles').select('notify_recs, notify_matches, notify_max')).data?.[0];
  ok(pr?.notify_recs === true && pr?.notify_matches === true && pr?.notify_max === true, 'preferencias de avisos editables por su dueño');
  await A.c.from('social_profiles').update({ notify_recs: false }).eq('user_id', B.id);
  ok((await sql(ref, `select notify_recs from public.social_profiles where user_id = '${B.id}'`))?.[0]?.notify_recs === true, 'nadie cambia preferencias ajenas');
  // Eliminación de cuenta
  await D.c.rpc('delete_my_account');
  const dleft = await sql(ref, `select (select count(*) from public.shared_interests where owner = '${D.id}')::int + (select count(*) from public.social_events where user_id = '${D.id}' or actor = '${D.id}')::int as n`);
  ok(dleft?.[0]?.n === 0, 'eliminar la cuenta borra intereses y avisos');
  A.c.removeChannel(chA); C.c.removeChannel(chC);
} finally {
  const bad = results.filter(([c]) => !c);
  console.log(`\n${results.length - bad.length}/${results.length} pruebas v4.3 OK contra el backend de producción en ${((Date.now() - t0) / 1000).toFixed(1)} s · put_shared ${timings.put_shared_ms} ms · get_shared ${timings.get_shared_ms} ms`);
  if (bad.length) { console.log('Fallaron:', bad.map(([, n]) => n).join(' | ')); process.exitCode = 1; }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
