import BackupReminder from '../ui/BackupReminder';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIMENSIONS, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { useRatings } from '../hooks/useRatings';
import { useApp } from '../hooks/useApp';
import { useRecommendations } from '../hooks/useRecs';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { ENGINE_LABEL, engineFor, hintsFromFilters, rankWithFilters } from '../services/recommendations';
import { TrailerButton } from '../ui/Trailer';
import { rateAndLearn, setNotInterested, setWatched } from '../services/ratings';
import { activeFilters, filterLabel, includedPeople, loadFilters, saveFilters, without, type RankFilters, type WatchedFilter } from '../services/filters';
import type { AvailabilitySnapshot, MediaType, Named, PlatformId, Rating, RecommendationItem, RecommendationRun, TitleKey, TitleMeta } from '../types';
import { AvailabilityLine, ChannelBars, Chip, Empty, ErrorNote, Poster, personalState, publicScore, ScorePair, Spinner, TitleLink, TypeBadge, PlatformPill } from '../ui/components';
import { safely } from '../services/notices';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import FilterPanel from '../ui/FilterPanel';
import RatingEditor, { readDraft } from '../ui/RatingEditor';
import { num, relTime } from '../ui/format';

export type { WatchedFilter } from '../services/filters';
import { diagnose, diagnosticOn, exportDiagnostics, type Diagnostic } from '../services/diagnostics';

/** v3.4: panel de diagnóstico (sólo con el modo activado en Ajustes). Muestra lo calculado; no agrega explicaciones. */
function DiagnosticPanel({ d }: { d: Diagnostic }) {
  return (
    <details className="mt-1.5 rounded-lg bg-violet-500/10 p-2 text-[11px] text-violet-100" data-testid="diag-panel">
      <summary className="cursor-pointer">Diagnóstico: puesto {d.rank}{d.engineRank && d.engineRank !== d.rank ? ` (motor: ${d.engineRank})` : ''} · nota {d.score} · base {d.base ?? '–'} · confianza {d.confidence}</summary>
      <p className="mt-1 font-semibold">Señales (puntos sobre tu media)</p>
      <ul>{d.channels.map((c) => <li key={c.id} data-testid="diag-channel" data-basis={c.basis}>{c.contribution > 0 ? '+' : ''}{c.contribution} · {c.label} <span className="opacity-70">({c.basis === 'aproximado' ? 'inferencia aproximada' : 'dato'}: {c.source}; peso {c.weight}, evidencia {c.evidence})</span></li>)}</ul>
      {d.prefs && <p className="mt-1">Preferencias: {d.prefs.matches.length ? d.prefs.matches.map((m) => `${m.label} (${m.evidence.join(', ')})`).join('; ') : 'ninguna coincidencia'}{d.prefs.unknown.length ? ` · sin datos para: ${d.prefs.unknown.join(', ')}` : ''} · {d.prefs.delta ? `${d.prefs.delta > 0 ? 'sube' : 'baja'} ${Math.abs(d.prefs.delta)} posiciones (posición del motor: ${d.engineRank})` : 'sin cambio de posición'}</p>}
      <p className="mt-1">Penalizaciones: {d.penalties.length ? d.penalties.join('; ') : 'ninguna'}</p>
      <p>Metadatos faltantes: {d.missing.length ? d.missing.join(', ') : 'ninguno'}</p>
      <p>Filtros aplicados: {d.filters.length ? d.filters.join(' · ') : 'ninguno'}</p>
      <p className="mt-1 font-semibold">Motivo de inclusión</p>
      <ul>{d.reason.map((r, i) => <li key={i}>• {r}</li>)}</ul>
    </details>
  );
}

type Editing = { key: TitleKey; mode: 'score' | 'aspects'; savedScore?: number };

interface CardProps {
  item: RecommendationItem; live?: RecommendationItem; meta: TitleMeta; snap?: AvailabilitySnapshot; rating?: Rating; profileId: string;
  editing?: Editing; onEdit: (e?: Editing) => void; onSave: (p: Promise<unknown>) => void; onTouch: (k: TitleKey) => void;
}

