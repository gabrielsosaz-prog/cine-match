// Traducciones de palabras clave frecuentes de TMDB (que se publican en inglés).
export const KEYWORD_ES: Record<string, string> = {
  'based on novel or book': 'basada en un libro', 'based on true story': 'basada en hechos reales', 'murder': 'asesinatos',
  'investigation': 'investigación', 'detective': 'detectives', 'serial killer': 'asesinos seriales', 'time travel': 'viajes en el tiempo',
  'dystopia': 'distopía', 'friendship': 'amistad', 'family': 'familia', 'revenge': 'venganza', 'love': 'amor', 'romance': 'romance',
  'small town': 'pueblo chico', 'police': 'policías', 'mystery': 'misterio', 'conspiracy': 'conspiraciones', 'superhero': 'superhéroes',
  'based on comic': 'basada en cómic', 'space': 'espacio', 'artificial intelligence': 'inteligencia artificial', 'heist': 'golpes y robos',
  'drug trafficking': 'narcotráfico', 'mafia': 'mafia', 'politics': 'política', 'war': 'guerra', 'world war ii': 'Segunda Guerra Mundial',
  'coming of age': 'crecer y madurar', 'high school': 'secundaria', 'dark comedy': 'comedia negra', 'satire': 'sátira', 'parody': 'parodia',
  'psychological thriller': 'thriller psicológico', 'psychological': 'psicológico', 'supernatural': 'sobrenatural', 'ghost': 'fantasmas',
  'zombie': 'zombis', 'vampire': 'vampiros', 'magic': 'magia', 'dragon': 'dragones', 'post-apocalyptic future': 'postapocalíptico',
  'survival': 'supervivencia', 'biography': 'biografía', 'sports': 'deporte', 'music': 'música', 'musical': 'musical', 'lawyer': 'abogados',
  'courtroom': 'juicios', 'hospital': 'hospitales', 'doctor': 'médicos', 'prison': 'cárcel', 'corruption': 'corrupción', 'spy': 'espionaje',
  'espionage': 'espionaje', 'cold war': 'Guerra Fría', 'alien': 'extraterrestres', 'robot': 'robots', 'dark fantasy': 'fantasía oscura',
  'anime': 'anime', 'based on manga': 'basada en manga', 'sitcom': 'sitcom', 'mockumentary': 'falso documental', 'workplace comedy': 'comedia de oficina',
  'teenager': 'adolescentes', 'nonlinear timeline': 'línea temporal no lineal', 'parallel world': 'mundos paralelos', 'multiple storylines': 'historias cruzadas',
  'anthology': 'antología', 'miniseries': 'miniserie', 'period drama': 'drama de época', 'historical': 'histórica', 'royal family': 'realeza',
  'medieval': 'medieval', 'kingdom': 'reinos', 'road trip': 'viaje en ruta', 'neo-noir': 'neo-noir', 'noir': 'cine negro', 'hacker': 'hackers',
  'cyberpunk': 'cyberpunk', 'social commentary': 'crítica social', 'class differences': 'diferencias de clase', 'female protagonist': 'protagonista femenina',
  'gangster': 'gánsteres', 'cartel': 'cárteles', 'kidnapping': 'secuestros', 'missing person': 'desapariciones', 'cult': 'sectas', 'religion': 'religión',
  'philosophy': 'filosofía', 'existentialism': 'existencialismo', 'grief': 'duelo', 'mental illness': 'salud mental', 'addiction': 'adicciones',
  'loneliness': 'soledad', 'marriage': 'matrimonio', 'father son relationship': 'relación padre-hijo', 'mother daughter relationship': 'relación madre-hija',
  'buenos aires, argentina': 'Buenos Aires', 'argentina': 'Argentina', 'animation': 'animación', 'pixar': 'Pixar', 'christmas': 'Navidad',
  'martial arts': 'artes marciales', 'samurai': 'samuráis', 'western': 'western', 'cowboy': 'vaqueros', 'monster': 'monstruos', 'slasher': 'slasher',
  'found footage': 'metraje encontrado', 'haunted house': 'casas embrujadas', 'possession': 'posesiones', 'witch': 'brujas', 'game': 'juegos',
  'competition': 'competencias', 'reality': 'realidad', 'cooking': 'cocina', 'journalism': 'periodismo', 'business': 'negocios', 'wealth': 'riqueza',
  'power': 'poder', 'betrayal': 'traiciones', 'secret': 'secretos', 'lgbt': 'LGBT', 'feel-good': 'para sentirse bien', 'quirky': 'excéntrica',
};

/** Palabras clave que pueden revelar giros o desenlaces: nunca se usan en explicaciones. */
export const SPOILER_PATTERN = /twist|ending|death of|dies|killed|reveal|suicide|secret identity|betrayal|pregnan|cliffhanger|dead|murder of|final battle|sacrifice|resurrection/i;

export function keywordLabel(name: string) {
  return KEYWORD_ES[name.toLowerCase()] ?? name;
}
