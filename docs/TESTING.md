# Resultados de pruebas (v4.1, interfaz compacta)

- Unitarias (Vitest): 292/292. Tipos: sin errores.
- Interfaz en emulación Android (Pixel 7 y 360 px, TMDB simulado): 82/82, incluida `tests/e2e/v41.spec.ts` (tarjeta común en las tres pantallas, sincronización, persistencia, tres motores, sin desborde horizontal, posición estable).
- Equivalencia v4.0 con datos reales (sólo local, fuera del repositorio): 400/400 recomendaciones idénticas en orden y puntajes; «Parecida a» consigo mismo pasó de 13 casos a 0.
- Actualización v4.0 → v4.1 con una copia real (sólo local): notas, intereses, perfil de gustos, perfiles y ajustes idénticos.
- Producción con TMDB real: `tests/prod/v41.spec.ts` (workflow «Flujos reales en producción»).

# Resultados de pruebas (v3.6, incidente de persistencia)

- Vitest: **275/275 OK**. 28 nuevas en `tests/unit/v36-storage.test.ts`: instalación nueva sin escrituras; error al abrir
  o al leer → «read-error» y ningún perfil creado; borrado de IndexedDB con registro intacto → «suspected-loss»; base
  perdida sin registro pero con copias locales; pérdida parcial grande vs. pequeña; caída con la app abierta que no baja
  el registro; borrar de a una no es pérdida; «Borrar todo» no dispara recuperación; registro corrupto; perfil vacío
  activo con valoraciones en otro; perfil sin nombre o repetido; importación de un archivo viejo que no pisa lo más
  nuevo y agrega lo que falta; vista previa sin escrituras; ajustes y nombres de perfiles intactos; copias locales
  (sin vacías, espaciadas, el recorte conserva la mayor); flujo pérdida → restauración → estado sano sin duplicados;
  el respaldo del 23/11 nunca se importa solo; historial de actividad (sólo lectura) con la caída y los títulos faltantes; recordatorio de copia externa; almacenamiento persistente denegado; y
  montaje real de la app: ante pérdida o error muestra Recuperación, nunca la app vacía.
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **76/76 OK**. Nuevos (`tests/e2e/v36.spec.ts`): base con 3 de 40
  valoraciones abre Recuperación (no la bienvenida), vista previa de un respaldo (37 agregadas, 3 conservadas), fusión
  que respeta la valoración más nueva; perfil sin nombre bloqueado y la bienvenida ofrece volver al perfil con datos;
  estado de protección y copia externa sin token en Ajustes.

# Resultados de pruebas (v3.5)

Mismos cuatro tipos de prueba que en v3.4 (abajo), más una evaluación con el historial real de una persona que se corre
localmente y **no se sube** al repositorio (`scripts/eval/personal.ts`).

## Resumen v3.5

- Vitest: **243/243 OK**. 8 nuevas en `tests/unit/v35.test.ts`: con menos de 8 notas el candidato ordena igual que 3.4.0;
  el modelo de interés sólo con ≥ 3 descartes; los descartes no cambian el modelo de nota; `orderScore` cambia el orden
  pero no la nota mostrada; intercalado sin repetidos, equilibrado y respetando el orden de cada motor (29 semillas);
  «Ya la vi» y «No puedo evaluarla» fuera del puntaje; integración con el proveedor simulado (12 títulos nuevos, nada
  ya valorado ni ya respondido, exportación sin token ni notas, valoraciones intactas).
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **68/68 OK**. Flujo nuevo (`tests/e2e/v35.spec.ts`): Ajustes →
  comparación, sin nombres de motor mientras hay pendientes, respuestas, recarga y Atrás/Adelante conservan todo,
  resumen al terminar, exportación, valoraciones idénticas en IndexedDB, Inicio sigue funcionando, sin catálogo
  semántico (bloqueado a propósito), sin desplazamiento horizontal. Con CPU 4 veces más lenta: 0,24-0,30 s para armar.
- Producción con TMDB real: `tests/prod/v35.spec.ts` (versión 3.5.0 con motor 3.4.0, comparación real de 12 títulos,
  persistencia, exportación sin token). Las pruebas de producción anteriores esperan ahora la versión 3.5.0.
  Run 45279410792 (Pixel 7 y Galaxy S5): **12/12 OK** al repetirla; comparación real de 12 títulos en 197-358 ms. En el
  primer intento la prueba de tráileres de v3.2 (código sin cambios) superó el tiempo en Galaxy S5 esperando un
  tráiler de YouTube; en Pixel 7 pasó en la misma corrida.
