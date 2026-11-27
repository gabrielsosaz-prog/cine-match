/**
 * v4.2 · Acción «Compartir» (tarjeta común, ficha y resultados de búsqueda).
 *
 * Con destinatario favorito: un toque envía y muestra «Recomendación enviada a [alias]» con «Deshacer».
 * Sin favorito: abre un selector compacto de contactos. El botón ▾ (o mantener presionado) abre las opciones: otro
 * destinatario, comentario opcional, a quién se envió y cambiar el favorito. Un título ya enviado a esa persona no se
 * reenvía sin una acción explícita. Sin conexión, el envío queda «pendiente» (nunca se informa como enviado).
 * No toca valoraciones, listas ni el perfil: compartir no es una señal para el recomendador.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { pushNotice } from '../services/notices';
import { activeContacts, discardOutbox, flushOutbox, initSocial, scheduleNotify, share, undoShare, updateContact, UNDO_MS, type ShareResult } from '../social/store';
import { useSocial } from '../social/useSocial';
import { parseKey, type TitleKey } from '../types';
import { relTime } from './format';

export interface ShareTarget { k: TitleKey; title: string; year?: number; posterPath?: string | null }

const shareIcon = (cls = 'h-[18px] w-[18px]') => (
  <svg viewBox="0 0 24 24" className={`${cls} shrink-0`} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></svg>
);
const SHARE_BG = '#0F2742';
const SHARE_FG = '#7DD3FC';

function announce(r: ShareResult, onUndo?: () => void) {
  if (r.status === 'sent') {
    const withInterest = activeContacts().some((c) => c.alias === r.to && c.shareInterests);
    const nid = pushNotice({ kind: 'info', text: `Recomendación enviada a ${r.to}${withInterest ? ' (con tu interés, si lo marcaste)' : ''}`, action: { label: 'Deshacer', run: () => { void (async () => {
      try { const ok = await undoShare(r.id); pushNotice({ kind: 'info', text: ok ? `Envío a ${r.to} deshecho.` : 'Ya no se puede deshacer este envío.' }, 4000); onUndo?.(); }
      catch (e) { pushNotice({ kind: 'error', text: `No se pudo deshacer: ${(e as Error).message}` }); }
    })(); } } }, UNDO_MS);
    scheduleNotify(r.id);
    return nid;
  }
  if (r.status === 'pending') return pushNotice({ kind: 'info', text: `Sin conexión: la recomendación a ${r.to} quedó pendiente y se enviará al reconectar.` }, 7000);
  return pushNotice({ kind: 'error', text: `No se envió a ${r.to}: ${r.error.message}` });
}

export async function sendTo(t: ShareTarget, recipient: string, opts: { comment?: string; resend?: boolean } = {}) {
  const { type, id } = parseKey(t.k);
  const r = await share({ recipient, type, tmdbId: id, title: t.title, year: t.year, posterPath: t.posterPath ?? undefined, comment: opts.comment, resend: opts.resend });
  announce(r);
  return r;
}

/** Estado de la acción para un título: enviado al favorito, pendiente o libre. */
function useShareState(k: TitleKey) {
  const s = useSocial();
  const fav = s.contacts.find((c) => c.favorite && c.linked && !c.blocked);
  const sent = s.sent.filter((x) => x.key === k);
  const pending = s.outbox.filter((o) => `${o.input.type}:${o.input.tmdbId}` === k);
  return { s, fav, sent, pending, sentToFav: Boolean(fav && sent.some((x) => x.recipient === fav.id)), pendingFav: Boolean(fav && pending.some((p) => p.input.recipient === fav.id && p.state === 'pending')) };
}

