import 'dotenv/config';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from './feeds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const MAX_ITEMS_POR_FEED = 30;
const MAX_RESUMEN_CHARS = 600;
const ANTHROPIC_TIMEOUT_MS = 8 * 60 * 1000;
const FEED_TIMEOUT_MS = 30 * 1000;

// El timeout de rss-parser es de inactividad del socket: un servidor que
// gotea bytes sin terminar podría colgar el scraper indefinidamente (el run
// del 19-09 estuvo 6 h en `node scraper.js` hasta que se canceló). El tope
// duro de abajo garantiza que ningún feed pueda bloquear al resto.
function crearParser(feed) {
  return new Parser({
    timeout: FEED_TIMEOUT_MS,
    ...(feed.userAgent ? { headers: { 'User-Agent': feed.userAgent } } : {}),
  });
}

function conTopeDuro(promesa, ms) {
  let timer;
  const tope = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta tras ${ms / 1000}s`)), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(timer));
}

// Algunos feeds (LessWrong, Alignment Forum) incrustan fórmulas con MathJax
// como HTML con <style> inline por cada fórmula. rss-parser solo quita las
// etiquetas al generar el texto plano, así que el CSS queda como texto
// suelto y contamina el resumen. Lo limpiamos a mano antes de usarlo.
function limpiarHTML(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// El log del Action enmascaró el motivo real del "Connection error" como
// "***" (GitHub redacta cualquier texto que contenga el valor exacto de un
// secret). Reproducido en local: un secret con un carácter de control
// (salto de línea, tab...) hace que node-fetch tire un
// `TypeError: <valor> is not a legal HTTP header value` -- el propio
// mensaje incluye el secreto, de ahí el enmascarado. Recortar solo los
// extremos (trim) no basta si el carácter inválido está en medio del
// valor, así que quitamos cualquier carácter de control de toda la
// cadena. Se deja un diagnóstico (solo longitudes, nunca el valor) para
// confirmar si hacía falta.
function limpiarSecreto(nombre, valor) {
  if (!valor) return valor;
  // eslint-disable-next-line no-control-regex
  const limpio = valor.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (limpio !== valor) {
    console.warn(`Aviso: ${nombre} tenía caracteres de control o espacios de más (${valor.length} -> ${limpio.length} caracteres), se limpia.`);
  }
  return limpio;
}

const anthropicApiKey = limpiarSecreto('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
const anthropicWorkspaceId = limpiarSecreto('ANTHROPIC_WORKSPACE_ID', process.env.ANTHROPIC_WORKSPACE_ID);

const anthropic = new Anthropic({
  apiKey: anthropicApiKey,
  timeout: ANTHROPIC_TIMEOUT_MS,
  // Las últimas ejecuciones en GitHub Actions fallaron con un "Connection
  // error" casi instantáneo (no un timeout real), varios días seguidos. Con
  // más reintentos el SDK aplica su backoff exponencial por defecto y
  // absorbe mejor ese tipo de fallo transitorio en vez de caer directo al
  // fallback sin filtrar.
  maxRetries: 4,
  ...(anthropicWorkspaceId
    ? { defaultHeaders: { 'anthropic-workspace-id': anthropicWorkspaceId } }
    : {}),
});

async function fetchFeed(feed) {
  try {
    const result = await conTopeDuro(crearParser(feed).parseURL(feed.url), FEED_TIMEOUT_MS);
    return result.items.slice(0, MAX_ITEMS_POR_FEED).map((item) => {
      const textoLimpio = limpiarHTML(item.content ?? item.summary ?? item.contentSnippet ?? '');
      return {
        fuente: feed.name,
        titulo: item.title ?? '',
        enlace: item.link ?? '',
        fecha: item.pubDate ?? item.isoDate ?? '',
        resumen: textoLimpio.slice(0, MAX_RESUMEN_CHARS),
      };
    });
  } catch (err) {
    console.warn(`No se pudo leer el feed "${feed.name}": ${err.message}`);
    return [];
  }
}

function extraerJSON(texto) {
  if (!texto) {
    throw new Error('La respuesta de la API no contenía texto');
  }
  const limpio = texto
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(limpio);
  } catch (err) {
    // Claude a veces deja una coma final antes de un `}` o `]`
    // (`"resumen": "...",\n }`), que JSON no admite. El 20-09 eso tumbó la
    // selección de destacadas ("Expected double-quoted property name").
    // Si sigue sin parsear tras quitarlas, se propaga el error original.
    try {
      return JSON.parse(limpio.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      throw err;
    }
  }
}

// Varias cabeceras cubren la misma historia. Pedirle a Claude que "quite
// duplicados" mientras filtra cientos de noticias no es fiable (en una prueba
// dejó la misma historia 5 veces), así que le pedimos una etiqueta por
// historia y aquí nos quedamos con UNA por etiqueta: la de la fuente de mayor
// prioridad (número más bajo en feeds.js) y, a igualdad, la más reciente.
// Las noticias sin etiqueta (p. ej. si la API falló) se dejan tal cual.
function deduplicarPorHistoria(noticias) {
  const prioridad = new Map(feeds.map((f) => [f.name, f.prioridad ?? 9]));
  const mejor = new Map();
  for (const n of noticias) {
    if (!n.historia) continue;
    const actual = mejor.get(n.historia);
    const gana =
      !actual ||
      (prioridad.get(n.fuente) ?? 9) < (prioridad.get(actual.fuente) ?? 9) ||
      ((prioridad.get(n.fuente) ?? 9) === (prioridad.get(actual.fuente) ?? 9) &&
        new Date(n.fecha) > new Date(actual.fecha));
    if (gana) mejor.set(n.historia, n);
  }
  return noticias
    .filter((n) => !n.historia || mejor.get(n.historia) === n)
    .map(({ historia, ...resto }) => resto);
}

// La prensa general (feeds con maxPorDia) publica mucho y solo una parte es
// AI safety: nos quedamos con las más recientes de cada una para que una sola
// cabecera no llene la lista. Las fuentes especializadas no tienen tope.
function limitarPorFuente(noticias) {
  const tope = new Map(feeds.filter((f) => f.maxPorDia).map((f) => [f.name, f.maxPorDia]));
  const usadas = new Map();
  return [...noticias]
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .filter((n) => {
      const max = tope.get(n.fuente);
      if (!max) return true;
      const usadasAntes = usadas.get(n.fuente) ?? 0;
      usadas.set(n.fuente, usadasAntes + 1);
      return usadasAntes < max;
    });
}

async function filtrarYTraducirAISafety(noticias) {
  const prompt = `Eres un editor especializado en seguridad de la inteligencia artificial (AI safety): riesgos catastróficos o de mal uso, alineamiento, evaluaciones de modelos, interpretabilidad, gobernanza y regulación de la IA.

