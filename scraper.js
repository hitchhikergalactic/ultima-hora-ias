import 'dotenv/config';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from './feeds.js';
import { REGLAS, seleccionarNoticias } from './reglas.js';

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
    customFields: { item: ['source'] },
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

const escaparRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// ¿Nombra el titular alguno de los términos de la fuente? Sin `terminos` siempre.
const nombraTermino = (feed, titulo) =>
  !feed.terminos || new RegExp(`\\b(${feed.terminos.map(escaparRegex).join('|')})\\b`, 'i').test(titulo);

// Cada noticia lleva los metadatos de su fuente (idioma, categoría, laboratorio,
// boletín semanal, prioridad): reglas.js los necesita para aplicar las reglas.
async function fetchFeed(feed) {
  try {
    const result = await conTopeDuro(crearParser(feed).parseURL(feed.url), FEED_TIMEOUT_MS);
    return result.items.slice(0, MAX_ITEMS_POR_FEED).map((item) => {
      let titulo = item.title ?? '';
      let publicador;
      if (feed.googleNews) {
        // Google News añade el medio al final del titular ("... - Reuters").
        publicador = typeof item.source === 'string' ? item.source : item.source?._;
        if (publicador && titulo.endsWith(` - ${publicador}`)) {
          titulo = titulo.slice(0, -(publicador.length + 3));
        }
      }
      const textoLimpio = limpiarHTML(item.content ?? item.summary ?? item.contentSnippet ?? '');
      // Un artículo de Google News que no nombra al laboratorio en el titular
      // no cuenta como del laboratorio: pasa a prensa generalista.
      const delLaboratorio = nombraTermino(feed, titulo);
      return {
        fuente: feed.name,
        titulo,
        enlace: item.link ?? '',
        fecha: item.pubDate ?? item.isoDate ?? '',
        resumen: textoLimpio.slice(0, MAX_RESUMEN_CHARS),
        idioma: feed.idioma,
        categoria: delLaboratorio ? feed.categoria : 'prensa',
        ...(feed.laboratorio && delLaboratorio ? { laboratorio: feed.laboratorio } : {}),
        ...(feed.semanal ? { semanal: true } : {}),
        ...(publicador ? { publicador } : {}),
        prioridad: feed.prioridad ?? 9,
      };
    });
  } catch (err) {
    console.warn(`No se pudo leer el feed "${feed.name}": ${err.message}`);
    return [];
  }
}

// Las respuestas se piden como uso forzado de una herramienta con esquema en
// vez de "JSON dentro de un texto": la API devuelve la lista ya estructurada y
// no hay nada que parsear. Pedir JSON en texto falló tres veces el 20-09 con
// errores distintos (coma final, texto después del array y un salto de línea
// sin escapar dentro de una cadena), y cada parche solo cubría el anterior.
async function pedirLista({ prompt, maxTokens, herramienta, descripcion, propiedades, requeridas }) {
  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    tools: [
      {
        name: herramienta,
        description: descripcion,
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', properties: propiedades, required: requeridas },
            },
          },
          required: ['items'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: herramienta },
    messages: [{ role: 'user', content: prompt }],
  });

  // Si se cortó por max_tokens la lista podría estar incompleta sin dar error.
  if (respuesta.stop_reason === 'max_tokens') {
    throw new Error(`La respuesta se cortó por max_tokens (${maxTokens})`);
  }
  const uso = respuesta.content.find((bloque) => bloque.type === 'tool_use');
  if (!Array.isArray(uso?.input?.items)) {
    throw new Error(`La respuesta no traía la lista esperada (stop_reason: ${respuesta.stop_reason})`);
  }
  return uso.input.items;
}

// Pedirle a Claude que filtre, deduplique Y traduzca cientos de noticias en una
// sola respuesta no cabe (con 410 entradas se cortó por max_tokens) y las reglas
// de diversidad no son fiables en un prompt. Por eso el trabajo se divide:
//   1. Claude solo PUNTÚA la relevancia de cada noticia y le asigna un evento
//      (respuesta pequeña: índice, puntuación y etiqueta).
//   2. reglas.js aplica en código las reglas de diversidad.
//   3. Solo las que sobreviven se traducen (las de fuentes en español no).
// Enlaces y fechas no pasan por Claude: se toman del feed original.
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

Historia: a las noticias con puntuación 3, 4 o 5 añádeles una "h": una etiqueta corta en minúsculas con guiones que identifique un SUCESO CONCRETO (quién hizo qué), no un tema general. Bien: "gemini-hackeo-tres-empresas", "newsom-orden-ejecutiva-seguridad-ia". Mal: "debate-riesgo-ia", "regulacion-ia". Las noticias que cuentan exactamente el mismo suceso, aunque vengan de fuentes o idiomas distintos, llevan EXACTAMENTE la misma etiqueta. Si dos noticias no cuentan el mismo suceso, usa etiquetas distintas: ante la duda, distintas. Decide las etiquetas mirando todas las noticias a la vez para que sean coherentes entre sí.

