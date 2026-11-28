/**
 * v4.2 Social · estado compartido de las funciones sociales.
 *
 * Independiente del recomendador: se carga en segundo plano después de abrir la app (import dinámico) y ningún error
 * del servicio social bloquea Inicio, las valoraciones ni los motores. Nada de lo que ocurre acá escribe en el perfil
 * de gustos, las notas ni el ranking: recibir una recomendación no es una señal de interés.
 */
import { db } from '../db/db';
import { createProfile, updateConfig } from '../db/repo';
import { dismissNotice, pushNotice } from '../services/notices';
import { parseKey, type TitleKey } from '../types';
import type { SocialBackend } from './backend';
import { socialEndpoint } from './config';
import { SocialError, toSocialError, type Contact, type InboxRec, type PutItem, type SendInput, type SentRec, type SharedRow, type SocialEvent, type SocialPrefs, type SocialUser, type WantSyncItem } from './types';
import { isSharedAnswer, type SharedAnswer } from './interests';

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
  /** v4.3 · intereses/valoraciones que mis contactos me autorizan a ver (foto del servidor) */
  shared: SharedRow[];
  /** v4.3 · coincidencias de Quiero ver por contacto (sólo claves; títulos intercambiados) */
  wantMatches: Record<string, TitleKey[]>;
  /** v4.3 · lo que publiqué (o está pendiente de publicar) por título */
  pub: Record<string, PubEntry>;
  prefs: SocialPrefs;
}
export interface PubVal<T> { v: T; at: number; st: 'pending' | 'ok' | 'not_shared' }
export interface PubEntry { a?: PubVal<SharedAnswer>; r?: PubVal<number | null>; baseR?: number | null }

const DEFAULT_PREFS: SocialPrefs = { notifyRecs: true, notifyMatches: false, notifyMax: false };
const EMPTY_SOCIAL = { contacts: [], inbox: [], sent: [], outbox: [], shared: [], wantMatches: {}, pub: {}, prefs: DEFAULT_PREFS };
let state: SocialState = { available: Boolean(socialEndpoint()), phase: 'idle', reachable: true, ...EMPTY_SOCIAL };
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
const pubKey = (uid: string) => `cine-match:social:${uid}:pub`;
function persistCache() {
  const u = state.user;
  if (!u || state.phase !== 'ready') return;
  try {
    localStorage.setItem(cacheKey(u.id), JSON.stringify({ contacts: state.contacts, inbox: state.inbox.slice(0, 300), sent: state.sent.slice(0, 1000), displayName: u.displayName, shared: state.shared, wantMatches: state.wantMatches, prefs: state.prefs }));
    localStorage.setItem(outboxKey(u.id), JSON.stringify(state.outbox));
    localStorage.setItem(pubKey(u.id), JSON.stringify(state.pub));
  } catch { /* almacenamiento lleno: la caché es opcional */ }
}
function readCache(uid: string): Partial<SocialState> & { displayName?: string } {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(uid)) ?? '{}');
    const outbox = JSON.parse(localStorage.getItem(outboxKey(uid)) ?? '[]');
    const pub = JSON.parse(localStorage.getItem(pubKey(uid)) ?? '{}');
    // Contactos de una caché de v4.2: los permisos nuevos empiezan desactivados
    const contacts = (c.contacts ?? []).map((x: Partial<Contact>) => ({ shareInterests: false, shareRatings: false, notifyMatches: true, theirShareInterests: false, theirShareRatings: false, ...x }));
    return { contacts, inbox: c.inbox ?? [], sent: c.sent ?? [], outbox, displayName: c.displayName, shared: c.shared ?? [], wantMatches: c.wantMatches ?? {}, pub, prefs: { ...DEFAULT_PREFS, ...(c.prefs ?? {}) } };
  } catch { return { ...EMPTY_SOCIAL }; }
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
let unsubEvents: (() => void) | undefined;
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
export function stopSocialForTests() { unsubInbox?.(); unsubEvents?.(); unsubAuth?.(); started = false; backend = undefined; backendP = undefined; }

