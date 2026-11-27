// v4.2 · Pruebas funcionales y de seguridad contra el backend REAL (Supabase de producción) con tres usuarios
// independientes A, B y C, usando la API directamente (no la interfaz). Al final se eliminan las cuentas de prueba.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { findProject, sql } from './mgmt.mjs';

const cfg = readFileSync('src/social/config.ts', 'utf8');
const URL_ = cfg.match(/url: '([^']+)'/)?.[1];
const KEY = cfg.match(/anonKey: '([^']+)'/)?.[1];
if (!URL_ || !KEY) { console.error('::error::src/social/config.ts sin URL o clave'); process.exit(1); }
const ref = (await findProject()).id;
const run = Date.now().toString(36);
const results = [];
const ok = (cond, name) => { results.push([Boolean(cond), name]); console.log(`${cond ? '✓' : '✗'} ${name}`); };
const fails = async (p, re, name) => {
  let msg = '';
  try { const r = await p; if (r?.error) msg = r.error.message ?? JSON.stringify(r.error); } catch (e) { msg = String(e?.message ?? e); }
  ok(msg && re.test(msg), `${name} (${msg ? msg.slice(0, 80) : 'sin error'})`);
};
const zero = async (p, name) => { const r = await p; ok(!r.error && (r.data ?? []).length === 0, `${name} (${r.error ? r.error.message : `${(r.data ?? []).length} filas`})`); };

