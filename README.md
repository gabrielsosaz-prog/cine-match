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

### Motor de recomendaciones (`hybrid-aspects-2.1.0`)

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
