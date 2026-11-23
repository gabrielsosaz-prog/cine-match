import { allCountries, countryName } from '../services/filters';
import { useEffect, useMemo, useState } from 'react';
import { PLATFORMS } from '../constants';
import { DEFAULT_FILTERS, FILTER_GROUPS, activeCount, activeFilters, includedPeople, withoutGroup, type CountryField, type PersonRef, type RankFilters } from '../services/filters';
import { useApp } from '../hooks/useApp';
import { AudiencePicker, RegionPicker, TextFilterBox } from './SmartFilters';
import type { ReactNode } from 'react';
import { searchPeople, type PersonHit } from '../services/catalog';
import type { RankedPerson } from '../services/peopleSearch';
import { friendlyError } from '../providers/errors';
import type { MediaType, Named, PlatformId } from '../types';
import { Chip } from './components';

const RUNTIMES: { id: string; label: string; min?: number; max?: number }[] = [
  { id: 'any', label: 'Cualquiera' },
  { id: 'short', label: 'Hasta 95 min', max: 95 },
  { id: 'mid', label: '95-135 min', min: 95, max: 135 },
  { id: 'long', label: 'Más de 135 min', min: 135 },
];
const SCORES = [0, 6, 7, 8];

/**
 * Panel de filtros avanzados del inicio. Es temporal: no cambia los gustos aprendidos ni los ajustes del perfil.
 * Predeterminado: «Recomendaciones generales» (sin filtros, sólo no vistos).
 */
