# Resultados de pruebas (v2.0)

## Unitarias e integración (Vitest) — 80/80 OK

| Archivo | Qué cubre |
|---|---|
| `tmdb.test.ts` | Búsqueda, homónimos película/serie, autenticación v3/v4/proxy, errores 401/429/500/red/JSON, datos faltantes, mapeo de plataformas |
| `availability.test.ts` | Estados confirmada/sin datos/no verificada/desactualizada, altas y bajas, filtro por plataforma |
| `persistence.test.ts` | Nota general independiente de los aspectos, aspectos opcionales, «vista» independiente de la nota, motivo de abandono, persistencia al reabrir, perfiles, exportar/importar/borrar |
| `engine.test.ts` | Aprendizaje, robustez ante nota extrema, señales, importancia de aspectos, exclusiones, explicaciones, arranque en frío, confianza, diversidad |
| `integration.test.ts` | Buscar → valorar → recalcular; marcar vista no recalcula; rechazar excluye; filtros de plataforma; caídas del proveedor |
| `v2.test.ts` | Migración de una base v1 real (IndexedDB), importación de exportes v1, idempotencia, filtro vistos/no vistos/todos, aspectos sin nota ≠ negativos, escenarios sintéticos por aspecto |
| `proxy.test.ts` | Token sólo del lado servidor, rutas y parámetros permitidos, origen |
| `evaluation.test.ts` | NDCG@10, Recall@10 y cobertura vs. popularidad, calidad y azar |

## Interfaz Android (Playwright) — 14/14 OK

Pixel 7 y pantalla chica (360 px): las pruebas v1, más acciones rápidas en la tarjeta (vista con un toque, nota general, panel de aspectos) con los tres filtros, sin reordenar mientras se edita, y apertura de una base v1 sembrada en el navegador mostrando las valoraciones antiguas.

## Escenarios sintéticos por aspecto (`docs/dimension-scenarios.json`)

Con notas generales iguales, el motor diferencia por aspectos:

1. Suspenso alto en thrillers → thrillers 9,04 vs dramas 8,15; al invertirlo → dramas 9,16 vs thrillers 8,09.
2. Importancia aprendida: actuaciones 1,91 vs ritmo 0,09 cuando sólo las actuaciones explican la nota general.
3. Aspecto sin puntuar no penaliza (dramas 8,37 → 8,45).
4. Una nota extrema aislada no dispara la afinidad (0,42 → 0,42).
5. Bajar suspenso a 3 en thrillers los baja de 9,45 a 7,34; subirlo en ciencia ficción la lleva de 9,22 a 9,99 (5 → 8 títulos en el top 10).

## Evaluación offline (sintética)

200 títulos sintéticos en 8 grupos, 4 perfiles × 5 semillas, 30 valoraciones de entrenamiento.

| Método | NDCG@10 | Recall@10 | Cobertura |
|---|---|---|---|
| **Motor v2** | **0,780** | **0,920** | 0,480 |
| Popularidad | 0,207 | 0,205 | 0,080 |
| Calidad (TMDB) | 0,273 | 0,245 | 0,075 |
| Azar | 0,214 | 0,200 | 0,550 |

**Aviso:** todo esto es sintético. Muestra que el motor aprende y reacciona a los aspectos como se diseñó; **no** valida la calidad predictiva con usuarios reales. Para eso hace falta validación cruzada sobre tus valoraciones reales (40+).

## TMDB real

El contenedor de desarrollo no tiene salida a TMDB. La conexión real se verifica sobre la app publicada con `.github/workflows/smoke.yml` (salud, búsqueda real y disponibilidad en Argentina), sin usar ni mostrar el token.
