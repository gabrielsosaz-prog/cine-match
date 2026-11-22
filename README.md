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

### Motor de recomendaciones (`hybrid-aspects-2.0.0`)

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