Responde siempre en español, sin excepción. Traduce tanto el titular como el resumen de cada noticia al español; no dejes ninguna palabra o frase en el idioma original.

Este es un boletín de AI safety, NO de noticias de IA en general. Conserva una noticia solo si su tema PRINCIPAL es uno de estos:
- riesgos catastróficos o de mal uso de la IA (ciberataques, bioseguridad, armas, pérdida de control);
- alineamiento y control: agentes o modelos que se desvían, engañan, sabotean o actúan fuera de lo previsto;
- evaluaciones de seguridad de modelos, interpretabilidad e investigación en AI safety;
- incidentes de seguridad reales con sistemas de IA y cómo los gestionan los laboratorios;
- gobernanza y regulación orientadas a la seguridad de la IA avanzada (leyes, acuerdos internacionales, decisiones de laboratorios o gobiernos sobre seguridad).

Descarta, aunque mencionen la IA: lanzamientos de producto, rendimiento o benchmarks, negocio, inversión y valoraciones, empleo y economía, centros de datos y energía, usos de la IA en educación, salud, cultura o deporte, artículos de opinión sobre ansiedad o tendencias, y privacidad, derechos de autor o deepfakes salvo que el eje sea un riesgo de la IA avanzada. Ante la duda, descarta: es mejor una lista corta y buena que una larga y de relleno.

Historia: a cada noticia conservada asígnale un campo "historia": una etiqueta corta en minúsculas con guiones (p. ej. "gemini-hackeo-tres-empresas") que identifique el hecho o tema concreto. Todas las noticias que cuentan el mismo hecho, aunque vengan de fuentes o idiomas distintos, deben llevar EXACTAMENTE la misma etiqueta. Antes de escribir la lista, decide las etiquetas mirando todas las noticias a la vez para que sean coherentes entre sí.