async function enterAccount(u: SocialUser, fresh: boolean) {
  const cache = readCache(u.id);
  set({ user: { ...u, displayName: u.displayName ?? cache.displayName }, phase: 'ready', contacts: cache.contacts ?? [], inbox: cache.inbox ?? [], sent: cache.sent ?? [], outbox: cache.outbox ?? [],
    shared: cache.shared ?? [], wantMatches: cache.wantMatches ?? {}, pub: cache.pub ?? {}, prefs: cache.prefs ?? DEFAULT_PREFS });
  if (fresh) await bindProfile(state.user!);
  unsubInbox?.();
  const b = await getBackend();
  unsubInbox = b.subscribeInbox((id) => { void onIncoming(id); }, (id) => set({ inbox: state.inbox.filter((r) => r.id !== id) }));
  unsubEvents?.();
  unsubEvents = b.subscribeEvents((e) => { void onEvent(e); });
  await refresh(true);
  if (!fresh && state.user) {
    // Si el perfil activo no es el de esta cuenta (p. ej. lo cambiaron a mano), se avisa sin cambiar nada
    const bound = boundProfile(state.user.id);
    if (!bound) await bindProfile(state.user);
  }
}
function leaveAccount() {
  unsubInbox?.(); unsubInbox = undefined;
  unsubEvents?.(); unsubEvents = undefined;
  set({ user: undefined, phase: 'signed-out', ...EMPTY_SOCIAL, loadedAt: undefined });
}

