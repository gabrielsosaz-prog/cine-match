-- Pruebas de seguridad del esquema social con tres usuarios independientes (A, B, C).
-- Se ejecuta con psql (ON_ERROR_STOP) contra un Postgres con bootstrap-local.sql + migraciones.
-- Cada bloque actúa con el rol «authenticated» y el JWT del usuario, igual que PostgREST en Supabase.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned

reset role;
drop schema if exists t cascade;
create schema t;
grant usage on schema t to authenticated, anon;
create table t.results (n serial, name text, ok boolean);
grant insert, select on t.results to authenticated, anon;
grant usage on sequence t.results_n_seq to authenticated, anon;
create function t.ok(cond boolean, name text) returns void language plpgsql as $$
begin
  insert into t.results (name, ok) values (name, coalesce(cond, false));
  if not coalesce(cond, false) then raise exception 'FALLÓ: %', name; end if;
end $$;
create function t.fails(q text, pattern text, name text) returns void language plpgsql as $$
declare msg text;
begin
  begin execute q; exception when others then msg := sqlerrm; end;
  perform t.ok(msg is not null and msg ~* pattern, name || ' (error: ' || coalesce(msg, 'ninguno') || ')');
end $$;
create function t.login(u text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false);
$$;
grant execute on all functions in schema t to authenticated, anon;

delete from auth.users;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a@prueba.invalid'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b@prueba.invalid'),
  ('cccccccc-0000-4000-8000-00000000000c', 'c@prueba.invalid');
\set A '''aaaaaaaa-0000-4000-8000-00000000000a'''
\set B '''bbbbbbbb-0000-4000-8000-00000000000b'''
\set C '''cccccccc-0000-4000-8000-00000000000c'''

-- ── anon no accede a nada
set role anon;
select t.fails('select * from public.recommendations', 'permission denied', 'anon no lee recomendaciones');
select t.fails('select * from public.contacts', 'permission denied', 'anon no lee contactos');
select t.fails($q$select public.create_invite()$q$, 'permission denied', 'anon no crea invitaciones');
reset role;

-- ── sin perfil no se puede invitar
select t.login(:A); set role authenticated;
select t.fails('select * from public.create_invite()', 'no_profile', 'invitar requiere nombre');
select public.set_display_name('Ana <b>Prueba</b>');
select t.ok((select display_name from public.social_profiles) = 'Ana <b>Prueba</b>', 'nombre guardado como texto plano');
select code as code_a from public.create_invite() \gset
select t.ok(length(:'code_a') = 12, 'código de 12 caracteres');
select t.ok((select count(*) from public.invites) = 1, 'A ve su invitación');
select t.fails('select code_hash from public.invites', 'permission denied', 'el hash del código no es legible');
reset role;

select t.login(:B); set role authenticated;
select public.set_display_name('Beto');
select t.fails($q$select * from public.peek_invite('ZZZZZZZZZZZZ')$q$, 'invalid_invite', 'código inexistente: error genérico');
select t.ok((select inviter_name from public.peek_invite(lower(:'code_a'))) = 'Ana <b>Prueba</b>', 'B ve quién lo invita (código sin mayúsculas)');
select t.ok((select count(*) from public.invites) = 0, 'B no ve invitaciones ajenas');
select * from public.accept_invite(:'code_a', 'Ani') \gset acc_
select t.ok(:'acc_alias' = 'Ani', 'B acepta con alias');
select t.ok((select count(*) from public.contacts) = 1 and (select alias from public.contacts) = 'Ani', 'B ve sólo su fila de contacto');
select t.fails($q$select * from public.accept_invite('$q$ || :'code_a' || $q$')$q$, 'invalid_invite', 'un código no se puede reusar');
reset role;