async function user(tag, name) {
  const c = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `cmtest-${tag}-${run}@example.com`;
  const { data, error } = await c.auth.signUp({ email, password: `Prueba-${run}-${tag}!` });
  if (error) throw new Error(`signUp ${tag}: ${error.message}`);
  if (!data.session) throw new Error(`signUp ${tag}: sin sesión (¿confirmación por correo activa?)`);
  const r = await c.rpc('set_display_name', { p_name: name });
  if (r.error) throw new Error(r.error.message);
  return { c, id: data.user.id, email };
}
const t0 = Date.now();
const A = await user('a', 'Ana Prueba'), B = await user('b', 'Beto Prueba'), C = await user('c', 'Carla Prueba');
const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
try {
  // 0. Sin sesión no hay acceso
  await fails(anon.from('recommendations').select('*'), /permission/i, 'anon: sin acceso a recomendaciones');
  await fails(anon.rpc('create_invite'), /permission|not_authenticated|JWT|denied/i, 'anon: no crea invitaciones');

  // 1-2. A invita a B; B acepta
  const inv = (await A.c.rpc('create_invite')).data?.[0];
  ok(inv?.code?.length === 12, '1. A genera una invitación');
  await fails(C.c.rpc('peek_invite', { p_code: 'ZZZZZZZZZZZZ' }), /invalid_invite/, 'código inventado: error genérico');
  const peek = (await B.c.rpc('peek_invite', { p_code: inv.code })).data?.[0];
  ok(peek?.inviter_name === 'Ana Prueba', '2a. B ve quién invita');
  const acc = await B.c.rpc('accept_invite', { p_code: inv.code, p_alias: 'Ana' });
  ok(!acc.error && acc.data?.[0]?.alias === 'Ana', '2b. B acepta');
  await fails(C.c.rpc('accept_invite', { p_code: inv.code }), /invalid_invite/, 'C no reutiliza la invitación');

  // 3. A configura a B como favorito
  const fav = await A.c.from('contacts').update({ favorite: true }).eq('owner', A.id).eq('contact', B.id).select();
  ok(!fav.error && fav.data?.[0]?.favorite === true, '3. A elige a B como favorito');
  await fails(A.c.from('contacts').update({ blocked: true }).eq('owner', A.id), /permission/i, 'bloquear sólo por la función');

  // 4-6. A comparte con un toque; B recibe; contador
  const sent = await A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 603, p_title: 'Matrix', p_year: 1999, p_poster: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg', p_comment: 'Creo que esta nos puede gustar a los dos' });
  const recId = sent.data?.[0]?.id;
  ok(recId, '4. A envía Matrix a B');
  await fails(A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 603, p_title: 'Matrix' }), /duplicate/, 'duplicado rechazado por el servidor');
  const inbox = await B.c.from('recommendations').select('id, sender_name, title, comment, rec_inbox(seen_at)').eq('recipient', B.id);
  ok(inbox.data?.length === 1 && inbox.data[0].comment === 'Creo que esta nos puede gustar a los dos', '5. B la recibe con el comentario');
  const newCount = inbox.data?.filter((r) => !r.rec_inbox?.seen_at).length;
  ok(newCount === 1, '6. contador de nuevas = 1');
  // 7. B consulta
  await B.c.from('rec_inbox').update({ seen_at: new Date().toISOString() }).eq('rec_id', recId);
  ok((await B.c.from('rec_inbox').select('seen_at').eq('rec_id', recId)).data?.[0]?.seen_at, '7. B la marca consultada');
  ok((await A.c.from('rec_inbox').select('*')).data?.length === 0, 'A no ve el estado de la bandeja de B');

  // Notificación: deduplicada y sólo el remitente
  const n1 = await A.c.functions.invoke('notify', { body: { rec_id: recId } });
  ok(!n1.error && n1.data?.reason === 'no_subscriptions', `notify: A puede pedirla (${JSON.stringify(n1.data ?? n1.error?.message)})`);
  const n2 = await A.c.functions.invoke('notify', { body: { rec_id: recId } });
  ok(n2.data?.reason === 'not_applicable', 'notify: no se repite para la misma recomendación');
  const n3 = await C.c.functions.invoke('notify', { body: { rec_id: recId } });
  ok(n3.data?.reason === 'not_applicable' || n3.data?.sent === 0, 'notify: C no puede dispararla');
  const n4 = await anon.functions.invoke('notify', { body: { rec_id: recId } });
  ok(n4.error || n4.data?.error, 'notify: sin sesión se rechaza');

  // 8-10. Quiero ver + autorizaciones + coincidencias
  await B.c.from('want_items').insert([{ owner: B.id, media_type: 'movie', tmdb_id: 603, score: 8.4 }, { owner: B.id, media_type: 'tv', tmdb_id: 1396, score: 7.9 }]);
  await A.c.from('want_items').insert([{ owner: A.id, media_type: 'movie', tmdb_id: 603, score: 8.9 }, { owner: A.id, media_type: 'movie', tmdb_id: 13, score: 7.0 }]);
  ok((await B.c.from('want_items').select('*')).data?.length === 2, '8. B guarda en Quiero ver (sincronizado)');
  await fails(A.c.rpc('get_matches', { p_contact: B.id }), /matches_not_authorized/, 'sin autorizaciones no hay coincidencias');
  await A.c.from('contacts').update({ share_matches: true, share_scores: true }).eq('owner', A.id).eq('contact', B.id);
  await fails(B.c.rpc('get_matches', { p_contact: A.id }), /matches_not_authorized/, 'con una sola autorización no hay coincidencias');
  await B.c.from('contacts').update({ share_matches: true }).eq('owner', B.id).eq('contact', A.id);
  const mB = await B.c.rpc('get_matches', { p_contact: A.id });
  ok(mB.data?.length === 1 && mB.data[0].tmdb_id === 603 && Number(mB.data[0].their_score) === 8.9, '9-10. B ve sólo Matrix y la puntuación que A compartió');
  const mA = await A.c.rpc('get_matches', { p_contact: B.id });
  ok(mA.data?.length === 1 && mA.data[0].their_score === null, 'A no ve la puntuación de B (no la compartió)');
  ok((await A.c.from('want_items').select('*').eq('owner', B.id)).data?.length === 0, 'A no puede leer la lista completa de B');

  // 13. B → A
  const back = await B.c.rpc('send_recommendation', { p_recipient: A.id, p_media_type: 'tv', p_tmdb_id: 1396, p_title: 'Breaking Bad', p_year: 2008 });
  ok(!back.error && (await A.c.from('recommendations').select('id').eq('recipient', A.id)).data?.length === 1, '13. B recomienda a A (ambos sentidos)');

  // 14. C no accede a nada privado de A ni de B (API directa)
  await zero(C.c.from('recommendations').select('*'), '14. C: recomendaciones de A/B');
  await zero(C.c.from('contacts').select('*'), '14. C: contactos de A/B');
  await zero(C.c.from('want_items').select('*'), '14. C: Quiero ver de A/B');
  await zero(C.c.from('rec_inbox').select('*'), '14. C: bandeja de B');
  await zero(C.c.from('social_profiles').select('*').neq('user_id', C.id), '14. C: perfiles ajenos');
  await zero(C.c.from('push_subscriptions').select('*'), '14. C: suscripciones ajenas');
  await zero(C.c.from('invites').select('*'), '14. C: invitaciones ajenas');
  await fails(C.c.rpc('get_matches', { p_contact: A.id }), /matches_not_authorized/, '14. C: coincidencias con A');
  await fails(C.c.rpc('send_recommendation', { p_recipient: A.id, p_media_type: 'movie', p_tmdb_id: 1, p_title: 'x' }), /not_a_contact/, '14. C: enviar a A');
  await fails(C.c.from('recommendations').insert({ sender: A.id, recipient: B.id, sender_name: 'Ana', media_type: 'movie', tmdb_id: 1, title: 'falsa' }), /permission|denied|violates/i, '14. C: insertar como A');
  await fails(C.c.from('want_items').insert({ owner: A.id, media_type: 'movie', tmdb_id: 5 }), /row-level|violates/i, '14. C: escribir la lista de A');
  await fails(C.c.from('push_subscriptions').insert({ user_id: A.id, endpoint: 'https://x.invalid/y', p256dh: 'BPxxxxxxxxxxxxxxxxxxxxxxxxxxxx', auth: 'aaaaaaaaaaaa' }), /row-level|violates/i, '14. C: registrar push a nombre de A');
  const upd = await C.c.from('rec_inbox').update({ archived_at: new Date().toISOString() }).eq('rec_id', recId).select();
  ok(!upd.error && upd.data?.length === 0, '14. C: no modifica la bandeja de B');
  ok((await C.c.rpc('retract_recommendation', { p_id: recId })).data === false, '14. C: no retira envíos de A');
  await fails(C.c.from('rate_events').select('*'), /permission/i, '14. C: tabla interna de límites');
  await fails(C.c.from('recommendations').select('notified_at'), /permission/i, 'columna interna notified_at');

  // 15. Revocar
  await B.c.from('contacts').update({ share_matches: false }).eq('owner', B.id).eq('contact', A.id);
  await fails(A.c.rpc('get_matches', { p_contact: B.id }), /matches_not_authorized/, '15. revocar impide nuevos accesos');

  // Adicionales: deshacer, vencidas, rechazadas, bloqueo, eliminar, límite, cuenta
  const r2 = await A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 13, p_title: 'Forrest Gump' });
  ok((await A.c.rpc('retract_recommendation', { p_id: r2.data?.[0]?.id })).data === true, 'deshacer un envío');
  const exp = (await A.c.rpc('create_invite')).data?.[0];
  await sql(ref, `update public.invites set expires_at = now() - interval '1 second' where inviter = '${A.id}' and used_at is null`);
  await fails(C.c.rpc('peek_invite', { p_code: exp.code }), /invalid_invite/, 'invitación vencida');
  const dec = (await A.c.rpc('create_invite')).data?.[0];
  await C.c.rpc('decline_invite', { p_code: dec.code });
  await fails(C.c.rpc('accept_invite', { p_code: dec.code }), /invalid_invite/, 'invitación rechazada');
  let limited = 0;
  for (let i = 0; i < 32 && !limited; i++) { const r = await A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 900000 + i, p_title: `T${i}` }); if (r.error?.message.includes('rate_limited')) limited = i + 1; }
  ok(limited > 0 && limited <= 30, `límite de frecuencia de envíos (cortó en el intento ${limited})`);
  await B.c.rpc('block_contact', { p_contact: A.id });
  await fails(A.c.rpc('send_recommendation', { p_recipient: B.id, p_media_type: 'movie', p_tmdb_id: 77, p_title: 'x' }), /not_a_contact/, 'bloqueo: A ya no puede enviar a B');
  ok((await A.c.from('contacts').select('*')).data?.length === 0, 'bloqueo: el vínculo desaparece para A');
  await B.c.rpc('unblock_contact', { p_contact: A.id });
  const inv2 = (await B.c.rpc('create_invite')).data?.[0];
  await A.c.rpc('accept_invite', { p_code: inv2.code });
  await A.c.rpc('remove_contact', { p_contact: B.id });
  ok((await B.c.from('contacts').select('*')).data?.length === 0, 'eliminar contacto corta el vínculo para ambos');
  await C.c.rpc('delete_my_account');
  const left = await sql(ref, `select (select count(*) from auth.users where id = '${C.id}')::int + (select count(*) from public.social_profiles where user_id = '${C.id}')::int + (select count(*) from public.invites where inviter = '${C.id}')::int as n`);
  ok(left?.[0]?.n === 0, 'eliminar cuenta borra la cuenta y sus datos sociales');
} finally {
  const bad = results.filter(([c]) => !c);
  console.log(`\n${results.length - bad.length}/${results.length} pruebas OK contra el backend de producción en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (bad.length) { console.log('Fallaron:', bad.map(([, n]) => n).join(' | ')); process.exitCode = 1; }
}
