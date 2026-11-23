import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../hooks/useApp';
import { Card, Poster } from '../ui/components';
import { AB_ANSWERS, answerItem, clearSessions, exportSessions, loadSessions, newSession, summarize, type AbAnswer, type AbSession } from '../services/abtest';
import type { TitleKey } from '../types';

/** v3.5 · Comparación a ciegas de dos motores. No modifica valoraciones; las respuestas quedan en este dispositivo. */
export default function Compare() {
  const { profileId } = useApp();
  const [sessions, setSessions] = useState<AbSession[]>(() => loadSessions(profileId));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const current = sessions[sessions.length - 1];
  const pending = current ? current.items.filter((i) => !i.answer).length : 0;
  const summary = useMemo(() => summarize(sessions), [sessions]);
  const answered = summary.answered;

  async function start() {
    setBusy(true); setMsg(undefined);
    try {
      const s = await newSession(profileId);
      if ('error' in s) setMsg(s.error); else setSessions(loadSessions(profileId));
    } catch (e) { setMsg(`No se pudo armar la comparación: ${(e as Error).message}`); }
    setBusy(false);
  }
  const answer = (key: TitleKey, a: AbAnswer) => setSessions(answerItem(profileId, current!.id, key, a));
  function doExport() {
    const blob = new Blob([JSON.stringify(exportSessions(profileId), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `cine-match-comparacion-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="space-y-4" data-testid="compare-page">
      <header>
        <h1 className="text-xl font-bold">Comparar recomendaciones</h1>
        <p className="text-sm text-slate-400">Dos versiones del motor proponen títulos mezclados, sin decir cuál es cuál. Respondé cuánto te interesa cada uno. «Ya la vi» y «No puedo evaluarla» no cuentan como rechazo.</p>
        <p className="mt-1 text-[11px] text-slate-500">No cambia tus valoraciones ni tus recomendaciones. Las respuestas se guardan sólo en este dispositivo.</p>
      </header>
      {(!current || pending === 0) && (
        <button type="button" data-testid="ab-start" disabled={busy} onClick={start} className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-ink-950 disabled:opacity-50">
          {busy ? 'Calculando…' : current ? 'Nueva comparación' : 'Empezar comparación'}
        </button>
      )}
      {msg && <p data-testid="ab-msg" className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">{msg}</p>}
      {current && pending > 0 && <p className="text-sm text-slate-400" data-testid="ab-pending">Faltan {pending} de {current.items.length}</p>}
      {current && (
        <ul className="space-y-2" data-testid="ab-list">
          {current.items.map((it) => (
            <li key={it.key} data-testid="ab-item" data-key={it.key} data-answer={it.answer ?? ''} className="flex gap-3 rounded-xl bg-ink-900 p-3 ring-1 ring-white/5">
              <Link to={`/t/${it.key.replace(':', '/')}`} className="shrink-0"><Poster path={it.poster} title={it.title} className="h-24 w-16" /></Link>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{it.title} {it.year ? <span className="font-normal text-slate-400">({it.year})</span> : null}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {AB_ANSWERS.map((a) => (
                    <button key={a.id} type="button" data-testid={`ab-${a.id}`} aria-pressed={it.answer === a.id} onClick={() => answer(it.key, a.id)}
                      className={`rounded-full px-2.5 py-1 text-xs ${it.answer === a.id ? 'bg-accent text-ink-950' : 'bg-ink-800 text-slate-300 ring-1 ring-white/10'}`}>{a.label}</button>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Card className="space-y-2" data-testid="ab-summary">
        <h2 className="font-semibold">Resultados acumulados</h2>
        {answered === 0 ? <p className="text-sm text-slate-400">Todavía no hay respuestas.</p> : (
          <>
            {current && pending > 0 && <p className="text-[11px] text-slate-500">Los motores se muestran recién al terminar cada comparación, para no influir en tus respuestas.</p>}
            {(!current || pending === 0) && (
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400"><tr><th>Motor</th><th>Mostrados</th><th>Interés medio (0-2)</th><th>«Mucho»</th><th>«No»</th><th>Ya vistos</th><th>Comparaciones ganadas</th></tr></thead>
                <tbody>{summary.perEngine.map((e) => <tr key={e.engine} data-testid="ab-engine-row"><td>{e.engine}</td><td>{e.shown}</td><td>{e.mean ?? '—'}</td><td>{e.mucho}</td><td>{e.no}</td><td>{e.vista}</td><td>{summary.wins[e.engine] ?? 0}</td></tr>)}</tbody>
              </table>
            )}
            <p className="text-[11px] text-slate-500">{summary.sessions} comparaciones · {summary.ties} empates. Con pocas respuestas la diferencia puede ser azar.</p>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="ab-export" onClick={doExport} className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Exportar respuestas</button>
          <button type="button" data-testid="ab-clear" onClick={() => { if (confirm('¿Borrar las comparaciones guardadas? No afecta tus valoraciones.')) { clearSessions(profileId); setSessions([]); } }} className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Borrar comparaciones</button>
        </div>
      </Card>
    </div>
  );
}
