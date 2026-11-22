import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { STATUS_LABELS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import type { MediaType, Rating, TitleMeta, WatchStatus } from '../types';
import { Card, Chip, Empty, Poster, TitleLink, TypeBadge } from '../ui/components';
import { num, relTime } from '../ui/format';

type Sort = 'recent' | 'score' | 'title';

export default function Ratings() {
  const { profileId } = useApp();
  const ratings = useLiveQuery(() => db.ratings.where('profileId').equals(profileId).toArray(), [profileId]) ?? [];
  const titles = useLiveQuery(() => db.titles.bulkGet(ratings.map((r) => r.key)), [ratings]) ?? [];
  const [status, setStatus] = useState<WatchStatus | 'all'>('all');
  const [type, setType] = useState<MediaType | 'all'>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const tmap = new Map(titles.filter(Boolean).map((t) => [t!.key, t!]));

  const rows = useMemo(() => {
    const r = ratings.filter((x) => (status === 'all' || x.status === status) && (type === 'all' || tmap.get(x.key)?.type === type));
    return r.sort((a, b) => sort === 'recent' ? b.updatedAt - a.updatedAt : sort === 'score' ? (b.overall ?? -1) - (a.overall ?? -1) : (tmap.get(a.key)?.title ?? '').localeCompare(tmap.get(b.key)?.title ?? ''));
  }, [ratings, titles, status, type, sort]);

  const scored = ratings.filter((r) => r.overall !== undefined);
  const avg = scored.length ? scored.reduce((a, r) => a + r.overall!, 0) / scored.length : NaN;
  const dist = Array.from({ length: 10 }, (_, i) => scored.filter((r) => Math.round(r.overall!) === i + 1).length);
  const maxD = Math.max(1, ...dist);
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, ratings.filter((r) => r.status === s).length]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Mis valoraciones</h1>
      <Card>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div><div className="text-2xl font-bold">{ratings.length}</div><div className="text-[11px] text-slate-400">títulos</div></div>
          <div><div className="text-2xl font-bold">{scored.length}</div><div className="text-[11px] text-slate-400">puntuados</div></div>
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
        <p className="mt-2 text-[11px] text-slate-400">{Object.entries(counts).filter(([, c]) => c).map(([s, c]) => `${STATUS_LABELS[s as WatchStatus]}: ${c}`).join(' · ')}</p>
      </Card>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
        <Chip active={status === 'all'} onClick={() => setStatus('all')}>Todas</Chip>
        {(Object.keys(STATUS_LABELS) as WatchStatus[]).map((s) => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{STATUS_LABELS[s]}</Chip>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={type === 'all'} onClick={() => setType('all')}>Todo</Chip>
        <Chip active={type === 'movie'} onClick={() => setType('movie')}>Películas</Chip>
        <Chip active={type === 'tv'} onClick={() => setType('tv')}>Series</Chip>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="ml-auto rounded-lg bg-ink-800 p-1.5 text-sm ring-1 ring-white/10" aria-label="Ordenar">
          <option value="recent">Recientes</option><option value="score">Mejor nota</option><option value="title">Título</option>
        </select>
      </div>
      {rows.length === 0 && <Empty>Todavía no hay títulos acá. Buscá algo que hayas visto y puntualo.</Empty>}
      <ul className="space-y-2">{rows.map((r) => <RatingRow key={r.id} r={r} t={tmap.get(r.key)} />)}</ul>
    </div>
  );
}

function RatingRow({ r, t }: { r: Rating; t?: TitleMeta }) {
  return (
    <li data-testid="rating-row">
      <TitleLink k={r.key} className="flex items-center gap-3 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
        <Poster path={t?.posterPath} title={t?.title ?? r.key} className="h-16 w-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t?.title ?? r.key}</div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">{t && <TypeBadge type={t.type} />}<span>{STATUS_LABELS[r.status]}</span><span>· {relTime(r.updatedAt)}</span></div>
          {r.abandonReason && <div className="text-[11px] text-slate-500">Motivo: {r.abandonReason}</div>}
          {Object.keys(r.dimensions).length > 0 && <div className="text-[11px] text-slate-500">{Object.keys(r.dimensions).length} aspectos puntuados</div>}
        </div>
        <div className="text-xl font-bold text-accent">{r.overall ?? '—'}</div>
        <span className="text-slate-500" aria-hidden>›</span>
      </TitleLink>
    </li>
  );
}
