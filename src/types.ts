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

export interface Person {
  id: number; name: string; role?: string;
  /** Orden de aparición en los créditos de TMDB (0 = protagonista) */
  order?: number;
  /** Series: episodios en los que participó (TMDB aggregate_credits) */
  episodes?: number;
}
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
  /** Guion / autoría (TMDB crew, departamento «Writing»). v3.0 */
  writers?: Person[];
  runtime?: number; // minutos (película) o duración típica de episodio (serie)
  seasons?: { number: number; name: string; episodes?: number; airDate?: string }[];
  numberOfSeasons?: number;
  status?: string;
  originalLanguage?: string;
  originCountry?: string[];
  /** Películas: países de producción (pueden ser varios en coproducciones). v3.1 */
  productionCountries?: string[];
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  /** Saga o colección de TMDB (belongs_to_collection; sólo películas) */
  collection?: Named;
  /** Series: total de episodios (para medir la participación real de cada actor) */
  totalEpisodes?: number;
  /** Versión del mapeo de la ficha (2 = incluye colección y participación del reparto) */
  metaVersion?: number;
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

export type PlatformId = 'netflix' | 'prime' | 'disney' | 'max' | 'paramount';

/** Seguimiento opcional, independiente de la marca de visto, la puntuación y «No me interesa». */
export type ListStatus = 'want' | 'watching' | 'abandoned';

/** Estados combinados de la v1 (sólo para migrar datos y exportaciones antiguas). */
export type LegacyStatus = 'rated' | 'watched' | 'want' | 'watching' | 'abandoned' | 'not_interested';

/** Los siete aspectos de la v2.1 (Personajes y Originalidad se retiraron; sus datos quedan en `legacy`). */
export type DimensionId = 'story' | 'acting' | 'ending' | 'emotion' | 'visuals' | 'pacing' | 'suspense';

/** Estrellas 1-5 por aspecto. Ausente = sin valorar (no es una nota baja). */
export type DimensionScores = Partial<Record<DimensionId, number>>;

/** Respaldo de datos anteriores a la v2.1, para recuperación. El motor no lo usa. */
export interface LegacyRatingData {
  /** Aspectos originales en escala 1-10 (incluye Personajes y Originalidad) */
  dimensions10?: Record<string, number>;
  /** Esquema del que se migró */
  fromSchema: number;
  migratedAt: number;
  /** Estado combinado de la v1, si existía */
  status?: string;
}

export interface SeasonRating {
  season: number;
  overall?: number;
  dimensions?: DimensionScores;
  updatedAt: number;
}

/**
 * Registro del usuario sobre un título (esquema v3, Cine Match v2.1).
 * `watched`, `list`, `notInterested`, la nota general, los aspectos y el comentario son independientes.
 */
export interface Rating {
  id: string; // `${profileId}|${key}`
  profileId: string;
  key: TitleKey;
  /** Marca explícita de visto. No implica satisfacción. */
  watched: boolean;
  watchedAt?: number;
  /** Quiero verla, viéndola o abandonada (opcional) */
  list?: ListStatus;
  /** «No me interesa»: descarte sin haberla visto. No es una valoración negativa. */
  notInterested?: boolean;
  notInterestedAt?: number;
  /** Valoración general 1-10, independiente de las estrellas */
  overall?: number;
  /** Estrellas opcionales por aspecto (1-5). Ausente ≠ baja. */
  dimensions: DimensionScores;
  /** Campo libre «Otros: ¿Qué te gustó o no te gustó?». Se guarda y analiza sólo en el dispositivo. */
  comment?: string;
  /** Datos de versiones anteriores conservados para recuperación (no se usan en el ranking) */
  legacy?: LegacyRatingData;
  abandonReason?: string;
  /** Preparado para valoraciones por temporada (la UI usa la global) */
  seasons?: SeasonRating[];
  createdAt: number;
  updatedAt: number;
  schema: 3;
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
  /** Ajuste aplicado por descartes («No me interesa») de títulos relacionados (≤ 0) */
  rejectionPenalty?: number;
  provisional: boolean;
  /** Notas estimadas por aspecto (sólo donde hay evidencia) */
  dimensionEstimates?: DimensionScores;
  /** v3.0: aporte de cada canal del motor (diagnóstico; puntos sobre tu media) */
  channels?: ChannelContribution[];
  /** v3.0: tu media al momento del cálculo (base de la estimación) */
  base?: number;
  /** v3.0: candidato incorporado por búsqueda extra en TMDB con poca evidencia propia */
  lowEvidence?: boolean;
}

export type ChannelId = 'theme' | 'comments' | 'aspects' | 'actors' | 'crew' | 'narrative' | 'similar' | 'genre' | 'format' | 'rejection' | 'quality';
export interface ChannelContribution { id: ChannelId; value: number; weight: number; contribution: number; evidence: number }

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
  /** Candidatos con disponibilidad confirmada en tus plataformas (base de los filtros avanzados) */
  eligible?: TitleKey[];
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
