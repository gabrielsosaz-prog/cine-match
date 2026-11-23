import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { COUNTRIES, PLATFORMS } from '../constants';
import { db } from '../db/db';
import { createProfile, updateConfig, updateSettings } from '../db/repo';
import { ALGORITHM_VERSION } from '../engine/recommender';
import { useApp } from '../hooks/useApp';
import { genreNames } from '../services/catalog';
import { deleteAllData, exportData, importData } from '../services/dataPortability';
import type { PlatformId } from '../types';
import { Card, Chip } from '../ui/components';

import { diagnosticOn, setDiagnostic } from '../services/diagnostics';

export default function Settings() {
  const { profileId, settings, config } = useApp();
  const profiles = useLiveQuery(() => db.profiles.toArray()) ?? [];
  const [genres, setGenres] = useState<[number, string][]>([]);
  const [msg, setMsg] = useState<string>();
  const [newProfile, setNewProfile] = useState('');
  useEffect(() => { if (config.tmdbToken || config.proxyUrl) genreNames(settings.language).then((m) => setGenres([...m].sort((a, b) => a[1].localeCompare(b[1])))); }, [settings.language, config.tmdbToken, config.proxyUrl]);
  const set = (patch: Parameters<typeof updateSettings>[1]) => updateSettings(profileId, patch);
  const togglePlatform = (p: PlatformId) => set({ platforms: settings.platforms.includes(p) ? settings.platforms.filter((x) => x !== p) : [...settings.platforms, p] });
  const doExport = async () => {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `cine-match-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setMsg(`Exportadas ${data.ratings.length} valoraciones.`);
  };
  const doImport = async (f?: File) => {
    if (!f) return;
    try { const r = await importData(JSON.parse(await f.text())); setMsg(`Importadas ${r.ratings} valoraciones.`); } catch (e) { setMsg((e as Error).message); }
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
        <div className="flex flex-wrap gap-2">{profiles.map((p) => <Chip key={p.id} active={p.id === profileId} onClick={() => updateConfig({ activeProfileId: p.id })}>{p.name}</Chip>)}</div>
        <div className="flex gap-2">
          <input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} placeholder="Nombre del nuevo perfil" className="min-w-0 flex-1 rounded-lg bg-ink-800 p-2 text-sm ring-1 ring-white/10" />
          <button onClick={async () => { const p = await createProfile(newProfile); setNewProfile(''); await updateConfig({ activeProfileId: p.id }); }} className="rounded-lg bg-ink-700 px-3 text-sm">Crear</button>
        </div>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Fuente de datos</h2>
        <p className="text-sm text-slate-300">{config.proxyUrl ? 'Proxy propio configurado.' : config.tmdbToken ? 'Clave de TMDB guardada en este dispositivo.' : 'Sin configurar.'}</p>
        <Link to="/configurar" className="text-sm text-accent underline">Cambiar clave o proxy</Link>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Modo diagnóstico (desarrollo)</h2>
        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" data-testid="diagnostic-toggle" defaultChecked={diagnosticOn()} onChange={(e) => { setDiagnostic(e.target.checked); setMsg(e.target.checked ? 'Modo diagnóstico activado: en Inicio, cada recomendación muestra su cálculo y se puede exportar.' : 'Modo diagnóstico desactivado.'); }} />
          Mostrar el cálculo de cada recomendación y permitir exportarlo</label>
        <p className="text-[11px] text-slate-500">No cambia el ranking ni tus datos. Distingue datos (TMDB, tus notas) de inferencias aproximadas (análisis semántico, textos).</p>
      </Card>
      <Card className="space-y-2">
        <h2 className="font-semibold">Gestión de datos</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={doExport} className="rounded-lg bg-ink-700 px-3 py-2 text-sm">Exportar historial</button>
          <label className="cursor-pointer rounded-lg bg-ink-700 px-3 py-2 text-sm">Importar<input type="file" accept="application/json" className="hidden" onChange={(e) => doImport(e.target.files?.[0])} /></label>
          <button onClick={async () => { if (confirm('¿Borrar todos tus datos de este dispositivo? No se puede deshacer.')) { await deleteAllData(); location.reload(); } }} className="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-200">Borrar todos mis datos</button>
        </div>
        <p className="text-[11px] text-slate-500">Tus datos se guardan sólo en este dispositivo. No hay cuentas ni servidores propios. La exportación no incluye tu clave.</p>
      </Card>
      <p className="text-center text-[10px] text-slate-500">Cine Match AI · motor {ALGORITHM_VERSION}<br />Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB. Disponibilidad provista por JustWatch a través de TMDB.</p>
    </div>
  );
}
