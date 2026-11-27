/**
 * v4.2 · «Me recomendaron» (pestañas Recibidas y Para ver juntos).
 *
 * Usa la misma tarjeta que «Quiero ver». Las puntuaciones son SIEMPRE las del perfil de quien recibe («Para vos» del
 * motor v3.4, igual que en Quiero ver); nunca se muestran las del remitente. Mirar, archivar o recibir no cambia el
 * perfil ni el ranking: sólo las acciones explícitas de la tarjeta (Quiero verla, Ya la vi, Puntuar…) lo hacen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../hooks/useApp';
import { useRatings } from '../hooks/useRatings';
import { pushNotice, safely } from '../services/notices';
import { predictFor } from '../services/recommendations';
import { interestMap, recordInterest } from '../services/taste';
import { initSocial, markSeen, setArchived } from '../social/store';
import { displayTitle, type DisplayTitle } from '../social/titles';
import type { InboxRec } from '../social/types';
import { useSocial } from '../social/useSocial';
import type { MediaType, RecommendationItem, TitleKey } from '../types';
import { Chip, Empty, personalState, publicScore } from '../ui/components';
import TitleCard, { type CardInfo } from '../ui/TitleCard';
import { useLiveQuery } from 'dexie-react-hooks';
import Together from './Together';

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'juntos' ? 'juntos' : 'recibidas';
  useEffect(() => { void initSocial(); }, []);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Me recomendaron</h1>
      <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-ink-900 p-1 ring-1 ring-white/5" role="tablist">
        {([['recibidas', 'Recibidas'], ['juntos', 'Para ver juntos']] as const).map(([id, l]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`inbox-tab-${id}`} onClick={() => setParams(id === 'juntos' ? { tab: 'juntos' } : {}, { replace: true })}
            className={`min-h-[40px] rounded-lg text-sm font-semibold ${tab === id ? 'bg-ink-700 text-slate-50' : 'text-slate-400'}`}>{l}</button>
        ))}
      </div>
      {tab === 'juntos' ? <Together /> : <Received focus={params.get('r') ?? undefined} />}
    </div>
  );
}

/** Mensaje común cuando falta cuenta o servicio. */
export function SocialGate({ children }: { children: ReactNode }) {
  const s = useSocial();
  if (!s.available) return <Empty>Las recomendaciones entre personas no están disponibles en esta instalación.</Empty>;
  if (s.phase === 'idle' || s.phase === 'loading') return <p className="text-sm text-slate-400">Cargando…</p>;
  if (s.phase !== 'ready') return (
    <div className="space-y-2 rounded-2xl bg-ink-900 p-4 text-sm text-slate-300 ring-1 ring-white/5" data-testid="social-signed-out">
      <p>Creá una cuenta para recibir recomendaciones de tus contactos y encontrar títulos para ver juntos. La app sigue funcionando sin cuenta.</p>
      <Link to="/ajustes/cuenta" className="inline-block rounded-lg bg-accent px-3 py-2 font-semibold text-ink-950">Crear cuenta o iniciar sesión</Link>
    </div>
  );
  return <>{children}</>;
}

type Status = 'nueva' | 'consultada' | 'guardada' | 'vista' | 'archivada';
const STATUS_LABEL: Record<Status, string> = { nueva: 'Nueva', consultada: 'Consultada', guardada: 'Guardada en Quiero ver', vista: 'Vista', archivada: 'Archivada' };
type Filter = 'todas' | 'nuevas' | 'vistas' | 'archivadas';
type Sort = 'fecha' | 'para-vos' | 'tmdb';

