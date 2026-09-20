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
// Claude puntúa cada noticia de 1 a 5 según su relevancia para AI safety y solo
// se conservan las que llegan a este mínimo. Subirlo acorta y endurece la
// lista; bajarlo la alarga.
const RELEVANCIA_MINIMA = 4;

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

// Devuelve el primer array u objeto JSON completo del texto, ignorando lo que
// haya antes y después (una nota, el cierre de un bloque de código...). Sabe
// saltarse corchetes y llaves que aparezcan dentro de cadenas.
function primerValorJSON(texto) {
  const inicio = texto.search(/[[{]/);
  if (inicio < 0) return texto;
  let profundidad = 0;
  let enCadena = false;
  let escapado = false;
  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i];
    if (enCadena) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === '"') enCadena = false;
    } else if (c === '"') {
      enCadena = true;
    } else if (c === '[' || c === '{') {
      profundidad += 1;
    } else if (c === ']' || c === '}') {
      profundidad -= 1;
      if (profundidad === 0) return texto.slice(inicio, i + 1);
    }
  }
  return texto.slice(inicio);
}

// Claude no siempre devuelve JSON limpio. Casos vistos en producción:
//  - una coma final antes de `}` o `]` ("Expected double-quoted property
//    name", tumbó las destacadas el 20-09);
//  - texto después del array ("Unexpected non-whitespace character after
//    JSON", tumbó la clasificación el 20-09 en el runner).
// Se prueban, por orden, el texto tal cual y el primer valor JSON completo,
// cada uno con y sin comas finales. Si nada parsea se propaga el PRIMER error.
function extraerJSON(texto) {
  if (!texto) {
    throw new Error('La respuesta de la API no contenía texto');
  }
  const limpio = texto
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let primerError;
  for (const candidato of [limpio, primerValorJSON(limpio)]) {
    for (const intento of [candidato, candidato.replace(/,(\s*[}\]])/g, '$1')]) {
      try {
        return JSON.parse(intento);
      } catch (err) {
        primerError ??= err;
      }
    }
  }
  throw primerError;
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
// AI safety: de cada una nos quedamos con las más relevantes (y, a igualdad,
// las más recientes) para que una sola cabecera no llene la lista. Las fuentes especializadas no tienen tope.
function limitarPorFuente(noticias) {
  const tope = new Map(feeds.filter((f) => f.maxPorDia).map((f) => [f.name, f.maxPorDia]));
  const usadas = new Map();
  const porFecha = (a, b) => new Date(b.fecha) - new Date(a.fecha);
  return [...noticias]
    .sort((a, b) => (b.relevancia ?? 0) - (a.relevancia ?? 0) || porFecha(a, b))
    .filter((n) => {
      const max = tope.get(n.fuente);
      if (!max) return true;
      const usadasAntes = usadas.get(n.fuente) ?? 0;
      usadas.set(n.fuente, usadasAntes + 1);
      return usadasAntes < max;
    })
    .sort(porFecha);
}

// Pedirle a Claude que filtre, deduplique Y traduzca cientos de noticias en una
// sola respuesta no cabe: en una prueba con 410 entradas se cortó por
// max_tokens (32 000) a mitad de JSON. Por eso el trabajo se divide:
//   1. Claude solo decide qué noticias entran y a qué historia pertenecen
//      (respuesta de unos pocos miles de tokens: índice + etiqueta).
//   2. El código deduplica por historia y aplica el tope por fuente.
//   3. Solo las que sobreviven se traducen (las de fuentes en español no).
// Además, enlaces y fechas ya no pasan por Claude: se toman del feed original.
async function clasificarAISafety(noticias) {
  const lista = noticias.map((n, i) => ({
    i,
    fuente: n.fuente,
    titulo: n.titulo,
    resumen: n.resumen.slice(0, 300),
  }));

  const prompt = `Eres un editor especializado en seguridad de la inteligencia artificial (AI safety). Este es un boletín de AI safety, NO de noticias de IA en general.

Puntúa TODAS las noticias de la lista de 1 a 5 según su relevancia para AI safety, fijándote en su tema PRINCIPAL:
- 5: incidente real o riesgo grave y concreto de seguridad de la IA (ciberataques, bioseguridad, armas, pérdida de control, agentes o modelos que engañan o sabotean), o una ley, acuerdo o decisión importante sobre seguridad de la IA avanzada.
- 4: claramente sobre AI safety (investigación, evaluaciones de seguridad, interpretabilidad, alineamiento, control, gobernanza o regulación orientadas a la seguridad), de importancia media.
- 3: menciona riesgos o seguridad, pero el tema principal es otro: negocio, inversión, empleo, geopolítica o política general, opinión sobre tendencias, privacidad, derechos de autor o deepfakes.
- 2: sobre IA pero sin relación con la seguridad: lanzamientos de producto, rendimiento o benchmarks, centros de datos y energía, usos de la IA en educación, salud, cultura o deporte.
- 1: nada que ver con la IA.
Ante la duda entre dos puntuaciones, pon la más baja. Una noticia que solo nombra la IA de pasada nunca pasa de 2.

Historia: a las noticias con puntuación 4 o 5 añádeles una "h": una etiqueta corta en minúsculas con guiones que identifique un SUCESO CONCRETO (quién hizo qué), no un tema general. Bien: "gemini-hackeo-tres-empresas", "newsom-orden-ejecutiva-seguridad-ia". Mal: "debate-riesgo-ia", "regulacion-ia". Las noticias que cuentan exactamente el mismo suceso, aunque vengan de fuentes o idiomas distintos, llevan EXACTAMENTE la misma etiqueta. Si dos noticias no cuentan el mismo suceso, usa etiquetas distintas: ante la duda, distintas. Decide las etiquetas mirando todas las noticias a la vez para que sean coherentes entre sí.

Noticias (i es el índice):
${JSON.stringify(lista)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array con UN objeto por cada noticia de la lista: "i" es el índice, "r" la puntuación y "h" la historia (solo si r es 4 o 5).
[
  { "i": 0, "r": 5, "h": "..." },
  { "i": 1, "r": 2 }
]`;

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = respuesta.content.find((bloque) => bloque.type === 'text')?.text;
  const vistos = new Set();
  return extraerJSON(texto)
    .filter((e) => {
      const valido =
        Number.isInteger(e?.i) && e.i >= 0 && e.i < noticias.length && !vistos.has(e.i) &&
        Number.isInteger(e?.r) && e.r >= 1 && e.r <= 5;
      if (valido) vistos.add(e.i);
      return valido;
    })
    .map((e) => ({ i: e.i, relevancia: e.r, historia: e.h }));
}

