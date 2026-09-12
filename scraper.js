import Parser from 'rss-parser';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from './feeds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const parser = new Parser();

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
}

main();
