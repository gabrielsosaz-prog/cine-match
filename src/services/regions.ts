/**
 * Regiones geográficas para filtrar por país de origen o producción (v3.3).
 *
 * Base: el esquema geográfico M49 de la División de Estadística de las Naciones Unidas
 * (https://unstats.un.org/unsd/methodology/m49/), con estas decisiones explícitas:
 *  - «Asia oriental», «Sudeste asiático» y «Asia meridional» son las subregiones M49 (no hay una categoría
 *    «oriental» única). Irán, que M49 ubica en Asia meridional, se cuenta en «Medio Oriente».
 *  - «Medio Oriente» no es una región M49: aquí = Asia occidental M49 sin el Cáucaso (Armenia, Azerbaiyán,
 *    Georgia) ni Chipre, más Egipto e Irán. Egipto pertenece también a «África».
 *  - «Latinoamérica» = «América Latina y el Caribe» de M49 (incluye el Caribe no hispanohablante).
 *  - «Europa», «África» y «Oceanía» = las regiones M49 (Europa incluye Rusia, Turquía no).
 *  - «Occidental» NO es geográfica: es una agrupación cultural/política sin definición universal. La lista
 *    predeterminada (Europa occidental, del norte y del sur + EE. UU., Canadá, Australia y Nueva Zelanda) es una
 *    elección documentada y cada perfil puede editarla.
 * Una región se usa sólo para expandir a países: un título pertenece a todas las regiones de sus países
 * (coproducciones incluidas). No describe ambientación ni idioma.
 */
export type RegionId = 'western' | 'east-asia' | 'south-asia' | 'southeast-asia' | 'middle-east' | 'latam' | 'europe' | 'africa' | 'oceania';

const EUROPE = 'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK';
const AFRICA = 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW';
const LATAM = 'AG AI AR AW BB BL BO BQ BR BS BZ CL CO CR CU CW DM DO EC FK GD GF GP GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI';
const OCEANIA = 'AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS';
const EAST_ASIA = 'CN HK JP KP KR MN MO TW';
const SOUTH_ASIA = 'AF BD BT IN LK MV NP PK';
const SOUTHEAST_ASIA = 'BN ID KH LA MM MY PH SG TH TL VN';
const MIDDLE_EAST = 'AE BH EG IL IQ IR JO KW LB OM PS QA SA SY TR YE';
export const DEFAULT_WESTERN = 'AD AT BE CH DE DK ES FI FR GB GR IE IS IT LI LU MC MT NL NO PT SE SM VA US CA AU NZ'.split(' ');

const split = (s: string) => s.split(' ');
export const REGIONS: { id: RegionId; name: string; note: string; countries: string[] }[] = [
  { id: 'western', name: 'Occidental', note: 'Agrupación cultural, no geográfica: lista editable (predeterminada: Europa occidental, del norte y del sur, EE. UU., Canadá, Australia y Nueva Zelanda).', countries: DEFAULT_WESTERN },
  { id: 'europe', name: 'Europa', note: 'Región M49 de la ONU (incluye Europa del Este y Rusia).', countries: split(EUROPE) },
  { id: 'latam', name: 'Latinoamérica', note: '«América Latina y el Caribe» de M49.', countries: split(LATAM) },
  { id: 'east-asia', name: 'Asia oriental', note: 'Subregión M49: China, Hong Kong, Macao, Taiwán, Japón, las dos Coreas y Mongolia.', countries: split(EAST_ASIA) },
  { id: 'southeast-asia', name: 'Sudeste asiático', note: 'Subregión M49 (Tailandia, Filipinas, Indonesia, Vietnam…).', countries: split(SOUTHEAST_ASIA) },
  { id: 'south-asia', name: 'Asia meridional', note: 'Subregión M49 sin Irán (India, Pakistán, Bangladés, Sri Lanka, Nepal…).', countries: split(SOUTH_ASIA) },
  { id: 'middle-east', name: 'Medio Oriente', note: 'Asia occidental M49 sin el Cáucaso ni Chipre, más Egipto e Irán.', countries: split(MIDDLE_EAST) },
  { id: 'africa', name: 'África', note: 'Región M49 (Egipto figura también en Medio Oriente).', countries: split(AFRICA) },
  { id: 'oceania', name: 'Oceanía', note: 'Región M49 (Australia y Nueva Zelanda figuran también en «Occidental»).', countries: split(OCEANIA) },
];
export const regionName = (id: RegionId) => REGIONS.find((r) => r.id === id)?.name ?? id;

// «Occidental» editable por perfil (se guarda en este dispositivo, no toca valoraciones)
const WKEY = (p: string) => `cine-match:western:${p}`;
let western: string[] = DEFAULT_WESTERN;
export function loadWestern(profileId: string): string[] {
  try { const raw = localStorage.getItem(WKEY(profileId)); const v = raw ? JSON.parse(raw) : null; western = Array.isArray(v) && v.every((c) => typeof c === 'string') ? v : DEFAULT_WESTERN; }
  catch { western = DEFAULT_WESTERN; }
  return western;
}
export function saveWestern(profileId: string, list: string[]) {
  western = [...new Set(list)];
  try { localStorage.setItem(WKEY(profileId), JSON.stringify(western)); } catch { /* sin almacenamiento */ }
}
export const currentWestern = () => western;

export function regionCountries(id: RegionId): string[] {
  if (id === 'western') return western;
  return REGIONS.find((r) => r.id === id)?.countries ?? [];
}
/** Regiones a las que pertenece un país (puede ser más de una). */
export const regionsOfCountry = (code: string): RegionId[] => REGIONS.filter((r) => regionCountries(r.id).includes(code)).map((r) => r.id);
/** Expande regiones a países (sin repetidos). */
export const expandRegions = (ids: RegionId[] = []): string[] => [...new Set(ids.flatMap(regionCountries))];
