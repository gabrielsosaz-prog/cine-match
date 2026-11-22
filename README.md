# Cine Match AI

Recomendador personal de películas y series para Netflix, Prime Video, Disney+ y Max (HBO). PWA instalable en Android, en español, con datos guardados en el dispositivo.

## Ejecutar

Requisitos: Node 20+.

```bash
npm install
npm run dev          # desarrollo en http://localhost:5173
npm run build        # compila a dist/ (PWA con service worker)
npm run preview      # sirve dist/ en http://localhost:4173
npm test             # 59 pruebas unitarias, de integración y evaluación
npm run test:e2e     # pruebas de interfaz en Android emulado (Pixel 7 y pantalla chica)
npm run eval         # evaluación offline del motor (escribe docs/evaluation-results.json)
```

## Token de TMDB (nunca en el código ni en GitHub)

La app consulta TMDB a través de su propio servidor (`/api/tmdb`), que agrega la credencial leyendo la variable de entorno **`TMDB_READ_ACCESS_TOKEN`**. El navegador nunca recibe el token.

- **Producción (Vercel):** Project → Settings → Environment Variables → `TMDB_READ_ACCESS_TOKEN` (Production y Preview) → Redeploy. Verificación: abrir `https://<tu-app>.vercel.app/api/health` debe mostrar `"ok": true` (no muestra el token).
- **Local:** copiar `.env.example` a `.env` y completar el valor. `.env` está en `.gitignore`. `npm run dev` y `npm run preview` sirven el mismo proxy.
- **Alternativa sin servidor:** en la app, «token guardado sólo en este dispositivo» (para uso personal) o el proxy de Cloudflare de `proxy/`.

El proxy sólo permite rutas de lectura (búsqueda, discover, fichas, proveedores, géneros), descarta parámetros extra y rechaza pedidos desde otros sitios. Hay una prueba que compila con un token falso y verifica que no aparece en `dist/`.

## Publicación

Vercel (plan Hobby gratuito) publica la app y la función `/api/tmdb` en el mismo dominio, y vuelve a publicar en cada push a `main`. Pasos: vercel.com → *Sign up with GitHub* → *Add New → Project* → importar `cine-match` → agregar `TMDB_READ_ACCESS_TOKEN` → *Deploy*. GitHub Actions (`.github/workflows/tests.yml`) corre las pruebas en cada push.

## Arquitectura

| Capa | Elección | Motivo |
|---|---|---|
| UI | React 18 + TypeScript + Vite + Tailwind | Rápida, tipada, sin costo, lista para Capacitor |
| Persistencia | IndexedDB (Dexie) en el dispositivo | Un usuario, sin servidor ni costo, offline; tablas ya separadas por perfil |
| Metadatos | TMDB API v3 | Gratuita para uso no comercial; películas y series, temporadas, reparto, keywords |
| Disponibilidad | TMDB `watch/providers` (datos de JustWatch) | Única fuente legítima y gratuita con datos por país (AR) |
| Motor | Híbrido propio en TS (`src/engine`) | Verificable, explicable, reemplazable vía `RecommenderEngine` |
| Servidor | Función serverless de Vercel (`api/`) | Guarda el token en una variable de entorno; mismo dominio, sin costo |

Metadatos (`titles`) y disponibilidad (`availability`, `availabilityEvents`) se guardan en tablas separadas; cada verificación registra fuente y fecha.

### Novedades v2.0

- **Nota general + 9 aspectos opcionales e independientes**: Trama y guion, Ritmo narrativo, Personajes, Suspenso e intriga, Originalidad, Impacto emocional, Actuaciones, Dirección y calidad visual, Final o desenlace. La nota general no se calcula a partir de los aspectos; un aspecto sin nota queda como «sin dato».
- **Marca «Vista / No vista» independiente**: se puede marcar vista sin puntuar, puntuar sin marcar vista, y cambiarlo después. «Vista» no es una señal de gusto.
- **Filtro del inicio**: «Solo no vistos» (predeterminado), «Solo vistos» y «Todos», combinable con plataforma y tipo.
- **Acciones rápidas en cada tarjeta**: vista con un toque, nota general en línea, panel de aspectos y edición, sin salir del ranking. Se recalcula al guardar, pero el orden no cambia mientras editás.
- **Migración automática** de los datos v1 (sin pérdida) y exportación `cine-match-export/2`, que también importa archivos v1.

