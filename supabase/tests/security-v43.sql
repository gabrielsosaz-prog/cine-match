-- v4.3 · Intereses compartidos: pruebas funcionales y de seguridad en Postgres local con usuarios A, B, C y D.
-- Se ejecuta después de security.sql (reutiliza el esquema «t» de ayudas). Cada bloque actúa con el rol «authenticated».
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

reset role;
delete from auth.users;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a@prueba.invalid'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b@prueba.invalid'),
  ('cccccccc-0000-4000-8000-00000000000c', 'c@prueba.invalid'),
  ('dddddddd-0000-4000-8000-00000000000d', 'd@prueba.invalid');
\set A '''aaaaaaaa-0000-4000-8000-00000000000a'''
\set B '''bbbbbbbb-0000-4000-8000-00000000000b'''
\set C '''cccccccc-0000-4000-8000-00000000000c'''
\set D '''dddddddd-0000-4000-8000-00000000000d'''
delete from public.rate_events;
select (clock_timestamp() + interval '30 seconds')::text as t0 \gset

-- Ayudas: lote de un cambio y lectura de un estado
create or replace function t.put1(mt text, id int, f text, v text, at timestamptz default clock_timestamp()) returns text language sql as $$
  select status from public.put_shared(jsonb_build_array(jsonb_build_object('t', mt, 'id', id, 'f', f, 'v', v, 'at', at)));
$$;
create or replace function t.their(c uuid, id int) returns text language sql as $$
  select coalesce((select answer from public.get_shared() g where g.contact = c and g.tmdb_id = id), '∅');
$$;
grant execute on all functions in schema t to authenticated;

-- ── Vincular A-B, A-C (C sin permisos) y A-D
select t.login(:A); set role authenticated; select public.set_display_name('Ana');
select code as ab from public.create_invite() \gset
select code as ad from public.create_invite() \gset
reset role;
select t.login(:B); set role authenticated; select public.set_display_name('Beto'); select * from public.accept_invite(:'ab') \gset x_
reset role;
select t.login(:D); set role authenticated; select public.set_display_name('Dani'); select * from public.accept_invite(:'ad') \gset x_
reset role;
select t.login(:C); set role authenticated; select public.set_display_name('Carla');
select code as cb from public.create_invite() \gset
reset role;
select t.login(:B); set role authenticated; select * from public.accept_invite(:'cb') \gset x_
reset role;

