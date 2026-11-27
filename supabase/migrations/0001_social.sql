-- Cine Match AI v4.2 Social · esquema del servicio social (Supabase / Postgres 15+)
--
-- Principios:
--  * El historial personal NO vive acá. Sólo: alias de contactos, invitaciones, recomendaciones enviadas
--    explícitamente, la lista «Quiero ver» de quien autorizó «Para ver juntos» y suscripciones push.
--  * Toda escritura sensible pasa por funciones SECURITY DEFINER que validan auth.uid() en el servidor.
--  * RLS activado en todas las tablas; sin acceso para «anon». Permisos mínimos y explícitos.

-- ───────────────────────────── Tablas ─────────────────────────────

create table if not exists public.social_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  inviter uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  declined_at timestamptz,
  revoked_at timestamptz
);
create index if not exists invites_inviter_idx on public.invites (inviter, created_at desc);

-- Un vínculo activo = dos filas (una por lado), ninguna bloqueada. Cada lado edita sólo la suya.
create table if not exists public.contacts (
  owner uuid not null references auth.users (id) on delete cascade,
  contact uuid not null references auth.users (id) on delete cascade,
  alias text not null check (char_length(btrim(alias)) between 1 and 40),
  favorite boolean not null default false,
  blocked boolean not null default false,
  -- «Para ver juntos»: el dueño autoriza comparar su «Quiero ver» con este contacto
  share_matches boolean not null default false,
  -- el dueño autoriza que este contacto vea su puntuación personalizada en las coincidencias
  share_scores boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (owner, contact),
  check (owner <> contact),
  check (not (blocked and (favorite or share_matches or share_scores)))
);
create unique index if not exists contacts_one_favorite on public.contacts (owner) where favorite;
create index if not exists contacts_contact_idx on public.contacts (contact);

create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null references auth.users (id) on delete cascade,
  recipient uuid not null references auth.users (id) on delete cascade,
  sender_name text not null check (char_length(sender_name) between 1 and 40),
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id integer not null check (tmdb_id > 0),
  title text not null check (char_length(title) between 1 and 200),
  year integer check (year between 1870 and 2100),
  poster_path text check (poster_path ~ '^/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$'),
  comment text check (char_length(comment) between 1 and 280),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  check (sender <> recipient)
);
create index if not exists recs_recipient_idx on public.recommendations (recipient, created_at desc);
create index if not exists recs_sender_idx on public.recommendations (sender, media_type, tmdb_id);

-- Estado de la bandeja: sólo lo ve quien recibe (el remitente no sabe si la abriste o archivaste)
create table if not exists public.rec_inbox (
  rec_id uuid primary key references public.recommendations (id) on delete cascade,
  recipient uuid not null references auth.users (id) on delete cascade,
  seen_at timestamptz,
  archived_at timestamptz
);
create index if not exists rec_inbox_recipient_idx on public.rec_inbox (recipient);

