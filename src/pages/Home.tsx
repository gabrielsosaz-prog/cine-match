import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIMENSIONS, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { migrateRating } from '../db/migrations';
import { useApp } from '../hooks/useApp';
import { useRecommendations } from '../hooks/useRecs';
import { streamingPlatforms } from '../services/availability';
import { rateAndLearn, setWatched } from '../services/ratings';
import type { AvailabilitySnapshot, MediaType, PlatformId, Rating, RecommendationItem, RecommendationRun, TitleKey, TitleMeta } from '../types';
import { AvailabilityLine, Chip, Empty, ErrorNote, Poster, ScoreBadge, Spinner, TitleLink, TypeBadge, PlatformPill } from '../ui/components';
import RatingEditor from '../ui/RatingEditor';
import { num, relTime } from '../ui/format';

export type WatchedFilter = 'unwatched' | 'watched' | 'all';

interface CardProps {
  item: RecommendationItem; meta: TitleMeta; snap?: AvailabilitySnapshot; rating?: Rating; profileId: string;
  quickOpen: boolean; onQuick: (open: boolean) => void; onAspects: () => void; onSaving: (p: Promise<unknown>) => void; onToggledWatched: (k: TitleKey) => void;
}

function RecCard({ item, meta, snap, rating, profileId, quickOpen, onQuick, onAspects, onSaving, onToggledWatched }: CardProps) {
  const [open, setOpen] = useState(false);
  const watched = rating?.watched ?? false;
  const dims = Object.entries(item.dimensionEstimates ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return (
    <li className={`rounded-2xl bg-ink-900 p-3 ring-1 ${quickOpen ? 'ring-accent/60' : 'ring-white/5'}`} data-testid="rec-item" data-key={item.key}>
      <div className="flex gap-3">
        <TitleLink k={item.key} className="shrink-0"><Poster path={meta.posterPath} title={meta.title} className="h-28 w-[76px]" /></TitleLink>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="text-sm font-bold text-slate-500">#{item.rank}</span>
            <TitleLink k={item.key} className="min-w-0 flex-1"><h3 className="truncate font-semibold leading-tight">{meta.title}</h3></TitleLink>
            {rating?.overall !== undefined ? <ScoreBadge score={rating.overall} label="tu nota" /> : <ScoreBadge score={item.score} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />{meta.year && <span>{meta.year}</span>}
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${item.confidenceLabel === 'alta' ? 'bg-emerald-500/15 text-emerald-300' : item.confidenceLabel === 'media' ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-500/15 text-slate-300'}`}>confianza {item.confidenceLabel}</span>
            {item.exploration && <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-300">exploración</span>}
            {rating?.overall !== undefined && <span className="text-[10px]">estimada {num(item.score)}</span>}
          </div>
          <div className="mt-1.5"><AvailabilityLine snap={snap} compact /></div>
          <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 text-left text-xs text-slate-300" data-testid="rec-explanation">
            {open ? item.explanation.map((l, i) => <p key={i} className="mb-0.5">• {l}</p>) : <span className="line-clamp-2">{item.explanation[0]}</span>}
            {open && dims.length > 0 && <p className="mt-1 text-[11px] text-slate-400">Estimado para vos: {dims.map(([d, v]) => `${DIMENSIONS.find((x) => x.id === d)!.short} ${num(v)}`).join(' · ')}</p>}
          </button>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5" role="group" aria-label={`Acciones rápidas para ${meta.title}`}>
        <button type="button" data-testid="quick-watched" aria-pressed={watched}
          onClick={async () => { onToggledWatched(item.key); await setWatched(profileId, item.key, !watched); }}
          className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${watched ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
          {watched ? '✓ Vista' : '○ Marcar vista'}
        </button>
        <button type="button" data-testid="quick-score" aria-expanded={quickOpen} onClick={() => onQuick(!quickOpen)}
          className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ring-1 ${quickOpen ? 'bg-accent text-ink-950 ring-accent' : 'bg-ink-800 text-slate-300 ring-white/10'}`}>
          {rating?.overall !== undefined ? `★ ${num(rating.overall, rating.overall % 1 ? 1 : 0)} · editar` : '★ Puntuar'}
        </button>
        <button type="button" data-testid="quick-aspects" onClick={onAspects} className="flex-1 rounded-lg bg-ink-800 py-1.5 text-xs font-semibold text-slate-300 ring-1 ring-white/10">
          Aspectos{rating && Object.keys(rating.dimensions).length ? ` (${Object.keys(rating.dimensions).length})` : ''}
        </button>
      </div>
      {quickOpen && (
        <div className="mt-2" data-testid="quick-score-row">
          <div className="flex gap-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" aria-label={`Nota general ${n}`}
                onClick={() => onSaving(rateAndLearn(profileId, item.key, { overall: n }))}
                className={`h-9 flex-1 rounded-md text-sm font-semibold ${rating?.overall === n ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300'}`}>{n}</button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Tocá una nota para guardarla. No cambia la marca de vista.{rating?.overall !== undefined && <> <button className="underline" onClick={() => onSaving(rateAndLearn(profileId, item.key, { overall: null }))}>Quitar nota</button></>}</p>
        </div>
      )}
    </li>
  );
}

export function filterByWatched<T extends { key: TitleKey }>(rows: T[], ratings: Map<TitleKey, Rating>, filter: WatchedFilter, sticky: Set<TitleKey> = new Set()): T[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => sticky.has(r.key) || (filter === 'watched') === Boolean(ratings.get(r.key)?.watched));
}

export default function Home() {
  const { profileId, settings } = useApp();
  const { run: latest, busy, error, refresh } = useRecommendations(profileId);
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all');
  const [type, setType] = useState<MediaType | 'all'>('all');
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('unwatched');
  // Ranking congelado mientras se edita una tarjeta; se aplica el nuevo después de guardar
  const [shown, setShown] = useState<RecommendationRun>();
  const [editing, setEditing] = useState<{ key: TitleKey; mode: 'score' | 'aspects' }>();
  const [saving, setSaving] = useState(0);
  const [notice, setNotice] = useState<string>();
  // Títulos que el usuario acaba de marcar/desmarcar: siguen visibles hasta cambiar de filtro
  const [sticky, setSticky] = useState<Set<TitleKey>>(new Set());
  const frozen = Boolean(editing) || saving > 0;
  const lastApplied = useRef<number>();
  useEffect(() => {
    if (!latest || frozen) return;
    if (shown && latest.id !== shown.id && lastApplied.current !== latest.id) setNotice(`Ranking actualizado con tu valoración (${latest.algorithmVersion}).`);
    lastApplied.current = latest.id;
    setShown(latest);
  }, [latest?.id, frozen]);
  useEffect(() => setSticky(new Set()), [watchedFilter]);

  const run = shown;
  const keys = run?.items.map((i) => i.key) ?? [];
  const titles = useLiveQuery(() => db.titles.bulkGet(keys), [run?.id]);
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [run?.id, settings.country]);
  const ratingList = useLiveQuery(() => db.ratings.where('profileId').equals(profileId).toArray(), [profileId]);
  const ratings = useMemo(() => new Map((ratingList ?? []).map((r) => { const m = migrateRating(r); return [m.key, m] as [TitleKey, Rating]; })), [ratingList]);
  const pendingCount = [...ratings.values()].filter((r) => r.list === 'want' || r.list === 'watching').length;
  const events = useLiveQuery(() => db.availabilityEvents.where('country').equals(settings.country).reverse().sortBy('detectedAt').then((e) => e.slice(0, 6)), [settings.country]);
  const eventTitles = useLiveQuery(() => db.titles.bulkGet((events ?? []).map((e) => e.key)), [events]);

  const rows = useMemo(() => {
    if (!run || !titles) return [];
    const base = run.items.map((item, i) => ({ key: item.key, item, meta: titles[i], snap: snaps?.[i] }))
      .filter((r) => r.meta && (type === 'all' || r.meta.type === type))
      .filter((r) => platform === 'all' || streamingPlatforms(r.snap).includes(platform));
    return filterByWatched(base, ratings, watchedFilter, sticky).map((r, i) => ({ ...r, item: { ...r.item, rank: i + 1 } }));
  }, [run, titles, snaps, type, platform, watchedFilter, ratings, sticky]);
  const featured = watchedFilter === 'unwatched' ? rows.filter((r) => r.meta?.backdropPath || r.meta?.posterPath).slice(0, 3) : [];
  const trackSave = (p: Promise<unknown>) => {
    setSaving((n) => n + 1);
    p.finally(() => { setSaving((n) => n - 1); setEditing(undefined); });
  };
  const editingRow = editing?.mode === 'aspects' ? rows.find((r) => r.key === editing.key) ?? (run && titles ? { key: editing.key, meta: titles[keys.indexOf(editing.key)] } : undefined) : undefined;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Para vos</h1>
          <p className="text-xs text-slate-400">{run ? `Actualizado ${relTime(run.createdAt)} · ${run.ratingsCount} valoraciones` : 'Calculando tu ranking…'}</p>
        </div>
        <button onClick={() => refresh(true)} disabled={busy || frozen} className="rounded-full bg-ink-800 px-3 py-2 text-sm ring-1 ring-white/10 disabled:opacity-50" aria-label="Actualizar recomendaciones">{busy || saving ? '…' : '↻ Actualizar'}</button>
      </header>

      <div className="flex rounded-xl bg-ink-800 p-1 ring-1 ring-white/10" role="radiogroup" aria-label="Filtrar por vistos">
        {([['unwatched', 'No vistos'], ['watched', 'Vistos'], ['all', 'Todos']] as [WatchedFilter, string][]).map(([v, l]) => (
          <button key={v} role="radio" aria-checked={watchedFilter === v} data-testid={`watched-filter-${v}`} onClick={() => setWatchedFilter(v)}
            className={`flex-1 rounded-lg py-1.5 text-sm font-semibold ${watchedFilter === v ? 'bg-accent text-ink-950' : 'text-slate-300'}`}>{l}</button>
        ))}
      </div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        <Chip active={platform === 'all'} onClick={() => setPlatform('all')}>Todas</Chip>
        {PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <Chip key={p.id} testId={`filter-${p.id}`} active={platform === p.id} onClick={() => setPlatform(p.id)}>{p.label}</Chip>)}
      </div>
      <div className="flex gap-2">
        <Chip active={type === 'all'} onClick={() => setType('all')}>Todo</Chip>
        <Chip active={type === 'movie'} onClick={() => setType('movie')} testId="filter-movie">Películas</Chip>
        <Chip active={type === 'tv'} onClick={() => setType('tv')} testId="filter-tv">Series</Chip>
        <Link to="/pendientes" className="ml-auto shrink-0 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10">Pendientes ({pendingCount})</Link>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {run?.warning && <ErrorNote>{run.warning}</ErrorNote>}
      {notice && !frozen && <p role="status" data-testid="rank-notice" className="rounded-xl bg-emerald-500/10 p-2.5 text-xs text-emerald-200" onClick={() => setNotice(undefined)}>{notice}</p>}
      {saving > 0 && <p role="status" className="text-xs text-slate-400">Guardando y recalculando… el ranking se actualiza al terminar.</p>}
      {busy && !run && <Spinner label="Buscando títulos en tus plataformas…" />}

      {featured.length > 0 && (
        <section aria-label="Destacadas" className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4">
          {featured.map(({ item, meta }) => (
            <TitleLink key={item.key} k={item.key} className="relative w-[85%] shrink-0 snap-start overflow-hidden rounded-2xl">
              <Poster path={meta!.backdropPath ?? meta!.posterPath} size="w780" title={meta!.title} className="aspect-video w-full" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
              <div className="absolute bottom-0 p-3">
                <div className="text-xs font-semibold text-accent">#{item.rank} · {num(item.score)} estimada</div>
                <div className="text-lg font-bold leading-tight">{meta!.title}</div>
              </div>
            </TitleLink>
          ))}
        </section>
      )}

      {run && rows.length === 0 && !busy && (
        <Empty>{watchedFilter === 'watched' ? 'Todavía no marcaste títulos como vistos en tus plataformas.' : <>No hay recomendaciones con estos filtros. {settings.includeUnconfirmed ? '' : 'Podés incluir títulos con disponibilidad no confirmada en Ajustes.'} <br /><Link to="/buscar" className="text-accent underline">Valorá más títulos</Link> para mejorar el ranking.</>}</Empty>
      )}
      <ol className="space-y-3" aria-label="Ranking personalizado">
        {rows.map((r) => (
          <RecCard key={r.key} item={r.item} meta={r.meta!} snap={r.snap} rating={ratings.get(r.key)} profileId={profileId}
            quickOpen={editing?.key === r.key && editing.mode === 'score'}
            onQuick={(o) => setEditing(o ? { key: r.key, mode: 'score' } : undefined)}
            onAspects={() => setEditing({ key: r.key, mode: 'aspects' })}
            onSaving={trackSave}
            onToggledWatched={(k) => setSticky((s) => new Set(s).add(k))} />
        ))}
      </ol>

      {editing?.mode === 'aspects' && editingRow?.meta && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/60" role="dialog" aria-modal="true" aria-label={`Valorar ${editingRow.meta.title}`} data-testid="aspects-sheet"
          onClick={(e) => { if (e.target === e.currentTarget && !saving) setEditing(undefined); }}>
          <div className="safe-bottom mx-auto max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-ink-900 p-4 ring-1 ring-white/10">
            <div className="mb-3 flex items-center gap-3">
              <Poster path={editingRow.meta.posterPath} title={editingRow.meta.title} className="h-14 w-10" />
              <div className="min-w-0"><div className="truncate font-semibold">{editingRow.meta.title}</div><div className="text-xs text-slate-400">Valoración por aspectos</div></div>
            </div>
            <RatingEditor profileId={profileId} k={editing.key} existing={ratings.get(editing.key)} isTv={editingRow.meta.type === 'tv'} openAspects
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
      <p className="pt-2 text-center text-[10px] text-slate-500">La nota estimada es una afinidad calculada (1-10), no una probabilidad. Datos: TMDB · Disponibilidad: JustWatch.</p>
    </div>
  );
}
