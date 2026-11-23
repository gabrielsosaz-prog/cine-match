# Evaluación de recomendaciones v3.4

Reproducir: `npm run eval:v34` (evaluación final) y `npm run eval:v34:dev` (desarrollo). Sin red: usa el catálogo del
repositorio (`public/catalog/`) y la referencia `eval/data/reference.json`.

## Qué se mide y con qué

- **Catálogo**: 6.558 títulos reales de TMDB (ids reales) de 1920 a 2020s, 74 países y 33 idiomas originales,
  populares y poco votados, películas y series. 686 tienen menos de 3 palabras clave y 7 no tienen vector semántico
  (metadatos incompletos reales); además se prueba una ablación que quita datos a propósito.
- **Referencia independiente** (`eval/data/reference.json`, generada con `scripts/research/reference.mjs` en GitHub
  Actions): categorías de Wikipedia en inglés (5.895 títulos) y afirmaciones de Wikidata (6.459 títulos: género,
  tema, candidaturas y premios). Son decisiones editoriales de otras comunidades; **el motor no las usa** y ninguna
  etiqueta viene del propio algoritmo.
- **Separación**: hash FNV-1a de la clave del título. 50 % «desarrollo» (de ahí salen las valoraciones de los perfiles
  y ahí se ajustó todo) y 50 % «evaluación final» (candidatos y juicios). Cada perfil se corre con 3 semillas.
- **Perfiles sintéticos** (`scripts/eval/profiles.ts`), con reglas de relevancia escritas antes de mirar resultados:

| Perfil | Valoraciones | Juzgados relevantes / rechazados entre 3.304 candidatos |
|---|---|---|
| p1 Ciencia ficción con viajes en el tiempo | 27 | 454 / 685 |
| p2 Thriller psicológico y misterio | 27 | 745 / 749 |
| p3 Calidad narrativa (premios de guion) por encima del género | 34 | 163 / 20 |
| p4 Producciones poco conocidas con reconocimiento | 27 | 545 / 189 |
| p5 Gustos variados | 30 | 356 / 502 |
| p6 Gusto muy específico (atracos) | 20 | 59 / 720 |
| p7 Usuario nuevo (3 valoraciones) | 3 | 745 / 749 |
| p8 Muchas valoraciones con contradicciones | 62 | 364 / 37 |

- **Métricas**: P@5, P@10, NDCG@10 graduado (relevante = 1, muy relevante = 2), rechazados en el top 10, diversidad
  de géneros y semántica, pares de la misma saga (redundancia), novedad (−log de popularidad), mediana de votos,
  estabilidad (Jaccard del top 10 al quitar una valoración al azar, dos veces), cobertura del catálogo y latencia.
  Las métricas de relevancia usan **sólo** los juicios de la referencia, nunca el puntaje del motor.
- **Algoritmos** con los mismos candidatos y condiciones: A popularidad/nota bayesiana de TMDB, B coincidencia de
  géneros, C similitud de contenido (vectores del catálogo, con palabras clave si falta el vector),
  D motor publicado (`hybrid-narrative-3.1.0`), y variantes de diagnóstico: E (D ordenando sin recortar la nota a 10),
  F (E + máximo 1 título por saga en el top 10) y D sin datos narrativos (sin vectores y sin palabras clave en la mitad
  de los candidatos).

## Resultados agregados (evaluación final, 24 corridas)

