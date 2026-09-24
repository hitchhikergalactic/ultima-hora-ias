// Lógica pura del pipeline (sin red ni API), para poder probarla con datos guardados.
//
// Diseño: NINGÚN modelo decide qué se publica.
//   - Laboratorios, seguridad y gobernanza y boletines pasan SIN filtro.
//   - La prensa pasa por una lista de palabras clave (abajo).
//   - Solo se descartan duplicados exactos (misma URL o mismo título normalizado).
//   - Se publica todo lo recibido de los últimos 7 días, por fecha descendente.

export const VENTANA_DIAS = 7;
export const MAX_RESUMEN_CHARS = 600;

export const CATEGORIAS = {
  laboratorio: 'Laboratorios',
  seguridad: 'Seguridad y gobernanza',
  boletin: 'Boletines',
  prensa: 'Prensa',
};

const DIA_MS = 24 * 60 * 60 * 1000;
const ms = (fecha) => new Date(fecha).getTime();

// ---------------------------------------------------------------------------
// Normalización de lo que entrega rss-parser
// ---------------------------------------------------------------------------

// rss-parser solo quita las etiquetas al generar el texto plano; algunos feeds
// (LessWrong, Alignment Forum) incrustan CSS de MathJax que quedaría suelto.
export function limpiarHTML(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convierte un ítem de rss-parser en una noticia. `fecha` queda en ISO, o vacía si
// el feed no trae una fecha válida (esa noticia no se publica y se cuenta aparte).
export function normalizarItem(feed, item) {
  let titulo = (item.title ?? '').trim();
  let publicador;
  if (feed.googleNews) {
    // Google News añade el medio al final del titular: "... - Reuters".
    publicador = (typeof item.source === 'string' ? item.source : item.source?._)?.trim();
    if (publicador && titulo.endsWith(` - ${publicador}`)) {
      titulo = titulo.slice(0, -(publicador.length + 3));
    }
  }
  const instante = new Date(item.isoDate ?? item.pubDate ?? '').getTime();
  return {
    fuente: feed.name,
    medio: publicador || feed.name,
    categoria: feed.categoria,
    ...(feed.laboratorio ? { laboratorio: feed.laboratorio } : {}),
    idioma: feed.idioma,
    titulo,
    // El resumen de Google News solo repite el titular y el medio: no aporta.
    resumen: feed.googleNews
      ? ''
      : limpiarHTML(item.content ?? item.summary ?? item.contentSnippet ?? '').slice(0, MAX_RESUMEN_CHARS),
    enlace: item.link ?? '',
    fecha: Number.isNaN(instante) ? '' : new Date(instante).toISOString(),
    ...(publicador ? { publicador } : {}),
  };
}

// ---------------------------------------------------------------------------
// Filtro de la prensa generalista
// ---------------------------------------------------------------------------

// \b no entiende las letras acentuadas: se usan límites Unicode.
const palabras = (alternativas) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternativas.join('|')})(?![\\p{L}\\p{N}])`, 'iu');

// Nombres de laboratorios y de modelos: pasan por sí solos.
const LABORATORIOS_Y_MODELOS = palabras([
  'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'GPT-?\\d[\\w.-]*', 'Sora', 'Gemini', 'DeepMind',
  'Meta AI', 'Llama', 'xAI', 'Grok', 'Moonshot', 'Kimi', 'DeepSeek', 'Mistral', 'Copilot',
]);

// Contexto de IA. Sin él, palabras como "seguridad" o "control" dejarían pasar
// noticias que no tienen nada que ver (BBC Mundo y Euronews no son solo de IA).
const CONTEXTO_IA = palabras([
  'IA', 'AI', 'A\\.I\\.', 'IAG', 'AGI', 'inteligencia artificial', 'artificial intelligence',
  'chatbots?', 'LLMs?', 'modelos? de lenguaje', 'language models?', 'machine learning',
  'aprendizaje autom[aá]tico', 'superinteligencia', 'superintelligence',
]);

// Seguridad, riesgo, alineación, control, regulación, incidentes y evaluación.
const SEGURIDAD = palabras([
  'seguridad', 'safety', 'security', 'riesg\\p{L}*', 'risk\\p{L}*', 'align\\p{L}*', 'aline\\p{L}*',
  'control\\p{L}*', 'regulaci\\p{L}*', 'regulat\\p{L}*', 'incident\\p{L}*', 'evaluaci\\p{L}*',
  'evaluat\\p{L}*', 'evals?', 'AI Act', 'ley de IA', 'AISI', 'CAISI', 'guardrails?', 'salvaguardas?',
  'catastr\\p{L}*', 'existencial\\p{L}*', 'existential', 'extinci\\p{L}*', 'misuse', 'uso indebido',
  'ciberataque\\p{L}*', 'cyberattack\\p{L}*', 'hack\\p{L}*', 'bioarmas?', 'bioweapons?', 'jailbreak\\p{L}*',
  'deepfake\\p{L}*', 'vigilancia', 'surveillance', 'moratori\\p{L}*', 'peligro\\p{L}*', 'danger\\p{L}*',
  'amenaza\\p{L}*', 'threat\\p{L}*',
]);

// ¿Pasa esta noticia de prensa el filtro? Laboratorio o modelo nombrado, o bien
// contexto de IA + una palabra de seguridad, en el titular o el resumen.
export function pasaFiltroPrensa(noticia) {
  const texto = `${noticia.titulo} ${noticia.resumen ?? ''}`;
  return LABORATORIOS_Y_MODELOS.test(texto) || (CONTEXTO_IA.test(texto) && SEGURIDAD.test(texto));
}

export const pasaFiltro = (noticia) => noticia.categoria !== 'prensa' || pasaFiltroPrensa(noticia);

// ---------------------------------------------------------------------------
// Duplicados exactos
// ---------------------------------------------------------------------------

export function normalizarTitulo(titulo) {
  return titulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Misma URL: se ignoran el fragmento y los parámetros de seguimiento (utm_*).
export function normalizarUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const clave of [...u.searchParams.keys()]) if (/^utm_/i.test(clave)) u.searchParams.delete(clave);
    return u.toString();
  } catch {
    return url;
  }
}

const ORDEN_CATEGORIA = { laboratorio: 0, seguridad: 1, boletin: 2, prensa: 3 };

// Solo duplicados exactos (misma URL o mismo título normalizado). Ante un
// duplicado se conserva la fuente más original: categoría primero y, dentro de
// ella, la que no viene de Google News.
export function deduplicar(noticias) {
  const preferida = (a, b) =>
    (ORDEN_CATEGORIA[a.categoria] - ORDEN_CATEGORIA[b.categoria]) ||
    (Number(Boolean(a.publicador)) - Number(Boolean(b.publicador)));
  const porUrl = new Map();
  const porTitulo = new Map();
  const conservadas = [];
  for (const n of [...noticias].sort(preferida)) {
    const url = n.enlace ? normalizarUrl(n.enlace) : '';
    const titulo = normalizarTitulo(n.titulo);
    if ((url && porUrl.has(url)) || (titulo && porTitulo.has(titulo))) continue;
    if (url) porUrl.set(url, n);
    if (titulo) porTitulo.set(titulo, n);
    conservadas.push(n);
  }
  return conservadas;
}

// ---------------------------------------------------------------------------
// Publicación
// ---------------------------------------------------------------------------

export const ordenarPorFecha = (noticias) => [...noticias].sort((a, b) => ms(b.fecha) - ms(a.fecha));

// De todas las noticias recibidas a lo que se publica: los últimos `dias` días,
// tras el filtro de la prensa y sin duplicados exactos, por fecha descendente.
// `conteo24h` alimenta la comprobación de frescura de scripts/verificar.mjs.
export function prepararPublicacion(recibidas, { ahora = Date.now(), dias = VENTANA_DIAS } = {}) {
  const desde = ahora - dias * DIA_MS;
  const hace24h = ahora - DIA_MS;
  const descartes = { sinFecha: 0, fueraDeVentana: 0, prensaSinCoincidencia: 0, duplicadas: 0 };
  const enUltimas24h = (n) => ms(n.fecha) >= hace24h && ms(n.fecha) <= ahora + DIA_MS;
  const conteo24h = { enFeeds: 0, quePasanFiltro: 0, publicadas: 0 };

  const conFecha = [];
  for (const n of recibidas) {
    if (!n.fecha) descartes.sinFecha += 1;
    else conFecha.push(n);
  }
  conteo24h.enFeeds = conFecha.filter(enUltimas24h).length;

  const enVentana = conFecha.filter((n) => ms(n.fecha) >= desde);
  descartes.fueraDeVentana = conFecha.length - enVentana.length;

  const filtradas = enVentana.filter(pasaFiltro);
  descartes.prensaSinCoincidencia = enVentana.length - filtradas.length;
  conteo24h.quePasanFiltro = filtradas.filter(enUltimas24h).length;

  const unicas = deduplicar(filtradas);
  descartes.duplicadas = filtradas.length - unicas.length;

  const noticias = ordenarPorFecha(unicas);
  conteo24h.publicadas = noticias.filter(enUltimas24h).length;
  return { noticias, descartes, conteo24h };
}

// Tras traducir pueden aparecer titulares idénticos que en origen eran distintos
// (dos medios con titulares en inglés parecidos que se traducen igual): vuelven a
// contar como duplicados exactos. Devuelve la lista final, por fecha descendente.
export function finalizarPublicacion(traducidas) {
  const unicas = deduplicar(traducidas);
  return { noticias: ordenarPorFecha(unicas), duplicadas: traducidas.length - unicas.length };
}

// ---------------------------------------------------------------------------
// Archivo histórico: todo lo publicado alguna vez, para la búsqueda por fecha y
// por palabra clave en la web (que solo carga los últimos VENTANA_DIAS días).
// Se guarda un fichero por mes (data/historico/AAAA-MM.json); cada publicación
// fusiona en el mes que corresponda lo que acaba de publicarse.
// ---------------------------------------------------------------------------

// Mes (UTC) de una fecha ISO, como "2026-09".
export const claveMes = (fecha) => new Date(fecha).toISOString().slice(0, 7);

// Añade `nuevas` al archivo ya existente de un mes sin duplicar (misma lógica que
// al publicar: misma URL o mismo título normalizado). Por fecha descendente.
export function fusionarHistorico(existentes, nuevas) {
  return ordenarPorFecha(deduplicar([...existentes, ...nuevas]));
}

// ---------------------------------------------------------------------------
// Descarga: user agent de cada intento
// ---------------------------------------------------------------------------

export const USER_AGENTS = {
  lector: 'Feedly/1.0 (+http://www.feedly.com/fetcher.html)',
  navegador: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

// User agent del intento `intento` (0 es el primero). El primero es el del feed o,
// si no tiene, el de rss-parser (undefined). Si falla, se prueba como lector de
// feeds y luego como navegador: Substack devolvía 403 desde el runner de GitHub y
// otros sitios rechazan según el user agent (VentureBeat 429, Euronews 406).
export function agenteDeUsuario(feed, intento) {
  const orden = [feed.userAgent, USER_AGENTS.lector, USER_AGENTS.navegador];
  return orden[Math.min(intento, orden.length - 1)];
}

// ---------------------------------------------------------------------------
// Estado de los feeds
// ---------------------------------------------------------------------------

// `actual` y `previo` son listas de { nombre, items }. Un feed "caído" es el que
// ayer devolvió ítems y hoy devuelve cero.
export function comprobarFeeds(actual, previo = []) {
  const antes = new Map(previo.map((f) => [f.nombre, f.items]));
  const vacios = actual.filter((f) => f.items === 0).map((f) => f.nombre);
  const caidos = actual.filter((f) => f.items === 0 && (antes.get(f.nombre) ?? 0) > 0).map((f) => f.nombre);
  return { vacios, caidos };
}