select t.login(:C); set role authenticated;
select public.set_display_name('Carla');
select t.fails($q$select * from public.peek_invite('$q$ || :'code_a' || $q$')$q$, 'invalid_invite', 'C no puede usar el código ya usado');
select t.ok((select count(*) from public.contacts) = 0, 'C no ve contactos de A ni B');
select t.ok((select count(*) from public.social_profiles) = 1, 'C sólo ve su propio perfil');
select t.fails($q$insert into public.contacts (owner, contact, alias) values ('cccccccc-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-00000000000a', 'x')$q$, 'permission denied', 'C no puede autovincularse insertando contactos');
select t.fails($q$select * from public.send_recommendation('aaaaaaaa-0000-4000-8000-00000000000a', 'movie', 603, 'Matrix')$q$, 'not_a_contact', 'C no puede enviar a A');
select t.fails($q$insert into public.recommendations (sender, recipient, sender_name, media_type, tmdb_id, title) values ('cccccccc-0000-4000-8000-00000000000c','aaaaaaaa-0000-4000-8000-00000000000a','C','movie',1,'x')$q$, 'permission denied', 'C no puede insertar recomendaciones directo');
select t.fails('select * from public.rate_events', 'permission denied', 'rate_events no es accesible');
reset role;

-- ── A: favorito y envío
select t.login(:A); set role authenticated;
select t.ok((select alias from public.contacts where contact = :B) = 'Beto', 'A ve a B con su nombre');
update public.contacts set favorite = true where contact = :B;
select t.ok((select favorite from public.contacts where contact = :B), 'A marca a B como favorito');
select t.fails($q$update public.contacts set blocked = true$q$, 'permission denied', 'bloquear sólo por la función');
select t.fails($q$update public.contacts set contact = 'cccccccc-0000-4000-8000-00000000000c'$q$, 'permission denied', 'no se puede reapuntar un contacto');
select id as rec1 from public.send_recommendation(:B, 'movie', 603, 'Matrix', 1999, '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg', E'Creo que esta nos puede gustar \x01a los dos') \gset
select t.fails($q$select * from public.send_recommendation('bbbbbbbb-0000-4000-8000-00000000000b', 'movie', 603, 'Matrix')$q$, 'duplicate', 'duplicado bloqueado en el servidor');
select id as rec2 from public.send_recommendation(:B, 'movie', 603, 'Matrix', p_resend => true) \gset
select t.fails($q$select * from public.send_recommendation('bbbbbbbb-0000-4000-8000-00000000000b', 'movie', 1, 'x', p_poster => 'javascript:alert(1)')$q$, 'violates check', 'póster con formato inválido rechazado');
select t.fails($q$select * from public.send_recommendation('cccccccc-0000-4000-8000-00000000000c', 'movie', 603, 'Matrix')$q$, 'not_a_contact', 'A no puede enviar a C (no vinculado)');
select t.ok((select count(*) from public.rec_inbox) = 0, 'el remitente no ve el estado de la bandeja ajena');
select t.fails($q$select notified_at from public.recommendations$q$, 'permission denied', 'notified_at es interno');
reset role;

select t.login(:B); set role authenticated;
select t.ok((select count(*) from public.recommendations where recipient = :B) = 2, 'B recibe las dos');
select t.ok((select comment from public.recommendations where id = :'rec1') = 'Creo que esta nos puede gustar a los dos', 'comentario sin caracteres de control');
select t.ok((select sender_name from public.recommendations where id = :'rec1') = 'Ana <b>Prueba</b>', 'nombre del remitente');
update public.rec_inbox set seen_at = now() where rec_id = :'rec1';
select t.ok((select seen_at is not null from public.rec_inbox where rec_id = :'rec1'), 'B marca consultada');
select t.fails($q$update public.rec_inbox set recipient = 'cccccccc-0000-4000-8000-00000000000c'$q$, 'permission denied', 'no se puede reasignar la bandeja');
select t.ok(not public.retract_recommendation(:'rec1'), 'el destinatario no puede retirar un envío ajeno');
-- B también envía a A (ambos sentidos)
select id as rec3 from public.send_recommendation(:A, 'tv', 1396, 'Breaking Bad', 2008) \gset
reset role;

