import { useMemo, useState } from 'react';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIMENSIONS, LIST_LABELS, RETIRED_DIMENSIONS } from '../constants';
import { db } from '../db/db';
import { aspectCompletion, hasScore } from '../db/migrations';
import { useRatings } from '../hooks/useRatings';
import { useApp } from '../hooks/useApp';
import { setNotInterested, setWatched } from '../services/ratings';
import { safely } from '../services/notices';
import type { ListStatus, MediaType, Rating, TitleMeta } from '../types';
import { Card, Chip, CompletionRing, DataStatus, Empty, Poster, TitleLink, TypeBadge } from '../ui/components';
import RatingEditor from '../ui/RatingEditor';
import { num, relTime } from '../ui/format';

export type Sort = 'recent' | 'score' | 'title' | 'completion-desc' | 'completion-asc';
export type Dir = 'asc' | 'desc';
const SORTS = ['recent', 'score', 'title', 'completion-desc', 'completion-asc'] as const;
export type View = 'all' | 'watched' | 'unwatched' | 'scored' | 'complete' | 'incomplete' | 'dismissed' | ListStatus;

const VIEWS: [View, string][] = [
  ['all', 'Todos'], ['watched', 'Vistos'], ['unwatched', 'No vistos'], ['scored', 'Puntuados'],
  ['complete', 'Aspectos completos'], ['incomplete', 'Aspectos incompletos'],
  ['want', LIST_LABELS.want], ['watching', LIST_LABELS.watching], ['abandoned', LIST_LABELS.abandoned], ['dismissed', 'Descartados'],
];

export function matchesView(r: Rating, v: View) {
  if (v === 'all') return true;
  if (v === 'watched') return r.watched;
  if (v === 'unwatched') return !r.watched;
  if (v === 'scored') return hasScore(r);
  if (v === 'complete') return aspectCompletion(r).percent === 100;
  // Incompletos: títulos que valoraste (vista o con nota) y a los que les faltan aspectos
  if (v === 'incomplete') return aspectCompletion(r).percent < 100 && (r.watched || r.overall !== undefined || Object.keys(r.dimensions).length > 0);
  if (v === 'dismissed') return Boolean(r.notInterested);
  return r.list === v;
}

/** Dirección natural de cada orden (la que se usa con «desc» = predeterminada) */
export function sortRatings(rs: Rating[], sort: Sort, title: (r: Rating) => string, dir: Dir = sort === 'title' ? 'asc' : 'desc'): Rating[] {
  const pct = (r: Rating) => aspectCompletion(r).percent;
  // Comparación en sentido «descendente natural»; el título A-Z es el ascendente
  const cmp = (a: Rating, b: Rating) => sort === 'recent' ? b.updatedAt - a.updatedAt
    : sort === 'score' ? (b.overall ?? -1) - (a.overall ?? -1)
    : sort === 'completion-desc' ? pct(b) - pct(a) || b.updatedAt - a.updatedAt
    : sort === 'completion-asc' ? pct(a) - pct(b) || b.updatedAt - a.updatedAt
    : title(b).localeCompare(title(a), 'es');
  // Desempate estable por clave: editar un título no lo hace «saltar» entre posiciones equivalentes
  return [...rs].sort((a, b) => (dir === 'desc' ? cmp(a, b) : -cmp(a, b)) || a.key.localeCompare(b.key));
}

const dirLabel = (s: Sort, d: Dir) => s === 'title' ? (d === 'asc' ? 'A→Z' : 'Z→A') : s === 'recent' ? (d === 'desc' ? 'Nuevos primero' : 'Antiguos primero') : (d === 'desc' ? '↓ Mayor' : '↑ Menor');