let refreshing: Promise<void> | undefined;
export function refresh(force = false): Promise<void> {
  if (state.phase !== 'ready') return Promise.resolve();
  if (!force && state.loadedAt && Date.now() - state.loadedAt < 30_000) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const b = await getBackend();
      const [contacts, inbox, sent, name, prefs] = await Promise.all([b.listContacts(), b.listInbox(), b.listSent(), b.getDisplayName(), b.getPrefs().catch(() => state.prefs)]);
      set({ contacts, inbox: mergeInbox(inbox), sent, prefs, reachable: true, loadedAt: Date.now(), user: state.user && { ...state.user, displayName: name ?? state.user.displayName } });
      await flushOutbox();
      // v4.3: permisos revalidados en el servidor; primero se envía lo pendiente y después se pide la foto compartida
      await flushShared();
      await refreshShared();
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

const incomingNotices = new Set<number>();
/** Al abrir Me recomendaron, los avisos de «X te recomendó…» ya no hacen falta. */
export function clearIncomingNotices() { for (const n of incomingNotices) dismissNotice(n); incomingNotices.clear(); }

async function onIncoming(id: string) {
  if (state.inbox.some((r) => r.id === id)) return;
  try {
    const rec = await (await getBackend()).getInboxRec(id);
    if (!rec || state.inbox.some((r) => r.id === id)) return;
    set({ inbox: [rec, ...state.inbox] });
    const who = contactName(rec.sender) ?? rec.senderName;
    if (!state.prefs.notifyRecs) return;
    // En la propia bandeja no hace falta el aviso: la tarjeta aparece arriba
    if (typeof location !== 'undefined' && (location.hash.startsWith('#/recibidas') || location.hash.startsWith('#/compartidas')) && !location.hash.includes('tab=')) return;
    incomingNotices.add(pushNotice({ kind: 'info', text: `${who} te recomendó «${rec.title}».`, action: { label: 'Ver', run: () => onOpenRec?.(rec.id) } }, 7000));
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
  if (uid) { try { localStorage.removeItem(cacheKey(uid)); localStorage.removeItem(outboxKey(uid)); localStorage.removeItem(pubKey(uid)); const bd = bindings(); delete bd[uid]; localStorage.setItem(BIND_KEY, JSON.stringify(bd)); } catch { /* */ } }
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
export const updateContact = (id: string, patch: Parameters<SocialBackend['updateContact']>[1]) => contactsOp((b) => b.updateContact(id, patch)).then(() => {
  if (patch.shareMatches !== undefined || patch.shareScores !== undefined) wantDirty();
  if (patch.shareInterests !== undefined || patch.shareRatings !== undefined || patch.shareMatches !== undefined) void refreshShared();
});
export const removeContact = (id: string) => contactsOp((b) => b.removeContact(id)).then(() => { wantDirty(); void refreshShared(); });
export const blockContact = (id: string) => contactsOp((b) => b.blockContact(id)).then(() => { wantDirty(); void refreshShared(); });
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
    set({ sent: [{ id: r.id, recipient: input.recipient, key, createdAt: r.createdAt, title: input.title, year: input.year, posterPath: input.posterPath ?? undefined, comment: input.comment?.trim() || undefined }, ...state.sent], reachable: true });
    void afterSend(key, input.recipient);
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
        const k = `${o.input.type}:${o.input.tmdbId}` as TitleKey;
        set({ outbox: state.outbox.filter((x) => x.localId !== o.localId), sent: [{ id: r.id, recipient: o.input.recipient, key: k, createdAt: r.createdAt, title: o.input.title, year: o.input.year, posterPath: o.input.posterPath ?? undefined, comment: o.input.comment?.trim() || undefined }, ...state.sent], reachable: true });
        void afterSend(k, o.input.recipient);
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

/** Coincidencias con un contacto (sincroniza antes la lista propia, si está autorizada). */
export async function fetchMatches(contactId: string) {
  await syncWantNow();
  return (await getBackend()).getMatches(contactId);
}

// ───────────── v4.3 · intereses compartidos ─────────────
/**
 * Reglas:
 *  - Lo local manda: el recomendador usa sólo los intereses del dispositivo. Acá se publica la ÚLTIMA respuesta de
 *    interés (sin «Ya la vi») y, con su permiso aparte, la valoración posterior, únicamente de títulos intercambiados con
 *    contactos que autorizaste. El servidor vuelve a verificar todo.
 *  - Se publica al cambiar la respuesta (desde cualquier pantalla), al compartir un título, o al dar consentimiento para
 *    publicar respuestas ya registradas. Una respuesta vieja nunca se publica sola.
 *  - Sin conexión el cambio queda «pendiente» (no se muestra como compartido) y se envía al volver. Cada envío lleva la
 *    hora del cambio: reenviar es idempotente y un cambio viejo nunca pisa a uno nuevo.
 */
export interface LocalSource {
  profileId: string;
  answers: () => Promise<Map<TitleKey, SharedAnswer>>;
  ratings: () => Promise<Map<TitleKey, number>>;
}
let local: LocalSource | undefined;
export function setLocalSource(src: LocalSource) { local = src; }
const ownProfile = () => Boolean(local && state.user && (boundProfile(state.user.id) ?? local.profileId) === local.profileId);

/** Contactos (activos) con los que el título está intercambiado. */
export function exchangedWith(key: TitleKey): string[] {
  const ids = new Set<string>();
  for (const s of state.sent) if (s.key === key) ids.add(s.recipient);
  for (const r of state.inbox) if (r.key === key) ids.add(r.sender);
  for (const [c, ks] of Object.entries(state.wantMatches)) if (ks.includes(key)) ids.add(c);
  const active = new Set(activeContacts().map((c) => c.id));
  return [...ids].filter((id) => active.has(id));
}
/** Desde cuándo (aprox., hora del servidor de la recomendación) el título está intercambiado con ese contacto. */
export function exchangeTime(key: TitleKey, contactId: string): number {
  const ts = [...state.sent.filter((s) => s.key === key && s.recipient === contactId), ...state.inbox.filter((r) => r.key === key && r.sender === contactId)].map((x) => x.createdAt);
  return ts.length ? Math.min(...ts) : 0;
}
export const bothWant = (key: TitleKey, contactId: string) => Boolean(state.wantMatches[contactId]?.includes(key));
export function theirRow(key: TitleKey, contactId: string) { return state.shared.find((r) => r.key === key && r.contact === contactId); }

export type TheirState = { kind: 'private'; why: 'mine' | 'theirs' } | { kind: 'none' } | { kind: 'answer'; v: SharedAnswer; at?: number };
export function theirState(key: TitleKey, c: Contact): TheirState {
  if (!c.shareInterests) return { kind: 'private', why: 'mine' };
  if (!c.theirShareInterests) return { kind: 'private', why: 'theirs' };
  const r = theirRow(key, c.id);
  return r?.answer ? { kind: 'answer', v: r.answer, at: r.answerAt } : { kind: 'none' };
}
export type MyState = 'private' | 'none' | 'pending' | 'shared' | 'unshared';
/** Estado de MI respuesta respecto de un contacto (lo que esa persona puede ver). */
export function myState(key: TitleKey, c: Contact, mine?: SharedAnswer): MyState {
  if (!c.shareInterests) return 'private';
  if (!mine) return 'none';
  const p = state.pub[key]?.a;
  if (p?.st === 'pending') return 'pending';
  if (p && p.st === 'ok' && p.v === mine && p.at >= exchangeTime(key, c.id) - 120_000) return 'shared';
  return 'unshared';
}

function setPub(key: TitleKey, patch: Partial<PubEntry>) { set({ pub: { ...state.pub, [key]: { ...state.pub[key], ...patch } } }); }
const eligible = (key: TitleKey, what: 'shareInterests' | 'shareRatings') => exchangedWith(key).some((id) => state.contacts.find((c) => c.id === id)?.[what]);

/** Publica una respuesta propia (si el título está intercambiado con alguien autorizado). */
export function publishAnswer(key: TitleKey, v: SharedAnswer) {
  if (state.phase !== 'ready' || !eligible(key, 'shareInterests')) return false;
  setPub(key, { a: { v, at: Date.now(), st: 'pending' } });
  scheduleFlushShared();
  return true;
}
export function publishRating(key: TitleKey, v: number | null) {
  if (state.phase !== 'ready' || !eligible(key, 'shareRatings')) return false;
  setPub(key, { r: { v, at: Date.now(), st: 'pending' }, baseR: v });
  scheduleFlushShared();
  return true;
}
/** Al compartir un título: tu respuesta actual (y tu valoración, si la autorizaste) pasa a verse para ese contacto. */
async function afterSend(key: TitleKey, recipient: string) {
  const c = state.contacts.find((x) => x.id === recipient);
  if (!c || !local || !ownProfile()) return;
  if (c.shareInterests) { const a = (await local.answers()).get(key); if (a) publishAnswer(key, a); }
  if (c.shareRatings) { const r = (await local.ratings()).get(key); if (r !== undefined) publishRating(key, r); }
}
/** Lo llama la app cuando se guarda una respuesta de interés (cualquier pantalla). */
export function onLocalAnswer(profileId: string, key: TitleKey, answer: string) {
  if (!local || local.profileId !== profileId || !ownProfile() || !isSharedAnswer(answer)) return;
  publishAnswer(key, answer);
}
/**
 * Valoraciones posteriores: la primera vez que un título intercambiado entra en juego se toma como base (no se publica
 * sola); cada cambio posterior sí se publica.
 */
export function syncLocalRatings(profileId: string, ratings: Map<TitleKey, number>) {
  if (!local || local.profileId !== profileId || !ownProfile() || state.phase !== 'ready') return;
  if (!state.contacts.some((c) => c.shareRatings && !c.blocked)) return;
  const pub = { ...state.pub }; let changed = false;
  const keys = new Set<TitleKey>([...state.sent.map((s) => s.key), ...state.inbox.map((r) => r.key), ...Object.values(state.wantMatches).flat()]);
  for (const k of keys) {
    if (!eligible(k, 'shareRatings')) continue;
    const cur = ratings.get(k) ?? null;
    const e = pub[k] ?? {};
    const last = e.r ? e.r.v : e.baseR;
    if (last === undefined) { pub[k] = { ...e, baseR: cur }; changed = true; continue; }
    if (last !== cur) { pub[k] = { ...e, r: { v: cur, at: Date.now(), st: 'pending' }, baseR: cur }; changed = true; }
  }
  if (changed) { set({ pub }); scheduleFlushShared(); }
}
/** Cuántas respuestas ya registradas se podrían publicar al activar un permiso con este contacto (para pedir consentimiento). */
export async function backfillCount(contactId: string, what: 'interests' | 'ratings'): Promise<number> {
  if (!local) return 0;
  const m = what === 'interests' ? await local.answers() : await local.ratings();
  return [...m.keys()].filter((k) => exchangedWith(k).includes(contactId)).length;
}
/** Activa/desactiva un permiso. Con `backfill`, publica también lo ya registrado de los títulos intercambiados con ese contacto. */
export async function setSharePermission(contactId: string, what: 'interests' | 'ratings', on: boolean, backfill = false) {
  await updateContact(contactId, what === 'interests' ? { shareInterests: on } : { shareRatings: on });
  if (!on) { await refreshShared(); return; }
  if (backfill && local && ownProfile()) {
    if (what === 'interests') { for (const [k, a] of await local.answers()) if (exchangedWith(k).includes(contactId)) publishAnswer(k, a); }
    else { for (const [k, r] of await local.ratings()) if (exchangedWith(k).includes(contactId)) publishRating(k, r); }
  }
  await flushShared();
  await refreshShared();
}

let sharedTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFlushShared(ms = 300) { if (sharedTimer) clearTimeout(sharedTimer); sharedTimer = setTimeout(() => { void flushShared(); }, ms); }
let sharedFlushing: Promise<void> | undefined;
export function flushShared(): Promise<void> {
  if (state.phase !== 'ready') return Promise.resolve();
  sharedFlushing ??= (async () => {
    // Siempre asíncrono: si terminara antes del primer await, el «finally» correría antes de la asignación
    await Promise.resolve();
    try {
      for (let round = 0; round < 3; round++) {
        const items: PutItem[] = [];
        for (const [k, e] of Object.entries(state.pub)) {
          if (e.a?.st === 'pending') items.push({ key: k as TitleKey, f: 'answer', v: e.a.v, at: e.a.at });
          if (e.r?.st === 'pending') items.push({ key: k as TitleKey, f: 'rating', v: e.r.v === null ? null : String(Math.round(e.r.v * 10) / 10), at: e.r.at });
        }
        if (!items.length) return;
        const b = await getBackend();
        let res;
        try { res = await b.putShared(items.slice(0, 200)); } catch (err) {
          const se = toSocialError(err);
          if (se.code === 'network') { set({ reachable: false }); return; }
          if (se.code === 'rate_limited') return;
          throw se;
        }
        const pub = { ...state.pub };
        const evs: number[] = [];
        for (const r of res) {
          const e = { ...pub[r.key] };
          const sent = items.find((i) => i.key === r.key && i.f === r.f)!;
          const cur = r.f === 'answer' ? e.a : e.r;
          // Si cambió otra vez mientras viajaba, el nuevo queda pendiente
          if (!cur || cur.at !== sent.at) continue;
          const st = r.status === 'not_shared' || r.status === 'invalid' ? 'not_shared' : 'ok';
          if (r.f === 'answer') e.a = { ...e.a!, st }; else e.r = { ...e.r!, st };
          pub[r.key] = e;
          evs.push(...r.events);
        }
        set({ pub, reachable: true });
        if (evs.length) b.notifyEvents(evs).catch(() => undefined);
      }
    } catch { /* se reintenta en el próximo cambio o al reconectar */ } finally { sharedFlushing = undefined; }
  })();
  return sharedFlushing;
}
export const pendingShared = () => Object.values(state.pub).filter((e) => e.a?.st === 'pending' || e.r?.st === 'pending').length;

let sharedRefreshing: Promise<void> | undefined;
/** Foto de lo compartido conmigo + coincidencias de Quiero ver (un pedido por contacto con Para ver juntos mutuo). */
export function refreshShared(): Promise<void> {
  if (state.phase !== 'ready') return Promise.resolve();
  sharedRefreshing ??= (async () => {
    try {
      const b = await getBackend();
      const mm = state.contacts.filter((c) => c.linked && !c.blocked && c.shareMatches && c.theirShareMatches);
      const [shared, ...wm] = await Promise.all([b.getShared(), ...mm.map((c) => b.getMatches(c.id).then((m) => m.map((x) => x.key)).catch(() => state.wantMatches[c.id] ?? []))]);
      const wantMatches: Record<string, TitleKey[]> = {};
      mm.forEach((c, i) => { wantMatches[c.id] = wm[i]; });
      set({ shared, wantMatches, reachable: true });
    } catch (e) { if (toSocialError(e).code === 'network') set({ reachable: false }); } finally { sharedRefreshing = undefined; }
  })();
  return sharedRefreshing;
}

let onOpenMatch: ((key: TitleKey, contact: string) => void) | undefined;
export function setOpenMatchHandler(fn: (key: TitleKey, contact: string) => void) { onOpenMatch = fn; }
let evTimer: ReturnType<typeof setTimeout> | undefined;
async function onEvent(e: SocialEvent) {
  // Un cambio de permisos del otro lado también llega acá: se revalidan contactos y foto compartida
  if (evTimer) clearTimeout(evTimer);
  evTimer = setTimeout(() => {
    void (async () => { try { const b = await getBackend(); set({ contacts: await b.listContacts() }); } catch { /* */ } await refreshShared(); })();
  }, 400);
  if (e.kind === 'shared' || !e.key) return;
  const c = state.contacts.find((x) => x.id === e.actor);
  if (!c || !c.notifyMatches) return;
  if (e.kind === 'match' && !state.prefs.notifyMatches) return;
  if (e.kind === 'match_max' && !state.prefs.notifyMax) return;
  const title = e.title ?? state.sent.find((s) => s.key === e.key)?.title ?? state.inbox.find((r) => r.key === e.key)?.title ?? 'un título que tienen en común';
  const text = e.kind === 'match_max' ? `Ambos tienen muchas ganas de ver «${title}».` : `Nueva coincidencia: a ${c.alias} también le interesa «${title}».`;
  const key = e.key;
  pushNotice({ kind: 'info', text, action: { label: 'Ver', run: () => onOpenMatch?.(key, c.id) } }, 9000);
}
export async function setPrefs(p: Partial<SocialPrefs>) {
  const prev = state.prefs;
  set({ prefs: { ...state.prefs, ...p } });
  try { await (await getBackend()).setPrefs(p); } catch (e) { set({ prefs: prev }); throw toSocialError(e); }
}

/** SÓLO PRUEBAS: inyecta un servicio social y un estado inicial. */
export function __setForTests(b: SocialBackend, patch: Partial<SocialState>) { backend = b; backendP = Promise.resolve(b); set(patch); }
