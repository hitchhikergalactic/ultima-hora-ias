// idioma: 'es' | 'en'. La página muestra primero las fuentes en español.
// userAgent (opcional): algunos sitios rechazan el UA por defecto de
// rss-parser o el de un navegador (ver comentarios en cada fuente).
export const feeds = [
  // Prensa en español (general y tecnológica; se filtra después por relevancia para AI safety)
  { name: 'Xataka IA', idioma: 'es', url: 'https://www.xataka.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'Genbeta IA', idioma: 'es', url: 'https://www.genbeta.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'El País Tecnología', idioma: 'es', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada' },
  { name: 'BBC Mundo', idioma: 'es', url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
  // Euronews devuelve 406 a los UA de navegador; con el UA por defecto de rss-parser responde bien.
  { name: 'Euronews Next', idioma: 'es', url: 'https://es.euronews.com/rss?level=vertical&name=next' },

  // Prensa tecnológica general en inglés (se filtra después por relevancia para AI safety)
  { name: 'TechCrunch AI', idioma: 'en', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  // VentureBeat responde 429 al UA de rss-parser y al de navegador; con este UA sí sirve el feed.
  { name: 'VentureBeat AI', idioma: 'en', url: 'https://venturebeat.com/category/ai/feed', userAgent: 'Feedly/1.0' },
  { name: 'Wired AI', idioma: 'en', url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  { name: 'MIT Technology Review', idioma: 'en', url: 'https://www.technologyreview.com/feed/' },
  { name: 'The Verge AI', idioma: 'en', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },

  // Laboratorios de IA
  { name: 'OpenAI News', idioma: 'en', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google DeepMind Blog', idioma: 'en', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Google AI Blog', idioma: 'en', url: 'https://blog.google/technology/ai/rss/' },

  // Investigación y organizaciones especializadas en AI safety
  { name: 'AI Safety Newsletter (CAIS)', idioma: 'en', url: 'https://newsletter.safe.ai/feed' },
  { name: 'Future of Life Institute', idioma: 'en', url: 'https://futureoflife.org/feed/' },
  { name: 'Transformer', idioma: 'en', url: 'https://www.transformernews.ai/feed' },
  { name: 'Import AI', idioma: 'en', url: 'https://jack-clark.net/feed/' },
];
