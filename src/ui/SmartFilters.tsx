import { useEffect, useMemo, useState } from 'react';
import { AUDIENCES, DEFAULT_THRESHOLD, type AudienceFilter, type AudienceId } from '../services/audience';
import { allCountries, contradictions, countryName, type RankFilters } from '../services/filters';
import { DEFAULT_WESTERN, REGIONS, loadWestern, regionCountries, saveWestern, type RegionId } from '../services/regions';
import { condLabel, groupLabel, parseText, type Cond, type ParsedText } from '../services/textFilter';

/**
 * Texto libre (v3.3). Se interpreta con reglas y vocabulario (no es comprensión del lenguaje) y, antes de aplicar,
 * se muestra lo que se entendió: condiciones incluidas, exclusiones, partes no interpretadas, aclaraciones y
 * contradicciones con el resto del panel. Cada condición se puede quitar; el texto se puede corregir.
 */
export function TextFilterBox({ f, onChange }: { f: RankFilters; onChange: (f: RankFilters) => void }) {
  const [text, setText] = useState(f.text?.text ?? '');
  const [draft, setDraft] = useState<ParsedText>();
  useEffect(() => { if (!draft) setText(f.text?.text ?? ''); }, [f.text?.text]);
  const interpret = () => setDraft(parseText(text));
  const warn = draft ? contradictions(f, draft) : [];
  const dropInc = (i: number) => draft && setDraft({ ...draft, include: draft.include.filter((_, j) => j !== i) });
  const dropExc = (i: number) => draft && setDraft({ ...draft, exclude: draft.exclude.filter((_, j) => j !== i) });
  const dropPref = (i: number) => draft && setDraft({ ...draft, prefs: draft.prefs?.filter((_, j) => j !== i) });
  const empty = draft && !draft.include.length && !draft.exclude.length && !draft.prefs?.some((p) => p.applied);
  return (
    <div className="space-y-2" data-testid="text-filter">
      <label className="block text-xs text-slate-300" htmlFor="text-filter-input">Describí qué querés ver o evitar</label>
      <textarea id="text-filter-input" data-testid="text-input" value={text} rows={2} maxLength={300} onChange={(e) => { setText(e.target.value); setDraft(undefined); }}
        placeholder="Ej.: thriller adulto posterior a 2015, sin comedias románticas juveniles"
        className="w-full rounded-lg bg-ink-800 p-2 text-base text-slate-100 ring-1 ring-white/10" />
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="text-interpret" disabled={text.trim().length < 3} onClick={interpret} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-ink-950 disabled:opacity-40">Interpretar</button>
        {f.text && <button type="button" data-testid="text-clear" onClick={() => { onChange({ ...f, text: undefined }); setText(''); setDraft(undefined); }} className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm ring-1 ring-white/10">Quitar el filtro de texto</button>}
      </div>
      {draft && (
        <div className="space-y-1.5 rounded-xl bg-ink-800/60 p-2.5 text-xs ring-1 ring-white/10" data-testid="text-preview">
          <p className="font-semibold text-slate-200">Interpretación:</p>
          <ul className="space-y-1">
            {draft.include.map((c, i) => <CondRow key={`i${i}`} label={incLabel(c)} onRemove={() => dropInc(i)} kind="inc" />)}
            {draft.exclude.map((g, i) => <CondRow key={`e${i}`} label={`Excluir: ${groupLabel(g)}${g.length > 1 ? ' (todo a la vez)' : ''}`} onRemove={() => dropExc(i)} kind="exc" />)}
          </ul>
          {draft.prefs && draft.prefs.length > 0 && (
            <div data-testid="text-prefs">
              <p className="mt-1 font-semibold text-slate-200">Preferencias (ordenan, no quitan títulos):</p>
              <ul className="space-y-1">
                {draft.prefs.map((p, i) => (
                  <li key={p.id} className={`rounded-lg px-2 py-1 ${p.applied ? 'bg-sky-500/10 text-sky-100' : 'bg-ink-900 text-slate-400'}`} data-testid="text-pref" data-applied={p.applied}>
                    <div className="flex items-center justify-between gap-2"><span>{p.polarity < 0 ? 'Menos: ' : 'Más: '}{p.label} · {p.applied ? 'se aplica' : 'no se aplica'}</span>
                      <button type="button" aria-label={`Quitar ${p.label}`} data-testid="text-pref-remove" onClick={() => dropPref(i)} className="px-1">✕</button></div>
                    <span className="block text-[10px] opacity-80">{p.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draft.unparsed.map((u) => <p key={u} className="text-amber-200" data-testid="text-unparsed">No interpretado: «{u}». No se aplica: reescribilo o quitalo del texto.</p>)}
          {draft.notes.map((n) => <p key={n} className="text-slate-400" data-testid="text-note">• {n}</p>)}
          {warn.map((w) => <p key={w} className="text-rose-200" data-testid="text-contradiction">⚠ {w}</p>)}
          {empty && <p className="text-amber-200" data-testid="text-nothing">No se reconoció ninguna condición. Probá con tipo, género, años, público, región, país o un tema (p. ej. «viajes en el tiempo»).</p>}
          <p className="text-[10px] text-slate-500">Interpretación por reglas y vocabulario en español, no comprensión del lenguaje. Se combina con los demás filtros: deben cumplirse todos y una exclusión manda. Las preferencias sólo cambian el orden cuando TMDB tiene evidencia explícita (palabras clave o género); sin datos, no suman ni restan.</p>
          <div className="flex gap-2 pt-1">
            <button type="button" data-testid="text-apply" disabled={empty} onClick={() => { onChange({ ...f, text: draft }); setDraft(undefined); }} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-ink-950 disabled:opacity-40">Aplicar</button>
            <button type="button" data-testid="text-cancel" onClick={() => setDraft(undefined)} className="rounded-lg bg-ink-800 px-3 py-1.5 text-sm ring-1 ring-white/10">Cancelar</button>
          </div>
        </div>
      )}
      {!draft && f.text && (
        <ul className="space-y-0.5 text-[11px] text-slate-300" data-testid="text-applied">
          {f.text.include.map((c, i) => <li key={`i${i}`}>• {incLabel(c)}</li>)}
          {f.text.exclude.map((g, i) => <li key={`e${i}`}>• Excluir: {groupLabel(g)}</li>)}
          {(f.text.prefs ?? []).map((p) => <li key={p.id} className={p.applied ? 'text-sky-200' : 'text-slate-500'}>• {p.polarity < 0 ? 'Menos' : 'Más'}: {p.label} ({p.applied ? 'ordena' : 'no se aplica'})</li>)}
          {f.text.unparsed.length > 0 && <li className="text-amber-200">• Sin aplicar: {f.text.unparsed.map((u) => `«${u}»`).join(', ')}</li>}
        </ul>
      )}
    </div>
  );
}
const incLabel = (c: Cond) => (c.k === 'yearMin' || c.k === 'yearMax' || c.k === 'publicMin' || c.k === 'type' ? condLabel(c) : `Incluir ${condLabel(c).replace(/^[^:]+: /, '')}`);
function CondRow({ label, onRemove, kind }: { label: string; onRemove: () => void; kind: 'inc' | 'exc' }) {
  return (
    <li className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 ${kind === 'inc' ? 'bg-emerald-500/10 text-emerald-100' : 'bg-rose-500/10 text-rose-100'}`} data-testid="text-cond">
      <span>{label}</span>
      <button type="button" aria-label={`Quitar ${label}`} data-testid="text-cond-remove" onClick={onRemove} className="px-1">✕</button>
    </li>
  );
}

const THRESHOLDS = [{ v: 0.65, l: 'Alta (más estricta)' }, { v: DEFAULT_THRESHOLD, l: 'Media' }, { v: 0.35, l: 'Baja (más amplia)' }];
/** Público objetivo: tocá una vez para incluir, dos para excluir. Las categorías no se excluyen entre sí. */
export function AudiencePicker({ value, onChange }: { value?: AudienceFilter; onChange: (a: AudienceFilter) => void }) {
  const a: AudienceFilter = value ?? { include: [], exclude: [] };
  const cycle = (id: AudienceId) => {
    const inc = a.include.includes(id), exc = a.exclude.includes(id);
    onChange(inc ? { ...a, include: a.include.filter((x) => x !== id), exclude: [...a.exclude, id] } : exc ? { ...a, exclude: a.exclude.filter((x) => x !== id) } : { ...a, include: [...a.include, id] });
  };
  return (
    <div className="space-y-2" data-testid="audience-filter">
      <p className="text-[11px] text-slate-400">Tocá una vez para incluir, dos para excluir. Una obra puede tener varios públicos.</p>
      <div className="flex flex-wrap gap-1.5">
        {AUDIENCES.map((x) => {
          const inc = a.include.includes(x.id), exc = a.exclude.includes(x.id);
          return (
            <button key={x.id} type="button" data-testid={`audience-${x.id}`} data-state={inc ? 'include' : exc ? 'exclude' : 'none'} disabled={!x.enabled} title={x.note}
              aria-label={`${x.name}: ${!x.enabled ? 'deshabilitada' : inc ? 'incluido' : exc ? 'excluido' : 'sin filtrar'}`} onClick={() => cycle(x.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${!x.enabled ? 'bg-ink-800 text-slate-600 line-through' : inc ? 'bg-emerald-500 text-ink-950' : exc ? 'bg-red-500/80 text-white line-through' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
              {inc ? '+ ' : exc ? '− ' : ''}{x.name}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500" data-testid="audience-disabled-note">Masculina y femenina: deshabilitadas. TMDB no tiene datos editoriales ni demográficos sobre eso, y deducirlo de protagonistas o del género sería un estereotipo.</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="text-slate-400">Evidencia necesaria
          <select data-testid="audience-threshold" value={a.threshold ?? DEFAULT_THRESHOLD} onChange={(e) => onChange({ ...a, threshold: Number(e.target.value) })} className="ml-1 rounded-lg bg-ink-800 p-1 ring-1 ring-white/10">
            {THRESHOLDS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-slate-300"><input type="checkbox" data-testid="audience-uncertain" checked={a.uncertainAsMatch ?? false} onChange={(e) => onChange({ ...a, uncertainAsMatch: e.target.checked })} />Contar los de clasificación incierta</label>
      </div>
      <p className="text-[10px] text-slate-500">Clasificación aproximada a partir de géneros y palabras clave de TMDB, con la clasificación por edad como señal auxiliar. La edad de los protagonistas no alcanza: una serie con adolescentes y clasificación para adultos queda «incierta». Sin datos: no pasa un «incluir» y no se quita por un «excluir».</p>
    </div>
  );
}

/** Regiones (incluir/excluir) y edición de «Occidental». */
export function RegionPicker({ include, exclude, onChange, profileId }: { include: RegionId[]; exclude: RegionId[]; onChange: (inc: RegionId[], exc: RegionId[]) => void; profileId: string }) {
  const [western, setWestern] = useState(() => loadWestern(profileId));
  const [show, setShow] = useState<RegionId>();
  const [q, setQ] = useState('');
  const all = useMemo(() => allCountries(), []);
  const cycle = (id: RegionId) => {
    const inc = include.includes(id), exc = exclude.includes(id);
    if (inc) onChange(include.filter((x) => x !== id), [...exclude, id]);
    else if (exc) onChange(include, exclude.filter((x) => x !== id));
    else onChange([...include, id], exclude);
  };
  const setW = (list: string[]) => { saveWestern(profileId, list); setWestern([...list]); onChange([...include], [...exclude]); };
  const nq = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hits = show === 'western' && nq.length >= 2 ? all.filter((c) => c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(nq) && !western.includes(c.code)).slice(0, 5) : [];
  const region = REGIONS.find((r) => r.id === show);
  return (
    <div className="space-y-1.5" data-testid="region-filter">
      <h4 className="text-[11px] font-semibold text-slate-400">Regiones: una vez incluye, dos excluye</h4>
      <div className="flex flex-wrap gap-1.5">
        {REGIONS.map((r) => {
          const inc = include.includes(r.id), exc = exclude.includes(r.id);
          return (
            <button key={r.id} type="button" data-testid={`region-${r.id}`} data-state={inc ? 'include' : exc ? 'exclude' : 'none'} onClick={() => cycle(r.id)}
              className={`rounded-full px-2.5 py-1 text-xs ${inc ? 'bg-emerald-500 text-ink-950' : exc ? 'bg-red-500/80 text-white line-through' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{inc ? '+ ' : exc ? '− ' : ''}{r.name}</button>
          );
        })}
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-400">Ver países de
        <select data-testid="region-show" value={show ?? ''} onChange={(e) => setShow((e.target.value || undefined) as RegionId | undefined)} className="rounded-lg bg-ink-800 p-1 ring-1 ring-white/10">
          <option value="">—</option>{REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {region && (
        <div className="rounded-lg bg-ink-800/60 p-2 text-[11px] text-slate-300" data-testid="region-countries">
          <p className="mb-1 text-slate-400">{region.note}</p>
          <div className="flex flex-wrap gap-1">
            {regionCountries(region.id).map((c) => (
              <span key={c} className="flex items-center gap-0.5 rounded-full bg-ink-900 px-2 py-0.5" data-testid="region-country">{countryName(c)}
                {region.id === 'western' && <button type="button" aria-label={`Quitar ${countryName(c)} de Occidental`} data-testid="western-remove" onClick={() => setW(western.filter((x) => x !== c))} className="px-0.5">✕</button>}
              </span>
            ))}
          </div>
          {region.id === 'western' && (
            <div className="mt-1.5 space-y-1">
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Agregar país a Occidental" data-testid="western-input" className="w-full rounded-lg bg-ink-900 p-1.5 text-base ring-1 ring-white/10" />
              {hits.map((c) => <button key={c.code} type="button" data-testid="western-add" onClick={() => { setW([...western, c.code]); setQ(''); }} className="mr-1 rounded bg-emerald-500/15 px-2 py-1 text-emerald-200">+ {c.name}</button>)}
              {western.join() !== DEFAULT_WESTERN.join() && <button type="button" data-testid="western-reset" onClick={() => setW(DEFAULT_WESTERN)} className="underline">Restablecer la lista predeterminada</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
