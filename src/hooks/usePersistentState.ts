import { useCallback, useState } from 'react';

/**
 * Estado de pantalla que se conserva en este dispositivo (orden, dirección, vista, filtros) hasta que lo
 * cambies o lo restablezcas. Sobrevive a editar un título, cambiar de pantalla y recargar la app.
 * Es una preferencia de visualización: no se mezcla con lo aprendido de tus gustos.
 */
export function usePersistentState<T>(key: string, initial: T, validate?: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const v = JSON.parse(raw);
        if (!validate || validate(v)) return v as T;
      }
    } catch { /* sin almacenamiento o dato corrupto: se usa el valor inicial */ }
    return initial;
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* sin almacenamiento */ }
  }, [key]);
  return [value, set];
}

export const oneOf = <T extends string>(xs: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);