export default function FilterPanel({ value, onChange, genres, userPlatforms, onSearchMore, searching, language = 'es-MX', hideScore }: {
  value: RankFilters; onChange: (f: RankFilters) => void; genres: Named[]; userPlatforms: PlatformId[];
  onSearchMore?: () => void; searching?: boolean; language?: string; hideScore?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { profileId } = useApp();
  const f = value;
  const n = activeCount(f);
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const setType = (t: MediaType | 'all') => onChange({ ...f, types: t === 'all' ? [] : [t] });
  const runtime = RUNTIMES.find((r) => r.min === f.runtimeMin && r.max === f.runtimeMax) ?? RUNTIMES[0];
  const sortedGenres = [...genres].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="filters-toggle"
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${n ? 'bg-accent/15 text-accent ring-accent/40' : 'bg-ink-800 text-slate-300 ring-white/10'}`}>
          ⚙ Filtros{n > 0 && <span data-testid="filters-count" className="rounded-full bg-accent px-1.5 text-[11px] text-ink-950">{n}</span>}
        </button>
        <span className="truncate text-[11px] text-slate-400" data-testid="filters-mode">{n ? `${n} ${n === 1 ? 'filtro activo' : 'filtros activos'}` : 'Recomendaciones generales'}</span>
        {n > 0 && <button type="button" data-testid="reset-general" onClick={() => onChange({ ...DEFAULT_FILTERS })} className="ml-auto shrink-0 text-xs text-accent underline">Restablecer generales</button>}
      </div>
      {open && (
        <div className="space-y-3 rounded-2xl bg-ink-900 p-3 ring-1 ring-white/10" data-testid="filters-panel">
          <Group n={1} id="text" title="Texto libre" f={f} onChange={onChange}>
            <TextFilterBox f={f} onChange={onChange} />
          </Group>
          <Group n={2} id="audience" title="Público objetivo" f={f} onChange={onChange}>
            <AudiencePicker value={f.audience} onChange={(audience) => onChange({ ...f, audience })} />
          </Group>
          <Group n={3} id="places" title="Países y regiones" f={f} onChange={onChange}>
            <RegionPicker profileId={profileId} include={f.includeRegions ?? []} exclude={f.excludeRegions ?? []} onChange={(includeRegions, excludeRegions) => onChange({ ...f, includeRegions, excludeRegions })} />
            <CountryPicker include={f.includeCountries ?? []} exclude={f.excludeCountries ?? []} field={f.countryField ?? 'both'}
              onChange={(includeCountries, excludeCountries, countryField) => onChange({ ...f, includeCountries, excludeCountries, countryField })} />
          </Group>
          <Group n={4} id="other" title="Otros filtros" f={f} onChange={onChange}>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-slate-400">Tipo</h3>
              <div className="flex gap-2">
                <Chip active={f.types.length !== 1} onClick={() => setType('all')}>Todo</Chip>
                <Chip active={f.types[0] === 'movie' && f.types.length === 1} onClick={() => setType('movie')} testId="panel-movie">Películas</Chip>
                <Chip active={f.types[0] === 'tv' && f.types.length === 1} onClick={() => setType('tv')} testId="panel-tv">Series</Chip>
              </div>
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-slate-400">Géneros: tocá una vez para incluir, dos para excluir</h3>
              <div className="flex flex-wrap gap-1.5">
                {sortedGenres.map((g) => {
                  const inc = f.includeGenres.includes(g.id), exc = f.excludeGenres.includes(g.id);
                  return (
                    <button key={g.id} type="button" data-testid={`genre-${g.id}`} data-state={inc ? 'include' : exc ? 'exclude' : 'none'} aria-label={`${g.name}: ${inc ? 'incluido' : exc ? 'excluido' : 'sin filtrar'}`}
                      onClick={() => onChange(inc ? { ...f, includeGenres: f.includeGenres.filter((x) => x !== g.id), excludeGenres: [...f.excludeGenres, g.id] }
                        : exc ? { ...f, excludeGenres: f.excludeGenres.filter((x) => x !== g.id) } : { ...f, includeGenres: [...f.includeGenres, g.id] })}
                      className={`rounded-full px-2.5 py-1 text-xs ${inc ? 'bg-emerald-500 text-ink-950' : exc ? 'bg-red-500/80 text-white line-through' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
                      {inc ? '+ ' : exc ? '− ' : ''}{g.name}
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="grid grid-cols-2 gap-2">
              <YearInput label="Año mínimo" placeholder="Ej. 2010" value={f.yearMin} testId="filter-year-min" onCommit={(v) => onChange({ ...f, yearMin: v })} />
              <YearInput label="Año máximo" placeholder="Ej. 2024" value={f.yearMax} testId="filter-year-max" onCommit={(v) => onChange({ ...f, yearMax: v })} />
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-slate-400">Plataformas</h3>
              <div className="flex flex-wrap gap-1.5">
                {PLATFORMS.filter((p) => userPlatforms.includes(p.id)).map((p) => (
                  <Chip key={p.id} testId={`panel-platform-${p.id}`} active={f.platforms.includes(p.id)} onClick={() => onChange({ ...f, platforms: toggle(f.platforms, p.id) })}>{p.label}</Chip>
                ))}
              </div>
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-slate-400">Duración (cuando hay datos; en series, por episodio)</h3>
              <div className="flex flex-wrap gap-1.5">
                {RUNTIMES.map((r) => <Chip key={r.id} testId={`runtime-${r.id}`} active={runtime.id === r.id} onClick={() => onChange({ ...f, runtimeMin: r.min, runtimeMax: r.max })}>{r.label}</Chip>)}
              </div>
            </section>
            <PeoplePicker include={includedPeople(f)} exclude={f.excludePeople ?? []} mode={f.peopleMode ?? 'any'} language={language}
              onChange={(includePeople, excludePeople, peopleMode) => onChange({ ...f, person: undefined, includePeople, excludePeople, peopleMode })} />
          {!hideScore && <section>
            <h3 className="mb-1 text-xs font-semibold text-slate-400">«Para vos» mínimo</h3>
            <div className="flex gap-1.5">
              {SCORES.map((s) => <Chip key={s} testId={`min-score-${s}`} active={(f.minScore ?? 0) === s} onClick={() => onChange({ ...f, minScore: s || undefined })}>{s ? `≥ ${s}` : 'Sin mínimo'}</Chip>)}
            </div>
          </section>}
          </Group>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" data-testid="clear-filters" onClick={() => onChange({ ...DEFAULT_FILTERS, watched: f.watched })} className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm ring-1 ring-white/10">Limpiar filtros</button>
            {onSearchMore && <button type="button" data-testid="search-more" disabled={searching} onClick={onSearchMore} className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm text-accent ring-1 ring-white/10 disabled:opacity-50">{searching ? 'Buscando…' : 'Buscar más títulos con estos filtros'}</button>}
          </div>
          <p className="text-[10px] text-slate-500">Los filtros son temporales: no cambian lo que el sistema aprendió de tus gustos.</p>
        </div>
      )}
    </div>
  );
}