export function whenLabel(ts: number) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Hoy · ${hm}`;
  if (diff === 1) return `Ayer · ${hm}`;
  return `${d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} · ${hm}`;
}

function Received({ focus }: { focus?: string }) {
  return <SocialGate><ReceivedList focus={focus} /></SocialGate>;
}

function ReceivedList({ focus }: { focus?: string }) {
  const { profileId, settings } = useApp();
  const s = useSocial();
  const rs = useRatings(profileId);
  const [filter, setFilter] = useState<Filter>('todas');
  const [type, setType] = useState<'all' | MediaType>('all');
  const [from, setFrom] = useState<string>('all');
  const [sort, setSort] = useState<Sort>('fecha');
  // Las que eran nuevas al entrar conservan la marca «Nueva» durante esta visita
  const newAtEntry = useRef<Set<string>>(new Set(s.inbox.filter((r) => !r.seenAt && !r.archivedAt).map((r) => r.id)));
  for (const r of s.inbox) if (!r.seenAt && !r.archivedAt) newAtEntry.current.add(r.id);
  const statusOf = (r: InboxRec): Status => {
    if (r.archivedAt) return 'archivada';
    const rt = rs.byKey.get(r.key);
    if (rt?.watched) return 'vista';
    if (rt?.list === 'want' || rt?.list === 'watching') return 'guardada';
    return r.seenAt ? 'consultada' : 'nueva';
  };
  const senders = useMemo(() => [...new Map(s.inbox.map((r) => [r.sender, s.contacts.find((c) => c.id === r.sender)?.alias ?? r.senderName])).entries()], [s.inbox, s.contacts]);

  // Fichas (sin guardarlas) y estimaciones «Para vos» del perfil de quien recibe
  const [titles, setTitles] = useState<Map<TitleKey, DisplayTitle | 'error'>>(new Map());
  const keys = useMemo(() => [...new Set(s.inbox.map((r) => r.key))], [s.inbox]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    for (const k of keys) {
      if (titles.has(k) && titles.get(k) !== 'error') continue;
      displayTitle(k, { language: settings.language, country: settings.country })
        .then((d) => { if (alive) setTitles((m) => new Map(m).set(k, d)); })
        .catch(() => { if (alive) setTitles((m) => new Map(m).set(k, 'error')); });
    }
    return () => { alive = false; };
  }, [keys.join(','), settings.language, settings.country, retry]);
  const loaded = keys.filter((k) => { const t = titles.get(k); return t && t !== 'error'; });
  const [preds, setPreds] = useState<Map<TitleKey, RecommendationItem>>(new Map());
  const asked = useRef('');
  useEffect(() => {
    const sig = `${profileId}|${loaded.join(',')}|${rs.ratings.length}`;
    if (!loaded.length || sig === asked.current) return;
    asked.current = sig;
    const extra = loaded.map((k) => (titles.get(k) as DisplayTitle).meta);
    predictFor(profileId, loaded, { holdOut: true, extraTitles: extra }).then(setPreds).catch(() => undefined);
  }, [loaded.join(','), profileId, rs.status]);
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);

  // Orden estable: sólo cambia al elegir otro orden o filtro, o cuando llega algo nuevo
  const visible = s.inbox.filter((r) => {
    const st = statusOf(r);
    if (filter === 'archivadas' ? st !== 'archivada' : st === 'archivada' && !(r.id === focus)) return false;
    if (filter === 'nuevas' && !newAtEntry.current.has(r.id)) return false;
    if (filter === 'vistas' && st !== 'vista') return false;
    if (type !== 'all' && !r.key.startsWith(type)) return false;
    if (from !== 'all' && r.sender !== from) return false;
    return true;
  });
  const orderSig = `${sort}|${filter}|${type}|${from}|${visible.map((r) => r.id).sort().join(',')}|${sort === 'fecha' ? '' : preds.size + '|' + loaded.length}`;
  const order = useMemo(() => {
    const val = (r: InboxRec) => {
      if (sort === 'para-vos') { const p = preds.get(r.key); return p && personalState(p).kind !== 'insufficient' ? p.score : -1; }
      if (sort === 'tmdb') { const t = titles.get(r.key); return t && t !== 'error' ? publicScore(t.meta) ?? -1 : -1; }
      return r.createdAt;
    };
    return [...visible].sort((a, b) => val(b) - val(a) || b.createdAt - a.createdAt).map((r) => r.id);
  }, [orderSig]);
  const byId = new Map(s.inbox.map((r) => [r.id, r]));

  // Consultadas: lo que estuvo en pantalla un momento
  useEffect(() => {
    const ids = visible.filter((r) => !r.seenAt).map((r) => r.id);
    if (!ids.length) return;
    const t = setTimeout(() => { void markSeen(ids); }, 1500);
    return () => clearTimeout(t);
  }, [visible.map((r) => r.id).join(',')]);
  // Enlace directo (notificación): llevar a esa tarjeta
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => document.querySelector(`[data-rec-id="${focus}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300);
    return () => clearTimeout(t);
  }, [focus, order.length]);

  const archive = async (r: InboxRec, v: boolean) => {
    try {
      await setArchived(r.id, v);
      pushNotice({ kind: 'info', text: v ? `«${r.title}» archivada.` : `«${r.title}» volvió a Recibidas.`, action: { label: 'Deshacer', run: () => { void setArchived(r.id, !v).catch(() => undefined); } } }, 6000);
    } catch (e) { pushNotice({ kind: 'error', text: `No se pudo ${v ? 'archivar' : 'desarchivar'}: ${(e as Error).message}` }); }
  };
  const counts = { nuevas: s.inbox.filter((r) => newAtEntry.current.has(r.id) && !r.archivedAt).length, archivadas: s.inbox.filter((r) => r.archivedAt).length };

  return (
    <div className="space-y-3">
      {!s.reachable && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" data-testid="social-offline">Sin conexión con el servicio social: se muestra lo último recibido.</p>}
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4" data-testid="inbox-filters">
        {([['todas', 'Todas'], ['nuevas', `Nuevas${counts.nuevas ? ` (${counts.nuevas})` : ''}`], ['vistas', 'Vistas'], ['archivadas', `Archivadas${counts.archivadas ? ` (${counts.archivadas})` : ''}`]] as const).map(([id, l]) => (
          <Chip key={id} active={filter === id} onClick={() => setFilter(id)} testId={`inbox-filter-${id}`}>{l}</Chip>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <select aria-label="Contacto" data-testid="inbox-from" value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10">
          <option value="all">Todos</option>{senders.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as typeof type)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10">
          <option value="all">Todo tipo</option><option value="movie">Películas</option><option value="tv">Series</option>
        </select>
        <select aria-label="Orden" data-testid="inbox-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10">
          <option value="fecha">Recientes</option><option value="para-vos">Para vos</option><option value="tmdb">TMDB</option>
        </select>
      </div>
      {!s.inbox.length && <Empty>Todavía no te recomendaron nada. Cuando un contacto te envíe un título, aparece acá.</Empty>}
      {s.inbox.length > 0 && !order.length && <Empty>No hay recomendaciones con estos filtros.</Empty>}
      <ul className="space-y-4" data-testid="inbox-list">
        {order.map((id) => {
          const r = byId.get(id);
          if (!r) return null;
          const st = statusOf(r);
          const who = s.contacts.find((c) => c.id === r.sender)?.alias ?? r.senderName;
          const t = titles.get(r.key);
          const p = preds.get(r.key);
          const ps = personalState(p);
          const info: CardInfo = {
            compat: p && ps.kind !== 'insufficient' ? `Afinidad con confianza ${p.confidenceLabel}` : undefined,
            primaryLabel: 'Para vos', primary: p && ps.kind !== 'insufficient' ? p.score : undefined,
            why: p?.explanation ?? [],
            cons: (p?.rejectionPenalty ?? 0) < -0.05 ? ['Se parece a títulos que descartaste con «No me interesa».'] : [],
            reliability: [
              p ? `«Para vos» es TU estimación (motor v3.4, como en Quiero ver), calculada con tu perfil; no es la nota de ${who}${ps.kind === 'provisional' ? '. Provisional, con poca evidencia' : ''}.` : (t && t !== 'error' ? 'Calculando tu estimación «Para vos»…' : 'Estimación no disponible hasta cargar la ficha.'),
              'Recibir una recomendación no cambia tu perfil ni tus recomendaciones.',
            ],
          };
          return (
            <li key={r.id} data-testid="inbox-item" data-rec-id={r.id} data-status={st} className={`space-y-1.5 ${focus === r.id ? 'rounded-2xl ring-2 ring-sky-400/60' : ''}`}>
              <div className="px-1" data-testid="inbox-header">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-bold text-sky-200"><span data-testid="inbox-from-name">{who}</span> te recomienda</p>
                  {newAtEntry.current.has(r.id) && !r.archivedAt && <span className="rounded-full bg-sky-400 px-2 py-0.5 text-[10px] font-bold text-ink-950" data-testid="inbox-new">Nueva</span>}
                </div>
                <p className="text-[11px] text-slate-400"><span data-testid="inbox-when">{whenLabel(r.createdAt)}</span> · <span data-testid="inbox-status">{STATUS_LABEL[st]}</span></p>
                {r.comment && <p className="mt-1 whitespace-pre-line break-words rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[13px] italic text-sky-100" data-testid="inbox-comment">«{r.comment}»</p>}
              </div>
              {t && t !== 'error' ? (
                <ul>
                  <TitleCard k={r.key} meta={t.meta} snap={t.snap} rating={rs.byKey.get(r.key)} info={info} profileId={profileId} testId="want-item"
                    interest={{ value: interests?.get(r.key)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, r.key, a, { engine: 'recibidas', source: 'recibidas' }), 'tu respuesta'); } }}
                    actionsExtra={
                      <button type="button" data-testid={r.archivedAt ? 'inbox-unarchive' : 'inbox-archive'} onClick={() => void archive(r, !r.archivedAt)}
                        className="mt-2 w-full rounded-lg py-2 text-[13px] font-semibold text-slate-400 ring-1 ring-white/10">{r.archivedAt ? 'Desarchivar' : 'Archivar recomendación'}</button>
                    } />
                </ul>
              ) : (
                <div className="flex items-center gap-3 rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5" data-testid="inbox-loading">
                  <div className="h-[96px] w-[64px] shrink-0 rounded-lg bg-ink-700" />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-bold">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                    {t === 'error'
                      ? <p className="text-xs text-amber-300">No se pudo cargar la ficha. <button type="button" className="font-semibold underline" onClick={() => { setTitles((m) => { const n = new Map(m); n.delete(r.key); return n; }); setRetry((x) => x + 1); }}>Reintentar</button></p>
                      : <p className="text-xs text-slate-500">Cargando ficha…</p>}
                    <button type="button" onClick={() => void archive(r, !r.archivedAt)} className="mt-1 text-xs text-slate-400 underline">{r.archivedAt ? 'Desarchivar' : 'Archivar'}</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