- Calidad: `docs/eval-v3.5.md` (editorial) y latencia con `scripts/eval/latency35.ts`.
- Selector de motor: Vitest **247/247 OK** (4 nuevas: sin elección arranca con v3.4; elegir v3.5 cambia el orden de
  «Para vos» con las mismas notas; volver a v3.4 restaura el mismo orden; caché invalidada en ambos cambios; persiste
  al reabrir; por perfil; filtros con ambos motores; comparación a ciegas independiente; valoraciones intactas).
  Playwright **70/70 OK** (flujo nuevo en Android: indicador «Motor», cambio y vuelta, recarga, comparación a ciegas,
  CPU ×4: 0,44-0,56 s hasta ver el ranking de v3.5). Producción, run 45295061631 (Pixel 7 y Galaxy S5): **14/14 OK**.
  Con 10 valoraciones reales, v3.5 cambia el top 10 de «Para vos» (6 títulos en común, otro orden) y se ve en 0,9-1,5 s.
  La primera vuelta a v3.4 repite 9 de sus 10 títulos (el primer cálculo se hizo con menos fichas completas en caché);
  la segunda vuelta v3.5 → v3.4 da exactamente el mismo orden.

# Resultados de pruebas (v3.4)

Cuatro tipos de prueba, que no se mezclan:
1. **Unitarias/funcionales** (Vitest, fichas a mano): comprueban que el código hace lo que dice. No miden calidad.
2. **Simuladas** (Vitest y Playwright con el catálogo sintético `tests/fixtures/fakeTmdb.ts`): flujos e interfaz en Android.
3. **Con datos reales** (`tests/prod/*.spec.ts`, GitHub Actions contra la app publicada y TMDB real): integración.
4. **Evaluación de calidad con referencia independiente** (`npm run eval:v34`): catálogo real + Wikipedia/Wikidata, con desarrollo y evaluación final separados. Es la única que respalda afirmaciones de precisión.

## Resumen v3.4

- Vitest: **235/235 OK**. 21 nuevas en `tests/unit/v34.test.ts`: restricción estricta vs. preferencia flexible («sin romance» filtra, «poco romance» no), texto sin preferencias idéntico a texto-1.0, preferencias no aplicadas con motivo, ajuste sólo con evidencia (sin datos = sin cambio), desplazamiento estable por posiciones, preferencias que no quitan títulos y conservan la posición del motor (integración simulada), combinación con filtros manuales y persistencia, valoraciones y ajustes intactos, orden 3.4.0 = mismo conjunto y mismas notas que 3.1.0, tope de 1 por saga, modo diagnóstico (apagado por defecto, dato vs. inferencia, faltantes, filtros, exportación sin credenciales), y ningún token en `src`, `scripts` ni `dist`.
- Actualizadas en `v33.test.ts` por cambios intencionales: «atmósfera opresiva» ahora es una preferencia (antes «no interpretado»); con `público-1.1` una animación «G» cuenta como Infantil, así que «Familiar sin Infantil» la excluye.
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **66/66 OK**. 2 flujos nuevos (`tests/e2e/v34.spec.ts`): vista previa con preferencia aplicada y no aplicada, restricción + preferencia, «Baja por…» con evidencia, persistencia al recargar, sin desborde horizontal; modo diagnóstico apagado por defecto, panel, exportación JSON sin token, y apagado.
- Producción con TMDB real: `tests/prod/v34.spec.ts` (versión y motor publicados, ningún token en el HTML ni en el JavaScript, «poco romance» no cambia la cantidad de resultados, cada «Baja por» se verifica contra la ficha de TMDB, Toy Story Infantil con la ficha real, diagnóstico y exportación).
- Producción, run 45110939205 (Pixel 7 y Galaxy S5): **10/10 OK** (incluye las pruebas de producción de v3.0-v3.3 con versión 3.4.0). Con un perfil nuevo y TMDB real: «Películas» y «Películas con poco romance» dan 36 resultados cada una; 3 coincidencias, todas con género Romance en la ficha real de TMDB, y bajan 4-5 puestos (Amor contra viento y marea 10 → 14, Forrest Gump 12 → 17, Velocidad y deseo 27 → 32). Toy Story: Infantil sí. Ningún token en el HTML ni en el JavaScript publicado ni en la exportación. Sin errores de página.
- Evaluación de calidad: `docs/eval-v3.4.md`, `docs/audience-validation.md`, `docs/preferences-validation.json`.
- Corregido al probar: (1) «poco romance» subía títulos románticos (sumar puntos a una nota recortada deshacía la diversidad); (2) un texto con sólo preferencias no contaba como filtro activo; (3) «importantes para la trama» y «No mostrar…» dejaban palabras sin interpretar.
- Las evaluaciones sintéticas previas (`docs/evaluation-results.json`) se regeneraron con el motor 3.4.0: NDCG@10 promedio del motor 0,757 → 0,84 y cobertura 0,525 → 0,46. Es un catálogo sintético: confirma la dirección, no la valida.

