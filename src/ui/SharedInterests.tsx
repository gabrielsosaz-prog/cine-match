/**
 * v4.3 · «Intereses compartidos» dentro de la tarjeta común y botones de interés con su representación (ícono y color).
 *
 * Sólo aparece si el título está intercambiado con algún contacto activo (en Inicio y Buscar la mayoría de las tarjetas
 * no cambia de altura). Muestra tu respuesta y la del contacto (si los dos lo autorizaron), una interpretación breve y,
 * con su permiso aparte, las valoraciones posteriores. No agrega controles: tu respuesta se cambia con los cuatro
 * botones de interés de siempre, que están debajo.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { safely } from '../services/notices';
import { recordInterest } from '../services/taste';
import { ANSWER_STYLE, combinedLevel, interpretation, isSharedAnswer, LEVEL_TONE, SHARED_ANSWERS, type SharedAnswer } from '../social/interests';
import { bothWant, exchangedWith, myState, theirRow, theirState, favoriteContact } from '../social/store';
import { useSocial } from '../social/useSocial';
import type { InterestAnswer, Rating, TitleKey } from '../types';
import { num } from './format';

/** Última respuesta de interés local sin «Ya la vi» (la que se comparte). */
export function useSharedMine(profileId: string, k: TitleKey, enabled = true): SharedAnswer | undefined {
  return useLiveQuery(async () => {
    if (!enabled) return undefined;
    const rs = await db.interests.where('[profileId+key]').equals([profileId, k]).toArray();
    let best: { a: SharedAnswer; at: number } | undefined;
    for (const r of rs) if (isSharedAnswer(r.answer) && (!best || r.at >= best.at)) best = { a: r.answer, at: r.at };
    return best?.a;
  }, [profileId, k, enabled]);
}

export function InterestButtons({ value, onPick, title, testPrefix = 'interest' }: { value?: InterestAnswer; onPick: (a: SharedAnswer) => void; title: string; testPrefix?: string }) {
  return (
    <div className="mt-2 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={`Interés en ${title}`} data-testid="interest-row">
      {SHARED_ANSWERS.map((id) => {
        const st = ANSWER_STYLE[id];
        const on = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} aria-label={st.label === 'No' ? 'No me interesa' : st.label === 'Podría' ? 'Podría interesarme' : st.label === 'Me interesa' ? 'Me interesa' : 'Tengo muchas ganas de verla'}
            data-testid={`${testPrefix}-${id}`} onClick={() => onPick(id)}
            className={`flex min-h-[38px] min-w-0 items-center justify-center gap-1 rounded-lg px-0.5 text-[11px] font-semibold leading-tight ring-1 ${on ? 'ring-transparent' : 'bg-ink-800 text-slate-300 ring-white/10'}`}
            style={on ? { background: st.solid, color: st.ink } : undefined}>
            <span aria-hidden="true" className="shrink-0 text-[12px]" style={on ? undefined : { color: st.fg }}>{st.icon}</span><span className="min-w-0">{st.short}</span>
          </button>
        );
      })}
    </div>
  );
}

function Box({ who, v, note, testId, state }: { who: string; v?: SharedAnswer; note?: string; testId: string; state: string }) {
  const st = v ? ANSWER_STYLE[v] : undefined;
  return (
    <div className="min-w-0 rounded-lg px-2 py-1.5" style={{ background: st?.bg ?? 'rgba(148,163,184,0.08)' }} data-testid={testId} data-state={state} data-answer={v ?? ''}>
      <div className="truncate text-[10px] font-medium text-slate-400">{who}</div>
      <div className="flex min-w-0 items-center gap-1 text-[13px] font-bold leading-tight" style={{ color: st?.fg ?? '#94A3B8' }}>
        {st ? <><span aria-hidden="true">{st.icon}</span><span className="truncate">{st.label}</span></> : <span className="truncate font-semibold">{note}</span>}
      </div>
      {st && note && <div className="truncate text-[10px] text-slate-500">{note}</div>}
    </div>
  );
}

