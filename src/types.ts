// Modelo de dominio de Cine Match AI.
// La metadata (TitleMeta) está separada de la disponibilidad (AvailabilitySnapshot).

export type MediaType = 'movie' | 'tv';
/** Clave única: evita confundir película y serie homónimas (mismo id numérico en TMDB es otro título). */
export type TitleKey = `${MediaType}:${number}`;

export const titleKey = (type: MediaType, id: number): TitleKey => `${type}:${id}`;
export const parseKey = (key: TitleKey): { type: MediaType; id: number } => {
  const [type, id] = key.split(':');
  return { type: type as MediaType, id: Number(id) };
};

export interface Person { id: number; name: string; role?: string }
export interface Named { id: number; name: string }

export interface TitleMeta {
  key: TitleKey;
  type: MediaType;
  tmdbId: number;
  title: string;
  originalTitle?: string;
  year?: number;
  releaseDate?: string;
  overview?: string;
  overviewLang?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  genres: Named[];
  keywords: Named[];
  cast: Person[];
  directors: Person[]; // directores (películas) o creadores (series)
  runtime?: number; // minutos (película) o duración típica de episodio (serie)
  seasons?: { number: number; name: string; episodes?: number; airDate?: string }[];
  numberOfSeasons?: number;
  status?: string;
  originalLanguage?: string;
  originCountry?: string[];
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  /** Ids de títulos recomendados/similares según TMDB (para generar candidatos) */
  related?: TitleKey[];
  /** 'full' = ficha completa (keywords, créditos); 'basic' = sólo datos de búsqueda */
  completeness: 'basic' | 'full';
  missing: string[]; // campos que el proveedor no devolvió
  source: string;
  fetchedAt: number;
}

export type OfferKind = 'flatrate' | 'ads' | 'free' | 'rent' | 'buy';

export interface ProviderOffer {
  providerId: number;
  providerName: string;
  platform: PlatformId | null; // null = plataforma fuera de las 4 principales
  kind: OfferKind;
  logoPath?: string | null;
}

export interface AvailabilitySnapshot {
  id: string; // `${key}|${country}`
  key: TitleKey;
  country: string;
  offers: ProviderOffer[];
  /** 'ok' = el proveedor respondió; 'no-data' = respondió sin datos para el país; 'error' = falló */
  status: 'ok' | 'no-data' | 'error';
  link?: string;
  source: string; // ej. "TMDB / JustWatch"
  checkedAt: number;
  errorMessage?: string;
}

export interface AvailabilityEvent {
  id?: number;
  key: TitleKey;
  country: string;
  platform: PlatformId;
  change: 'added' | 'removed';
  /** La detección ocurre entre dos verificaciones; el proveedor no informa la fecha exacta */
  detectedAt: number;
  previousCheckAt: number;
  source: string;
}

export type PlatformId = 'netflix' | 'prime' | 'disney' | 'max';

/** Seguimiento opcional, independiente de la marca de visto y de la puntuación. */
export type ListStatus = 'want' | 'watching' | 'abandoned' | 'not_interested';

/** Estados combinados de la v1 (sólo para migrar datos y exportaciones antiguas). */
export type LegacyStatus = 'rated' | 'watched' | 'want' | 'watching' | 'abandoned' | 'not_interested';

export type DimensionId =
  | 'story'
  | 'pacing'
  | 'characters'
  | 'suspense'
  | 'originality'
  | 'emotion'
  | 'acting'
  | 'visuals'
  | 'ending';

export type DimensionScores = Partial<Record<DimensionId, number>>;

export interface SeasonRating {
  season: number;
  overall?: number;
  dimensions?: DimensionScores;
  updatedAt: number;
}

/**
 * Registro del usuario sobre un título (esquema v2).
 * `watched`, `list` y las puntuaciones son independientes entre sí.
 */
export interface Rating {
  id: string; // `${profileId}|${key}`
  profileId: string;
  key: TitleKey;
  /** Marca explícita de visto. No implica satisfacción. */
  watched: boolean;
  watchedAt?: number;
  /** Quiero verla, viéndola, abandonada o no me interesa (opcional) */
  list?: ListStatus;
  /** Valoración general 1-10, independiente de la media de dimensiones */
  overall?: number;
  /** Puntuaciones opcionales por aspecto (1-10). Ausente ≠ baja. */
  dimensions: DimensionScores;
  abandonReason?: string;
  /** Preparado para valoraciones por temporada (la UI usa la global) */
  seasons?: SeasonRating[];
  createdAt: number;
  updatedAt: number;
  schema: 2;
}

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
}

export interface ProfileSettings {
  profileId: string;
  country: string;
  platforms: PlatformId[];
  language: string;
  excludedGenres: number[];
  includeUnconfirmed: boolean;
  /** Multiplicadores ajustables por dimensión (0 a 2, 1 = neutro) */
  dimensionWeights: Partial<Record<DimensionId, number>>;
  onboarded: boolean;
}

export interface AppConfig {
  id: 'app';
  activeProfileId: string;
  /** Token de lectura de TMDB guardado sólo en este dispositivo (opcional si se usa proxy) */
  tmdbToken?: string;
  /** URL de un proxy propio que agrega la credencial del lado servidor */
  proxyUrl?: string;
}

export interface RecommendationItem {
  key: TitleKey;
  rank: number;
  score: number; // nota estimada 1-10 (no es probabilidad)
  confidence: number; // 0-1
  confidenceLabel: 'baja' | 'media' | 'alta';
  explanation: string[];
  exploration: boolean;
  provisional: boolean;
  /** Notas estimadas por aspecto (sólo donde hay evidencia) */
  dimensionEstimates?: DimensionScores;
}

export interface RecommendationRun {
  id?: number;
  profileId: string;
  algorithmVersion: string;
  createdAt: number;
  trigger: string;
  ratingsCount: number;
  country: string;
  items: RecommendationItem[];
  /** Conjunto de candidatos evaluados (permite recalcular rápido tras cada valoración) */
  pool: TitleKey[];
  /** Error del proveedor durante la generación, si lo hubo */
  warning?: string;
}

export interface ProfileSnapshot {
  id?: number;
  profileId: string;
  at: number;
  algorithmVersion: string;
  ratingsCount: number;
  mean: number;
  topFeatures: { feature: string; label: string; affinity: number }[];
}

export interface ActivityLog {
  id?: number;
  profileId: string;
  at: number;
  type: 'rating_saved' | 'rating_deleted' | 'recs_updated' | 'catalog_refresh' | 'import';
  key?: TitleKey;
  algorithmVersion?: string;
  detail?: string;
}