### Novedades v2.1

- **Aspectos con estrellas (1 a 5)**, siete y en este orden: Trama y guion, Actuaciones, Final o desenlace, Impacto emocional, Dirección y calidad visual, Ritmo narrativo, Suspenso o intriga. Todos opcionales; se pueden quitar (✕). La nota general 1-10 no cambia y sigue siendo independiente.
- **Migración v3 (Dexie 3)**: los aspectos 1-10 se convierten con `estrellas = redondear(1 + (nota − 1) × 4 / 9)` (1→1 … 10→5; conserva extremos y orden). Los valores originales, incluidos Personajes y Originalidad, quedan en `legacy.dimensions10` y no se usan en el ranking. Notas generales, vistos y listas no se tocan. Importa exportaciones v1, v2 y v3.
- **«Otros: ¿Qué te gustó o no te gustó?»**: texto libre que se guarda y analiza sólo en el dispositivo (ver más abajo).
- **«No me interesa»** como cuarta acción rápida, independiente de vista, nota, aspectos y «Quiero verla». Se revierte desde Valoraciones → Descartados.
- **Las tarjetas no desaparecen al puntuar**: nota general → la tarjeta queda → se ofrece completar aspectos y «Otros» → «Listo». El modelo se recalcula solo; el orden visible cambia únicamente con **Actualizar ranking** (un aviso indica cambios pendientes). Los cambios sin guardar del panel quedan como borrador si se cierra por accidente.
- **Filtros avanzados** combinables (tipo, géneros incluidos/excluidos, años, plataformas, vistos, duración, afinidad mínima), con indicador, «Limpiar filtros» y «Restablecer generales». Se aplican al conjunto de candidatos antes de ordenar; si no hay resultados se indica qué filtro restringe y se puede buscar más en TMDB con esos filtros.
- **Porcentaje de aspectos completados** (aspectos / 7 × 100) en Valoraciones, con filtros, orden y acceso directo a los faltantes.

### Novedades v3.2 (motor sin cambios: `hybrid-narrative-3.1.0`)

- **Búsqueda de personas corregida.** «Michael Fox» encuentra a **Michael J. Fox** y su filmografía (Volver al futuro). Causa del fallo: en `/search/multi` de TMDB las personas quedan detrás de títulos que contienen el nombre, y la app tomaba ese orden; además, un error de escritura («Ben Afleck») devolvía 0 resultados. Ahora se consulta también `/search/person`, se ordena por coincidencia del nombre (sin iniciales intermedias, tildes ni puntos) y popularidad, y las personas van primero cuando una coincide claramente. Si no hay coincidencia, se prueban variantes concretas (consonantes dobles/simples, «Di Caprio»/«DiCaprio», apellido solo) y se muestran como «¿quisiste decir?». Nunca se fusionan dos ids de TMDB.
- **Filtros de actores**: incluidos (modo **Cualquiera** o **Todos**) y excluidos, hasta 5 por lista, por id único de TMDB. Los títulos salen de las **filmografías completas** (`/person/{id}/combined_credits`), no del ranking. Actuación = créditos de reparto de ficción (no «como sí mismo», talk shows ni documentales; producción y equipo técnico no cuentan). Series: cuenta cualquier crédito de reparto, también como invitado; «Todos» exige que todos figuren en la serie, no necesariamente en el mismo episodio. **La exclusión manda.** Si hay títulos fuera de tus plataformas, «Mostrar también» los suma.
- **Filtros de países**: incluidos (cualquiera de ellos) y excluidos, con elección de **origen**, **producción** o ambos. Coproducciones: basta un país incluido; se quitan si figura un país excluido (la exclusión manda). El idioma no se usa como país.
- **Buscar por reparto** (pestaña en Buscar): 1 a 5 personas, Todos/Cualquiera, exclusiones, tipo, género, países y «sólo en mis plataformas»; orden Para vos, Puntuación TMDB, Año o Título. Si no hay obras en común se dice explícitamente.
- **Condiciones visibles** («Actores incluidos: Ben Affleck y Jennifer Lopez · Coincidencia: Todos», «Países excluidos: México»), cada una con ✕ para quitarla sola, y «Limpiar filtros». Filtros y orden se conservan al navegar.
- **Tráileres**: 1) oficial con audio en español, 2) oficial con subtítulos en español **indicados en el título del vídeo**, 3) en español listado en TMDB pero no oficial, 4) oficial en idioma original, 5) otro vídeo oficial. Se puede elegir otra versión. Si no hay ninguna versión 1-3, se ofrece **«Buscar tráiler subtitulado en YouTube»**, que abre una búsqueda (título + año + «tráiler subtitulado español»), nunca un vídeo no verificado. Ni TMDB ni el reproductor informan pistas de subtítulos: no se afirma que existan.

