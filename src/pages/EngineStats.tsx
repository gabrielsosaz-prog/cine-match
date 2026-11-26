import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { ENGINE_LABEL } from '../services/recommendations';
import { engineStats, INTEREST_ANSWERS, listInterests } from '../services/taste';
import { SATISFACTION_MIN_EVIDENCE } from '../engine/attractionEngine';
import { Card } from '../ui/components';
import { num } from '../ui/format';

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)} %`);

/**
 * v4.0 · Rendimiento de cada motor con tu uso real. Un título mostrado que no viste NO cuenta como fallo: sólo se
 * cuenta lo que respondiste, viste o puntuaste después de que el motor lo mostró.
 */
export default function EngineStats() {
  const { profileId } = useApp();
  const data = useLiveQuery(async () => {
    const [shown, interests, ratings] = await Promise.all([
      db.shown.where('profileId').equals(profileId).toArray(), listInterests(profileId), db.ratings.where('profileId').equals(profileId).toArray(),
    ]);
    return { stats: engineStats(shown, interests, ratings), interests };
  }, [profileId]);
  if (!data) return <p className="text-sm text-slate-400">Cargando…</p>;
  const bySource = new Map<string, number>();
  for (const i of data.interests) bySource.set(i.source ?? 'app', (bySource.get(i.source ?? 'app') ?? 0) + 1);
  return (
    <div className="space-y-4" data-testid="engine-stats">
      <header>
        <h1 className="text-2xl font-bold">Estadísticas de motores</h1>
        <p className="text-xs text-slate-400">Se cuentan los títulos que cada motor mostró en sus primeros 30 puestos desde la versión 4.0.</p>
      </header>
      {data.stats.length === 0 && <Card><p className="text-sm text-slate-300">Todavía no hay datos. Usá «Para vos» y respondé el interés de algunos títulos.</p></Card>}
      {data.stats.map((s) => (
        <Card key={s.engine} className="space-y-1" data-testid={`stats-${ENGINE_LABEL[s.engine] ?? s.engine}`}>
          <h2 className="font-semibold">{ENGINE_LABEL[s.engine] ?? s.engine} <span className="text-[11px] font-normal text-slate-500">{s.engine}</span></h2>
          <ul className="text-sm text-slate-300">
            <li>Mostrados: {s.shown} · respondidos: {s.answered}</li>
            <li>Interés generado (no vistos): <b data-testid="stat-interest">{pct(s.interestRate)}</b> con «Me interesa» o más</li>
            <li className="text-[11px] text-slate-400">{INTEREST_ANSWERS.map((a) => `${a.short}: ${s.counts[a.id]}`).join(' · ')}</li>
            <li>Vistos después de mostrarse: {s.watched}</li>
            <li>Puntuados después: {s.ratedAfter}{s.meanRatingAfter !== null ? ` · nota media ${num(s.meanRatingAfter)}` : ''}</li>
            {s.satisfactionError !== null && <li>Nota real − satisfacción estimada: {s.satisfactionError > 0 ? '+' : ''}{num(s.satisfactionError)}</li>}
          </ul>
          {(ENGINE_LABEL[s.engine] === 'v4.0') && s.ratedAfter < SATISFACTION_MIN_EVIDENCE && (
            <p className="text-[11px] text-amber-200">Satisfacción estimada todavía poco fiable: hay {s.ratedAfter} de {SATISFACTION_MIN_EVIDENCE} notas posteriores necesarias para evaluarla.</p>
          )}
        </Card>
      ))}
      <Card className="space-y-1">
        <h2 className="font-semibold">Respuestas de interés guardadas</h2>
        <p className="text-sm text-slate-300">{data.interests.length} en total{bySource.size ? ` (${[...bySource].map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}.</p>
        <p className="text-[11px] text-slate-500">Son respuestas antes de ver; no son valoraciones y no cambian tus notas.</p>
      </Card>
    </div>
  );
}
