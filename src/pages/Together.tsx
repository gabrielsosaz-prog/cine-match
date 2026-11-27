/**
 * v4.3 · «Para ver juntos»: candidatos por dos vías, deduplicados por contacto + tipo + id TMDB.
 *   1. Ambos lo guardaron en «Quiero ver» y autorizaron Para ver juntos (como en v4.2).
 *   2. Ambos expresaron interés en un título intercambiado y autorizaron compartir intereses.
 * Orden: interés explícito de ambos (categoría) → puntaje conjunto de v4.2 si ambos puntajes están autorizados → TMDB
 * → fecha → identificador. Los motores individuales no se tocan; nada se inventa: sin dato, no se muestra ni se deduce.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORMS } from '../constants';
import { useApp } from '../hooks/useApp';
import { oneOf, usePersistentState } from '../hooks/usePersistentState';
import { availabilityState } from '../services/availability';
import { pushNotice, safely } from '../services/notices';
import { interestMap, recordInterest } from '../services/taste';
import { combinedLevel, compareMatches, dedupeMatches, isPositive, joint, JOINT_PENALTY, LEVEL_LABEL, LEVEL_TONE, type MatchLevel, type RankItem } from '../social/interests';
import { fetchMatches, refresh, syncWantNow, theirState, updateContact } from '../social/store';
import { toSocialError, type Contact, type Match } from '../social/types';
import { useSocial } from '../social/useSocial';
import type { MediaType, PlatformId, TitleKey, TitleMeta } from '../types';
import { Chip, Empty, personalState, publicScore } from '../ui/components';
import { num } from '../ui/format';
import TitleCard from '../ui/TitleCard';
import { myInfo, SocialGate, useCardData, useMyAnswers, useTabScroll } from './Inbox';
import { useLiveQuery } from 'dexie-react-hooks';
import { listRatings } from '../db/repo';

export default function Together({ focus, focusContact }: { focus?: string; focusContact?: string }) {
  return <SocialGate><TogetherInner focus={focus as TitleKey | undefined} focusContact={focusContact} /></SocialGate>;
}

const LEVEL_FILTERS = ['positivas', 'maxima', 'muy_alta', 'alta', 'posibles', 'pendientes', 'sin', 'todas'] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];
const SORTS = ['coincidencia', 'propia', 'tmdb', 'recientes', 'conjunta'] as const;
type Sort = (typeof SORTS)[number];
const passLevel = (f: LevelFilter, l: MatchLevel) => f === 'todas' ? true : f === 'positivas' ? isPositive(l) : f === 'posibles' ? l === 'posible' || l === 'posible_baja' : f === 'pendientes' ? l === 'pendiente' : l === f;
const sel = 'min-w-0 rounded-lg bg-ink-800 p-2 ring-1 ring-white/10';

function TogetherInner({ focus, focusContact }: { focus?: TitleKey; focusContact?: string }) {
  const { profileId } = useApp();
  const s = useSocial();
  const contacts = s.contacts.filter((c) => c.linked && !c.blocked);
  const [who, setWho] = usePersistentState<string>(`cine-match:compartidas:juntos:${profileId}:who`, 'all');
  useEffect(() => { void refresh(true); }, []);
  useEffect(() => { if (focusContact && contacts.some((c) => c.id === focusContact)) setWho(focusContact); }, [focusContact, contacts.length]);
  if (!contacts.length) return <Empty>Vinculá a alguien en <Link to="/ajustes/contactos" className="text-accent underline">Mis contactos</Link> para encontrar títulos que los dos quieran ver.</Empty>;
  // Con un solo contacto se comporta como en v4.2 (ese contacto seleccionado)
  const single = contacts.length === 1;
  const current = single ? contacts[0] : contacts.find((c) => c.id === who);
  const usable = (c: Contact) => (c.shareMatches && c.theirShareMatches) || (c.shareInterests && c.theirShareInterests);
  const shown = current ? (usable(current) ? [current] : []) : contacts.filter(usable);
  return (
    <div className="space-y-3">
      {!single && (
        <div className="flex flex-wrap gap-1.5" data-testid="together-contacts">
          <Chip active={!current} onClick={() => setWho('all')} testId="together-contact-all">Todos</Chip>
          {contacts.map((x) => <Chip key={x.id} active={current?.id === x.id} onClick={() => setWho(x.id)} testId="together-contact">{x.alias}</Chip>)}
        </div>
      )}
      {current ? <Permissions contactId={current.id} /> : contacts.filter((c) => !usable(c)).length > 0 && (
        <p className="rounded-lg bg-ink-900 p-2 text-[11px] text-slate-400 ring-1 ring-white/5" data-testid="together-missing">Sin autorización mutua con {contacts.filter((c) => !usable(c)).map((c) => c.alias).join(', ')}: elegí ese contacto arriba para ver qué falta.</p>
      )}
      {shown.length > 0 && <MatchList key={shown.map((c) => c.id).join(',')} contacts={shown} focus={focus} />}
    </div>
  );
}

function Permissions({ contactId }: { contactId: string }) {
  const s = useSocial();
  const c = s.contacts.find((x) => x.id === contactId)!;
  const [busy, setBusy] = useState(false);
  const [withScore, setWithScore] = useState(true);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await syncWantNow(); } catch (e) { pushNotice({ kind: 'error', text: toSocialError(e).message }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      {!c.shareMatches ? (
        <div className="space-y-2 rounded-2xl bg-ink-900 p-4 text-sm text-slate-300 ring-1 ring-white/5" data-testid="together-authorize">
          <p>Para ver juntos compara tu lista «Quiero ver» con la de <b>{c.alias}</b> y muestra sólo los títulos que tienen en común. {c.alias} no ve tu lista completa, ni tus notas ni tu historial.</p>
          {c.theirShareMatches && <p className="text-emerald-300">{c.alias} ya lo autorizó.</p>}
          <label className="flex items-start gap-2"><input type="checkbox" checked={withScore} onChange={(e) => setWithScore(e.target.checked)} className="mt-1" data-testid="together-share-score" />
            <span>Mostrarle también mi puntuación «Para vos» de esos títulos (para ordenar por coincidencia conjunta).</span></label>
          <button type="button" disabled={busy} data-testid="together-enable" onClick={() => void act(() => updateContact(c.id, { shareMatches: true, shareScores: withScore }))}
            className="w-full rounded-xl bg-accent py-2.5 font-bold text-ink-950 disabled:opacity-50">Autorizar con {c.alias}</button>
        </div>
      ) : (
        <div className="space-y-1 rounded-xl bg-ink-900 p-3 text-xs text-slate-400 ring-1 ring-white/5" data-testid="together-status">
          <p>Autorizaste Para ver juntos con {c.alias}{c.shareScores ? ' y compartís tu puntuación' : ' sin compartir tu puntuación'}. <Link to="/ajustes/privacidad" className="text-accent underline">Cambiar</Link></p>
          {!c.theirShareMatches && <p className="text-amber-200" data-testid="together-waiting">Falta que {c.alias} lo autorice desde su app (Compartidas › Para ver juntos).</p>}
        </div>
      )}
      <div className="rounded-xl bg-ink-900 p-3 text-xs text-slate-400 ring-1 ring-white/5" data-testid="together-interests">
        {c.shareInterests ? (
          <p>Compartís tus intereses con {c.alias} en los títulos que se recomiendan.{!c.theirShareInterests && <span className="text-amber-200" data-testid="together-interests-waiting"> Falta que {c.alias} también lo active.</span>}</p>
        ) : (
          <p>Las coincidencias por interés (👍 / ♥) necesitan que ambos activen «Compartir intereses».{c.theirShareInterests ? ` ${c.alias} ya lo activó.` : ''} <Link to="/ajustes/privacidad" className="font-semibold text-accent underline" data-testid="together-interests-link">Activar en Privacidad</Link></p>
        )}
      </div>
    </div>
  );
}

interface Cand extends RankItem { theirScore?: number; myAddedAt?: number; theirAddedAt?: number; viaWant: boolean; alias: string }

function MatchList({ contacts, focus }: { contacts: Contact[]; focus?: TitleKey }) {
  const { profileId, settings } = useApp();
  const s = useSocial();
  // Coincidencias de Quiero ver (con las puntuaciones autorizadas), por contacto con autorización mutua
  const [matches, setMatches] = useState<Record<string, Match[]>>({});
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const wantSig = useLiveQuery(async () => (await listRatings(profileId)).filter((r) => r.list === 'want' || r.list === 'watching').map((r) => r.key).sort().join(','), [profileId]);
  const mm = contacts.filter((c) => c.shareMatches && c.theirShareMatches);
  const load = async () => {
    try {
      const out: Record<string, Match[]> = {};
      for (const c of mm) out[c.id] = await fetchMatches(c.id);
      setMatches(out); setError(undefined);
    } catch (e) { setError(toSocialError(e).message); } finally { setLoaded(true); }
  };
  useEffect(() => {
    // Se actualiza sola: al volver a la app y cada 20 s mientras está a la vista (los intereses llegan en tiempo real)
    void load();
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    const t = setInterval(onVis, 20_000);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [mm.map((c) => `${c.id}${c.theirShareScores}`).join(','), wantSig]);
  const mine = useMyAnswers(profileId);
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);

  // Candidatos: vía Quiero ver + vía intereses compartidos (títulos intercambiados con autorización mutua)
  const cands = useMemo(() => {
    const out: Cand[] = [];
    for (const c of contacts) {
      const want = new Map((matches[c.id] ?? []).map((m) => [m.key, m]));
      const keys = new Set<TitleKey>(want.keys());
      if (c.shareInterests && c.theirShareInterests) {
        for (const x of s.sent) if (x.recipient === c.id) keys.add(x.key);
        for (const x of s.inbox) if (x.sender === c.id) keys.add(x.key);
      }
      for (const k of keys) {
        const t = theirState(k, c);
        const w = want.get(k);
        const level = combinedLevel({ mine: mine.get(k), theirs: t.kind === 'answer' ? t.v : undefined, theirsPrivate: t.kind === 'private', bothWant: Boolean(w) });
        if (level === 'privado') continue;
        const at = Math.max(w ? Math.max(w.myAddedAt, w.theirAddedAt) : 0, t.kind === 'answer' ? t.at ?? 0 : 0,
          ...s.sent.filter((x) => x.key === k && x.recipient === c.id).map((x) => x.createdAt), ...s.inbox.filter((x) => x.key === k && x.sender === c.id).map((x) => x.createdAt));
        out.push({ key: k, contact: c.id, alias: c.alias, level, theirScore: w?.theirScore, myAddedAt: w?.myAddedAt, theirAddedAt: w?.theirAddedAt, viaWant: Boolean(w), at });
      }
    }
    return dedupeMatches(out);
  }, [contacts, matches, s.shared, s.sent, s.inbox, mine]);
  const keys = useMemo(() => [...new Set(cands.map((c) => c.key))].sort(), [cands]);
  const { titles, preds, rs, retryKey } = useCardData(keys);
  const myScore = (k: TitleKey) => { const p = preds.get(k); return p && personalState(p).kind !== 'insufficient' ? p.score : undefined; };

  // Filtros (se conservan al cambiar de pestaña o volver de una ficha)
  const P = `cine-match:compartidas:juntos:${profileId}`;
  const [lf, setLf] = usePersistentState<LevelFilter>(`${P}:level`, 'positivas', oneOf(LEVEL_FILTERS));
  const [type, setType] = usePersistentState<'all' | MediaType>(`${P}:type`, 'all', oneOf(['all', 'movie', 'tv'] as const));
  const [plats, setPlats] = usePersistentState<PlatformId[]>(`${P}:plats`, [], (v): v is PlatformId[] => Array.isArray(v));
  const [len, setLen] = usePersistentState<'all' | 'corta' | 'larga'>(`${P}:len`, 'all', oneOf(['all', 'corta', 'larga'] as const));
  const [genre, setGenre] = usePersistentState<number | null>(`${P}:genre`, null, (v): v is number | null => v === null || typeof v === 'number');
  const [sort, setSort] = usePersistentState<Sort>(`${P}:sort`, 'coincidencia', oneOf(SORTS));
  // Enlace desde un aviso: se muestra ese título aunque el filtro no lo incluya
  const [pinned, setPinned] = useState<TitleKey | undefined>(focus);
  useEffect(() => { if (focus) setPinned(focus); }, [focus]);
  const metaOf = (k: TitleKey): TitleMeta | undefined => { const t = titles.get(k); return t && t !== 'error' ? t.meta : undefined; };
  const genres = [...new Map(keys.map(metaOf).filter(Boolean).flatMap((m) => m!.genres).filter((g) => !/^Género \d+$/.test(g.name)).map((g) => [g.id, g.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const isShort = (m: TitleMeta) => (m.type === 'movie' ? (m.runtime ?? 999) <= 100 : (m.numberOfSeasons ?? 99) <= 2);
  const list = cands.filter((c) => {
    if (pinned && c.key === pinned) return true;
    if (!passLevel(lf, c.level)) return false;
    if (type !== 'all' && !c.key.startsWith(type)) return false;
    const meta = metaOf(c.key);
    if (!meta) return !plats.length && len === 'all' && genre === null;
    if (len !== 'all' && isShort(meta) !== (len === 'corta')) return false;
    if (genre !== null && !meta.genres.some((g) => g.id === genre)) return false;
    if (plats.length) { const t = titles.get(c.key); const st = availabilityState(t && t !== 'error' ? t.snap : undefined); if (st.kind !== 'confirmed' || !st.platforms.some((p) => plats.includes(p))) return false; }
    return true;
  });
  const ranked = list.map((c) => ({ ...c, myScore: myScore(c.key), tmdb: publicScore(metaOf(c.key)) }));
  const sorted = [...ranked].sort((a, b) => {
    if (sort === 'coincidencia') return compareMatches(a, b);
    const v = (x: typeof a) => sort === 'tmdb' ? x.tmdb ?? -1 : sort === 'recientes' ? x.at ?? 0 : sort === 'conjunta' ? joint(x.myScore, x.theirScore) ?? -1 : x.myScore ?? -1;
    return v(b) - v(a) || compareMatches(a, b);
  });
  useTabScroll('juntos', sorted.length > 0 && titles.size > 0);
  useEffect(() => {
    if (!pinned) return;
    const t = setTimeout(() => document.querySelector(`[data-testid="together-item"][data-key="${CSS.escape(pinned)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 400);
    return () => clearTimeout(t);
  }, [pinned, sorted.length]);
  const nMax = cands.filter((c) => c.level === 'maxima').length;
  const nPos = cands.filter((c) => isPositive(c.level) && c.level !== 'maxima').length;
  const nPend = cands.filter((c) => c.level === 'pendiente').length;
  const anyScores = contacts.some((c) => c.theirShareScores);
  const multi = contacts.length > 1;

  return (
    <div className="space-y-3" data-testid="together-list" data-count={loaded ? cands.length : -1}>
      <div className="grid grid-cols-3 gap-1.5 text-center" data-testid="together-summary">
        <button type="button" onClick={() => setLf('maxima')} className="rounded-lg bg-emerald-500/10 px-1 py-1.5 ring-1 ring-emerald-400/20"><div className="text-lg font-extrabold text-emerald-300" data-testid="together-n-max">{nMax}</div><div className="text-[10px] leading-tight text-emerald-100/80">coincidencias máximas</div></button>
        <button type="button" onClick={() => setLf('positivas')} className="rounded-lg bg-amber-500/10 px-1 py-1.5 ring-1 ring-amber-400/20"><div className="text-lg font-extrabold text-amber-200" data-testid="together-n-pos">{nPos}</div><div className="text-[10px] leading-tight text-amber-100/80">otras positivas</div></button>
        <button type="button" onClick={() => setLf('pendientes')} className="rounded-lg bg-sky-500/10 px-1 py-1.5 ring-1 ring-sky-400/20"><div className="text-lg font-extrabold text-sky-300" data-testid="together-n-pend">{nPend}</div><div className="text-[10px] leading-tight text-sky-100/80">pendientes de respuesta</div></button>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="together-levels">
        {([['positivas', 'Positivas'], ['maxima', 'Máxima'], ['muy_alta', 'Muy alta'], ['alta', 'Alta'], ['posibles', 'Posibles'], ['pendientes', 'Pendientes'], ['sin', 'Sin coincidencia'], ['todas', 'Todas']] as const).map(([id, l]) => (
          <Chip key={id} active={lf === id} onClick={() => { setPinned(undefined); setLf(id); }} testId={`together-filter-${id}`}>{l}</Chip>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={sel}><option value="all">Películas y series</option><option value="movie">Películas</option><option value="tv">Series</option></select>
        <select aria-label="Orden" data-testid="together-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={sel}>
          <option value="coincidencia">Coincidencia</option><option value="propia">Mi puntaje</option><option value="tmdb">TMDB</option><option value="recientes">Recientes</option>
          <option value="conjunta" disabled={!anyScores}>Conjunta{anyScores ? '' : ' (no disponible)'}</option>
        </select>
        <select aria-label="Duración" value={len} onChange={(e) => setLen(e.target.value as typeof len)} className={sel}><option value="all">Duración</option><option value="corta">Cortas (≤ 100 min / ≤ 2 temp.)</option><option value="larga">Largas</option></select>
        <select aria-label="Género" value={genre ?? ''} onChange={(e) => setGenre(e.target.value ? Number(e.target.value) : null)} className={sel}><option value="">Géneros</option>{genres.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="together-platforms">
        {PLATFORMS.filter((p) => settings.platforms.includes(p.id)).map((p) => <Chip key={p.id} active={plats.includes(p.id)} onClick={() => setPlats(plats.includes(p.id) ? plats.filter((x) => x !== p.id) : [...plats, p.id])}>{p.label}</Chip>)}
      </div>
      <p className="text-[11px] text-slate-500">Primero lo que ambos marcaron con interés (♥ y 👍), después lo que los dos guardaron en Quiero ver. Dentro de cada grupo: coincidencia conjunta = promedio de las dos puntuaciones − {JOINT_PENALTY.toString().replace('.', ',')} × su diferencia, sólo si ambas están autorizadas; si no, TMDB y fecha.</p>
      {error && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200" role="status">{error} <button type="button" className="font-semibold underline" onClick={() => void load()}>Reintentar</button></p>}
      {!loaded && !error && <p className="text-sm text-slate-400">Buscando coincidencias…</p>}
      {loaded && !cands.length && <Empty>Todavía no hay coincidencias. Aparecen cuando los dos marcan interés en un título que se recomendaron, o cuando los dos lo guardan en «Quiero ver».</Empty>}
      {loaded && cands.length > 0 && !sorted.length && <Empty>No hay coincidencias con estos filtros.{lf === 'positivas' && nPend ? ` Hay ${nPend} pendientes de respuesta.` : ''}</Empty>}
      <div className="space-y-3">
        {sorted.map((m) => {
          const meta = metaOf(m.key);
          const t = titles.get(m.key);
          if (!meta) return <div key={`${m.contact}|${m.key}`} data-testid="together-loading" className="rounded-2xl bg-ink-900 p-3 text-sm text-slate-400 ring-1 ring-white/5">{t === 'error' ? <>No se pudo cargar la ficha. <button type="button" className="underline" onClick={() => retryKey(m.key)}>Reintentar</button></> : 'Cargando ficha…'}</div>;
          const my = m.myScore;
          const j = joint(my, m.theirScore);
          const info = myInfo(preds.get(m.key), m.alias);
          info.badges = (
            <>
              <span className="rounded px-1.5 py-0.5 font-semibold" style={{ background: 'rgba(52,211,153,0.12)', color: LEVEL_TONE[m.level] }} data-testid="together-level" data-level={m.level}>{LEVEL_LABEL[m.level]}</span>
              {m.viaWant && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-300" data-testid="together-both">Ambos quieren verla</span>}
              {multi && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-200">con {m.alias}</span>}
            </>
          );
          info.reliability = [...(info.reliability ?? []).slice(0, 1), m.theirScore !== undefined ? `La puntuación de ${m.alias} es la estimación de SU app para su perfil; ${m.alias} eligió compartirla.` : `${m.alias} no comparte su puntuación estimada.`];
          return (
            <ul key={`${m.contact}|${m.key}`} className={pinned === m.key ? 'rounded-2xl ring-2 ring-emerald-400/60' : ''}>
              <TitleCard k={m.key} meta={meta} snap={t && t !== 'error' ? t.snap : undefined} rating={rs.byKey.get(m.key)} info={info} profileId={profileId} testId="together-item" sharedContact={m.contact}
                interest={{ value: interests?.get(m.key)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, m.key, a, { engine: 'juntos', source: 'juntos' }), 'tu respuesta'); } }}
                actionsExtra={m.viaWant || m.theirScore !== undefined ? (
                  <div className="mt-2 grid grid-cols-3 gap-1.5 text-center" data-testid="together-scores">
                    <div className="rounded-lg px-1 py-1" style={{ background: '#302519' }}><div className="text-[10px]" style={{ color: '#E8CF9C' }}>Vos (estimada)</div><div className="text-base font-extrabold" style={{ color: '#FFBB38' }}>{my !== undefined ? num(my) : '–'}</div></div>
                    <div className="rounded-lg bg-sky-500/10 px-1 py-1"><div className="truncate text-[10px] text-sky-200">{m.alias} (estimada)</div><div className="text-base font-extrabold text-sky-300" data-testid="together-their">{m.theirScore !== undefined ? num(m.theirScore) : '–'}</div></div>
                    <div className="rounded-lg bg-emerald-500/10 px-1 py-1"><div className="text-[10px] text-emerald-200">Conjunta</div><div className="text-base font-extrabold text-emerald-300" data-testid="together-joint">{j !== undefined ? num(j) : '–'}</div></div>
                  </div>
                ) : undefined} />
            </ul>
          );
        })}
      </div>
    </div>
  );
}