select t.login(:C); set role authenticated;
select t.ok((select count(*) from public.recommendations) = 0, 'C no ve recomendaciones de A ni B');
select t.ok((select count(*) from public.rec_inbox) = 0, 'C no ve bandejas ajenas');
update public.rec_inbox set archived_at = now();
select t.ok(not public.retract_recommendation(:'rec1'), 'C no puede retirar envíos de A');
select t.fails($q$select * from public.get_matches('aaaaaaaa-0000-4000-8000-00000000000a')$q$, 'matches_not_authorized', 'C no obtiene coincidencias con A');
reset role;
select t.ok((select archived_at is null from public.rec_inbox where rec_id = :'rec1'), 'la escritura de C no afectó la bandeja de B');

-- ── Para ver juntos
select t.login(:A); set role authenticated;
insert into public.want_items (owner, media_type, tmdb_id, score) values (:A, 'movie', 603, 8.1), (:A, 'movie', 13, 7.0), (:A, 'tv', 1399, 6.5);
select t.fails($q$insert into public.want_items (owner, media_type, tmdb_id) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'movie', 999)$q$, 'row-level security', 'A no puede escribir la lista de B');
select t.fails($q$select * from public.get_matches('bbbbbbbb-0000-4000-8000-00000000000b')$q$, 'matches_not_authorized', 'sin autorizaciones no hay coincidencias');
update public.contacts set share_matches = true where contact = :B;
select t.fails($q$select * from public.get_matches('bbbbbbbb-0000-4000-8000-00000000000b')$q$, 'matches_not_authorized', 'con una sola autorización no hay coincidencias');
reset role;

select t.login(:B); set role authenticated;
select t.ok((select count(*) from public.want_items) = 0, 'B no ve la lista de A');
insert into public.want_items (owner, media_type, tmdb_id, score) values (:B, 'movie', 603, 9.0), (:B, 'tv', 1396, 8.0);
select t.ok((select their_share_matches from public.contact_permissions() where contact = :A), 'B ve que A autorizó');
update public.contacts set share_matches = true where contact = :A;
select t.ok((select count(*) from public.get_matches(:A)) = 1, 'B ve sólo la coincidencia (no la lista de A)');
select t.ok((select their_score is null from public.get_matches(:A)), 'sin permiso no se ve la puntuación de A');
reset role;

select t.login(:A); set role authenticated;
update public.contacts set share_scores = true where contact = :B;
select t.ok((select tmdb_id from public.get_matches(:B)) = 603, 'A ve la coincidencia Matrix');
select t.ok((select their_score is null from public.get_matches(:B)), 'A no ve la nota de B sin su permiso');
reset role;
select t.login(:B); set role authenticated;
select t.ok((select their_score from public.get_matches(:A)) = 8.1, 'B ve la nota de A tras su permiso');
update public.contacts set share_scores = true where contact = :A;
-- B quita el título de su lista: la coincidencia desaparece
delete from public.want_items where tmdb_id = 603;
select t.ok((select count(*) from public.get_matches(:A)) = 0, 'quitar de Quiero ver actualiza coincidencias');
insert into public.want_items (owner, media_type, tmdb_id, score) values (:B, 'movie', 603, 9.0);
-- B revoca la autorización
update public.contacts set share_matches = false where contact = :A;
reset role;
select t.login(:A); set role authenticated;
select t.fails($q$select * from public.get_matches('bbbbbbbb-0000-4000-8000-00000000000b')$q$, 'matches_not_authorized', 'revocar impide nuevos accesos');
reset role;

-- ── Límite de frecuencia
select t.login(:A); set role authenticated;
do $$ declare n int := 0; got text;
begin
  for i in 1..40 loop
    n := i;
    begin perform public.send_recommendation('bbbbbbbb-0000-4000-8000-00000000000b', 'movie', 10000 + i, 'T' || i);
    exception when others then got := sqlerrm; exit; end;
  end loop;
  -- A ya envió 2 (el original y el reenvío; los rechazados no cuentan): corta en el intento 29
  perform t.ok(got = 'rate_limited' and n = 29, 'límite de 30 envíos cada 10 minutos (cortó en el intento ' || n || ')');
end $$;
reset role;

