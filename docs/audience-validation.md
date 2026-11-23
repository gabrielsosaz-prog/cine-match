# Validación del público objetivo (v3.4, reglas público-1.1)

Referencia: categorías de Wikipedia + género de Wikidata (ver criterios en scripts/eval/audience.ts). Títulos con al menos una etiqueta de referencia: 1573 (desarrollo 768, evaluación 805).

## Evaluación final, medición estricta (sólo etiquetados o incompatibles)

| Categoría | n | positivos | precisión | recall | F1 | FP | FN | inciertos | sin datos |
|---|---|---|---|---|---|---|---|---|---|
| kids | 570 | 469 | 100 % | 56 % | 72 % | 0 | 206 | 1 % | 0 |
| teen | 310 | 310 | 100 % | 18 % | 31 % | 0 | 253 | 20 % | 0 |
| family | 223 | 121 | 99 % | 87 % | 93 % | 1 | 16 | 3 % | 0 |
| adult | 603 | 102 | 100 % | 77 % | 87 % | 0 | 23 | 0 % | 0 |

## Evaluación final, medición amplia (sin etiqueta = negativo)

| Categoría | n | positivos | precisión | recall | F1 | FP | FN | inciertos | sin datos |
|---|---|---|---|---|---|---|---|---|---|
| kids | 805 | 469 | 96 % | 56 % | 71 % | 11 | 206 | 1 % | 0 |
| teen | 805 | 310 | 77 % | 18 % | 30 % | 17 | 253 | 8 % | 0 |
| family | 805 | 121 | 29 % | 87 % | 43 % | 261 | 16 | 7 % | 0 |
| adult | 805 | 102 | 50 % | 77 % | 61 % | 78 | 23 | 0 % | 0 |

## Cambio respecto de público-1.0 (misma referencia)

| Medición | Categoría | precisión 1.0 → 1.1 | recall 1.0 → 1.1 | F1 1.0 → 1.1 |
|---|---|---|---|---|
| dev-strict | kids | 100 % → 100 % | 36 % → 52 % | 53 % → 68 % |
| test-strict | kids | 100 % → 100 % | 43 % → 56 % | 60 % → 72 % |
| test-broad | kids | 96 % → 96 % | 43 % → 56 % | 60 % → 71 % |

El cambio se decidió con desarrollo (dev) y se confirma en evaluación (test). Las demás categorías no cambiaron.

## Casos pedidos

| Título | Referencia | Evidencia editorial | Reglas (estado, confianza) |
|---|---|---|---|
| Euphoria | teen | 2010s american teen drama television series; 2020s american teen drama television series; coming-of-age television shows; teen drama television | kids: no-evidence 0 · teen: no-evidence 0.17 · family: no-evidence 0 · adult: yes 0.6 |
| El club de los cinco | teen | 1980s coming-of-age comedy-drama films; 1980s teen comedy-drama films; 1985 coming-of-age films; american coming-of-age comedy-drama films | kids: no-evidence 0 · teen: uncertain 0.38 · family: no-evidence 0 · adult: yes 0.6 |
| Toy Story | kids | 1990s children's adventure films; 1990s children's animated films; 1990s children's comedy films; 1995 children's films | kids: yes 0.55 · teen: no-evidence 0 · family: yes 0.81 · adult: no-evidence 0 |
| Frozen | kids, family | 2013 children's animated films; american children's animated fantasy films; american children's animated musical films; family film | kids: uncertain 0.28 · teen: no-evidence 0 · family: yes 0.77 · adult: no-evidence 0 |
| Buscando a Nemo | kids, family | family film; children's film | kids: yes 0.55 · teen: no-evidence 0 · family: yes 0.81 · adult: no-evidence 0 |
| Bluey | kids | animated television series about children; australian children's animated adventure television series; australian children's animated comedy television series; australian children's animated television series | kids: yes 0.95 · teen: no-evidence 0 · family: yes 0.7 · adult: no-evidence 0 |