-- «Quiero ver» de quien activó «Para ver juntos» con al menos un contacto. Sólo la ve su dueño;
-- los contactos autorizados reciben únicamente la intersección (get_matches).
create table if not exists public.want_items (
  owner uuid not null references auth.users (id) on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id integer not null check (tmdb_id > 0),
  score numeric(4, 2) check (score between 0 and 10),
  added_at timestamptz not null default now(),
  primary key (owner, media_type, tmdb_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  created_at timestamptz not null default now()
);
create index if not exists push_user_idx on public.push_subscriptions (user_id);

-- Límites de frecuencia (sin acceso directo desde la app)
create table if not exists public.rate_events (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (user_id, kind, at desc);

-- ───────────────────────────── RLS y permisos ─────────────────────────────

alter table public.social_profiles enable row level security;
alter table public.invites enable row level security;
alter table public.contacts enable row level security;
alter table public.recommendations enable row level security;
alter table public.rec_inbox enable row level security;
alter table public.want_items enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.rate_events enable row level security;

revoke all on public.social_profiles, public.invites, public.contacts, public.recommendations, public.rec_inbox,
  public.want_items, public.push_subscriptions, public.rate_events from anon, authenticated, public;

grant select, insert on public.social_profiles to authenticated;
grant update (display_name) on public.social_profiles to authenticated;
grant select (id, created_at, expires_at, used_at, declined_at, revoked_at) on public.invites to authenticated;
grant select on public.contacts to authenticated;
grant update (alias, favorite, share_matches, share_scores) on public.contacts to authenticated;
grant select (id, sender, recipient, sender_name, media_type, tmdb_id, title, year, poster_path, comment, created_at) on public.recommendations to authenticated;
grant select on public.rec_inbox to authenticated;
grant update (seen_at, archived_at) on public.rec_inbox to authenticated;
grant select, insert, update, delete on public.want_items to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;

drop policy if exists profiles_own on public.social_profiles;
create policy profiles_own on public.social_profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists invites_own on public.invites;
create policy invites_own on public.invites for select to authenticated using (inviter = auth.uid());

drop policy if exists contacts_own_select on public.contacts;
create policy contacts_own_select on public.contacts for select to authenticated using (owner = auth.uid());
drop policy if exists contacts_own_update on public.contacts;
create policy contacts_own_update on public.contacts for update to authenticated
  using (owner = auth.uid() and not blocked) with check (owner = auth.uid() and not blocked);

drop policy if exists recs_parties on public.recommendations;
create policy recs_parties on public.recommendations for select to authenticated
  using (sender = auth.uid() or recipient = auth.uid());

drop policy if exists inbox_own on public.rec_inbox;
create policy inbox_own on public.rec_inbox for select to authenticated using (recipient = auth.uid());
drop policy if exists inbox_own_update on public.rec_inbox;
create policy inbox_own_update on public.rec_inbox for update to authenticated
  using (recipient = auth.uid()) with check (recipient = auth.uid());

drop policy if exists want_own on public.want_items;
create policy want_own on public.want_items for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- rate_events: sin políticas = sin acceso para la app.

-- ───────────────────────────── Funciones auxiliares ─────────────────────────────

create or replace function public._uid() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return u;
end $$;

-- Registra un evento y falla si se superó el máximo en la ventana
create or replace function public._rate(p_user uuid, p_kind text, p_max int, p_window interval) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || p_kind, 0));
  select count(*) into n from rate_events where user_id = p_user and kind = p_kind and at > now() - p_window;
  if n >= p_max then raise exception 'rate_limited' using errcode = 'P0001', hint = p_kind; end if;
  insert into rate_events (user_id, kind) values (p_user, p_kind);
  delete from rate_events where user_id = p_user and kind = p_kind and at < now() - interval '2 days';
end $$;

create or replace function public._linked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from contacts where owner = a and contact = b and not blocked)
     and exists (select 1 from contacts where owner = b and contact = a and not blocked);
$$;

create or replace function public._norm_code(p text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create or replace function public._clean_text(p text, maxlen int) returns text language sql immutable as $$
  -- Texto plano: sin caracteres de control (salvo salto de línea), espacios recortados, vacío = null
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x09\x0B-\x1F\x7F​-‏‪-‮⁦-⁩]', '', 'g')), maxlen), '');
$$;

-- ───────────────────────────── Perfil ─────────────────────────────

create or replace function public.set_display_name(p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); n text := _clean_text(replace(p_name, E'\n', ' '), 40);
begin
  if n is null then raise exception 'invalid_name'; end if;
  insert into social_profiles (user_id, display_name) values (u, n)
  on conflict (user_id) do update set display_name = excluded.display_name;
end $$;

-- ───────────────────────────── Invitaciones ─────────────────────────────

-- Devuelve el código en claro UNA sola vez; se guarda sólo su hash. 12 caracteres de 31 símbolos ≈ 59 bits.
create or replace function public.create_invite() returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid := _uid();
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  c text := '';
  i int;
  exp timestamptz := now() + interval '72 hours';
begin
  if not exists (select 1 from social_profiles where user_id = u) then raise exception 'no_profile'; end if;
  perform _rate(u, 'invite', 10, interval '1 hour');
  -- Se omiten los bytes 6 y 8 de cada UUID v4 (llevan bits fijos de versión y variante)
  for i in 1..12 loop
    c := c || substr(alphabet, (get_byte(raw, (array[0,1,2,3,4,5,16,17,18,19,20,21])[i]) % 31) + 1, 1);
  end loop;
  -- Como máximo 5 invitaciones vigentes por persona: se revocan las más viejas
  update invites set revoked_at = now()
   where id in (select id from invites where inviter = u and used_at is null and revoked_at is null and declined_at is null and invites.expires_at > now()
                order by created_at desc offset 4);
  insert into invites (inviter, code_hash, expires_at) values (u, encode(sha256(convert_to(c, 'UTF8')), 'hex'), exp);
  return query select c, exp;
end $$;

