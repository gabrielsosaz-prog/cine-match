# Decisiones

- **Sin backend propio en v1.** Un usuario, datos personales en el dispositivo, costo cero. Los perfiles ya existen en el modelo para multiusuario; un backend (Postgres) se justifica recién con sincronización entre dispositivos.
- **IndexedDB en vez de SQLite.** Nativo del navegador y del WebView de Capacitor; SQLite en web requiere WASM y no aporta en esta escala.
- **TMDB como única fuente.** Gratis para uso no comercial, buena cobertura en español y disponibilidad por país vía JustWatch. JustWatch no ofrece API pública gratuita.
- **Token en el servidor (Vercel).** Una variable de entorno de compilación terminaría dentro del JavaScript público, así que el token vive en una función serverless que hace de proxy en el mismo dominio. Vercel Hobby es gratuito y despliega desde GitHub. Antes: **Clave en el dispositivo o proxy.** Una PWA estática no puede esconder una clave compartida; por eso cada usuario usa su propio token (guardado localmente, nunca en el bundle) o un proxy propio (`proxy/cloudflare-worker.js`) que la mantiene en el servidor.
- **Sin LLM en el ranking.** Motor de contenido + kNN, determinista y testeable; las explicaciones salen de los mismos números que ordenan.
- **Embeddings semánticos: postergados.** Un modelo de sinopsis (p. ej. MiniLM con transformers.js) agregaría ~25 MB y latencia en celulares de gama media. Las keywords de TMDB ya capturan temáticas. Se puede sumar como otra familia de rasgos sin cambiar la interfaz `RecommenderEngine`.
- **Factorización matricial / colaborativo: no aplica todavía.** Con un solo usuario no hay matriz; sirve cuando haya muchos perfiles.
- **Valoración por temporada.** Modelada (`Rating.seasons`), UI pendiente.
- **v2: «vista» separada de la nota.** El estado único de v1 mezclaba consumo y gusto. Ahora `watched` es un booleano y las listas (quiero verla, viéndola, abandonada, no me interesa) van aparte. Migración Dexie v2: «vista»/«puntuada» → vista; el resto → lista; notas, aspectos y fechas se conservan.
- **v2: aspectos como canal propio del modelo, no como promedio.** La nota general sigue siendo la señal principal; los aspectos aportan afinidades por rasgo y su importancia se aprende por regresión ridge sobre tu historial. Un aspecto sin nota es dato faltante.
- **v2: no reordenar mientras se edita.** El ranking visible se congela durante la edición y se actualiza al cerrar, para no mover tarjetas bajo el dedo.