-- ── Valores iniciales: todo desactivado; la app v4.2 sigue viendo su función de permisos
select t.login(:A); set role authenticated;
select t.ok((select bool_and(not share_interests and not share_ratings) from public.contacts), 'permisos nuevos desactivados al inicio');
select t.ok((select count(*) from public.contact_permissions()) = 2, 'contact_permissions de v4.2 sigue igual');
select t.ok((select bool_and(not their_share_interests) from public.contact_permissions_v43()), 'contact_permissions_v43: nadie autorizó');
select t.ok((select notify_recs and not notify_matches and not notify_max from public.social_profiles), 'avisos: recomendaciones sí, coincidencias opcionales');
-- A comparte Matrix con B (sin permisos, un interés no se publica)
select id as rec1 from public.send_recommendation(:B, 'movie', 603, 'Matrix') \gset
select t.ok(t.put1('movie', 603, 'answer', 'mucho') = 'not_shared', 'sin autorización el interés no se guarda en el servidor');
select t.ok((select count(*) from public.shared_interests) = 0, 'nada guardado');
-- Escritura directa prohibida
select t.fails($q$insert into public.shared_interests (owner, media_type, tmdb_id, answer, answer_at) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'movie', 603, 'mucho', now())$q$, 'permission denied', 'no se escribe la tabla directamente');
select t.fails($q$select public._prune_shared('bbbbbbbb-0000-4000-8000-00000000000b')$q$, 'permission denied', 'funciones internas no ejecutables');
select t.fails($q$select public._match_level('si', 'si')$q$, 'permission denied', 'clasificación interna no ejecutable');
-- Autorización unilateral de A
update public.contacts set share_interests = true where contact = :B;
select t.ok(t.put1('movie', 603, 'answer', 'mucho') = 'ok', '3. A marca Muchas ganas (autorizado, título intercambiado)');
select t.ok(t.put1('movie', 999, 'answer', 'si') = 'not_shared', 'título no intercambiado: no se guarda');
select t.ok(t.put1('movie', 603, 'answer', 'nada') = 'invalid', 'valor inválido rechazado');
select t.ok(t.put1('movie', 603, 'rating', '11') = 'invalid', 'valoración fuera de rango rechazada');
select t.ok(t.put1('movie', 603, 'rating', '8') = 'not_shared', 'valoraciones: requiere su propio permiso');
reset role;
select t.login(:B); set role authenticated;
select t.ok(t.their(:A, 603) = '∅', 'autorización unilateral: B todavía no ve el interés de A');
select t.ok((select their_share_interests from public.contact_permissions_v43() where contact = :A), 'B sabe que A autorizó (sólo el booleano)');
update public.contacts set share_interests = true where contact = :A;
select t.ok(t.their(:A, 603) = 'mucho', '6. con autorización mutua B ve el Muchas ganas de A');
select t.ok((select count(*) from public.get_shared()) = 1, 'B ve sólo ese título');
-- 7. B marca Me interesa → aviso de coincidencia para A
select t.ok(t.put1('movie', 603, 'answer', 'si') = 'ok', '7. B marca Me interesa');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 603) = 'si', '8. A ve la respuesta de B');
select t.ok((select count(*) from public.social_events where kind = 'match' and tmdb_id = 603 and title = 'Matrix') = 1, 'A recibe un aviso de nueva coincidencia (con título)');
select t.fails('select * from public.social_pushes', 'permission denied', 'control interno de avisos ilegible');
reset role;
-- 10-12. B pasa a Muchas ganas → una sola «coincidencia máxima»; reenvíos y desorden no duplican
select t.login(:B); set role authenticated;
select t.ok(t.put1('movie', 603, 'answer', 'mucho', (:'t0'::timestamptz + interval '1 seconds')) = 'ok', '10. B cambia a Muchas ganas');
select t.ok(t.put1('movie', 603, 'answer', 'mucho', (:'t0'::timestamptz + interval '1 seconds')) = 'stale', 'reenvío idéntico = idempotente');
select t.ok(t.put1('movie', 603, 'answer', 'no', (:'t0'::timestamptz - interval '1 hour')) = 'stale', 'cambio viejo que llega tarde no pisa al nuevo');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 603) = 'mucho', '11. A ve Muchas ganas de B');
select t.ok((select count(*) from public.social_events where kind = 'match_max' and tmdb_id = 603) = 1, '12. exactamente un aviso de coincidencia máxima');
reset role;
-- 13-15. B marca No: sin aviso negativo; A lo ve
select t.login(:B); set role authenticated;
select t.ok(t.put1('movie', 603, 'answer', 'no', (:'t0'::timestamptz + interval '2 seconds')) = 'ok', '13. B cambia a No');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 603) = 'no', '15. A consulta la respuesta negativa');
select t.ok((select count(*) from public.social_events where kind <> 'shared' and tmdb_id = 603) = 2, 'marcar No no genera avisos');
reset role;
-- 16-17. Vuelve a Me interesa: la coincidencia reaparece; el aviso no se repite en 10 minutos
select t.login(:B); set role authenticated;
select t.ok(t.put1('movie', 603, 'answer', 'si', (:'t0'::timestamptz + interval '3 seconds')) = 'ok', '16. B vuelve a Me interesa');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 603) = 'si', '17. la respuesta positiva reaparece');
select t.ok((select count(*) from public.social_events where kind = 'match' and tmdb_id = 603) = 1, 'idas y vueltas rápidas no repiten el aviso');
reset role;
-- 18-19. Sentido inverso: B comparte Breaking Bad con A
select t.login(:B); set role authenticated;
select id as rec2 from public.send_recommendation(:A, 'tv', 1396, 'Breaking Bad') \gset
select t.ok(t.put1('tv', 1396, 'answer', 'mucho') = 'ok', '18. B comparte otro título con su interés');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 1396) = 'mucho', '19. A ve el interés de B en lo que B le envió');
select t.ok(t.put1('tv', 1396, 'answer', 'mucho') = 'ok', '19. A responde Muchas ganas');
reset role;
select t.login(:B); set role authenticated;
select t.ok((select count(*) from public.social_events where kind = 'match_max' and tmdb_id = 1396) = 1, '19. B recibe la coincidencia máxima (funciona al revés)');
reset role;

