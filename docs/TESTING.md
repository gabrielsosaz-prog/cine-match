# Resultados de pruebas

## Unitarias e integración (Vitest) — 53/53 OK

| Archivo | Qué cubre |
|---|---|
| `tmdb.test.ts` (15) | Búsqueda, homónimos película/serie con el mismo id, autenticación v3/v4/proxy, errores 401/429/500/red/JSON, datos faltantes, mapeo de plataformas |
| `availability.test.ts` (6) | Estados confirmada/sin datos/no verificada/desactualizada, altas y bajas, filtro por plataforma |
| `persistence.test.ts` (8) | Guardar y modificar valoraciones, dimensiones opcionales, normalización, motivo de abandono, persistencia al reabrir la base, perfiles, exportar/importar/borrar |
| `engine.test.ts` (16) | Actualización de preferencias, robustez ante nota extrema, señales implícitas, importancia de dimensiones, ranking, exclusiones, explicaciones sin spoilers, arranque en frío, confianza, exploración y diversidad, perfiles sintéticos diferenciados |
| `integration.test.ts` (7) | Flujo completo buscar → valorar → recalcular ranking (con versión del algoritmo), filtro por plataforma, caídas del proveedor, sinopsis faltante |
| `evaluation.test.ts` (1) | NDCG@10, Recall@10 y cobertura vs. popularidad, calidad y azar |

## Interfaz móvil (Playwright) — 6/6 OK

Pixel 7 y pantalla chica (360 px): configuración, incorporación con valoración rápida, ranking con explicaciones, filtros por plataforma y tipo, homónimos en búsqueda, ficha con puntuación por aspectos, modificación, persistencia tras recargar, perfil de gustos, sin desplazamiento horizontal, error de clave, manifest PWA.

## Evaluación offline (sintética)

200 títulos sintéticos en 8 grupos, 4 perfiles con gustos distintos × 5 semillas, 30 valoraciones de entrenamiento cada uno.

| Método | NDCG@10 | Recall@10 | Cobertura |
|---|---|---|---|
| **Motor** | **0,819** | **0,955** | 0,465 |
| Popularidad | 0,207 | 0,205 | 0,080 |
| Calidad (TMDB) | 0,273 | 0,245 | 0,075 |
| Azar | 0,214 | 0,200 | 0,550 |

Aviso: el catálogo sintético tiene grupos muy marcados, por eso los valores son altos. Indica que el motor aprende y diferencia perfiles, **no** demuestra precisión con usuarios reales. Para eso hace falta un conjunto real (por ejemplo, tus valoraciones con validación cruzada cuando tengas 40+).