Noticias (i es el índice):
${JSON.stringify(lista)}

Entrega el resultado con la herramienta, con UN objeto por cada noticia de la lista: "i" es el índice, "r" la puntuación y "h" la historia (solo si r es 3, 4 o 5).`;

  const resultados = await pedirLista({
    prompt,
    maxTokens: 16000,
    herramienta: 'entregar_puntuaciones',
    descripcion: 'Entrega la puntuación de relevancia de cada noticia y la historia de las de 3, 4 o 5.',
    propiedades: {
      i: { type: 'integer', description: 'Índice de la noticia' },
      r: { type: 'integer', minimum: 1, maximum: 5, description: 'Puntuación de relevancia para AI safety' },
      h: { type: 'string', description: 'Etiqueta de la historia (solo si r es 3, 4 o 5)' },
    },
    requeridas: ['i', 'r'],
  });

  const vistos = new Set();
  return resultados
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

Entrega el resultado con la herramienta, un objeto por cada elemento y con el mismo índice i.`;

  const resultados = await pedirLista({
    prompt,
    maxTokens: 32000,
    herramienta: 'entregar_traducciones',
    descripcion: 'Entrega el titular y el resumen traducidos al español de cada noticia.',
    propiedades: {
      i: { type: 'integer', description: 'Índice de la noticia' },
      titulo: { type: 'string', description: 'Titular traducido al español' },
      resumen: { type: 'string', description: 'Resumen traducido al español' },
    },
    requeridas: ['i', 'titulo', 'resumen'],
  });
  const traducidas = new Map(resultados.map((t) => [t.i, t]));
  return noticias.map((n, i) => {
    const t = traducidas.get(i);
    return t?.titulo ? { ...n, titulo: t.titulo, resumen: t.resumen ?? n.resumen } : n;
  });
}