| Algoritmo | P@5 | P@10 | NDCG@10 | Rechazados en top 10 | Diversidad de géneros | Diversidad semántica | Pares de la misma saga | Novedad | Votos (mediana) | Estabilidad | Cobertura | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A popularidad | 0.12 | 0.15 | 0.060 | 0.63 | 0.73 | 0.46 | 0.00 | 0.73 | 7839 | 1.00 | 0.3 % | 3 |
| B géneros | 0.47 | 0.47 | 0.348 | 0.17 | 0.18 | 0.37 | 0.21 | 1.22 | 4899 | 0.72 | 4.3 % | 5 |
| C contenido | 0.39 | 0.35 | 0.226 | 0.25 | 0.64 | 0.44 | 0.00 | 1.99 | 1026 | 0.70 | 5.9 % | 90 |
| D motor 3.1.0 | 0.43 | 0.45 | 0.301 | 0.33 | 0.73 | 0.37 | 0.00 | 1.38 | 4238 | 0.46 | 6.4 % | 1253 |
| D sin datos narrativos | 0.50 | 0.46 | 0.373 | 0.29 | 0.72 | 0.40 | 0.08 | 1.31 | 4818 | 0.65 | 5.9 % | 379 |
| E sin recorte | 0.60 | 0.56 | 0.479 | 0.25 | 0.65 | 0.35 | 0.42 | 1.33 | 4745 | 0.67 | 6.0 % | 1247 |
| **F = motor 3.4.0** | **0.58** | **0.55** | **0.470** | 0.29 | 0.65 | 0.36 | **0.00** | 1.35 | 4735 | **0.68** | 6.1 % | 1375 |

Latencia: tiempo de cómputo en Node para 3.304 candidatos; en el teléfono el motor rankea un conjunto más chico.

### Comparaciones pareadas (bootstrap, 2.000 remuestras; diferencia media, IC 95 %, corridas mejor/peor/empate)

| Comparación | NDCG@10 | mejor/peor/empate | P@10 |
|---|---|---|---|
| D 3.1.0 − A popularidad | +0.241 [0.174, 0.311] | 23/1/0 | +0.300 [0.212, 0.396] |
| D 3.1.0 − B géneros | −0.047 [−0.176, 0.070] | 12/12/0 | −0.017 [−0.142, 0.100] |
| D 3.1.0 − C contenido | +0.076 [0.004, 0.143] | 17/6/1 | +0.100 [0.000, 0.196] |
| D 3.1.0 − D sin datos narrativos | −0.072 [−0.150, 0.007] | 8/16/0 | −0.012 [−0.100, 0.075] |
| D 3.1.0 − F (3.4.0) | −0.168 [−0.251, −0.094] | 2/18/4 | −0.100 [−0.183, −0.025] |
| F 3.4.0 − A popularidad | +0.410 [0.328, 0.490] | 23/1/0 | +0.400 [0.317, 0.475] |
| F 3.4.0 − B géneros | +0.121 [−0.001, 0.238] | 16/8/0 | +0.083 [−0.050, 0.204] |
| F 3.4.0 − C contenido | +0.244 [0.173, 0.319] | 22/2/0 | +0.200 [0.113, 0.288] |

**Conclusiones que los datos permiten:**
- El motor (3.1.0 y 3.4.0) supera a la popularidad y a la similitud de contenido sola.
- **No hay ganador entre el motor y la coincidencia de géneros (B)**: el intervalo de 3.4.0 − B toca el cero. B logra su
  precisión recomendando 10 títulos del mismo género (diversidad 0,18 frente a 0,65).
- 3.4.0 supera a 3.1.0 en relevancia (+0,17 NDCG@10) y en estabilidad (0,46 → 0,68) a costa de algo de diversidad de
  géneros (0,73 → 0,65).
- Quitar los datos narrativos **no empeoró** la relevancia de 3.1.0 (la diferencia apunta incluso a favor de quitarlos,
  sin significancia). El canal narrativo no demostró aportar precisión en esta evaluación.

## Por perfil (NDCG@10, evaluación final)

| Perfil | A | B | C | D 3.1.0 | D sin narrativa | F 3.4.0 |
|---|---|---|---|---|---|---|
| p1 viajes en el tiempo | 0.03 | **0.55** | 0.33 | 0.38 | 0.38 | 0.41 |
| p2 thriller psicológico | 0.12 | 0.53 | 0.17 | 0.35 | 0.65 | **0.70** |
| p3 calidad narrativa | 0.22 | **0.47** | 0.07 | 0.24 | 0.38 | 0.42 |
| p4 poco conocidas | 0.00 | 0.00 | **0.11** | 0.09 | 0.02 | **0.11** |
| p5 variado | 0.00 | 0.19 | 0.22 | 0.38 | 0.41 | **0.55** |
| p6 muy específico | 0.00 | 0.12 | 0.30 | 0.23 | 0.38 | **0.58** |
| p7 usuario nuevo | 0.12 | 0.23 | 0.21 | 0.42 | 0.32 | **0.47** |
| p8 contradictorio | 0.00 | **0.70** | 0.40 | 0.31 | 0.45 | 0.53 |

