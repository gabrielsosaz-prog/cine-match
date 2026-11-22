# Resultados de pruebas (v3.2)

## Resumen v3.2

- Vitest: **193/193 OK**. 26 nuevas en `tests/unit/v32.test.ts` para los 22 casos pedidos: país incluido, excluido, coproducciones, incluidos y excluidos a la vez (también contra el catálogo simulado); actor incluido, excluido, dos actores en Todos y en Cualquiera, uno incluido y otro excluido, actores con países/tipo/plataformas, vacío legítimo y homónimos; «Michael Fox», «Michael J. Fox», «Leonardo DiCaprio» y variantes, «Ben Afleck»/«Jenifer Lopez» (con ids y nombres reales de TMDB en un buscador simulado); tráiler oficial en español, subtítulos confirmados por el título, sin subtítulos conocidos y búsqueda externa; persistencia, migración idempotente y conservación de valoraciones, vistos, descartes y ajustes. Se actualizó la prueba de prioridad de tráileres de v3.1 a la nueva escala.
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **56/56 OK**. 4 flujos nuevos (`tests/e2e/v32.spec.ts`): Buscar por reparto (Todos, Cualquiera, exclusión, orden por título, volver con Atrás conservando todo, vacío legítimo); filtros de actores y países en Inicio con condiciones visibles, quitar una sin borrar las demás, persistencia y «Limpiar filtros»; tráiler con versiones, búsqueda en YouTube y Atrás de Android; búsqueda general con personas separadas de títulos.
- Corregido al probar: una filmografía en caché no volvía a registrar sus títulos en la base (los resultados quedaban vacíos tras borrar datos); cambiar de versión del tráiler agregaba una entrada de historial y «Atrás» no cerraba el reproductor.
- Producción con TMDB real: `tests/prod/v32.spec.ts` (Michael Fox → 521 → Volver al futuro, DiCaprio, errores de escritura, Ben Affleck + Jennifer Lopez en Todos, exclusión, Ricardo Darín con Argentina y sin España verificado contra la ficha de TMDB, tráileres de Volver al futuro, Breaking Bad y Parásitos). Resultados en el informe de la versión.

# Resultados de pruebas (v3.1)

## Resumen v3.1

- Vitest: **167/167 OK**: 16 nuevas en `v31.test.ts` (sin 100 % salvo identidad, coincidencias débiles que no suben la similitud, rasgos por encima del género, metadatos escasos, sagas, procedencia de los rasgos, modos «En común»/«Combinar», importancia por referencia, orden estricto global con «info insuf.» al final, prioridad de tráileres, regla de países y coproducciones, Paramount+, variantes de búsqueda, lugares compuestos como coincidencia débil) y la evaluación con datos reales (`narrative.eval.test.ts`).
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **48/48 OK**. 6 flujos nuevos (`tests/e2e/v31.spec.ts`): orden estricto después de «Ver más»; volver con Atrás a la misma tarjeta y cantidad cargada (y empezar arriba al entrar desde el menú); buscar una persona, filtrar su filmografía y volver a la búsqueda; tráiler embebido que se cierra con Atrás y aviso cuando no hay; excluir México y Paramount+; Similares con dos referencias, modos, importancia, porcentajes < 100 % y volver conservando todo. Con TMDB simulado; el catálogo narrativo real se prueba en producción (`tests/prod/v31.spec.ts`).
- Corregido al probar: la página se ensanchaba 8 px a 360 px (fila «Todo / Películas / Series / Pendientes»), lo que hacía zoom y tapaba la barra inferior; la posición guardada se pisaba al cambiar de pantalla; el botón de tráiler conservaba el estado del título anterior; un cálculo viejo de Similares podía pisar a uno nuevo.

## Evaluación v3.1 con datos reales (`docs/eval-v3.1.json`)

Catálogo real de 6.558 títulos (TMDB + Wikipedia, vectores `bge-small-en-v1.5`). Casos fijados **antes** de evaluar en `eval/cases.json` (16 tríos referencia → positivo vs señuelo; 1 omitido por falta de datos). Las etiquetas las puse yo a partir de sinopsis publicadas: **no son juicios de usuarios** y el conjunto es chico; las diferencias no son estadísticamente concluyentes. v3.0 se reprodujo con su propia fórmula sobre el mismo catálogo y las mismas sinopsis en español.

| Medida | v3.0 | v3.1 |
|---|---|---|
| Positivo por encima del señuelo | 9/15 (60 %) | 10/15 (67 %) |
| MRR del positivo entre 6.557 candidatos | 0,043 | 0,076 |
| Tiempo por consulta (Node, todo el catálogo) | 263 ms | 118 ms |
| Máximo mostrado | 100 % siempre (relativo al mejor) | máx. 66 % en los casos (100 % sólo identidad) |

- Mejoras claras: varias referencias con tonos distintos (Breaking Bad + The Office → Barry: puesto 828 → 8), señuelos léxicos (puesto 127 → 6) y tono contradictorio (145 → 35).
- Sin resolver en ninguna versión: «distinto género, conflicto parecido» (ambos fallan) y Batman → El gran truco frente a otra película de Batman (el puntaje crudo favorece a la saga; en la lista, la variedad por saga la compensa).
- Confianza: alta 3/5 aciertos, media 7/9, baja 0/1. **No está calibrada** como probabilidad: indica cantidad de evidencia.
- Sagas en el top 10 crudo: Harry Potter 7 y Volver al futuro 2 en ambas versiones; en la pantalla, el orden «Relevancia» limita la misma saga.

**Diagnóstico White Lotus** (The White Lotus + El club gastronómico + El intercambio, «En común»):

