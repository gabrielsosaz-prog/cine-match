/**
 * Coincidencias débiles: atributos frecuentes o poco narrativos (géneros amplios, «basada en un libro»,
 * lugares geográficos, etiquetas técnicas). Pueden mencionarse como información secundaria, pero no
 * justifican por sí solas una similitud alta.
 */
import FACETS from './facets.json';

const WEAK = new Set(FACETS.weakKeywords.map((s) => s.toLowerCase()));

const US_STATES = 'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington wisconsin wyoming'.split(' ');
const PLACES = `new york city|new york|los angeles|san francisco|chicago|boston|miami|las vegas|new orleans|seattle|washington d.c.|london|england|scotland|wales|ireland|paris|france|rome|italy|sicily|palermo|venice|florence|milan|naples|tuscany|amalfi coast|capri|sardinia|lake como|spain|madrid|barcelona|seville|ibiza|mallorca|majorca|canary islands|portugal|lisbon|germany|berlin|munich|amsterdam|netherlands|belgium|brussels|switzerland|austria|vienna|greece|athens|crete|mykonos|turkey|istanbul|sweden|stockholm|norway|oslo|denmark|copenhagen|finland|iceland|russia|moscow|poland|warsaw|prague|czech republic|hungary|budapest|mexico|mexico city|cancun|tulum|argentina|buenos aires|brazil|rio de janeiro|são paulo|sao paulo|colombia|bogotá|bogota|medellín|medellin|chile|santiago|peru|lima|cuba|havana|caribbean|puerto rico|jamaica|bahamas|canada|toronto|vancouver|montreal|japan|tokyo|kyoto|osaka|south korea|korea|seoul|busan|china|beijing|shanghai|hong kong|taiwan|thailand|bangkok|phuket|koh samui|vietnam|india|mumbai|indonesia|bali|philippines|singapore|malaysia|australia|sydney|melbourne|new zealand|egypt|cairo|morocco|marrakech|south africa|kenya|nigeria|israel|jerusalem|iran|iraq|afghanistan|dubai|united arab emirates|saudi arabia|maldives|tahiti|fiji|polynesia|maui|honolulu|oahu|tropical island|europe|asia|africa|latin america|south america|middle east|scandinavia|mediterranean|riviera|french riviera|côte d'azur|monaco|patagonia|alps|texas border`.split('|');
let geo: Set<string> | undefined;
function geoSet(): Set<string> {
  if (geo) return geo;
  geo = new Set([...US_STATES, ...PLACES]);
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const n = dn.of(code);
      if (n && n !== code) geo.add(n.toLowerCase());
    }
  } catch { /* entorno sin Intl.DisplayNames: queda la lista fija */ }
  return geo;
}

export type WeakKind = 'geo' | 'generic' | 'era' | undefined;

/** Clasifica una palabra clave de TMDB (nombre en inglés). undefined = específica. */
export function weakKind(name: string): WeakKind {
  const n = name.toLowerCase().trim();
  // «sicily, italy», «paris, france»: lugar compuesto
  if (n.includes(',')) { const parts = n.split(',').map((x) => x.trim()).filter(Boolean); if (parts.length > 1 && parts.every((x) => weakKind(x) === 'geo')) return 'geo'; }
  if (geoSet().has(n) || /\b(city|county|province|island|islands|archipelago|coast|countryside)$/.test(n) && geoSet().has(n.replace(/\s+(city|county|province|island|islands|archipelago|coast|countryside)$/, ''))) return 'geo';
  if (/^\d{4}s$|^\d{2}(st|nd|rd|th) century$|^(19|20)\d\d$/.test(n)) return 'era';
  if (WEAK.has(n)) return 'generic';
  return undefined;
}

/** Peso multiplicativo de una palabra clave según su tipo. */
export const weakFactor = (k: WeakKind) => (k === 'geo' ? 0.05 : k === 'era' ? 0.05 : k === 'generic' ? 0.12 : 1);
