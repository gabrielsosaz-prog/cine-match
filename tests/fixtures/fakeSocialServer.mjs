// SÓLO PRUEBAS · Servidor social simulado en memoria con las MISMAS reglas que supabase/migrations (vínculo mutuo,
// invitaciones de un uso con vencimiento, duplicados, permisos de coincidencias, bloqueo). Sirve para las pruebas de
// interfaz locales; la seguridad real se prueba contra Postgres (supabase/tests) y contra Supabase en producción.
// Admin: POST /admin/reset · POST /admin/outage {on} · POST /admin/expire-invites · GET /admin/state
import { createServer } from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';

const PORT = Number(process.env.FAKE_SOCIAL_PORT ?? 4174);
let S;
const reset = () => { S = { users: new Map(), tokens: new Map(), contacts: [], invites: [], recs: [], inbox: new Map(), want: new Map(), outage: false, notified: [], shared: new Map(), events: [], evSeq: 0, prefs: new Map() }; };
reset();

class E extends Error { constructor(code, status = 400) { super(code); this.status = status; } }
const now = () => Date.now();
const contact = (o, c) => S.contacts.find((x) => x.owner === o && x.contact === c);
const linked = (a, b) => { const x = contact(a, b), y = contact(b, a); return Boolean(x && y && !x.blocked && !y.blocked); };
const clean = (s, max) => { const t = String(s ?? '').replace(/[\u0001-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max); return t || undefined; };
const norm = (c) => String(c ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const findInvite = (code) => S.invites.find((i) => i.code === norm(code) && !i.usedAt && !i.revokedAt && !i.declinedAt && i.expiresAt > now());
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rpc = {
  signup: (_, { email, password, displayName }) => {
    if (String(password ?? '').length < 8) throw new E('weak_password');
    if ([...S.users.values()].some((u) => u.email === email)) throw new E('already registered');
    const u = { id: randomUUID(), email, password, displayName: clean(displayName, 40) };
    S.users.set(u.id, u);
    const token = randomUUID(); S.tokens.set(token, u.id);
    return { token, user: { id: u.id, email } };
  },
  signin: (_, { email, password }) => {
    const u = [...S.users.values()].find((x) => x.email === email && x.password === password);
    if (!u) throw new E('Invalid login credentials');
    const token = randomUUID(); S.tokens.set(token, u.id);
    return { token, user: { id: u.id, email } };
  },
  change_password: (me, { password }) => { if (String(password).length < 8) throw new E('weak_password'); S.users.get(me).password = password; },
  delete_my_account: (me) => {
    S.users.delete(me);
    S.contacts = S.contacts.filter((c) => c.owner !== me && c.contact !== me);
    S.recs = S.recs.filter((r) => r.sender !== me && r.recipient !== me);
    S.invites = S.invites.filter((i) => i.inviter !== me);
    for (const k of [...S.shared.keys()]) if (k.startsWith(me)) S.shared.delete(k);
    S.events = S.events.filter((e) => e.user !== me && e.actor !== me);
    for (const u of S.users.keys()) prune(u);
    for (const k of [...S.want.keys()]) if (k.startsWith(me)) S.want.delete(k);
  },
  get_display_name: (me) => S.users.get(me)?.displayName,
  set_display_name: (me, { name }) => { const n = clean(name, 40); if (!n) throw new E('invalid_name'); S.users.get(me).displayName = n; },
  list_contacts: (me) => S.contacts.filter((c) => c.owner === me).map((c) => {
    const t = contact(c.contact, me);
    return { id: c.contact, alias: c.alias, favorite: c.favorite, blocked: c.blocked, shareMatches: c.shareMatches, shareScores: c.shareScores,
      theirShareMatches: Boolean(t && !t.blocked && t.shareMatches), theirShareScores: Boolean(t && !t.blocked && t.shareScores),
      shareInterests: Boolean(c.shareInterests), shareRatings: Boolean(c.shareRatings), notifyMatches: c.notifyMatches !== false,
      theirShareInterests: Boolean(t && !t.blocked && !c.blocked && t.shareInterests), theirShareRatings: Boolean(t && !t.blocked && !c.blocked && t.shareRatings), linked: Boolean(t && !t.blocked && !c.blocked), createdAt: c.createdAt };
  }),
  update_contact: (me, { id, patch }) => {
    const c = contact(me, id); if (!c || c.blocked) return;
    if (patch.favorite) for (const x of S.contacts) if (x.owner === me) x.favorite = false;
    if (patch.alias !== undefined) c.alias = clean(patch.alias, 40) ?? c.alias;
    for (const f of ['favorite', 'shareMatches', 'shareScores', 'shareInterests', 'shareRatings', 'notifyMatches']) if (patch[f] !== undefined) c[f] = Boolean(patch[f]);
    afterContacts(me, id);
  },
  remove_contact: (me, { id }) => { S.contacts = S.contacts.filter((c) => !(c.owner === me && c.contact === id) && !(c.owner === id && c.contact === me && !c.blocked)); afterContacts(me, id); },
  block_contact: (me, { id }) => {
    const c = contact(me, id); if (!c) throw new E('invalid_contact');
    Object.assign(c, { blocked: true, favorite: false, shareMatches: false, shareScores: false, shareInterests: false, shareRatings: false });
    S.contacts = S.contacts.filter((x) => !(x.owner === id && x.contact === me && !x.blocked));
    afterContacts(me, id);
  },
  unblock_contact: (me, { id }) => { S.contacts = S.contacts.filter((c) => !(c.owner === me && c.contact === id && c.blocked)); },
  create_invite: (me) => {
    if (!S.users.get(me)?.displayName) throw new E('no_profile');
    const code = Array.from({ length: 12 }, () => ALPH[randomInt(31)]).join('');
    const inv = { id: randomUUID(), inviter: me, code, createdAt: now(), expiresAt: now() + 72 * 3600e3 };
    S.invites.push(inv);
    return { code, expiresAt: inv.expiresAt };
  },
  list_invites: (me) => S.invites.filter((i) => i.inviter === me).reverse().map(({ id, createdAt, expiresAt, usedAt, declinedAt, revokedAt }) => ({ id, createdAt, expiresAt, usedAt, declinedAt, revokedAt })),
  revoke_invite: (me, { id }) => { const i = S.invites.find((x) => x.id === id && x.inviter === me && !x.usedAt); if (i) i.revokedAt = now(); },
  peek_invite: (me, { code }) => {
    const i = findInvite(code);
    if (!i || i.inviter === me || contact(i.inviter, me)?.blocked) throw new E('invalid_invite');
    return { inviterName: S.users.get(i.inviter).displayName, expiresAt: i.expiresAt };
  },
  accept_invite: (me, { code, alias }) => {
    const myName = S.users.get(me)?.displayName; if (!myName) throw new E('no_profile');
    const i = findInvite(code);
    if (!i || i.inviter === me || contact(i.inviter, me)?.blocked) throw new E('invalid_invite');
    if (linked(me, i.inviter)) throw new E('already_linked');
    S.contacts = S.contacts.filter((c) => !(c.owner === me && c.contact === i.inviter) && !(c.owner === i.inviter && c.contact === me));
    const a = clean(alias, 40) ?? S.users.get(i.inviter).displayName;
    const base = { favorite: false, blocked: false, shareMatches: false, shareScores: false, shareInterests: false, shareRatings: false, notifyMatches: true, createdAt: now() };
    S.contacts.push({ owner: me, contact: i.inviter, alias: a, ...base }, { owner: i.inviter, contact: me, alias: myName, ...base });
    i.usedAt = now(); i.usedBy = me;
    return { contact: i.inviter, alias: a };
  },
  decline_invite: (me, { code }) => { const i = findInvite(code); if (!i || i.inviter === me) throw new E('invalid_invite'); i.declinedAt = now(); },
  send: (me, i) => {
    const name = S.users.get(me)?.displayName; if (!name) throw new E('no_profile');
    if (!linked(me, i.recipient)) throw new E('not_a_contact');
    if (S.recs.some((r) => r.sender === me && r.recipient === i.recipient && r.type === i.type && r.tmdbId === i.tmdbId) && !i.resend) throw new E('duplicate');
    if (S.recs.filter((r) => r.sender === me && r.createdAt > now() - 600e3).length >= 30) throw new E('rate_limited');
    const r = { id: randomUUID(), sender: me, recipient: i.recipient, senderName: name, type: i.type, tmdbId: i.tmdbId, title: clean(i.title, 200), year: i.year, posterPath: i.posterPath ?? undefined, comment: clean(i.comment, 280), createdAt: now() };
    S.recs.push(r); S.inbox.set(r.id, {});
    return { id: r.id, createdAt: r.createdAt };
  },
  retract: (me, { id }) => { const r0 = S.recs.find((r) => r.id === id); const n = S.recs.length; S.recs = S.recs.filter((r) => !(r.id === id && r.sender === me && r.createdAt > now() - 600e3)); if (r0 && S.recs.length < n) { prune(r0.sender); prune(r0.recipient); } return S.recs.length < n; },
  list_sent: (me) => S.recs.filter((r) => r.sender === me).map((r) => ({ id: r.id, recipient: r.recipient, key: `${r.type}:${r.tmdbId}`, createdAt: r.createdAt, title: r.title, year: r.year, posterPath: r.posterPath, comment: r.comment })),
  list_inbox: (me) => S.recs.filter((r) => r.recipient === me).sort((a, b) => b.createdAt - a.createdAt).map(view),
  get_inbox_rec: (me, { id }) => { const r = S.recs.find((x) => x.id === id && x.recipient === me); return r ? view(r) : null; },
  inbox_ids: (me) => S.recs.filter((r) => r.recipient === me).map((r) => r.id),
  mark_seen: (me, { ids }) => { for (const id of ids) { const r = S.recs.find((x) => x.id === id && x.recipient === me); if (r && !S.inbox.get(id).seenAt) S.inbox.get(id).seenAt = now(); } },
  set_archived: (me, { id, archived }) => { const r = S.recs.find((x) => x.id === id && x.recipient === me); if (r) S.inbox.get(id).archivedAt = archived ? now() : undefined; },
  sync_want: (me, { items }) => {
    const mine = [...S.want.entries()].filter(([k]) => k.startsWith(`${me}|`));
    const want = new Set(items.map((i) => i.key));
    let removed = 0, added = 0;
    for (const [k] of mine) if (!want.has(k.split('|')[1])) { S.want.delete(k); removed++; }
    for (const i of items) { const k = `${me}|${i.key}`; const prev = S.want.get(k); if (!prev) added++; S.want.set(k, { score: i.score, addedAt: i.addedAt, syncedAt: prev?.syncedAt ?? now() }); }
    if (removed) { prune(me); for (const c of S.contacts) if (c.owner === me) prune(c.contact); }
    return { added, removed };
  },
  clear_want: (me) => { for (const k of [...S.want.keys()]) if (k.startsWith(`${me}|`)) S.want.delete(k); prune(me); for (const c of S.contacts) if (c.owner === me) prune(c.contact); },
  get_matches: (me, { contact: other }) => {
    const a = contact(me, other), b = contact(other, me);
    if (!a || !b || a.blocked || b.blocked || !a.shareMatches || !b.shareMatches) throw new E('matches_not_authorized');
    const out = [];
    for (const [k, v] of S.want) {
      if (!k.startsWith(`${me}|`)) continue;
      const key = k.split('|')[1];
      const t = S.want.get(`${other}|${key}`);
      if (t) out.push({ key, myScore: v.score, theirScore: b.shareScores ? t.score : undefined, myAddedAt: v.addedAt, theirAddedAt: t.addedAt });
    }
    return out;
  },
  // ── v4.3 · intereses compartidos (mismas reglas que 0002_shared_interests.sql)
  get_prefs: (me) => ({ notifyRecs: true, notifyMatches: false, notifyMax: false, ...(S.prefs.get(me) ?? {}) }),
  set_prefs: (me, { p }) => { S.prefs.set(me, { ...(S.prefs.get(me) ?? {}), ...p }); },
  put_shared: (me, { items }) => {
    if (!Array.isArray(items) || items.length > 200) throw new E('invalid_items');
    return items.map((it) => {
      const { key, f, v } = it; let at = Number(it.at);
      const out = (status, events = []) => ({ key, f, status, events });
      if (!/^(movie|tv):\d+$/.test(key) || !['answer', 'rating'].includes(f) || !Number.isFinite(at)) return out('invalid');
      if (f === 'answer' && !['no', 'quiza', 'si', 'mucho'].includes(v)) return out('invalid');
      if (f === 'rating' && v !== null && !(Number(v) >= 1 && Number(v) <= 10)) return out('invalid');
      if (at > now() + 300e3) at = now();
      const what = f === 'answer' ? 'shareInterests' : 'shareRatings';
      if (!S.contacts.some((c) => c.owner === me && !c.blocked && c[what] && linked(me, c.contact) && since(me, c.contact, key) !== undefined)) return out('not_shared');
      const sk = `${me}|${key}`; const cur = S.shared.get(sk) ?? {};
      const atF = f === 'answer' ? 'answerAt' : 'ratingAt';
      if (cur[atF] !== undefined && cur[atF] >= at) return out('stale');
      const prev = { ...cur };
      if (f === 'answer') Object.assign(cur, { answer: v, answerAt: at, answerSrv: now() }); else Object.assign(cur, { rating: v === null ? undefined : Number(v), ratingAt: at, ratingSrv: now() });
      S.shared.set(sk, cur);
      const evs = [];
      for (const c of S.contacts.filter((x) => x.owner === me && !x.blocked)) {
        if (!mutual(me, c.contact, f === 'answer' ? 'shareInterests' : 'shareRatings')) continue;
        const sn = since(me, c.contact, key); if (sn === undefined) continue;
        ping(c.contact, me);
        if (f !== 'answer') continue;
        const t = S.shared.get(`${c.contact}|${key}`); const theirs = t && t.answerSrv >= sn ? t.answer : undefined;
        const nl = level(v, theirs), ol = level(prev.answerSrv >= sn ? prev.answer : undefined, theirs);
        const pos = ['alta', 'muy_alta', 'maxima'];
        if (pos.includes(nl) && (!pos.includes(ol) || (nl === 'maxima' && ol !== 'maxima'))) {
          const kind = nl === 'maxima' ? 'match_max' : 'match';
          if (!S.events.some((e) => e.user === c.contact && e.actor === me && e.key === key && e.kind === kind && e.createdAt > now() - 600e3)) {
            const r = S.recs.filter((x) => `${x.type}:${x.tmdbId}` === key && ((x.sender === me && x.recipient === c.contact) || (x.sender === c.contact && x.recipient === me))).sort((a, b) => b.createdAt - a.createdAt)[0];
            const e = { id: ++S.evSeq, user: c.contact, actor: me, kind, key, title: r?.title, createdAt: now() };
            S.events.push(e); evs.push(e.id);
          }
        }
      }
      return out('ok', evs);
    });
  },
  get_shared: (me) => {
    const out = [];
    for (const c of S.contacts.filter((x) => x.owner === me && !x.blocked && linked(me, x.contact))) {
      const mi = mutual(me, c.contact, 'shareInterests'), mr = mutual(me, c.contact, 'shareRatings');
      if (!mi && !mr) continue;
      for (const [sk, row] of S.shared) {
        if (!sk.startsWith(`${c.contact}|`)) continue;
        const key = sk.split('|')[1]; const sn = since(me, c.contact, key); if (sn === undefined) continue;
        const a = mi && row.answer && row.answerSrv >= sn, r = mr && row.ratingAt !== undefined && row.ratingSrv >= sn;
        if (a || r) out.push({ contact: c.contact, key, answer: a ? row.answer : undefined, answerAt: a ? row.answerAt : undefined, rating: r ? row.rating : undefined, ratingAt: r ? row.ratingAt : undefined });
      }
    }
    return out;
  },
  events_since: (me, { id }) => S.events.filter((e) => e.user === me && e.id > id).map(({ id: i, actor, kind, key, title, createdAt }) => ({ id: i, actor, kind, key, title, createdAt })),
  events_max: () => S.evSeq,
  notify_events: (me, { ids }) => { for (const id of ids ?? []) { const e = S.events.find((x) => x.id === id && x.actor === me); if (e && !e.pushedAt) { e.pushedAt = now(); S.notified.push(`event:${e.kind}:${e.key}`); } } },
  notify: (me, { id }) => { const r = S.recs.find((x) => x.id === id && x.sender === me); if (r && !r.notifiedAt) { r.notifiedAt = now(); S.notified.push(id); } },
};
const level = (x, y) => (x === 'no' || y === 'no' ? 'sin' : !x || !y ? 'pendiente' : x === 'mucho' && y === 'mucho' ? 'maxima'
  : (x === 'mucho' && y === 'si') || (x === 'si' && y === 'mucho') ? 'muy_alta' : x === 'si' && y === 'si' ? 'alta' : x === 'quiza' && y === 'quiza' ? 'posible_baja' : 'posible');
const grants = (o, p, what) => linked(o, p) && Boolean(contact(o, p)?.[what]);
const mutual = (a, b, what) => grants(a, b, what) && grants(b, a, what);
function since(a, b, key) {
  const recs = S.recs.filter((r) => `${r.type}:${r.tmdbId}` === key && ((r.sender === a && r.recipient === b) || (r.sender === b && r.recipient === a))).map((r) => r.createdAt);
  const x = contact(a, b), y = contact(b, a);
  const wa = S.want.get(`${a}|${key}`), wb = S.want.get(`${b}|${key}`);
  if (x?.shareMatches && y?.shareMatches && !x.blocked && !y.blocked && wa && wb) recs.push(Math.max(wa.syncedAt, wb.syncedAt));
  return recs.length ? Math.min(...recs) : undefined;
}
function ping(to, from) { if (!S.events.some((e) => e.user === to && e.actor === from && e.kind === 'shared' && e.createdAt > now() - 2000)) S.events.push({ id: ++S.evSeq, user: to, actor: from, kind: 'shared', createdAt: now() }); }
function prune(owner) {
  for (const [sk, row] of [...S.shared]) {
    if (!sk.startsWith(`${owner}|`)) continue;
    const key = sk.split('|')[1];
    const ok = (what) => S.contacts.some((c) => c.owner === owner && c[what] && !c.blocked && linked(owner, c.contact) && since(owner, c.contact, key) !== undefined);
    if (!ok('shareInterests')) { delete row.answer; delete row.answerAt; delete row.answerSrv; }
    if (!ok('shareRatings')) { delete row.rating; delete row.ratingAt; delete row.ratingSrv; }
    if (row.answerAt === undefined && row.ratingAt === undefined) S.shared.delete(sk);
  }
}
function afterContacts(a, b) {
  prune(a); prune(b);
  if (!mutual(a, b, 'shareInterests')) S.events = S.events.filter((e) => !(e.kind !== 'shared' && ((e.user === a && e.actor === b) || (e.user === b && e.actor === a))));
  if (S.users.has(a) && S.users.has(b)) ping(b, a);
}
function view(r) {
  const st = S.inbox.get(r.id) ?? {};
  return { id: r.id, sender: r.sender, senderName: r.senderName, key: `${r.type}:${r.tmdbId}`, title: r.title, year: r.year, posterPath: r.posterPath, comment: r.comment, createdAt: r.createdAt, seenAt: st.seenAt, archivedAt: st.archivedAt };
}

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj)); };
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/admin/reset') { reset(); return send(200, { ok: true }); }
  if (url.pathname === '/admin/outage') { S.outage = Boolean(body.on); return send(200, { ok: true }); }
  if (url.pathname === '/admin/expire-invites') { for (const i of S.invites) i.expiresAt = now() - 1; return send(200, { ok: true }); }
  if (url.pathname === '/admin/state') return send(200, { users: S.users.size, contacts: S.contacts, recs: S.recs, want: [...S.want.keys()], notified: S.notified, shared: [...S.shared.entries()], events: S.events });
  if (S.outage) { res.destroy(); return; }
  const m = url.pathname.match(/^\/rpc\/(\w+)$/);
  const fn = m && rpc[m[1]];
  if (!fn) return send(404, { error: 'not_found' });
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const me = S.tokens.get(token);
  if (!['signup', 'signin'].includes(m[1]) && (!me || !S.users.has(me))) return send(401, { error: 'not_authenticated' });
  try { send(200, { data: (await fn(me, body)) ?? null }); } catch (e) { send(e.status ?? 500, { error: e.message }); }
}).listen(PORT, () => console.log(`fake social en :${PORT}`));
