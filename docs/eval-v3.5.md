# Evaluación de recomendaciones v3.5

Motor candidato: `hybrid-personal-3.5.0` (`src/engine/personalEngine.ts`). Motor publicado: `hybrid-narrative-3.4.0`
(sin cambios). **Decisión: 3.4.0 sigue como motor principal**; 3.5.0 queda disponible sólo en la comparación a ciegas
(Ajustes → «Comparar motores a ciegas»), porque no alcanzó la mejora pedida (≥ 20 % relativo en NDCG@10 con evidencia).

## Qué cambia en el motor candidato

Tres etapas separadas:
- **A. Recuperación**: la misma de la app (ranking guardado, TMDB, catálogo, filmografías). Sin cambios.
- **B. Afinidad**: combinación en escala comparable (z) de tres modelos que miran señales distintas:
  1. el motor 3.4.0 (contenido, aspectos, comentarios, descartes parecidos);
  2. un modelo personal **regularizado** (ridge, λ = 8) sobre rasgos interpretables: géneros, formato, saga, popularidad,
     calidad pública bayesiana, época, idioma y 48 rasgos narrativos del catálogo (misterio, tono, estructura…);
  3. un modelo de **interés** (logístico regularizado): vistos (con o sin nota) frente a «No me interesa». No es una
     nota y no entrena el modelo de nota: un descarte no es una valoración negativa.
  Con menos de 8 notas usa sólo 3.4.0; con menos de 3 descartes no usa el modelo de interés.
- **C. Ranking**: el de 3.4.0 (diversidad, tope por saga y por actor). La exploración ahora elige entre títulos poco
  conocidos **según la afinidad del perfil**, no por calidad pública con una semilla fija.
- La nota «Para vos» mostrada sigue siendo la de 3.4.0; el candidato sólo cambia el orden.

## Evaluación con datos reales de una persona (privada)

Se evaluó además con el historial real exportado por el usuario (valoraciones, vistos, descartes y aspectos),
**sin subir esos datos ni sus resultados al repositorio**. Método (`scripts/eval/personal.ts`, que lee un archivo local
fuera de git):
- reserva final fija y estratificada de las valoraciones, usada **una sola vez** al final;
- en el resto, validación cruzada por grupos (las sagas y sus derivados quedan siempre del mismo lado) con
  particiones repetidas;
- métricas que no dependen de la calibración entre particiones: concordancia de pares, AUC «gustó frente a
  descartado», «gustó frente al resto», y error de nota; intervalos por bootstrap pareado.
Resumen sin datos personales: el candidato mejoró la concordancia con las notas reales en desarrollo y en la reserva
final frente a 3.4.0, pero **una línea base de calidad pública sola quedó a la par o por encima** en la reserva final.
Con tan pocas valoraciones no hay evidencia suficiente para afirmar un salto: por eso la comparación a ciegas.

## Evaluación editorial (perfiles sintéticos, evaluación final, 24 corridas)

Mismo protocolo que `docs/eval-v3.4.md` (catálogo real de 6.558 títulos, referencia independiente de Wikipedia y
Wikidata, separación por hash, 3 semillas). Reproducir:
`npx tsx scripts/eval/recs.ts --only F-sin-recorte-1-por-saga,B-generos,G-motor-3.5,A-popularidad,C-contenido --ref G-motor-3.5 --out docs/eval-v3.5.json`.

| Algoritmo | P@5 | P@10 | NDCG@10 | Rechazados en top 10 | Diversidad de géneros | Diversidad semántica | Novedad | Votos (mediana) | Estabilidad | Cobertura | ms (3.304 candidatos) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A popularidad | 0.13 | 0.15 | 0.060 | 0.63 | 0.73 | 0.46 | 0.73 | 7839 | 1.00 | 0.3 % | 3 |
| B géneros | 0.47 | 0.47 | 0.348 | 0.17 | 0.18 | 0.37 | 1.22 | 4899 | 0.72 | 4.3 % | 5 |
| C contenido | 0.39 | 0.35 | 0.226 | 0.25 | 0.64 | 0.44 | 1.99 | 1026 | 0.70 | 5.9 % | 83 |
| F motor 3.4.0 (publicado) | 0.58 | 0.55 | 0.470 | 0.29 | 0.65 | 0.36 | 1.35 | 4735 | 0.68 | 6.1 % | 1308 |
| **G motor 3.5.0 (candidato)** | **0.63** | **0.61** | **0.497** | **0.08** | 0.54 | 0.35 | 1.26 | 6655 | 0.67 | 5.4 % | 2424 |

