/**
 * v4.3 · «Compartidas»: pestañas Recibidas, Enviadas y Para ver juntos (antes «Me recomendaron», v4.2).
 *
 * Las tres usan la tarjeta común. Las puntuaciones son SIEMPRE las del perfil de quien mira («Para vos» del motor v3.4,
 * igual que en Quiero ver). Mirar, archivar o recibir no cambia el perfil ni el ranking: sólo las acciones explícitas de
 * la tarjeta (Quiero verla, Ya la vi, Puntuar, los botones de interés…) lo hacen, igual que en cualquier otra pantalla.
 * El interés del otro se ve sólo con autorización mutua; si no, se muestra «Interés privado» (nunca se deduce).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { PLATFORMS } from '../constants';
import { useApp } from '../hooks/useApp';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import { useRatings } from '../hooks/useRatings';
import { availabilityState } from '../services/availability';
import { pushNotice, safely } from '../services/notices';
import { predictFor } from '../services/recommendations';
import { interestMap, listInterests, recordInterest } from '../services/taste';
import { ANSWER_STYLE, combinedLevel, isPositive, isSharedAnswer, type MatchLevel, type SharedAnswer } from '../social/interests';
import { clearIncomingNotices, initSocial, markSeen, refreshShared, setArchived, theirState } from '../social/store';
import { displayTitle, type DisplayTitle } from '../social/titles';
import type { Contact, InboxRec, SentRec } from '../social/types';
import { useSocial } from '../social/useSocial';
import type { MediaType, PlatformId, RecommendationItem, TitleKey } from '../types';
import { Chip, Empty, personalState, publicScore } from '../ui/components';
import TitleCard, { type CardInfo } from '../ui/TitleCard';
import Together from './Together';

const TABS = ['recibidas', 'enviadas', 'juntos'] as const;
type Tab = (typeof TABS)[number];

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'recibidas';
  useEffect(() => { void initSocial(); clearIncomingNotices(); void refreshShared(); }, []);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Compartidas</h1>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-ink-900 p-1 ring-1 ring-white/5" role="tablist">
        {([['recibidas', 'Recibidas'], ['enviadas', 'Enviadas'], ['juntos', 'Para ver juntos']] as const).map(([id, l]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`inbox-tab-${id}`} onClick={() => { saveTabScroll(tab); setParams(id === 'recibidas' ? {} : { tab: id }, { replace: true }); }}
            className={`min-h-[40px] rounded-lg px-1 text-[13px] font-semibold leading-tight ${tab === id ? 'bg-ink-700 text-slate-50' : 'text-slate-400'}`}>{l}</button>
        ))}
      </div>
      {tab === 'juntos' ? <Together focus={params.get('k') ?? undefined} focusContact={params.get('c') ?? undefined} />
        : tab === 'enviadas' ? <SocialGate><SentList /></SocialGate>
        : <SocialGate><ReceivedList focus={params.get('r') ?? undefined} /></SocialGate>}
    </div>
  );
}

// ───────────── posición por pestaña (cambiar de pestaña o volver de una ficha conserva el lugar) ─────────────
const scrollKey = (t: string) => `cine-match:compartidas-scroll:${t}`;
function saveTabScroll(t: string) { try { sessionStorage.setItem(scrollKey(t), String(window.scrollY)); } catch { /* */ } }
export function useTabScroll(tab: string, ready: boolean) {
  const done = useRef(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const here = window.location.hash;
    const onScroll = () => { if (t) clearTimeout(t); t = setTimeout(() => { if (window.location.hash === here) saveTabScroll(tab); }, 150); };
    window.addEventListener('scroll', onScroll, { passive: true });
    const onClick = () => { if (window.location.hash === here) saveTabScroll(tab); };
    document.addEventListener('click', onClick, true);
    return () => { window.removeEventListener('scroll', onScroll); document.removeEventListener('click', onClick, true); if (t) clearTimeout(t); };
  }, [tab]);
  useLayoutEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    let y = 0; try { y = Number(sessionStorage.getItem(scrollKey(tab)) ?? 0); } catch { /* */ }
    if (!y) return;
    let n = 0; const iv = setInterval(() => { window.scrollTo(0, y); if (++n > 10 || Math.abs(window.scrollY - y) < 2) clearInterval(iv); }, 100);
    window.scrollTo(0, y);
    const stop = () => clearInterval(iv);
    window.addEventListener('touchstart', stop, { passive: true, once: true });
    return () => clearInterval(iv);
  }, [ready, tab]);
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