// Devuelve hasta REGLAS.maxDestacadas noticias de la lista con un resumen breve.
// Claude solo elige por índice y escribe el resumen: título, enlace y fecha se
// toman de la propia lista, así que una destacada siempre se puede quitar de
// la lista por su enlace (regla 5).
async function seleccionarYResumir(noticias) {
  const lista = noticias.map((n, i) => ({ i, fuente: n.fuente, titulo: n.titulo, resumen: n.resumen }));
  const prompt = `Responde siempre en español, sin excepción.

De la siguiente lista de noticias, elige entre 2 y ${REGLAS.maxDestacadas} que tengan relevancia real para AI safety: regulación, incidentes, investigación o decisiones de empresa con impacto significativo. Escribe un resumen breve de cada una que elijas.

Si ninguna noticia del lote cumple ese criterio de relevancia real, no fuerces la cuota: devuelve una lista vacía en lugar de incluir noticias flojas o poco relevantes solo para completarla.

Noticias (i es el índice):
${JSON.stringify(lista, null, 2)}

Entrega el resultado con la herramienta: el índice i de cada noticia elegida y su resumen breve, o una lista vacía.`;

  const elegidas = await pedirLista({
    prompt,
    maxTokens: 4096,
    herramienta: 'entregar_destacadas',
    descripcion: 'Entrega el índice y el resumen de las noticias destacadas, o una lista vacía.',
    propiedades: {
      i: { type: 'integer', description: 'Índice de la noticia elegida' },
      resumen: { type: 'string', description: 'Resumen breve en español' },
    },
    requeridas: ['i', 'resumen'],
  });

  const vistos = new Set();
  return elegidas
    .filter((e) => {
      const valido = Number.isInteger(e?.i) && e.i >= 0 && e.i < noticias.length && !vistos.has(e.i) && e.resumen;
      if (valido) vistos.add(e.i);
      return valido;
    })
    .slice(0, REGLAS.maxDestacadas)
    .map((e) => ({ ...noticias[e.i], resumen: e.resumen }));
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

// Campos internos que no se guardan en los datos publicados.
const paraGuardar = ({ prioridad, semanal, ...resto }) => resto;

async function leerDestacadasAnteriores() {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, 'destacadas-latest.json'), 'utf-8'));
  } catch {
    return [];
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  // Petición real a cada feed; se registra cuántos ítems devuelve.
  const results = await Promise.all(feeds.map(fetchFeed));
  const informeFeeds = feeds.map((f, i) => ({ nombre: f.name, categoria: f.categoria, items: results[i].length }));
  const feedsVacios = informeFeeds.filter((f) => f.items === 0).map((f) => f.nombre);
  console.log(`Feeds (${feeds.length}):\n${informeFeeds.map((f) => `  ${String(f.items).padStart(3)}  ${f.nombre}`).join('\n')}`);
  if (feedsVacios.length > 0) console.warn(`Feeds sin noticias: ${feedsVacios.join(', ')}`);

  const noticiasCrudas = results
    .flat()
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const fecha = new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `noticias-${fecha}.json`);
  const latestFile = path.join(DATA_DIR, 'latest.json');

  // Si no hay noticias, o la puntuación/traducción fallan, se aborta SIN
  // escribir nada (el proceso sale con error): en el Action eso evita abrir un
  // PR y la web conserva las noticias buenas del último PR fusionado. Antes se
  // guardaban las noticias sin filtrar y el PR se abría igual; el 20-09 una de
  // esas se fusionó y publicó 192 noticias sin filtrar.
  if (noticiasCrudas.length === 0) {
    throw new Error('Ningún feed devolvió noticias; no se guarda nada.');
  }

  let puntuadas;
  try {
    puntuadas = await clasificarAISafety(noticiasCrudas);
  } catch (err) {
    throw new Error(`No se pudo puntuar con la API de Anthropic; no se guarda nada para no publicar noticias sin filtrar: ${describirError(err)}`);
  }
  const reparto = [5, 4, 3, 2, 1]
    .map((r) => `${r}: ${puntuadas.filter((p) => p.relevancia === r).length}`)
    .join(' | ');
  console.log(`Puntuación (${puntuadas.length} de ${noticiasCrudas.length} noticias puntuadas) -> ${reparto}`);

  // Reglas de diversidad, en código (ver reglas.js).
  const candidatas = puntuadas.map(({ i, relevancia, historia }) => ({
    ...noticiasCrudas[i],
    relevancia,
    // Sin etiqueta no se agrupa con ninguna otra.
    evento: historia || `sin-etiqueta-${i}`,
  }));
  const seleccion = seleccionarNoticias(candidatas);
  console.log(`Selección: ${seleccion.lista.length} noticias + ${seleccion.boletines.length} boletines semanales.`);
  if (seleccion.lista.length + seleccion.boletines.length === 0) {
    throw new Error('Ninguna noticia pasó el filtro de AI safety; no se guarda nada para no vaciar la web.');
  }

  let traducidas;
  try {
    traducidas = await traducirAlEspanol([
      ...seleccion.lista,
      ...seleccion.boletines.map((b) => ({ ...b, bloque: 'boletines' })),
    ]);
  } catch (err) {
    throw new Error(`No se pudo traducir con la API de Anthropic; no se guarda nada: ${describirError(err)}`);
  }
  let noticias = traducidas.slice(0, seleccion.lista.length);
  const boletines = traducidas.slice(seleccion.lista.length);

  // Destacadas (regla 5: lo destacado no se repite en la lista). Si la
  // selección falla o sale vacía se conservan las anteriores, y también se
  // quitan de la lista.
  let destacadas = [];
  let destacadasNuevas = false;
  try {
    destacadas = await seleccionarYResumir(noticias);
    destacadasNuevas = destacadas.length > 0;
    if (!destacadasNuevas) {
      console.log('Ninguna noticia de hoy cumple el criterio de relevancia real; se conservan las destacadas anteriores.');
    }
  } catch (err) {
    console.warn(`No se pudieron seleccionar noticias destacadas, se conservan las anteriores: ${describirError(err)}`);
  }
  if (!destacadasNuevas) destacadas = await leerDestacadasAnteriores();
  const enlacesDestacadas = new Set(destacadas.map((d) => d.enlace));
  noticias = noticias.filter((n) => !enlacesDestacadas.has(n.enlace));

  const publicadas = [...noticias, ...boletines].map(paraGuardar);
  await writeFile(outFile, JSON.stringify(publicadas, null, 2), 'utf-8');
  await writeFile(latestFile, JSON.stringify(publicadas, null, 2), 'utf-8');
  console.log(`Se guardaron ${publicadas.length} noticias (${noticias.length} en la lista y ${boletines.length} boletines) en ${outFile}`);

  if (destacadasNuevas) {
    const destacadasFile = path.join(DATA_DIR, `destacadas-${fecha}.json`);
    const destacadasLatestFile = path.join(DATA_DIR, 'destacadas-latest.json');
    const guardadas = destacadas.map(paraGuardar);
    await writeFile(destacadasFile, JSON.stringify(guardadas, null, 2), 'utf-8');
    await writeFile(destacadasLatestFile, JSON.stringify(guardadas, null, 2), 'utf-8');
    console.log(`Se seleccionaron ${destacadas.length} noticias destacadas en ${destacadasFile}`);
  }

  // Informe de la ejecución: lo lee scripts/verificar.mjs.
  await writeFile(
    path.join(DATA_DIR, 'informe-latest.json'),
    JSON.stringify({ fecha, ventanaDias: REGLAS.ventanaDias, feeds: informeFeeds, feedsVacios, laboratorios: seleccion.informe.laboratorios }, null, 2),
    'utf-8',
  );
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