Diferencias pareadas (bootstrap, 2.000 remuestras; G − otro; corridas mejor/peor):

| Comparación | NDCG@10 | mejor/peor | P@10 |
|---|---|---|---|
| G − F 3.4.0 | +0.028 [−0.037, 0.093] | 12/10 | +0.062 [−0.021, 0.138] |
| G − B géneros | **+0.149 [0.042, 0.255]** | 18/5 | **+0.146 [0.042, 0.242]** |
| G − A popularidad | +0.437 [0.346, 0.528] | 23/0 | +0.462 [0.367, 0.554] |
| G − C contenido | +0.272 [0.169, 0.372] | 19/5 | +0.263 [0.146, 0.371] |

**Conclusiones que los datos permiten:**
- Frente a 3.4.0: +6 % relativo de NDCG@10 (0,470 → 0,497), con un intervalo que incluye el cero. **No se cumple el
  objetivo de +20 %.** En desarrollo la mejora había sido +10 %, también sin significancia.
- Frente a la línea base de géneros, el candidato **sí** gana con un intervalo que excluye el cero (3.4.0 no lo
  lograba: +0,121 [−0,001, 0,238]).
- Menos títulos rechazados por el perfil en el top 10: 0,29 → 0,08 por lista.
- Costos: menos diversidad de géneros (0,65 → 0,54), títulos más populares (mediana de votos 4.735 → 6.655),
  cobertura algo menor y el doble de cómputo.

Por perfil (NDCG@10): p1 0,41 → 0,47 · p2 0,70 → 0,75 · p3 0,42 → 0,58 · p4 0,11 → 0,03 · p5 0,55 → 0,53 ·
p6 0,58 → 0,56 · p7 0,47 → 0,47 · p8 0,53 → 0,59. Gana donde la calidad pública ayuda (p3 premios de guion, p8
contradictorio); pierde en p4 (poco conocidas), donde el top 10 queda lleno de series infantiles (Masha y el Oso,
Booba, Pixar Popcorn): el problema que ya tenía 3.4.0 empeora.

## Experimentos descartados (sólo en desarrollo)

Proceso gaussiano (con y sin optimizar hiperparámetros, con y sin vectores semánticos), ranking por pares con
núcleo, modelo de interés con núcleo, vecinos semánticos (kNN), géneros, calidad + interés, combinaciones con
distintos pesos de interés, variantes de λ del modelo de nota y proyecciones semánticas (PCA de 8, 16 y 32
componentes, que empeoraron o fueron inestables). Ninguno superó a la combinación elegida en desarrollo.

## Lo que no se hizo y queda pendiente

- **Fichas narrativas estructuradas** (explícito / inferido / desconocido) generadas por un modelo de lenguaje: no hay
  un modelo local autorizado y no se usan servicios pagos ni externos con datos personales. El sustituto medible son
  los 48 rasgos narrativos del catálogo dentro del modelo personal.
- Corregir la invasión de títulos infantiles en perfiles de «poco conocidas».
- Validar con respuestas reales de la comparación a ciegas antes de cambiar el motor principal.

## Latencia y memoria (`node --expose-gc --import tsx scripts/eval/latency35.ts`)

Con el tamaño de la app (250 candidatos, 42 notas, 23 vistos sin nota, 33 descartes, catálogo semántico real), en
Node: 3.4.0 mediana 159 ms y 14 MB transitorios; 3.5.0 mediana 291 ms y 21 MB. En el teléfono el candidato sólo se
calcula al abrir la comparación (no en «Para vos»), fuera del guardado. En Android emulado con CPU 4 veces más lenta,
armar una comparación con el catálogo simulado tardó 0,24-0,29 s.
