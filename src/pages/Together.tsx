/**
 * v4.2 · «Para ver juntos»: títulos que vos y un contacto tienen en «Quiero ver».
 * Requiere la autorización explícita de ambos. El servidor devuelve sólo la intersección (nunca la lista del otro) y
 * la puntuación del otro sólo si la compartió. El orden conjunto es un criterio simple y transparente (social/joint.ts),
 * fuera de los motores; sin las dos puntuaciones no se calcula.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { PLATFORMS } from '../constants';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { useRatings } from '../hooks/useRatings';
import { availabilityState } from '../services/availability';
import { getTitle, refreshAvailability } from '../services/catalog';
import { pushNotice, safely } from '../services/notices';
import { predictFor } from '../services/recommendations';
import { interestMap, recordInterest } from '../services/taste';
import { JOINT_PENALTY, jointScore } from '../social/joint';
import { fetchMatches, refresh, updateContact, wantDirty } from '../social/store';
import { toSocialError, type Match } from '../social/types';
import { useSocial } from '../social/useSocial';
import type { MediaType, PlatformId, RecommendationItem, TitleKey, TitleMeta } from '../types';
import { Chip, Empty, personalState, publicScore } from '../ui/components';
import { num } from '../ui/format';
import TitleCard, { type CardInfo } from '../ui/TitleCard';
import { SocialGate } from './Inbox';

type Sort = 'propia' | 'tmdb' | 'recientes' | 'conjunta';

export default function Together() {
  return <SocialGate><TogetherInner /></SocialGate>;
}

function TogetherInner() {
  const s = useSocial();
  const contacts = s.contacts.filter((c) => c.linked && !c.blocked);
  const fav = contacts.find((c) => c.favorite);
  const [who, setWho] = useState<string | undefined>(fav?.id ?? contacts[0]?.id);
  useEffect(() => { if (!who || !contacts.some((c) => c.id === who)) setWho(fav?.id ?? contacts[0]?.id); }, [contacts.map((c) => c.id).join(',')]);
  useEffect(() => { void refresh(true); }, []);
  if (!contacts.length) return <Empty>Vinculá a alguien en <Link to="/ajustes/contactos" className="text-accent underline">Mis contactos</Link> para encontrar títulos que los dos quieran ver.</Empty>;
  const c = contacts.find((x) => x.id === who) ?? contacts[0];
  return (
    <div className="space-y-3">
      {contacts.length > 1 && (
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">{contacts.map((x) => <Chip key={x.id} active={x.id === c.id} onClick={() => setWho(x.id)} testId="together-contact">{x.alias}</Chip>)}</div>
      )}
      <Permissions contactId={c.id} />
      {c.shareMatches && c.theirShareMatches && <MatchList key={c.id} contactId={c.id} alias={c.alias} theirScores={c.theirShareScores} />}
    </div>
  );
}

function Permissions({ contactId }: { contactId: string }) {
  const s = useSocial();
  const c = s.contacts.find((x) => x.id === contactId)!;
  const [busy, setBusy] = useState(false);
  const [withScore, setWithScore] = useState(true);
  const act = async (patch: Parameters<typeof updateContact>[1]) => {
    setBusy(true);
    try { await updateContact(c.id, patch); wantDirty(0); } catch (e) { pushNotice({ kind: 'error', text: toSocialError(e).message }); } finally { setBusy(false); }
  };
  if (!c.shareMatches) return (
    <div className="space-y-2 rounded-2xl bg-ink-900 p-4 text-sm text-slate-300 ring-1 ring-white/5" data-testid="together-authorize">
      <p>Para ver juntos compara tu lista «Quiero ver» con la de <b>{c.alias}</b> y muestra sólo los títulos que tienen en común. {c.alias} no ve tu lista completa, ni tus notas ni tu historial.</p>
      {c.theirShareMatches && <p className="text-emerald-300">{c.alias} ya lo autorizó.</p>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={withScore} onChange={(e) => setWithScore(e.target.checked)} className="mt-1" data-testid="together-share-score" />
        <span>Mostrarle también mi puntuación «Para vos» de esos títulos (para ordenar por coincidencia conjunta).</span></label>
      <button type="button" disabled={busy} data-testid="together-enable" onClick={() => void act({ shareMatches: true, shareScores: withScore })}
        className="w-full rounded-xl bg-accent py-2.5 font-bold text-ink-950 disabled:opacity-50">Autorizar con {c.alias}</button>
    </div>
  );
  return (
    <div className="space-y-1 rounded-xl bg-ink-900 p-3 text-xs text-slate-400 ring-1 ring-white/5" data-testid="together-status">
      <p>Autorizaste Para ver juntos con {c.alias}{c.shareScores ? ' y compartís tu puntuación' : ' sin compartir tu puntuación'}. <Link to="/ajustes/privacidad" className="text-accent underline">Cambiar</Link></p>
      {!c.theirShareMatches && <p className="text-amber-200" data-testid="together-waiting">Falta que {c.alias} lo autorice desde su app (Me recomendaron › Para ver juntos).</p>}
    </div>
  );
}

function MatchList({ contactId, alias, theirScores }: { contactId: string; alias: string; theirScores: boolean }) {
  const { profileId, settings } = useApp();
  const rs = useRatings(profileId);
  const [matches, setMatches] = useState<Match[]>();
  const [error, setError] = useState<string>();
  const wantSig = rs.ratings.filter((r) => r.list === 'want' || r.list === 'watching').map((r) => r.key).sort().join(',');
  const load = async () => {
    try { setMatches(await fetchMatches(contactId)); setError(undefined); } catch (e) { setError(toSocialError(e).message); }
  };
  useEffect(() => { void load(); const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000); return () => clearInterval(t); }, [contactId, wantSig, theirScores]);
  const keys = useMemo(() => (matches ?? []).map((m) => m.key), [matches]);
  const sig = keys.join(',');
  const titles = useLiveQuery(() => db.titles.bulkGet(keys), [sig]) ?? [];
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [sig, settings.country]) ?? [];
  const fetched = useRef(new Set<TitleKey>());
  useEffect(() => {
    keys.forEach((k, i) => { if (!titles[i] && !fetched.current.has(k)) { fetched.current.add(k); getTitle(k, { language: settings.language, country: settings.country }).catch(() => undefined); } });
    if (keys.length) refreshAvailability(keys, settings.country, 30).catch(() => undefined);
  }, [sig, titles.filter(Boolean).length]);
  const [preds, setPreds] = useState<Map<TitleKey, RecommendationItem>>(new Map());
  const ready = keys.filter((_, i) => titles[i]);
  useEffect(() => { if (ready.length) predictFor(profileId, ready, { holdOut: true }).then(setPreds).catch(() => undefined); }, [ready.join(','), profileId]);
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);

  // Filtros
  const [type, setType] = useState<'all' | MediaType>('all');
  const [plats, setPlats] = useState<PlatformId[]>([]);
  const [len, setLen] = useState<'all' | 'corta' | 'larga'>('all');
  const [genre, setGenre] = useState<number>();
  const [sort, setSort] = useState<Sort>(theirScores ? 'conjunta' : 'propia');
  const metaOf = new Map<TitleKey, TitleMeta>(titles.filter(Boolean).map((t) => [t!.key, t!]));
  const snapOf = new Map(keys.map((k, i) => [k, snaps[i]]));
  const genres = [...new Map([...metaOf.values()].flatMap((m) => m.genres).filter((g) => !/^Género \d+$/.test(g.name)).map((g) => [g.id, g.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const mine = (k: TitleKey) => { const p = preds.get(k); return p && personalState(p).kind !== 'insufficient' ? p.score : undefined; };
  const isShort = (m: TitleMeta) => (m.type === 'movie' ? (m.runtime ?? 999) <= 100 : (m.numberOfSeasons ?? 99) <= 2);
  const list = (matches ?? []).filter((m) => {
    const meta = metaOf.get(m.key);
    if (type !== 'all' && !m.key.startsWith(type)) return false;
    if (!meta) return type === 'all' && !plats.length && len === 'all' && genre === undefined;
    if (len !== 'all' && isShort(meta) !== (len === 'corta')) return false;
    if (genre !== undefined && !meta.genres.some((g) => g.id === genre)) return false;
    if (plats.length) { const st = availabilityState(snapOf.get(m.key)); if (st.kind !== 'confirmed' || !st.platforms.some((p) => plats.includes(p))) return false; }
    return true;
  });
  const val = (m: Match) => {
    if (sort === 'tmdb') return publicScore(metaOf.get(m.key)) ?? -1;
    if (sort === 'recientes') return Math.max(m.myAddedAt, m.theirAddedAt);
    if (sort === 'conjunta') return jointScore(mine(m.key), m.theirScore) ?? -1;
    return mine(m.key) ?? -1;
  };
  const sorted = [...list].sort((a, b) => val(b) - val(a) || a.key.localeCompare(b.key));
  const canJoint = theirScores;

  return (
    <div className="space-y-3" data-testid="together-list" data-count={matches?.length ?? -1}>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as typeof type)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10"><option value="all">Películas y series</option><option value="movie">Películas</option><option value="tv">Series</option></select>
        <select aria-label="Orden" data-testid="together-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10">
          <option value="propia">Mejor puntuación propia</option><option value="tmdb">TMDB</option><option value="recientes">Agregadas recientemente</option>
          <option value="conjunta" disabled={!canJoint}>Mejor coincidencia conjunta{canJoint ? '' : ' (no disponible)'}</option>
        </select>
        <select aria-label="Duración" value={len} onChange={(e) => setLen(e.target.value as typeof len)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10"><option value="all">Cualquier duración</option><option value="corta">Cortas (≤ 100 min / ≤ 2 temp.)</option><option value="larga">Largas</option></select>
        <select aria-label="Género" value={genre ?? ''} onChange={(e) => setGenre(e.target.value ? Number(e.target.value) : undefined)} className="min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10"><option value="">Todos los géneros</option>{genres.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
      </div>
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
        {PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <Chip key={p.id} active={plats.includes(p.id)} onClick={() => setPlats(plats.includes(p.id) ? plats.filter((x) => x !== p.id) : [...plats, p.id])}>{p.label}</Chip>)}
      </div>
      {sort === 'conjunta' && <p className="text-[11px] text-slate-500">Coincidencia conjunta = promedio de las dos puntuaciones − {JOINT_PENALTY.toString().replace('.', ',')} × su diferencia. Los títulos sin las dos puntuaciones van al final.</p>}
      {error && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" role="status">{error} <button type="button" className="font-semibold underline" onClick={() => void load()}>Reintentar</button></p>}
      {matches === undefined && !error && <p className="text-sm text-slate-400">Buscando coincidencias…</p>}
      {matches && !matches.length && <Empty>Todavía no tienen títulos en común en «Quiero ver». Guardá títulos con «Quiero verla» y aparecerán acá cuando {alias} también los guarde.</Empty>}
      {matches && matches.length > 0 && !sorted.length && <Empty>No hay coincidencias con estos filtros.</Empty>}
      <ul className="space-y-3">
        {sorted.map((m) => {
          const meta = metaOf.get(m.key);
          if (!meta) return <li key={m.key} className="rounded-2xl bg-ink-900 p-3 text-sm text-slate-400 ring-1 ring-white/5">Cargando ficha…</li>;
          const p = preds.get(m.key);
          const ps = personalState(p);
          const my = mine(m.key);
          const joint = jointScore(my, m.theirScore);
          const info: CardInfo = {
            compat: 'Ambos quieren verla',
            primaryLabel: 'Para vos', primary: my,
            why: p?.explanation ?? [],
            badges: <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-300" data-testid="together-both">Ambos quieren verla</span>,
            reliability: [
              p ? `«Para vos» es TU estimación (motor v3.4)${ps.kind === 'provisional' ? ', provisional' : ''}.` : 'Calculando tu estimación…',
              m.theirScore !== undefined ? `La puntuación de ${alias} es la estimación de SU app para su perfil; ${alias} eligió compartirla.` : `${alias} no comparte su puntuación.`,
            ],
          };
          return (
            <TitleCard key={m.key} k={m.key} meta={meta} snap={snapOf.get(m.key)} rating={rs.byKey.get(m.key)} info={info} profileId={profileId} testId="together-item"
              interest={{ value: interests?.get(m.key)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, m.key, a, { engine: 'juntos', source: 'juntos' }), 'tu respuesta'); } }}
              actionsExtra={
                <div className="mt-2 grid grid-cols-3 gap-1.5 text-center" data-testid="together-scores">
                  <div className="rounded-lg px-1 py-1" style={{ background: '#302519' }}><div className="text-[10px]" style={{ color: '#E8CF9C' }}>Vos</div><div className="text-base font-extrabold" style={{ color: '#FFBB38' }}>{my !== undefined ? num(my) : '–'}</div></div>
                  <div className="rounded-lg bg-sky-500/10 px-1 py-1"><div className="truncate text-[10px] text-sky-200">{alias}</div><div className="text-base font-extrabold text-sky-300" data-testid="together-their">{m.theirScore !== undefined ? num(m.theirScore) : '–'}</div></div>
                  <div className="rounded-lg bg-emerald-500/10 px-1 py-1"><div className="text-[10px] text-emerald-200">Conjunta</div><div className="text-base font-extrabold text-emerald-300" data-testid="together-joint">{joint !== undefined ? num(joint) : '–'}</div></div>
                </div>
              } />
          );
        })}
      </ul>
    </div>
  );
}
