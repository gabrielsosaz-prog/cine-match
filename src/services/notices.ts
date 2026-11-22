/**
 * Avisos no bloqueantes (errores de guardado, actualizaciones de la app, estado de la base).
 * Se muestran sobre la interfaz sin impedir seguir usándola.
 */
export interface Notice { id: number; kind: 'error' | 'info' | 'update' | 'db'; text: string; action?: { label: string; run: () => void } }

let notices: Notice[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
export const getNotices = () => notices;
export function subscribeNotices(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function pushNotice(n: Omit<Notice, 'id'>, ttlMs = n.kind === 'error' ? 8000 : 0): number {
  // Un solo aviso de cada tipo persistente (actualización / base) a la vez
  if (n.kind === 'update' || n.kind === 'db') notices = notices.filter((x) => x.kind !== n.kind);
  const id = ++seq;
  notices = [...notices, { ...n, id }].slice(-4);
  emit();
  if (ttlMs) setTimeout(() => dismissNotice(id), ttlMs);
  return id;
}
export function dismissNotice(id: number) { notices = notices.filter((n) => n.id !== id); emit(); }

/** Ejecuta una acción rápida (vista, nota, descarte) e informa el error sin bloquear ni perder datos. */
export async function safely<T>(fn: () => Promise<T>, what = 'el cambio'): Promise<T | undefined> {
  try { return await fn(); } catch (e) {
    pushNotice({ kind: 'error', text: `No se pudo guardar ${what}. Tus datos anteriores siguen intactos. ${e instanceof Error ? e.message : ''}`.trim() });
    return undefined;
  }
}