function RecCard({ item, live, meta, snap, rating, profileId, editing, onEdit, onSave, onTouch, strictScore, diag }: CardProps & { strictScore?: boolean; diag?: Diagnostic }) {
  const [open, setOpen] = useState(false);
  const watched = rating?.watched ?? false;
  const dismissed = Boolean(rating?.notInterested);
  const quickOpen = editing?.mode === 'score';
  // Estimación recalculada; el orden visible sólo cambia con «Actualizar ranking». Con orden estricto «Para vos» se muestra
  // el mismo valor con que se ordenó (si cambió, se indica la nueva estimación aparte).
  const shownItem = strictScore ? item : live ?? item;
  const newer = strictScore && live && Math.abs(live.score - item.score) >= 0.05 ? live.score : undefined;
  const dims = Object.entries(shownItem.dimensionEstimates ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const nAspects = rating ? Object.keys(rating.dimensions).length : 0;
  const hasDraft = Boolean(readDraft(profileId, item.key));
  const quick = (fn: () => Promise<unknown>, what = 'el cambio') => { onTouch(item.key); onSave(safely(fn, what)); };
  return (
    <li className={`rounded-2xl bg-ink-900 p-3 ring-1 ${editing ? 'ring-accent/60' : 'ring-white/5'} ${dismissed ? 'opacity-70' : ''}`} data-testid="rec-item" data-key={item.key} data-dismissed={dismissed}>
      <div className="flex gap-3">
        <TitleLink k={item.key} className="shrink-0"><Poster path={meta.posterPath} title={meta.title} className="h-28 w-[76px]" /></TitleLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="text-sm font-bold text-slate-500">#{item.rank}</span>
            <TitleLink k={item.key} className="min-w-0 flex-1"><h3 className="line-clamp-2 font-semibold leading-tight">{meta.title}</h3></TitleLink>
          </div>
          <div className="mt-1"><ScorePair item={shownItem} meta={meta} userScore={rating?.overall} compact /></div>
          {newer !== undefined && <p className="text-[10px] text-slate-500" data-testid="newer-estimate">Nueva estimación: {num(newer)} (se reordena al tocar «Actualizar ranking»)</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />{meta.year && <span>{meta.year}</span>}
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${shownItem.confidenceLabel === 'alta' ? 'bg-emerald-500/15 text-emerald-300' : shownItem.confidenceLabel === 'media' ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-500/15 text-slate-300'}`}>confianza {shownItem.confidenceLabel}</span>
            {item.exploration && <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-300">exploración</span>}
            {rating?.overall !== undefined && <span className="text-[10px]" data-testid="estimate-separate">estimación para vos {num(shownItem.score)} (aparte de tu nota)</span>}
            {shownItem.lowEvidence && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-200" data-testid="low-evidence">provisional: pocos datos</span>}
            {hasDraft && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">borrador</span>}
          </div>
          <div className="mt-1.5"><AvailabilityLine snap={snap} compact /></div>
          <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-left text-xs text-slate-300" data-testid="rec-explanation">
            {open ? shownItem.explanation.map((l, i) => <p key={i} className="mb-0.5">• {l}</p>) : <span className="line-clamp-2">{shownItem.explanation[0]}</span>}
            {open && dims.length > 0 && <p className="mt-1 text-[11px] text-slate-400">Estimado para vos: {dims.map(([d, v]) => `${DIMENSIONS.find((x) => x.id === d)!.short} ${num(v)}★`).join(' · ')}</p>}
          </button>
          {item.prefs && item.prefs.matches.length > 0 && (
            <p className="mt-1 text-[11px] text-sky-200" data-testid="rec-prefs">
              {item.prefs.matches.map((m) => `${m.polarity < 0 ? 'Baja por' : 'Sube por'} «${m.label}» (TMDB: ${m.evidence.join(', ')})`).join(' · ')}
            </p>
          )}
          {diag && <DiagnosticPanel d={diag} />}
          {open && (
            <div className="mt-2 rounded-lg bg-ink-950/60 p-2">
              {shownItem.lowEvidence && <p className="mb-1 text-[11px] text-amber-200">Este título se sumó con una búsqueda en TMDB para tus filtros y tu historial casi no tiene información sobre algo parecido: la estimación es de baja confianza y se apoya en datos públicos.</p>}
              <ChannelBars channels={shownItem.channels} base={shownItem.base} score={shownItem.score} />
              <div className="mt-2 flex flex-wrap items-center gap-2"><TrailerButton k={item.key} originalLanguage={meta.originalLanguage} title={meta.title} year={meta.year} compact /></div>
            </div>
          )}
        </div>
      </div>
      {dismissed ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-200" data-testid="dismissed-note">
          <span className="flex-1">Descartada: no se va a recomendar. Sale de la lista al actualizar el ranking.</span>
          <button type="button" data-testid="undo-not-interested" className="font-semibold underline" onClick={() => quick(() => setNotInterested(profileId, item.key, false), 'el cambio')}>Deshacer</button>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label={`Acciones rápidas para ${meta.title}`}>
          <button type="button" data-testid="quick-watched" aria-pressed={watched} onClick={() => quick(() => setWatched(profileId, item.key, !watched), 'la marca de vista')}
            className={`rounded-lg px-1 py-1.5 text-[11px] font-semibold leading-tight ${watched ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
            {watched ? '✓ Vista' : '○ Vista'}
          </button>
          <button type="button" data-testid="quick-score" aria-expanded={quickOpen} onClick={() => onEdit(quickOpen ? undefined : { key: item.key, mode: 'score' })}
            className={`rounded-lg px-1 py-1.5 text-[11px] font-semibold leading-tight ring-1 ${quickOpen ? 'bg-accent text-ink-950 ring-accent' : 'bg-ink-800 text-slate-300 ring-white/10'}`}>
            {rating?.overall !== undefined ? `★ ${num(rating.overall, rating.overall % 1 ? 1 : 0)} editar` : '★ Puntuar'}
          </button>
          <button type="button" data-testid="quick-aspects" onClick={() => { onTouch(item.key); onEdit({ key: item.key, mode: 'aspects' }); }}
            className="rounded-lg bg-ink-800 px-1 py-1.5 text-[11px] font-semibold leading-tight text-slate-300 ring-1 ring-white/10">
            Aspectos{nAspects ? ` ${nAspects}/${DIMENSIONS.length}` : ''}
          </button>
          <button type="button" data-testid="quick-not-interested" onClick={() => { onEdit(undefined); quick(() => setNotInterested(profileId, item.key, true), '«No me interesa»'); }}
            className="rounded-lg bg-ink-800 px-1 py-1.5 text-[11px] font-semibold leading-tight text-slate-300 ring-1 ring-white/10">
            ✕ No me interesa
          </button>
        </div>
      )}
      {quickOpen && !dismissed && (
        <div className="mt-2" data-testid="quick-score-row">
          <div className="flex gap-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" aria-label={`Nota general ${n}`}
                onClick={() => { quick(() => rateAndLearn(profileId, item.key, { overall: n }), 'la nota'); onEdit({ key: item.key, mode: 'score', savedScore: n }); }}
                className={`h-9 flex-1 rounded-md text-sm font-semibold ${rating?.overall === n ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300'}`}>{n}</button>
            ))}
          </div>
          {editing?.savedScore !== undefined ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-200" data-testid="quick-after-save">
              <span className="flex-1">Nota {editing.savedScore} guardada. ¿Querés sumar aspectos o un comentario?</span>
              <button type="button" data-testid="quick-complete" onClick={() => onEdit({ key: item.key, mode: 'aspects' })} className="rounded-md bg-accent px-2 py-1 font-semibold text-ink-950">Completar aspectos</button>
              <button type="button" data-testid="quick-done" onClick={() => onEdit(undefined)} className="rounded-md bg-ink-800 px-2 py-1 font-semibold">Listo</button>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-slate-500">Tocá una nota para guardarla. No cambia la marca de vista ni el orden hasta que actualices el ranking.
              {rating?.overall !== undefined && <> <button className="underline" onClick={() => quick(() => rateAndLearn(profileId, item.key, { overall: null }), 'el cambio')}>Quitar nota</button></>}</p>
          )}
        </div>
      )}
    </li>
  );
}

export function filterByWatched<T extends { key: TitleKey }>(rows: T[], ratings: Map<TitleKey, Rating>, filter: WatchedFilter, sticky: Set<TitleKey> = new Set()): T[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => sticky.has(r.key) || (filter === 'watched') === Boolean(ratings.get(r.key)?.watched));
}

export type HomeSort = 'recommended' | 'affinity' | 'public' | 'year' | 'title';
const HOME_SORTS: [HomeSort, string][] = [['recommended', 'Recomendado'], ['affinity', 'Para vos (estricto)'], ['public', 'Público (TMDB)'], ['year', 'Año'], ['title', 'Título']];
export const PAGE_SIZE = 10;

/**
 * Orden de la lista visible (v3.1). Se ordena la lista COMPLETA antes de paginar, así «Ver más» nunca rompe el orden.
 * - «Recomendado»: el orden del motor (afinidad + variedad + exploración).
 * - «Para vos (estricto)»: por la puntuación personalizada mostrada, sin diversificación posterior. Se compara el valor
 *   interno; como el redondeo a un decimal es monótono, los valores mostrados quedan siempre en orden no creciente.
 * - Los demás: por el dato elegido; los títulos sin dato van al final; empates por el orden del motor.
 */
export function sortRows<T extends { key: TitleKey; item: RecommendationItem; meta?: TitleMeta }>(rows: T[], sort: HomeSort, dir: 'asc' | 'desc'): T[] {
  if (sort === 'recommended') return dir === 'desc' ? rows : [...rows].reverse();
  const val = (r: T): number | string | undefined => sort === 'affinity' ? (personalState(r.item).kind === 'insufficient' ? undefined : r.item.score) : sort === 'public' ? publicScore(r.meta) : sort === 'year' ? r.meta?.year : r.meta?.title;
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    // Sin dato (p. ej. sin votos suficientes en TMDB) va siempre al final
    if (x === undefined && y === undefined) return a.item.rank - b.item.rank;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y as string, 'es') : x - (y as number);
    return sign * c || a.item.rank - b.item.rank;
  });
}

