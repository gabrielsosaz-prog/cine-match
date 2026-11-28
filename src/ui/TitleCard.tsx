/**
 * v4.1 · Tarjeta común de recomendación (Inicio / Para vos, Similares, Quiero ver y, desde v4.2, Me recomendaron y Para ver juntos).
 * v4.2: la cuadrícula de acciones pasa de 2 × 2 a 3 × 2 (suma Compartir y el acceso directo a Aspectos); el resto no cambia.
 *
 * Sólo interfaz: no calcula puntajes ni cambia el orden. Cada pantalla le pasa los datos de SU contexto (motor elegido,
 * similitud o lista) ya calculados; la tarjeta no inventa sinopsis, explicaciones ni puntajes.
 *
 * Guardado: usa las mismas funciones de siempre (`rateAndLearn`, `setWatched`, `setNotInterested`, `recordInterest`),
 * sin cambios de esquema. «Quiero verla» es la lista `want` del registro del título (la misma que usa la ficha).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { COMMENT_MAX, DIMENSIONS, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { friendlyError } from '../providers/errors';
import { availabilityState } from '../services/availability';
import { peekFullTitle } from '../services/catalog';
import { getNarrativeIndex } from '../services/narrativeCatalog';
import { countriesOf, countryName } from '../services/filters';
import { safely } from '../services/notices';
import { rateAndLearn, setNotInterested, setWatched } from '../services/ratings';
import { findTrailers, needsExternalSearch, type TrailerChoice } from '../services/trailers';
import type { AvailabilitySnapshot, DimensionId, DimensionScores, InterestAnswer, Rating, TitleKey, TitleMeta } from '../types';
import { Poster, publicScore, StarRow, TitleLink } from './components';
import { num, relTime } from './format';
import { TrailerModal, YouTubeSearchLink } from './Trailer';
import ShareAction from './ShareAction';
import { InterestButtons, SharedInterests } from './SharedInterests';

export interface SimilarRef { key?: TitleKey; title: string; note?: string }
export interface CardInfo {
  /** Indicador de compatibilidad del contexto (texto verde). Sin dato, no se muestra. */
  compat?: string;
  /** Recuadro dorado: nombre del indicador (p. ej. «Satisfacción» en v4.0, «Para vos» en v3.4/v3.5) y valor. */
  primaryLabel: string;
  primary?: number;
  /** Explicación personalizada («Por tu perfil»). Vacía = no se muestra. */
  why?: string[];
  whyTitle?: string;
  similar?: SimilarRef[];
  /** Explicación breve de lo que tiene en común con las referencias, cuando no hay una por título */
  similarNote?: string;
  cons?: string[];
  reliability?: string[];
  /** Marcas pequeñas bajo la compatibilidad (exploración, provisional, nueva estimación…) */
  badges?: ReactNode;
  /** Contenido adicional al principio de «Más información» (p. ej. diagnóstico) */
  moreExtra?: ReactNode;
}
export interface InterestCtx {
  value?: InterestAnswer;
  onPick: (a: InterestAnswer) => void;
}

const SYNOPSIS_SHORT = 200;
/** Fichas completas pedidas sólo para mostrar (una vez por sesión y título; null = TMDB no respondió). */
const fullCache = new Map<TitleKey, Promise<TitleMeta | null>>();
/**
 * Completa la ficha (sinopsis en español, dirección, países) cuando la tarjeta se acerca a la pantalla. No la guarda en
 * el catálogo local: lo que se mira no cambia los datos con que se calcula el próximo ranking.
 */
function useFullMeta(base: TitleMeta, near: boolean): { meta: TitleMeta; loading: boolean } {
  const { settings } = useApp();
  const [got, setGot] = useState<{ key: TitleKey; meta: TitleMeta | null }>();
  const needs = base.completeness !== 'full';
  useEffect(() => {
    if (!near || !needs) return;
    let alive = true;
    let p = fullCache.get(base.key);
    if (!p) { p = peekFullTitle(base.key, { language: settings.language, country: settings.country }).then((m) => m ?? null, () => null); fullCache.set(base.key, p); }
    p.then((m) => { if (alive) setGot({ key: base.key, meta: m }); });
    return () => { alive = false; };
  }, [near, needs, base.key]);
  if (!needs) return { meta: base, loading: false };
  const mine = got?.key === base.key ? got : undefined;
  return { meta: mine?.meta ?? base, loading: !mine };
}
/** true cuando la tarjeta está cerca de la pantalla (carga progresiva). */
function useNear(ref: React.RefObject<HTMLElement>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '600px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return near;
}