/** Grupo del panel (v3.3): plegable, con su cantidad de filtros activos y su propio «Limpiar». */
function Group({ n, id, title, f, onChange, children }: { n: number; id: keyof typeof FILTER_GROUPS; title: string; f: RankFilters; onChange: (f: RankFilters) => void; children: ReactNode }) {
  const k = `cine-match:filter-group:${id}`;
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem(k) !== '0'; } catch { return true; } });
  const count = activeFilters(f).filter((x) => FILTER_GROUPS[id].includes(x)).length;
  return (
    <section className="rounded-xl bg-ink-950/40 ring-1 ring-white/5" data-testid={`filter-group-${id}`}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button type="button" aria-expanded={open} data-testid={`filter-group-${id}-toggle`} onClick={() => { setOpen(!open); try { sessionStorage.setItem(k, open ? '0' : '1'); } catch { /* */ } }} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-slate-200">
          <span aria-hidden>{open ? '▾' : '▸'}</span>{n}. {title}{count > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] text-ink-950">{count}</span>}
        </button>
        {count > 0 && <button type="button" data-testid={`filter-group-${id}-clear`} onClick={() => onChange(withoutGroup(f, id))} className="shrink-0 text-[11px] text-accent underline">Limpiar</button>}
      </div>
      {open && <div className="space-y-3 px-2.5 pb-2.5">{children}</div>}
    </section>
  );
}

export const MIN_YEAR = 1874;
export const MAX_YEAR = new Date().getFullYear() + 5;
/** Año válido para aplicar: 4 cifras dentro del rango. Valores parciales («2», «20», «201») no se aplican todavía. */
export function parseYear(raw: string): { value?: number; partial: boolean; error?: string } {
  const v = raw.trim();
  if (!v) return { partial: false };
  if (!/^\d+$/.test(v)) return { partial: false, error: 'Usá sólo números.' };
  if (v.length < 4) return { partial: true };
  const n = Number(v);
  if (v.length > 4 || n < MIN_YEAR || n > MAX_YEAR) return { partial: false, error: `Entre ${MIN_YEAR} y ${MAX_YEAR}.` };
  return { value: n, partial: false };
}

/**
 * Campo de año para teclados virtuales de Android.
 * Problema anterior: `type="number"` controlado con un valor que sólo aceptaba años completos. Al escribir «2»
 * el valor se convertía en vacío y el campo se borraba en cada pulsación, así que los dígitos «no aparecían».
 * Ahora el texto se guarda tal cual se escribe (teclado numérico con inputMode) y se valida al aplicar:
 * con 4 cifras válidas, al salir del campo o al tocar «Listo» del teclado.
 */
export function YearInput({ label, placeholder, value, onCommit, testId }: { label: string; placeholder: string; value?: number; onCommit: (v?: number) => void; testId: string }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => { setText((t) => (parseYear(t).value === value ? t : value ? String(value) : '')); }, [value]);
  const p = parseYear(text);
  const commit = (raw: string) => { const r = parseYear(raw); if (!r.partial && !r.error && r.value !== value) onCommit(r.value); };
  return (
    <label className="text-xs text-slate-400">{label}
      <input type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={4} enterKeyHint="done" placeholder={placeholder}
        value={text} data-testid={testId} aria-invalid={Boolean(p.error)}
        onChange={(e) => { const t = e.target.value.replace(/[^0-9]/g, '').slice(0, 4); setText(t); if (t.length === 4 || t === '') commit(t); }}
        onBlur={() => commit(text)} onKeyDown={(e) => { if (e.key === 'Enter') { commit(text); (e.target as HTMLInputElement).blur(); } }}
        className={`mt-1 w-full rounded-lg bg-ink-800 p-2 text-base text-slate-100 ring-1 ${p.error ? 'ring-red-400' : 'ring-white/10'}`} />
      {p.error && <span className="mt-0.5 block text-[10px] text-red-300" data-testid={`${testId}-error`}>{p.error}</span>}
      {p.partial && <span className="mt-0.5 block text-[10px] text-slate-500">Escribí el año completo (4 cifras).</span>}
    </label>
  );
}

/**
 * Personas incluidas y excluidas (v3.2). Se buscan en TMDB (tolerante a iniciales, tildes y errores menores) y se
 * eligen por id único: dos personas con el mismo nombre se distinguen por su oficio y sus títulos conocidos.
 * Incluir: «Cualquiera» (al menos una) o «Todos» (todas a la vez). Excluir: se quita el título si aparece cualquiera.
 */
