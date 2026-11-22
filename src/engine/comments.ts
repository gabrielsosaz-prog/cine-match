import type { DimensionId, Rating, TitleKey, TitleMeta } from '../types';

/**
 * Interpretación del campo «Otros: ¿Qué te gustó o no te gustó?».
 *
 * Arquitectura (preparada para cambiar de extractor sin tocar el motor):
 *   texto original (se guarda tal cual, sólo en el dispositivo)
 *     → PreferenceExtractor → preferencias estructuradas {concepto, polaridad, fuerza, respaldo}
 *     → perfil de conceptos (acumula evidencia entre títulos)
 *     → canal de ranking que relaciona conceptos con palabras clave y géneros de TMDB de otros títulos
 *     → explicación cuando una recomendación se apoya en un comentario.
 *
 * El extractor activo es LOCAL y DETERMINISTA (`local-rules-1`): segmenta en cláusulas, detecta la polaridad
 * (incluida la negación y los contrastes con «pero»/«aunque»), reconoce conceptos de un léxico curado con
 * sinónimos en español y los vincula a palabras clave reales de TMDB. No es comprensión semántica: un concepto
 * que no está en el léxico no se reconoce. Un extractor semántico (embeddings o un modelo de lenguaje) puede
 * implementar la misma interfaz; requiere autorización explícita porque enviaría texto personal a un tercero.
 */

export interface ExtractedPreference {
  kind: 'concept' | 'aspect' | 'person';
  id: string; // id del concepto, del aspecto o de la persona (TMDB)
  label: string;
  polarity: 1 | -1;
  strength: number; // 0-1: 1 = expresión explícita («me encantó»), 0,5 = heredada de la nota general
  /** El título comentado tiene metadatos que confirman el concepto (p. ej. la palabra clave en TMDB) */
  grounded: boolean;
}

export interface PreferenceExtractor {
  id: string;
  /** true si el texto sale del dispositivo (requiere consentimiento y credenciales). */
  remote: boolean;
  extract(text: string, context?: { title?: TitleMeta; overall?: number }): ExtractedPreference[];
}

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface Concept {
  id: string;
  label: string;
  /** Expresiones en español (texto normalizado, sin tildes) */
  es: RegExp;
  /** Palabras clave de TMDB (en inglés) que representan el concepto */
  tmdb?: RegExp;
  /** Géneros de TMDB asociados (películas y series) */
  genres?: number[];
}