**Dónde gana el motor**: gustos variados (p5), gusto muy específico (p6), usuario nuevo (p7) y thriller psicológico
(p2): combina varias señales y no se encierra en un género.
**Dónde pierde**: frente a B en p1 (ciencia ficción: el género ya define casi todo), p3 (premios de guion: el motor no
tiene una señal de calidad de escritura) y p8 (muchas valoraciones contradictorias). En p4 (poco conocidas) todos
fallan: el motor llena el top 10 de series infantiles poco votadas (Mickey Mouse Funhouse, Paw Patrol).

## Cambio adoptado en el motor (`hybrid-narrative-3.4.0`)

Hallazgo: la nota estimada se recorta a 10 y, con perfiles definidos, decenas de candidatos empatan en 10. El orden
entre ellos lo decidía la diversidad (MMR), así que quitar una sola valoración cambiaba hasta 9 de los 10 primeros
(estabilidad 0,46). Se probaron, **sólo en desarrollo**, dos variantes; F se definió tras ver que E repetía sagas
(0,42 pares por lista, p. ej. «La Gran Estafa» y «La Nueva Gran Estafa»). Regla fijada antes de mirar la evaluación
final: adoptar F si en desarrollo no queda a más de 0,02 de E y elimina las repeticiones. En desarrollo: E 0,411,
F 0,408, D 0,297. La evaluación final lo confirmó (tabla de arriba). Mismos canales, pesos y perfil: sólo cambia el
orden; la nota mostrada sigue siendo la misma. `rankBy: 'capped', collectionCap: false` reproduce 3.1.0.

Archivos: `docs/eval-v3.4.json` (A–E y ablación), `docs/eval-v3.4-orden.json` (D, E, F),
`docs/eval-v3.4-vs-lineas-base.json` (F contra A, B, C), y sus versiones `-dev`.

## Ejemplos concretos (semilla 1, evaluación final; [grado de referencia], R = rechazado por el perfil)

Buenos:
- p2 thriller psicológico, 3.4.0: El Sexto Sentido [2], La mujer en la ventana [2], Revelaciones [2], Eclipse total
  [2], Mr. Brooks [2], Perdida [2], Hannibal [2], El asesino [2]. Con 3.1.0 la misma lista traía Rambo [1],
  El Justiciero: Capítulo final [1] y Sherlock Holmes [1] (Wikipedia no los clasifica como thriller psicológico).
- p8 contradictorio, 3.4.0: abre con 멜로가 체질 [2], Su vida privada [2], Luces, cámara, ¡amor! [2].
- p7 usuario nuevo (3 valoraciones): Amnesia [2], Ojos bien cerrados [2], El halcón maltés [1], Fargo [1].

Malos:
- **Exploración repetida**: «Por unos dólares más» ocupa el puesto 6 en p1, p2, p5 y otros. El puesto de exploración
  elige por calidad pública con una semilla fija y no depende del perfil.
- p1 ciencia ficción: «Mortal Kombat: Aniquilación» [0] en el puesto 2.
- p4 poco conocidas: Mickey Mouse Funhouse [0], Paw Patrol [0], Booba [0], Mickey Mouse Clubhouse+ [0].
- p3 calidad narrativa: 7 de 10 sin relevancia (El Perfume, Air, BIA, La casa del dragón…), igual en 3.1.0 y 3.4.0.

## Limitaciones

- Los perfiles son sintéticos: prueban comportamientos esperados, no reemplazan a usuarios reales.
- La referencia es editorial y en inglés: tiene huecos (títulos sin categoría quedan sin juzgar) y sesgos propios
  (cubre mejor lo estadounidense y lo popular).
- 24 corridas: los intervalos son anchos; diferencias menores a ~0,1 de NDCG no se pueden distinguir.
- La latencia es de Node en el servidor de pruebas, no del teléfono.
- No hay métricas de satisfacción real ni de largo plazo.