export default function Ratings() {
  const { profileId } = useApp();
  const rs = useRatings(profileId);
  const ratings = rs.ratings;
  const titles = useLiveQuery(() => db.titles.bulkGet(ratings.map((r) => r.key)), [ratings]) ?? [];
  // Vista, tipo, orden y dirección se conservan al editar un título, al navegar y al recargar
  const [view, setView] = usePersistentState<View>(`cine-match:ratings-view:${profileId}`, 'all', oneOf(VIEWS.map(([v]) => v)));
  const [type, setType] = usePersistentState<MediaType | 'all'>(`cine-match:ratings-type:${profileId}`, 'all', oneOf(['all', 'movie', 'tv'] as const));
  const [sort, setSortRaw] = usePersistentState<Sort>(`cine-match:ratings-sort:${profileId}`, 'recent', oneOf(SORTS));
  const [dir, setDir] = usePersistentState<Dir>(`cine-match:ratings-dir:${profileId}`, 'desc', oneOf(['asc', 'desc'] as const));
  const setSort = (s: Sort) => { setSortRaw(s); setDir(s === 'title' ? 'asc' : 'desc'); };
  const tmap = new Map(titles.filter(Boolean).map((t) => [t!.key, t!]));

  const [editingKey, setEditingKey] = useState<string>();
  const rows = useMemo(() => {
    const r = ratings.filter((x) => matchesView(x, view) && (type === 'all' || tmap.get(x.key)?.type === type));
    return sortRatings(r, sort, (x) => tmap.get(x.key)?.title ?? '', dir);
  }, [ratings, titles, view, type, sort, dir]);
  const editing = ratings.find((r) => r.key === editingKey);
  const editingMeta = editing ? tmap.get(editing.key) : undefined;

  const scored = ratings.filter((r) => r.overall !== undefined);
  const avg = scored.length ? scored.reduce((a, r) => a + r.overall!, 0) / scored.length : NaN;
  const dist = Array.from({ length: 10 }, (_, i) => scored.filter((r) => Math.round(r.overall!) === i + 1).length);
  const maxD = Math.max(1, ...dist);
  const watchedCount = ratings.filter((r) => r.watched).length;
  const withAspects = ratings.filter((r) => Object.keys(r.dimensions).length).length;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mis valoraciones</h1>
      <Card>
        <div className="grid grid-cols-4 gap-2 text-center">
          <div><div className="text-2xl font-bold">{watchedCount}</div><div className="text-[11px] text-slate-400">vistos</div></div>
          <div><div className="text-2xl font-bold">{scored.length}</div><div className="text-[11px] text-slate-400">con nota</div></div>
          <div><div className="text-2xl font-bold">{withAspects}</div><div className="text-[11px] text-slate-400">con aspectos</div></div>
          <div><div className="text-2xl font-bold text-accent">{num(avg)}</div><div className="text-[11px] text-slate-400">nota media</div></div>
        </div>
        <div className="mt-3 flex h-16 items-end gap-1" aria-label="Distribución de notas">
          {dist.map((d, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-0.5">
              <div className="w-full rounded-t bg-accent/70" style={{ height: `${(d / maxD) * 100}%`, minHeight: d ? 3 : 0 }} title={`${d} con nota ${i + 1}`} />
              <span className="text-[9px] text-slate-500">{i + 1}</span>
            </div>
          ))}
        </div>
      </Card>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        {VIEWS.map(([v, l]) => <Chip key={v} testId={`view-${v}`} active={view === v} onClick={() => setView(v)}>{l}</Chip>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={type === 'all'} onClick={() => setType('all')} testId="ratings-type-all">Todo</Chip>
        <Chip active={type === 'movie'} onClick={() => setType('movie')} testId="ratings-type-movie">Películas</Chip>
        <Chip active={type === 'tv'} onClick={() => setType('tv')} testId="ratings-type-tv">Series</Chip>
        <div className="ml-auto flex items-center gap-1">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg bg-ink-800 p-1.5 text-sm ring-1 ring-white/10" aria-label="Ordenar" data-testid="ratings-sort">
            <option value="recent">Recientes</option><option value="score">Nota</option><option value="title">Título</option>
            <option value="completion-desc">Más aspectos completados</option><option value="completion-asc">Menos aspectos completados</option>
          </select>
          <button type="button" data-testid="ratings-dir" aria-label={`Dirección: ${dirLabel(sort, dir)}. Tocá para invertir`} onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
            className="rounded-lg bg-ink-800 px-2 py-1.5 text-xs ring-1 ring-white/10">{dirLabel(sort, dir)}</button>
          {(sort !== 'recent' || dir !== 'desc' || view !== 'all' || type !== 'all') && (
            <button type="button" data-testid="ratings-reset" onClick={() => { setSort('recent'); setView('all'); setType('all'); }} className="text-[11px] text-accent underline">Restablecer</button>
          )}
        </div>
      </div>
      <DataStatus {...rs} onRetry={rs.retry} />
      {rs.status === 'ready' && rows.length === 0 && <Empty>No hay títulos en esta vista. Buscá algo y marcalo como visto o puntualo.</Empty>}
      <p className="text-[11px] text-slate-500">El porcentaje indica cuántos de los {DIMENSIONS.length} aspectos puntuaste. Es sólo informativo: no hace falta llegar al 100 %.</p>
      <ul className="space-y-2">{rows.map((r) => <RatingRow key={r.id} r={r} t={tmap.get(r.key)} profileId={profileId} onComplete={() => setEditingKey(r.key)} />)}</ul>
      {editing && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/60" role="dialog" aria-modal="true" aria-label="Completar aspectos" data-testid="aspects-sheet"
          onClick={(e) => { if (e.target === e.currentTarget) setEditingKey(undefined); }}>
          <div className="safe-bottom mx-auto max-h-[88vh] w-full max-w-xl scroll-pb-24 scroll-pt-4 overflow-y-auto rounded-t-3xl bg-ink-900 p-4 ring-1 ring-white/10">
            <div className="mb-2 font-semibold">{editingMeta?.title ?? editing.key}</div>
            <p className="mb-2 text-[11px] text-slate-400">Resaltamos los aspectos que faltan. Completá sólo los que quieras.</p>
            <RatingEditor profileId={profileId} k={editing.key} existing={editing} isTv={editingMeta?.type === 'tv'} title={editingMeta} openAspects highlightMissing
              onCancel={() => setEditingKey(undefined)} onSaved={() => setEditingKey(undefined)} />
          </div>
        </div>
      )}
    </div>
  );
}

