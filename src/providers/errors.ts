export type ProviderErrorKind = 'config' | 'auth' | 'rate_limit' | 'not_found' | 'network' | 'server' | 'bad_response';

export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function friendlyError(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'config': return 'Falta configurar la clave de TMDB (Configuración → Fuente de datos).';
      case 'auth': return 'TMDB rechazó la clave. Revisala en Configuración.';
      case 'rate_limit': return 'TMDB limitó las consultas momentáneamente. Probá de nuevo en unos segundos.';
      case 'not_found': return 'El título no existe en TMDB.';
      case 'network': return 'Sin conexión con TMDB. Se muestran datos guardados si los hay.';
      case 'server': return 'TMDB tuvo un error interno. Probá más tarde.';
      default: return 'Respuesta inesperada del proveedor.';
    }
  }
  return e instanceof Error ? e.message : String(e);
}
