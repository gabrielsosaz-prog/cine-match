-- Cine Match AI v4.3 · Intereses compartidos (Supabase / Postgres 15+)
--
-- Migración ADITIVA, idempotente y compatible con la app v4.2: no cambia ni borra columnas, tablas ni firmas de
-- funciones existentes (la v4.2 sigue funcionando contra esta base). Para volver atrás: supabase/rollback/0002_down.sql.
--
-- Principios:
--  * El interés local sigue siendo la fuente de verdad del recomendador. Acá sólo vive la ÚLTIMA respuesta de interés
--    (No / Podría / Me interesa / Muchas ganas) y, si se autorizó aparte, la valoración posterior, y SÓLO de títulos
--    intercambiados con un contacto que autorizó el dueño. Nada de historial, perfil, listas ni otros títulos.
--  * «Intercambiado» entre A y B = existe una recomendación entre ellos (en cualquier sentido) o ambos lo tienen en
--    «Quiero ver» con «Para ver juntos» autorizado por los dos (una coincidencia que ya se ven mutuamente).
--  * Ver el interés del otro requiere autorización MUTUA. Toda verificación ocurre en el servidor.
--  * Al perder la autorización (revocar, bloquear, eliminar, retirar el envío) los datos que ya no corresponden se borran.

-- ───────────────────────────── Permisos por contacto ─────────────────────────────

alter table public.contacts add column if not exists share_interests boolean not null default false;
alter table public.contacts add column if not exists share_ratings boolean not null default false;
-- Preferencia de recepción (no comparte información): avisos de coincidencias con este contacto
alter table public.contacts add column if not exists notify_matches boolean not null default true;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_blocked_v43') then
    alter table public.contacts add constraint contacts_blocked_v43 check (not (blocked and (share_interests or share_ratings)));
  end if;
end $$;
grant update (share_interests, share_ratings, notify_matches) on public.contacts to authenticated;

-- Preferencias de avisos (globales, de quien recibe). Recomendaciones: activadas como en v4.2. Coincidencias: opcionales.
alter table public.social_profiles add column if not exists notify_recs boolean not null default true;
alter table public.social_profiles add column if not exists notify_matches boolean not null default false;
alter table public.social_profiles add column if not exists notify_max boolean not null default false;
grant update (notify_recs, notify_matches, notify_max) on public.social_profiles to authenticated;

-- ───────────────────────────── Intereses compartidos ─────────────────────────────

-- Una fila por dueño y título. answer_at / rating_at son la hora del cambio en el dispositivo: resuelven envíos fuera
-- de orden (gana el más nuevo) y hacen idempotente el reenvío. La app no escribe directo: sólo put_shared().
create table if not exists public.shared_interests (
  owner uuid not null references auth.users (id) on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv')),
  tmdb_id integer not null check (tmdb_id > 0),
  answer text check (answer in ('no', 'quiza', 'si', 'mucho')),
  answer_at timestamptz,
  rating numeric(3, 1) check (rating between 1 and 10),
  rating_at timestamptz,
  -- Hora del SERVIDOR en que se guardó cada valor: decide la visibilidad por contacto (ver _since)
  answer_srv timestamptz,
  rating_srv timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner, media_type, tmdb_id)
);

alter table public.shared_interests add column if not exists answer_srv timestamptz;
alter table public.shared_interests add column if not exists rating_srv timestamptz;

-- Hora del servidor en que cada título de «Quiero ver» llegó a la base (la de added_at la informa el dispositivo)
alter table public.want_items add column if not exists synced_at timestamptz not null default now();

-- Eventos para quien recibe: «algo compartido cambió» (sin contenido) y coincidencias nuevas. Alimentan el tiempo real
-- y los avisos. Sólo se crean hacia contactos con autorización mutua vigente.
create table if not exists public.social_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  actor uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('shared', 'match', 'match_max')),
  media_type text check (media_type in ('movie', 'tv')),
  tmdb_id integer,
  title text,
  created_at timestamptz not null default now(),
  pushed_at timestamptz
);
create index if not exists social_events_user_idx on public.social_events (user_id, created_at desc);
create index if not exists social_events_pair_idx on public.social_events (actor, user_id);

