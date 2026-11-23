/**
 * Filtro por texto libre (v3.3): «Describí qué querés ver o evitar».
 *
 * Método: REGLAS y VOCABULARIO en español (no hay un modelo de lenguaje: no hay uno gratuito que pueda correr sin
 * enviar texto a terceros). El texto se separa en cláusulas; en cada una se buscan expresiones conocidas (tipo,
 * géneros, años, valoración pública, público objetivo, regiones, países y temas narrativos con palabras clave
 * documentadas de TMDB) y marcas de negación («sin», «no», «excluir», «evitar», «nada de», «excepto»…).
 * Lo que no coincide con nada se informa como «no interpretado»: nunca se descarta en silencio.
 *
 * Resultado:
 *  - include: condiciones que TODAS deben cumplirse (dentro de una misma clase —géneros, regiones/países, públicos—
 *    alcanza con una: «misterio o suspenso»).
 *  - exclude: grupos; se quita el título si cumple TODAS las condiciones de un grupo («excluir comedias románticas
 *    juveniles» = comedia ∧ romance ∧ público juvenil, no cualquier comedia).
 */
import type { MediaType, TitleMeta } from '../types';
import { audienceName, type AudienceId } from './audience';
import { allCountries, countryName } from './filters';
import { regionName, type RegionId } from './regions';

export const TEXT_RULES = 'texto-1.0';
import { extractPrefs, PREF_RULES, type PrefCond } from './preferences';
export type Cond =
  | { k: 'type'; v: MediaType }
  | { k: 'genre'; v: number[]; name: string }
  | { k: 'yearMin'; v: number }
  | { k: 'yearMax'; v: number }
  | { k: 'publicMin'; v: number }
  | { k: 'audience'; v: AudienceId }
  | { k: 'region'; v: RegionId }
  | { k: 'country'; v: string }
  | { k: 'theme'; v: string; name: string; kw: string[]; genres?: number[] };
export interface ParsedText {
  text: string;
  include: Cond[];
  exclude: Cond[][];
  /** fragmentos que no se pudieron interpretar */
  unparsed: string[];
  /** aclaraciones (aproximaciones, categorías deshabilitadas, ambigüedades) */
  notes: string[];
  version: string;
  /** v3.4: preferencias flexibles (reordenan, no filtran); ver services/preferences.ts */
  prefs?: PrefCond[];
}

