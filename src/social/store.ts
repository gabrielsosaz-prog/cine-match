/**
 * v4.2 Social · estado compartido de las funciones sociales.
 *
 * Independiente del recomendador: se carga en segundo plano después de abrir la app (import dinámico) y ningún error
 * del servicio social bloquea Inicio, las valoraciones ni los motores. Nada de lo que ocurre acá escribe en el perfil
 * de gustos, las notas ni el ranking: recibir una recomendación no es una señal de interés.
 */
import { db } from '../db/db';
import { createProfile, updateConfig } from '../db/repo';
import { pushNotice } from '../services/notices';
import { parseKey, type TitleKey } from '../types';
import type { SocialBackend } from './backend';
import { socialEndpoint } from './config';
import { SocialError, toSocialError, type Contact, type InboxRec, type SendInput, type SentRec, type SocialUser, type WantSyncItem } from './types';

export interface OutboxItem { localId: string; input: SendInput; state: 'pending' | 'failed'; error?: string; at: number }
export interface SocialState {
  available: boolean;
  phase: 'idle' | 'loading' | 'signed-out' | 'ready';
  user?: SocialUser;
  /** false si la última consulta al servicio falló por conexión */
  reachable: boolean;
  contacts: Contact[];
  inbox: InboxRec[];
  sent: SentRec[];
  outbox: OutboxItem[];
  loadedAt?: number;
}

let state: SocialState = { available: Boolean(socialEndpoint()), phase: 'idle', reachable: true, contacts: [], inbox: [], sent: [], outbox: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<SocialState>) => { state = { ...state, ...patch }; persistCache(); for (const l of listeners) l(); updateBadge(); };
export const getSocial = () => state;
export function subscribeSocial(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

let backend: SocialBackend | undefined;
let backendP: Promise<SocialBackend> | undefined;
export function getBackend(): Promise<SocialBackend> {
  if (backend) return Promise.resolve(backend);
  const ep = socialEndpoint();
  if (!ep) return Promise.reject(new SocialError('not_configured'));
  backendP ??= (ep.kind === 'fake'
    ? import('./fakeBackend').then((m) => m.createFakeBackend(ep.url))
    : import('./supabaseBackend').then((m) => m.createSupabaseBackend(ep.url, ep.key))).then((b) => (backend = b));
  return backendP;
}

// ───────────── caché local por cuenta (para abrir sin conexión) ─────────────
const cacheKey = (uid: string) => `cine-match:social:${uid}:cache`;
const outboxKey = (uid: string) => `cine-match:social:${uid}:outbox`;
function persistCache() {
  const u = state.user;
  if (!u || state.phase !== 'ready') return;
  try {
    localStorage.setItem(cacheKey(u.id), JSON.stringify({ contacts: state.contacts, inbox: state.inbox.slice(0, 300), sent: state.sent.slice(0, 1000), displayName: u.displayName }));
    localStorage.setItem(outboxKey(u.id), JSON.stringify(state.outbox));
  } catch { /* almacenamiento lleno: la caché es opcional */ }
}
function readCache(uid: string): Partial<SocialState> & { displayName?: string } {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(uid)) ?? '{}');
    const outbox = JSON.parse(localStorage.getItem(outboxKey(uid)) ?? '[]');
    return { contacts: c.contacts ?? [], inbox: c.inbox ?? [], sent: c.sent ?? [], outbox, displayName: c.displayName };
  } catch { return { contacts: [], inbox: [], sent: [], outbox: [] }; }
}

// ───────────── cuenta ↔ perfil local ─────────────
const BIND_KEY = 'cine-match:social-bindings';
const bindings = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(BIND_KEY) ?? '{}'); } catch { return {}; } };
export function boundProfile(uid: string) { return bindings()[uid]; }
/**
 * Cada cuenta queda asociada a un perfil local. Al iniciar sesión se activa SU perfil; si el perfil activo pertenece a
 * otra cuenta, se crea uno nuevo para no mezclar datos. Nunca se borra ni se modifica un perfil existente.
 */
