-- Vuelta atrás de la migración 0002 (v4.3 → esquema de v4.2). Sólo si se decide abandonar v4.3: BORRA los intereses
-- compartidos, las valoraciones compartidas y los avisos de coincidencias. No toca contactos, invitaciones,
-- recomendaciones, bandejas ni «Quiero ver» (salvo la columna nueva synced_at). La app v4.2 funciona también SIN
-- aplicar esto (la migración es aditiva), así que normalmente alcanza con volver al despliegue de v4.2 en Vercel.
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_events') then
    execute 'alter publication supabase_realtime drop table public.social_events';
  end if;
end $$;
drop trigger if exists contacts_v43 on public.contacts;
drop trigger if exists recs_v43 on public.recommendations;
drop trigger if exists want_v43 on public.want_items;
drop function if exists public.put_shared(jsonb), public.get_shared(), public.contact_permissions_v43(),
  public._contacts_v43(), public._recs_v43(), public._want_v43(), public._prune_shared(uuid, text, int), public._ping(uuid, uuid),
  public._match_level(text, text), public._mutual(uuid, uuid, text), public._grants(uuid, uuid, text), public._since(uuid, uuid, text, int),
  public._exchanged(uuid, uuid, text, int);
drop table if exists public.social_pushes, public.shared_interests, public.social_events;
alter table public.contacts drop constraint if exists contacts_blocked_v43;
alter table public.contacts drop column if exists share_interests, drop column if exists share_ratings, drop column if exists notify_matches;
alter table public.social_profiles drop column if exists notify_recs, drop column if exists notify_matches, drop column if exists notify_max;
alter table public.want_items drop column if exists synced_at;
-- block_contact vuelve a su cuerpo de v4.2 al reaplicar 0001 (idempotente)