alter table public.shared_interests enable row level security;
alter table public.social_events enable row level security;
revoke all on public.shared_interests, public.social_events from anon, authenticated, public;
grant select on public.shared_interests to authenticated;
grant select (id, actor, kind, media_type, tmdb_id, title, created_at) on public.social_events to authenticated;

drop policy if exists shared_own on public.shared_interests;
create policy shared_own on public.shared_interests for select to authenticated using (owner = auth.uid());
drop policy if exists events_own on public.social_events;
create policy events_own on public.social_events for select to authenticated using (user_id = auth.uid());

-- ───────────────────────────── Funciones auxiliares ─────────────────────────────

create or replace function public._exchanged(a uuid, b uuid, p_mt text, p_id int) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from recommendations r where r.media_type = p_mt and r.tmdb_id = p_id
                   and ((r.sender = a and r.recipient = b) or (r.sender = b and r.recipient = a)))
      or (exists (select 1 from contacts x where x.owner = a and x.contact = b and x.share_matches and not x.blocked)
          and exists (select 1 from contacts y where y.owner = b and y.contact = a and y.share_matches and not y.blocked)
          and exists (select 1 from want_items w where w.owner = a and w.media_type = p_mt and w.tmdb_id = p_id)
          and exists (select 1 from want_items w where w.owner = b and w.media_type = p_mt and w.tmdb_id = p_id));
$$;

-- Desde cuándo un título está intercambiado entre A y B (hora del servidor). Un interés guardado ANTES no se muestra a
-- ese contacto: así nadie puede averiguar respuestas viejas enviando títulos al azar (la app vuelve a publicar la
-- respuesta, con consentimiento, cuando corresponde). null = no intercambiado.
create or replace function public._since(a uuid, b uuid, p_mt text, p_id int) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select least(
    (select min(r.created_at) from recommendations r where r.media_type = p_mt and r.tmdb_id = p_id
        and ((r.sender = a and r.recipient = b) or (r.sender = b and r.recipient = a))),
    (select greatest(wa.synced_at, wb.synced_at) from want_items wa join want_items wb on wb.owner = b and wb.media_type = p_mt and wb.tmdb_id = p_id
      where wa.owner = a and wa.media_type = p_mt and wa.tmdb_id = p_id
        and exists (select 1 from contacts x where x.owner = a and x.contact = b and x.share_matches and not x.blocked)
        and exists (select 1 from contacts y where y.owner = b and y.contact = a and y.share_matches and not y.blocked)));
$$;