async function bindProfile(u: SocialUser) {
  const b = bindings();
  const cfg = await db.config.get('app');
  const profiles = await db.profiles.toArray();
  const mine = b[u.id];
  if (mine && profiles.some((p) => p.id === mine)) {
    if (cfg?.activeProfileId !== mine) {
      await updateConfig({ activeProfileId: mine });
      pushNotice({ kind: 'info', text: `Perfil local de ${u.displayName ?? u.email} activado.` }, 5000);
    }
    return;
  }
  const active = cfg?.activeProfileId;
  const taken = new Set(Object.entries(b).filter(([id]) => id !== u.id).map(([, p]) => p));
  if (active && !taken.has(active)) { b[u.id] = active; localStorage.setItem(BIND_KEY, JSON.stringify(b)); return; }
  const base = (u.displayName ?? u.email?.split('@')[0] ?? 'Cuenta').slice(0, 30);
  let name = base, n = 2;
  while (profiles.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
  const p = await createProfile(name);
  b[u.id] = p.id; localStorage.setItem(BIND_KEY, JSON.stringify(b));
  await updateConfig({ activeProfileId: p.id });
  pushNotice({ kind: 'info', text: `Se creó el perfil local «${name}» para esta cuenta. Los datos del perfil anterior quedan intactos.` }, 9000);
}

// ───────────── ciclo de vida ─────────────
let unsubInbox: (() => void) | undefined;
let unsubAuth: (() => void) | undefined;
let started = false;
let onOpenRec: ((id: string) => void) | undefined;
export function setOpenRecHandler(fn: (id: string) => void) { onOpenRec = fn; }

export async function initSocial() {
  if (started || !state.available) return;
  started = true;
  set({ phase: 'loading' });
  try {
    const b = await getBackend();
    const u = await b.currentUser();
    if (u) await enterAccount(u, false); else set({ phase: 'signed-out' });
    unsubAuth = b.onAuthChange((nu) => {
      if (!nu && state.user) leaveAccount();
    });
    window.addEventListener('online', () => { void refresh(true); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  } catch (e) {
    set({ phase: 'signed-out', reachable: toSocialError(e).code !== 'network' });
  }
}
export function stopSocialForTests() { unsubInbox?.(); unsubAuth?.(); started = false; backend = undefined; backendP = undefined; }

async function enterAccount(u: SocialUser, fresh: boolean) {
  const cache = readCache(u.id);
  set({ user: { ...u, displayName: u.displayName ?? cache.displayName }, phase: 'ready', contacts: cache.contacts ?? [], inbox: cache.inbox ?? [], sent: cache.sent ?? [], outbox: cache.outbox ?? [] });
  if (fresh) await bindProfile(state.user!);
  unsubInbox?.();
  const b = await getBackend();
  unsubInbox = b.subscribeInbox((id) => { void onIncoming(id); }, (id) => set({ inbox: state.inbox.filter((r) => r.id !== id) }));
  await refresh(true);
  if (!fresh && state.user) {
    // Si el perfil activo no es el de esta cuenta (p. ej. lo cambiaron a mano), se avisa sin cambiar nada
    const bound = boundProfile(state.user.id);
    if (!bound) await bindProfile(state.user);
  }
}
function leaveAccount() {
  unsubInbox?.(); unsubInbox = undefined;
  set({ user: undefined, phase: 'signed-out', contacts: [], inbox: [], sent: [], outbox: [], loadedAt: undefined });
}

let refreshing: Promise<void> | undefined;
export function refresh(force = false): Promise<void> {
  if (state.phase !== 'ready') return Promise.resolve();
  if (!force && state.loadedAt && Date.now() - state.loadedAt < 30_000) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const b = await getBackend();
      const [contacts, inbox, sent, name] = await Promise.all([b.listContacts(), b.listInbox(), b.listSent(), b.getDisplayName()]);
      set({ contacts, inbox: mergeInbox(inbox), sent, reachable: true, loadedAt: Date.now(), user: state.user && { ...state.user, displayName: name ?? state.user.displayName } });
      await flushOutbox();
    } catch (e) {
      const err = toSocialError(e);
      if (err.code === 'not_authenticated') leaveAccount(); else set({ reachable: err.code !== 'network' ? state.reachable : false });
    } finally { refreshing = undefined; }
  })();
  return refreshing;
}
/** Conserva los cambios locales (consultada/archivada) que el servidor todavía no confirmó */
function mergeInbox(server: InboxRec[]) {
  const local = new Map(state.inbox.map((r) => [r.id, r]));
  return server.map((r) => { const l = local.get(r.id); return l ? { ...r, seenAt: r.seenAt ?? l.seenAt, archivedAt: l.archivedAt !== undefined || r.archivedAt === undefined ? l.archivedAt : r.archivedAt } : r; });
}

async function onIncoming(id: string) {
  if (state.inbox.some((r) => r.id === id)) return;
  try {
    const rec = await (await getBackend()).getInboxRec(id);
    if (!rec || state.inbox.some((r) => r.id === id)) return;
    set({ inbox: [rec, ...state.inbox] });
    const who = contactName(rec.sender) ?? rec.senderName;
    pushNotice({ kind: 'info', text: `${who} te recomendó «${rec.title}».`, action: { label: 'Ver', run: () => onOpenRec?.(rec.id) } }, 7000);
  } catch { /* se verá en la próxima actualización */ }
}