/** Léxico curado: conceptos temáticos frecuentes con sinónimos. Ampliable sin cambiar el motor. */
export const CONCEPTS: Concept[] = [
  { id: 'simulation', label: 'realidad simulada', es: /simulaci|realidad virtual|mundo virtual|vivimos (en|dentro)|la realidad no es|matrix|mundo falso/, tmdb: /simulat|virtual reality|simulated reality|artificial reality/i },
  { id: 'time_travel', label: 'viajes en el tiempo', es: /viaj\w* (en|por) el tiempo|viajar en el tiempo|paradoja temporal|bucle temporal|loop temporal|linea temporal/, tmdb: /time travel|time loop|time paradox/i },
  { id: 'ai', label: 'inteligencia artificial', es: /inteligencia artificial|\bia\b|robot|androide|maquinas consciente/, tmdb: /artificial intelligence|robot|android|cyborg/i },
  { id: 'dystopia', label: 'distopías', es: /distopi|totalitari|futuro oscuro|sociedad controlada/, tmdb: /dystopi|totalitarian/i },
  { id: 'postapoc', label: 'mundos postapocalípticos', es: /postapocalip|apocalipsis|fin del mundo/, tmdb: /post-apocalyptic|apocalypse|end of the world/i },
  { id: 'space', label: 'el espacio', es: /espacio exterior|espacial|astronaut|planeta|galaxia|nave/, tmdb: /outer space|space travel|astronaut|spaceship|space opera|planet/i },
  { id: 'aliens', label: 'extraterrestres', es: /extraterrestre|alien|invasion alienigena|ovni/, tmdb: /alien|extraterrestrial|ufo/i },
  { id: 'parallel', label: 'universos paralelos', es: /universo\w* paralel|multiverso|mundo\w* paralel|dimensiones/, tmdb: /parallel world|parallel universe|multiverse|alternate reality/i },
  { id: 'dreams', label: 'sueños y mente', es: /suenos|dentro de la mente|subconsciente|onirico/, tmdb: /dream|subconscious/i },
  { id: 'memory', label: 'memoria y amnesia', es: /memoria|amnesia|recuerdos/, tmdb: /amnesia|memory loss|memory/i },
  { id: 'philosophy', label: 'preguntas filosóficas', es: /filosof|existencial|sentido de la vida|me hizo pensar|reflexion/, tmdb: /philosoph|existential/i },
  { id: 'superhero', label: 'superhéroes', es: /superhero|superheroe|marvel|\bdc\b|poderes|super ?poderes/, tmdb: /superhero|based on comic|marvel cinematic universe|dc extended universe/i },
  { id: 'serial_killer', label: 'asesinos seriales', es: /asesino\w* serial|psicopata/, tmdb: /serial killer|psychopath/i },
  { id: 'investigation', label: 'investigaciones', es: /investigaci|detective|resolver el caso|whodunit|policial/, tmdb: /investigation|detective|whodunit|police procedural/i },
  { id: 'heist', label: 'golpes y robos', es: /robo|atraco|golpe maestro|asalto/, tmdb: /heist|robbery|bank robbery/i },
  { id: 'revenge', label: 'venganza', es: /vengan/, tmdb: /revenge|vengeance/i },
  { id: 'conspiracy', label: 'conspiraciones', es: /conspiraci|complot|encubrimiento/, tmdb: /conspiracy|cover-up/i },
  { id: 'mafia', label: 'mafias y crimen organizado', es: /mafia|narco|carte|gangster|crimen organizado/, tmdb: /mafia|gangster|drug cartel|drug trafficking|organized crime|cartel/i },
  { id: 'politics', label: 'política', es: /politic|gobierno|elecciones|poder politico/, tmdb: /politic|government|election/i },
  { id: 'war', label: 'guerra', es: /guerra|soldado/, tmdb: /\bwar\b|soldier|world war/i, genres: [10752, 10768] },
  { id: 'history', label: 'historia y época', es: /historic|de epoca|hechos reales|basad\w* en (una )?historia real/, tmdb: /historical|period drama|based on true story|biography/i, genres: [36] },
  { id: 'survival', label: 'supervivencia', es: /supervivencia|sobrevivir|naufrag/, tmdb: /survival|stranded|shipwreck/i },
  { id: 'zombies', label: 'zombis', es: /zombi/, tmdb: /zombie/i },
  { id: 'vampires', label: 'vampiros', es: /vampir/, tmdb: /vampire/i },
  { id: 'supernatural', label: 'lo sobrenatural', es: /sobrenatural|fantasma|espiritu|posesion|demonio|embrujad/, tmdb: /supernatural|ghost|possession|demon|haunted/i },
  { id: 'magic', label: 'magia y fantasía', es: /magia|mago|hechiz|dragon|fantasia epica|reinos/, tmdb: /magic|wizard|dragon|sword and sorcery|high fantasy/i },
  { id: 'psych', label: 'tensión psicológica', es: /psicologic|mente del|manipulaci|paranoi/, tmdb: /psychological|manipulation|paranoia/i },
  { id: 'mental_health', label: 'salud mental', es: /salud mental|depresion|ansiedad|locura|trastorno/, tmdb: /mental illness|depression|anxiety|insanity/i },
  { id: 'grief', label: 'duelo y pérdida', es: /duelo|perdida de un|muerte de (un|una|su)/, tmdb: /grief|loss of loved one|death of/i },
  { id: 'family', label: 'relaciones familiares', es: /familia|padre|madre|herman|hij[oa]s?\b/, tmdb: /family|father|mother|sibling|parent/i },
  { id: 'friendship', label: 'amistad', es: /amistad|amigos/, tmdb: /friendship|best friend/i },
  { id: 'romance', label: 'historias de amor', es: /romance|romantic|historia de amor|enamora|pareja/, tmdb: /romance|love|relationship/i, genres: [10749] },
  { id: 'coming_of_age', label: 'crecer y madurar', es: /adolescen|crecer|madurar|coming of age|secundaria|colegio/, tmdb: /coming of age|teenager|high school/i },
  { id: 'social', label: 'crítica social', es: /critica social|desigualdad|clases sociales|sistema/, tmdb: /social commentary|class differences|inequality|satire/i },
  { id: 'corruption', label: 'corrupción', es: /corrupci/, tmdb: /corruption/i },
  { id: 'prison', label: 'cárceles', es: /carcel|prision|presos/, tmdb: /prison|jail|inmate/i },
  { id: 'courtroom', label: 'juicios', es: /juicio|abogad|tribunal/, tmdb: /courtroom|lawyer|trial/i },
  { id: 'spy', label: 'espionaje', es: /espia|espionaje|agente secreto/, tmdb: /spy|espionage|secret agent/i },
  { id: 'hacker', label: 'tecnología y hackers', es: /hacker|tecnologia|redes sociales|ciber/, tmdb: /hacker|technology|social media|cyberpunk/i },
  { id: 'nonlinear', label: 'narrativas no lineales', es: /no lineal|saltos temporales|desordenad|rompecabezas|varias lineas de tiempo/, tmdb: /nonlinear timeline|multiple storylines|flashback/i },
  { id: 'sports', label: 'deporte', es: /deporte|futbol|boxeo|basquet|tenis/, tmdb: /sport|football|soccer|boxing|basketball/i },
  { id: 'music', label: 'música', es: /musica|banda sonora|cancion|musical/, tmdb: /music|musician|band/i, genres: [10402] },
  { id: 'monsters', label: 'monstruos', es: /monstruo|criatura|kaiju|dinosaurio/, tmdb: /monster|creature|kaiju|dinosaur/i },
  { id: 'religion', label: 'religión y sectas', es: /religio|secta|culto/, tmdb: /religion|cult/i },
  { id: 'violence', label: 'violencia explícita', es: /violen|sangr|gore|brutal/, tmdb: /violence|gore|brutality/i },
  // Géneros generales
  { id: 'g_horror', label: 'terror', es: /terror|miedo|susto|horror/, genres: [27] },
  { id: 'g_comedy', label: 'comedia', es: /comedia|humor|me rei|graciosa|chistes/, genres: [35] },
  { id: 'g_action', label: 'acción', es: /accion|peleas|persecucion|explosiones/, genres: [28, 10759] },
  { id: 'g_scifi', label: 'ciencia ficción', es: /ciencia ficcion|sci-?fi/, genres: [878, 10765] },
  { id: 'g_animation', label: 'animación', es: /animacion|animada|dibujos/, genres: [16] },
  { id: 'g_documentary', label: 'documentales', es: /documental/, genres: [99] },
  { id: 'g_mystery', label: 'misterio', es: /misterio|enigma/, genres: [9648] },
];

