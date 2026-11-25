import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { COUNTRIES, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { createProfile, updateConfig, updateSettings } from '../db/repo';
import { useApp } from '../hooks/useApp';
import { genreNames } from '../services/catalog';
import { deleteAllData } from '../services/dataPortability';
import { clearLocalBackups, saveExternalBackup } from '../services/backups';
import { getPersistenceStatus, readLedger, requestPersistence, type PersistenceStatus } from '../services/storageSafety';
import type { EngineChoice, PlatformId } from '../types';
import { requestRecompute } from '../services/recompute';
import { engineFor } from '../services/recommendations';
import { Card, Chip } from '../ui/components';

import { diagnosticOn, setDiagnostic } from '../services/diagnostics';

const ENGINE_OPTIONS: { id: EngineChoice; label: string; help: string }[] = [
  { id: 'v3.4', label: 'v3.4 — Estable (predeterminado)', help: 'Motor anterior, utilizado actualmente por defecto.' },
  { id: 'v3.5', label: 'v3.5 — Personalizado (experimental)', help: 'Incorpora aprendizaje de preferencias a partir de valoraciones y descartes. Todavía no demostró ser superior en calidad general. Cambia el orden; la nota «Para vos» sigue siendo la de v3.4.' },
];

export default function Settings() {
  const { profileId, settings, config } = useApp();
  const profiles = useLiveQuery(() => db.profiles.toArray()) ?? [];
  const [genres, setGenres] = useState<[number, string][]>([]);
  const [msg, setMsg] = useState<string>();
  const [engineSel, setEngineSel] = useState<EngineChoice>(settings.engine ?? 'v3.4');
  useEffect(() => { setEngineSel(settings.engine ?? 'v3.4'); }, [settings.engine, profileId]);
  const [newProfile, setNewProfile] = useState('');
  useEffect(() => { if (config.tmdbToken || config.proxyUrl) genreNames(settings.language).then((m) => setGenres([...m].sort((a, b) => a[1].localeCompare(b[1])))); }, [settings.language, config.tmdbToken, config.proxyUrl]);
  const set = (patch: Parameters<typeof updateSettings>[1]) => updateSettings(profileId, patch);
  const togglePlatform = (p: PlatformId) => set({ platforms: settings.platforms.includes(p) ? settings.platforms.filter((x) => x !== p) : [...settings.platforms, p] });
  const doExport = async () => {
    try {
      const r = await saveExternalBackup();
      if (r.method !== 'cancelled') { setMsg(`Copia de ${r.total} valoraciones ${r.method === 'share' ? 'compartida' : 'descargada'}. Guardala fuera del teléfono (Drive, correo…).`); setLedger(readLedger()); }
    } catch (e) { setMsg(`No se pudo crear la copia: ${(e as Error).message}`); }
  };
  const [persist, setPersist] = useState<PersistenceStatus>(getPersistenceStatus());
  const [ledger, setLedger] = useState(readLedger());
  useEffect(() => { requestPersistence().then(setPersist).catch(() => undefined); }, []);
  const counts = useLiveQuery(async () => {
    const c: Record<string, number> = {};
    await db.ratings.each((r) => { c[r.profileId] = (c[r.profileId] ?? 0) + 1; });
    return c;
  }) ?? {};
  const [confirmDelete, setConfirmDelete] = useState('');
  const doCreateProfile = async () => {
    try {
      const p = await createProfile(newProfile);
      if (!confirm(`Se creó el perfil «${p.name}», sin valoraciones. ¿Cambiar a ese perfil ahora? Tus valoraciones quedan en el perfil actual.`)) { setNewProfile(''); return; }
      setNewProfile(''); await updateConfig({ activeProfileId: p.id });
    } catch (e) { setMsg((e as Error).message); }
  };
  const switchProfile = async (id: string, name: string) => {
    if (id === profileId) return;
    if (!confirm(`¿Cambiar al perfil «${name}» (${counts[id] ?? 0} valoraciones)? Las valoraciones de cada perfil se guardan por separado.`)) return;
    await updateConfig({ activeProfileId: id });
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Ajustes</h1>
      {msg && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">{msg}</p>}
      <Card className="space-y-2">
        <h2 className="font-semibold">País</h2>
        <select value={settings.country} onChange={(e) => set({ country: e.target.value })} className="w-full rounded-lg bg-ink-800 p-2.5 ring-1 ring-white/10" aria-label="País">
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Plataformas contratadas</h2>
        <div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <Chip key={p.id} active={settings.platforms.includes(p.id)} onClick={() => togglePlatform(p.id)}>{p.label}</Chip>)}</div>
        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={settings.includeUnconfirmed} onChange={(e) => set({ includeUnconfirmed: e.target.checked })} /> Incluir títulos con disponibilidad no confirmada</label>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Preferencias de contenido</h2>
        <label className="block text-sm">Idioma de los datos
          <select value={settings.language} onChange={(e) => set({ language: e.target.value })} className="mt-1 w-full rounded-lg bg-ink-800 p-2.5 ring-1 ring-white/10">
            <option value="es-MX">Español (Latinoamérica)</option><option value="es-ES">Español (España)</option><option value="en-US">Inglés</option>
          </select>
        </label>
        <p className="text-sm text-slate-300">Géneros que no querés ver:</p>
        <div className="flex flex-wrap gap-1.5">
          {genres.map(([id, name]) => <Chip key={id} active={settings.excludedGenres.includes(id)} onClick={() => set({ excludedGenres: settings.excludedGenres.includes(id) ? settings.excludedGenres.filter((g) => g !== id) : [...settings.excludedGenres, id] })}>{name}</Chip>)}
          {!genres.length && <span className="text-xs text-slate-500">Disponible al conectar TMDB.</span>}
        </div>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Perfiles</h2>
        <p className="text-sm text-slate-300" data-testid="active-profile">Perfil activo: <b>{profiles.find((p) => p.id === profileId)?.name ?? profileId}</b> · {counts[profileId] ?? 0} valoraciones</p>
        <div className="flex flex-wrap gap-2">{profiles.map((p) => <Chip key={p.id} active={p.id === profileId} onClick={() => switchProfile(p.id, p.name)}>{p.name} ({counts[p.id] ?? 0})</Chip>)}</div>
        <div className="flex gap-2">
          <input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} placeholder="Nombre del nuevo perfil" className="min-w-0 flex-1 rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10" />
          <button disabled={!newProfile.trim()} onClick={doCreateProfile} className="rounded-lg bg-ink-700 px-3 text-sm disabled:opacity-40">Crear</button>
        </div>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Fuente de datos</h2>
        <p className="text-sm text-slate-300">{config.proxyUrl ? 'Proxy propio configurado.' : config.tmdbToken ? 'Clave de TMDB guardada en este dispositivo.' : 'Sin configurar.'}</p>
        <Link to="/configurar" className="text-sm text-accent underline">Cambiar clave o proxy</Link>
      </Card>
      <Card className="space-y-2" data-testid="engine-card">
        <h2 className="font-semibold">Motor de recomendaciones</h2>
        <div role="radiogroup" aria-label="Motor de recomendaciones" className="space-y-2">
          {ENGINE_OPTIONS.map((o) => (
            <label key={o.id} className="flex items-start gap-2 text-sm text-slate-300">
              <input type="radio" name="engine" data-testid={`engine-${o.id}`} checked={engineSel === o.id} className="mt-1"
                onChange={async () => {
                  setEngineSel(o.id);
                  await updateSettings(profileId, { engine: o.id, engineChangedAt: Date.now() });
                  requestRecompute(profileId, { trigger: 'cambio de motor' }).catch(() => undefined);
                  setMsg(`Motor ${o.label}. «Para vos» se recalcula con este motor; tus valoraciones no cambian.`);
                }} />
              <span><span className="font-medium text-slate-100">{o.label}</span><br /><span className="text-[11px] text-slate-400">{o.help}</span></span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-slate-500">Se guarda por perfil y se aplica a «Para vos» y a sus filtros. Podés volver a v3.4 cuando quieras sin perder datos.</p>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Modo diagnóstico (desarrollo)</h2>
        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" data-testid="diagnostic-toggle" defaultChecked={diagnosticOn()} onChange={(e) => { setDiagnostic(e.target.checked); setMsg(e.target.checked ? 'Modo diagnóstico activado: en Inicio, cada recomendación muestra su cálculo y se puede exportar.' : 'Modo diagnóstico desactivado.'); }} />
          Mostrar el cálculo de cada recomendación y permitir exportarlo</label>
        <p className="text-[11px] text-slate-500">No cambia el ranking ni tus datos. Distingue datos (TMDB, tus notas) de inferencias aproximadas (análisis semántico, textos).</p>
      </Card>
      <Card className="space-y-2" data-testid="ab-card">
        <h2 className="font-semibold">Comparar motores a ciegas (v3.5)</h2>
        <p className="text-sm text-slate-300">Te mostramos títulos propuestos por el motor actual y por uno nuevo en prueba, mezclados y sin decir cuál es cuál. Tus respuestas ayudan a decidir si el nuevo recomienda mejor.</p>
        <Link to="/comparar" data-testid="ab-link" className="text-sm text-accent underline">Abrir comparación</Link>
        <p className="text-[11px] text-slate-500">Opcional. No cambia tus valoraciones ni el orden de «Para vos».</p>
      </Card>
      <Card className="space-y-2" data-testid="backup-card">
        <h2 className="font-semibold">Copias de seguridad</h2>
        <p className="text-sm text-slate-300">Tus valoraciones viven en este navegador. Si el sistema o el navegador borran los datos del sitio, sólo una copia fuera del teléfono las salva.</p>
        <ul className="text-xs text-slate-400">
          <li data-testid="persist-status">Protección contra borrado automático: {persist.supported ? (persist.persisted ? 'activada' : 'no concedida por el navegador (instalá la app en la pantalla de inicio y usala seguido)') : 'no disponible en este navegador'}</li>
          <li data-testid="last-backup">Última copia fuera del teléfono: {ledger?.lastExternalBackupAt ? new Date(ledger.lastExternalBackupAt).toLocaleDateString('es-AR') + ` (${ledger.lastExternalBackupTotal ?? 0} valoraciones)` : 'nunca'}</li>
          <li>Copias locales automáticas: se guardan solas después de valorar (sirven si falla la app, no si se borra el navegador).</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <button onClick={doExport} data-testid="backup-now" className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink-950">Guardar copia fuera del teléfono</button>
          <Link to="/recuperar" data-testid="recovery-link" className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Importar o recuperar</Link>
        </div>
        <p className="text-[11px] text-slate-500">La copia es un archivo JSON con todos los perfiles; no incluye tu clave. Importar nunca pisa valoraciones más nuevas y siempre muestra antes qué va a cambiar.</p>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Borrar datos</h2>
        <p className="text-sm text-slate-300">Borra valoraciones, perfiles, ajustes y copias locales de este dispositivo. No se puede deshacer. Escribí <b>BORRAR</b> para habilitarlo.</p>
        <div className="flex gap-2">
          <input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} aria-label="Confirmación de borrado" className="min-w-0 flex-1 rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10" />
          <button disabled={confirmDelete.trim() !== 'BORRAR'} onClick={async () => { await deleteAllData(); await clearLocalBackups().catch(() => undefined); location.reload(); }} className="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-200 disabled:opacity-40">Borrar todo</button>
        </div>
      </Card>
      <p className="text-center text-[10px] text-slate-500">Cine Match AI · motor {engineFor(settings).version}<br />Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB. Disponibilidad provista por JustWatch a través de TMDB.</p>
    </div>
  );
}
