import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { friendlyError } from '../providers/errors';
import { getTitle } from '../services/catalog';
import { similarTo } from '../engine/recommender';
import { availabilityState } from '../services/availability';
import type { MediaType, TitleKey, TitleMeta } from '../types';
import { titleKey } from '../types';
import { AvailabilityLine, Card, ErrorNote, Poster, Spinner, TitleLink, TypeBadge } from '../ui/components';
import { dateTime } from '../ui/format';
import RatingPanel from './RatingPanel';

export default function TitlePage() {
  const { type, id } = useParams();
  const key = titleKey(type as MediaType, Number(id)) as TitleKey;
  const { settings, profileId } = useApp();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true); setError(undefined);
    getTitle(key, { language: settings.language, country: settings.country }).then((r) => { if (r.error) setError(friendlyError(r.error)); }).finally(() => setLoading(false));
  }, [key, settings.language, settings.country]);
  const meta = useLiveQuery(() => db.titles.get(key), [key]);
  const snap = useLiveQuery(() => db.availability.get(`${key}|${settings.country}`), [key, settings.country]);
  const rating = useLiveQuery(() => db.ratings.get(`${profileId}|${key}`), [profileId, key]);
  const related = useLiveQuery(async () => {
    if (!meta?.related?.length) return [];
    const rel = (await db.titles.bulkGet(meta.related)).filter((m): m is TitleMeta => Boolean(m));
    const map = new Map<TitleKey, TitleMeta>([[meta.key, meta], ...rel.map((m) => [m.key, m] as [TitleKey, TitleMeta])]);
    return similarTo(meta.key, map, rel.map((r) => r.key), 10).map((s) => map.get(s.key)!);
  }, [meta?.key, meta?.fetchedAt]);

  if (!meta && loading) return <Spinner />;
  if (!meta) return <ErrorNote>{error ?? 'No se encontró el título.'}</ErrorNote>;
  const st = availabilityState(snap);
  return (
    <article className="space-y-4">
      {meta.backdropPath && <Poster path={meta.backdropPath} size="w780" title={meta.title} className="-mx-4 -mt-4 aspect-video w-[calc(100%+2rem)] max-w-none rounded-none opacity-60" />}
      <div className={`flex gap-3 ${meta.backdropPath ? '-mt-20 relative' : ''}`}>
        <Poster path={meta.posterPath} size="w342" title={meta.title} className="h-40 w-28 shrink-0 shadow-xl" />
        <div className="min-w-0 self-end">
          <h1 className="text-xl font-bold leading-tight">{meta.title}</h1>
          {meta.originalTitle && meta.originalTitle !== meta.title && <div className="text-sm italic text-slate-400">{meta.originalTitle}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
            <TypeBadge type={meta.type} />
            <span>{meta.year ?? 'Año sin datos'}</span>
            {meta.runtime && <span>· {meta.runtime} min{meta.type === 'tv' ? '/ep.' : ''}</span>}
            {meta.numberOfSeasons && <span>· {meta.numberOfSeasons} {meta.numberOfSeasons === 1 ? 'temporada' : 'temporadas'}</span>}
            {meta.voteAverage ? <span>· TMDB {meta.voteAverage.toFixed(1)}</span> : null}
          </div>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap gap-1.5">{meta.genres.map((g) => <span key={g.id} className="rounded-full bg-ink-800 px-2.5 py-1 text-xs">{g.name}</span>)}</div>
      <p className="text-sm leading-relaxed text-slate-300">{meta.overview ?? <span className="italic text-slate-500">Sinopsis no disponible.</span>}{meta.overviewLang === 'en' && <span className="block text-[11px] text-slate-500">(Sinopsis en inglés: no hay traducción al español en TMDB.)</span>}</p>

      <Card className="space-y-2">
        <h2 className="font-semibold">Dónde verla ({settings.country})</h2>
        <AvailabilityLine snap={snap} />
        {snap?.status === 'ok' && snap.offers.filter((o) => !o.platform).length > 0 && (
          <p className="text-xs text-slate-400">Otras opciones: {[...new Set(snap.offers.filter((o) => !o.platform).map((o) => `${o.providerName} (${o.kind === 'rent' ? 'alquiler' : o.kind === 'buy' ? 'compra' : 'suscripción'})`))].slice(0, 6).join(', ')}</p>
        )}
        <p className="text-[11px] text-slate-500">
          {snap ? <>Fuente: {snap.source} · última verificación {dateTime(snap.checkedAt)}. </> : null}
          {st.kind !== 'confirmed' && 'La disponibilidad puede no estar confirmada. '}
          {snap?.link && <a href={snap.link} target="_blank" rel="noreferrer" className="text-accent underline">Ver en JustWatch/TMDB</a>}
        </p>
      </Card>

      <RatingPanel profileId={profileId} k={key} existing={rating} isTv={meta.type === 'tv'} />

      {(meta.directors.length > 0 || meta.cast.length > 0) && (
        <Card className="space-y-1 text-sm">
          {meta.directors.length > 0 && <p><span className="text-slate-400">{meta.type === 'movie' ? 'Dirección' : 'Creación'}:</span> {meta.directors.map((d) => d.name).join(', ')}</p>}
          {meta.cast.length > 0 && <p><span className="text-slate-400">Reparto:</span> {meta.cast.slice(0, 6).map((c) => c.name).join(', ')}</p>}
        </Card>
      )}
      {meta.seasons && meta.seasons.length > 0 && (
        <details className="rounded-2xl bg-ink-900 p-4 text-sm ring-1 ring-white/5"><summary className="font-semibold">Temporadas ({meta.seasons.length})</summary>
          <ul className="mt-2 space-y-1 text-slate-300">{meta.seasons.map((s) => <li key={s.number}>{s.name} · {s.episodes ?? '?'} episodios{s.airDate ? ` · ${s.airDate.slice(0, 4)}` : ''}</li>)}</ul>
        </details>
      )}
      {meta.missing.length > 0 && <p className="text-[11px] text-slate-500">Datos no disponibles en el proveedor: {meta.missing.join(', ')}.</p>}

      {related && related.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Títulos similares</h2>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
            {related.map((r) => (
              <TitleLink key={r.key} k={r.key} className="w-24 shrink-0">
                <Poster path={r.posterPath} title={r.title} className="h-36 w-24" />
                <div className="mt-1 line-clamp-2 text-xs">{r.title}</div>
              </TitleLink>
            ))}
          </div>
        </section>
      )}
      <p className="text-center text-[10px] text-slate-500">Metadatos: TMDB. Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB. Disponibilidad: JustWatch.</p>
    </article>
  );
}