export default function ShareAction({ target, variant = 'grid' }: { target: ShareTarget; variant?: 'grid' | 'full' | 'icon' }) {
  const { s, fav, sentToFav, pendingFav } = useShareState(target.k);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout>>();
  const longPressed = useRef(false);
  useEffect(() => { void initSocial(); }, []);

  const tap = async () => {
    if (longPressed.current) { longPressed.current = false; return; }
    // Un toque: envío inmediato al favorito, salvo que ya se le haya enviado (entonces se muestra el estado)
    if (s.phase === 'ready' && fav && !sentToFav && !pendingFav) {
      setBusy(true);
      try { await sendTo(target, fav.id); } finally { setBusy(false); }
      return;
    }
    setOpen(true);
  };
  const startPress = () => { longPressed.current = false; press.current = setTimeout(() => { longPressed.current = true; setOpen(true); }, 550); };
  const endPress = () => { if (press.current) clearTimeout(press.current); };

  const label = busy ? 'Enviando…' : pendingFav ? 'Pendiente' : sentToFav ? 'Enviada' : 'Compartir';
  const aria = sentToFav ? `Ya recomendada a ${fav!.alias}. Ver opciones` : fav ? `Compartir con ${fav.alias}` : 'Compartir';
  const sheet = open && createPortal(<ShareSheet target={target} onClose={() => setOpen(false)} />, document.body);

  if (variant === 'icon') return (
    <>
      <button type="button" data-testid="share-icon" aria-label={aria} onClick={tap} onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ring-sky-400/20" style={{ background: SHARE_BG, color: SHARE_FG }}>
        {sentToFav ? <span className="text-base font-bold">✓</span> : shareIcon()}
      </button>
      {sheet}
    </>
  );
  if (variant === 'full') return (
    <>
      <div className="flex overflow-hidden rounded-xl ring-1 ring-sky-400/25" style={{ background: SHARE_BG, color: SHARE_FG }}>
        <button type="button" data-testid="share-main" data-state={sentToFav ? 'sent' : pendingFav ? 'pending' : 'idle'} aria-label={aria} onClick={tap} disabled={busy}
          className="flex min-h-[44px] flex-1 items-center gap-2 px-3 text-sm font-semibold">{shareIcon()}{sentToFav ? `Enviada a ${fav!.alias}` : fav ? `${label} con ${fav.alias}` : label}</button>
        <button type="button" data-testid="share-menu" aria-label="Más opciones para compartir" onClick={() => setOpen(true)} className="min-h-[44px] border-l border-sky-300/15 px-3 text-sm">▾</button>
      </div>
      {sheet}
    </>
  );
  return (
    <>
      <div className="relative flex min-h-[52px] overflow-hidden rounded-xl ring-1 ring-sky-400/25" style={{ background: SHARE_BG, color: SHARE_FG }}>
        <button type="button" data-testid="share-main" data-state={sentToFav ? 'sent' : pendingFav ? 'pending' : 'idle'} aria-label={aria} onClick={tap} disabled={busy}
          onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onContextMenu={(e) => e.preventDefault()}
          className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pl-1 text-[12px] font-semibold leading-tight">
          {sentToFav ? <span className="text-[15px] font-bold leading-none">✓</span> : shareIcon()}
          <span className="max-w-full truncate">{label}</span>
        </button>
        <button type="button" data-testid="share-menu" aria-label="Más opciones para compartir" onClick={() => setOpen(true)}
          className="w-[26px] shrink-0 border-l border-sky-300/15 text-[11px]">▾</button>
      </div>
      {sheet}
    </>
  );
}

