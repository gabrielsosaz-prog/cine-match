import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIMENSIONS, LIST_LABELS, RETIRED_DIMENSIONS } from '../constants';
import { db } from '../db/db';
import { aspectCompletion, hasScore, migrateRating } from '../db/migrations';
import { useApp } from '../hooks/useApp';
import { setNotInterested, setWatched } from '../services/ratings';
import type { ListStatus, MediaType, Rating, TitleMeta } from '../types';
import { Card, Chip, CompletionRing, Empty, Poster, TitleLink, TypeBadge } from '../ui/components';
import RatingEditor from '../ui/RatingEditor';
import { num, relTime } from '../ui/format';

type Sort = 'recent' | 'score' | 'title' | 'completion-desc' | 'completion-asc';
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

export function sortRatings(rs: Rating[], sort: Sort, title: (r: Rating) => string): Rating[] {
  const pct = (r: Rating) => aspectCompletion(r).percent;
  return [...rs].sort((a, b) => sort === 'recent' ? b.updatedAt - a.updatedAt
    : sort === 'score' ? (b.overall ?? -1) - (a.overall ?? -1)
    : sort === 'completion-desc' ? pct(b) - pct(a) || b.updatedAt - a.updatedAt
    : sort === 'completion-asc' ? pct(a) - pct(b) || b.updatedAt - a.updatedAt
    : title(a).localeCompare(title(b)));
}

export default function Ratings() {
  const { profileId } = useApp();
  const raw = useLiveQuery(() => db.ratings.where('profileId').equals(profileId).toArray(), [profileId]);
  const ratings = useMemo(() => (raw ?? []).map(migrateRating), [raw]);
  const titles = useLiveQuery(() => db.titles.bulkGet(ratings.map((r) => r.key)), [ratings]) ?? [];
  const [view, setView] = useState<View>('all');
  const [type, setType] = useState<MediaType | 'all'>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const tmap = new Map(titles.filter(Boolean).map((t) => [t!.key, t!]));

  const [editingKey, setEditingKey] = useState<string>();
  const rows = useMemo(() => {
    const r = ratings.filter((x) => matchesView(x, view) && (type === 'all' || tmap.get(x.key)?.type === type));
    return sortRatings(r, sort, (x) => tmap.get(x.key)?.title ?? '');
  }, [ratings, titles, view, type, sort]);
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
        <Chip active={type === 'all'} onClick={() => setType('all')}>Todo</Chip>
        <Chip active={type === 'movie'} onClick={() => setType('movie')}>Películas</Chip>
        <Chip active={type === 'tv'} onClick={() => setType('tv')}>Series</Chip>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="ml-auto rounded-lg bg-ink-800 p-1.5 text-sm ring-1 ring-white/10" aria-label="Ordenar">
          <option value="recent">Recientes</option><option value="score">Mejor nota</option><option value="title">Título</option>
          <option value="completion-desc">Más aspectos completados</option><option value="completion-asc">Menos aspectos completados</option>
        </select>
      </div>
      {rows.length === 0 && <Empty>No hay títulos en esta vista. Buscá algo y marcalo como visto o puntualo.</Empty>}
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
          ? <button type="button" data-testid="row-undo-dismiss" onClick={() => setNotInterested(profileId, r.key, false)} className="rounded-lg bg-ink-800 px-2 py-1 text-[11px] text-accent ring-1 ring-white/10">Volver a recomendar</button>
          : null}
      </div>
      <button type="button" aria-pressed={r.watched} data-testid="row-watched" onClick={() => setWatched(profileId, r.key, !r.watched)}
        className={`shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${r.watched ? 'bg-emerald-500/20 text-emerald-300' : 'bg-ink-800 text-slate-400 ring-1 ring-white/10'}`}>
        {r.watched ? '✓ Vista' : 'No vista'}
      </button>
    </li>
  );
}