export default function Home() {
  const { profileId, settings } = useApp();
  const [sort, setSortRaw] = usePersistentState<HomeSort>(`cine-match:home-sort:${profileId}`, 'recommended', oneOf(HOME_SORTS.map(([v]) => v)));
  const [dir, setDir] = usePersistentState<'asc' | 'desc'>(`cine-match:home-dir:${profileId}`, 'desc', oneOf(['asc', 'desc'] as const));
  const [listReady, setListReady] = useState(false);
  const { page, setPage } = useScrollRestore('home', listReady);
  const setSort = (v: HomeSort) => { setSortRaw(v); setDir(v === 'title' ? 'asc' : 'desc'); setPage(1); };
  const { run: latest, busy, error, refresh } = useRecommendations(profileId);
  const [filters, setFiltersState] = useState<RankFilters>(() => loadFilters(profileId));
  const setFilters = (f: RankFilters) => { setFiltersState(f); saveFilters(profileId, f); setTouched(new Set()); setPage(1); };
  // Orden visible: sólo cambia al abrir, al tocar «Actualizar ranking» o al cambiar filtros. El modelo se recalcula solo.
  const [shown, setShown] = useState<RecommendationRun>();
  const [applyNext, setApplyNext] = useState(false);
  const [applyTick, setApplyTick] = useState(0);
  const [editing, setEditing] = useState<Editing>();
  const [saving, setSaving] = useState(0);
  const [notice, setNotice] = useState<string>();
  // Títulos con los que interactuaste: siguen visibles hasta que actualices el ranking o cambies de filtro
  const [touched, setTouched] = useState<Set<TitleKey>>(new Set());
  const apply = (r?: RecommendationRun) => {
    if (!r) return;
    setShown(r); setTouched(new Set()); setApplyTick((t) => t + 1);
  };
  useEffect(() => {
    if (!latest) { if (shown && shown.algorithmVersion !== engineFor(settings).version) setShown(undefined); return; }
    if (!shown || shown.algorithmVersion !== latest.algorithmVersion) { apply(latest); return; } // v3.5: otro motor, nunca mezclado
    if (latest.id === shown.id) return;
    if (applyNext && !saving) { setApplyNext(false); apply(latest); setNotice(`Ranking actualizado con tus valoraciones (${latest.algorithmVersion}).`); return; }
    // Recálculo que no viene de una interacción tuya (p. ej. al abrir): se aplica si no estás editando
    if (!touched.size && !editing && !saving) apply(latest);
  }, [latest?.id, applyNext, saving]);

  const advanced = activeFilters(filters).length > 0;
  const [diagOn] = useState(diagnosticOn);
  const filtersKey = JSON.stringify(filters);
  const [filteredState, setFiltered] = useState<Awaited<ReturnType<typeof rankWithFilters>> & { for: string }>();
  // Resultado sólo válido para los filtros y el ranking con los que se calculó: evita mostrar «ningún título» un instante al cambiar filtros
  const filterSig = `${shown?.id}|${filtersKey}|${applyTick}`;
  const filtered = filteredState?.for === filterSig ? filteredState : undefined;
  const [filterBusy, setFilterBusy] = useState(false);
  useEffect(() => {
    if (!shown || !advanced) { setFiltered(undefined); return; }
    let alive = true;
    setFilterBusy(true);
    rankWithFilters(profileId, shown, filters).then((r) => { if (alive) setFiltered({ ...r, for: filterSig }); }).catch((e) => { if (alive) setFiltered({ items: [], candidates: 0, diagnostics: [], discovered: 0, warning: e instanceof Error ? e.message : String(e), for: filterSig }); }).finally(() => { if (alive) setFilterBusy(false); });
    return () => { alive = false; };
  }, [shown?.id, filtersKey, applyTick, advanced]);

  const items = advanced ? filtered?.items ?? [] : shown?.items ?? [];
  const keys = items.map((i) => i.key);
  const keysSig = keys.join(',');
  const titles = useLiveQuery(() => db.titles.bulkGet(keys), [keysSig]);
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [keysSig, settings.country]);
  const eligibleKeys = shown?.eligible ?? shown?.items.map((i) => i.key) ?? [];
  const eligibleMetas = useLiveQuery(() => db.titles.bulkGet(eligibleKeys), [shown?.id]);
  const genres = useMemo(() => {
    const m = new Map<number, Named>();
    for (const t of eligibleMetas ?? []) for (const g of t?.genres ?? []) if (!/^Género \d+$/.test(g.name)) m.set(g.id, g);
    return [...m.values()];
  }, [eligibleMetas]);
  const rs = useRatings(profileId);
  const ratings = rs.byKey;
  const liveItems = useMemo(() => new Map((latest?.items ?? []).map((i) => [i.key, i])), [latest?.id]);
  const pendingCount = [...ratings.values()].filter((r) => r.list === 'want' || r.list === 'watching').length;
  const events = useLiveQuery(() => db.availabilityEvents.where('country').equals(settings.country).reverse().sortBy('detectedAt').then((e) => e.slice(0, 6)), [settings.country]);
  const eventTitles = useLiveQuery(() => db.titles.bulkGet((events ?? []).map((e) => e.key)), [events]);

  const rows = useMemo(() => {
    if (!titles) return [];
    const base = items.map((item, i) => ({ key: item.key, item, meta: titles[i], snap: snaps?.[i] })).filter((r) => r.meta);
    const visible = advanced ? base : filterByWatched(base, ratings, filters.watched, touched);
    return sortRows(visible.map((r, i) => ({ ...r, item: { ...r.item, rank: i + 1 } })), sort, dir);
  }, [items, titles, snaps, filters.watched, ratings, touched, advanced, sort, dir]);
  // Paginación: 10 al principio y de a 10 con «Ver más» (nunca cientos de tarjetas a la vez)
  const pageRows = rows.slice(0, page * PAGE_SIZE);
  useEffect(() => { if (rows.length && titles && snaps) setListReady(true); }, [rows.length, Boolean(titles), Boolean(snaps)]);
  const featured = !advanced && filters.watched === 'unwatched' && sort === 'recommended' && dir === 'desc' ? rows.filter((r) => !touched.has(r.key) && (r.meta?.backdropPath || r.meta?.posterPath)).slice(0, 3) : [];
  const trackSave = (p: Promise<unknown>) => {
    setSaving((n) => n + 1);
    p.catch(() => undefined).finally(() => setSaving((n) => n - 1));
  };
  const pending = Boolean(latest && shown && latest.id !== shown.id) || touched.size > 0;
  const onApplyRanking = async () => {
    setEditing(undefined);
    if (latest && shown && latest.id !== shown.id && !saving) { apply(latest); setNotice(`Ranking actualizado con tus valoraciones (${latest.algorithmVersion}).`); return; }
    setApplyNext(true);
    if (!saving) await refresh({ trigger: 'actualizar ranking' });
  };
  const onSearchMore = async () => {
    setApplyNext(true);
    await refresh({ trigger: 'filtros', discover: hintsFromFilters(filters) });
  };
  const editingMeta = editing?.mode === 'aspects' ? rows.find((r) => r.key === editing.key)?.meta : undefined;
  const genreName = (id: number) => genres.find((g) => g.id === id)?.name ?? `género ${id}`;
  const platformName = (id: PlatformId) => PLATFORMS.find((p) => p.id === id)?.label ?? id;
  const quickType: MediaType | 'all' = filters.types.length === 1 ? filters.types[0] : 'all';
  const quickPlatform: PlatformId | 'all' = filters.platforms.length === 1 ? filters.platforms[0] : 'all';

  return (
    <div className="space-y-4">
      <BackupReminder />
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Para vos</h1>
          <p className="text-xs text-slate-400">{shown ? `Orden de ${relTime(shown.createdAt)} · ${shown.ratingsCount} valoraciones` : 'Calculando tu ranking…'}</p>
          {shown && (
            <p className="text-[11px] text-slate-500" data-testid="engine-badge" data-engine={ENGINE_LABEL[shown.algorithmVersion] ?? shown.algorithmVersion}>
              Motor: {ENGINE_LABEL[shown.algorithmVersion] ?? shown.algorithmVersion}
              {ENGINE_LABEL[shown.algorithmVersion] === 'v3.5' && ' (experimental) · ordena v3.5; la nota «Para vos» es la estimación de v3.4'}
            </p>
          )}
        </div>
        <button onClick={onApplyRanking} disabled={busy && !pending} data-testid="apply-ranking" aria-label="Actualizar ranking"
          className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ring-1 disabled:opacity-50 ${pending ? 'bg-accent text-ink-950 ring-accent' : 'bg-ink-800 ring-white/10'}`}>
          {busy || saving ? '… ' : '↻ '}Actualizar ranking
        </button>
      </header>
      {pending && (
        <p role="status" data-testid="pending-changes" className="flex items-center gap-2 rounded-xl bg-amber-500/10 p-2 text-xs text-amber-200">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
          {saving ? 'Guardando y recalculando el modelo…' : 'Hay valoraciones nuevas que todavía no se reflejan en el orden. Podés seguir puntuando y actualizar cuando quieras.'}
        </p>
      )}

      <div className="flex rounded-xl bg-ink-800 p-1 ring-1 ring-white/10" role="radiogroup" aria-label="Filtrar por vistos">
        {([['unwatched', 'No vistos'], ['watched', 'Vistos'], ['all', 'Todos']] as [WatchedFilter, string][]).map(([v, l]) => (
          <button key={v} role="radio" aria-checked={filters.watched === v} data-testid={`watched-filter-${v}`} onClick={() => setFilters({ ...filters, watched: v })}
            className={`flex-1 rounded-lg py-1.5 text-sm font-semibold ${filters.watched === v ? 'bg-accent text-ink-950' : 'text-slate-300'}`}>{l}</button>
        ))}
      </div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        <Chip active={quickPlatform === 'all' && !filters.platforms.length} onClick={() => setFilters({ ...filters, platforms: [] })}>Todas</Chip>
        {PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <Chip key={p.id} testId={`filter-${p.id}`} active={quickPlatform === p.id} onClick={() => setFilters({ ...filters, platforms: quickPlatform === p.id ? [] : [p.id] })}>{p.label}</Chip>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip active={quickType === 'all'} onClick={() => setFilters({ ...filters, types: [] })}>Todo</Chip>
        <Chip active={quickType === 'movie'} onClick={() => setFilters({ ...filters, types: ['movie'] })} testId="filter-movie">Películas</Chip>
        <Chip active={quickType === 'tv'} onClick={() => setFilters({ ...filters, types: ['tv'] })} testId="filter-tv">Series</Chip>
        <Link to="/pendientes" className="ml-auto shrink-0 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10">Pendientes ({pendingCount})</Link>
      </div>
      <FilterPanel value={filters} onChange={setFilters} genres={genres} userPlatforms={settings.platforms} onSearchMore={advanced ? onSearchMore : undefined} searching={busy} language={settings.language} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-400" htmlFor="home-sort">Ordenar por</label>
        <select id="home-sort" value={sort} onChange={(e) => setSort(e.target.value as HomeSort)} data-testid="home-sort" className="min-w-0 max-w-[55vw] rounded-lg bg-ink-800 p-1.5 text-sm ring-1 ring-white/10">
          {HOME_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button type="button" data-testid="home-dir" onClick={() => { setDir(dir === 'asc' ? 'desc' : 'asc'); setPage(1); }} className="rounded-lg bg-ink-800 px-2 py-1.5 text-xs ring-1 ring-white/10"
          aria-label="Invertir el orden">{sort === 'title' ? (dir === 'asc' ? 'A→Z' : 'Z→A') : dir === 'desc' ? '↓ Mayor' : '↑ Menor'}</button>
        {(sort !== 'recommended' || dir !== 'desc') && <button type="button" data-testid="home-sort-reset" onClick={() => setSort('recommended')} className="text-[11px] text-accent underline">Restablecer</button>}
      </div>
      {diagOn && rows.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-violet-500/10 p-2 text-[11px] text-violet-100" data-testid="diag-bar">
          <span className="flex-1">Modo diagnóstico activo (Ajustes). Muestra cómo se calculó cada posición.</span>
          <button type="button" data-testid="diag-export" className="rounded bg-violet-500/20 px-2 py-1 font-semibold" onClick={() => {
            const data = exportDiagnostics(rows.filter((r) => r.meta).map((r) => diagnose(r.item, r.meta!, filters, { genre: genreName, platform: platformName as never })), filters);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            a.download = `cine-match-diagnostico-${new Date().toISOString().slice(0, 10)}.json`; a.click();
          }}>Exportar JSON</button>
        </div>
      )}
      {advanced && (
        <div className="flex flex-wrap gap-1.5" data-testid="active-filters">
          {activeFilters(filters).map((id) => (
            <span key={id} className="flex items-center gap-1 rounded-full bg-accent/15 py-0.5 pl-2 pr-1 text-[11px] text-accent" data-testid="active-filter" data-filter={id}>
              {filterLabel(id, filters, genreName, platformName)}
              <button type="button" aria-label={`Quitar ${filterLabel(id, filters, genreName, platformName)}`} data-testid="active-filter-remove" onClick={() => setFilters(without(filters, id))} className="px-1">✕</button>
            </span>
          ))}
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {shown?.warning && <ErrorNote>{shown.warning}</ErrorNote>}
      {notice && !pending && <p role="status" data-testid="rank-notice" className="rounded-xl bg-emerald-500/10 p-2.5 text-xs text-emerald-200" onClick={() => setNotice(undefined)}>{notice}</p>}
      {busy && !shown && <Spinner label="Buscando títulos en tus plataformas…" />}
      {advanced && filterBusy && !filtered && <Spinner label="Aplicando filtros (si hay pocos títulos, se busca en TMDB)…" />}
      {advanced && filtered?.warning && <ErrorNote>{filtered.warning}</ErrorNote>}
      {advanced && filtered && filtered.discovered > 0 && (
        <p role="status" data-testid="discovered-note" className="rounded-xl bg-sky-500/10 p-2 text-xs text-sky-100">
          Había pocos títulos para estos filtros en tu ranking: se sumaron {filtered.discovered} buscados en TMDB con los mismos filtros y tus plataformas. Los marcados «provisional» tienen estimación de baja confianza.
        </p>
      )}
      {advanced && filtered?.outsidePlatforms ? (
        <p className="text-[11px] text-slate-500" data-testid="person-outside">
          {filtered.outsidePlatforms} {filtered.outsidePlatforms === 1 ? 'título' : 'títulos'} con {includedPeople(filters).map((p) => p.name).join(' y ')} no {filtered.outsidePlatforms === 1 ? 'figura' : 'figuran'} en tus plataformas en {settings.country} (o falta verificarlos) y no se muestran.{' '}
          <button type="button" className="underline" data-testid="person-any-platform" onClick={() => setFilters({ ...filters, anyPlatform: true })}>Mostrar también</button>
        </p>
      ) : null}
      {advanced && filters.anyPlatform && includedPeople(filters).length > 0 && (
        <p className="text-[11px] text-slate-500" data-testid="person-any-platform-on">Incluye títulos fuera de tus plataformas. <button type="button" className="underline" onClick={() => setFilters({ ...filters, anyPlatform: false })}>Sólo mis plataformas</button></p>
      )}
      {advanced && filtered?.perPerson && filtered.peopleTotal === 0 && (
        <p role="status" className="rounded-xl bg-amber-500/10 p-2 text-xs text-amber-100" data-testid="people-none">
          {filters.peopleMode === 'all' && filtered.perPerson.length > 1 ? `En TMDB no hay películas ni series donde actúen ${filtered.perPerson.map((x) => x.person.name).join(' y ')} a la vez` : 'Las personas elegidas no tienen títulos que cumplan la selección'}
          {' '}({filtered.perPerson.map((x) => `${x.person.name}: ${x.count}`).join(' · ')} títulos cada uno{filters.excludePeople?.length ? ', antes de quitar los excluidos' : ''}).
        </p>
      )}

      {featured.length > 0 && (
        <section aria-label="Destacadas" className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4">
          {featured.map(({ item, meta }) => (
            <TitleLink key={item.key} k={item.key} className="relative w-[85%] shrink-0 snap-start overflow-hidden rounded-2xl">
              <Poster path={meta!.backdropPath ?? meta!.posterPath} size="w780" title={meta!.title} className="aspect-video w-full" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
              <div className="absolute bottom-0 p-3">
                <div className="text-xs font-semibold text-accent">#{item.rank} · Para vos {num(item.score)}{publicScore(meta) !== undefined ? ` · TMDB ${num(publicScore(meta))}` : ''}</div>
                <div className="text-lg font-bold leading-tight">{meta!.title}</div>
              </div>
            </TitleLink>
          ))}
        </section>
      )}

      {shown && rows.length === 0 && !busy && !(advanced && (filterBusy || !filtered || items.length > 0)) && (
        advanced ? (
          <Empty>
            <span data-testid="filters-empty">Ningún título cumple todos los filtros entre {filtered?.candidates ?? 0} candidatos evaluados.</span>
            {filtered?.diagnostics.length ? (
              <ul className="mt-2 space-y-0.5 text-left text-xs">
                {filtered.diagnostics.slice(0, 3).map((d) => <li key={d.id}>• Sin «{filterLabel(d.id as any, filters, genreName, platformName)}» habría {d.count} {d.count === 1 ? 'resultado' : 'resultados'}.</li>)}
              </ul>
            ) : null}
            {filtered?.dataGaps && (filtered.dataGaps.noAudience || filtered.dataGaps.noCountries || filtered.dataGaps.noKeywords) ? (
              <ul className="mt-2 space-y-0.5 text-left text-xs text-amber-200" data-testid="data-gaps">
                {filtered.dataGaps.noAudience > 0 && <li>• {filtered.dataGaps.noAudience} de {filtered.dataGaps.total} candidatos no tienen datos para clasificar el público: no es que no coincidan, no se pueden evaluar.</li>}
                {filtered.dataGaps.noCountries > 0 && <li>• {filtered.dataGaps.noCountries} de {filtered.dataGaps.total} no tienen país informado por TMDB.</li>}
                {filtered.dataGaps.noKeywords > 0 && <li>• {filtered.dataGaps.noKeywords} de {filtered.dataGaps.total} no tienen palabras clave para evaluar temas.</li>}
              </ul>
            ) : null}
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={onSearchMore} className="text-accent underline">Buscar más títulos con estos filtros</button>
              <button type="button" onClick={() => setFilters({ ...filters, types: [], includeGenres: [], excludeGenres: [], yearMin: undefined, yearMax: undefined, platforms: [], runtimeMin: undefined, runtimeMax: undefined, minScore: undefined })} className="underline">Limpiar filtros</button>
            </div>
          </Empty>
        ) : (
          <Empty>{filters.watched === 'watched' ? 'Todavía no marcaste títulos como vistos en tus plataformas.' : <>No hay recomendaciones con estos filtros. {settings.includeUnconfirmed ? '' : 'Podés incluir títulos con disponibilidad no confirmada en Ajustes.'} <br /><Link to="/buscar" className="text-accent underline">Valorá más títulos</Link> para mejorar el ranking.</>}</Empty>
        )
      )}
      <ol className="space-y-3" aria-label="Ranking personalizado">
        {pageRows.map((r) => (
          <RecCard key={r.key} diag={diagOn ? diagnose(r.item, r.meta!, filters, { genre: genreName, platform: platformName as never }) : undefined} strictScore={sort === 'affinity'} item={r.item} live={liveItems.get(r.key)} meta={r.meta!} snap={r.snap} rating={ratings.get(r.key)} profileId={profileId}
            editing={editing?.key === r.key ? editing : undefined}
            onEdit={setEditing} onSave={trackSave}
            onTouch={(k) => setTouched((s) => (s.has(k) ? s : new Set(s).add(k)))} />
        ))}
      </ol>
      {rows.length > pageRows.length && (
        <button type="button" data-testid="show-more" onClick={() => setPage(page + 1)} className="w-full rounded-xl bg-ink-800 py-2.5 text-sm font-semibold ring-1 ring-white/10">
          Ver más ({Math.min(PAGE_SIZE, rows.length - pageRows.length)} de {rows.length - pageRows.length} restantes)
        </button>
      )}
      {rows.length > 0 && <p className="text-center text-[11px] text-slate-500" data-testid="rows-count">Mostrando {pageRows.length} de {rows.length}</p>}

      {editing?.mode === 'aspects' && editingMeta && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/60" role="dialog" aria-modal="true" aria-label={`Valorar ${editingMeta.title}`} data-testid="aspects-sheet"
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(undefined); }}>
          <div className="safe-bottom mx-auto max-h-[88vh] w-full max-w-xl scroll-pb-24 scroll-pt-4 overflow-y-auto rounded-t-3xl bg-ink-900 p-4 ring-1 ring-white/10">
            <div className="mb-3 flex items-center gap-3">
              <Poster path={editingMeta.posterPath} title={editingMeta.title} className="h-14 w-10" />
              <div className="min-w-0"><div className="truncate font-semibold">{editingMeta.title}</div><div className="text-xs text-slate-400">Nota general, aspectos y comentario</div></div>
            </div>
            <RatingEditor profileId={profileId} k={editing.key} existing={ratings.get(editing.key)} isTv={editingMeta.type === 'tv'} title={editingMeta} openAspects
              onCancel={() => setEditing(undefined)}
              onSaved={() => setEditing(undefined)} />
          </div>
        </div>
      )}

      {events && events.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Cambios detectados en plataformas</h2>
          <p className="text-[11px] text-slate-400">Detectados al comparar verificaciones; el proveedor no informa la fecha exacta del cambio.</p>
          {events.map((e, i) => (
            <div key={e.id} className="flex items-center gap-2 text-sm">
              <span className={e.change === 'added' ? 'text-emerald-300' : 'text-red-300'}>{e.change === 'added' ? '＋ Llegó a' : '－ Salió de'}</span>
              <PlatformPill id={e.platform} small />
              <TitleLink k={e.key} className="truncate underline">{eventTitles?.[i]?.title ?? e.key}</TitleLink>
              <span className="ml-auto shrink-0 text-[11px] text-slate-500">{relTime(e.detectedAt)}</span>
            </div>
          ))}
        </section>
      )}
      <p className="pt-2 text-center text-[10px] text-slate-500">«Para vos» es una estimación personalizada (1-10) de cuánto lo disfrutarías; no es una probabilidad ni tu nota. «TMDB» es el promedio de votos del público en TMDB. Disponibilidad: JustWatch.</p>
    </div>
  );
}