// ───────────── cuenta ─────────────
export async function signUp(email: string, password: string, displayName: string) {
  if (password.length < 8) throw new SocialError('weak_password');
  if (!displayName.trim()) throw new SocialError('no_profile');
  const b = await getBackend();
  const u = await b.signUp(email.trim(), password, displayName.trim());
  await enterAccount({ ...u, displayName: displayName.trim() }, true);
}
export async function signIn(email: string, password: string) {
  const b = await getBackend();
  const u = await b.signIn(email.trim(), password);
  const name = await b.getDisplayName().catch(() => undefined);
  await enterAccount({ ...u, displayName: name }, true);
}
export async function signOut() {
  const b = await getBackend();
  const { disablePush } = await import('./push');
  await disablePush().catch(() => undefined);
  await b.signOut();
  leaveAccount();
}
export async function deleteAccount() {
  const b = await getBackend();
  const uid = state.user?.id;
  const { disablePush } = await import('./push');
  await disablePush().catch(() => undefined);
  await b.deleteAccount();
  if (uid) { try { localStorage.removeItem(cacheKey(uid)); localStorage.removeItem(outboxKey(uid)); const bd = bindings(); delete bd[uid]; localStorage.setItem(BIND_KEY, JSON.stringify(bd)); } catch { /* */ } }
  leaveAccount();
}
export async function setDisplayName(name: string) {
  await (await getBackend()).setDisplayName(name);
  set({ user: state.user && { ...state.user, displayName: name.trim() } });
}

// ───────────── contactos ─────────────
export const contactName = (id: string) => state.contacts.find((c) => c.id === id)?.alias;
export const favoriteContact = () => state.contacts.find((c) => c.favorite && c.linked && !c.blocked);
export const activeContacts = () => state.contacts.filter((c) => c.linked && !c.blocked);
async function contactsOp(fn: (b: SocialBackend) => Promise<unknown>) {
  const b = await getBackend();
  await fn(b);
  set({ contacts: await b.listContacts() });
}
export const updateContact = (id: string, patch: Parameters<SocialBackend['updateContact']>[1]) => contactsOp((b) => b.updateContact(id, patch)).then(() => { if (patch.shareMatches !== undefined || patch.shareScores !== undefined) wantDirty(); });
export const removeContact = (id: string) => contactsOp((b) => b.removeContact(id)).then(() => wantDirty());
export const blockContact = (id: string) => contactsOp((b) => b.blockContact(id)).then(() => wantDirty());
export const unblockContact = (id: string) => contactsOp((b) => b.unblockContact(id));
export async function acceptInvite(code: string, alias?: string) {
  const b = await getBackend();
  const r = await b.acceptInvite(code, alias);
  set({ contacts: await b.listContacts() });
  return r;
}

// ───────────── recomendaciones enviadas ─────────────
export type ShareResult = { status: 'sent'; id: string; to: string } | { status: 'pending'; to: string } | { status: 'failed'; to: string; error: SocialError };
export function sentTo(key: TitleKey): SentRec[] { return state.sent.filter((s) => s.key === key); }
export function pendingFor(key: TitleKey): OutboxItem[] { const { type, id } = parseKey(key); return state.outbox.filter((o) => o.input.type === type && o.input.tmdbId === id); }