create or replace function public._find_invite(p_code text) returns public.invites
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invites;
begin
  select * into inv from invites
   where code_hash = encode(sha256(convert_to(_norm_code(p_code), 'UTF8')), 'hex')
     and used_at is null and revoked_at is null and declined_at is null and expires_at > now();
  return inv;
end $$;

-- Ver quién invita antes de aceptar. Cualquier falla da el mismo error (no permite enumerar).
create or replace function public.peek_invite(p_code text) returns table (inviter_name text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); inv invites;
begin
  perform _rate(u, 'redeem', 20, interval '1 hour');
  inv := _find_invite(p_code);
  if inv.id is null or inv.inviter = u
     or exists (select 1 from contacts where owner = inv.inviter and contact = u and blocked) then
    raise exception 'invalid_invite';
  end if;
  return query select p.display_name, inv.expires_at from social_profiles p where p.user_id = inv.inviter;
end $$;

create or replace function public.accept_invite(p_code text, p_alias text default null) returns table (contact uuid, alias text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); inv invites; me text; them text; a text;
begin
  perform _rate(u, 'redeem', 20, interval '1 hour');
  select display_name into me from social_profiles where user_id = u;
  if me is null then raise exception 'no_profile'; end if;
  inv := _find_invite(p_code);
  if inv.id is null or inv.inviter = u
     or exists (select 1 from contacts c where c.owner = inv.inviter and c.contact = u and c.blocked) then
    raise exception 'invalid_invite';
  end if;
  -- Bloqueo simultáneo de la fila: dos aceptaciones del mismo código no pueden pasar a la vez
  perform 1 from invites where id = inv.id and used_at is null for update;
  if not found then raise exception 'invalid_invite'; end if;
  if _linked(u, inv.inviter) then raise exception 'already_linked'; end if;
  select display_name into them from social_profiles where user_id = inv.inviter;
  a := coalesce(_clean_text(replace(p_alias, E'\n', ' '), 40), them);
  -- Aceptar es consentimiento explícito: reemplaza un bloqueo propio previo
  delete from contacts c where c.owner = u and c.contact = inv.inviter;
  delete from contacts c where c.owner = inv.inviter and c.contact = u;
  insert into contacts (owner, contact, alias) values (u, inv.inviter, a), (inv.inviter, u, me);
  update invites set used_by = u, used_at = now() where id = inv.id;
  return query select inv.inviter, a;
end $$;

create or replace function public.decline_invite(p_code text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); inv invites;
begin
  perform _rate(u, 'redeem', 20, interval '1 hour');
  inv := _find_invite(p_code);
  if inv.id is null or inv.inviter = u then raise exception 'invalid_invite'; end if;
  update invites set declined_at = now() where id = inv.id;
end $$;

