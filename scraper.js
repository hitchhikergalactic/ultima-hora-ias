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

const parser = new Parser();

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
const anthropic = new Anthropic({
  timeout: ANTHROPIC_TIMEOUT_MS,
  maxRetries: 1,
  ...(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } }
    : {}),
});

async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
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
  return JSON.parse(limpio);
}

async function filtrarYTraducirAISafety(noticias) {
  const prompt = `Eres un editor especializado en seguridad de la inteligencia artificial (AI safety): riesgos catastróficos o de mal uso, alineamiento, evaluaciones de modelos, interpretabilidad, gobernanza y regulación de la IA.

Responde siempre en español, sin excepción. Traduce tanto el titular como el resumen de cada noticia al español; no dejes ninguna palabra o frase en el idioma original.

De la siguiente lista de noticias, descarta todas las que NO traten sobre seguridad, riesgos, alineamiento, evaluaciones de modelos, interpretabilidad o gobernanza/regulación de la IA. Conserva únicamente las que sí sean relevantes para AI safety.

Noticias:
${JSON.stringify(noticias, null, 2)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array de objetos con este formato, uno por cada noticia conservada:
[
  { "fuente": "...", "titulo": "...", "enlace": "...", "fecha": "...", "resumen": "..." }
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
    console.warn(`No se pudo filtrar/traducir con la API de Anthropic, se guardan las noticias sin filtrar: ${err.message}`);
    noticias = noticiasCrudas;
  }

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
    console.warn(`No se pudieron seleccionar noticias destacadas: ${err.message}`);
  }
}

main();