/** Menciones a aspectos: se muestran en la interpretación; las estrellas siguen siendo la fuente principal. */
const ASPECT_TERMS: [DimensionId, RegExp][] = [
  ['acting', /actua|actor|actriz|elenco|interpretaci/],
  ['ending', /\bfinal\b|desenlace|como termin/],
  ['pacing', /ritmo|lent[oa]\b|se hace largo|dinamica|vertiginos/],
  ['story', /guion|trama|historia\b|argumento/],
  ['visuals', /fotografia|visual|efectos|estetica|direccion|imagenes/],
  ['emotion', /emocion|llore|conmovedor|me toco|emotiv/],
  ['suspense', /suspenso|intriga|tension|atrapante/],
];

const POS = /\b(me|nos) (gusto|gustaron|encanto|encantaron|fascino|atrapo|atraparon|emociono|sorprendio|parecio (buen|genial|excelente|brillante))|\bme gusta|genial|excelente|buenisim|increible|brillante|hermos|muy buen|\bbuen[oa]?\b|fascinante|lo mejor|me hizo pensar|atrapante|impecable|espectacular|perfect|me mato|original\b|interesante|bien hech/;
const NEG = /\bno me (gusto|gustaron|convencio|convencieron|atrapo|cerro|interes)|odie|horrible|malisim|pesim|aburrid|aburre|\blent[oa]s?\b|predecible|floj[oa]|me molest|sobr(o|aba)|insoportable|cansador|innecesari|demasiad|lo peor|decepcion|mal hech|absurd|forzad|ridicul|tedios|sin sentido|me sobro|me canso/;
const NEGATED_POS = /\bno (fue|era|es|me parecio|esta|estuvo|tan)?\s?(muy )?(buen|genial|excelente|interesante|original|brillante|atrapante)/;

/** Divide en cláusulas: oraciones y contrastes («pero», «aunque», «sin embargo»). */
export function clauses(text: string): string[] {
  return norm(text).split(/[.;!?\n]+|,?\s+(?:pero|aunque|sin embargo|en cambio|salvo)\s+/).map((c) => c.trim()).filter((c) => c.length > 2);
}

export function clausePolarity(c: string): -1 | 0 | 1 {
  if (NEG.test(c)) return -1;
  if (NEGATED_POS.test(c)) return -1;
  if (POS.test(c)) return 1;
  return 0;
}

const castMention = (c: string, t?: TitleMeta) =>
  (t?.cast ?? []).filter((p) => {
    const parts = norm(p.name).split(/\s+/).filter((w) => w.length > 3);
    const last = parts[parts.length - 1];
    return parts.length && (c.includes(norm(p.name)) || (last && new RegExp(`\\b${last}\\b`).test(c)));
  });