// ───────────── vocabulario ─────────────
const GENRES: [RegExp, number[], string][] = [
  [/terror|horror/, [27], 'Terror'],
  [/thrillers?|suspenso|suspense/, [53], 'Suspense'],
  [/ciencia ficcion|sci ?fi|ciencia-ficcion/, [878, 10765], 'Ciencia ficción'],
  [/fantasia|fantasticas?|fantasticos?/, [14, 10765], 'Fantasía'],
  [/accion/, [28, 10759], 'Acción'],
  [/aventuras?/, [12, 10759], 'Aventura'],
  [/comedias?|comicas?|graciosas?/, [35], 'Comedia'],
  [/dramas?|dramaticas?/, [18], 'Drama'],
  [/misterio|misteriosas?/, [9648], 'Misterio'],
  [/policiales?|crimen(es)?|criminales?/, [80], 'Crimen'],
  [/animadas?|animacion|dibujos animados/, [16], 'Animación'],
  [/documentales?/, [99], 'Documental'],
  [/belicas?|guerra/, [10752, 10768], 'Bélica'],
  [/westerns?|del oeste/, [37], 'Western'],
  [/historicas?/, [36], 'Historia'],
  [/musicales?/, [10402], 'Música'],
];
const ROMCOM = /comedias? romanticas?|romcoms?/;
interface Theme { id: string; re: RegExp; name: string; kw: string[]; genres?: number[] }
// Temas: nombres (en inglés) de palabras clave de TMDB, la misma fuente documentada que usan los rasgos narrativos
const THEMES: Theme[] = [
  { id: 'time-travel', re: /viajes? (en el|por el|a traves del) tiempo|viajes? temporal(es)?|viajeros? del tiempo|bucles? temporal(es)?/, name: 'viajes en el tiempo', kw: ['time travel', 'time loop', 'time machine', 'time paradox', 'time traveler'] },
  { id: 'romance', re: /relaciones? romanticas?|historias? de amor|romance|romanticas?|amorosas?|historias? romanticas?/, name: 'romance', kw: ['romance', 'love triangle', 'romantic comedy', 'falling in love', 'lovers', 'romantic drama', 'love affair'], genres: [10749] },
  { id: 'zombie', re: /zombis?|zombies?|muertos vivientes/, name: 'zombis', kw: ['zombie', 'zombie apocalypse'] },
  { id: 'vampire', re: /vampiros?/, name: 'vampiros', kw: ['vampire'] },
  { id: 'ghost', re: /fantasmas?|casas? embrujadas?|espiritus/, name: 'fantasmas', kw: ['ghost', 'haunted house', 'haunting'] },
  { id: 'alien', re: /extraterrestres?|alienigenas?|aliens?|invasion alienigena/, name: 'extraterrestres', kw: ['alien', 'alien invasion', 'extraterrestrial', 'alien life-form'] },
  { id: 'ai', re: /inteligencias? artificial(es)?|robots?|androides?/, name: 'inteligencia artificial y robots', kw: ['artificial intelligence', 'robot', 'android', 'cyborg'] },
  { id: 'serial-killer', re: /asesinos? en serie|asesinos? seriales?/, name: 'asesinos en serie', kw: ['serial killer'] },
  { id: 'heist', re: /atracos?|robos?|golpes? maestros?/, name: 'atracos', kw: ['heist', 'robbery', 'bank robbery', 'heist movie'] },
  { id: 'mafia', re: /mafias?|mafiosos?|crimen organizado/, name: 'mafia', kw: ['mafia', 'organized crime', 'gangster', 'mafia boss'] },
  { id: 'revenge', re: /venganzas?/, name: 'venganza', kw: ['revenge'] },
  { id: 'dystopia', re: /distopias?|distopicas?|postapocalipticas?|post apocalipticas?|apocalipsis/, name: 'distopía o apocalipsis', kw: ['dystopia', 'post-apocalyptic future', 'apocalypse', 'end of the world'] },
  { id: 'superhero', re: /superheroes?|superheroinas?/, name: 'superhéroes', kw: ['superhero', 'superhero team', 'based on comic'] },
  { id: 'space', re: /espacio exterior|viajes? espacial(es)?|naves? espacial(es)?|el espacio/, name: 'espacio', kw: ['space', 'outer space', 'space travel', 'spacecraft', 'astronaut'] },
  { id: 'magic', re: /brujas?|brujos?|magia|magos?|hechiceros?/, name: 'magia y brujería', kw: ['magic', 'witch', 'wizard', 'witchcraft', 'sorcery'] },
  { id: 'true-story', re: /hechos? reales?|historias? reales?|basadas? en (una )?historia real/, name: 'basada en hechos reales', kw: ['based on true story', 'based on a true story', 'biography', 'true crime'] },
  { id: 'sports', re: /deportes?|deportivas?|futbol|boxeo/, name: 'deportes', kw: ['sports', 'football', 'soccer', 'boxing', 'basketball', 'baseball'] },
  { id: 'courtroom', re: /juicios?|abogados?|tribunales?/, name: 'juicios y abogados', kw: ['courtroom', 'lawyer', 'trial', 'legal drama'] },
  { id: 'spy', re: /espias?|espionaje/, name: 'espionaje', kw: ['spy', 'espionage', 'secret agent', 'cia'] },
  { id: 'ww', re: /(primera|segunda) guerra mundial|guerras? mundial(es)?/, name: 'guerras mundiales', kw: ['world war ii', 'world war i'] },
  { id: 'detective', re: /detectives?|investigacion(es)? (policial|criminal)(es)?/, name: 'detectives e investigaciones', kw: ['detective', 'investigation', 'murder investigation', 'police detective'] },
  { id: 'dinosaur', re: /dinosaurios?/, name: 'dinosaurios', kw: ['dinosaur'] },
  { id: 'pirate', re: /piratas?/, name: 'piratas', kw: ['pirate'] },
];
const AUDIENCE: [RegExp, AudienceId][] = [
  [/adolescentes?|juvenil(es)?|adolescencia|teen(s|agers?)?|para jovenes|publico joven/, 'teen'],
  [/infantil(es)?|para (los )?ninos|para chicos|ninos pequenos/, 'kids'],
  [/adult(o|a|os|as)|para mayores|maduras?/, 'adult'],
  [/familiar(es)?|en familia|para toda la familia|todo publico|todos los publicos/, 'family'],
  [/masculinas?|masculinos?|para hombres/, 'male'],
  [/femeninas?|femeninos?|para mujeres/, 'female'],
];
const REGIONS: [RegExp, RegionId][] = [
  [/occidental(es)?|de occidente|del oeste del mundo/, 'western'],
  [/europe(a|o|as|os)|europa/, 'europe'],
  [/latinoamerican(a|o|as|os)|latinoamerica|america latina|latin(a|o|as|os)/, 'latam'],
  [/asia oriental|este asiatico|del este de asia|extremo oriente/, 'east-asia'],
  [/sudeste asiatico|sureste asiatico/, 'southeast-asia'],
  [/asia meridional|sur de asia|surasiatic(a|o|as|os)/, 'south-asia'],
  [/medio oriente|oriente medio|medio-oriente/, 'middle-east'],
  [/african(a|o|as|os)|africa/, 'africa'],
  [/oceania|oceanic(a|o|as|os)/, 'oceania'],
];
const DEMONYMS: [RegExp, string][] = [
  [/argentin(a|o|as|os)/, 'AR'], [/espanol(a|as|es)?|de espana/, 'ES'], [/mexican(a|o|as|os)/, 'MX'], [/estadounidenses?|norteamerican(a|o|as|os)|de (los )?ee ?uu|de estados unidos|hollywood/, 'US'],
  [/britanic(a|o|as|os)|ingles(a|as|es)?|del reino unido/, 'GB'], [/frances(a|as|es)?/, 'FR'], [/italian(a|o|as|os)/, 'IT'], [/aleman(a|as|es)?/, 'DE'], [/corean(a|o|as|os)/, 'KR'],
  [/japones(a|as|es)?/, 'JP'], [/chin(a|o|as|os)/, 'CN'], [/indi(a|o|as|os)|bollywood/, 'IN'], [/brasilen(a|o|as|os)/, 'BR'], [/chilen(a|o|as|os)/, 'CL'], [/colombian(a|o|as|os)/, 'CO'],
  [/suec(a|o|as|os)/, 'SE'], [/danes(a|as|es)?/, 'DK'], [/norueg(a|o|as|os)/, 'NO'], [/turc(a|o|as|os)/, 'TR'], [/canadienses?/, 'CA'], [/australian(a|o|as|os)/, 'AU'],
  [/irlandes(a|as|es)?/, 'IE'], [/belgas?/, 'BE'], [/polac(a|o|as|os)/, 'PL'], [/rus(a|o|as|os)/, 'RU'], [/tailandes(a|as|es)?/, 'TH'], [/filipin(a|o|as|os)/, 'PH'],
];
const NEG = /\b(sin|no|nada de|ni|excluir|excluyendo|excluye|exclui|excluime|evitar|evita|evito|eviten|fuera|menos|excepto|salvo|tampoco|quitar|quita|saca|sacar|odio)\b/;
// «no quiero», «no me gusta», «no busco»: la marca positiva negada no anula la negación
const POS = /(?<!\bno )(?<!\bno me )\b(con|quiero|busco|incluir|incluye|inclui|solo|solamente|prefiero|me gustan?|tipo)\b/;
// Palabras de relleno que no aportan condiciones
const FILLER = new Set(('quiero ver un una unos unas el la los las de del que y o a al en con para por me mi gustaria buscar busco ver algo producciones produccion titulos titulo obras obra cosas contenido algun alguna ' +
  'esten este estan sean sea sobre tipo estilo muy mas bien buena buenas bueno buenos valoracion publica publico centradas centrados centrada centrado enfocadas enfocados enfocada enfocado ' +
  'significativamente principalmente predominantemente dirigidas dirigidos dirigida dirigido tengan tenga temas tema trate traten tratan sin no nada ni excluir excluyendo excluye exclui evitar evita evito fuera menos excepto salvo ' +
  'posterior posteriores anterior anteriores despues antes desde hasta entre partir ano anos decada estrenadas estrenados lanzadas hechas hechos pero tambien solo solamente prefiero incluir incluye inclui donde haya hay ' +
  'son es les nos se lo le su sus mucho mucha muchos muchas poco poca relaciones peliculas pelicula series serie films film largometrajes nota puntuacion calificacion tmdb gente aclamadas aclamados criticas critica ' +
  'mostrar mostrame muestres muestren aparezcan aparecer mal malas peor peores excelente excelentes alta altas paises pais region regiones odio quitar quita saca sacar tampoco ningun ninguna cualquier todo toda todas todos favor por favor que ahora alguna').split(' '));

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”«»"¿?¡!()]/g, ' ').replace(/\s+/g, ' ').trim();

