import { useEffect, useState } from 'react';
import { ABANDON_REASONS, STATUS_LABELS } from '../constants';
import { rateAndLearn, removeAndLearn } from '../services/ratings';
import type { DimensionScores, Rating, TitleKey, WatchStatus } from '../types';
import { Card, DimensionEditor, ScoreRow } from '../ui/components';

const ORDER: WatchStatus[] = ['rated', 'watching', 'want', 'abandoned', 'not_interested', 'watched'];

export default function RatingPanel({ profileId, k, existing, isTv }: { profileId: string; k: TitleKey; existing?: Rating; isTv: boolean }) {
  const [status, setStatus] = useState<WatchStatus>(existing?.status ?? 'rated');
  const [overall, setOverall] = useState<number | undefined>(existing?.overall);
  const [dims, setDims] = useState<DimensionScores>(existing?.dimensions ?? {});
  const [reason, setReason] = useState(existing?.abandonReason ?? '');
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStatus(existing?.status ?? 'rated'); setOverall(existing?.overall); setDims(existing?.dimensions ?? {}); setReason(existing?.abandonReason ?? ''); }, [existing?.updatedAt, k]);
  const canScore = status === 'rated' || status === 'watched' || status === 'watching' || status === 'abandoned';
  const save = async () => {
    setBusy(true); setSaved(undefined);
    const { rating, run } = await rateAndLearn(profileId, k, { status, overall: canScore ? overall : undefined, dimensions: canScore ? dims : {}, abandonReason: reason || undefined });
    setBusy(false);
    setSaved(`Guardado como «${STATUS_LABELS[rating.status]}». ${run ? 'Ranking actualizado.' : 'El ranking se actualizará cuando haya conexión.'}`);
  };
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Tu valoración</h2>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Estado">
        {ORDER.map((s) => (
          <button key={s} role="radio" aria-checked={status === s} onClick={() => setStatus(s)} data-testid={`status-${s}`}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${status === s ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>
            {s === 'rated' ? 'Vista' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>
      {status === 'abandoned' && (
        <label className="block text-sm text-slate-300">¿Por qué la abandonaste?
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-full rounded-lg bg-ink-800 p-2 ring-1 ring-white/10" data-testid="abandon-reason">
            <option value="">Elegí un motivo (opcional)</option>
            {ABANDON_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
      )}
      {canScore && (
        <>
          <ScoreRow label="Valoración general" value={overall} onChange={setOverall} testId="overall" />
          <p className="-mt-2 text-[11px] text-slate-500">La general es independiente de los aspectos: puntuá sólo los que quieras.{isTv ? ' En series, la valoración es global (por temporada: próximamente).' : ''}</p>
          <DimensionEditor value={dims} onChange={setDims} />
        </>
      )}
      <div className="flex gap-2">
        <button onClick={save} disabled={busy} data-testid="save-rating" className="flex-1 rounded-xl bg-accent py-2.5 font-semibold text-ink-950 disabled:opacity-50">{busy ? 'Guardando y recalculando…' : existing ? 'Actualizar' : 'Guardar'}</button>
        {existing && <button onClick={async () => { await removeAndLearn(profileId, k); setSaved('Valoración eliminada.'); }} className="rounded-xl bg-ink-800 px-3 text-sm text-red-300 ring-1 ring-white/10">Borrar</button>}
      </div>
      {saved && <p role="status" data-testid="save-status" className="text-sm text-emerald-300">{saved}</p>}
    </Card>
  );
}