### Novedades v3.1 (`hybrid-narrative-3.1.0`)

**Similares con análisis narrativo real**
- **Catálogo narrativo** precalculado (≈ 6.500 películas y series populares o muy votadas): sinopsis de TMDB en inglés + sección de argumento/premisa de **Wikipedia en inglés** (CC BY-SA) → **vectores semánticos reales** con el modelo abierto `bge-small-en-v1.5` (384 dimensiones, int8). Se calcula **fuera del teléfono**, en GitHub Actions, con textos públicos; la app sólo descarga el resultado (~1 MB comprimido + 2,5 MB de vectores, en caché, sin bloquear el arranque ni el guardado). **No se envía ningún dato personal a terceros** y no hay servicios pagos. El texto de Wikipedia no se distribuye.
- **Rasgos narrativos** con procedencia y confianza (taxonomía de ~45 rasgos: premisa, conflicto, temas, relaciones, poder, secretos, motivaciones, tono, ritmo, complejidad, tipo de misterio, humor, intensidad, estructura, ambientación): «palabras clave de TMDB» (exactas) o «inferido del argumento» (similitud semántica con descripciones prototipo, sólo si supera un umbral estadístico). Si no hay datos, el rasgo queda **desconocido**, no se inventa.
- **Similitud absoluta**, no relativa al mejor: argumento (45 %), rasgos (25 %), temáticas específicas ponderadas por rareza en todo el catálogo (18 %), creación/guion (7 %), género (5 %). Lugares, épocas y etiquetas genéricas («basada en un libro», «antología», «thriller») casi no pesan y se muestran como «no justifican el parecido». **100 % = el mismo título**; el resto llega como máximo a 99 %. La **confianza** (alta/media/baja) es aparte y mide cuánta evidencia hay, no la probabilidad de acierto.
- **1 a 5 referencias**, modos **«En común»** (predeterminado: parecido a todas, núcleo compartido) y **«Combinar»** (mezcla rasgos de distintas referencias), **importancia por referencia** (Menos/Normal/Más; iguales por defecto). Una referencia con muy pocos datos pesa menos en «En común». Se muestran lo que comparten, lo propio de cada una, las diferencias y el parecido con cada referencia.
- Recuperación en dos etapas (todo el catálogo + relacionados y descubrimiento de TMDB → reordenamiento fino), con variedad por saga sin romper el orden estricto «Similitud».
- El canal «Similitud» de «Para vos» usa los mismos vectores (canal «Narrativa»).

**Otras mejoras**
- **Orden estricto «Para vos»** en Inicio, también después de «Ver más» (el orden «Recomendado» conserva la variedad del motor y es el predeterminado). Se muestra el mismo valor con que se ordenó; los títulos con «info insuficiente» van al final.
- **Volver sin perder el lugar**: al volver con «Atrás» (incluido el botón Atrás de Android) se recuperan posición, cantidad cargada, filtros, orden, búsqueda y referencias de Similares. Al entrar desde el menú o hacer una búsqueda nueva se empieza arriba.
- **Ver tráiler** con el reproductor oficial (YouTube sin cookies / Vimeo) dentro de la app: prioridad audio en español → subtítulos en español (sólo si TMDB lo indica) → idioma original → otro video oficial. Se cierra con ✕, tocando fuera, Escape o Atrás.
- **Filtros por país** (incluir/excluir, buscador por nombre): país de origen ∪ países de producción de TMDB (no idioma ni nacionalidad del reparto). Coproducciones: incluir = alcanza con uno; excluir = se excluye si figura alguno. Sin datos de país: no pasa un filtro de inclusión y sí uno de exclusión.
- **Paramount+** (TMDB 531, verificado en Argentina) en Ajustes, filtros y disponibilidad; no se confunde con canales de Paramount.
- **Búsqueda unificada**: títulos y personas (actuación, dirección, guion) con foto, profesión y **filmografía** filtrable (rol, tipo, género, año, mis plataformas) y ordenable (Para vos, Público, recientes). Tolera tildes y variantes; un texto que es un título no se toma como persona.

