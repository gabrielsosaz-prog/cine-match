import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { AppProvider } from './hooks/useApp';
import { onDbEvent } from './db/db';
import { pushNotice } from './services/notices';
import { getRecomputeState } from './services/recompute';
import './index.css';

/**
 * Actualizaciones de la PWA (v3.0). Antes la app se recargaba sola apenas había una versión nueva, aunque
 * estuvieras guardando. Ahora se avisa y se aplica cuando tocás «Actualizar» o cuando la app pasa a segundo
 * plano sin operaciones pendientes. Los borradores sin guardar quedan en el dispositivo.
 */
let pendingUpdate: ((reload?: boolean) => Promise<void>) | undefined;
const updateSW = registerSW({
  onNeedRefresh() {
    pendingUpdate = updateSW;
    pushNotice({ kind: 'update', text: 'Hay una versión nueva de Cine Match lista.', action: { label: 'Actualizar', run: () => updateSW(true) } });
  },
});
document.addEventListener('visibilitychange', () => {
  const s = getRecomputeState();
  if (document.visibilityState === 'hidden' && pendingUpdate && !s.running && !s.queued) pendingUpdate(true);
});

// Otra pestaña o una versión nueva necesita actualizar la base local: se avisa en lugar de quedar bloqueado
onDbEvent((e) => pushNotice({
  kind: 'db',
  text: e === 'blocked' ? 'La actualización de la base local espera a que cierres otras pestañas de Cine Match.' : 'Se actualizó la app en otra pestaña. Recargá para seguir con la versión nueva (tus datos están guardados).',
  action: { label: 'Recargar', run: () => location.reload() },
}));

// El pedido de almacenamiento persistente se hace en AppProvider (storageSafety.requestPersistence), que además
// registra si se concedió para mostrarlo en Ajustes.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </React.StrictMode>,
);
