import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import { useApp } from '../hooks/useApp';
import { useRatings } from '../hooks/useRatings';
import { getTitle, refreshAvailability } from '../services/catalog';
import { safely } from '../services/notices';
import { predictFor } from '../services/recommendations';
import { interestMap, recordInterest } from '../services/taste';
import type { RecommendationItem, TitleKey } from '../types';
import { DataStatus, Empty, personalState } from '../ui/components';
import TitleCard, { type CardInfo } from '../ui/TitleCard';

/**
 * «Quiero ver» (v4.1): tu lista («Quiero verla» y «Viéndola») con la tarjeta común. Un título que quitás de la lista
 * sigue visible mientras estás en la pantalla (para poder volver a guardarlo); al volver a entrar ya no aparece.
 * La estimación que se muestra es «Para vos» del motor v3.4 (la lista no la ordena ningún motor).
 */
export default function Pending() {
  const { profileId, settings } = useApp();
  const rs = useRatings(profileId);
  const listed = useMemo(() => rs.ratings.filter((r) => r.list === 'want' || r.list === 'watching').map((r) => r.key), [rs.ratings]);
  // Orden estable: los títulos no cambian de lugar ni desaparecen mientras interactuás
  const [keys, setKeys] = useState<TitleKey[]>([]);
  useEffect(() => { setKeys((prev) => { const add = listed.filter((k) => !prev.includes(k)); return add.length ? [...prev, ...add] : prev; }); }, [listed.join(',')]);
  const sig = keys.join(',');
  const titles = useLiveQuery(() => db.titles.bulkGet(keys), [sig]) ?? [];
  const snaps = useLiveQuery(() => db.availability.bulkGet(keys.map((k) => `${k}|${settings.country}`)), [sig, settings.country]) ?? [];
  const interests = useLiveQuery(() => interestMap(profileId), [profileId]);
  useEffect(() => { if (keys.length) refreshAvailability(keys, settings.country, 30).catch(() => undefined); }, [keys.length, settings.country]);
  // Fichas que todavía no están en el dispositivo (p. ej. tras importar una copia): se piden una vez
  const fetched = useRef(new Set<TitleKey>());
  useEffect(() => {
    if (!titles.length) return;
    for (const [i, k] of keys.entries()) if (!titles[i] && !fetched.current.has(k)) { fetched.current.add(k); getTitle(k, { language: settings.language, country: settings.country }).catch(() => undefined); }
  }, [titles]);
  const [preds, setPreds] = useState<Map<TitleKey, RecommendationItem>>(new Map());
  const asked = useRef('');
  useEffect(() => {
    const ready = keys.filter((_, i) => titles[i]);
    const s = ready.join(',');
    if (!ready.length || s === asked.current) return;
    asked.current = s;
    predictFor(profileId, ready, { holdOut: true }).then(setPreds).catch(() => undefined);
  }, [sig, titles.filter(Boolean).length]);
  const count = listed.length;
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Quiero ver</h1>
      <p className="text-sm text-slate-400">Lo que guardaste con «Quiero verla» (o marcaste «Viéndola»), con disponibilidad actualizada. {count ? `${count} ${count === 1 ? 'título' : 'títulos'}.` : ''}</p>
      <DataStatus {...rs} onRetry={rs.retry} />
      {rs.status === 'ready' && keys.length === 0 && <Empty>No tenés títulos guardados. Tocá «Quiero verla» en cualquier tarjeta para sumarlos.</Empty>}
      <ul className="space-y-3" data-testid="want-list">
        {keys.map((k, i) => {
          const meta = titles[i];
          if (!meta) return null;
          const p = preds.get(k);
          const ps = personalState(p);
          const rating = rs.byKey.get(k);
          const info: CardInfo = {
            compat: p && ps.kind !== 'insufficient' ? `Afinidad con confianza ${p.confidenceLabel}` : undefined,
            primaryLabel: 'Para vos', primary: p && ps.kind !== 'insufficient' ? p.score : undefined,
            why: p?.explanation ?? [],
            cons: (p?.rejectionPenalty ?? 0) < -0.05 ? ['Se parece a títulos que descartaste con «No me interesa».'] : [],
            badges: rating?.list === 'watching' ? <span className="text-sky-300">viéndola</span> : undefined,
            reliability: [
              p ? `«Para vos» es la estimación del motor v3.4 (tu lista no la ordena ningún motor)${ps.kind === 'provisional' ? '; provisional, con poca evidencia' : ''}.` : 'Calculando la estimación «Para vos»…',
              '«Para vos» estima cuánto lo disfrutarías (1-10); no es una probabilidad ni tu nota.',
            ],
          };
          return (
            <TitleCard key={k} k={k} meta={meta} snap={snaps[i]} rating={rating} info={info} profileId={profileId} testId="want-item"
              interest={{ value: interests?.get(k)?.answer, onPick: (a) => { void safely(() => recordInterest(profileId, k, a, { engine: 'quiero-ver', source: 'quiero-ver' }), 'tu respuesta'); } }} />
          );
        })}
      </ul>
    </div>
  );
}