### Novedades v3.0

**Correcciones críticas**
- **Guardado confiable**: guardar ya no espera al recálculo del modelo (que usa la red). Primero se persiste en una transacción atómica, se **confirma releyendo la base** (máx. 10 s, con error claro) y recién después se recalcula en segundo plano, en una **cola única** que agrupa pedidos seguidos. Un error nunca deja «procesando», muestra un aviso no bloqueante, conserva el borrador y no toca lo guardado. Cada consulta a TMDB tiene un tiempo máximo (15 s).
- **Datos siempre visibles**: las pantallas leen las valoraciones desde un almacén compartido que distingue «cargando», «tardando» y «error» de «vacío», conserva lo último confirmado si la base se cierra y reconecta sola. Pantallas con error muestran «Reintentar» en lugar de quedar en blanco.
- **Actualizaciones de la PWA sin recargas en medio de un guardado**: aviso «Hay una versión nueva» y se aplica al tocar «Actualizar» o al pasar a segundo plano sin operaciones pendientes. Se pide almacenamiento persistente.
- **Años en Android**: campo de texto con teclado numérico que acepta escritura parcial y valida al tener 4 cifras.
- **Filtros**: descubrimiento → filtrado → afinidad → orden, separados. Se ordena **todo** el subconjunto filtrado (sin tope), así ningún título que cumple el filtro desaparece al cambiar de vista. Con menos de 20 candidatos se busca en TMDB con los mismos filtros (2 páginas por orden, con caché de 1 h) y esos títulos se marcan «provisional» si hay poca evidencia.
- **10 recomendaciones y «Ver más»** de a 10. Ranking guardado de hasta 200 títulos.
- **Orden persistente** en Inicio (Para vos, Público, Año, Título + dirección), Valoraciones (campo, dirección, vista y tipo) y Similares, hasta que lo cambies o lo restablezcas.

**Motor `hybrid-channels-3.0.0`** (ver «Motor» más abajo), **actores** como fuente de candidatos y **filtro por actor/actriz/dirección** con id único de TMDB, **dos notas** (Público TMDB y «Para vos») y la sección **Similares**.

### Motor de recomendaciones (`hybrid-channels-3.0.0`)

La estimación «Para vos» = tu media + Σ peso × canal. Canales separados, cada uno en puntos sobre tu media:

| Canal | Qué mide | Peso previo | Tope |
|---|---|---|---|
| Temáticas (A) | palabras clave de TMDB y rasgos de final | 1,0 | 2,5 |
| «Otros» (A′) | conceptos de tus comentarios | 0,9 | 2 |
| Aspectos (B) | afinidad por aspecto × importancia aprendida | 1,4 | 3 |
| Actores (C) | Actuaciones (y, débil, la nota general) × participación | 0,8 | 2 |
| Dirección y guion (D) | directores, creadores y guionistas (crew «Writing») | 0,7 | 2 |
| Similitud (E) | kNN con tu historial: rasgos + sinopsis **léxica** (TF-IDF, no semántica) | 1,3 | 3 |
| Géneros (F) | acotado: aporte máximo ±1 punto | 0,6 | 0,9 |
| Formato | tipo, década, duración, idioma | 0,4 | 0,8 |
| Descartes (G) | modelo jerárquico con excepciones positivas | 1 | fijo |
| Público (H) | calidad bayesiana de TMDB, auxiliar | 0,3 | 0,35 |
| Exploración (I) | 1 de cada 6 posiciones + diversidad MMR | — | — |

