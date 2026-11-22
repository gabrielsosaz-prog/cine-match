import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LIST_LABELS } from '../constants';
import { db } from '../db/db';
import { hasScore, migrateRating } from '../db/migrations';
import { useApp } from '../hooks/useApp';
import { setWatched } from '../services/ratings';
import type { ListStatus, MediaType, Rating, TitleMeta } from '../types';
import { Card, Chip, Empty, Poster, TitleLink, TypeBadge } from '../ui/components';
import { num, relTime } from '../ui/format';

type Sort = 'recent' | 'score' | 'title';
type View = 'all' | 'watched' | 'unwatched' | 'scored' | ListStatus;

const VIEWS: [View, string][] = [
  ['all', 'Todos'], ['watched', 'Vistos'], ['unwatched', 'No vistos'], ['scored', 'Puntuados'],
  ['want', LIST_LABELS.want], ['watching', LIST_LABELS.watching], ['abandoned', LIST_LABELS.abandoned], ['not_interested', LIST_LABELS.not_interested],
];

export function matchesView(r: Rating, v: View) {
  if (v === 'all') return true;
  if (v === 'watched') return r.watched;
  if (v === 'unwatched') return !r.watched;
  if (v === 'scored') return hasScore(r);
  return r.list === v;
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

  const rows = useMemo(() => {
    const r = ratings.filter((x) => matchesView(x, view) && (type === 'all' || tmap.get(x.key)?.type === type));
    return r.sort((a, b) => sort === 'recent' ? b.updatedAt - a.updatedAt : sort === 'score' ? (b.overall ?? -1) - (a.overall ?? -1) : (tmap.get(a.key)?.title ?? '').localeCompare(tmap.get(b.key)?.title ?? ''));
  }, [ratings, titles, view, type, sort]);

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
        </select>
      </div>
      {rows.length === 0 && <Empty>No hay títulos en esta vista. Buscá algo y marcalo como visto o puntualo.</Empty>}
      <ul className="space-y-2">{rows.map((r) => <RatingRow key={r.id} r={r} t={tmap.get(r.key)} profileId={profileId} />)}</ul>
    </div>
  );
}

function RatingRow({ r, t, profileId }: { r: Rating; t?: TitleMeta; profileId: string }) {
  return (
    <li data-testid="rating-row" className="flex items-center gap-2 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
      <TitleLink k={r.key} className="flex min-w-0 flex-1 items-center gap-3">
        <Poster path={t?.posterPath} title={t?.title ?? r.key} className="h-16 w-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t?.title ?? r.key}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            {t && <TypeBadge type={t.type} />}
            {r.list && <span>{LIST_LABELS[r.list]}</span>}
            <span>· {relTime(r.updatedAt)}</span>
          </div>
          {r.abandonReason && <div className="text-[11px] text-slate-500">Motivo: {r.abandonReason}</div>}
          {Object.keys(r.dimensions).length > 0 && <div className="text-[11px] text-slate-500">{Object.keys(r.dimensions).length} aspectos puntuados</div>}
        </div>
        <div className="text-xl font-bold text-accent" data-testid="row-score">{r.overall ?? '—'}</div>
      </TitleLink>
      <button type="button" aria-pressed={r.watched} data-testid="row-watched" onClick={() => setWatched(profileId, r.key, !r.watched)}
        className={`shrink-0 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${r.watched ? 'bg-emerald-500/20 text-emerald-300' : 'bg-ink-800 text-slate-400 ring-1 ring-white/10'}`}>
        {r.watched ? '✓ Vista' : 'No vista'}
      </button>
    </li>
  );
}
