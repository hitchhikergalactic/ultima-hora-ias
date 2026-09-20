// Única configuración de fuentes. Cada una lleva nombre, url y categoría.
//
// Categorías:
//   laboratorio  Feeds oficiales de laboratorios y búsquedas de Google News sobre
//                ellos. Pasan SIN filtro.
//   seguridad    Organizaciones de seguridad y gobernanza de la IA. Pasan SIN filtro.
//   boletin      Boletines y Substacks de seguridad de la IA. Pasan SIN filtro.
//   prensa       Prensa generalista. Es la única que pasa por la lista de palabras
//                clave (ver pipeline.js).
//
// Otros campos:
//   idioma:       'es' | 'en'. Solo se traduce lo que no está en español.
//   laboratorio:  laboratorio al que se refiere la fuente (para la tabla por
//                 laboratorio de scripts/verificar.mjs).
//   googleNews:   la fuente es una búsqueda de Google News. Los titulares traen el
//                 medio al final ("... - Reuters"): ese medio es el que se muestra
//                 ("vía"), no el laboratorio.
//   userAgent:    algunos sitios rechazan el user agent por defecto de rss-parser.
//
// Comprobado con peticiones reales: Anthropic, Meta AI, xAI, Moonshot y DeepSeek no
// tienen RSS oficial de noticias (404, feeds vacíos o desactualizados), y tampoco
// GovAI, Apollo Research ni el AI Security Institute (404 o XML no válido), así que
// usan Google News. Las búsquedas de laboratorios incluyen términos de seguridad
// para que Google News devuelva noticias de seguridad y no de producto.

// Búsqueda de Google News (RSS) de los últimos 14 días; la publicación recorta a 7.
const googleNews = (consulta) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${consulta} when:14d`)}&hl=en-US&gl=US&ceid=US:en`;
const SEGURIDAD = '(safety OR alignment OR risk OR regulation OR security)';