- **Pesos justificados**: los previos son los valores validados en v2.1 repartidos entre canales. Con ≥ 12 valoraciones se re-estiman por **validación cruzada de 5 grupos** sobre tus notas (cada título se predice sin haber visto su nota) y regresión ridge **hacia el previo** (equivale a 10 valoraciones), no negativa y con topes. Ausencia de datos = canal en 0 (desconocido, no negativo).
- **Género sin dominar**: en la similitud entre títulos el género pesa la mitad que las temáticas, y su canal está acotado.
- **Diagnóstico**: cada recomendación guarda el aporte por canal; se ve en «¿Por qué esta estimación?» (ficha) y al abrir la explicación de una tarjeta. Es una descomposición del cálculo, no una medida de precisión.
- **Actores**: los actores con afinidad ≥ 0,2 y ≥ 2 títulos (máx. 4) aportan hasta 8 títulos de ficción de su filmografía (`/person/{id}/combined_credits`) al conjunto de candidatos; en el top 10, máximo 2 títulos impulsados por el mismo actor.

### Notas visibles
- **TMDB**: promedio de votos del público (0-10), con «s/d» si hay menos de 20 votos. FilmAffinity, IMDb y otros no tienen API pública autorizada y sustentable: no se muestran (no se hace scraping).
- **Para vos**: estimación 1-10 de cuánto lo disfrutarías. No es tu nota, ni la confianza, ni una probabilidad. «provisional» con poca evidencia; «info insuficiente» si casi no hay datos. La confianza se muestra aparte. En títulos ya puntuados se ve «Tu nota» y, en la ficha, la estimación calculada **sin** tu nota.

### Similares
Elegí 1-5 referencias. Se arma un perfil temporal con lo que comparten (temáticas, dirección, guion, reparto, subgéneros, sinopsis léxica), ponderando cada referencia por tu nota si la puntuaste y atenuando rasgos que solés puntuar bajo. Candidatos: relacionados de TMDB + descubrimiento por palabras clave, reparto y equipo + tus candidatos. Cada resultado muestra similitud (%) y «Para vos» por separado, explicación, disponibilidad y acciones rápidas; se excluyen las referencias y aplican los filtros. Sin ≥ 5 valoraciones se avisa que no está personalizado.

### Motor v2.1 (`hybrid-aspects-2.1.0`, se conserva dentro de los canales)

Sobre el modelo de afinidad de la v2.0 (no es un promedio):

- **Peso por aspecto**: influencia = proporción aprendida (regresión ridge, peso manual) × confianza, con confianza = n/(n+4) × consistencia (correlación con la nota general). Un aspecto nunca puntuado aporta **0**; ausencia ≠ nota baja.
- **Actores**: se aprende de las estrellas de Actuaciones. El crédito se reparte según la participación real (orden en los créditos; en series, proporción de episodios de `aggregate_credits`), con contracción por actor (una sola actuación no alcanza para un sesgo fuerte), evidencia negativa y confianza por cantidad de observaciones. Se explica sólo con 2+ títulos.
- **Finales**: rasgos de final (giro, abierto, ambiguo, trágico, feliz, agridulce, cliffhanger, emotivo) sólo si TMDB los publica como palabras clave; se usan únicamente para aprender del aspecto Final y nunca se muestran (spoilers). Sin esos datos, el componente no existe.
- **«Otros»**: extractor local y determinista (`local-rules-1`): cláusulas, polaridad con negación y contrastes («pero», «aunque»), léxico curado de ~50 conceptos con sinónimos en español vinculados a palabras clave y géneros de TMDB, menciones a aspectos y a actores del reparto. Los conceptos se acumulan entre comentarios y suben o bajan títulos que los tratan según TMDB; la explicación lo indica. **No es comprensión semántica**: lo que no está en el léxico no se reconoce. La interfaz `PreferenceExtractor` permite sumar embeddings o un modelo de lenguaje; uno remoto requiere tu autorización y credenciales (no está activado).
- **Descartes jerárquicos**: título (excluido) → saga (colección oficial de TMDB) → subgénero/temática (palabras clave) → género (contracción fuerte). La evidencia positiva diluye la penalización y un rasgo específico que te gustó sin descartes (misma saga, palabra clave como «batman», mismo director) es una excepción positiva. «No me interesa» no alimenta el perfil de gustos.

