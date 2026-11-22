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

### Motor de recomendaciones (`hybrid-content-1.0.0`)

1. **Rasgos de cada título**: géneros, palabras clave (temáticas), dirección/creación, reparto, tipo, década, duración, cantidad de temporadas, idioma; ponderados por familia × IDF.
2. **Perfil dinámico**: afinidad por rasgo = desvío medio de tus notas respecto de tu media, con contracción bayesiana (λ=2,5) y recorte de extremos (±3,5) para que una nota aislada no distorsione.
3. **Señales**: puntuadas (peso 1), abandonadas y «no me interesa» (negativas), «quiero verla» y «viéndola» (positivas suaves), vistas sin nota.
4. **Dimensiones**: la nota efectiva combina la general (75 %) y la media de aspectos ponderada por importancia aprendida (correlación de cada aspecto con tu nota general) × peso manual ajustable.
5. **Predicción**: tu media + afinidad de contenido + vecinos más parecidos de tu historial (kNN por coseno) + leve ajuste por valoración del público.
6. **Confianza** según evidencia compartida y cantidad de valoraciones; con menos de 5 la recomendación se marca provisional.
7. **Exclusiones**: todo lo ya vista, pendiente o rechazado; géneros excluidos; plataformas no contratadas.
8. **Diversidad** (MMR) y **exploración**: 1 de cada 6 posiciones se reserva a títulos bien valorados con rasgos poco explorados, marcados como tales.
9. **Aprendizaje continuo**: cada valoración se guarda, se registra con la versión del algoritmo, recalcula perfil y ranking, y guarda una instantánea del perfil para ver su evolución.

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