export const feeds = [
  // --- Laboratorios: feeds oficiales ---
  { name: 'OpenAI News', categoria: 'laboratorio', laboratorio: 'OpenAI', idioma: 'en', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google DeepMind Blog', categoria: 'laboratorio', laboratorio: 'Google DeepMind', idioma: 'en', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'Mistral AI', categoria: 'laboratorio', laboratorio: 'Mistral', idioma: 'en', url: 'https://mistral.ai/rss.xml' },

  // --- Laboratorios: Google News por búsqueda ---
  { name: 'Anthropic (Google News)', categoria: 'laboratorio', laboratorio: 'Anthropic', idioma: 'en', googleNews: true, url: googleNews(`Anthropic ${SEGURIDAD}`) },
  { name: 'OpenAI (Google News)', categoria: 'laboratorio', laboratorio: 'OpenAI', idioma: 'en', googleNews: true, url: googleNews(`OpenAI ${SEGURIDAD}`) },
  { name: 'Google DeepMind (Google News)', categoria: 'laboratorio', laboratorio: 'Google DeepMind', idioma: 'en', googleNews: true, url: googleNews(`"Google DeepMind" ${SEGURIDAD}`) },
  { name: 'Meta AI (Google News)', categoria: 'laboratorio', laboratorio: 'Meta', idioma: 'en', googleNews: true, url: googleNews(`"Meta AI" ${SEGURIDAD}`) },
  { name: 'xAI (Google News)', categoria: 'laboratorio', laboratorio: 'xAI', idioma: 'en', googleNews: true, url: googleNews(`(xAI OR Grok) ${SEGURIDAD}`) },
  { name: 'Moonshot (Google News)', categoria: 'laboratorio', laboratorio: 'Moonshot', idioma: 'en', googleNews: true, url: googleNews(`("Moonshot AI" OR "Kimi K2") ${SEGURIDAD}`) },
  { name: 'DeepSeek (Google News)', categoria: 'laboratorio', laboratorio: 'DeepSeek', idioma: 'en', googleNews: true, url: googleNews(`DeepSeek ${SEGURIDAD}`) },

  // --- Seguridad y gobernanza ---
  { name: 'METR', categoria: 'seguridad', idioma: 'en', url: 'https://metr.org/feed.xml' },
  // Epoch, Toner y Brundage solo publican en substack.com, que devuelve 403 al runner de
  // GitHub con cualquier user agent: se sustituyen por búsquedas de Google News.
  { name: 'Epoch AI (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('"Epoch AI"') },
  { name: 'Alignment Forum', categoria: 'seguridad', idioma: 'en', url: 'https://www.alignmentforum.org/feed.xml' },
  { name: 'LessWrong', categoria: 'seguridad', idioma: 'en', url: 'https://www.lesswrong.com/feed.xml' },
  { name: 'Future of Life Institute', categoria: 'seguridad', idioma: 'en', url: 'https://futureoflife.org/feed/' },
  { name: 'MIRI', categoria: 'seguridad', idioma: 'en', url: 'https://intelligence.org/feed/' },
  { name: 'Redwood Research', categoria: 'seguridad', idioma: 'en', url: 'https://blog.redwoodresearch.org/feed' },
  { name: 'CSET (Georgetown)', categoria: 'seguridad', idioma: 'en', url: 'https://cset.georgetown.edu/feed/' },
  { name: 'Helen Toner (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('"Helen Toner" AI') },
  { name: 'Miles Brundage (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('"Miles Brundage"') },
  { name: 'GovAI (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('("GovAI" OR "Centre for the Governance of AI")') },
  { name: 'Apollo Research (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('"Apollo Research" AI') },
  { name: 'AI Security Institute (Google News)', categoria: 'seguridad', idioma: 'en', googleNews: true, url: googleNews('("AI Security Institute" OR "AI Safety Institute") AI') },

  // --- Boletines y Substacks ---
  { name: 'AI Safety Newsletter (CAIS)', categoria: 'boletin', idioma: 'en', url: 'https://newsletter.safe.ai/feed' },
  { name: 'Import AI', categoria: 'boletin', idioma: 'en', url: 'https://jack-clark.net/feed/' },
  // Zvi: el feed de substack.com da 403 desde el runner; su espejo de WordPress publica lo mismo.
  { name: "Zvi (Don't Worry About the Vase)", categoria: 'boletin', idioma: 'en', url: 'https://thezvi.wordpress.com/feed/' },
  { name: 'Transformer', categoria: 'boletin', idioma: 'en', url: 'https://www.transformernews.ai/feed' },
  { name: 'ML Safety Newsletter', categoria: 'boletin', idioma: 'en', url: 'https://newsletter.mlsafety.org/feed' },
  { name: 'AI Snake Oil', categoria: 'boletin', idioma: 'en', url: 'https://www.aisnakeoil.com/feed' },

  // --- Prensa ---
  { name: 'The Guardian AI', categoria: 'prensa', idioma: 'en', url: 'https://www.theguardian.com/technology/artificialintelligenceai/rss' },
  { name: 'Wired AI', categoria: 'prensa', idioma: 'en', url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  // NYT y FT tienen muro de pago: solo llega titular y resumen.
  { name: 'The New York Times', categoria: 'prensa', idioma: 'en', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
  { name: 'Financial Times AI', categoria: 'prensa', idioma: 'en', url: 'https://www.ft.com/artificial-intelligence?format=rss' },
  { name: 'Politico Tech', categoria: 'prensa', idioma: 'en', url: 'https://rss.politico.com/technology.xml' },
  { name: 'TechCrunch AI', categoria: 'prensa', idioma: 'en', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'MIT Technology Review', categoria: 'prensa', idioma: 'en', url: 'https://www.technologyreview.com/feed/' },
  { name: 'El País Tecnología', categoria: 'prensa', idioma: 'es', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada' },
  // Euronews devuelve 406 a los user agents de navegador; con el de rss-parser responde bien.
  { name: 'Euronews Next', categoria: 'prensa', idioma: 'es', url: 'https://es.euronews.com/rss?level=vertical&name=next' },
  { name: 'Xataka IA', categoria: 'prensa', idioma: 'es', url: 'https://www.xataka.com/tag/inteligencia-artificial/rss2.xml' },
  { name: 'BBC Mundo', categoria: 'prensa', idioma: 'es', url: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
];
