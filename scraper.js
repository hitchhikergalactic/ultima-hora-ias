import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from './feeds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const parser = new Parser();
const anthropic = new Anthropic();

async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return result.items.map((item) => ({
      fuente: feed.name,
      titulo: item.title ?? '',
      enlace: item.link ?? '',
      fecha: item.pubDate ?? item.isoDate ?? '',
      resumen: item.contentSnippet ?? '',
    }));
  } catch (err) {
    console.warn(`No se pudo leer el feed "${feed.name}": ${err.message}`);
    return [];
  }
}

async function seleccionarYResumir(noticias) {
  const prompt = `Responde siempre en español, sin excepción. Si una noticia viene de una fuente en otro idioma, traduce tanto el titular como el resto de campos al español; no dejes ninguna palabra o frase en el idioma original.

De la siguiente lista de noticias, elige entre 2 y 3 que consideres más relevantes sobre inteligencia artificial y escribe un resumen breve de cada una.

Noticias:
${JSON.stringify(noticias, null, 2)}

Devuelve únicamente un JSON (sin texto adicional ni bloques de código) con un array de objetos con este formato:
[
  { "fuente": "...", "titulo": "...", "enlace": "...", "fecha": "...", "resumen": "..." }
]`;

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = respuesta.content[0].text;
  return JSON.parse(texto);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const results = await Promise.all(feeds.map(fetchFeed));
  const noticias = results
    .flat()
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const fecha = new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `noticias-${fecha}.json`);
  const latestFile = path.join(DATA_DIR, 'latest.json');

  await writeFile(outFile, JSON.stringify(noticias, null, 2), 'utf-8');
  await writeFile(latestFile, JSON.stringify(noticias, null, 2), 'utf-8');

  console.log(`Se guardaron ${noticias.length} noticias en ${outFile}`);

  try {
    const destacadas = await seleccionarYResumir(noticias);
    const destacadasFile = path.join(DATA_DIR, `destacadas-${fecha}.json`);
    const destacadasLatestFile = path.join(DATA_DIR, 'destacadas-latest.json');

    await writeFile(destacadasFile, JSON.stringify(destacadas, null, 2), 'utf-8');
    await writeFile(destacadasLatestFile, JSON.stringify(destacadas, null, 2), 'utf-8');

    console.log(`Se seleccionaron ${destacadas.length} noticias destacadas en ${destacadasFile}`);
  } catch (err) {
    console.warn(`No se pudieron seleccionar noticias destacadas: ${err.message}`);
  }
}

main();
