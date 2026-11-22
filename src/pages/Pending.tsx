import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { refreshAvailability } from '../services/catalog';
import { AvailabilityLine, DataStatus, Empty, Poster, TitleLink, TypeBadge } from '../ui/components';
import { useEffect, useMemo } from 'react';
import { useRatings } from '../hooks/useRatings';

export default function Pending() {
  const { profileId, settings } = useApp();
  const rs = useRatings(profileId);
  const items = useMemo(() => rs.ratings.filter((r) => r.list === 'want' || r.list === 'watching'), [rs.ratings]);
  const titles = useLiveQuery(() => db.titles.bulkGet(items.map((i) => i.key)), [items]) ?? [];
  const snaps = useLiveQuery(() => db.availability.bulkGet(items.map((i) => `${i.key}|${settings.country}`)), [items, settings.country]) ?? [];
  useEffect(() => { if (items.length) refreshAvailability(items.map((i) => i.key), settings.country, 30).catch(() => undefined); }, [items.length, settings.country]);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Pendientes</h1>
      <p className="text-sm text-slate-400">Lo que marcaste como «Quiero verla» o «Viéndola», con disponibilidad actualizada.</p>
      <DataStatus {...rs} onRetry={rs.retry} />
      {rs.status === 'ready' && items.length === 0 && <Empty>No tenés títulos pendientes.</Empty>}
      <ul className="space-y-2">
        {items.map((r, i) => (
          <li key={r.id}>
            <TitleLink k={r.key} className="flex gap-3 rounded-2xl bg-ink-900 p-2.5 ring-1 ring-white/5">
              <Poster path={titles[i]?.posterPath} title={titles[i]?.title ?? r.key} className="h-20 w-14 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{titles[i]?.title ?? r.key}</div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">{titles[i] && <TypeBadge type={titles[i]!.type} />}{r.list === 'watching' ? 'Viéndola' : 'Quiero verla'}</div>
                <div className="mt-1"><AvailabilityLine snap={snaps[i]} compact /></div>
              </div>
            </TitleLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
