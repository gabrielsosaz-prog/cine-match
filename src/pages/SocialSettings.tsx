/**
 * v4.2 · Ajustes sociales: Mi cuenta, Mis contactos, Privacidad y permisos, Notificaciones e invitaciones.
 * Crear una cuenta no sube ni borra nada del dispositivo: sólo habilita contactos y recomendaciones.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { pushNotice } from '../services/notices';
import { disablePush, enablePush, pushStatus, pushSupported, type PushStatus } from '../social/push';
import {
  acceptInvite, backfillCount, blockContact, boundProfile, deleteAccount, getBackend, initSocial, refresh, removeContact, setDisplayName, setPrefs, setSharePermission, signIn, signOut, signUp,
  unblockContact, updateContact, wantDirty,
} from '../social/store';
import { toSocialError, type Contact, type Invite } from '../social/types';
import { useSocial } from '../social/useSocial';
import { Card } from '../ui/components';
import { relTime } from '../ui/format';

const input = 'w-full rounded-lg bg-ink-800 p-2.5 text-sm ring-1 ring-white/10';
const primary = 'rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-ink-950 disabled:opacity-40';
const secondary = 'rounded-xl bg-ink-700 px-3 py-2.5 text-sm font-semibold text-slate-100 ring-1 ring-white/10 disabled:opacity-40';

function Page({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { void initSocial(); }, []);
  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="text-sm text-slate-400">‹ Ajustes</Link>
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
    </div>
  );
}
function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setErr(undefined);
    try { return await fn(); } catch (e) { setErr(toSocialError(e).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, err, run, setErr };
}
const Err = ({ msg }: { msg?: string }) => (msg ? <p role="alert" className="rounded-lg bg-rose-500/10 p-2 text-sm text-rose-200" data-testid="social-error">{msg}</p> : null);
function Unavailable() { return <Card><p className="text-sm text-slate-300">Las funciones sociales no están disponibles en esta instalación. El resto de la app funciona igual.</p></Card>; }

// ───────────────────────────── Mi cuenta ─────────────────────────────
export function AccountPage() {
  const s = useSocial();
  const { profileId } = useApp();
  const profiles = useLiveQuery(() => db.profiles.toArray()) ?? [];
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmDel, setConfirmDel] = useState('');
  const a = useAsync();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  if (!s.available) return <Page title="Mi cuenta"><Unavailable /></Page>;
  if (s.phase !== 'ready') return (
    <Page title="Mi cuenta">
      <Card className="space-y-3">
        <p className="text-sm text-slate-300">La cuenta sirve sólo para vincularte con tus contactos y recomendarse títulos. Tus valoraciones, tu perfil de gustos y tu historial siguen en este dispositivo y no se suben.</p>
        <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-ink-950 p-1">
          {([['signup', 'Crear cuenta'], ['signin', 'Iniciar sesión']] as const).map(([m, l]) => (
            <button key={m} type="button" data-testid={`account-mode-${m}`} onClick={() => { setMode(m); a.setErr(undefined); }} className={`min-h-[40px] rounded-lg text-sm font-semibold ${mode === m ? 'bg-ink-700' : 'text-slate-400'}`}>{l}</button>
          ))}
        </div>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
          if (mode === 'signup') await signUp(email, pass, name); else await signIn(email, pass);
          pushNotice({ kind: 'info', text: mode === 'signup' ? 'Cuenta creada. Tus datos locales no cambiaron.' : 'Sesión iniciada.' }, 4000);
          if (next) nav(next);
        }); }}>
          {mode === 'signup' && <label className="block text-xs text-slate-400">Tu nombre (lo ven tus contactos)<input data-testid="account-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className={`${input} mt-1`} autoComplete="nickname" required /></label>}
          <label className="block text-xs text-slate-400">Correo electrónico<input data-testid="account-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${input} mt-1`} autoComplete="email" required /></label>
          <label className="block text-xs text-slate-400">Contraseña{mode === 'signup' && ' (mínimo 8 caracteres)'}<input data-testid="account-password" type="password" value={pass} minLength={mode === 'signup' ? 8 : undefined} onChange={(e) => setPass(e.target.value)} className={`${input} mt-1`} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required /></label>
          <Err msg={a.err} />
          <button type="submit" data-testid="account-submit" disabled={a.busy} className={`${primary} w-full`}>{a.busy ? 'Un momento…' : mode === 'signup' ? 'Crear cuenta' : 'Iniciar sesión'}</button>
        </form>
        <p className="text-[11px] text-slate-500">Las contraseñas las guarda el servicio de autenticación (Supabase) de forma segura; la app nunca las almacena. No hay perfiles públicos ni buscador de usuarios.</p>
      </Card>
    </Page>
  );
  const bound = s.user ? boundProfile(s.user.id) : undefined;
  return (
    <Page title="Mi cuenta">
      <Card className="space-y-2" data-testid="account-card">
        <p className="text-sm text-slate-300">Sesión iniciada como <b data-testid="account-display">{s.user?.displayName ?? '—'}</b></p>
        <p className="text-xs text-slate-400" data-testid="account-email-shown">{s.user?.email}</p>
        <p className="text-xs text-slate-400">Perfil local asociado: <b>{profiles.find((p) => p.id === bound)?.name ?? '—'}</b>{bound && bound !== profileId && <span className="text-amber-300"> (el perfil activo es otro)</span>}</p>
        <div className="flex gap-2">
          <input value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} placeholder="Cambiar nombre" className={`${input} min-w-0 flex-1`} />
          <button type="button" disabled={!newName.trim() || a.busy} className={secondary} onClick={() => void a.run(async () => { await setDisplayName(newName); setNewName(''); })}>Guardar</button>
        </div>
      </Card>
      <Err msg={a.err} />
      <Card className="space-y-2">
        <h2 className="font-semibold">Contraseña</h2>
        <div className="flex gap-2">
          <input type="password" value={newPass} minLength={8} onChange={(e) => setNewPass(e.target.value)} placeholder="Nueva contraseña" autoComplete="new-password" className={`${input} min-w-0 flex-1`} />
          <button type="button" disabled={newPass.length < 8 || a.busy} className={secondary} onClick={() => void a.run(async () => { await (await getBackend()).changePassword(newPass); setNewPass(''); pushNotice({ kind: 'info', text: 'Contraseña actualizada.' }, 4000); })}>Cambiar</button>
        </div>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Cerrar sesión</h2>
        <p className="text-sm text-slate-300">Tus datos del dispositivo quedan intactos. Mientras no inicies sesión no recibís recomendaciones nuevas en este teléfono.</p>
        <button type="button" data-testid="account-signout" disabled={a.busy} className={secondary} onClick={() => void a.run(signOut)}>Cerrar sesión</button>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold text-rose-200">Eliminar cuenta</h2>
        <p className="text-sm text-slate-300">Borra del servidor tu cuenta, tus contactos, invitaciones, recomendaciones enviadas y recibidas, la lista de Para ver juntos y las suscripciones a notificaciones. No borra nada de este dispositivo. Escribí <b>ELIMINAR</b>.</p>
        <div className="flex gap-2">
          <input value={confirmDel} onChange={(e) => setConfirmDel(e.target.value)} aria-label="Confirmación" className={`${input} min-w-0 flex-1`} />
          <button type="button" data-testid="account-delete" disabled={confirmDel.trim() !== 'ELIMINAR' || a.busy} className="rounded-xl bg-rose-500/20 px-3 text-sm text-rose-100 disabled:opacity-40"
            onClick={() => void a.run(async () => { await deleteAccount(); pushNotice({ kind: 'info', text: 'Cuenta y datos sociales eliminados.' }, 5000); })}>Eliminar</button>
        </div>
      </Card>
    </Page>
  );
}

// ───────────────────────────── Mis contactos ─────────────────────────────
export const inviteLink = (code: string) => `${location.origin}${location.pathname}#/invitacion?c=${code}`;
const fmtCode = (c: string) => c.replace(/(.{4})(?=.)/g, '$1-');

export function ContactsPage() {
  const s = useSocial();
  const a = useAsync();
  const [invite, setInvite] = useState<{ code: string; expiresAt: number }>();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [code, setCode] = useState('');
  const nav = useNavigate();
  const loadInvites = () => getBackend().then((b) => b.listInvites()).then(setInvites).catch(() => undefined);
  useEffect(() => { if (s.phase === 'ready') { void refresh(true); void loadInvites(); } }, [s.phase]);
  if (!s.available) return <Page title="Mis contactos"><Unavailable /></Page>;
  if (s.phase !== 'ready') return <Page title="Mis contactos"><Card><p className="text-sm text-slate-300">Primero <Link to="/ajustes/cuenta?next=/ajustes/contactos" className="text-accent underline">creá tu cuenta o iniciá sesión</Link>.</p></Card></Page>;
  const linked = s.contacts.filter((c) => !c.blocked);
  const blocked = s.contacts.filter((c) => c.blocked);
  const fav = linked.find((c) => c.favorite);
  const shareInvite = async (c: string) => {
    const url = inviteLink(c);
    const text = `Vinculémonos en Cine Match para recomendarnos películas y series. Código: ${fmtCode(c)}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Cine Match', text, url }); return; }
    } catch { /* cancelado */ }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); pushNotice({ kind: 'info', text: 'Invitación copiada.' }, 3000); } catch { /* sin portapapeles */ }
  };
  return (
    <Page title="Mis contactos">
      <Card className="space-y-2" data-testid="invite-card">
        <h2 className="font-semibold">Invitar a alguien</h2>
        <p className="text-sm text-slate-300">Generá un código y compartilo por WhatsApp o como quieras. Vale para una sola persona y vence en 72 horas. No hay buscador de usuarios: sólo se vinculan quienes tienen el código.</p>
        {invite ? (
          <div className="space-y-2 rounded-xl bg-ink-950 p-3 text-center">
            <p className="font-mono text-2xl font-bold tracking-wider text-accent" data-testid="invite-code">{fmtCode(invite.code)}</p>
            <p className="text-[11px] text-slate-400">Vence {relTime(invite.expiresAt)}</p>
            <button type="button" data-testid="invite-share" onClick={() => void shareInvite(invite.code)} className={`${primary} w-full`}>Compartir invitación</button>
          </div>
        ) : (
          <button type="button" data-testid="invite-create" disabled={a.busy} className={`${primary} w-full`} onClick={() => void a.run(async () => { const i = await (await getBackend()).createInvite(); setInvite(i); void loadInvites(); })}>Generar invitación</button>
        )}
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Tengo un código</h2>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) nav(`/invitacion?c=${encodeURIComponent(code.trim())}`); }}>
          <input data-testid="invite-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" className={`${input} min-w-0 flex-1 font-mono`} />
          <button type="submit" data-testid="invite-open" disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 12} className={secondary}>Ver</button>
        </form>
      </Card>
      <Err msg={a.err} />
      <Card className="space-y-3" data-testid="contacts-card">
        <h2 className="font-semibold">Contactos ({linked.length})</h2>
        {!linked.length && <p className="text-sm text-slate-400">Todavía no tenés contactos vinculados.</p>}
        {linked.length > 0 && <p className="text-xs text-slate-400">{fav ? <>Destinatario favorito: <b className="text-amber-200">{fav.alias}</b>. Un toque en «Compartir» le envía el título.</> : 'Elegí un destinatario favorito (★) para compartir con un solo toque.'}</p>}
        {linked.length === 1 && !fav && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-100" data-testid="fav-offer">
            <span className="flex-1">¿Usar a {linked[0].alias} como destinatario favorito?</span>
            <button type="button" className="font-semibold underline" data-testid="fav-offer-yes" onClick={() => void a.run(() => updateContact(linked[0].id, { favorite: true }))}>Sí</button>
          </div>
        )}
        <ul className="space-y-2">{linked.map((c) => <ContactRow key={c.id} c={c} run={a.run} />)}</ul>
      </Card>
      {invites.length > 0 && (
        <Card className="space-y-1">
          <h2 className="font-semibold">Invitaciones generadas</h2>
          <ul className="space-y-1 text-xs text-slate-300">
            {invites.slice(0, 8).map((i) => {
              const st = i.usedAt ? 'aceptada' : i.declinedAt ? 'rechazada' : i.revokedAt ? 'anulada' : i.expiresAt < Date.now() ? 'vencida' : 'vigente';
              return (
                <li key={i.id} className="flex items-center gap-2" data-testid="invite-row" data-state={st}>
                  <span className="flex-1">{relTime(i.createdAt)} · {st}</span>
                  {st === 'vigente' && <button type="button" className="text-rose-300 underline" onClick={() => void a.run(async () => { await (await getBackend()).revokeInvite(i.id); if (invite) setInvite(undefined); await loadInvites(); })}>Anular</button>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {blocked.length > 0 && (
        <Card className="space-y-2">
          <h2 className="font-semibold">Bloqueados</h2>
          <ul className="space-y-1">{blocked.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm" data-testid="blocked-row"><span className="flex-1">{c.alias}</span>
              <button type="button" className="text-xs underline" onClick={() => void a.run(() => unblockContact(c.id))}>Desbloquear</button></li>
          ))}</ul>
          <p className="text-[11px] text-slate-500">Desbloquear no vuelve a vincular: hace falta una invitación nueva.</p>
        </Card>
      )}
      <p className="text-center text-xs"><Link to="/ajustes/privacidad" className="text-accent underline">Privacidad y permisos por contacto</Link></p>
    </Page>
  );
}

function ContactRow({ c, run }: { c: Contact; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [edit, setEdit] = useState(false);
  const [alias, setAlias] = useState(c.alias);
  const [confirm, setConfirm] = useState<'remove' | 'block'>();
  return (
    <li className="space-y-2 rounded-xl bg-ink-800 p-2.5 ring-1 ring-white/10" data-testid="contact-row" data-contact={c.alias}>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={c.favorite ? `${c.alias} es tu favorito` : `Elegir a ${c.alias} como favorito`} aria-pressed={c.favorite} data-testid="contact-fav"
          onClick={() => void run(() => updateContact(c.id, { favorite: !c.favorite }))} className={`grid h-10 w-10 place-items-center rounded-lg text-xl ${c.favorite ? 'text-amber-300' : 'text-slate-500'}`}>{c.favorite ? '★' : '☆'}</button>
        {edit ? (
          <form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); void run(async () => { await updateContact(c.id, { alias }); setEdit(false); }); }}>
            <input value={alias} maxLength={40} onChange={(e) => setAlias(e.target.value)} className={`${input} min-w-0 flex-1 p-2`} aria-label="Alias" data-testid="contact-alias-input" />
            <button type="submit" className="text-sm font-semibold text-accent" data-testid="contact-alias-save">OK</button>
          </form>
        ) : (
          <button type="button" className="min-w-0 flex-1 truncate text-left font-semibold" onClick={() => setEdit(true)} data-testid="contact-alias">{c.alias} <span className="text-[11px] font-normal text-slate-500">✎</span></button>
        )}
      </div>
      {!c.linked && <p className="text-[11px] text-amber-300">Vínculo inactivo.</p>}
      <p className="pl-1 text-[11px] text-slate-500" data-testid="contact-perms">Compartís: {[c.shareInterests && 'intereses', c.shareMatches && 'Quiero ver', c.shareScores && 'puntuaciones', c.shareRatings && 'valoraciones'].filter(Boolean).join(', ') || 'nada'} · <Link to="/ajustes/privacidad" className="text-accent underline">Permisos</Link></p>
      {confirm ? (
        <div className="flex items-center gap-2 rounded-lg bg-rose-500/10 p-2 text-xs text-rose-100">
          <span className="flex-1">{confirm === 'remove' ? `¿Eliminar a ${c.alias}? Se corta el vínculo para los dos.` : `¿Bloquear a ${c.alias}? No podrá enviarte nada ni volver a vincularse con sus invitaciones.`}</span>
          <button type="button" data-testid="contact-confirm" className="font-semibold underline" onClick={() => void run(async () => { if (confirm === 'remove') await removeContact(c.id); else await blockContact(c.id); setConfirm(undefined); })}>Sí</button>
          <button type="button" className="underline" onClick={() => setConfirm(undefined)}>No</button>
        </div>
      ) : (
        <div className="flex gap-3 pl-1 text-xs">
          <button type="button" data-testid="contact-remove" className="text-slate-400 underline" onClick={() => setConfirm('remove')}>Eliminar</button>
          <button type="button" data-testid="contact-block" className="text-rose-300 underline" onClick={() => setConfirm('block')}>Bloquear</button>
        </div>
      )}
    </li>
  );
}

// ───────────────────────────── Invitación (enlace o código) ─────────────────────────────
export function InvitePage() {
  const s = useSocial();
  const [params] = useSearchParams();
  const code = (params.get('c') ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const [peek, setPeek] = useState<{ inviterName: string; expiresAt: number }>();
  const [alias, setAlias] = useState('');
  const [done, setDone] = useState<'accepted' | 'declined'>();
  const a = useAsync();
  const nav = useNavigate();
  useEffect(() => { if (s.phase === 'ready' && code && !peek && !done) void a.run(async () => { const p = await (await getBackend()).peekInvite(code); setPeek(p); setAlias(p.inviterName); }); }, [s.phase, code]);
  if (!s.available) return <Page title="Invitación"><Unavailable /></Page>;
  if (s.phase === 'idle' || s.phase === 'loading') return <Page title="Invitación"><p className="text-sm text-slate-400">Cargando…</p></Page>;
  if (s.phase !== 'ready') return (
    <Page title="Invitación">
      <Card className="space-y-2"><p className="text-sm text-slate-300">Te invitaron a vincularte en Cine Match para recomendarse películas y series. Para aceptar, creá tu cuenta o iniciá sesión (tus datos del teléfono no se suben).</p>
        <Link to={`/ajustes/cuenta?next=${encodeURIComponent(`/invitacion?c=${code}`)}`} data-testid="invite-login" className={`${primary} inline-block`}>Crear cuenta o iniciar sesión</Link></Card>
    </Page>
  );
  return (
    <Page title="Invitación">
      <Err msg={a.err} />
      {done === 'accepted' ? (
        <Card className="space-y-2" data-testid="invite-accepted"><p className="text-sm text-emerald-200">¡Listo! Ya están vinculados.</p>
          <button type="button" className={primary} onClick={() => nav('/ajustes/contactos')}>Ir a Mis contactos</button></Card>
      ) : done === 'declined' ? (
        <Card><p className="text-sm text-slate-300" data-testid="invite-declined">Rechazaste la invitación.</p></Card>
      ) : peek ? (
        <Card className="space-y-3" data-testid="invite-peek">
          <p className="text-base"><b data-testid="invite-from">{peek.inviterName}</b> te invita a vincularse en Cine Match.</p>
          <p className="text-xs text-slate-400">Podrán recomendarse títulos. No comparten valoraciones, historial ni listas; Para ver juntos requiere una autorización aparte de cada uno.</p>
          <label className="block text-xs text-slate-400">Cómo querés verlo/a en tu app (alias)<input value={alias} maxLength={40} onChange={(e) => setAlias(e.target.value)} className={`${input} mt-1`} data-testid="invite-alias" /></label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" data-testid="invite-decline" disabled={a.busy} className={secondary} onClick={() => void a.run(async () => { await (await getBackend()).declineInvite(code); setDone('declined'); })}>Rechazar</button>
            <button type="button" data-testid="invite-accept" disabled={a.busy} className={primary} onClick={() => void a.run(async () => {
              await acceptInvite(code, alias);
              setDone('accepted');
            })}>Aceptar</button>
          </div>
        </Card>
      ) : !a.err && <p className="text-sm text-slate-400">Verificando invitación…</p>}
    </Page>
  );
}

// ───────────────────────────── Privacidad y permisos ─────────────────────────────
export function PrivacyPage() {
  const s = useSocial();
  const a = useAsync();
  if (!s.available) return <Page title="Privacidad y permisos"><Unavailable /></Page>;
  const linked = s.contacts.filter((c) => !c.blocked);
  const anyOn = linked.some((c) => c.shareMatches || c.shareInterests || c.shareRatings || c.shareScores);
  return (
    <Page title="Privacidad y permisos">
      <Card className="space-y-2 text-sm text-slate-300">
        <h2 className="font-semibold text-slate-100">Qué sale de este dispositivo</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Tu nombre visible, correo (sólo para iniciar sesión) y tus contactos.</li>
          <li>Las recomendaciones que enviás a propósito (título, año, póster y tu comentario).</li>
          <li>Sólo si autorizás Para ver juntos: tu lista «Quiero ver» (y, si lo elegís, tu puntuación «Para vos» de esos títulos). Tu contacto ve únicamente los títulos en común.</li>
          <li>Sólo si autorizás «Compartir intereses»: tu respuesta (No, Podría, Me interesa o Muchas ganas) de los títulos que se recomiendan entre ustedes o que ambos tienen en Quiero ver.</li>
          <li>Sólo si autorizás «Compartir valoraciones»: tu nota real después de verlo, de esos mismos títulos.</li>
        </ul>
        <h2 className="pt-1 font-semibold text-slate-100">Qué nunca se comparte</h2>
        <p>Tu historial, perfil de gustos, aspectos, comentarios, listas completas, descartes, motor elegido, intereses de otros títulos ni nada sobre tus otros contactos. Lo que recibís nunca entrena tu perfil.</p>
      </Card>
      <Err msg={a.err} />
      {s.phase === 'ready' && (
        <Card className="space-y-3" data-testid="privacy-card">
          <h2 className="font-semibold">Permisos por contacto</h2>
          <p className="text-[11px] text-slate-500">Todo empieza desactivado. Para ver la información del otro hace falta que los dos lo activen. Podés revocar cuando quieras: se borra del servidor lo que ya no corresponde.</p>
          {!linked.length && <p className="text-sm text-slate-400">Sin contactos.</p>}
          {linked.map((c) => <PermissionRow key={c.id} c={c} run={a.run} busy={a.busy} />)}
          {anyOn && (
            <button type="button" data-testid="privacy-revoke-all" className={secondary} onClick={() => void a.run(async () => {
              for (const c of linked.filter((x) => x.shareMatches || x.shareInterests || x.shareRatings || x.shareScores)) await updateContact(c.id, { shareMatches: false, shareScores: false, shareInterests: false, shareRatings: false });
              wantDirty(0);
            })}>Revocar todos los permisos</button>
          )}
          <p className="text-[11px] text-slate-500">Al revocar, tus datos compartidos con esa persona se borran del servidor y desaparecen también de su app.</p>
        </Card>
      )}
    </Page>
  );
}

function PermissionRow({ c, run, busy }: { c: Contact; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; busy: boolean }) {
  const [ask, setAsk] = useState<{ what: 'interests' | 'ratings'; n: number }>();
  const start = async (what: 'interests' | 'ratings') => setAsk({ what, n: await backfillCount(c.id, what) });
  const their = (on: boolean, what: string) => <span className={on ? 'text-emerald-300' : 'text-slate-500'}>{c.alias} {on ? 'lo activó' : `no activó ${what}`}</span>;
  return (
    <div className="space-y-2 rounded-xl bg-ink-800 p-2.5 ring-1 ring-white/10" data-testid="privacy-row" data-contact={c.alias}>
      <p className="font-semibold">{c.alias}</p>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="privacy-interests" checked={c.shareInterests} disabled={busy}
          onChange={(e) => { if (e.target.checked) void start('interests'); else void run(() => setSharePermission(c.id, 'interests', false)); }} /> Compartir intereses en títulos compartidos</label>
        <p className="pl-6 text-[11px]">{their(c.theirShareInterests, 'compartir intereses')}</p>
      </div>
      {ask && (
        <div className="space-y-2 rounded-lg bg-sky-500/10 p-2.5 text-xs text-sky-100 ring-1 ring-sky-400/20" data-testid="privacy-consent" data-what={ask.what}>
          {ask.what === 'interests'
            ? <p>{c.alias} podrá ver tus respuestas <b>No</b>, <b>Podría</b>, <b>Me interesa</b> y <b>Muchas ganas</b> de los títulos que se recomienden entre ustedes (y de los que ambos tengan en Quiero ver con Para ver juntos). Sólo si {c.alias} también lo activa; ninguno ve otros títulos.</p>
            : <p>{c.alias} podrá ver tu nota real (1-10) después de ver los títulos que se recomienden entre ustedes, en un bloque aparte del interés y de la estimación. No se usa para entrenar el perfil de nadie.</p>}
          {ask.n > 0 && <p data-testid="privacy-backfill-count">Ya tenés {ask.n} {ask.what === 'interests' ? (ask.n === 1 ? 'respuesta registrada' : 'respuestas registradas') : (ask.n === 1 ? 'valoración' : 'valoraciones')} en títulos que intercambiaron. ¿Las compartimos también? Si no, sólo se comparten las que des a partir de ahora (o al tocar de nuevo tu respuesta).</p>}
          <div className="flex flex-wrap gap-2">
            {ask.n > 0 && <button type="button" data-testid="privacy-consent-all" className={primary} onClick={() => void run(async () => { await setSharePermission(c.id, ask.what, true, true); setAsk(undefined); })}>Activar y compartir {ask.n === 1 ? 'esa' : `las ${ask.n}`}</button>}
            <button type="button" data-testid="privacy-consent-new" className={ask.n > 0 ? secondary : primary} onClick={() => void run(async () => { await setSharePermission(c.id, ask.what, true, false); setAsk(undefined); })}>{ask.n > 0 ? 'Sólo las nuevas' : 'Activar'}</button>
            <button type="button" className="text-slate-300 underline" onClick={() => setAsk(undefined)}>Cancelar</button>
          </div>
        </div>
      )}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="privacy-matches" checked={c.shareMatches} disabled={busy} onChange={(e) => void run(async () => { await updateContact(c.id, { shareMatches: e.target.checked, ...(e.target.checked ? {} : { shareScores: false }) }); wantDirty(0); })} /> Detectar coincidencias de Quiero ver</label>
        <label className="flex items-center gap-2 pl-6 text-sm"><input type="checkbox" data-testid="privacy-scores" disabled={!c.shareMatches || busy} checked={c.shareScores} onChange={(e) => void run(async () => { await updateContact(c.id, { shareScores: e.target.checked }); wantDirty(0); })} /> Compartir mis puntuaciones estimadas en esas coincidencias</label>
        <p className="pl-6 text-[11px]">{their(c.theirShareMatches, 'Para ver juntos')}{c.theirShareMatches ? (c.theirShareScores ? ' y comparte su puntuación' : ' sin compartir su puntuación') : ''}.</p>
      </div>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="privacy-ratings" checked={c.shareRatings} disabled={busy}
          onChange={(e) => { if (e.target.checked) void start('ratings'); else void run(() => setSharePermission(c.id, 'ratings', false)); }} /> Compartir valoraciones después de verlos</label>
        <p className="pl-6 text-[11px]">{their(c.theirShareRatings, 'compartir valoraciones')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="privacy-notify" checked={c.notifyMatches} disabled={busy} onChange={(e) => void run(() => updateContact(c.id, { notifyMatches: e.target.checked }))} /> Recibir avisos de coincidencias con {c.alias}</label>
    </div>
  );
}

// ───────────────────────────── Notificaciones ─────────────────────────────
export function NotificationsPage() {
  const s = useSocial();
  const [st, setSt] = useState<PushStatus>();
  const a = useAsync();
  useEffect(() => { pushStatus().then(setSt).catch(() => setSt('unsupported')); }, []);
  return (
    <Page title="Notificaciones">
      <Card className="space-y-2 text-sm text-slate-300" data-testid="push-card" data-state={st ?? 'loading'}>
        <p>Te avisamos <b>sólo</b> de lo que elijas abajo: recomendaciones que te envían («Ana te recomendó una película») y, si las activás, coincidencias nuevas. Al tocar el aviso se abre ese título. Nunca hay avisos negativos (si alguien marca «No»), ni publicidad ni recordatorios.</p>
        <p className="text-xs text-slate-400">Dentro de la app siempre ves el contador de «Recibidas» y un aviso al llegar algo nuevo, aunque no actives las notificaciones.</p>
        {!s.available || s.phase !== 'ready' ? <p className="text-xs text-amber-200">Necesitás <Link to="/ajustes/cuenta" className="underline">iniciar sesión</Link>.</p>
          : st === 'unsupported' ? <p className="text-xs text-amber-200" data-testid="push-unsupported">Este navegador no admite notificaciones push{pushSupported() ? '' : ' (o la app no está instalada)'}. En Android, instalá Cine Match desde Chrome («Agregar a la pantalla principal»).</p>
          : st === 'denied' ? <p className="text-xs text-amber-200">Bloqueaste las notificaciones para este sitio. Podés habilitarlas desde la configuración del navegador.</p>
          : st === 'on' ? <button type="button" data-testid="push-disable" disabled={a.busy} className={secondary} onClick={() => void a.run(async () => { await disablePush(); setSt('off'); })}>Desactivar notificaciones</button>
          : st === 'off' ? <button type="button" data-testid="push-enable" disabled={a.busy} className={primary} onClick={() => void a.run(async () => setSt(await enablePush()))}>Activar notificaciones</button>
          : <p className="text-xs text-slate-400">Verificando…</p>}
        <Err msg={a.err} />
      </Card>
      {s.phase === 'ready' && (
        <Card className="space-y-2 text-sm" data-testid="notify-prefs">
          <h2 className="font-semibold">Qué avisos querés</h2>
          {([['notifyRecs', 'Recomendaciones recibidas', 'Cuando un contacto te envía un título.'],
            ['notifyMatches', 'Nuevas coincidencias', '«Nueva coincidencia: a Ana también le interesa…» (Me interesa o más, de ambos).'],
            ['notifyMax', 'Coincidencias máximas', '«Ambos tienen muchas ganas de ver…».']] as const).map(([k, l, d]) => (
            <label key={k} className="flex items-start gap-2"><input type="checkbox" className="mt-1" data-testid={`pref-${k}`} checked={s.prefs[k]} disabled={a.busy} onChange={(e) => void a.run(() => setPrefs({ [k]: e.target.checked }))} />
              <span><span className="font-medium text-slate-100">{l}</span><span className="block text-[11px] text-slate-400">{d}</span></span></label>
          ))}
          <p className="text-[11px] text-slate-500">Se aplican a los avisos dentro de la app y a las notificaciones push. Por contacto, en <Link to="/ajustes/privacidad" className="text-accent underline">Privacidad y permisos</Link>.</p>
        </Card>
      )}
    </Page>
  );
}
