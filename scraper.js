import 'dotenv/config';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from './feeds.js';
import { VENTANA_DIAS, agenteDeUsuario, comprobarFeeds, finalizarPublicacion, normalizarItem, prepararPublicacion } from './pipeline.js';
import { traducirNoticias, traductorSimulado } from './traduccion.js';

// Uso:
//   node scraper.js                            ejecución normal (feeds reales + Haiku)
//   node scraper.js --capturar=RUTA            descarga los feeds y guarda un fixture (sin API)
//   node scraper.js --fixture=RUTA             usa un fixture en vez de descargar
//   node scraper.js --traduccion-simulada      no llama a la API: traducción de mentira
//   node scraper.js --datos=DIR --ahora=ISO    carpeta de salida y hora de referencia
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [clave, ...valor] = a.replace(/^--/, '').split('=');
    return [clave, valor.length > 0 ? valor.join('=') : true];
  }),
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = args.datos ? path.resolve(args.datos) : path.join(__dirname, 'data');

const MAX_ITEMS_POR_FEED = 50;
const FEED_TIMEOUT_MS = 30 * 1000;
const REINTENTOS = 2;
const ESPERAS_MS = [1000, 3000];
const ANTHROPIC_TIMEOUT_MS = 5 * 60 * 1000;
// Haiku 4.5 solo traduce: no selecciona, no puntúa, no resume.
const MODELO_TRADUCCION = 'claude-haiku-4-5-20251001';

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// El timeout de rss-parser es de inactividad del socket: un servidor que gotea
// bytes sin terminar podría colgar el scraper (el run del 19-09 estuvo 6 h así).
// El tope duro garantiza que ningún feed pueda bloquear al resto.
function conTopeDuro(promesa, ms) {
  let timer;
  const tope = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta tras ${ms / 1000}s`)), ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(timer));
}

function crearParser(feed, intento) {
  const agente = agenteDeUsuario(feed, intento);
  return new Parser({
    timeout: FEED_TIMEOUT_MS,
    customFields: { item: ['source'] },
    ...(agente ? { headers: { 'User-Agent': agente } } : {}),
  });
}

// --- Secretos y cliente de Anthropic ---------------------------------------

// Un secret con un carácter de control (salto de línea, tab...) hace que node-fetch
// tire un `TypeError: <valor> is not a legal HTTP header value` que cita el propio
// secreto, y GitHub lo enmascara como "***". Se limpia toda la cadena.
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
  maxRetries: 4,
  ...(anthropicWorkspaceId ? { defaultHeaders: { 'anthropic-workspace-id': anthropicWorkspaceId } } : {}),
});

// GitHub Actions enmascara como "***" cualquier texto de log que contenga el valor
// de un secret; lo quitamos nosotros antes de imprimir para no perder el diagnóstico.
function redactar(texto) {
  if (!texto) return texto;
  let limpio = texto;
  if (anthropicApiKey) limpio = limpio.split(anthropicApiKey).join('<ANTHROPIC_API_KEY>');
  if (anthropicWorkspaceId) limpio = limpio.split(anthropicWorkspaceId).join('<ANTHROPIC_WORKSPACE_ID>');
  return limpio;
}

// El SDK envuelve los fallos de red en un "Connection error" genérico; el motivo
// real suele venir en err.cause (a veces anidado).
function describirError(err) {
  const partes = [`${err.name}: ${err.message}`];
  let causa = err.cause;
  for (let profundidad = 0; causa && profundidad < 3; profundidad += 1) {
    partes.push(`cause: ${causa.code ?? causa.name ?? ''} ${causa.message ?? causa}`.trim());
    causa = causa.cause;
  }
  return redactar(partes.join(' | '));
}

// --- Ingesta -----------------------------------------------------------------

// Descarga un feed con reintentos y devuelve cuántos ítems trajo (y el error, si lo hubo).
async function leerFeed(feed) {
  let ultimoError;
  for (let intento = 0; intento <= REINTENTOS; intento += 1) {
    try {
      const resultado = await conTopeDuro(crearParser(feed, intento).parseURL(feed.url), FEED_TIMEOUT_MS);
      const items = resultado.items.slice(0, MAX_ITEMS_POR_FEED).map((item) => normalizarItem(feed, item));
      return { nombre: feed.name, categoria: feed.categoria, items, intentos: intento + 1 };
    } catch (err) {
      ultimoError = err;
      if (intento < REINTENTOS) await esperar(ESPERAS_MS[intento]);
    }
  }
  return { nombre: feed.name, categoria: feed.categoria, items: [], intentos: REINTENTOS + 1, error: ultimoError.message.replace(/\s+/g, ' ').slice(0, 160) };
}

// --- Traducción con Haiku ------------------------------------------------------

// Tokens gastados en traducir en esta ejecución (para conocer el coste real).
const uso = { entrada: 0, salida: 0 };

async function traducirConHaiku(lote) {
  const prompt = `Eres un traductor. Traduce al español de España el titular y el resumen de cada elemento.

SOLO traduces: no resumas, no añadas información, no omitas nada, no valores el contenido ni decidas qué es relevante. Conserva los nombres propios (personas, empresas, modelos), las cifras y las siglas habituales. Si un texto ya está en español, devuélvelo igual. Si el resumen está vacío, devuélvelo vacío.

${JSON.stringify(lote)}

Entrega el resultado con la herramienta: un objeto por elemento, con el mismo índice i.`;

  const respuesta = await anthropic.messages.create({
    model: MODELO_TRADUCCION,
    max_tokens: 16000,
    tools: [
      {
        name: 'entregar_traducciones',
        description: 'Entrega el titular y el resumen traducidos al español de cada elemento.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  i: { type: 'integer', description: 'Índice del elemento' },
                  titulo: { type: 'string', description: 'Titular traducido al español' },
                  resumen: { type: 'string', description: 'Resumen traducido al español (vacío si no había)' },
                },
                required: ['i', 'titulo', 'resumen'],
              },
            },
          },
          required: ['items'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'entregar_traducciones' },
    messages: [{ role: 'user', content: prompt }],
  });

  uso.entrada += respuesta.usage?.input_tokens ?? 0;
  uso.salida += respuesta.usage?.output_tokens ?? 0;
  // Si se cortó por max_tokens la lista podría estar incompleta sin dar error.
  if (respuesta.stop_reason === 'max_tokens') throw new Error('la respuesta se cortó por max_tokens');
  const bloque = respuesta.content.find((b) => b.type === 'tool_use');
  if (!Array.isArray(bloque?.input?.items)) throw new Error(`respuesta sin la lista esperada (stop_reason: ${respuesta.stop_reason})`);
  return bloque.input.items;
}

// --- Ficheros ------------------------------------------------------------------

async function leerJSON(ruta, porDefecto) {
  try {
    return JSON.parse(await readFile(ruta, 'utf-8'));
  } catch {
    return porDefecto;
  }
}

const escribirJSON = (ruta, datos) => writeFile(ruta, `${JSON.stringify(datos, null, 2)}\n`, 'utf-8');

// --- Principal -----------------------------------------------------------------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const informePrevio = await leerJSON(path.join(DATA_DIR, 'informe-latest.json'), null);

  // Ingesta: petición real a cada feed (o un fixture guardado en los ensayos).
  let resultados;
  let ahora = args.ahora ? Date.parse(args.ahora) : Date.now();
  if (args.fixture) {
    const fixture = JSON.parse(await readFile(path.resolve(args.fixture), 'utf-8'));
    resultados = fixture.feeds;
    if (!args.ahora) ahora = Date.parse(fixture.capturadoEn);
  } else {
    resultados = await Promise.all(feeds.map(leerFeed));
  }
  if (args.capturar) {
    await escribirJSON(path.resolve(args.capturar), { capturadoEn: new Date(ahora).toISOString(), feeds: resultados });
    console.log(`Fixture guardado en ${args.capturar} (${resultados.reduce((n, r) => n + r.items.length, 0)} ítems de ${resultados.length} feeds).`);
    return;
  }

  const informeFeeds = resultados.map((r) => ({
    nombre: r.nombre,
    categoria: r.categoria,
    items: r.items.length,
    ...(r.error ? { error: r.error } : {}),
  }));
  console.log(`Feeds (${informeFeeds.length}):\n${informeFeeds.map((f) => `  ${f.error ? 'ERR' : String(f.items).padStart(3)}  ${f.nombre}${f.error ? `: ${f.error}` : ''}`).join('\n')}`);
  const { vacios, caidos } = comprobarFeeds(informeFeeds, informePrevio?.feeds ?? []);
  if (vacios.length > 0) console.warn(`Feeds sin ítems: ${vacios.join(', ')}`);
  if (caidos.length > 0) console.warn(`Feeds que ayer devolvieron ítems y hoy 0: ${caidos.join(', ')}`);

  const recibidas = resultados.flatMap((r) => r.items);
  if (recibidas.length === 0) throw new Error('Ningún feed devolvió noticias; no se guarda nada.');

  // Filtro solo para la prensa, duplicados exactos y ventana de 7 días.
  const { noticias, descartes, conteo24h } = prepararPublicacion(recibidas, { ahora });
  console.log(
    `Recibidas ${recibidas.length} -> publicables ${noticias.length} (descartadas: ${descartes.fueraDeVentana} fuera de los ${VENTANA_DIAS} días, ` +
      `${descartes.prensaSinCoincidencia} de prensa sin palabras clave, ${descartes.duplicadas} duplicadas, ${descartes.sinFecha} sin fecha).`,
  );
  if (noticias.length === 0) throw new Error('No hay ninguna noticia publicable; no se guarda nada para no vaciar la web.');

  // Traducción (solo lo que no está en español y no está en la caché).
  const rutaCache = path.join(DATA_DIR, 'cache-traducciones.json');
  const cache = await leerJSON(rutaCache, {});
  let traductor = traducirConHaiku;
  if (args['traduccion-simulada']) {
    traductor = traductorSimulado;
  } else if (!anthropicApiKey) {
    console.warn('Aviso: ANTHROPIC_API_KEY no está configurada; las noticias se publican sin traducir.');
    traductor = async () => {
      throw new Error('ANTHROPIC_API_KEY no configurada');
    };
  }
  const traducidas = await traducirNoticias(noticias, cache, traductor, {
    ahora,
    log: (mensaje) => console.warn(redactar(mensaje)),
  });
  const t = traducidas.stats;
  console.log(`Traducción (${args['traduccion-simulada'] ? 'simulada' : MODELO_TRADUCCION}): ${t.traducidas} nuevas en ${t.llamadas} llamada(s), ${t.deCache} de la caché, ${t.yaEnEspanol} ya en español, ${t.fallidas} sin traducir.${uso.entrada + uso.salida > 0 ? ` Tokens: ${uso.entrada} de entrada y ${uso.salida} de salida.` : ''}`);

  // Duplicados exactos que solo se ven tras traducir.
  const final = finalizarPublicacion(traducidas.noticias);
  descartes.duplicadasTrasTraducir = final.duplicadas;
  // Las publicadas de las últimas 24 h se recalculan tras quitar esos duplicados.
  conteo24h.publicadas = final.noticias.filter((n) => Date.parse(n.fecha) >= ahora - 24 * 60 * 60 * 1000).length;
  if (final.duplicadas > 0) console.log(`Tras traducir: ${final.duplicadas} duplicada(s) exacta(s) más.`);

  await escribirJSON(path.join(DATA_DIR, 'latest.json'), final.noticias);
  await escribirJSON(rutaCache, traducidas.cache);
  await escribirJSON(path.join(DATA_DIR, 'informe-latest.json'), {
    generado: new Date(ahora).toISOString(),
    ventanaDias: VENTANA_DIAS,
    feeds: informeFeeds,
    feedsVacios: vacios,
    feedsCaidos: caidos,
    ultimas24h: conteo24h,
    descartes,
    traduccion: { modelo: args['traduccion-simulada'] ? 'simulada' : MODELO_TRADUCCION, ...t, tokens: { ...uso } },
  });
  console.log(`Se guardaron ${final.noticias.length} noticias en ${path.join(DATA_DIR, 'latest.json')}`);
}

// Salida explícita: algún feed (Google) deja un socket keep-alive abierto y Node no
// termina mientras exista (en el Action eso alargaba cada run ~9 min).
main().then(
  () => process.exit(0),
  (err) => {
    console.error(describirError(err));
    process.exit(1);
  },
);