### Motor v2.0 (base que se conserva)


1. **Rasgos de cada título**: géneros, palabras clave, dirección/creación, reparto, tipo, década, duración, temporadas, idioma; ponderados por familia × IDF.
2. **Afinidad general**: desvío de tus notas generales respecto de tu media por rasgo, con contracción bayesiana (λ=2,5) y recorte (±3,5) para que una nota extrema aislada no distorsione.
3. **Afinidad por aspecto** (nuevo): para cada aspecto se aprende en qué rasgos (género, temática, autor, formato) puntuás ese aspecto alto o bajo, usando sólo los títulos donde lo puntuaste. Un aspecto faltante no cuenta como negativo.
4. **Importancia aprendida de cada aspecto**: regresión ridge de tu nota general sobre los desvíos de cada aspecto (cuánto explica cada uno tus notas), mezclada con un prior uniforme mientras hay poca evidencia y multiplicada por el peso manual del perfil de gustos.
5. **Predicción**: tu media + afinidad general + vecinos parecidos de tu historial (kNN por coseno) + canal de aspectos ponderado por importancia + leve ajuste por valoración del público. Es un modelo de afinidad, no un promedio.
6. **Señales**: nota general (peso 1), sólo aspectos (0,6), abandonada y «no me interesa» (negativas), «quiero verla»/«viéndola» (positivas suaves). «Vista» sin nota no aporta señal.
7. **Recalcula** perfil y ranking ante cualquier cambio de nota, aspecto o lista (marcar vista no recalcula el aprendizaje).
8. **Diversidad** (MMR) y **exploración** (1 de cada 6 posiciones). Explicaciones con tus preferencias reales, incluidos los aspectos que más pesan y los aspectos estimados para el título.
9. **Confianza** según evidencia; con menos de 5 valoraciones la recomendación se marca provisional.

La nota estimada es una afinidad en escala 1-10, no una probabilidad.

## Integraciones reales y limitaciones

- **TMDB (metadatos)**: real. Requiere token gratuito. Las palabras clave vienen en inglés (se traducen las más comunes). Algunas sinopsis no tienen traducción: se usa la inglesa y se indica.
- **Disponibilidad (JustWatch vía TMDB)**: real. Limitaciones: TMDB no informa fechas de alta/baja; la app detecta cambios comparando verificaciones y muestra el intervalo. Los datos pueden tener días de atraso respecto de JustWatch. Se refresca automáticamente cada 24 h para lo que estás viendo; más de 7 días se marca «desactualizada»; errores o países sin datos se muestran como «no confirmada». Atribución a JustWatch obligatoria (incluida).
- **APIs pagas descartadas**: Streaming Availability (RapidAPI) y Watchmode tienen fechas de expiración y más detalle, pero son pagas o con cupos bajos; se pueden sumar implementando otra fuente de disponibilidad.
- No hay scraping de ningún sitio.
- **v3.0**: el proxy permite además `search/person` y `person/{id}/combined_credits`, y los parámetros `with_keywords`, `with_cast`, `with_crew`, `with_people`. La similitud de sinopsis es léxica; una similitud semántica requeriría un modelo de embeddings (no activado sin autorización).

## Pruebas

Ver `docs/TESTING.md` y `docs/evaluation-results.json`. Las pruebas usan un catálogo **sintético** con el formato de TMDB; la integración real con TMDB requiere un token y se valida aparte.

## Futura APK (Capacitor)

```bash
npm i @capacitor/core @capacitor/cli @capacitor/android
npm run build
npx cap add android      # usa capacitor.config.json (webDir: dist)
npx cap sync android
npx cap open android     # Android Studio → Build → Generate Signed APK/AAB
```

IndexedDB funciona igual dentro del WebView. Para publicar en Play Store conviene usar el proxy (`proxy/`) en lugar de un token por usuario.

## Privacidad

Sin cuentas, sin analítica, sin servidor propio. Los datos viven en el dispositivo; se pueden exportar, importar y borrar desde Ajustes. La exportación no incluye el token.

Este producto usa la API de TMDB pero no está avalado ni certificado por TMDB.
