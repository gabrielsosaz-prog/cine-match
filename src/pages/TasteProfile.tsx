import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { emptyTasteProfile, PREFS, type PrefDef } from '../engine/attraction';
import { saveTaste } from '../services/taste';
import { requestRecompute } from '../services/recompute';
import { safely } from '../services/notices';
import type { TasteLevel, TasteProfile } from '../types';
import { Card } from '../ui/components';

/**
 * v4.0 · «Mi perfil de gustos». Cada preferencia se puede apagar, dejar como FLEXIBLE (suma o resta en el orden, nunca
 * quita títulos) o, sólo las que alejan, convertir en EXCLUSIÓN estricta (quita esos títulos). Nada se vuelve estricto
 * solo. Los cambios se guardan al tocar y recalculan «Para vos» si usás v4.0.
 */
function LevelPicker({ def, value, onChange }: { def: PrefDef; value: TasteLevel; onChange: (v: TasteLevel) => void }) {
  const opts: [TasteLevel, string][] = def.kind === 'avoid' ? [['off', 'No aplicar'], ['on', 'Flexible'], ['strict', 'Excluir']] : [['off', 'No aplicar'], ['on', 'Me atrae']];
  return (
    <div className="mt-1 flex gap-1" role="radiogroup" aria-label={def.label}>
      {opts.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} data-testid={`pref-${def.id}-${v}`} onClick={() => onChange(v)}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold ring-1 ${value === v ? (v === 'strict' ? 'bg-red-500/25 text-red-100 ring-red-400/50' : 'bg-accent text-ink-950 ring-accent') : 'bg-ink-800 text-slate-300 ring-white/10'}`}>{l}</button>
      ))}
    </div>
  );
}

export default function TasteProfilePage() {
  const { profileId, settings } = useApp();
  const stored = useLiveQuery(() => db.taste.get(profileId), [profileId]);
  const taste: TasteProfile = stored ?? emptyTasteProfile(profileId);
  const anchors = useLiveQuery(() => db.titles.bulkGet(taste.anchors), [taste.anchors.join(',')]) ?? [];
  const [msg, setMsg] = useState<string>();
  const save = (patch: Partial<TasteProfile>, what: string) => safely(async () => {
    await saveTaste({ ...taste, ...patch });
    if (settings.engine === 'v4.0') requestRecompute(profileId, { trigger: 'perfil de gustos' }).catch(() => undefined);
    setMsg(`${what} guardado.${settings.engine === 'v4.0' ? ' «Para vos» se recalcula.' : ''}`);
  }, 'el perfil de gustos');
  const groups = [...new Set(PREFS.map((p) => p.group))];
  const active = PREFS.filter((p) => (taste.prefs[p.id] ?? 'off') !== 'off').length;
  return (
    <div className="space-y-4" data-testid="taste-profile">
      <header>
        <h1 className="text-2xl font-bold">Mi perfil de gustos</h1>
        <p className="text-xs text-slate-400">Lo usa el motor v4.0 (atractivo personalizado). {active} preferencias activas{taste.source ? ` · origen: ${taste.source}` : ''}.</p>
      </header>
      {msg && <p className="rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-200" role="status">{msg}</p>}
      {!stored && (
        <Card className="space-y-1">
          <p className="text-sm text-slate-300">Todavía no hay un perfil guardado. Podés armarlo acá o importar el archivo de tu perfil desde <Link to="/recuperar" className="text-accent underline">Importar o recuperar</Link>.</p>
        </Card>
      )}
      <Card className="space-y-1 text-[11px] text-slate-400">
        <p><b className="text-slate-200">Flexible</b>: sube o baja el puesto con el peso indicado; nunca quita títulos.</p>
        <p><b className="text-red-200">Excluir</b>: quita esos títulos de v4.0. Usalo sólo para lo que nunca querés ver.</p>
      </Card>
      {groups.map((g) => (
        <Card key={g} className="space-y-3">
          <h2 className="font-semibold">{g}</h2>
          {PREFS.filter((p) => p.group === g).map((p) => {
            const v = (taste.prefs[p.id] ?? 'off') as TasteLevel;
            return (
              <div key={p.id} data-testid={`pref-${p.id}`} data-level={v}>
                <p className="text-sm text-slate-100">{p.label}</p>
                <p className="text-[11px] text-slate-500">{v === 'strict' && p.strictLabel ? p.strictLabel : p.detail}{p.source ? ` · ${p.source}` : ''}</p>
                <LevelPicker def={p} value={v} onChange={(nv) => save({ prefs: { ...taste.prefs, [p.id]: nv } }, `«${p.label}»`)} />
              </div>
            );
          })}
        </Card>
      ))}
      <Card className="space-y-2" data-testid="taste-anchors">
        <h2 className="font-semibold">Títulos de referencia</h2>
        <p className="text-[11px] text-slate-500">Premisas que elegiste como atractivas. Pesan 1,5 en el parecido. Tus «Tengo muchas ganas» y «Me interesa» también cuentan (peso 1).</p>
        {taste.anchors.length === 0 && <p className="text-sm text-slate-400">Ninguno.</p>}
        <ul className="space-y-1">
          {taste.anchors.map((k, i) => (
            <li key={k} className="flex items-center justify-between gap-2 text-sm">
              <Link to={`/t/${k.replace(':', '/')}`} className="truncate">{anchors[i]?.title ?? k}</Link>
              <button type="button" className="text-[11px] text-slate-400 underline" data-testid={`anchor-remove-${k}`} onClick={() => save({ anchors: taste.anchors.filter((x) => x !== k) }, 'El cambio')}>Quitar</button>
            </li>
          ))}
        </ul>
      </Card>
      {taste.notes.length > 0 && (
        <details className="rounded-2xl bg-ink-900 p-3 ring-1 ring-white/5">
          <summary className="cursor-pointer text-sm font-semibold">Tus respuestas del cuestionario ({taste.notes.length})</summary>
          <ul className="mt-2 space-y-2 text-xs text-slate-300">{taste.notes.map((n, i) => <li key={i}><p className="text-slate-400">{n.q}</p><p>{n.a}</p></li>)}</ul>
        </details>
      )}
    </div>
  );
}
