// Campos de cada fuente:
//   idioma:      'es' | 'en'. La página muestra primero las fuentes en español.
//   categoria:   'laboratorio' | 'seguridad' | 'prensa'.
//                - laboratorio: blog oficial de un laboratorio, o (si no tiene
//                  RSS oficial) la búsqueda de Google News sobre ese
//                  laboratorio + términos de seguridad.
//                - seguridad: organizaciones y boletines de AI safety y gobernanza.
//                - prensa: medios generalistas y tecnológicos. Son como máximo el
//                  50% de la lista (ver reglas.js).
//   laboratorio: (opcional) laboratorio al que se refiere la fuente. Cuenta para
//                la regla de "al menos una noticia por laboratorio".
//   semanal:     (opcional) boletín semanal. Va en su propio bloque de la página,
//                fuera del corte por fechas: solo se conserva el último número.
//   prioridad:   1 = fuente original, 2 = prensa de referencia, 3 = prensa
//                general o cobertura de terceros. En caso de empate entre dos
//                noticias del mismo hecho, gana la de menor número.
//   googleNews:  (opcional) el feed es una búsqueda de Google News: los titulares
//                traen el medio al final ("... - Reuters") y se separa como
//                `publicador`.
//   terminos:    (solo con googleNews) palabras que debe nombrar el TITULAR para
//                que la noticia cuente como del laboratorio. Google News
//                devuelve también artículos que solo lo mencionan de pasada; si
//                el titular no lo nombra la noticia pasa a prensa generalista.
//   userAgent:   (opcional) algunos sitios rechazan el UA por defecto de
//                rss-parser o el de un navegador (ver comentarios).

// Búsqueda de Google News (RSS) de los últimos 14 días. Anthropic, Meta, xAI,
// Moonshot y DeepSeek no tienen RSS oficial de noticias: se comprobó con
// peticiones reales (404, feeds vacíos o desactualizados).
const googleNews = (consulta) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${consulta} when:14d`)}&hl=en-US&gl=US&ceid=US:en`;
const TERMINOS_SEGURIDAD = '(safety OR alignment OR risk OR regulation OR security)';

export const feeds = [
  // --- Laboratorios: RSS oficial ---
  { name: 'OpenAI News', idioma: 'en', categoria: 'laboratorio', laboratorio: 'OpenAI', prioridad: 1, url: 'https://openai.com/news/rss.xml' },
  { name: 'Google DeepMind Blog', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Google DeepMind', prioridad: 1, url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Google AI Blog', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Google DeepMind', prioridad: 1, url: 'https://blog.google/technology/ai/rss/' },
  { name: 'Mistral AI', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Mistral', prioridad: 1, url: 'https://mistral.ai/rss.xml' },

  // --- Laboratorios sin RSS oficial: Google News ---
  { name: 'Anthropic (Google News)', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Anthropic', prioridad: 3, googleNews: true, terminos: ['Anthropic', 'Claude'], url: googleNews(`Anthropic AI ${TERMINOS_SEGURIDAD}`) },
  { name: 'Meta AI (Google News)', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Meta', prioridad: 3, googleNews: true, terminos: ['Meta', 'Llama', 'Zuckerberg'], url: googleNews(`"Meta AI" ${TERMINOS_SEGURIDAD}`) },
  { name: 'xAI (Google News)', idioma: 'en', categoria: 'laboratorio', laboratorio: 'xAI', prioridad: 3, googleNews: true, terminos: ['xAI', 'Grok'], url: googleNews(`xAI Grok ${TERMINOS_SEGURIDAD}`) },
  { name: 'Moonshot (Google News)', idioma: 'en', categoria: 'laboratorio', laboratorio: 'Moonshot', prioridad: 3, googleNews: true, terminos: ['Moonshot', 'Kimi'], url: googleNews(`Moonshot AI Kimi ${TERMINOS_SEGURIDAD}`) },
  { name: 'DeepSeek (Google News)', idioma: 'en', categoria: 'laboratorio', laboratorio: 'DeepSeek', prioridad: 3, googleNews: true, terminos: ['DeepSeek'], url: googleNews(`DeepSeek ${TERMINOS_SEGURIDAD}`) },

  // --- Seguridad y gobernanza ---
  { name: 'AI Safety Newsletter (CAIS)', idioma: 'en', categoria: 'seguridad', semanal: true, prioridad: 1, url: 'https://newsletter.safe.ai/feed' },
  { name: 'Import AI', idioma: 'en', categoria: 'seguridad', semanal: true, prioridad: 1, url: 'https://jack-clark.net/feed/' },
  { name: 'Future of Life Institute', idioma: 'en', categoria: 'seguridad', prioridad: 1, url: 'https://futureoflife.org/feed/' },
  { name: 'Transformer', idioma: 'en', categoria: 'seguridad', prioridad: 1, url: 'https://www.transformernews.ai/feed' },

  // --- Prensa en español ---
  { name: 'Xataka IA', idioma: 'es', categoria: 'prensa', prioridad: 3, url: 'https://www.xataka.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'Genbeta IA', idioma: 'es', categoria: 'prensa', prioridad: 3, url: 'https://www.genbeta.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'El País Tecnología', idioma: 'es', categoria: 'prensa', prioridad: 2, url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada' },
  { name: 'BBC Mundo', idioma: 'es', categoria: 'prensa', prioridad: 2, url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  // Euronews devuelve 406 a los UA de navegador; con el UA por defecto de rss-parser responde bien.
  { name: 'Euronews Next', idioma: 'es', categoria: 'prensa', prioridad: 3, url: 'https://es.euronews.com/rss?level=vertical&name=next' },

  // --- Prensa de referencia internacional (NYT y FT tienen muro de pago: solo llega titular y resumen) ---
  { name: 'The New York Times', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
  { name: 'The Guardian AI', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://www.theguardian.com/technology/artificialintelligenceai/rss' },
  { name: 'Financial Times AI', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://www.ft.com/artificial-intelligence?format=rss' },
  { name: 'Politico Tech', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://rss.politico.com/technology.xml' },
  { name: 'MIT Technology Review', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://www.technologyreview.com/feed/' },
  { name: 'Wired AI', idioma: 'en', categoria: 'prensa', prioridad: 2, url: 'https://www.wired.com/feed/tag/ai/latest/rss' },

  // --- Prensa tecnológica general en inglés ---
  { name: 'TechCrunch AI', idioma: 'en', categoria: 'prensa', prioridad: 3, url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  // VentureBeat responde 429 al UA de rss-parser y al de navegador; con este UA sí sirve el feed.
  { name: 'VentureBeat AI', idioma: 'en', categoria: 'prensa', prioridad: 3, url: 'https://venturebeat.com/category/ai/feed', userAgent: 'Feedly/1.0' },
  { name: 'The Verge AI', idioma: 'en', categoria: 'prensa', prioridad: 3, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
];