-- ── 20. C (contacto de B, sin autorizaciones) no accede a nada de A ni de B
select t.login(:C); set role authenticated;
select t.ok((select count(*) from public.get_shared()) = 0, '20. C: get_shared vacío');
select t.ok((select count(*) from public.shared_interests) = 0, '20. C: no lee intereses ajenos');
select t.ok((select count(*) from public.social_events) = 0, '20. C: no ve avisos ajenos');
select t.ok(t.put1('movie', 603, 'answer', 'si') = 'not_shared', '20. C no puede escribir sobre un título que no intercambió');
update public.contacts set share_interests = true where contact = :B;
select t.ok((select count(*) from public.get_shared()) = 0, '20. C con autorización propia sigue sin ver nada (B no autorizó y no intercambiaron)');
-- Enumeración: C envía a B Matrix (que B respondió para A) → no ve la respuesta vieja
reset role;
select t.login(:B); set role authenticated;
update public.contacts set share_interests = true where contact = :C;
reset role;
select t.login(:C); set role authenticated;
select * from public.send_recommendation(:B, 'movie', 603, 'Matrix') \gset x_
select t.ok(t.their(:B, 603) = '∅', 'enumeración: enviar un título no revela respuestas anteriores de B');
reset role;
select t.login(:B); set role authenticated;
select t.ok(t.put1('movie', 603, 'answer', 'si', (:'t0'::timestamptz + interval '4 seconds')) = 'ok', 'B vuelve a publicar (decisión suya)');
reset role;
select t.login(:C); set role authenticated;
select t.ok(t.their(:B, 603) = 'si', 'después de que B la vuelve a publicar, C la ve');
select t.ok((select count(*) from public.get_shared() where contact = :A) = 0, 'C nunca ve datos de A');
reset role;

-- ── Múltiples contactos: D (vinculado con A, intereses mutuos) no ve Matrix hasta que A se la envía y la publica
select t.login(:D); set role authenticated; update public.contacts set share_interests = true where contact = :A; reset role;
select t.login(:A); set role authenticated; update public.contacts set share_interests = true where contact = :D; reset role;
select t.login(:D); set role authenticated;
select t.ok(t.their(:A, 603) = '∅', 'D no ve el interés de A en un título que A compartió con otra persona');
reset role;
select t.login(:A); set role authenticated;
select * from public.send_recommendation(:D, 'movie', 603, 'Matrix') \gset x_
select t.ok(t.their(:D, 603) = '∅', 'A sin respuesta de D');
select t.ok(t.put1('movie', 603, 'answer', 'mucho', (:'t0'::timestamptz + interval '5 seconds')) = 'ok', 'al compartir, A vuelve a publicar su interés');
reset role;
select t.login(:D); set role authenticated;
select t.ok(t.their(:A, 603) = 'mucho', 'D ve el interés de A en lo que A le envió');
reset role;