export async function share(input: SendInput): Promise<ShareResult> {
  const to = contactName(input.recipient) ?? 'tu contacto';
  try {
    const b = await getBackend();
    const r = await b.send(input);
    const key = `${input.type}:${input.tmdbId}` as TitleKey;
    set({ sent: [{ id: r.id, recipient: input.recipient, key, createdAt: r.createdAt }, ...state.sent], reachable: true });
    return { status: 'sent', id: r.id, to };
  } catch (e) {
    const err = toSocialError(e);
    if (err.code === 'network') {
      // Queda pendiente y se envía al recuperar la conexión. No se informa como enviada.
      const item: OutboxItem = { localId: `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, input, state: 'pending', at: Date.now() };
      set({ outbox: [...state.outbox.filter((o) => !(o.input.recipient === input.recipient && o.input.tmdbId === input.tmdbId && o.input.type === input.type)), item], reachable: false });
      return { status: 'pending', to };
    }
    return { status: 'failed', to, error: err };
  }
}
let flushing = false;
export async function flushOutbox() {
  if (flushing || !state.outbox.some((o) => o.state === 'pending')) return;
  flushing = true;
  try {
    const b = await getBackend();
    for (const o of state.outbox.filter((x) => x.state === 'pending')) {
      const to = contactName(o.input.recipient) ?? 'tu contacto';
      try {
        const r = await b.send(o.input);
        set({ outbox: state.outbox.filter((x) => x.localId !== o.localId), sent: [{ id: r.id, recipient: o.input.recipient, key: `${o.input.type}:${o.input.tmdbId}` as TitleKey, createdAt: r.createdAt }, ...state.sent], reachable: true });
        pushNotice({ kind: 'info', text: `Recomendación pendiente enviada a ${to}.` }, 5000);
        scheduleNotify(r.id, 0);
      } catch (e) {
        const err = toSocialError(e);
        if (err.code === 'network') { set({ reachable: false }); break; }
        if (err.code === 'duplicate') { set({ outbox: state.outbox.filter((x) => x.localId !== o.localId), sent: await b.listSent() }); continue; }
        set({ outbox: state.outbox.map((x) => (x.localId === o.localId ? { ...x, state: 'failed', error: err.message } : x)) });
        pushNotice({ kind: 'error', text: `No se pudo enviar a ${to}: ${err.message}` });
      }
    }
  } finally { flushing = false; }
}
export function discardOutbox(localId: string) { set({ outbox: state.outbox.filter((o) => o.localId !== localId) }); }

export async function undoShare(id: string) {
  cancelNotify(id);
  const ok = await (await getBackend()).retract(id);
  if (ok) set({ sent: state.sent.filter((s) => s.id !== id) });
  return ok;
}
// La notificación push sale cuando vence el plazo para deshacer
const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const UNDO_MS = 6000;
export function scheduleNotify(id: string, ms = UNDO_MS + 500) {
  cancelNotify(id);
  notifyTimers.set(id, setTimeout(() => { notifyTimers.delete(id); getBackend().then((b) => b.notify(id)).catch(() => undefined); }, ms));
}
function cancelNotify(id: string) { const t = notifyTimers.get(id); if (t) clearTimeout(t); notifyTimers.delete(id); }

// ───────────── bandeja ─────────────
export const newCount = () => state.inbox.filter((r) => !r.seenAt && !r.archivedAt).length;
export async function markSeen(ids: string[]) {
  const todo = ids.filter((id) => state.inbox.some((r) => r.id === id && !r.seenAt));
  if (!todo.length) return;
  const at = Date.now();
  set({ inbox: state.inbox.map((r) => (todo.includes(r.id) ? { ...r, seenAt: at } : r)) });
  try { await (await getBackend()).markSeen(todo); } catch { /* se reintenta al volver a abrir */ }
}
export async function setArchived(id: string, archived: boolean) {
  const prev = state.inbox.find((r) => r.id === id)?.archivedAt;
  set({ inbox: state.inbox.map((r) => (r.id === id ? { ...r, archivedAt: archived ? Date.now() : undefined } : r)) });
  try { await (await getBackend()).setArchived(id, archived); } catch (e) {
    set({ inbox: state.inbox.map((r) => (r.id === id ? { ...r, archivedAt: prev } : r)) });
    throw toSocialError(e);
  }
}

// ───────────── «Para ver juntos»: sincronización de la lista ─────────────
let wantProvider: ((withScores: boolean) => Promise<WantSyncItem[]>) | undefined;
let wantTimer: ReturnType<typeof setTimeout> | undefined;
let lastWantSig = '';
/** La pantalla registra cómo obtener la lista «Quiero ver» del perfil activo (con puntuaciones si se autorizaron). */
export function setWantProvider(fn: (withScores: boolean) => Promise<WantSyncItem[]>) { wantProvider = fn; }
export function wantDirty(delay = 2500) {
  if (wantTimer) clearTimeout(wantTimer);
  wantTimer = setTimeout(() => { void syncWantNow(); }, delay);
}
export async function syncWantNow() {
  if (state.phase !== 'ready' || !wantProvider) return;
  const b = await getBackend();
  const matching = state.contacts.some((c) => c.shareMatches && !c.blocked);
  try {
    if (!matching) {
      if (lastWantSig !== 'cleared') { await b.clearWant(); lastWantSig = 'cleared'; }
      return;
    }
    const withScores = state.contacts.some((c) => c.shareMatches && c.shareScores && !c.blocked);
    const items = (await wantProvider(withScores)).map((i) => (withScores ? i : { ...i, score: undefined }));
    const sig = JSON.stringify(items.map((i) => [i.key, i.score === undefined ? null : Math.round(i.score * 100)]));
    if (sig === lastWantSig) return;
    await b.syncWant(items);
    lastWantSig = sig;
  } catch { /* se reintenta en el próximo cambio */ }
}

// ───────────── contador en el ícono de la app ─────────────
let lastBadge = -1;
function updateBadge() {
  const n = state.phase === 'ready' ? newCount() : 0;
  if (n === lastBadge) return;
  lastBadge = n;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try { if (n) nav.setAppBadge?.(n).catch(() => undefined); else nav.clearAppBadge?.().catch(() => undefined); } catch { /* no soportado */ }
}