/** Selector compacto de contactos y opciones de envío. */
export function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const { s, fav, sent, pending } = useShareState(target.k);
  const contacts = activeContacts();
  const [to, setTo] = useState<string | undefined>(fav?.id ?? (contacts.length === 1 ? contacts[0].id : undefined));
  const [comment, setComment] = useState('');
  const [makeFav, setMakeFav] = useState(!fav && contacts.length === 1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  useEffect(() => { if (!to && (fav || contacts.length === 1)) setTo(fav?.id ?? contacts[0].id); }, [fav?.id, contacts.length]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  const chosen = contacts.find((c) => c.id === to);
  const already = chosen ? sent.filter((x) => x.recipient === chosen.id) : [];
  const send = async (resend: boolean) => {
    if (!chosen) return;
    setBusy(true); setMsg(undefined);
    try {
      if (makeFav && !chosen.favorite) await updateContact(chosen.id, { favorite: true }).catch(() => undefined);
      const r = await sendTo(target, chosen.id, { comment, resend });
      if (r.status !== 'failed') onClose(); else setMsg(r.error.message);
    } finally { setBusy(false); }
  };
  const name = (id: string) => s.contacts.find((c) => c.id === id)?.alias ?? 'contacto anterior';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose} data-testid="share-sheet">
      <div role="dialog" aria-modal="true" aria-label={`Compartir ${target.title}`} onClick={(e) => e.stopPropagation()}
        className="safe-bottom max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-ink-900 p-4 ring-1 ring-white/10">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h2 className="text-base font-bold leading-tight">Compartir «{target.title}»</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="-mr-1 -mt-1 grid h-10 w-10 place-items-center text-slate-400">✕</button>
        </div>
        {!s.available ? <p className="text-sm text-slate-300">Las recomendaciones entre personas no están disponibles en esta instalación.</p>
          : s.phase !== 'ready' ? (
            <div className="space-y-2 text-sm text-slate-300" data-testid="share-need-account">
              <p>Para recomendar títulos a otra persona necesitás una cuenta. Tus valoraciones y tu perfil siguen sólo en este dispositivo.</p>
              <Link to="/ajustes/cuenta" onClick={onClose} className="inline-block rounded-lg bg-accent px-3 py-2 font-semibold text-ink-950">Crear cuenta o iniciar sesión</Link>
            </div>
          ) : !contacts.length ? (
            <div className="space-y-2 text-sm text-slate-300" data-testid="share-no-contacts">
              <p>Todavía no tenés contactos vinculados.</p>
              <Link to="/ajustes/contactos" onClick={onClose} className="inline-block rounded-lg bg-accent px-3 py-2 font-semibold text-ink-950">Invitar a alguien</Link>
            </div>
          ) : (
            <div className="space-y-3">
              {sent.length > 0 && (
                <p className="rounded-lg bg-sky-500/10 p-2 text-xs text-sky-200" data-testid="share-history">
                  Ya la recomendaste a: {[...new Map(sent.map((x) => [x.recipient, x])).values()].map((x) => `${name(x.recipient)} (${relTime(x.createdAt)})`).join(', ')}.
                </p>
              )}
              {pending.map((p) => (
                <div key={p.localId} className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" data-testid="share-pending">
                  <span className="flex-1">{p.state === 'pending' ? `Pendiente para ${name(p.input.recipient)}: se enviará al reconectar.` : `Falló el envío a ${name(p.input.recipient)}: ${p.error}`}</span>
                  {p.state === 'pending' && <button type="button" className="font-semibold underline" onClick={() => void flushOutbox()}>Reintentar</button>}
                  <button type="button" className="font-semibold underline" onClick={() => discardOutbox(p.localId)}>Descartar</button>
                </div>
              ))}
              <fieldset>
                <legend className="mb-1 text-xs font-semibold text-slate-400">Destinatario</legend>
                <div className="space-y-1.5" role="radiogroup">
                  {contacts.map((c) => {
                    const was = sent.some((x) => x.recipient === c.id);
                    return (
                      <label key={c.id} className={`flex min-h-[44px] items-center gap-2 rounded-xl px-3 ring-1 ${to === c.id ? 'bg-sky-500/10 ring-sky-400/50' : 'bg-ink-800 ring-white/10'}`} data-testid="share-contact">
                        <input type="radio" name="share-to" checked={to === c.id} onChange={() => setTo(c.id)} className="accent-sky-400" />
                        <span className="flex-1 truncate text-sm font-medium">{c.alias}{c.favorite && <span className="ml-1 text-amber-300" aria-label="favorito">★</span>}</span>
                        {was && <span className="text-[11px] text-sky-300">enviada</span>}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {chosen && (
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" data-testid="share-make-fav" checked={chosen.favorite || makeFav} disabled={chosen.favorite} onChange={(e) => setMakeFav(e.target.checked)} />
                  {chosen.favorite ? `${chosen.alias} es tu destinatario favorito` : `Usar a ${chosen.alias} como destinatario favorito (un toque)`}
                </label>
              )}
              <label className="block text-xs text-slate-400">Comentario (opcional)
                <textarea data-testid="share-comment" value={comment} maxLength={280} rows={2} onChange={(e) => setComment(e.target.value)} placeholder="Por ejemplo: creo que esta nos puede gustar a los dos"
                  className="mt-1 w-full rounded-lg bg-ink-800 p-2 text-sm text-slate-100 ring-1 ring-white/10" />
              </label>
              {msg && <p className="text-xs text-rose-300" role="alert">{msg}</p>}
              {already.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs text-slate-400" data-testid="share-already">Ya se la enviaste a {chosen!.alias} {relTime(already[0].createdAt)}.</p>
                  <button type="button" data-testid="share-resend" disabled={busy} onClick={() => void send(true)} className="w-full rounded-xl bg-ink-700 py-3 text-sm font-semibold text-slate-100 ring-1 ring-white/10 disabled:opacity-50">Reenviar a {chosen!.alias}</button>
                </div>
              ) : (
                <button type="button" data-testid="share-send" disabled={!chosen || busy} onClick={() => void send(false)}
                  className="w-full rounded-xl py-3 text-sm font-bold disabled:opacity-40" style={{ background: '#38BDF8', color: '#06121F' }}>{busy ? 'Enviando…' : chosen ? `Enviar a ${chosen.alias}` : 'Elegí un destinatario'}</button>
              )}
              <Link to="/ajustes/contactos" onClick={onClose} className="block text-center text-xs text-slate-400 underline">Administrar contactos y favorito</Link>
            </div>
          )}
      </div>
    </div>
  );
}