export function whenLabel(ts: number) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Hoy · ${hm}`;
  if (diff === 1) return `Ayer · ${hm}`;
  return `${d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} · ${hm}`;
}

// ───────────── datos comunes de las tarjetas (fichas sin guardarlas + estimación «Para vos» propia) ─────────────
export function useCardData(keys: TitleKey[]) {
  const { profileId, settings } = useApp();
  const rs = useRatings(profileId);
  const [titles, setTitles] = useState<Map<TitleKey, DisplayTitle | 'error'>>(new Map());
  const [retry, setRetry] = useState(0);
  const sig = keys.join(',');
  useEffect(() => {
    let alive = true;
    for (const k of keys) {
      if (titles.has(k) && titles.get(k) !== 'error') continue;
      displayTitle(k, { language: settings.language, country: settings.country })
        .then((d) => { if (alive) setTitles((m) => new Map(m).set(k, d)); })
        .catch(() => { if (alive) setTitles((m) => new Map(m).set(k, 'error')); });
    }
    return () => { alive = false; };
  }, [sig, settings.language, settings.country, retry]);
  const loaded = keys.filter((k) => { const t = titles.get(k); return t && t !== 'error'; });
  const [preds, setPreds] = useState<Map<TitleKey, RecommendationItem>>(new Map());
  const asked = useRef('');
  useEffect(() => {
    const s = `${profileId}|${loaded.join(',')}|${rs.ratings.length}`;
    if (!loaded.length || s === asked.current) return;
    asked.current = s;
    const extra = loaded.map((k) => (titles.get(k) as DisplayTitle).meta);
    predictFor(profileId, loaded, { holdOut: true, extraTitles: extra }).then(setPreds).catch(() => undefined);
  }, [loaded.join(','), profileId, rs.status]);
  const retryKey = (k: TitleKey) => { setTitles((m) => { const n = new Map(m); n.delete(k); return n; }); setRetry((x) => x + 1); };
  return { titles, preds, loaded, rs, retryKey };
}
/** Última respuesta de interés local sin «Ya la vi», por título (la que se comparte). */
export function useMyAnswers(profileId: string): Map<TitleKey, SharedAnswer> {
  return useLiveQuery(async () => {
    const m = new Map<TitleKey, SharedAnswer>(); const at = new Map<TitleKey, number>();
    for (const r of await listInterests(profileId)) if (isSharedAnswer(r.answer) && r.at >= (at.get(r.key) ?? -1)) { m.set(r.key, r.answer); at.set(r.key, r.at); }
    return m;
  }, [profileId]) ?? new Map();
}
export function myInfo(p: RecommendationItem | undefined, other: string): CardInfo {
  const ps = personalState(p);
  return {
    compat: p && ps.kind !== 'insufficient' ? `Afinidad con confianza ${p.confidenceLabel}` : undefined,
    primaryLabel: 'Para vos', primary: p && ps.kind !== 'insufficient' ? p.score : undefined,
    why: p?.explanation ?? [],
    cons: (p?.rejectionPenalty ?? 0) < -0.05 ? ['Se parece a títulos que descartaste con «No me interesa».'] : [],
    reliability: [
      p ? `«Para vos» es TU estimación (motor v3.4, como en Quiero ver), calculada con tu perfil; no es la nota de ${other}${ps.kind === 'provisional' ? '. Provisional, con poca evidencia' : ''}.` : 'Calculando tu estimación «Para vos»…',
      'Compartir o recibir una recomendación no cambia tu perfil ni tus recomendaciones; tus botones de interés sí, como en cualquier pantalla.',
    ],
  };
}
const levelOf = (k: TitleKey, c: Contact | undefined, mine: SharedAnswer | undefined, bothWant = false): MatchLevel => {
  if (!c) return 'privado';
  const t = theirState(k, c);
  return combinedLevel({ mine, theirs: t.kind === 'answer' ? t.v : undefined, theirsPrivate: t.kind === 'private', bothWant });
};
type MatchFilter = 'all' | 'positivas' | 'posibles' | 'pendientes' | 'sin' | 'privado';
const MATCH_FILTERS = ['all', 'positivas', 'posibles', 'pendientes', 'sin', 'privado'] as const;
const passMatch = (f: MatchFilter, l: MatchLevel) => f === 'all' || (f === 'positivas' ? isPositive(l) : f === 'posibles' ? l === 'posible' || l === 'posible_baja' : f === 'pendientes' ? l === 'pendiente' : f === 'sin' ? l === 'sin' : l === 'privado');
const sel = 'min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10';

function LoadingCard({ title, year, error, onRetry, extra }: { title: string; year?: number; error?: boolean; onRetry: () => void; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5" data-testid="inbox-loading">
      <div className="h-[96px] w-[64px] shrink-0 rounded-lg bg-ink-700" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-bold">{title}{year ? ` (${year})` : ''}</p>
        {error ? <p className="text-xs text-amber-300">No se pudo cargar la ficha. <button type="button" className="font-semibold underline" onClick={onRetry}>Reintentar</button></p>
          : <p className="text-xs text-slate-500">Cargando ficha…</p>}
        {extra}
      </div>
    </div>
  );
}

// ───────────────────────────── Recibidas ─────────────────────────────
type Status = 'nueva' | 'consultada' | 'guardada' | 'vista' | 'archivada';
const STATUS_LABEL: Record<Status, string> = { nueva: 'Nueva', consultada: 'Consultada', guardada: 'Guardada en Quiero ver', vista: 'Vista', archivada: 'Archivada' };
const R_FILTERS = ['todas', 'nuevas', 'vistas', 'archivadas'] as const;
type Filter = (typeof R_FILTERS)[number];
const R_SORTS = ['fecha', 'para-vos', 'tmdb', 'coincidencia'] as const;
type Sort = (typeof R_SORTS)[number];
const MINE_FILTERS = ['all', 'mucho', 'si', 'quiza', 'no', 'none'] as const;

function ReceivedList({ focus }: { focus?: string }) {
  const { profileId } = useApp();
  const s = useSocial();
  const P = `cine-match:compartidas:recibidas:${profileId}`;
  const [filter, setFilter] = usePersistentState<Filter>(`${P}:filter`, 'todas', oneOf(R_FILTERS));
  const [type, setType] = usePersistentState<'all' | MediaType>(`${P}:type`, 'all', oneOf(['all', 'movie', 'tv'] as const));
  const [from, setFrom] = usePersistentState<string>(`${P}:from`, 'all');
  const [sort, setSort] = usePersistentState<Sort>(`${P}:sort`, 'fecha', oneOf(R_SORTS));
  const [mineF, setMineF] = usePersistentState<(typeof MINE_FILTERS)[number]>(`${P}:mine`, 'all', oneOf(MINE_FILTERS));
  const [matchF, setMatchF] = usePersistentState<MatchFilter>(`${P}:match`, 'all', oneOf(MATCH_FILTERS));
  // Las que eran nuevas al entrar conservan la marca «Nueva» durante esta visita
  const newAtEntry = useRef<Set<string>>(new Set(s.inbox.filter((r) => !r.seenAt && !r.archivedAt).map((r) => r.id)));
  for (const r of s.inbox) if (!r.seenAt && !r.archivedAt) newAtEntry.current.add(r.id);
  const keys = useMemo(() => [...new Set(s.inbox.map((r) => r.key))], [s.inbox]);
  const { titles, preds, loaded, rs, retryKey } = useCardData(keys);
  const statusOf = (r: InboxRec): Status => {
    if (r.archivedAt) return 'archivada';
    const rt = rs.byKey.get(r.key);
    if (rt?.watched) return 'vista';
    if (rt?.list === 'want' || rt?.list === 'watching') return 'guardada';
    return r.seenAt ? 'consultada' : 'nueva';
  };
  const senders = useMemo(() => [...new Map(s.inbox.map((r) => [r.sender, s.contacts.find((c) => c.id === r.sender)?.alias ?? r.senderName])).entries()], [s.inbox, s.contacts]);
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);
  const mine = useMyAnswers(profileId);
  const contactOf = (id: string) => s.contacts.find((c) => c.id === id && c.linked && !c.blocked);
  const level = (r: InboxRec) => levelOf(r.key, contactOf(r.sender), mine.get(r.key), Boolean(s.wantMatches[r.sender]?.includes(r.key)));

  const visible = s.inbox.filter((r) => {
    const st = statusOf(r);
    if (filter === 'archivadas' ? st !== 'archivada' : st === 'archivada' && !(r.id === focus)) return false;
    if (filter === 'nuevas' && !newAtEntry.current.has(r.id)) return false;
    if (filter === 'vistas' && st !== 'vista') return false;
    if (type !== 'all' && !r.key.startsWith(type)) return false;
    if (from !== 'all' && r.sender !== from) return false;
    if (mineF !== 'all' && (mineF === 'none' ? mine.has(r.key) : mine.get(r.key) !== mineF)) return false;
    if (!passMatch(matchF, level(r))) return false;
    return true;
  });
  // Orden estable: sólo cambia al elegir otro orden o filtro, o cuando llega algo nuevo (archivar no reordena)
  const orderSig = `${sort}|${filter}|${type}|${from}|${mineF}|${matchF}|${visible.map((r) => r.id).sort().join(',')}|${sort === 'fecha' ? '' : preds.size + '|' + loaded.length + '|' + (sort === 'coincidencia' ? s.shared.length : '')}`;
  const order = useMemo(() => {
    const RANK: Record<MatchLevel, number> = { maxima: 9, muy_alta: 8, alta: 7, ambos: 6, posible: 5, posible_baja: 4, pendiente: 3, privado: 2, sin: 1 };
    const val = (r: InboxRec) => {
      if (sort === 'para-vos') { const p = preds.get(r.key); return p && personalState(p).kind !== 'insufficient' ? p.score : -1; }
      if (sort === 'tmdb') { const t = titles.get(r.key); return t && t !== 'error' ? publicScore(t.meta) ?? -1 : -1; }
      if (sort === 'coincidencia') return RANK[level(r)];
      return r.createdAt;
    };
    return [...visible].sort((a, b) => val(b) - val(a) || b.createdAt - a.createdAt).map((r) => r.id);
  }, [orderSig]);
  const byId = new Map(s.inbox.map((r) => [r.id, r]));
  useTabScroll('recibidas', order.length > 0 && loaded.length > 0);

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
      // Archivar no toca intereses ni coincidencias: sólo el estado de la bandeja
      await setArchived(r.id, v);
      pushNotice({ kind: 'info', text: v ? `«${r.title}» archivada.` : `«${r.title}» volvió a Recibidas.`, action: { label: 'Deshacer', run: () => { void setArchived(r.id, !v).catch(() => undefined); } } }, 6000);
    } catch (e) { pushNotice({ kind: 'error', text: `No se pudo ${v ? 'archivar' : 'desarchivar'}: ${(e as Error).message}` }); }
  };
  const counts = { nuevas: s.inbox.filter((r) => newAtEntry.current.has(r.id) && !r.archivedAt).length, archivadas: s.inbox.filter((r) => r.archivedAt).length };

  return (
    <div className="space-y-3">
      {!s.reachable && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" data-testid="social-offline">Sin conexión con el servicio social: se muestra lo último recibido.</p>}
      <div className="flex flex-wrap gap-1.5" data-testid="inbox-filters">
        {([['todas', 'Todas'], ['nuevas', `Nuevas${counts.nuevas ? ` (${counts.nuevas})` : ''}`], ['vistas', 'Vistas'], ['archivadas', `Archivadas${counts.archivadas ? ` (${counts.archivadas})` : ''}`]] as const).map(([id, l]) => (
          <Chip key={id} active={filter === id} onClick={() => setFilter(id)} testId={`inbox-filter-${id}`}>{l}</Chip>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <select aria-label="Contacto" data-testid="inbox-from" value={from} onChange={(e) => setFrom(e.target.value)} className={sel}>
          <option value="all">Todos</option>{senders.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={sel}>
          <option value="all">Todo tipo</option><option value="movie">Películas</option><option value="tv">Series</option>
        </select>
        <select aria-label="Orden" data-testid="inbox-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={sel}>
          <option value="fecha">Recientes</option><option value="para-vos">Para vos</option><option value="tmdb">TMDB</option><option value="coincidencia">Coincidencia</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <select aria-label="Mi interés" data-testid="inbox-mine" value={mineF} onChange={(e) => setMineF(e.target.value as typeof mineF)} className={sel}>
          <option value="all">Mi interés: todos</option><option value="mucho">Muchas ganas</option><option value="si">Me interesa</option><option value="quiza">Podría</option><option value="no">No</option><option value="none">Sin responder</option>
        </select>
        <select aria-label="Coincidencia" data-testid="inbox-match" value={matchF} onChange={(e) => setMatchF(e.target.value as MatchFilter)} className={sel}>
          <option value="all">Coincidencia: todas</option><option value="positivas">Positivas</option><option value="posibles">Posibles</option><option value="pendientes">Pendientes</option><option value="sin">Sin coincidencia</option><option value="privado">Interés privado</option>
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
          const archiveBtn = (
            <button type="button" data-testid={r.archivedAt ? 'inbox-unarchive' : 'inbox-archive'} onClick={() => void archive(r, !r.archivedAt)}
              className="mt-2 w-full rounded-lg py-2 text-[13px] font-semibold text-slate-400 ring-1 ring-white/10">{r.archivedAt ? 'Desarchivar' : 'Archivar recomendación'}</button>
          );
          return (
            <li key={r.id} data-testid="inbox-item" data-rec-id={r.id} data-key={r.key} data-status={st} data-level={level(r)} className={`space-y-1.5 ${focus === r.id ? 'rounded-2xl ring-2 ring-sky-400/60' : ''}`}>
              <div className="px-1" data-testid="inbox-header">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-bold text-sky-200"><span data-testid="inbox-from-name">{who}</span> te recomienda</p>
                  {newAtEntry.current.has(r.id) && !r.archivedAt && <span className="rounded-full bg-sky-400 px-2 py-0.5 text-[10px] font-bold text-ink-950" data-testid="inbox-new">Nueva</span>}
                </div>
                <p className="text-[11px] text-slate-400"><span data-testid="inbox-when">{whenLabel(r.createdAt)}</span>{st !== 'nueva' && <> · <span data-testid="inbox-status">{STATUS_LABEL[st]}</span></>}</p>
                {r.comment && <p className="mt-1 whitespace-pre-line break-words rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[13px] italic text-sky-100" data-testid="inbox-comment">«{r.comment}»</p>}
              </div>
              {t && t !== 'error' ? (
                <ul>
                  <TitleCard k={r.key} meta={t.meta} snap={t.snap} rating={rs.byKey.get(r.key)} info={myInfo(preds.get(r.key), who)} profileId={profileId} testId="want-item" sharedContact={contactOf(r.sender) ? r.sender : undefined}
                    interest={{ value: interests?.get(r.key)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, r.key, a, { engine: 'recibidas', source: 'recibidas' }), 'tu respuesta'); } }}
                    actionsExtra={archiveBtn} />
                </ul>
              ) : <LoadingCard title={r.title} year={r.year} error={t === 'error'} onRetry={() => retryKey(r.key)} extra={<button type="button" onClick={() => void archive(r, !r.archivedAt)} className="mt-1 text-xs text-slate-400 underline">{r.archivedAt ? 'Desarchivar' : 'Archivar'}</button>} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────────────────────── Enviadas ─────────────────────────────
const S_FILTERS = ['todas', 'positivas', 'mucho', 'si', 'quiza', 'no', 'none', 'privado'] as const;
type SFilter = (typeof S_FILTERS)[number];
const S_SORTS = ['coincidencia', 'envio', 'respuesta', 'interes', 'propia', 'tmdb'] as const;
type SSort = (typeof S_SORTS)[number];
const THEIR_RANK = (t: ReturnType<typeof theirState>) => (t.kind === 'answer' ? { mucho: 5, si: 4, quiza: 3, no: 1 }[t.v] : t.kind === 'none' ? 2 : 0);
interface SentGroup { id: string; recipient: string; key: TitleKey; createdAt: number; firstAt: number; count: number; title?: string; year?: number; comment?: string }

function SentList() {
  const { profileId, settings } = useApp();
  const s = useSocial();
  const P = `cine-match:compartidas:enviadas:${profileId}`;
  const [filter, setFilter] = usePersistentState<SFilter>(`${P}:filter`, 'todas', oneOf(S_FILTERS));
  const [sort, setSort] = usePersistentState<SSort>(`${P}:sort`, 'coincidencia', oneOf(S_SORTS));
  const [to, setTo] = usePersistentState<string>(`${P}:to`, 'all');
  const [type, setType] = usePersistentState<'all' | MediaType>(`${P}:type`, 'all', oneOf(['all', 'movie', 'tv'] as const));
  const [plat, setPlat] = usePersistentState<string>(`${P}:plat`, 'all');
  const [seen, setSeen] = usePersistentState<'all' | 'vistas' | 'no-vistas'>(`${P}:seen`, 'all', oneOf(['all', 'vistas', 'no-vistas'] as const));
  // Un envío por destinatario y título (reenvíos explícitos se cuentan)
  const groups = useMemo(() => {
    const m = new Map<string, SentGroup>();
    for (const x of s.sent as SentRec[]) {
      const g = m.get(`${x.recipient}|${x.key}`);
      if (!g) m.set(`${x.recipient}|${x.key}`, { id: x.id, recipient: x.recipient, key: x.key, createdAt: x.createdAt, firstAt: x.createdAt, count: 1, title: x.title, year: x.year, comment: x.comment });
      else { g.count++; if (x.createdAt > g.createdAt) Object.assign(g, { id: x.id, createdAt: x.createdAt, comment: x.comment ?? g.comment }); g.firstAt = Math.min(g.firstAt, x.createdAt); }
    }
    return [...m.values()];
  }, [s.sent]);
  const keys = useMemo(() => [...new Set(groups.map((g) => g.key))], [groups]);
  const { titles, preds, loaded, rs, retryKey } = useCardData(keys);
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);
  const mine = useMyAnswers(profileId);
  const contactOf = (id: string) => s.contacts.find((c) => c.id === id && c.linked && !c.blocked);
  const recipients = [...new Set(groups.map((g) => g.recipient))].map((id) => [id, s.contacts.find((c) => c.id === id)?.alias ?? 'Contacto anterior'] as const);
  const their = (g: SentGroup) => { const c = contactOf(g.recipient); return c ? theirState(g.key, c) : ({ kind: 'private', why: 'theirs' } as const); };
  const level = (g: SentGroup) => levelOf(g.key, contactOf(g.recipient), mine.get(g.key), Boolean(s.wantMatches[g.recipient]?.includes(g.key)));

  const visible = groups.filter((g) => {
    const t = their(g);
    if (filter === 'positivas' && !isPositive(level(g))) return false;
    if (['mucho', 'si', 'quiza', 'no'].includes(filter) && !(t.kind === 'answer' && t.v === filter)) return false;
    if (filter === 'none' && t.kind !== 'none') return false;
    if (filter === 'privado' && t.kind !== 'private') return false;
    if (to !== 'all' && g.recipient !== to) return false;
    if (type !== 'all' && !g.key.startsWith(type)) return false;
    const rt = rs.byKey.get(g.key);
    if (seen === 'vistas' && !rt?.watched) return false;
    if (seen === 'no-vistas' && rt?.watched) return false;
    if (plat !== 'all') { const d = titles.get(g.key); const st = availabilityState(d && d !== 'error' ? d.snap : undefined); if (st.kind !== 'confirmed' || !st.platforms.includes(plat as PlatformId)) return false; }
    return true;
  });
  const orderSig = `${sort}|${filter}|${to}|${type}|${plat}|${seen}|${visible.map((g) => g.id).sort().join(',')}|${preds.size}|${loaded.length}|${sort === 'envio' ? '' : s.shared.map((x) => `${x.key}${x.answer}`).join(',')}`;
  const order = useMemo(() => {
    const RANK: Record<MatchLevel, number> = { maxima: 9, muy_alta: 8, alta: 7, ambos: 6, posible: 5, posible_baja: 4, pendiente: 3, privado: 2, sin: 1 };
    const val = (g: SentGroup): number => {
      const t = their(g);
      if (sort === 'coincidencia') return RANK[level(g)] * 10 + THEIR_RANK(t);
      if (sort === 'respuesta') return t.kind === 'answer' ? t.at ?? 1 : 0;
      if (sort === 'interes') return THEIR_RANK(t);
      if (sort === 'propia') { const p = preds.get(g.key); return p && personalState(p).kind !== 'insufficient' ? p.score : -1; }
      if (sort === 'tmdb') { const d = titles.get(g.key); return d && d !== 'error' ? publicScore(d.meta) ?? -1 : -1; }
      return g.createdAt;
    };
    return [...visible].sort((a, b) => val(b) - val(a) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).map((g) => g.id);
  }, [orderSig]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  useTabScroll('enviadas', order.length > 0 && loaded.length > 0);
  const answered = groups.filter((g) => their(g).kind === 'answer').length;
  const positives = groups.filter((g) => isPositive(level(g))).length;
  const pending = groups.filter((g) => their(g).kind === 'none').length;
  const priv = groups.filter((g) => their(g).kind === 'private').length;

  return (
    <div className="space-y-3">
      {!s.reachable && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" data-testid="social-offline">Sin conexión con el servicio social: se muestran las últimas respuestas conocidas.</p>}
      <div className="grid grid-cols-3 gap-1.5 text-center" data-testid="sent-summary">
        <div className="rounded-lg bg-ink-900 px-1 py-1.5 ring-1 ring-white/5"><div className="text-lg font-extrabold text-slate-100" data-testid="sent-count">{groups.length}</div><div className="text-[10px] text-slate-400">enviadas</div></div>
        <div className="rounded-lg bg-ink-900 px-1 py-1.5 ring-1 ring-white/5"><div className="text-lg font-extrabold text-sky-300" data-testid="sent-answered">{answered}</div><div className="text-[10px] text-slate-400">respuestas</div></div>
        <div className="rounded-lg bg-ink-900 px-1 py-1.5 ring-1 ring-white/5"><div className="text-lg font-extrabold text-emerald-300" data-testid="sent-positive">{positives}</div><div className="text-[10px] text-slate-400">coincidencias +</div></div>
      </div>
      {(pending > 0 || priv > 0) && <p className="text-[11px] text-slate-500" data-testid="sent-note">{pending > 0 && <>{pending} sin responder. </>}{priv > 0 && <>{priv} con interés privado (no autorizado: no significa falta de interés).</>}</p>}
      <div className="flex flex-wrap gap-1.5" data-testid="sent-filters">
        {([['todas', 'Todas'], ['positivas', 'Coincidencias +'], ['mucho', `${ANSWER_STYLE.mucho.icon} Muchas ganas`], ['si', `${ANSWER_STYLE.si.icon} Me interesa`], ['quiza', '? Podría'], ['no', `${ANSWER_STYLE.no.icon} No`], ['none', 'Sin responder'], ['privado', 'Privado']] as const).map(([id, l]) => (
          <Chip key={id} active={filter === id} onClick={() => setFilter(id)} testId={`sent-filter-${id}`}>{l}</Chip>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <select aria-label="Contacto" data-testid="sent-to" value={to} onChange={(e) => setTo(e.target.value)} className={sel}><option value="all">Todos</option>{recipients.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={sel}><option value="all">Todo tipo</option><option value="movie">Películas</option><option value="tv">Series</option></select>
        <select aria-label="Orden" data-testid="sent-sort" value={sort} onChange={(e) => setSort(e.target.value as SSort)} className={sel}>
          <option value="coincidencia">Coincidencia</option><option value="envio">Envíos recientes</option><option value="respuesta">Respuestas recientes</option><option value="interes">Interés de quien recibe</option><option value="propia">Mi puntuación</option><option value="tmdb">TMDB</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <select aria-label="Plataforma" value={plat} onChange={(e) => setPlat(e.target.value)} className={sel}><option value="all">Plataformas</option>{PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <select aria-label="Vistas" value={seen} onChange={(e) => setSeen(e.target.value as typeof seen)} className={sel}><option value="all">Vistas y no vistas</option><option value="vistas">Vistas</option><option value="no-vistas">No vistas</option></select>
      </div>
      {!groups.length && <Empty>Todavía no recomendaste nada. Usá «Compartir» en cualquier tarjeta y vas a ver acá qué le interesó a cada contacto.</Empty>}
      {groups.length > 0 && !order.length && <Empty>No hay envíos con estos filtros.</Empty>}
      <ul className="space-y-4" data-testid="sent-list">
        {order.map((id) => {
          const g = byId.get(id);
          if (!g) return null;
          const c = contactOf(g.recipient);
          const who = s.contacts.find((x) => x.id === g.recipient)?.alias ?? 'Contacto anterior';
          const t = titles.get(g.key);
          const th = their(g);
          return (
            <li key={g.id} data-testid="sent-item" data-key={g.key} data-to={who} data-level={level(g)} data-their={th.kind === 'answer' ? th.v : th.kind} className="space-y-1.5">
              <div className="px-1" data-testid="sent-header">
                <p className="truncate text-sm font-bold text-sky-200">Para <span data-testid="sent-to-name">{who}</span></p>
                <p className="text-[11px] text-slate-400">Enviada {whenLabel(g.createdAt)}{g.count > 1 ? ` · ${g.count} envíos` : ''}{!c ? ' · ya no es tu contacto' : ''}</p>
                {g.comment && <p className="mt-1 whitespace-pre-line break-words rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-[13px] italic text-sky-100" data-testid="sent-comment">«{g.comment}»</p>}
              </div>
              {t && t !== 'error' ? (
                <ul>
                  <TitleCard k={g.key} meta={t.meta} snap={t.snap} rating={rs.byKey.get(g.key)} info={myInfo(preds.get(g.key), who)} profileId={profileId} testId="sent-card" sharedContact={c ? g.recipient : undefined}
                    interest={{ value: interests?.get(g.key)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, g.key, a, { engine: 'enviadas', source: 'enviadas' }), 'tu respuesta'); } }} />
                </ul>
              ) : <LoadingCard title={g.title ?? 'Título'} year={g.year} error={t === 'error'} onRetry={() => retryKey(g.key)} />}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-slate-500">Sólo ves la respuesta de quien autorizó compartir intereses con vos (y vos con esa persona). No se muestra cuándo abrió la app ni si vio la recomendación.</p>
    </div>
  );
}