function RatingRow({ r, t, profileId, onComplete }: { r: Rating; t?: TitleMeta; profileId: string; onComplete: () => void }) {
  const c = aspectCompletion(r);
  const retired = Object.keys(r.legacy?.dimensions10 ?? {}).filter((k) => RETIRED_DIMENSIONS[k]);
  return (
    <li data-testid="rating-row" className="flex items-center gap-2 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
      <TitleLink k={r.key} className="flex min-w-0 flex-1 items-center gap-3">
        <Poster path={t?.posterPath} title={t?.title ?? r.key} className="h-16 w-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t?.title ?? r.key}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            {t && <TypeBadge type={t.type} />}
            {r.list && <span>{LIST_LABELS[r.list]}</span>}
            {r.notInterested && <span className="text-red-300">Descartado</span>}
            <span>· {relTime(r.updatedAt)}</span>
          </div>
          {r.abandonReason && <div className="text-[11px] text-slate-500">Motivo: {r.abandonReason}</div>}
          {r.comment && <div className="truncate text-[11px] italic text-slate-400">«{r.comment}»</div>}
          {retired.length > 0 && <div className="text-[10px] text-slate-500">Conservado de la versión anterior: {retired.map((k) => RETIRED_DIMENSIONS[k]).join(' y ')}</div>}
        </div>
        <div className="text-xl font-bold text-accent" data-testid="row-score">{r.overall ?? '—'}</div>
      </TitleLink>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button type="button" onClick={onComplete} data-testid="row-complete" aria-label={c.percent < 100 ? `Completar aspectos faltantes (${c.done} de ${c.total})` : `Editar aspectos (${c.done} de ${c.total})`}
          className="flex items-center gap-1 rounded-lg bg-ink-800 px-1.5 py-1 ring-1 ring-white/10"><CompletionRing {...c} />{c.percent < 100 && <span className="text-[10px] text-accent">＋</span>}</button>
        {r.notInterested
          ? <button type="button" data-testid="row-undo-dismiss" onClick={() => safely(() => setNotInterested(profileId, r.key, false), 'el cambio')} className="rounded-lg bg-ink-800 px-2 py-1 text-[11px] text-accent ring-1 ring-white/10">Volver a recomendar</button>
          : null}
      </div>
      <button type="button" aria-pressed={r.watched} data-testid="row-watched" onClick={() => safely(() => setWatched(profileId, r.key, !r.watched), 'la marca de vista')}
        className={`shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${r.watched ? 'bg-emerald-500/20 text-emerald-300' : 'bg-ink-800 text-slate-400 ring-1 ring-white/10'}`}>
        {r.watched ? '✓ Vista' : 'No vista'}
      </button>
    </li>
  );
}