| Título señalado | v3.0 (puesto · % mostrado) | v3.1 (puesto · %) |
|---|---|---|
| Perfil falso | 55 · 36 % | 3.458 · 6 % |
| American Horror Story | 65 · 34 % | 1.327 · 10 % |
| 56 días | 97 · 30 % | 3.358 · 6 % |
| Love Story | 95 · 31 % | 3.156 · 6 % |
| El cuerpo en llamas | 173 · 25 % | 426 · 14 % |
| La novia | 389 · 16 % | 200 · 16 % |

Causa en v3.0: «antología», «basada en un libro», lugares y la sinopsis léxica pesaban como si fueran parecido narrativo, y el porcentaje era relativo al mejor. En v3.1 esas etiquetas casi no pesan. Limitación: las dos series nuevas tienen sinopsis de ~150 caracteres y sin artículo de Wikipedia, así que el núcleo común es pobre («secretos») y los primeros resultados combinados son flojos (≤ 36 %); se muestra así, con esa advertencia, en lugar de inflar porcentajes. Con The White Lotus sola: Nueve perfectos desconocidos, Room 104, Parásitos, Otro pequeño favor, Malos momentos en el Hotel Royale.


## Resumen v3.0

- Vitest: **150/150 OK** (39 nuevas en `v3.test.ts`):
  - guardado confirmado sin esperar el recálculo;
  - 20 guardados consecutivos;
  - 5 escrituras simultáneas de campos distintos;
  - fallo de escritura simulado (no borra nada);
  - base que no responde (corta por tiempo);
  - TMDB caído durante el recálculo;
  - cola única (6 valoraciones seguidas → 1 cálculo);
  - lectura resiliente con la base cerrada;
  - años parciales;
  - «Sólo Terror» sin historial;
  - «Sólo películas» sin perder ninguna película del ranking general (0 faltantes);
  - filtros combinados;
  - filtro por actor con homónimos;
  - orden A-Z/Z-A estable;
  - escenarios narrativos;
  - pesos por validación cruzada;
  - filmografías de actores y tope en el top 10;
  - notas pública y personalizada;
  - Similares;
  - fichas v3 con guionistas;
  - exportar/importar;
  - rutas nuevas del proxy.
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **36/36 OK**. Los 6 flujos nuevos:
  - año escrito dígito por dígito con `inputmode=numeric`;
  - 10 tarjetas + «Ver más», notas TMDB y «Para vos», diagnóstico por canal, orden por público que persiste al recargar;
  - guardar con TMDB caído y guardados seguidos, con las valoraciones visibles;
  - orden A-Z que se conserva al editar, navegar y recargar;
  - Terror con pocos candidatos y actor con homónimos combinado con tipo;
  - Similares con 2 referencias, filtros y acciones.
- Escenarios (`docs/v3-scenarios.json`):

  | Escenario | Resultado |
  |---|---|
  | Mismo género: viajes en el tiempo vs ópera espacial | 9,6 vs 2,5 |
  | Romance con viajes en el tiempo vs sin ellos | 10 vs 6,4 |
  | Ventaja por protagonista: 3 vs 1 observación | +1,03 vs +0,66 |
  | Misma nota general, distinta «Trama» | 7,35 vs 6,60 (sin aspectos: iguales) |
  | Batman frente a superhéroes descartados | Batman no queda eliminada |
  | Título popular pero ajeno | queda por debajo |

- Evaluación offline sintética:

  | Pesos | NDCG@10 | Recall@10 |
  |---|---|---|
  | Previos | 0,757 | 0,92 |
  | Aprendidos por validación cruzada | 0,784 | 0,90 |

  Las líneas base, popularidad y calidad, quedan en 0,21 y 0,27 de NDCG@10.

**Sintético**: el proveedor simulado y los títulos construidos a mano validan comportamiento, no la precisión con usuarios reales. Los emuladores de Playwright reproducen tamaños y teclado por eventos, pero no son un teclado virtual físico de Android.


## Resumen v2.1

- Vitest: **111/111 OK** (31 nuevas en `v21.test.ts`: conversión de escala, migración real de una base v2 de IndexedDB e importación de exportes v2, aspectos opcionales y quitar estrellas, peso cero de aspectos nunca puntuados, actores, finales, «Otros», «No me interesa» y reversión, sagas, excepciones positivas, filtros combinados, completitud, mapeo de TMDB).
- Playwright Android (Pixel 7 y 360 px): **24/24 OK**, incluidos: puntuar varios títulos seguidos sin que desaparezcan ni se reordenen, aviso de cambios pendientes y «Actualizar ranking», estrellas en el orden pedido, «Otros» con interpretación visible, borrador tras un cierre accidental, «No me interesa» con deshacer y sección Descartados, panel de filtros con indicador, persistencia al navegar y diagnóstico sin resultados, porcentaje de aspectos y acceso a los faltantes, base v1 sembrada en el navegador.
- Escenarios sintéticos (`docs/v21-scenarios.json`): influencia del suspenso 0,15 → 0,32 → 0,67 con 1, 3 y 8 títulos; actor con 1 vs 4 actuaciones de 5★: aporte 0,15 vs 0,41; finales con giro 8,9 vs 8,14; comentario sobre la simulación: título con realidad virtual 7,31 → 7,82, sin relación 0; descartar Endgame: misma saga −0,71, acción no relacionada −0,05; descartes de superhéroes 1/3/5: −0,31/−0,65/−0,84; con Batman puntuadas 9: Batman −0,15 vs otro superhéroe −0,70.
- Evaluación offline sintética: NDCG@10 0,785 · Recall@10 0,93 · cobertura 0,505.

**Son pruebas sintéticas**: verifican comportamiento, no la calidad predictiva con usuarios reales.

## Detalle v2.0

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
