import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { titleKey, parseKey, type MediaType, type TitleKey } from '../types';
import type { SocialBackend } from './backend';
import { SocialError, toSocialError, type Contact, type InboxRec, type PutResult, type SharedRow, type SocialUser } from './types';

const ts = (v?: string | null) => (v ? Date.parse(v) : undefined);
const toUser = (u: User | null | undefined): SocialUser | null => (u ? { id: u.id, email: u.email ?? undefined } : null);

/** Ejecuta y traduce errores (red, reglas del servidor) a mensajes en español. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function q(p: PromiseLike<any>): Promise<any> {
  let r: { data: any; error: unknown };
  try { r = await p; } catch (e) { throw toSocialError(e); }
  if (r.error) throw toSocialError(r.error);
  return r.data;
}

export function createSupabaseBackend(url: string, key: string): SocialBackend {
  const sb: SupabaseClient = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'cine-match-social-auth' },
    realtime: { params: { eventsPerSecond: 2 } },
  });
  const uid = async () => {
    const { data } = await sb.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new SocialError('not_authenticated');
    return id;
  };
  const inboxRow = (r: any): InboxRec => ({
    id: r.id, sender: r.sender, senderName: r.sender_name, key: titleKey(r.media_type as MediaType, r.tmdb_id), title: r.title,
    year: r.year ?? undefined, posterPath: r.poster_path ?? undefined, comment: r.comment ?? undefined, createdAt: ts(r.created_at)!,
    seenAt: ts(r.rec_inbox?.seen_at), archivedAt: ts(r.rec_inbox?.archived_at),
  });
  const REC_COLS = 'id, sender, sender_name, media_type, tmdb_id, title, year, poster_path, comment, created_at, rec_inbox(seen_at, archived_at)';

  return {
    kind: 'supabase',
    async currentUser() { const { data } = await sb.auth.getSession(); return toUser(data.session?.user); },
    onAuthChange(fn) {
      const { data } = sb.auth.onAuthStateChange((ev, s) => { if (ev !== 'TOKEN_REFRESHED') fn(toUser(s?.user)); });
      return () => data.subscription.unsubscribe();
    },
    async signUp(email, password, displayName) {
      const d = await q(sb.auth.signUp({ email, password }));
      if (!d.session) {
        // Si el proyecto exigiera confirmar el correo no habría sesión: se intenta iniciar sesión directamente
        const s = await q(sb.auth.signInWithPassword({ email, password }));
        if (!s.session) throw new SocialError('unknown', 'sin sesión');
      }
      await q(sb.rpc('set_display_name', { p_name: displayName }));
      return { ...toUser(d.user)!, displayName };
    },
    async signIn(email, password) { const d = await q(sb.auth.signInWithPassword({ email, password })); return toUser(d.user)!; },
    async signOut() { await sb.auth.signOut({ scope: 'local' }); },
    async changePassword(password) { await q(sb.auth.updateUser({ password })); },
    async deleteAccount() { await q(sb.rpc('delete_my_account')); await sb.auth.signOut({ scope: 'local' }); },
    async getDisplayName() {
      const d = await q(sb.from('social_profiles').select('display_name').maybeSingle());
      return (d as { display_name?: string } | null)?.display_name;
    },
    async setDisplayName(name) { await q(sb.rpc('set_display_name', { p_name: name })); },

    async listContacts() {
      const [rows, perms] = await Promise.all([
        q(sb.from('contacts').select('contact, alias, favorite, blocked, share_matches, share_scores, share_interests, share_ratings, notify_matches, created_at').order('created_at')),
        q(sb.rpc('contact_permissions_v43')),
      ]);
      const pm = new Map(((perms ?? []) as any[]).map((p) => [p.contact, p]));
      return ((rows ?? []) as any[]).map((r): Contact => {
        const p = pm.get(r.contact);
        return { id: r.contact, alias: r.alias, favorite: r.favorite, blocked: r.blocked, shareMatches: r.share_matches, shareScores: r.share_scores,
          theirShareMatches: Boolean(p?.their_share_matches), theirShareScores: Boolean(p?.their_share_scores), linked: Boolean(p?.linked), createdAt: ts(r.created_at)!,
          shareInterests: Boolean(r.share_interests), shareRatings: Boolean(r.share_ratings), notifyMatches: r.notify_matches !== false,
          theirShareInterests: Boolean(p?.their_share_interests), theirShareRatings: Boolean(p?.their_share_ratings) };
      });
    },
    async updateContact(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.alias !== undefined) row.alias = patch.alias.trim().slice(0, 40);
      if (patch.favorite !== undefined) row.favorite = patch.favorite;
      if (patch.shareMatches !== undefined) row.share_matches = patch.shareMatches;
      if (patch.shareScores !== undefined) row.share_scores = patch.shareScores;
      if (patch.shareInterests !== undefined) row.share_interests = patch.shareInterests;
      if (patch.shareRatings !== undefined) row.share_ratings = patch.shareRatings;
      if (patch.notifyMatches !== undefined) row.notify_matches = patch.notifyMatches;
      const me = await uid();
      // Un solo favorito: primero se quita el anterior
      if (patch.favorite) await q(sb.from('contacts').update({ favorite: false }).eq('owner', me).eq('favorite', true).neq('contact', id));
      await q(sb.from('contacts').update(row).eq('owner', me).eq('contact', id));
    },
    async removeContact(id) { await q(sb.rpc('remove_contact', { p_contact: id })); },
    async blockContact(id) { await q(sb.rpc('block_contact', { p_contact: id })); },
    async unblockContact(id) { await q(sb.rpc('unblock_contact', { p_contact: id })); },

    async createInvite() {
      const d = await q(sb.rpc('create_invite'));
      const r = (d as any[])[0];
      return { code: r.code, expiresAt: ts(r.expires_at)! };
    },
    async listInvites() {
      const d = await q(sb.from('invites').select('id, created_at, expires_at, used_at, declined_at, revoked_at').order('created_at', { ascending: false }).limit(20));
      return ((d ?? []) as any[]).map((r) => ({ id: r.id, createdAt: ts(r.created_at)!, expiresAt: ts(r.expires_at)!, usedAt: ts(r.used_at), declinedAt: ts(r.declined_at), revokedAt: ts(r.revoked_at) }));
    },
    async revokeInvite(id) { await q(sb.rpc('revoke_invite', { p_id: id })); },
    async peekInvite(code) {
      const d = await q(sb.rpc('peek_invite', { p_code: code }));
      const r = (d as any[])[0];
      if (!r) throw new SocialError('invalid_invite');
      return { inviterName: r.inviter_name, expiresAt: ts(r.expires_at)! };
    },
    async acceptInvite(code, alias) {
      const d = await q(sb.rpc('accept_invite', { p_code: code, p_alias: alias ?? null }));
      const r = (d as any[])[0];
      return { contact: r.contact, alias: r.alias };
    },
    async declineInvite(code) { await q(sb.rpc('decline_invite', { p_code: code })); },

    async send(i) {
      const d = await q(sb.rpc('send_recommendation', {
        p_recipient: i.recipient, p_media_type: i.type, p_tmdb_id: i.tmdbId, p_title: i.title, p_year: i.year ?? null,
        p_poster: i.posterPath ?? null, p_comment: i.comment?.trim() || null, p_resend: Boolean(i.resend),
      }));
      const r = (d as any[])[0];
      return { id: r.id, createdAt: ts(r.created_at)! };
    },
    async retract(id) { return Boolean(await q(sb.rpc('retract_recommendation', { p_id: id }))); },
    async listSent() {
      const me = await uid();
      const d = await q(sb.from('recommendations').select('id, recipient, media_type, tmdb_id, title, year, poster_path, comment, created_at').eq('sender', me).order('created_at', { ascending: false }).limit(1000));
      return ((d ?? []) as any[]).map((r) => ({ id: r.id, recipient: r.recipient, key: titleKey(r.media_type, r.tmdb_id), createdAt: ts(r.created_at)!, title: r.title, year: r.year ?? undefined, posterPath: r.poster_path ?? undefined, comment: r.comment ?? undefined }));
    },
    async listInbox() {
      const me = await uid();
      const d = await q(sb.from('recommendations').select(REC_COLS).eq('recipient', me).order('created_at', { ascending: false }).limit(500));
      return ((d ?? []) as any[]).map(inboxRow);
    },
    async getInboxRec(id) {
      const me = await uid();
      const d = await q(sb.from('recommendations').select(REC_COLS).eq('recipient', me).eq('id', id).maybeSingle());
      return d ? inboxRow(d) : undefined;
    },
    async markSeen(ids) {
      if (!ids.length) return;
      await q(sb.from('rec_inbox').update({ seen_at: new Date().toISOString() }).in('rec_id', ids).is('seen_at', null));
    },
    async setArchived(id, archived) { await q(sb.from('rec_inbox').update({ archived_at: archived ? new Date().toISOString() : null }).eq('rec_id', id)); },
    subscribeInbox(onInsert, onDelete) {
      let ch: ReturnType<SupabaseClient['channel']> | undefined;
      let stopped = false;
      uid().then((me) => {
        if (stopped) return;
        // Un único canal por sesión; el servidor filtra por destinatario y además aplica RLS
        ch = sb.channel(`inbox-${me}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'recommendations', filter: `recipient=eq.${me}` }, (p) => onInsert((p.new as { id: string }).id))
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'recommendations' }, (p) => { const id = (p.old as { id?: string }).id; if (id) onDelete(id); })
          .subscribe();
      }).catch(() => undefined);
      return () => { stopped = true; if (ch) sb.removeChannel(ch); };
    },

    async syncWant(items) {
      const me = await uid();
      const have = (await q(sb.from('want_items').select('media_type, tmdb_id, score'))) as any[];
      const cur = new Map(have.map((r) => [titleKey(r.media_type, r.tmdb_id), r.score === null ? undefined : Number(r.score)]));
      const want = new Map(items.map((i) => [i.key, i]));
      const del = [...cur.keys()].filter((k) => !want.has(k));
      const up = items.filter((i) => !cur.has(i.key) || round(cur.get(i.key)) !== round(i.score));
      for (const k of del) { const { type, id } = parseKey(k); await q(sb.from('want_items').delete().eq('owner', me).eq('media_type', type).eq('tmdb_id', id)); }
      if (up.length) {
        await q(sb.from('want_items').upsert(up.map((i) => { const { type, id } = parseKey(i.key); return { owner: me, media_type: type, tmdb_id: id, score: i.score === undefined ? null : round(i.score), added_at: new Date(i.addedAt).toISOString() }; }), { onConflict: 'owner,media_type,tmdb_id' }));
      }
      return { added: up.length, removed: del.length };
    },
    async clearWant() { const me = await uid(); await q(sb.from('want_items').delete().eq('owner', me)); },
    async getMatches(contact) {
      const d = await q(sb.rpc('get_matches', { p_contact: contact }));
      return ((d ?? []) as any[]).map((r) => ({ key: titleKey(r.media_type, r.tmdb_id) as TitleKey, myScore: r.my_score === null ? undefined : Number(r.my_score), theirScore: r.their_score === null ? undefined : Number(r.their_score), myAddedAt: ts(r.my_added_at)!, theirAddedAt: ts(r.their_added_at)! }));
    },

    async getPrefs() {
      const d = (await q(sb.from('social_profiles').select('notify_recs, notify_matches, notify_max').maybeSingle())) as any;
      return { notifyRecs: d?.notify_recs !== false, notifyMatches: Boolean(d?.notify_matches), notifyMax: Boolean(d?.notify_max) };
    },
    async setPrefs(p) {
      const me = await uid();
      const row: Record<string, boolean> = {};
      if (p.notifyRecs !== undefined) row.notify_recs = p.notifyRecs;
      if (p.notifyMatches !== undefined) row.notify_matches = p.notifyMatches;
      if (p.notifyMax !== undefined) row.notify_max = p.notifyMax;
      await q(sb.from('social_profiles').update(row).eq('user_id', me));
    },
    async putShared(items) {
      if (!items.length) return [];
      const d = await q(sb.rpc('put_shared', { p_items: items.map((i) => { const { type, id } = parseKey(i.key); return { t: type, id, f: i.f, v: i.v, at: new Date(i.at).toISOString() }; }) }));
      return ((d ?? []) as any[]).map((r): PutResult => ({ key: titleKey(r.media_type, r.tmdb_id), f: r.field, status: r.status, events: (r.events ?? []).map(Number) }));
    },
    async getShared() {
      const d = await q(sb.rpc('get_shared'));
      return ((d ?? []) as any[]).map((r): SharedRow => ({ contact: r.contact, key: titleKey(r.media_type, r.tmdb_id), answer: r.answer ?? undefined, answerAt: ts(r.answer_at),
        rating: r.rating === null || r.rating === undefined ? undefined : Number(r.rating), ratingAt: ts(r.rating_at) }));
    },
    subscribeEvents(onEvent) {
      let ch: ReturnType<SupabaseClient['channel']> | undefined;
      let stopped = false;
      uid().then((me) => {
        if (stopped) return;
        ch = sb.channel(`events-${me}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_events', filter: `user_id=eq.${me}` }, (p) => {
            const r = p.new as any;
            onEvent({ id: Number(r.id), actor: r.actor, kind: r.kind, key: r.media_type ? titleKey(r.media_type, r.tmdb_id) : undefined, title: r.title ?? undefined, createdAt: ts(r.created_at) ?? Date.now() });
          })
          .subscribe();
      }).catch(() => undefined);
      return () => { stopped = true; if (ch) sb.removeChannel(ch); };
    },
    async notifyEvents(ids) { if (ids.length) await q(sb.functions.invoke('notify', { body: { event_ids: ids } })); },
    async savePush(sub) {
      const me = await uid();
      await q(sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint!));
      await q(sb.from('push_subscriptions').insert({ user_id: me, endpoint: sub.endpoint, p256dh: sub.keys?.p256dh, auth: sub.keys?.auth }));
    },
    async deletePush(endpoint) { await q(sb.from('push_subscriptions').delete().eq('endpoint', endpoint)); },
    async notify(recId) { await q(sb.functions.invoke('notify', { body: { rec_id: recId } })); },
  };
}

const round = (n?: number) => (n === undefined ? undefined : Math.round(n * 100) / 100);
