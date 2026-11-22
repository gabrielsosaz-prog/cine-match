import { useState } from 'react';
import { PLATFORMS } from '../constants';
import { DEFAULT_FILTERS, activeCount, type RankFilters } from '../services/filters';
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
export default function FilterPanel({ value, onChange, genres, userPlatforms, onSearchMore, searching }: {
  value: RankFilters; onChange: (f: RankFilters) => void; genres: Named[]; userPlatforms: PlatformId[];
  onSearchMore?: () => void; searching?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const f = value;
  const n = activeCount(f);
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
  const setType = (t: MediaType | 'all') => onChange({ ...f, types: t === 'all' ? [] : [t] });
  const runtime = RUNTIMES.find((r) => r.min === f.runtimeMin && r.max === f.runtimeMax) ?? RUNTIMES[0];
  const year = (v: string) => { const x = Number(v); return v && Number.isFinite(x) && x > 1800 && x < 2100 ? x : undefined; };
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
            <label className="text-xs text-slate-400">Año mínimo
              <input inputMode="numeric" type="number" min={1900} max={2100} placeholder="Ej. 2010" value={f.yearMin ?? ''} data-testid="filter-year-min"
                onChange={(e) => onChange({ ...f, yearMin: year(e.target.value) })} className="mt-1 w-full rounded-lg bg-ink-800 p-2 text-sm text-slate-100 ring-1 ring-white/10" />
            </label>
            <label className="text-xs text-slate-400">Año máximo
              <input inputMode="numeric" type="number" min={1900} max={2100} placeholder="Ej. 2024" value={f.yearMax ?? ''} data-testid="filter-year-max"
                onChange={(e) => onChange({ ...f, yearMax: year(e.target.value) })} className="mt-1 w-full rounded-lg bg-ink-800 p-2 text-sm text-slate-100 ring-1 ring-white/10" />
            </label>
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
          <section>
            <h3 className="mb-1 text-xs font-semibold text-slate-400">Afinidad estimada mínima</h3>
            <div className="flex gap-1.5">
              {SCORES.map((s) => <Chip key={s} testId={`min-score-${s}`} active={(f.minScore ?? 0) === s} onClick={() => onChange({ ...f, minScore: s || undefined })}>{s ? `≥ ${s}` : 'Sin mínimo'}</Chip>)}
            </div>
          </section>
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