-- ── Valoraciones posteriores: permiso aparte y mutuo
select t.login(:A); set role authenticated;
update public.contacts set share_ratings = true where contact = :B;
select t.ok(t.put1('movie', 603, 'rating', '8.5') = 'ok', 'A comparte su valoración (autorizó valoraciones)');
reset role;
select t.login(:B); set role authenticated;
select t.ok((select rating from public.get_shared() where contact = :A and tmdb_id = 603) is null, 'valoración unilateral: B no la ve');
update public.contacts set share_ratings = true where contact = :A;
select t.ok((select rating from public.get_shared() where contact = :A and tmdb_id = 603) = 8.5, 'con permiso mutuo B ve la valoración real de A');
reset role;
select t.login(:D); set role authenticated;
select t.ok((select rating from public.get_shared() where contact = :A and tmdb_id = 603) is null, 'D no ve valoraciones de A (no autorizadas con D)');
reset role;

-- ── Para ver juntos por «Quiero ver»: el título queda intercambiado; un «No» lo saca de las positivas
select t.login(:A); set role authenticated;
update public.contacts set share_matches = true where contact = :B;
insert into public.want_items (owner, media_type, tmdb_id) values (:A, 'movie', 13);
select t.ok(t.put1('movie', 13, 'answer', 'no') = 'not_shared', 'Quiero ver de un solo lado: no intercambiado');
reset role;
select t.login(:B); set role authenticated;
update public.contacts set share_matches = true where contact = :A;
insert into public.want_items (owner, media_type, tmdb_id) values (:B, 'movie', 13);
select t.ok(t.put1('movie', 13, 'answer', 'si') = 'ok', 'coincidencia de Quiero ver = título intercambiado');
reset role;
select t.login(:A); set role authenticated;
select t.ok(t.put1('movie', 13, 'answer', 'no', (:'t0'::timestamptz + interval '1 seconds')) = 'ok', 'A marca No en un título de ambos');
select t.ok((select count(*) from public.get_matches(:B) where tmdb_id = 13) = 1, 'el «No» no toca las listas: sigue en la intersección');
select t.ok(t.their(:B, 13) = 'si', 'A ve el interés de B en la coincidencia');
reset role;
-- B saca el título de Quiero ver: deja de estar intercambiado y se borra lo compartido de ese título
select t.login(:B); set role authenticated;
delete from public.want_items where tmdb_id = 13;
reset role;
select t.ok((select count(*) from public.shared_interests where tmdb_id = 13) = 0, 'sin intercambio se borran los intereses de ese título (ambos lados)');

-- ── Revocación: corta el acceso, borra lo que ya no corresponde y los avisos; lo pendiente no lo restablece
select t.login(:B); set role authenticated;
update public.contacts set share_interests = false where contact = :A;
reset role;
select t.ok((select count(*) from public.shared_interests where owner = :B and answer is not null and tmdb_id = 1396) = 0, 'revocar borra los intereses de B que sólo compartía con A');
select t.ok((select count(*) from public.shared_interests where owner = :B and tmdb_id = 603 and answer is not null) = 1, 'conserva el que sigue compartido con C');
select t.ok((select count(*) from public.social_events where kind <> 'shared' and ((user_id = :A and actor = :B) or (user_id = :B and actor = :A))) = 0, 'revocar borra los avisos de coincidencias entre ambos');
select t.login(:A); set role authenticated;
select t.ok(t.their(:B, 603) = '∅' and t.their(:B, 1396) = '∅', 'A deja de ver los intereses de B');
reset role;
select t.login(:B); set role authenticated;
select t.ok(t.put1('tv', 1396, 'answer', 'si', (:'t0'::timestamptz + interval '60 seconds')) = 'not_shared', 'una operación pendiente no restablece el permiso revocado');
select t.ok(not (select share_interests from public.contacts where contact = :A), 'el permiso sigue revocado');
select t.ok(t.their(:A, 603) = '∅', 'tampoco B ve los de A (hace falta autorización mutua)');
reset role;