interface Hit { start: number; end: number; conds: Cond[]; note?: string }

/** Interpreta el texto. `now` = año actual (para «últimos N años»). */
export function parseText(text: string, now = new Date().getFullYear()): ParsedText {
  // v3.4: primero las preferencias flexibles; el resto pasa al analizador de restricciones (texto-1.0)
  const { prefs, rest } = extractPrefs(text);
  const p = parseStrict(text, rest, now);
  if (prefs.length) { p.prefs = prefs; p.version = `${TEXT_RULES} + ${PREF_RULES}`; }
  return p;
}
function parseStrict(text: string, source: string, now: number): ParsedText {
  const t = norm(source);
  const out: ParsedText = { text: text.trim(), include: [], exclude: [], unparsed: [], notes: [], version: TEXT_RULES };
  if (!t) return out;
  // Cláusulas: puntuación, «pero», «aunque», «y que», «y sin», «excepto/salvo» (abre su propia cláusula negativa)
  const clauses = t.split(/\s*(?:(?<!\d)[,.]|[,.](?!\d)|;|\bpero\b|\baunque\b|\by que\b|\bmientras\b)\s*|(?=\b(?:excepto|salvo|menos|sin)\b)/).map((c) => c.trim()).filter(Boolean);
  // Nombres de país (con «de» o solos si tienen 5 letras o más, para evitar cruces con palabras comunes)
  const countries = allCountries().map((c) => { const n = norm(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return { code: c.code, re: new RegExp(n.length >= 5 ? `(?:de )?${n}` : `de ${n}`) }; });
  for (const clause of clauses) {
    const hits: Hit[] = [];
    const take = (re: RegExp, mk: (m: RegExpExecArray) => Cond[] | null, note?: string) => {
      const g = new RegExp(`\\b(?:${re.source})\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = g.exec(clause))) {
        const s = m.index, e = s + m[0].length;
        if (hits.some((h) => s < h.end && e > h.start)) continue;
        const conds = mk(m);
        if (conds) hits.push({ start: s, end: e, conds, note });
      }
    };
    // Años (lo más específico primero)
    take(/entre (?:el |los anos )?(\d{4}) y (?:el )?(\d{4})/, (m) => [{ k: 'yearMin', v: Math.min(+m[1], +m[2]) }, { k: 'yearMax', v: Math.max(+m[1], +m[2]) }]);
    take(/(?:posterior(?:es)? a|despues (?:de|del)|mas nuev[ao]s? que|estrenad[ao]s? despues de) (?:el |los anos )?(\d{4})/, (m) => [{ k: 'yearMin', v: +m[1] + 1 }]);
    take(/(?:desde|a partir de|de) (?:el |los anos )?(\d{4}) (?:en adelante|o despues|para aca|para adelante)|(?:desde|a partir de)(?: el| del)? (\d{4})/, (m) => [{ k: 'yearMin', v: +(m[1] ?? m[2]) }]);
    take(/(?:anterior(?:es)? a|antes (?:de|del)|mas viej[ao]s? que) (?:el |los anos )?(\d{4})/, (m) => [{ k: 'yearMax', v: +m[1] - 1 }]);
    take(/hasta(?: el)? (\d{4})/, (m) => [{ k: 'yearMax', v: +m[1] }]);
    take(/(?:de|en) los (?:anos )?(?:19)?([2-9]0)s?|(?:de la decada de(?: los)?|anos) (?:19)?([2-9]0)s?/, (m) => { const d = 1900 + Number(m[1] ?? m[2]); return [{ k: 'yearMin', v: d }, { k: 'yearMax', v: d + 9 }]; });
    take(/(?:de|en) los (?:anos )?(20[0-2]0)s?|(?:de la decada de(?: los)?|anos) (20[0-2]0)s?/, (m) => { const d = Number(m[1] ?? m[2]); return [{ k: 'yearMin', v: d }, { k: 'yearMax', v: d + 9 }]; });
    take(/(?:de los |en los )?ultimos (\d{1,2}) anos/, (m) => [{ k: 'yearMin', v: now - Number(m[1]) }]);
    take(/(?:del|de|en) (?:ano )?(19\d{2}|20\d{2})/, (m) => [{ k: 'yearMin', v: +m[1] }, { k: 'yearMax', v: +m[1] }]);
    take(/recientes?|nuev[ao]s|actuales?/, () => [{ k: 'yearMin', v: now - 3 }], '«reciente» = de los últimos 3 años');
    // Valoración pública (TMDB)
    take(/(?:nota|puntuacion|calificacion|valoracion|puntaje)(?: publica| de tmdb| en tmdb)? (?:de |mayor (?:a|que) |superior a |de mas de |mas de |por encima de |minima de )?(\d(?:[.,]\d)?)(?: o mas| para arriba)?/, (m) => [{ k: 'publicMin', v: Number(m[1].replace(',', '.')) }]);
    take(/(?:muy buena|excelente|altisima) (?:valoracion|nota|puntuacion|critica)(?: publica)?|muy bien (?:valoradas?|puntuadas?|calificadas?)|obras maestras/, () => [{ k: 'publicMin', v: 8 }], '«muy bien valorada» = nota TMDB 8 o más');
    take(/(?:buena|alta) (?:valoracion|nota|puntuacion|critica|calificacion)(?: publica)?|bien (?:valoradas?|puntuadas?|calificadas?)|aclamad[ao]s?/, () => [{ k: 'publicMin', v: 7 }], '«buena valoración pública» = nota TMDB 7 o más');
    // Tipo
    take(/peliculas?|films?|largometrajes?/, () => [{ k: 'type', v: 'movie' }]);
    take(/series?|miniseries?/, () => [{ k: 'type', v: 'tv' }]);
    // Comedia romántica = comedia ∧ romance (antes que «comedia» y «romántica» por separado)
    take(ROMCOM, () => [{ k: 'genre', v: [35], name: 'Comedia' }, { k: 'genre', v: [10749], name: 'Romance' }]);
    // Público objetivo (con «público …» explícito o como adjetivo)
    for (const [re, id] of AUDIENCE) take(new RegExp(`(?:publico |audiencia |dirigid[ao]s? (?:a|al) (?:publico )?)?(?:${re.source})`), () => [{ k: 'audience', v: id }], id === 'male' || id === 'female' ? `«${audienceName(id)}» está deshabilitada (sin evidencia verificable): no se aplica` : undefined);
    // Temas narrativos (antes que géneros: «historias de amor» es tema, no género)
    for (const th of THEMES) take(th.re, () => [{ k: 'theme', v: th.id, name: th.name, kw: th.kw, genres: th.genres }], th.id === 'romance' ? '«romance»: se usa el género Romance o palabras clave de TMDB; no se mide cuánto pesa en la trama' : undefined);
    for (const [re, ids, name] of GENRES) take(re, () => [{ k: 'genre', v: ids, name }]);
    // Idiomas: no son países ni regiones (no se usan para filtrar por país)
    take(/(?:en|hablad[ao]s? en|en idioma|idioma|doblad[ao]s? al|subtitulad[ao]s? (?:al|en)) (?:ingles|espanol|castellano|frances|italiano|aleman|coreano|japones|chino|portugues|ruso|hindi|arabe)/, () => [], 'El idioma no se usa como país de producción: «en <idioma>» no se aplica');
    // Regiones y países
    for (const [re, id] of REGIONS) take(re, () => [{ k: 'region', v: id }]);
    take(/asiatic(a|o|as|os)|de asia|asia|oriental(es)?|del oriente/, () => [], '«asiático/oriental» es ambiguo y no se aplica: elegí Asia oriental, Sudeste asiático o Asia meridional');
    for (const [re, code] of DEMONYMS) take(re, () => [{ k: 'country', v: code }]);
    for (const c of countries) take(c.re, () => [{ k: 'country', v: c.code }]);

    hits.sort((a, b) => a.start - b.start);
    // Negación: una marca negativa vale para lo que sigue en la cláusula hasta una marca positiva
    const negAt = (pos: number) => {
      const before = clause.slice(0, pos);
      const nm = [...before.matchAll(new RegExp(NEG.source, 'g'))].pop();
      if (!nm) return false;
      const pm = [...before.matchAll(new RegExp(POS.source, 'g'))].pop();
      return !pm || (pm.index ?? 0) < (nm.index ?? 0);
    };
    let group: Cond[] | undefined;
    let lastEnd = -1;
    for (const h of hits) {
      if (h.note && !out.notes.includes(h.note)) out.notes.push(h.note);
      const conds = h.conds.filter((c) => !(c.k === 'audience' && (c.v === 'male' || c.v === 'female')));
      if (!conds.length) { lastEnd = h.end; continue; }
      if (negAt(h.start)) {
        // separadores entre dos negaciones: «ni», «o», «y sin», otra marca negativa → grupo nuevo
        const between = lastEnd >= 0 ? clause.slice(lastEnd, h.start) : '';
        if (!group || /\b(ni|o|u|sin|no|excluir|evitar|nada de)\b/.test(between) || lastEnd < 0) { group = []; out.exclude.push(group); }
        group.push(...conds);
      } else { group = undefined; out.include.push(...conds); }
      lastEnd = h.end;
    }
    // Lo que queda sin interpretar
    let rest = '';
    let pos = 0;
    for (const h of hits) { rest += clause.slice(pos, h.start) + ' | '; pos = h.end; }
    rest += clause.slice(pos);
    for (const frag of rest.split('|')) {
      const words = frag.split(' ').filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));
      if (words.length) out.unparsed.push(words.join(' '));
    }
  }
  // Exclusión de un tipo completo: «que no sean series» = sólo películas (se muestra igual como exclusión)
  out.include = dedupe(out.include);
  out.exclude = out.exclude.map(dedupe).filter((g) => g.length);
  return out;
}
const condKey = (c: Cond) => `${c.k}:${JSON.stringify(c.v)}`;
const dedupe = (cs: Cond[]) => [...new Map(cs.map((c) => [condKey(c), c])).values()];

/** Texto legible de una condición. */
export function condLabel(c: Cond): string {
  switch (c.k) {
    case 'type': return c.v === 'movie' ? 'Tipo: película' : 'Tipo: serie';
    case 'genre': return `Género: ${c.name}`;
    case 'yearMin': return `Año mínimo: ${c.v}`;
    case 'yearMax': return `Año máximo: ${c.v}`;
    case 'publicMin': return `Nota TMDB: ${String(c.v).replace('.', ',')} o más`;
    case 'audience': return `Público: ${audienceName(c.v)} (aprox.)`;
    case 'region': return `Región: ${regionName(c.v)}`;
    case 'country': return `País: ${countryName(c.v)}`;
    case 'theme': return `Tema: ${c.name} (palabras clave de TMDB)`;
  }
}
export const groupLabel = (g: Cond[]) => g.map((c) => condLabel(c).replace(/^[^:]+: /, '')).join(' + ');

export interface TextContext {
  /** nombres (en inglés) de las palabras clave del título, de la ficha o del catálogo */
  kw: (t: TitleMeta) => string[] | undefined;
  countries: (t: TitleMeta) => string[];
  regionCountries: (r: RegionId) => string[];
  audience: (t: TitleMeta, id: AudienceId) => boolean | undefined; // undefined = sin datos
  publicScore: (t: TitleMeta) => number | undefined;
}
/** Evalúa una condición: true/false, o undefined si falta el dato para decidir. */
export function evalCond(c: Cond, t: TitleMeta, ctx: TextContext): boolean | undefined {
  switch (c.k) {
    case 'type': return t.type === c.v;
    case 'genre': return t.genres.some((g) => c.v.includes(g.id));
    case 'yearMin': return t.year ? t.year >= c.v : undefined;
    case 'yearMax': return t.year ? t.year <= c.v : undefined;
    case 'publicMin': { const p = ctx.publicScore(t); return p === undefined ? undefined : p >= c.v; }
    case 'audience': return ctx.audience(t, c.v);
    case 'region': { const cs = ctx.countries(t); return cs.length ? cs.some((x) => ctx.regionCountries(c.v).includes(x)) : undefined; }
    case 'country': { const cs = ctx.countries(t); return cs.length ? cs.includes(c.v) : undefined; }
    case 'theme': {
      if (c.genres && t.genres.some((g) => c.genres!.includes(g.id))) return true;
      const kw = ctx.kw(t);
      if (!kw) return undefined;
      return kw.some((n) => c.kw.includes(n.toLowerCase()));
    }
  }
}
/**
 * Regla de aplicación: include = todas las clases (en una clase, alcanza con una); dato faltante → no pasa.
 * exclude = un grupo quita el título si TODAS sus condiciones se cumplen; si falta un dato del grupo, no se quita.
 */
export function matchesText(p: ParsedText, t: TitleMeta, ctx: TextContext): boolean {
  for (const g of p.exclude) if (g.every((c) => evalCond(c, t, ctx) === true)) return false;
  const byClass = new Map<string, Cond[]>();
  for (const c of p.include) {
    const cls = c.k === 'region' || c.k === 'country' ? 'place' : c.k === 'theme' ? `theme:${c.v}` : c.k === 'yearMin' || c.k === 'yearMax' || c.k === 'publicMin' ? `${c.k}` : c.k;
    byClass.set(cls, [...(byClass.get(cls) ?? []), c]);
  }
  for (const [cls, cs] of byClass) {
    // años y nota: todas (se toma la más estricta); el resto: alcanza con una
    const ok = cls === 'yearMin' || cls === 'yearMax' || cls === 'publicMin' ? cs.every((c) => evalCond(c, t, ctx) === true) : cs.some((c) => evalCond(c, t, ctx) === true);
    if (!ok) return false;
  }
  return true;
}

/** ¿Usa datos que pueden faltar (palabras clave, público, países)? */
export const textNeeds = (p?: ParsedText) => {
  const all = [...(p?.include ?? []), ...(p?.exclude.flat() ?? [])];
  return { keywords: all.some((c) => c.k === 'theme' || c.k === 'audience'), audience: all.some((c) => c.k === 'audience'), countries: all.some((c) => c.k === 'region' || c.k === 'country') };
};
