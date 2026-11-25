import { useState } from 'react';
import { externalBackupDue, saveExternalBackup } from '../services/backups';

/**
 * Recordatorio de copia fuera del teléfono (v3.6). Va en Inicio, dentro del flujo de la página (no flota sobre otros
 * botones). Aparece si nunca se hizo una copia o si pasaron 7 días con valoraciones nuevas; «Más tarde» lo oculta
 * hasta la próxima apertura.
 */
export default function BackupReminder() {
  const [due, setDue] = useState(() => externalBackupDue());
  const [hidden, setHidden] = useState(false);
  if (!due.due || hidden) return null;
  return (
    <div data-testid="backup-reminder" className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-100 ring-1 ring-amber-400/30">
      <span className="min-w-0 flex-1">{due.days === undefined ? 'Todavía no guardaste una copia de tus valoraciones fuera del teléfono.' : `Tu última copia fuera del teléfono es de hace ${due.days} días.`}</span>
      <button onClick={async () => { const r = await saveExternalBackup().catch(() => undefined); if (r && r.method !== 'cancelled') setDue(externalBackupDue()); }} className="font-semibold text-accent underline">Guardar copia</button>
      <button onClick={() => setHidden(true)} className="text-slate-400">Más tarde</button>
    </div>
  );
}
