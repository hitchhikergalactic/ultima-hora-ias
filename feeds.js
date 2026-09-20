// idioma: 'es' | 'en'. La página muestra primero las fuentes en español.
// prioridad: 1 = fuente original (laboratorios y organizaciones de AI safety),
// 2 = prensa de referencia, 3 = prensa tecnológica general. Si varias fuentes
// cuentan la misma historia, se conserva la de menor número.
// maxPorDia (opcional): tope de noticias que se conservan de esa fuente tras
// filtrar. Se pone a la prensa general, que publica mucho y de la que solo una
// parte es AI safety. Las fuentes especializadas no llevan tope.
// userAgent (opcional): algunos sitios rechazan el UA por defecto de
// rss-parser o el de un navegador (ver comentarios en cada fuente).
export const feeds = [
  // Prensa en español (general y tecnológica; se filtra después por relevancia para AI safety)
  { name: 'Xataka IA', idioma: 'es', prioridad: 3, maxPorDia: 3, url: 'https://www.xataka.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'Genbeta IA', idioma: 'es', prioridad: 3, maxPorDia: 3, url: 'https://www.genbeta.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'El País Tecnología', idioma: 'es', prioridad: 2, maxPorDia: 3, url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada' },
  { name: 'BBC Mundo', idioma: 'es', prioridad: 2, maxPorDia: 3, url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  // Euronews devuelve 406 a los UA de navegador; con el UA por defecto de rss-parser responde bien.
  { name: 'Euronews Next', idioma: 'es', prioridad: 3, maxPorDia: 3, url: 'https://es.euronews.com/rss?level=vertical&name=next' },

  // Prensa de referencia internacional (NYT y FT tienen muro de pago: solo llega titular y resumen)
  { name: 'The New York Times', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
  { name: 'The Guardian AI', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://www.theguardian.com/technology/artificialintelligenceai/rss' },
  { name: 'Financial Times AI', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://www.ft.com/artificial-intelligence?format=rss' },
  { name: 'Politico Tech', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://rss.politico.com/technology.xml' },

  // Prensa tecnológica general en inglés (se filtra después por relevancia para AI safety)
  { name: 'TechCrunch AI', idioma: 'en', prioridad: 3, maxPorDia: 3, url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  // VentureBeat responde 429 al UA de rss-parser y al de navegador; con este UA sí sirve el feed.
  { name: 'VentureBeat AI', idioma: 'en', prioridad: 3, maxPorDia: 3, url: 'https://venturebeat.com/category/ai/feed', userAgent: 'Feedly/1.0' },
  { name: 'Wired AI', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  { name: 'MIT Technology Review', idioma: 'en', prioridad: 2, maxPorDia: 3, url: 'https://www.technologyreview.com/feed/' },
  { name: 'The Verge AI', idioma: 'en', prioridad: 3, maxPorDia: 3, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },

  // Laboratorios de IA
  { name: 'OpenAI News', idioma: 'en', prioridad: 1, url: 'https://openai.com/news/rss.xml' },
  { name: 'Google DeepMind Blog', idioma: 'en', prioridad: 1, url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Google AI Blog', idioma: 'en', prioridad: 1, url: 'https://blog.google/technology/ai/rss/' },

  // Investigación y organizaciones especializadas en AI safety
  { name: 'AI Safety Newsletter (CAIS)', idioma: 'en', prioridad: 1, url: 'https://newsletter.safe.ai/feed' },
  { name: 'Future of Life Institute', idioma: 'en', prioridad: 1, url: 'https://futureoflife.org/feed/' },
  { name: 'Transformer', idioma: 'en', prioridad: 1, url: 'https://www.transformernews.ai/feed' },
  { name: 'Import AI', idioma: 'en', prioridad: 1, url: 'https://jack-clark.net/feed/' },
];