export function PeoplePicker({ include, exclude, mode, onChange, language, max = 5, title = 'Actores, actrices o dirección' }: {
  include: PersonRef[]; exclude: PersonRef[]; mode: 'any' | 'all'; language: string; max?: number; title?: string;
  onChange: (include: PersonRef[], exclude: PersonRef[], mode: 'any' | 'all') => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<RankedPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits([]); return; }
    let alive = true;
    const id = setTimeout(async () => {
      setBusy(true); setErr(undefined);
      try { const r = await searchPeople(t, language); if (alive) setHits(r.slice(0, 6)); }
      catch (e) { if (alive) setErr(friendlyError(e)); }
      finally { if (alive) setBusy(false); }
    }, 350);
    return () => { alive = false; clearTimeout(id); };
  }, [q, language]);
  const ref = (h: PersonHit): PersonRef => ({ id: h.id, name: h.name, department: h.department });
  const add = (h: PersonHit, kind: 'inc' | 'exc') => {
    const inc = include.filter((p) => p.id !== h.id), exc = exclude.filter((p) => p.id !== h.id);
    if (kind === 'inc') onChange([...inc, ref(h)].slice(0, max), exc, mode); else onChange(inc, [...exc, ref(h)].slice(0, max), mode);
    setQ(''); setHits([]);
  };
  const chip = (p: PersonRef, kind: 'inc' | 'exc') => (
    <span key={`${kind}${p.id}`} data-testid={kind === 'inc' ? 'person-selected' : 'person-excluded'} data-person-id={p.id}
      className={`flex items-center gap-1 rounded-full py-0.5 pl-2 pr-1 text-xs ${kind === 'inc' ? 'bg-accent/15 text-accent' : 'bg-rose-500/15 text-rose-200'}`}>
      {kind === 'exc' ? 'sin ' : ''}{p.name}
      <button type="button" aria-label={`Quitar ${p.name}`} data-testid="person-remove" className="px-1"
        onClick={() => onChange(include.filter((x) => !(kind === 'inc' && x.id === p.id)), exclude.filter((x) => !(kind === 'exc' && x.id === p.id)), mode)}>✕</button>
    </span>
  );
  const full = include.length >= max && exclude.length >= max;
  return (
    <section data-testid="person-filter">
      <h3 className="mb-1 text-xs font-semibold text-slate-400">{title}</h3>
      {include.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[11px] text-slate-400">Incluidos:</span>{include.map((p) => chip(p, 'inc'))}</div>}
      {include.length > 1 && (
        <div className="mb-1 flex items-center gap-1.5 text-[11px]" role="radiogroup" aria-label="Coincidencia de personas">
          <span className="text-slate-400">Coincidencia:</span>
          {([['any', 'Cualquiera'], ['all', 'Todos']] as const).map(([m, l]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} data-testid={`people-mode-${m}`} onClick={() => onChange(include, exclude, m)}
              className={`rounded-full px-2 py-0.5 ${mode === m ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{l}</button>
          ))}
        </div>
      )}
      {exclude.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1"><span className="text-[11px] text-slate-400">Excluidos:</span>{exclude.map((p) => chip(p, 'exc'))}</div>}
      {(include.length > 0 || exclude.length > 0) && <button type="button" data-testid="person-clear" className="mb-1 text-[11px] underline text-slate-400" onClick={() => onChange([], [], 'any')}>Quitar todas las personas</button>}
      {!full && (
        <>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ej.: Michael J. Fox" data-testid="person-input" aria-label="Buscar persona"
            className="w-full rounded-lg bg-ink-800 p-2 text-base text-slate-100 ring-1 ring-white/10" />
          {busy && <p className="mt-1 text-[11px] text-slate-500">Buscando…</p>}
          {err && <p className="mt-1 text-[11px] text-red-300">{err}</p>}
          {!busy && q.trim().length >= 2 && !hits.length && !err && <p className="mt-1 text-[11px] text-slate-500">Sin personas con ese nombre en TMDB.</p>}
          <ul className="mt-1 space-y-1">
            {hits.map((h) => (
              <li key={h.id} data-testid="person-hit" data-person-id={h.id} className="flex items-center gap-2 rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{h.name}</span> <span className="text-[11px] text-slate-400">· {departmentEs(h.department)}</span>
                  {h.fuzzy && <span className="ml-1 text-[10px] text-amber-300" data-testid="person-fuzzy">¿quisiste decir?</span>}
                  {h.knownFor.length > 0 && <span className="block truncate text-[11px] text-slate-500">{h.knownFor.join(' · ')}</span>}
                </span>
                <button type="button" data-testid="person-include" disabled={include.length >= max} onClick={() => add(h, 'inc')} className="rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-200 disabled:opacity-40">Incluir</button>
                <button type="button" data-testid="person-exclude" disabled={exclude.length >= max} onClick={() => add(h, 'exc')} className="rounded bg-rose-500/15 px-2 py-1 text-xs text-rose-200 disabled:opacity-40">Excluir</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-1 text-[10px] text-slate-500">Actuación: cuentan los créditos de reparto (también como invitado en series), no producción ni equipo técnico. Excluir tiene prioridad.</p>
    </section>
  );
}
const departmentEs = (d?: string) => (d === 'Acting' ? 'Actuación' : d === 'Directing' ? 'Dirección' : d === 'Writing' ? 'Guion' : d === 'Production' ? 'Producción' : d ?? 'sin datos');

/**
 * País de origen o producción (v3.1). Buscar por nombre; tocar «Incluir» o «Excluir».
 * Regla: incluir = al menos uno de sus países está en la lista; excluir = se quita si cualquiera de sus países está
 * (coproducciones incluidas). Sin país informado por TMDB: no pasa un «incluir» y no se quita por un «excluir».
 */
export function CountryPicker({ include, exclude, field = 'both', onChange }: { include: string[]; exclude: string[]; field?: CountryField; onChange: (inc: string[], exc: string[], field: CountryField) => void }) {
  const [q, setQ] = useState('');
  const all = useMemo(() => allCountries(), []);
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hits = q.trim().length >= 2 ? all.filter((c) => norm(c.name).includes(norm(q.trim())) || c.code === q.trim().toUpperCase()).slice(0, 6) : [];
  const chip = (code: string, kind: 'inc' | 'exc') => (
    <span key={`${kind}${code}`} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${kind === 'inc' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200'}`} data-testid={`country-${kind}`}>
      {kind === 'inc' ? '' : 'sin '}{countryName(code)}
      <button type="button" aria-label={`Quitar ${countryName(code)}`} onClick={() => onChange(include.filter((c) => !(kind === 'inc' && c === code)), exclude.filter((c) => !(kind === 'exc' && c === code)), field)}>✕</button>
    </span>
  );
  return (
    <section data-testid="country-filter">
      <h3 className="mb-1 text-xs font-semibold text-slate-400">Países</h3>
      {include.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1" data-testid="countries-included"><span className="text-[11px] text-slate-400">Incluidos (cualquiera):</span>{include.map((c) => chip(c, 'inc'))}</div>}
      {exclude.length > 0 && <div className="mb-1 flex flex-wrap items-center gap-1" data-testid="countries-excluded"><span className="text-[11px] text-slate-400">Excluidos:</span>{exclude.map((c) => chip(c, 'exc'))}</div>}
      <label className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">Según
        <select value={field} onChange={(e) => onChange(include, exclude, e.target.value as CountryField)} data-testid="country-field" className="rounded bg-ink-800 px-1 py-0.5 text-[11px] text-slate-200 ring-1 ring-white/10">
          <option value="both">país de origen o de producción</option><option value="origin">sólo país de origen</option><option value="production">sólo país de producción</option>
        </select>
      </label>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar país (p. ej. México)" aria-label="Buscar país" data-testid="country-input"
        className="w-full rounded-lg bg-ink-800 px-3 py-2 text-sm ring-1 ring-white/10" />
      {hits.length > 0 && (
        <ul className="mt-1 space-y-1">
          {hits.map((c) => (
            <li key={c.code} className="flex items-center gap-2 text-sm" data-testid="country-hit" data-code={c.code}>
              <span className="flex-1">{c.name}</span>
              <button type="button" data-testid="country-include" onClick={() => { onChange([...new Set([...include, c.code])], exclude.filter((x) => x !== c.code), field); setQ(''); }} className="rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-200">Incluir</button>
              <button type="button" data-testid="country-exclude" onClick={() => { onChange(include.filter((x) => x !== c.code), [...new Set([...exclude, c.code])], field); setQ(''); }} className="rounded bg-rose-500/15 px-2 py-1 text-xs text-rose-200">Excluir</button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[10px] text-slate-500">Se usan los países de origen y de producción de TMDB (no el idioma ni la nacionalidad del reparto). La exclusión manda: una coproducción con un país excluido no aparece. Si TMDB no informa el país, el título no pasa «incluir» y no se quita por «excluir».</p>
    </section>
  );
}