async function traducirAlEspanol(noticias) {
  const pendientes = noticias
    .map((n, i) => ({ i, titulo: n.titulo, resumen: n.resumen }))
    .filter((_, i) => noticias[i].idioma !== 'es');
  if (pendientes.length === 0) return noticias;

  const prompt = `Traduce al español, sin excepción, el titular y el resumen de cada una de estas noticias. No dejes ninguna palabra o frase en el idioma original (salvo nombres propios). Mantén el sentido y un tono periodístico neutro.

${JSON.stringify(pendientes)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array, un objeto por cada elemento y el mismo índice i:
[
  { "i": 0, "titulo": "...", "resumen": "..." }
]`;

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 32000,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = respuesta.content.find((bloque) => bloque.type === 'text')?.text;
  const traducidas = new Map(extraerJSON(texto).map((t) => [t.i, t]));
  return noticias.map((n, i) => {
    const t = traducidas.get(i);
    return t?.titulo ? { ...n, titulo: t.titulo, resumen: t.resumen ?? n.resumen } : n;
  });
}

async function filtrarYTraducirAISafety(noticias) {
  const puntuadas = await clasificarAISafety(noticias);
  const reparto = [5, 4, 3, 2, 1]
    .map((r) => `${r}: ${puntuadas.filter((p) => p.relevancia === r).length}`)
    .join(' | ');
  console.log(`Puntuación (${puntuadas.length} de ${noticias.length} noticias puntuadas) -> ${reparto}`);

  const idiomaPorFuente = new Map(feeds.map((f) => [f.name, f.idioma]));
  const conservadas = puntuadas
    .filter((p) => p.relevancia >= RELEVANCIA_MINIMA)
    .map(({ i, relevancia, historia }) => ({
      ...noticias[i],
      idioma: idiomaPorFuente.get(noticias[i].fuente) ?? 'en',
      relevancia,
      // Sin etiqueta no se agrupa con ninguna otra.
      historia: historia || `sin-etiqueta-${i}`,
    }));
  console.log(`Con relevancia >= ${RELEVANCIA_MINIMA}: ${conservadas.length} noticias.`);

  const finales = limitarPorFuente(deduplicarPorHistoria(conservadas)).map(
    ({ relevancia, ...resto }) => resto,
  );
  console.log(`Tras quitar repetidas y limitar por fuente: ${finales.length}.`);

  try {
    return await traducirAlEspanol(finales);
  } catch (err) {
    console.warn(`No se pudo traducir con la API de Anthropic, se guardan las noticias filtradas sin traducir: ${describirError(err)}`);
    return finales;
  }
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
    console.warn(`No se pudo filtrar con la API de Anthropic, se guardan las noticias sin filtrar: ${describirError(err)}`);
    noticias = limitarPorFuente(noticiasCrudas);
  }

  // El idioma se añade aquí (y no en el prompt) para que no dependa de que
  // Claude conserve el campo al reescribir cada noticia.
  const idiomaPorFuente = new Map(feeds.map((f) => [f.name, f.idioma]));
  noticias = noticias.map((n) => ({
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