-- Autorización vigente del dueño hacia un contacto (interés o valoración), con vínculo activo
create or replace function public._grants(p_owner uuid, p_peer uuid, p_what text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select _linked(p_owner, p_peer) and exists (
    select 1 from contacts c where c.owner = p_owner and c.contact = p_peer and not c.blocked
       and case p_what when 'interest' then c.share_interests when 'rating' then c.share_ratings else false end);
$$;
create or replace function public._mutual(a uuid, b uuid, p_what text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select _grants(a, b, p_what) and _grants(b, a, p_what);
$$;

-- Clasificación de coincidencia (simétrica). Debe coincidir con src/social/interests.ts (se prueba en ambos lados).
create or replace function public._match_level(x text, y text) returns text language sql immutable as $$
  select case
    when x = 'no' or y = 'no' then 'sin'
    when x is null or y is null then 'pendiente'
    when x = 'mucho' and y = 'mucho' then 'maxima'
    when (x = 'mucho' and y = 'si') or (x = 'si' and y = 'mucho') then 'muy_alta'
    when x = 'si' and y = 'si' then 'alta'
    when x = 'quiza' and y = 'quiza' then 'posible_baja'
    else 'posible' end;
$$;

-- Borra lo que ya no corresponde conservar de un dueño (opcionalmente de un solo título)
create or replace function public._prune_shared(p_owner uuid, p_mt text default null, p_id int default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update shared_interests s set answer = null, answer_at = null, updated_at = now()
   where s.owner = p_owner and s.answer_at is not null
     and (p_mt is null or (s.media_type = p_mt and s.tmdb_id = p_id))
     and not exists (select 1 from contacts c where c.owner = p_owner and c.share_interests and not c.blocked
                       and _linked(p_owner, c.contact) and _exchanged(p_owner, c.contact, s.media_type, s.tmdb_id));
  update shared_interests s set rating = null, rating_at = null, updated_at = now()
   where s.owner = p_owner and s.rating_at is not null
     and (p_mt is null or (s.media_type = p_mt and s.tmdb_id = p_id))
     and not exists (select 1 from contacts c where c.owner = p_owner and c.share_ratings and not c.blocked
                       and _linked(p_owner, c.contact) and _exchanged(p_owner, c.contact, s.media_type, s.tmdb_id));
  delete from shared_interests s where s.owner = p_owner and s.answer_at is null and s.rating_at is null
     and (p_mt is null or (s.media_type = p_mt and s.tmdb_id = p_id));
end $$;

-- Aviso sin contenido para que la otra app vuelva a pedir lo compartido (máx. 1 cada 2 s por par)
create or replace function public._ping(p_to uuid, p_from uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_to is null or p_from is null or p_to = p_from then return; end if;
  if exists (select 1 from social_events e where e.user_id = p_to and e.actor = p_from and e.kind = 'shared' and e.created_at > now() - interval '2 seconds') then return; end if;
  insert into social_events (user_id, actor, kind) values (p_to, p_from, 'shared');
end $$;

-- ───────────────────────────── Escritura: put_shared ─────────────────────────────

-- Recibe un lote de cambios [{t:'movie'|'tv', id:int, f:'answer'|'rating', v:valor|null, at:iso}] del dueño y devuelve
-- el estado de cada uno: ok (guardado), stale (había uno más nuevo o igual: idempotente), not_shared (el título no
-- forma parte de un intercambio autorizado: no se guarda nada) o invalid. Crea los eventos de coincidencia.
create or replace function public.put_shared(p_items jsonb)
returns table (media_type text, tmdb_id int, field text, status text, events bigint[])
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u uuid := _uid();
  it jsonb;
  mt text; tid int; f text; v text; cat timestamptz;
  cur shared_interests;
  peer record;
  old_l text; new_l text; ttl text; ev bigint; evs bigint[]; sn timestamptz;
  positive constant text[] := array['alta', 'muy_alta', 'maxima'];
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then raise exception 'invalid_items'; end if;
  perform _rate(u, 'shared', 120, interval '10 minutes');
  for it in select * from jsonb_array_elements(p_items) loop
    evs := array[]::bigint[];
    mt := it->>'t'; f := it->>'f'; v := it->>'v';
    begin tid := (it->>'id')::int; cat := (it->>'at')::timestamptz; exception when others then tid := null; cat := null; end;
    if mt not in ('movie', 'tv') or tid is null or tid <= 0 or cat is null or f not in ('answer', 'rating')
       or (f = 'answer' and (v is null or v not in ('no', 'quiza', 'si', 'mucho')))
       or (f = 'rating' and v is not null and (v !~ '^\d{1,2}(\.\d)?$' or v::numeric < 1 or v::numeric > 10)) then
      media_type := mt; tmdb_id := tid; field := f; status := 'invalid'; events := evs; return next; continue;
    end if;
    -- Un reloj del dispositivo adelantado no puede bloquear cambios futuros
    if cat > now() + interval '5 minutes' then cat := now(); end if;
    if not exists (select 1 from contacts c where c.owner = u and not c.blocked
                     and case f when 'answer' then c.share_interests else c.share_ratings end
                     and _linked(u, c.contact) and _exchanged(u, c.contact, mt, tid)) then
      media_type := mt; tmdb_id := tid; field := f; status := 'not_shared'; events := evs; return next; continue;
    end if;
    select * into cur from shared_interests s where s.owner = u and s.media_type = mt and s.tmdb_id = tid for update;
    if f = 'answer' and cur.answer_at is not null and cur.answer_at >= cat
       or f = 'rating' and cur.rating_at is not null and cur.rating_at >= cat then
      media_type := mt; tmdb_id := tid; field := f; status := 'stale'; events := evs; return next; continue;
    end if;
    if f = 'answer' then
      insert into shared_interests as s (owner, media_type, tmdb_id, answer, answer_at) values (u, mt, tid, v, cat)
      on conflict on constraint shared_interests_pkey do update set answer = excluded.answer, answer_at = excluded.answer_at, updated_at = now();
      update shared_interests s set answer_srv = now() where s.owner = u and s.media_type = mt and s.tmdb_id = tid;
    else
      insert into shared_interests as s (owner, media_type, tmdb_id, rating, rating_at) values (u, mt, tid, v::numeric, cat)
      on conflict on constraint shared_interests_pkey do update set rating = excluded.rating, rating_at = excluded.rating_at, updated_at = now();
      update shared_interests s set rating_srv = now() where s.owner = u and s.media_type = mt and s.tmdb_id = tid;
    end if;
    -- Contactos que pueden verlo: autorización mutua vigente y título intercambiado con cada uno
    for peer in select c.contact as id from contacts c where c.owner = u and not c.blocked
                  and _mutual(u, c.contact, case f when 'answer' then 'interest' else 'rating' end)
                  and _exchanged(u, c.contact, mt, tid) loop
      perform _ping(peer.id, u);
      if f = 'answer' then
        sn := _since(u, peer.id, mt, tid);
        select s.answer into old_l from shared_interests s where s.owner = peer.id and s.media_type = mt and s.tmdb_id = tid and s.answer_srv >= sn;
        new_l := _match_level(v, old_l);
        old_l := _match_level(case when cur.answer_srv >= sn then cur.answer end, old_l);
        if new_l = any (positive) and (old_l <> all (positive) or (new_l = 'maxima' and old_l <> 'maxima')) then
          -- Sin repetir el mismo aviso para el mismo par y título en 10 minutos (idas y vueltas rápidas)
          if not exists (select 1 from social_events e where e.user_id = peer.id and e.actor = u and e.media_type = mt and e.tmdb_id = tid
                           and e.kind = case when new_l = 'maxima' then 'match_max' else 'match' end and e.created_at > now() - interval '10 minutes') then
            select r.title into ttl from recommendations r where r.media_type = mt and r.tmdb_id = tid
              and ((r.sender = u and r.recipient = peer.id) or (r.sender = peer.id and r.recipient = u)) order by r.created_at desc limit 1;
            insert into social_events (user_id, actor, kind, media_type, tmdb_id, title)
            values (peer.id, u, case when new_l = 'maxima' then 'match_max' else 'match' end, mt, tid, ttl) returning id into ev;
            evs := evs || ev;
          end if;
        end if;
      end if;
    end loop;
    media_type := mt; tmdb_id := tid; field := f; status := 'ok'; events := evs; return next;
  end loop;
  delete from social_events e where e.user_id = u and e.created_at < now() - interval '30 days';
end $$;

-- ───────────────────────────── Lectura ─────────────────────────────

-- Lo que cada contacto autorizó respecto de mí (sólo booleanos de la relación). Versión ampliada de contact_permissions
-- (que se conserva igual para la app v4.2).
create or replace function public.contact_permissions_v43()
returns table (contact uuid, linked boolean, their_share_matches boolean, their_share_scores boolean, their_share_interests boolean, their_share_ratings boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.contact, (t.owner is not null and not t.blocked and not c.blocked),
         coalesce(t.share_matches and not t.blocked and not c.blocked, false), coalesce(t.share_scores and not t.blocked and not c.blocked, false),
         coalesce(t.share_interests and not t.blocked and not c.blocked, false), coalesce(t.share_ratings and not t.blocked and not c.blocked, false)
    from contacts c left join contacts t on t.owner = c.contact and t.contact = c.owner
   where c.owner = auth.uid();
$$;

-- Intereses y valoraciones que mis contactos me autorizan a ver: sólo con autorización mutua vigente y sólo de títulos
-- intercambiados con cada uno. Foto completa (la app reemplaza su caché: lo revocado desaparece).
create or replace function public.get_shared()
returns table (contact uuid, media_type text, tmdb_id int, answer text, answer_at timestamptz, rating numeric, rating_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare u uuid := _uid();
begin
  return query
    with peers as (
      select c.contact as id, _mutual(u, c.contact, 'interest') as mi, _mutual(u, c.contact, 'rating') as mr
        from contacts c where c.owner = u and not c.blocked and _linked(u, c.contact)
    )
    select x.id, x.media_type, x.tmdb_id, x.answer, x.answer_at, x.rating, x.rating_at from (
      select p.id, s.media_type, s.tmdb_id,
             case when p.mi and s.answer_srv >= z.sn then s.answer end as answer, case when p.mi and s.answer_srv >= z.sn then s.answer_at end as answer_at,
             case when p.mr and s.rating_srv >= z.sn then s.rating end as rating, case when p.mr and s.rating_srv >= z.sn then s.rating_at end as rating_at
        from peers p join shared_interests s on s.owner = p.id
        cross join lateral (select _since(u, p.id, s.media_type, s.tmdb_id) as sn) z
       where (p.mi or p.mr) and z.sn is not null) x
     where x.answer is not null or x.rating_at is not null;
end $$;

-- ───────────────────────────── Mantenimiento automático ─────────────────────────────

create or replace function public._contacts_v43() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid; c uuid;
begin
  if tg_op = 'DELETE' then o := old.owner; c := old.contact; else o := new.owner; c := new.contact; end if;
  if tg_op = 'UPDATE' and old.share_interests = new.share_interests and old.share_ratings = new.share_ratings
     and old.share_matches = new.share_matches and old.blocked = new.blocked then
    return null;
  end if;
  perform _prune_shared(o);
  perform _prune_shared(c);
  -- Coincidencias avisadas entre ambos: se borran si ya no hay autorización mutua de intereses
  if not _mutual(o, c, 'interest') then
    delete from social_events e where ((e.user_id = o and e.actor = c) or (e.user_id = c and e.actor = o)) and e.kind <> 'shared';
  end if;
  -- La otra app vuelve a pedir lo compartido (invalida su caché local)
  if exists (select 1 from auth.users where id = c) and exists (select 1 from auth.users where id = o) then
    perform _ping(c, o);
  end if;
  return null;
end $$;
drop trigger if exists contacts_v43 on public.contacts;
create trigger contacts_v43 after update or delete on public.contacts for each row execute function public._contacts_v43();

create or replace function public._recs_v43() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _prune_shared(old.sender, old.media_type, old.tmdb_id);
  perform _prune_shared(old.recipient, old.media_type, old.tmdb_id);
  return null;
end $$;
drop trigger if exists recs_v43 on public.recommendations;
create trigger recs_v43 after delete on public.recommendations for each row execute function public._recs_v43();

create or replace function public._want_v43() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record;
begin
  if not exists (select 1 from shared_interests s where s.media_type = old.media_type and s.tmdb_id = old.tmdb_id) then return null; end if;
  perform _prune_shared(old.owner, old.media_type, old.tmdb_id);
  for p in select c.contact from contacts c where c.owner = old.owner loop
    perform _prune_shared(p.contact, old.media_type, old.tmdb_id);
  end loop;
  return null;
end $$;
drop trigger if exists want_v43 on public.want_items;
create trigger want_v43 after delete on public.want_items for each row execute function public._want_v43();

-- Bloquear también apaga los permisos nuevos (misma firma que v4.2)
create or replace function public.block_contact(p_contact uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid := _uid(); a text;
begin
  if p_contact = u then raise exception 'invalid_contact'; end if;
  select alias into a from contacts where owner = u and contact = p_contact;
  if a is null then raise exception 'invalid_contact'; end if;
  update contacts set blocked = true, favorite = false, share_matches = false, share_scores = false, share_interests = false, share_ratings = false
   where owner = u and contact = p_contact;
  delete from contacts where owner = p_contact and contact = u and not blocked;
end $$;

-- ───────────────────────────── Permisos de funciones ─────────────────────────────

revoke all on function public._exchanged(uuid, uuid, text, int), public._since(uuid, uuid, text, int), public._grants(uuid, uuid, text), public._mutual(uuid, uuid, text),
  public._match_level(text, text), public._prune_shared(uuid, text, int), public._ping(uuid, uuid),
  public._contacts_v43(), public._recs_v43(), public._want_v43() from public, anon, authenticated;
revoke all on function public.put_shared(jsonb), public.contact_permissions_v43(), public.get_shared() from public, anon;
grant execute on function public.put_shared(jsonb), public.contact_permissions_v43(), public.get_shared() to authenticated;

-- ───────────────────────────── Tiempo real ─────────────────────────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_events') then
    execute 'alter publication supabase_realtime add table public.social_events';
  end if;
end $$;
