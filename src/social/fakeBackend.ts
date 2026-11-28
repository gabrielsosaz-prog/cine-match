/**
 * SÓLO PRUEBAS. Cliente del servidor social simulado (tests/fixtures/fakeSocialServer.mjs), que replica las reglas del
 * esquema de Supabase en memoria. Se activa únicamente si el almacenamiento local tiene «cine-match:social-fake».
 * El intercambio real se valida contra Supabase en producción (tests/prod/v42.spec.ts).
 */
import type { SocialBackend } from './backend';
import { SocialError, toSocialError, type SocialUser } from './types';

const TOKEN_KEY = 'cine-match:social-fake-session';

export function createFakeBackend(base: string): SocialBackend {
  const listeners = new Set<(u: SocialUser | null) => void>();
  const session = (): { token: string; user: SocialUser } | null => { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null'); } catch { return null; } };
  const setSession = (s: { token: string; user: SocialUser } | null) => {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); else localStorage.removeItem(TOKEN_KEY);
    for (const l of listeners) l(s?.user ?? null);
  };
  async function call<T = any>(name: string, body: Record<string, unknown> = {}): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${base}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session()?.token ?? ''}` }, body: JSON.stringify(body) });
    } catch (e) { throw toSocialError(e); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw toSocialError(new Error(j.error ?? `http ${r.status}`));
    return j.data as T;
  }
  return {
    kind: 'fake',
    async currentUser() { return session()?.user ?? null; },
    onAuthChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async signUp(email, password, displayName) { const s = await call('signup', { email, password, displayName }); setSession(s); return s.user; },
    async signIn(email, password) { const s = await call('signin', { email, password }); setSession(s); return s.user; },
    async signOut() { setSession(null); },
    async changePassword(password) { await call('change_password', { password }); },
    async deleteAccount() { await call('delete_my_account'); setSession(null); },
    async getDisplayName() { return call('get_display_name'); },
    async setDisplayName(name) { await call('set_display_name', { name }); },
    listContacts: () => call('list_contacts'),
    async updateContact(id, patch) { await call('update_contact', { id, patch }); },
    async removeContact(id) { await call('remove_contact', { id }); },
    async blockContact(id) { await call('block_contact', { id }); },
    async unblockContact(id) { await call('unblock_contact', { id }); },
    createInvite: () => call('create_invite'),
    listInvites: () => call('list_invites'),
    async revokeInvite(id) { await call('revoke_invite', { id }); },
    peekInvite: (code) => call('peek_invite', { code }),
    acceptInvite: (code, alias) => call('accept_invite', { code, alias }),
    async declineInvite(code) { await call('decline_invite', { code }); },
    send: (input) => call('send', { ...input }),
    retract: (id) => call('retract', { id }),
    listSent: () => call('list_sent'),
    listInbox: () => call('list_inbox'),
    getInboxRec: (id) => call('get_inbox_rec', { id }),
    async markSeen(ids) { await call('mark_seen', { ids }); },
    async setArchived(id, archived) { await call('set_archived', { id, archived }); },
    subscribeInbox(onInsert, onDelete) {
      let known: Set<string> | undefined;
      let stop = false;
      const tick = async () => {
        if (stop || !session()) return;
        try {
          const ids: string[] = await call('inbox_ids');
          const now = new Set(ids);
          if (known) { for (const id of ids) if (!known.has(id)) onInsert(id); for (const id of known) if (!now.has(id)) onDelete(id); }
          known = now;
        } catch { /* sin conexión: se reintenta */ }
      };
      void tick();
      const t = setInterval(tick, 1200);
      return () => { stop = true; clearInterval(t); };
    },
    syncWant: (items) => call('sync_want', { items }),
    async clearWant() { await call('clear_want'); },
    getMatches: (contact) => call('get_matches', { contact }),
    getPrefs: () => call('get_prefs'),
    async setPrefs(p) { await call('set_prefs', { p }); },
    putShared: (items) => (items.length ? call('put_shared', { items }) : Promise.resolve([])),
    getShared: () => call('get_shared'),
    subscribeEvents(onEvent) {
      let last = -1;
      let stop = false;
      const tick = async () => {
        if (stop || !session()) return;
        try {
          const evs: any[] = await call('events_since', { id: last });
          if (last >= 0) for (const e of evs) onEvent(e);
          if (evs.length) last = Math.max(last, ...evs.map((e) => e.id)); else if (last < 0) last = await call('events_max');
        } catch { /* sin conexión */ }
      };
      void tick();
      const t = setInterval(tick, 1000);
      return () => { stop = true; clearInterval(t); };
    },
    async notifyEvents(ids) { if (ids.length) await call('notify_events', { ids }); },
    async savePush() { throw new SocialError('unknown', 'push no disponible en pruebas'); },
    async deletePush() { /* */ },
    async notify(recId) { await call('notify', { id: recId }); },
  };
}