# Resultados de pruebas (v3.3)

## Resumen v3.3

- Vitest: **213/213 OK**. 20 nuevas en `tests/unit/v33.test.ts` (funcionales, con fichas armadas a mano y el proveedor simulado): 1 instrucciones simples, 2 negaciones, 3 condiciones combinadas, 4 texto no interpretable, 5 contradicciones, 6 incluir público adolescente, 7 excluirlo, 8 protagonistas adolescentes en obras para adultos, 9 clasificaciones inciertas y umbral, 10 públicos superpuestos, 11 regiones incluidas y «Occidental» editable, 12 regiones excluidas, 13 países con regiones, 14 coproducciones, 15 países desconocidos, 16 persistencia y limpieza por grupo, integración con el ranking y 18 conservación de valoraciones y ajustes.
- Diagnóstico con datos reales del catálogo (`docs/audience-agreement.md`): reglas contra **etiquetas propias del desarrollador** en 36 títulos. No es una validación de precisión. Adolescente: 8 sí correctos, 0 falsos sí, 3 inciertos; Infantil: 0 falsos sí, 4 de 5 obras infantiles quedan «inciertas» (Toy Story, Frozen, Nemo, Harry Potter 1: TMDB no las etiqueta como infantiles, sí como familiares); Adulto: 1 falso sí (El club de los cinco, clasificada R en EE. UU.).
- Playwright, Android Pixel 7 y Galaxy S5 (360 px): **62/62 OK**. 3 flujos nuevos (`tests/e2e/v33.spec.ts`): texto con vista previa, texto no interpretable, corrección antes de aplicar, resultados verificados, persistencia al navegar y recargar, limpiar sólo el texto; contradicción visible; público tri-estado con umbral e inciertos, regiones incluidas/excluidas, edición de «Occidental», limpieza por grupo y grupo plegable. Sin desplazamiento horizontal. Rendimiento (caso 17, simulado): texto aplicado y resultados en 0,4-1,0 s.
- Corregido al probar: «no quiero series» se interpretaba como incluir series (la palabra «quiero» anulaba la negación).
- Producción con TMDB real (caso 19), run 45102060010, Pixel 7 y Galaxy S5: **8/8 OK** (incluye las pruebas de producción de v3.0-v3.2, ahora con versión 3.3.0). En `tests/prod/v33.spec.ts` cada resultado se volvió a comprobar contra la ficha de TMDB: terror posterior a 2015 (5-6 títulos, todos película, género Terror, año ≥ 2016); thriller adulto posterior a 2015 (9); excluir público adolescente (10, ninguno con etiqueta juvenil explícita sin clasificación para adultos); europeas posteriores a 2010 con nota ≥ 7, sin España (8, país europeo y sin ES en origen ni producción); animación sin Asia oriental (10) y con Asia oriental (10). Fichas: Euphoria = Adulto (adolescente: sin evidencia, pese a sus protagonistas), Chicas pesadas = Adolescente, Bluey = Infantil y Familiar; masculino/femenino deshabilitados.
- Corregido en producción: la ficha clasificaba con datos parciales hasta recibir la ficha completa y las señales (la prueba ahora espera ambos), y el aviso «ningún título cumple los filtros» podía aparecer un instante mientras cargaban las fichas de resultados que sí existían.

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