-- ── Retirar un envío (Deshacer) quita el intercambio
select t.login(:C); set role authenticated;
select id as rec3 from public.send_recommendation(:B, 'movie', 550, 'El club de la pelea') \gset
select t.ok(t.put1('movie', 550, 'answer', 'si') = 'ok', 'C publica interés en lo que envía');
select t.ok(public.retract_recommendation(:'rec3'), 'C deshace el envío');
select t.ok((select count(*) from public.shared_interests where tmdb_id = 550) = 0, 'deshacer borra el interés compartido de ese título');
reset role;

-- ── Bloqueo: apaga permisos nuevos; el bloqueado no recibe más actualizaciones
select t.login(:B); set role authenticated;
select public.block_contact(:C);
select t.ok((select not share_interests and not share_ratings from public.contacts where contact = :C), 'bloquear apaga los permisos nuevos');
reset role;
select t.login(:C); set role authenticated;
select t.ok((select count(*) from public.get_shared()) = 0, 'el bloqueado no ve nada');
select t.ok(t.put1('movie', 603, 'answer', 'mucho', (:'t0'::timestamptz + interval '120 seconds')) = 'not_shared', 'el bloqueado no puede publicar hacia B');
reset role;
select t.ok((select count(*) from public.shared_interests where owner = :B and tmdb_id = 603) = 0, 'bloquear borra lo que B compartía sólo con C');
select t.ok((select count(*) from public.social_events where user_id = :C and actor = :B and created_at > now() - interval '1 second' and kind <> 'shared') = 0, 'sin avisos nuevos al bloqueado');

-- ── Avisos: preferencias propias editables; ajenas no
select t.login(:A); set role authenticated;
update public.social_profiles set notify_matches = true, notify_max = true;
select t.ok((select notify_matches and notify_max from public.social_profiles), 'A activa avisos de coincidencias');
update public.social_profiles set notify_matches = false where user_id = :B;
reset role;
select t.ok((select notify_matches from public.social_profiles where user_id = :B) = false, 'A no puede cambiar preferencias de B (RLS)');

-- ── Eliminación de cuenta: borra intereses y avisos en cascada
select t.login(:D); set role authenticated; select public.delete_my_account(); reset role;
select t.ok((select count(*) from public.shared_interests where owner = :D) + (select count(*) from public.social_events where user_id = :D or actor = :D) = 0, 'eliminar la cuenta borra intereses y avisos');
select t.login(:A); set role authenticated;
select t.ok((select count(*) from public.get_shared() where contact = :D) = 0, 'A deja de ver datos de la cuenta eliminada');
reset role;

-- ── Clasificación: las 16 combinaciones (más sin responder) son simétricas y siguen la tabla
reset role;
select t.ok((select bool_and(public._match_level(x, y) = public._match_level(y, x)) from unnest(array['no','quiza','si','mucho',null]) x, unnest(array['no','quiza','si','mucho',null]) y), 'clasificación simétrica (25 pares)');
select t.ok(public._match_level('mucho','mucho') = 'maxima' and public._match_level('mucho','si') = 'muy_alta' and public._match_level('si','si') = 'alta'
  and public._match_level('mucho','quiza') = 'posible' and public._match_level('si','quiza') = 'posible' and public._match_level('quiza','quiza') = 'posible_baja'
  and public._match_level('mucho','no') = 'sin' and public._match_level('si', null) = 'pendiente' and public._match_level('no', null) = 'sin', 'tabla de clasificación');
\o /dev/stdout
select string_agg(coalesce(x, '-') || '+' || coalesce(y, '-') || '=' || public._match_level(x, y), ' ' order by x, y) from unnest(array['no','quiza','si','mucho',null]) x, unnest(array['no','quiza','si','mucho',null]) y;

select format('%s pruebas de seguridad OK (total con v4.3)', count(*)) from t.results where ok;