let langNames: Intl.DisplayNames | undefined;
export function languageName(code?: string) {
  if (!code) return undefined;
  try { langNames ??= new Intl.DisplayNames(['es'], { type: 'language' }); const n = langNames.of(code); return n ? n.charAt(0).toUpperCase() + n.slice(1) : code; } catch { return code; }
}
export function durationText(meta: TitleMeta): string | undefined {
  if (meta.type === 'tv') {
    if (meta.numberOfSeasons) return `${meta.numberOfSeasons} ${meta.numberOfSeasons === 1 ? 'temporada' : 'temporadas'}`;
    return meta.runtime ? `${meta.runtime} min/ep.` : undefined;
  }
  if (!meta.runtime) return undefined;
  const h = Math.floor(meta.runtime / 60), m = meta.runtime % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
export function shortSynopsis(text: string, max = SYNOPSIS_SHORT): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:.]+$/, '')}…`;
}

const Icon = {
  bookmark: (filled: boolean) => (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
  ),
  play: <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>,
  eye: (on: boolean) => on
    ? <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12.5l5 5L20 6.5" /></svg>
    : <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  aspects: <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  star: <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="currentColor"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" /></svg>,
};

const btn = 'flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2 text-[13px] font-semibold leading-tight';
const neutral = `${btn} bg-ink-800 text-slate-200 ring-1 ring-white/10`;
/** v4.2: celdas de la cuadrícula 3 × 2 (ícono arriba y texto compacto; entran en 360 px con 52 px de alto) */
const gbtn = 'flex min-h-[52px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[12px] font-semibold leading-tight';
const gneutral = `${gbtn} bg-ink-800 text-slate-200 ring-1 ring-white/10`;

export default function TitleCard({ k, meta: baseMeta, snap, rating, rank, info, interest, profileId, track, onTouch, actionsExtra, testId = 'rec-item', interestTestPrefix = 'interest', sharedContact }: {
  k: TitleKey; meta: TitleMeta; snap?: AvailabilitySnapshot | null; rating?: Rating; rank?: number; info: CardInfo; interest?: InterestCtx;
  profileId: string; track?: (p: Promise<unknown>) => void; onTouch?: (k: TitleKey) => void; actionsExtra?: ReactNode; testId?: string; interestTestPrefix?: string;
  /** v4.3 · Fija el contacto del bloque «Intereses compartidos» (Enviadas, Recibidas, Para ver juntos) */
  sharedContact?: string;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const near = useNear(ref);
  const [moreOpen, setMoreOpen] = useState(false);
  const { meta, loading: metaLoading } = useFullMeta(baseMeta, near || moreOpen);
  const [panel, setPanel] = useState<'score' | 'aspects' | 'comment'>();
  const [longText, setLongText] = useState(false);
  const [aspectsAt, setAspectsAt] = useState<'grid' | 'more'>('grid');
  const dimCount = rating ? Object.keys(rating.dimensions).length : 0;
  const watched = Boolean(rating?.watched);
  const saved = rating?.list === 'want' || rating?.list === 'watching';
  const dismissed = Boolean(rating?.notInterested);
  const run = (fn: () => Promise<unknown>, what: string) => { onTouch?.(k); const p = safely(fn, what); track?.(p); return p; };
  const pub = publicScore(meta);
  const st = availabilityState(snap);
  const dur = durationText(meta);
  const overview = meta.overview && meta.overviewLang !== 'en' ? meta.overview : undefined;

  // Tráiler: se consulta sólo al pedirlo (caché de findTrailers); el reproductor se monta sólo mientras está abierto
  const [tr, setTr] = useState<{ busy?: boolean; list?: TrailerChoice[]; error?: string; open?: number }>({});
  const openTrailer = async () => {
    onTouch?.(k);
    if (tr.list?.length) { setTr({ ...tr, open: 0 }); return; }
    setTr({ busy: true });
    try { const list = await findTrailers(k, meta.originalLanguage); setTr({ list, open: list.length ? 0 : undefined }); }
    catch (e) { setTr({ error: friendlyError(e) }); }
  };

  const closeIfSaved = (r: unknown) => { if (r !== undefined) setPanel(undefined); return r; };
  const collapse = () => {
    setMoreOpen(false); setPanel(undefined);
    // Si el final de la tarjeta queda fuera de la pantalla al cerrar, se vuelve al comienzo de esta tarjeta
    requestAnimationFrame(() => { const r = ref.current?.getBoundingClientRect(); if (r && r.top < 0) ref.current!.scrollIntoView({ block: 'start' }); });
  };

  return (
    <li ref={ref} className="rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5 [overflow-anchor:none]" data-testid={testId} data-key={k} data-dismissed={dismissed} data-card="v41">
      {/* Encabezado */}
      <div className="flex gap-3">
        <TitleLink k={k} className="shrink-0"><Poster path={meta.posterPath} title={meta.title} className="h-[132px] w-[88px]" /></TitleLink>
        <div className="min-w-0 flex-1">
          <TitleLink k={k} className="line-clamp-2 block text-[15px] font-bold leading-tight text-slate-50">{rank !== undefined && <span className="mr-1 text-slate-500" data-testid="card-rank">#{rank}</span>}<h3 className="inline">{meta.title}</h3></TitleLink>
          <p className="mt-0.5 truncate text-xs text-slate-400" data-testid="card-meta">{[meta.year, meta.type === 'movie' ? 'Película' : 'Serie', dur].filter(Boolean).join(' · ')}</p>
          <p className="mt-0.5 text-[11px] leading-snug" data-testid="card-platforms">
            {st.kind === 'confirmed'
              ? <>{st.platforms.map((p, i) => { const pl = PLATFORMS.find((x) => x.id === p)!; return <span key={p}>{i > 0 && <span className="text-slate-600"> · </span>}<span className="font-semibold" style={{ color: platformText(pl.color) }}>{pl.label}</span></span>; })}{st.stale && <span className="text-amber-300"> · ⚠ desactualizada</span>}</>
              : st.kind === 'not_on_platforms' ? <span className="text-slate-500">No figura en tus plataformas</span>
                : st.kind === 'no_data' ? <span className="text-amber-300">Sin datos de disponibilidad</span>
                  : <span className="text-amber-300">Disponibilidad no confirmada</span>}
          </p>
          {info.compat && <p className="mt-0.5 text-xs font-semibold text-emerald-400" data-testid="card-compat">{info.compat}</p>}
          {info.badges && <div className="mt-0.5 flex flex-wrap gap-1 text-[10px]">{info.badges}</div>}
          <div className="mt-1.5 grid grid-cols-2 gap-1.5" data-testid="score-boxes">
            <div className="rounded-lg px-2 py-1" style={{ background: '#302519' }} data-testid="box-primary" data-label={info.primaryLabel}>
              <div className="truncate text-[10px] font-medium" style={{ color: '#E8CF9C' }}>{info.primaryLabel}</div>
              <div className="text-xl font-extrabold leading-tight" style={{ color: '#FFBB38' }}>{info.primary !== undefined ? num(info.primary) : '–'}</div>
            </div>
            <div className="rounded-lg px-2 py-1" style={{ background: '#142D3B' }} data-testid="score-public">
              <div className="text-[10px] font-medium" style={{ color: '#9FDDF2' }}>TMDB</div>
              <div className="text-xl font-extrabold leading-tight" style={{ color: '#45D0FF' }}>{pub !== undefined ? num(pub) : '–'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Cuerpo: sinopsis y explicación */}
      <div className="mt-2.5 space-y-2 text-[13px] leading-snug">
        <div data-testid="card-synopsis">
          {overview ? (
            <p className="text-slate-300">
              {longText || overview.length <= SYNOPSIS_SHORT ? overview : shortSynopsis(overview)}
              {overview.length > SYNOPSIS_SHORT && (
                <button type="button" className="ml-1 font-semibold text-accent" data-testid="synopsis-more" onClick={() => { onTouch?.(k); setLongText(!longText); }}>{longText ? 'Leer menos' : 'Leer más'}</button>
              )}
            </p>
          ) : metaLoading && near ? <p className="text-xs text-slate-500" data-testid="synopsis-loading">Cargando sinopsis…</p>
            : <p className="text-xs italic text-slate-500" data-testid="synopsis-none">{meta.overviewLang === 'en' ? 'TMDB no tiene la sinopsis en español.' : 'Sinopsis no disponible.'}</p>}
        </div>
        {info.why && info.why.length > 0 && (
          <div data-testid="card-why">
            <p className="text-xs font-bold text-emerald-400">{info.whyTitle ?? 'Por tu perfil'}</p>
            {info.why.map((l, i) => <p key={i} className="text-xs text-slate-300">{l}</p>)}
          </div>
        )}
      </div>

      {dismissed && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-200" data-testid="dismissed-note">
          <span className="flex-1">Descartada: no se va a recomendar.</span>
          <button type="button" data-testid="undo-not-interested" className="font-semibold underline" onClick={() => run(() => setNotInterested(profileId, k, false), 'el cambio')}>Deshacer</button>
        </div>
      )}

      {/* v4.2 · Acciones principales 3 × 2 (alternativa C): Tráiler · Quiero verla · Compartir / Ya la vi · Puntuar · Aspectos */}
      <div className="mt-2.5 grid grid-cols-3 gap-1.5" role="group" aria-label={`Acciones para ${meta.title}`} data-testid="card-actions" data-grid="3x2">
        <button type="button" className={gneutral} data-testid="trailer-button" onClick={openTrailer} disabled={tr.busy}>{Icon.play}<span className="max-w-full truncate">{tr.busy ? 'Buscando…' : 'Tráiler'}</span></button>
        <button type="button" data-testid="quick-want" aria-pressed={saved}
          onClick={() => run(() => rateAndLearn(profileId, k, { list: saved ? null : 'want' }), saved ? 'el cambio en «Quiero ver»' : '«Quiero verla»')}
          className={`${gbtn} ${saved ? 'ring-1 ring-emerald-500/40' : ''}`} style={saved ? { background: '#123222', color: '#4ADE80' } : { background: '#F4B83F', color: '#1A1205' }}>
          {Icon.bookmark(saved)}<span className="max-w-full truncate">{saved ? 'Guardada' : 'Quiero verla'}</span>
        </button>
        <ShareAction target={{ k, title: meta.title, year: meta.year, posterPath: meta.posterPath }} />
        <button type="button" data-testid="quick-watched" aria-pressed={watched} onClick={() => run(() => setWatched(profileId, k, !watched), 'la marca de vista')}
          className={watched ? `${gbtn} bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/40` : gneutral}>
          {Icon.eye(watched)}<span className="max-w-full truncate">{watched ? 'Vista' : 'Ya la vi'}</span>
        </button>
        <button type="button" data-testid="quick-score" aria-expanded={panel === 'score'} onClick={() => { onTouch?.(k); setPanel(panel === 'score' ? undefined : 'score'); }}
          className={panel === 'score' ? `${gbtn} bg-accent text-ink-950` : gneutral}>
          <span style={panel === 'score' ? undefined : { color: '#FFBB38' }}>{Icon.star}</span><span className="max-w-full truncate">{rating?.overall !== undefined ? <>Tu nota {num(rating.overall, rating.overall % 1 ? 1 : 0)}</> : 'Puntuar'}</span>
        </button>
        <button type="button" data-testid="quick-aspects-grid" aria-expanded={panel === 'aspects' && aspectsAt === 'grid'}
          onClick={() => { onTouch?.(k); setAspectsAt('grid'); setPanel(panel === 'aspects' && aspectsAt === 'grid' ? undefined : 'aspects'); }}
          className={panel === 'aspects' && aspectsAt === 'grid' ? `${gbtn} bg-accent text-ink-950` : gneutral}>
          {Icon.aspects}<span className="max-w-full truncate">Aspectos{dimCount ? ` ${dimCount}/${DIMENSIONS.length}` : ''}</span>
        </button>
      </div>
      {watched && <p className="mt-1 text-[11px] text-slate-500" data-testid="watched-hint">Marcada como vista. Tocá «Vista» para deshacerlo; tus notas no cambian.</p>}
      {(tr.list && !tr.list.length) && <p className="mt-1 text-xs text-slate-400" role="status" data-testid="trailer-none">TMDB no informa un tráiler para este título.</p>}
      {tr.error && <p className="mt-1 text-xs text-rose-300" role="status" data-testid="trailer-error">No se pudo buscar el tráiler: {tr.error}</p>}
      {tr.list && needsExternalSearch(tr.list) && <div className="mt-1.5"><YouTubeSearchLink title={meta.title} year={meta.year} compact /></div>}
      {tr.open !== undefined && tr.list?.[tr.open] && (
        <TrailerModal choice={tr.list[tr.open]} versions={tr.list} onPick={(i) => setTr((s) => ({ ...s, open: i }))} onClose={() => setTr((s) => ({ ...s, open: undefined }))} search={{ title: meta.title, year: meta.year }} />
      )}
      {panel === 'aspects' && aspectsAt === 'grid' && <AspectsPanel value={rating?.dimensions ?? {}} onSave={(d) => run(() => rateAndLearn(profileId, k, { dimensions: d }), 'los aspectos').then(closeIfSaved)} />}
      {panel === 'score' && <ScorePanel current={rating?.overall} onSave={(v) => run(() => rateAndLearn(profileId, k, { overall: v, watched: true }), 'la valoración').then(closeIfSaved)} onCancel={() => setPanel(undefined)} />}

      {/* Respuestas de interés (antes de verla). «Ya la vi» está en las acciones principales. */}
      {/* v4.3 · Intereses compartidos (sólo si el título está intercambiado con algún contacto) */}
      <SharedInterests k={k} profileId={profileId} rating={rating} contactId={sharedContact} />
      {interest && <InterestButtons value={interest.value} title={meta.title} testPrefix={interestTestPrefix} onPick={(a) => { onTouch?.(k); interest.onPick(a); }} />}
      {actionsExtra}

      {/* Más información y acciones */}
      {!moreOpen ? (
        <button type="button" data-testid="more-toggle" aria-expanded={false} onClick={() => { onTouch?.(k); setMoreOpen(true); }}
          className="mt-2 flex w-full items-center justify-between rounded-lg px-1 py-2 text-left text-[13px] font-semibold text-slate-300">
          Más información y acciones <span aria-hidden="true">▾</span>
        </button>
      ) : (
        <div className="mt-2 space-y-3 border-t border-white/10 pt-2.5 text-[13px]" data-testid="more-panel">
          <Section title="Parecida a" testId="more-similar">
            {info.similar?.length ? (
              <ul className="space-y-1.5">
                {info.similar.map((s, i) => <SimilarRow key={s.key ?? i} s={s} />)}
              </ul>
            ) : <p className="text-xs text-slate-500">Sin títulos de referencia para este cálculo.</p>}
            {info.similarNote && <p className="mt-1 text-xs text-slate-400">{info.similarNote}</p>}
          </Section>
          <Section title="Qué podría no gustarte" tone="#FDBA74" testId="more-cons">
            {info.cons?.length ? info.cons.map((c, i) => <p key={i} className="text-xs text-slate-300">{c}</p>) : <p className="text-xs text-slate-500">Sin datos que indiquen algo que podría no gustarte.</p>}
          </Section>
          <Section title="Información técnica" testId="more-tech">
            <TechGrid meta={meta} snap={snap} loading={metaLoading} />
          </Section>
          {info.reliability && info.reliability.length > 0 && (
            <Section title="Fiabilidad" testId="more-reliability">
              {info.reliability.map((l, i) => <p key={i} className="text-xs text-amber-200/90">{l}</p>)}
            </Section>
          )}
          {info.moreExtra}
          <div>
            <button type="button" data-testid="quick-aspects" aria-expanded={panel === 'aspects' && aspectsAt === 'more'} onClick={() => { setAspectsAt('more'); setPanel(panel === 'aspects' && aspectsAt === 'more' ? undefined : 'aspects'); }} className={`${neutral} w-full`}>
              {Icon.star}Puntuar aspectos{rating && Object.keys(rating.dimensions).length ? ` · ${Object.keys(rating.dimensions).length}/${DIMENSIONS.length}` : ''}
            </button>
            {panel === 'aspects' && aspectsAt === 'more' && <AspectsPanel value={rating?.dimensions ?? {}} onSave={(d) => run(() => rateAndLearn(profileId, k, { dimensions: d }), 'los aspectos').then(closeIfSaved)} />}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" data-testid="card-comment" aria-expanded={panel === 'comment'} onClick={() => setPanel(panel === 'comment' ? undefined : 'comment')} className={neutral}>
              Comentario{rating?.comment ? ' ✓' : ''}
            </button>
            <TitleLink k={k} className={neutral}><span data-testid="card-open">Ver ficha</span></TitleLink>
          </div>
          {panel === 'comment' && <CommentPanel profileId={profileId} k={k} value={rating?.comment ?? ''} onSave={(c) => run(() => rateAndLearn(profileId, k, { comment: c }), 'el comentario').then(closeIfSaved)} />}
          <button type="button" data-testid="more-close" onClick={collapse} className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-[13px] font-semibold text-slate-400">Mostrar menos <span aria-hidden="true">▴</span></button>
        </div>
      )}
    </li>
  );
}

/** Colores de marca aclarados para leerse sobre fondo oscuro en texto chico. */
function platformText(hex: string) {
  const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * 0.35);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function Section({ title, children, tone = '#4ADE80', testId }: { title: string; children: ReactNode; tone?: string; testId: string }) {
  return <section data-testid={testId}><h4 className="mb-1 text-xs font-bold" style={{ color: tone }}>{title}</h4>{children}</section>;
}

function SimilarRow({ s }: { s: SimilarRef }) {
  const m = useLiveQuery(() => (s.key ? db.titles.get(s.key) : undefined), [s.key]);
  // Sin ficha local: póster del catálogo narrativo ya cargado (sin pedir nada a TMDB)
  const poster = m?.posterPath ?? (s.key ? getNarrativeIndex()?.get(s.key)?.poster : undefined);
  const body = (
    <>
      {poster ? <Poster path={poster} title={s.title} size="w92" className="h-12 w-8 shrink-0" /> : <span className="h-12 w-8 shrink-0 rounded-md bg-ink-700" aria-hidden="true" />}
      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-slate-100">{s.title}</span>{s.note && <span className="block text-[11px] leading-snug text-slate-400">{s.note}</span>}</span>
    </>
  );
  return <li data-testid="similar-ref-row">{s.key ? <TitleLink k={s.key} className="flex items-center gap-2">{body}</TitleLink> : <div className="flex items-center gap-2">{body}</div>}</li>;
}

function TechGrid({ meta, snap, loading }: { meta: TitleMeta; snap?: AvailabilitySnapshot | null; loading?: boolean }) {
  const genres = meta.genres.filter((g) => !/^Género \d+$/.test(g.name)).map((g) => g.name);
  const people = meta.directors.map((d) => d.name).slice(0, 3);
  const countries = countriesOf(meta).map(countryName);
  const missing = loading ? 'Cargando…' : 'Sin datos';
  const rows: [string, string][] = [
    ['Géneros', genres.join(', ') || missing],
    [meta.type === 'tv' ? 'Creación' : 'Dirección', people.join(', ') || missing],
    ['País', countries.join(', ') || missing],
    ['Idioma original', languageName(meta.originalLanguage) ?? 'Sin datos'],
  ];
  const st = availabilityState(snap);
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {rows.map(([l, v]) => <div key={l} className="min-w-0"><dt className="text-[10px] uppercase tracking-wide text-slate-500">{l}</dt><dd className="break-words text-xs text-slate-200">{v}</dd></div>)}
      </dl>
      {'checkedAt' in st && st.checkedAt && <p className="mt-1 text-[10px] text-slate-500">Disponibilidad: TMDB / JustWatch, verificada {relTime(st.checkedAt)}.</p>}
    </>
  );
}

function ScorePanel({ current, onSave, onCancel }: { current?: number; onSave: (v: number) => Promise<unknown>; onCancel: () => void }) {
  const [v, setV] = useState<number | undefined>(current);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 rounded-xl bg-ink-950/70 p-2.5 ring-1 ring-white/10" data-testid="quick-score-row">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-slate-400">Valoración general (1-10){current !== undefined ? ' · podés editarla' : ''}</span>
        <span className="text-4xl font-extrabold leading-none" style={{ color: '#FFBB38' }} data-testid="score-big">{v !== undefined ? num(v, v % 1 ? 1 : 0) : '–'}</span>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" aria-label={`Nota general ${n}`} aria-pressed={v === n} onClick={() => setV(n)}
            className={`h-10 rounded-lg text-sm font-bold ${v !== undefined && n <= v ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300'}`}>{n}</button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" data-testid="score-save" disabled={v === undefined || busy || v === current} onClick={async () => { setBusy(true); try { await onSave(v!); } finally { setBusy(false); } }}
          className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-bold text-ink-950 disabled:opacity-40">{busy ? 'Guardando…' : 'Guardar valoración'}</button>
        <button type="button" onClick={onCancel} className="rounded-xl bg-ink-800 px-3 text-sm ring-1 ring-white/10">Cancelar</button>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">Al guardar se marca como vista. El orden de la lista no cambia hasta «Actualizar ranking».</p>
    </div>
  );
}