function grounded(concept: Concept, t?: TitleMeta) {
  if (!t) return false;
  if (concept.tmdb && t.keywords.some((k) => concept.tmdb!.test(k.name))) return true;
  if (concept.genres && t.genres.some((g) => concept.genres!.includes(g.id))) return true;
  return false;
}

export const localRulesExtractor: PreferenceExtractor = {
  id: 'local-rules-1',
  remote: false,
  extract(text, context = {}) {
    const out = new Map<string, ExtractedPreference>();
    const inherit = context.overall === undefined ? 0 : context.overall >= 7 ? 1 : context.overall <= 4 ? -1 : 0;
    for (const c of clauses(text ?? '')) {
      let pol: number = clausePolarity(c);
      let strength = 1;
      if (pol === 0) { pol = inherit; strength = 0.5; }
      if (pol === 0) continue;
      const add = (p: ExtractedPreference) => {
        const key = `${p.kind}:${p.id}`;
        const prev = out.get(key);
        if (!prev || p.strength > prev.strength) out.set(key, p);
      };
      for (const concept of CONCEPTS) if (concept.es.test(c)) add({ kind: 'concept', id: concept.id, label: concept.label, polarity: pol as 1 | -1, strength, grounded: grounded(concept, context.title) });
      for (const [d, re] of ASPECT_TERMS) if (re.test(c)) add({ kind: 'aspect', id: d, label: d, polarity: pol as 1 | -1, strength, grounded: true });
      for (const p of castMention(c, context.title)) add({ kind: 'person', id: String(p.id), label: p.name, polarity: pol as 1 | -1, strength, grounded: true });
    }
    return [...out.values()];
  },
};

let extractor: PreferenceExtractor = localRulesExtractor;
export const getExtractor = () => extractor;
/** Punto de extensión para un extractor semántico futuro. Uno remoto sólo debe activarse con consentimiento. */
export function setExtractor(e: PreferenceExtractor) { extractor = e; }

export interface ConceptPreference {
  id: string;
  label: string;
  score: number; // -1..1 aprox. (contraído)
  count: number;
  sources: { key: TitleKey; polarity: number }[];
}

/** Perfil de conceptos a partir de todos los comentarios: evidencia acumulada y contraída. */
export function buildConceptProfile(ratings: Rating[], titles: Map<TitleKey, TitleMeta>): { concepts: Map<string, ConceptPreference>; people: Map<number, { score: number; count: number; name: string }> } {
  const acc = new Map<string, { s: number; n: number; label: string; sources: { key: TitleKey; polarity: number }[] }>();
  const ppl = new Map<number, { s: number; n: number; name: string }>();
  for (const r of ratings) {
    if (!r.comment) continue;
    const prefs = extractor.extract(r.comment, { title: titles.get(r.key), overall: r.overall });
    for (const p of prefs) {
      // Lo confirmado por los metadatos del título comentado pesa más que una mención sin respaldo
      const w = p.strength * (p.grounded ? 1 : 0.6);
      if (p.kind === 'concept') {
        const a = acc.get(p.id) ?? { s: 0, n: 0, label: p.label, sources: [] };
        a.s += p.polarity * w; a.n += 1; a.sources.push({ key: r.key, polarity: p.polarity }); acc.set(p.id, a);
      } else if (p.kind === 'person') {
        const id = Number(p.id);
        const a = ppl.get(id) ?? { s: 0, n: 0, name: p.label };
        a.s += p.polarity * w; a.n += 1; ppl.set(id, a);
      }
    }
  }
  const concepts = new Map<string, ConceptPreference>();
  for (const [id, a] of acc) concepts.set(id, { id, label: a.label, score: a.s / (a.n + 0.75), count: a.n, sources: a.sources });
  const people = new Map<number, { score: number; count: number; name: string }>();
  for (const [id, a] of ppl) people.set(id, { score: a.s / (a.n + 0.75), count: a.n, name: a.name });
  return { concepts, people };
}

/** Conceptos del léxico presentes en un título, según sus palabras clave y géneros de TMDB. */
export function conceptsOfTitle(t: TitleMeta, spoiler: (name: string) => boolean = () => false): string[] {
  return CONCEPTS.filter((c) =>
    (c.tmdb && t.keywords.some((k) => !spoiler(k.name) && c.tmdb!.test(k.name))) ||
    (c.genres && t.genres.some((g) => c.genres!.includes(g.id))),
  ).map((c) => c.id);
}
