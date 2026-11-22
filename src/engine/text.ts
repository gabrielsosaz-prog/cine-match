/**
 * Similitud LÉXICA de sinopsis (TF-IDF + coseno). Se eligió por ser local, gratuita y verificable.
 * Limitación declarada: compara palabras, no significado. No es similitud semántica: dos sinopsis que
 * cuentan lo mismo con palabras distintas no se reconocen como parecidas. Una similitud semántica real
 * requeriría un modelo de embeddings (servicio externo con costo o un modelo pesado en el dispositivo),
 * que no se activó sin autorización. Con pocos títulos el IDF es inestable: por eso este componente tiene
 * peso bajo dentro del canal de similitud.
 */
const STOP = new Set(`para como pero porque cuando donde desde hasta entre sobre tras durante mientras ante bajo contra según sino aunque
este esta estos estas ese esa esos esas aquel aquella ellos ellas nosotros ustedes suyo suya sus su mismo misma
todo toda todos todas otro otra otros otras cada mucho mucha muchos muchas poco poca algo nada nadie alguien
será serán puede pueden debe deben tiene tienen hace hacen está están estaba era eran fue fueron sido siendo hay
más menos muy tanto también tampoco solo sólo ahora antes después luego siempre nunca años vida mundo nueva nuevo
with from that this they their them there when where which while into over under about after before what will
have has been being were would could should your yours ours his hers its than then them these those just only also
very more most some such other another every each must does doing done back life world year years story film series`
  .split(/\s+/).filter(Boolean));

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Raíz rudimentaria: quita plurales comunes para que «viajes»/«viaje» coincidan. */
const stem = (w: string) => w.replace(/(es|s)$/, '');

export function tokens(text?: string): string[] {
  if (!text) return [];
  return norm(text).split(/[^a-zñ0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}

export type TextVec = Map<string, number>;

export function textIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  // Palabras que aparecen en un único documento no ayudan a comparar: se descartan
  for (const [w, c] of df) if (c >= 2 && c < n) idf.set(w, Math.log(n / c));
  return idf;
}

export function textVector(toks: string[], idf: Map<string, number>): TextVec {
  const tf = new Map<string, number>();
  for (const t of toks) if (idf.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v: TextVec = new Map();
  for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * idf.get(t)!);
  return v;
}

export function textCosine(a: TextVec, b: TextVec): number {
  if (!a.size || !b.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, x] of s) { const y = l.get(k); if (y) dot += x * y; }
  return dot / Math.sqrt(na * nb);
}