function AspectsPanel({ value, onSave }: { value: DimensionScores; onSave: (d: DimensionScores) => Promise<unknown> }) {
  const [d, setD] = useState<DimensionScores>(value);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(value);
  return (
    <div className="mt-2 rounded-xl bg-ink-950/70 p-2 ring-1 ring-white/10" data-testid="aspects-panel">
      {DIMENSIONS.map((x) => (
        <StarRow key={x.id} label={x.label} value={d[x.id]} testId={`dim-${x.id}`}
          onChange={(v) => setD((p) => { const n = { ...p }; if (v === undefined) delete n[x.id as DimensionId]; else n[x.id as DimensionId] = v; return n; })} />
      ))}
      <button type="button" data-testid="aspects-save" disabled={!dirty || busy} onClick={async () => { setBusy(true); try { await onSave(d); } finally { setBusy(false); } }}
        className="mt-1 w-full rounded-xl bg-accent py-2.5 text-sm font-bold text-ink-950 disabled:opacity-40">{busy ? 'Guardando…' : 'Guardar aspectos'}</button>
    </div>
  );
}

const commentDraftKey = (profileId: string, k: TitleKey) => `cine-match:card-comment:${profileId}|${k}`;
function CommentPanel({ profileId, k, value, onSave }: { profileId: string; k: TitleKey; value: string; onSave: (c: string) => Promise<unknown> }) {
  // El texto sin guardar queda como borrador en el dispositivo (se recupera al volver a abrir)
  const [c, setC] = useState(() => { try { return localStorage.getItem(commentDraftKey(profileId, k)) ?? value; } catch { return value; } });
  const [busy, setBusy] = useState(false);
  const write = (t: string) => { setC(t); try { if (t === value) localStorage.removeItem(commentDraftKey(profileId, k)); else localStorage.setItem(commentDraftKey(profileId, k), t); } catch { /* sin almacenamiento */ } };
  return (
    <div className="rounded-xl bg-ink-950/70 p-2 ring-1 ring-white/10" data-testid="comment-panel">
      <label className="block text-xs text-slate-300">Otros: ¿Qué te gustó o no te gustó?
        <textarea value={c} maxLength={COMMENT_MAX} rows={3} onChange={(e) => write(e.target.value)} data-testid="comment"
          className="mt-1 w-full rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10" />
      </label>
      <button type="button" data-testid="comment-save" disabled={busy || c.trim() === value.trim()}
        onClick={async () => { setBusy(true); try { if ((await onSave(c)) !== undefined) { try { localStorage.removeItem(commentDraftKey(profileId, k)); } catch { /* */ } } } finally { setBusy(false); } }}
        className="mt-1 w-full rounded-xl bg-accent py-2.5 text-sm font-bold text-ink-950 disabled:opacity-40">{busy ? 'Guardando…' : 'Guardar comentario'}</button>
      <p className="mt-1 text-[10px] text-slate-500">Se guarda y se analiza sólo en este dispositivo.</p>
    </div>
  );
}