export function SharedInterests({ k, profileId, rating, contactId, testId = 'shared-interests' }: { k: TitleKey; profileId: string; rating?: Rating; contactId?: string; testId?: string }) {
  const s = useSocial();
  const ids = s.phase === 'ready' ? exchangedWith(k) : [];
  const relevant = ids.length > 0;
  const mine = useSharedMine(profileId, k, relevant);
  const fav = favoriteContact()?.id;
  const [pick, setPick] = useState<string>();
  if (!relevant) return null;
  const sel = (contactId && ids.includes(contactId) ? contactId : undefined) ?? (pick && ids.includes(pick) ? pick : undefined) ?? (fav && ids.includes(fav) ? fav : ids[0]);
  const c = s.contacts.find((x) => x.id === sel)!;
  const ts = theirState(k, c);
  const ms = myState(k, c, mine);
  const level = combinedLevel({ mine, theirs: ts.kind === 'answer' ? ts.v : undefined, theirsPrivate: ts.kind === 'private', bothWant: bothWant(k, c.id) });
  const myNote = ms === 'private' ? 'Privado' : ms === 'none' ? 'Sin responder' : ms === 'pending' ? 'Pendiente de envío' : ms === 'unshared' ? 'No compartido' : undefined;
  const theirNote = ts.kind === 'private' ? 'Interés privado' : ts.kind === 'none' ? 'Sin responder' : undefined;
  const row = theirRow(k, c.id);
  const ratingsOn = c.shareRatings && c.theirShareRatings;
  const theirRating = ratingsOn ? row?.rating : undefined;
  return (
    <section className="mt-2 rounded-xl bg-ink-950/60 p-2 ring-1 ring-white/5" data-testid={testId} data-level={level} data-contact={c.alias}>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="flex-1 text-[11px] font-bold uppercase tracking-wide text-sky-200">Intereses compartidos</h4>
        {ids.length > 1 && !contactId && (
          <select aria-label="Contacto" data-testid="shared-contact" value={sel} onChange={(e) => setPick(e.target.value)} className="max-w-[45%] rounded-md bg-ink-800 px-1.5 py-1 text-[11px] ring-1 ring-white/10">
            {ids.map((id) => <option key={id} value={id}>{s.contacts.find((x) => x.id === id)?.alias}</option>)}
          </select>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Box who="Vos" v={ms === 'none' ? undefined : mine} note={myNote} testId="shared-mine" state={ms} />
        <Box who={c.alias} v={ts.kind === 'answer' ? ts.v : undefined} note={theirNote} testId="shared-theirs" state={ts.kind === 'private' ? `private-${ts.why}` : ts.kind} />
      </div>
      <p className="mt-1 text-[12px] font-semibold" style={{ color: LEVEL_TONE[level] }} data-testid="shared-verdict">{interpretation(level, !mine)}</p>
      {ms === 'unshared' && <p className="text-[10px] text-slate-500" data-testid="shared-hint">{c.alias} todavía no ve tu respuesta: tocala abajo para compartirla.</p>}
      {ms === 'pending' && <p className="text-[10px] text-amber-300" data-testid="shared-pending">Sin conexión: tu respuesta se enviará al volver (todavía no la ve).</p>}
      {ts.kind === 'private' && <p className="text-[10px] text-slate-500">{ts.why === 'mine' ? <>Activá «Compartir intereses» con {c.alias} en <Link to="/ajustes/privacidad" className="text-accent underline">Privacidad y permisos</Link>.</> : `${c.alias} no activó «Compartir intereses»: su respuesta no se muestra ni se deduce.`}</p>}
      {ratingsOn && (rating?.overall !== undefined || theirRating !== undefined) && (
        <div className="mt-1.5 rounded-lg bg-emerald-500/5 px-2 py-1 text-[11px] text-slate-300 ring-1 ring-emerald-400/10" data-testid="shared-ratings">
          <span className="font-semibold text-emerald-200">Valoración después de verla</span> (nota real, no interés ni estimación): Vos {rating?.overall !== undefined ? num(rating.overall, rating.overall % 1 ? 1 : 0) : '–'} · {c.alias} <span data-testid="shared-their-rating">{theirRating !== undefined ? num(theirRating, theirRating % 1 ? 1 : 0) : '–'}</span>
        </div>
      )}
    </section>
  );
}

/** Para Buscar y la ficha: bloque compartido + botones de interés, sólo si el título tiene relación social. */
export function SocialInterestStrip({ k, title, profileId, rating }: { k: TitleKey; title: string; profileId: string; rating?: Rating }) {
  const s = useSocial();
  const relevant = s.phase === 'ready' && exchangedWith(k).length > 0;
  const mine = useSharedMine(profileId, k, relevant);
  if (!relevant) return null;
  return (
    <div data-testid="social-strip">
      <SharedInterests k={k} profileId={profileId} rating={rating} />
      <InterestButtons value={mine} title={title} onPick={(a) => { void safely(() => recordInterest(profileId, k, a, { engine: 'social', source: 'social' }), 'tu respuesta'); }} />
    </div>
  );
}