create or replace function public.revoke_invite(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update invites set revoked_at = now() where id = p_id and inviter = _uid() and used_at is null and revoked_at is null;
end $$;

-- ───────────────────────────── Contactos ─────────────────────────────

create or replace function public.remove_contact(p_contact uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid();
begin
  delete from contacts where (owner = u and contact = p_contact) or (owner = p_contact and contact = u and not blocked);
end $$;

create or replace function public.block_contact(p_contact uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); a text;
begin
  if p_contact = u then raise exception 'invalid_contact'; end if;
  select alias into a from contacts where owner = u and contact = p_contact;
  if a is null then raise exception 'invalid_contact'; end if;
  update contacts set blocked = true, favorite = false, share_matches = false, share_scores = false
   where owner = u and contact = p_contact;
  delete from contacts where owner = p_contact and contact = u and not blocked;
end $$;

create or replace function public.unblock_contact(p_contact uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from contacts where owner = _uid() and contact = p_contact and blocked;
end $$;

-- Lo que cada contacto autorizó respecto de mí (sólo booleanos de la relación)
create or replace function public.contact_permissions() returns table (contact uuid, linked boolean, their_share_matches boolean, their_share_scores boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.contact, (t.owner is not null and not t.blocked and not c.blocked),
         coalesce(t.share_matches and not t.blocked, false), coalesce(t.share_scores and not t.blocked, false)
    from contacts c left join contacts t on t.owner = c.contact and t.contact = c.owner
   where c.owner = auth.uid();
$$;

-- ───────────────────────────── Recomendaciones ─────────────────────────────

create or replace function public.send_recommendation(
  p_recipient uuid, p_media_type text, p_tmdb_id int, p_title text, p_year int default null,
  p_poster text default null, p_comment text default null, p_resend boolean default false
) returns table (id uuid, created_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); me text; r recommendations;
begin
  select display_name into me from social_profiles where user_id = u;
  if me is null then raise exception 'no_profile'; end if;
  if not _linked(u, p_recipient) then raise exception 'not_a_contact'; end if;
  if exists (select 1 from recommendations x where x.sender = u and x.recipient = p_recipient and x.media_type = p_media_type and x.tmdb_id = p_tmdb_id)
     and not coalesce(p_resend, false) then
    raise exception 'duplicate';
  end if;
  perform _rate(u, 'send', 30, interval '10 minutes');
  perform _rate(u, 'send_day', 200, interval '1 day');
  insert into recommendations (sender, recipient, sender_name, media_type, tmdb_id, title, year, poster_path, comment)
  values (u, p_recipient, me, p_media_type, p_tmdb_id, _clean_text(replace(p_title, E'\n', ' '), 200), p_year,
          nullif(p_poster, ''), _clean_text(p_comment, 280))
  returning * into r;
  insert into rec_inbox (rec_id, recipient) values (r.id, p_recipient);
  return query select r.id, r.created_at;
end $$;

-- «Deshacer»: el remitente puede retirar su envío durante 10 minutos
create or replace function public.retract_recommendation(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from recommendations where id = p_id and sender = _uid() and created_at > now() - interval '10 minutes';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ───────────────────────────── Para ver juntos ─────────────────────────────

-- Intersección de «Quiero ver» con un contacto, sólo si AMBOS lo autorizaron. La puntuación del otro sólo si la compartió.
create or replace function public.get_matches(p_contact uuid)
returns table (media_type text, tmdb_id int, my_score numeric, their_score numeric, my_added_at timestamptz, their_added_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); mine contacts; theirs contacts;
begin
  select * into mine from contacts where owner = u and contact = p_contact;
  select * into theirs from contacts where owner = p_contact and contact = u;
  if mine.owner is null or theirs.owner is null or mine.blocked or theirs.blocked
     or not mine.share_matches or not theirs.share_matches then
    raise exception 'matches_not_authorized';
  end if;
  return query
    select a.media_type, a.tmdb_id, a.score, case when theirs.share_scores then b.score end, a.added_at, b.added_at
      from want_items a join want_items b on b.owner = p_contact and b.media_type = a.media_type and b.tmdb_id = a.tmdb_id
     where a.owner = u;
end $$;

-- Límite de tamaño de la lista sincronizada
create or replace function public._want_limit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select count(*) from want_items where owner = new.owner) >= 3000 then raise exception 'want_limit'; end if;
  return new;
end $$;
drop trigger if exists want_limit on public.want_items;
create trigger want_limit before insert on public.want_items for each row execute function public._want_limit();

-- ───────────────────────────── Cuenta ─────────────────────────────

-- Borra la cuenta y TODOS sus datos sociales (cascada). No toca nada del dispositivo.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare u uuid := _uid();
begin
  delete from auth.users where id = u;
end $$;

-- ───────────────────────────── Permisos de funciones ─────────────────────────────

revoke all on function public._uid(), public._rate(uuid, text, int, interval), public._linked(uuid, uuid), public._find_invite(text),
  public._want_limit(), public._norm_code(text), public._clean_text(text, int) from public, anon, authenticated;
revoke all on function public.set_display_name(text), public.create_invite(), public.peek_invite(text), public.accept_invite(text, text),
  public.decline_invite(text), public.revoke_invite(uuid), public.remove_contact(uuid), public.block_contact(uuid), public.unblock_contact(uuid),
  public.contact_permissions(), public.send_recommendation(uuid, text, int, text, int, text, text, boolean), public.retract_recommendation(uuid),
  public.get_matches(uuid), public.delete_my_account() from public, anon;
grant execute on function public.set_display_name(text), public.create_invite(), public.peek_invite(text), public.accept_invite(text, text),
  public.decline_invite(text), public.revoke_invite(uuid), public.remove_contact(uuid), public.block_contact(uuid), public.unblock_contact(uuid),
  public.contact_permissions(), public.send_recommendation(uuid, text, int, text, int, text, text, boolean), public.retract_recommendation(uuid),
  public.get_matches(uuid), public.delete_my_account() to authenticated;
-- _uid lo usan funciones SECURITY INVOKER (contact_permissions usa auth.uid directo); las DEFINER corren como dueño.

-- ───────────────────────────── Tiempo real ─────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'recommendations') then
    execute 'alter publication supabase_realtime add table public.recommendations';
  end if;
end $$;