Noticias:
${JSON.stringify(noticias, null, 2)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array de objetos con este formato, uno por cada noticia conservada:
[
  { "fuente": "...", "titulo": "...", "enlace": "...", "fecha": "...", "resumen": "...", "historia": "..." }
]`;

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 32000,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = respuesta.content.find((bloque) => bloque.type === 'text')?.text;
  return extraerJSON(texto);
}

async function seleccionarYResumir(noticias) {
  const prompt = `Responde siempre en español, sin excepción. Si una noticia viene de una fuente en otro idioma, traduce tanto el titular como el resto de campos al español; no dejes ninguna palabra o frase en el idioma original.

De la siguiente lista de noticias, elige entre 2 y 3 que tengan relevancia real para AI safety: regulación, incidentes, investigación o decisiones de empresa con impacto significativo. Escribe un resumen breve de cada una que elijas.

Si ninguna noticia del lote cumple ese criterio de relevancia real, no fuerces la cuota de 2 o 3: devuelve un array vacío [] en lugar de incluir noticias flojas o poco relevantes solo para completarla.

Noticias:
${JSON.stringify(noticias, null, 2)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array de objetos con este formato, o un array vacío [] si ninguna noticia cumple el criterio:
[
  { "fuente": "...", "titulo": "...", "enlace": "...", "fecha": "...", "resumen": "..." }
]`;

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = respuesta.content.find((bloque) => bloque.type === 'text')?.text;
  return extraerJSON(texto);
}

// GitHub Actions enmascara como "***" cualquier texto de log que contenga el
// valor exacto de un secret. Si el mensaje de error real incluye la API key
// o el workspace ID (p.ej. un TypeError de cabecera HTTP inválida que cita
// el valor), eso se come el diagnóstico entero. Lo quitamos nosotros mismos
// antes de imprimir para que no quede nada que enmascarar.
function redactar(texto) {
  if (!texto) return texto;
  let limpio = texto;
  if (anthropicApiKey) limpio = limpio.split(anthropicApiKey).join('<ANTHROPIC_API_KEY>');
  if (anthropicWorkspaceId) limpio = limpio.split(anthropicWorkspaceId).join('<ANTHROPIC_WORKSPACE_ID>');
  return limpio;
}

// El SDK de Anthropic envuelve los fallos de red en un "Connection error"
// genérico; err.message no dice nada útil. El motivo real (DNS, timeout de
// conexión, TLS...) suele venir en err.cause (y a veces anidado otra vez).
function describirError(err) {
  const partes = [`${err.name}: ${err.message}`];
  let causa = err.cause;
  let profundidad = 0;
  while (causa && profundidad < 3) {
    partes.push(`cause: ${causa.code ?? causa.name ?? ''} ${causa.message ?? causa}`.trim());
    causa = causa.cause;
    profundidad += 1;
  }
  return redactar(partes.join(' | '));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const results = await Promise.all(feeds.map(fetchFeed));
  const noticiasCrudas = results
    .flat()
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const fecha = new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `noticias-${fecha}.json`);
  const latestFile = path.join(DATA_DIR, 'latest.json');

  let noticias;
  try {
    noticias = await filtrarYTraducirAISafety(noticiasCrudas);
  } catch (err) {
    console.warn(`No se pudo filtrar/traducir con la API de Anthropic, se guardan las noticias sin filtrar: ${describirError(err)}`);
    noticias = noticiasCrudas;
  }

  // El idioma se añade aquí (y no en el prompt) para que no dependa de que
  // Claude conserve el campo al reescribir cada noticia.
  const idiomaPorFuente = new Map(feeds.map((f) => [f.name, f.idioma]));
  noticias = limitarPorFuente(deduplicarPorHistoria(noticias)).map((n) => ({
    ...n,
    idioma: idiomaPorFuente.get(n.fuente) ?? 'en',
  }));

  await writeFile(outFile, JSON.stringify(noticias, null, 2), 'utf-8');
  await writeFile(latestFile, JSON.stringify(noticias, null, 2), 'utf-8');

  console.log(`Se guardaron ${noticias.length} noticias en ${outFile}`);

  try {
    const destacadas = await seleccionarYResumir(noticias);

    if (destacadas.length === 0) {
      console.log('Ninguna noticia de hoy cumple el criterio de relevancia real; no se genera entrada de destacadas.');
    } else {
      const destacadasFile = path.join(DATA_DIR, `destacadas-${fecha}.json`);
      const destacadasLatestFile = path.join(DATA_DIR, 'destacadas-latest.json');

      await writeFile(destacadasFile, JSON.stringify(destacadas, null, 2), 'utf-8');
      await writeFile(destacadasLatestFile, JSON.stringify(destacadas, null, 2), 'utf-8');

      console.log(`Se seleccionaron ${destacadas.length} noticias destacadas en ${destacadasFile}`);
    }
  } catch (err) {
    console.warn(`No se pudieron seleccionar noticias destacadas: ${describirError(err)}`);
  }
}

// Salida explícita: algún feed (Google) deja un socket keep-alive abierto y
// Node no termina mientras exista. En el Action eso alargaba cada run ~9 min
// y el del 19-09 no terminó nunca (cancelado a las 6 h).
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