-- ── Retirar (deshacer) y vencimiento
select t.login(:A); set role authenticated;
select t.ok(public.retract_recommendation(:'rec2'), 'A puede deshacer su envío');
reset role;
update public.recommendations set created_at = now() - interval '11 minutes' where id = :'rec1';
select t.login(:A); set role authenticated;
select t.ok(not public.retract_recommendation(:'rec1'), 'pasados 10 minutos no se retira');
select code as code_exp from public.create_invite() \gset
reset role;
update public.invites set expires_at = now() - interval '1 second' where inviter = :A and used_at is null;
select t.login(:C); set role authenticated;
select t.fails($q$select * from public.peek_invite('$q$ || :'code_exp' || $q$')$q$, 'invalid_invite', 'invitación vencida');
reset role;

-- ── Rechazar una invitación
select t.login(:A); set role authenticated;
select code as code_dec from public.create_invite() \gset
reset role;
select t.login(:C); set role authenticated;
select public.decline_invite(:'code_dec');
select t.fails($q$select * from public.accept_invite('$q$ || :'code_dec' || $q$')$q$, 'invalid_invite', 'una invitación rechazada no se puede aceptar');
reset role;
select t.login(:A); set role authenticated;
select t.ok((select count(*) from public.invites where declined_at is not null) = 1, 'A ve que la rechazaron');
reset role;

-- ── Bloqueo
select t.login(:B); set role authenticated;
select public.block_contact(:A);
select t.ok((select blocked from public.contacts where contact = :A), 'B bloqueó a A');
update public.contacts set favorite = true where contact = :A;
select t.ok(not (select favorite from public.contacts where contact = :A), 'un contacto bloqueado no se puede editar');
select code as code_b from public.create_invite() \gset
reset role;
select t.login(:A); set role authenticated;
select t.ok((select count(*) from public.contacts where contact = :B) = 0, 'A ya no tiene a B (vínculo cortado)');
select t.fails($q$select * from public.send_recommendation('bbbbbbbb-0000-4000-8000-00000000000b', 'movie', 77, 'x')$q$, 'not_a_contact', 'A no puede enviar a quien lo bloqueó');
select t.fails($q$select * from public.peek_invite('$q$ || :'code_b' || $q$')$q$, 'invalid_invite', 'A no puede usar invitaciones de quien lo bloqueó');
select t.ok((select count(*) from public.recommendations where recipient = :A) = 1, 'A conserva lo que ya recibió');
reset role;
select t.login(:B); set role authenticated;
select public.unblock_contact(:A);
select t.ok((select count(*) from public.contacts) = 0, 'desbloquear no revincula');
reset role;

-- ── Revincular y eliminar contacto
select t.login(:B); set role authenticated;
select code as code_b2 from public.create_invite() \gset
reset role;
select t.login(:A); set role authenticated;
select * from public.accept_invite(:'code_b2') \gset acc2_
select t.ok(:'acc2_alias' = 'Beto', 'alias por defecto = nombre del otro');
select public.remove_contact(:B);
select t.ok((select count(*) from public.contacts) = 0, 'A eliminó a B');
reset role;
select t.login(:B); set role authenticated;
select t.ok((select count(*) from public.contacts) = 0, 'eliminar borra el vínculo de ambos lados');
select t.fails($q$select * from public.get_matches('aaaaaaaa-0000-4000-8000-00000000000a')$q$, 'matches_not_authorized', 'sin vínculo no hay coincidencias');
reset role;

-- ── Eliminación de cuenta
select t.login(:C); set role authenticated;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (:C, 'https://fcm.googleapis.com/fcm/send/x', 'BPxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'aaaaaaaaaaaa');
select t.fails($q$insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'https://x.invalid/y', 'BPxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'aaaaaaaaaaaa')$q$, 'row-level security', 'C no registra push a nombre de A');
select public.delete_my_account();
reset role;
select t.ok((select count(*) from auth.users where id = :C) = 0, 'cuenta de C eliminada');
select t.ok((select count(*) from public.social_profiles where user_id = :C) + (select count(*) from public.push_subscriptions where user_id = :C) = 0, 'datos sociales de C eliminados en cascada');

select format('%s pruebas de seguridad OK', count(*)) from t.results where ok;
