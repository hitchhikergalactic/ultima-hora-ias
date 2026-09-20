// Verifica los datos generados por scraper.js contra las reglas de reglas.js.
//
//   node scripts/verificar.mjs           comprueba las reglas de diversidad
//   node scripts/verificar.mjs --feeds   comprueba que ningún feed devolvió 0
//
// Imprime las tablas de noticias por medio, por categoría y por laboratorio y
// sale con código 1 si se incumple alguna regla (o, con --feeds, si algún feed
// no devolvió noticias). Lee data/latest.json, data/destacadas-latest.json y
// data/informe-latest.json.

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from '../feeds.js';
import { REGLAS, verificarReglas } from '../reglas.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const soloFeeds = process.argv.includes('--feeds');

const leer = async (nombre) => JSON.parse(await readFile(path.join(DATA, nombre), 'utf-8'));

function tabla(titulo, filas, cabecera) {
  console.log(`\n== ${titulo} ==`);
  if (filas.length === 0) {
    console.log('  (vacío)');
    return;
  }
  const ancho = Math.max(...filas.map(([nombre]) => String(nombre).length), cabecera[0].length);
  console.log(`  ${cabecera[0].padEnd(ancho)}  ${cabecera[1]}`);
  for (const [nombre, valor] of filas) console.log(`  ${String(nombre).padEnd(ancho)}  ${valor}`);
}

const informe = await leer('informe-latest.json').catch(() => null);
if (!informe) {
  console.error('No existe data/informe-latest.json: el scraper no llegó a guardar datos.');
  process.exit(soloFeeds ? 0 : 1);
}

// --- Feeds: petición real, ítems devueltos por cada uno ---
const filasFeeds = informe.feeds.map((f) => [f.nombre, `${String(f.items).padStart(3)} ítems  (${f.categoria})`]);
tabla(`Feeds de la última ejecución (${informe.fecha})`, filasFeeds, ['feed', 'ítems devueltos']);
if (informe.feedsVacios.length > 0) {
  console.error(`\nFALLO: feeds que devolvieron 0 ítems: ${informe.feedsVacios.join(', ')}`);
} else {
  console.log(`\nOK: los ${informe.feeds.length} feeds devolvieron ítems.`);
}
if (soloFeeds) process.exit(informe.feedsVacios.length > 0 ? 1 : 0);

// --- Reglas de diversidad ---
const noticias = await leer('latest.json');
const destacadas = await leer('destacadas-latest.json').catch(() => []);
const { errores, excepciones, tablas, totales } = verificarReglas({ noticias, destacadas, informe, feeds });

const ordenar = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`\nVentana: últimos ${REGLAS.ventanaDias} días | ${totales.ventana} noticias (destacadas ${totales.destacadas} + lista) | ${totales.boletines} boletines semanales aparte`);
tabla('Noticias por medio (ventana)', ordenar(tablas.porMedio), ['medio', 'noticias']);
tabla('Noticias por categoría (ventana)', ordenar(tablas.porCategoria).map(([c, n]) => [c, `${n}  (${Math.round((100 * n) / totales.ventana)}%)`]), ['categoría', 'noticias']);
tabla('Noticias por laboratorio (ventana)', Object.entries(tablas.porLaboratorio).map(([lab, n]) => [lab, `${n}  (candidatas: ${informe.laboratorios?.[lab]?.candidatas ?? 0})`]), ['laboratorio', 'noticias']);
tabla('Boletines semanales (bloque aparte)', noticias.filter((n) => n.bloque === 'boletines').map((n) => [n.fuente, `${n.fecha.slice(0, 16)}  ${n.titulo.slice(0, 60)}`]), ['boletín', 'último número']);

const reglas = [
  ['Regla 1', `máx. ${REGLAS.maxPorEvento} noticia por evento`],
  ['Regla 2', `máx. ${REGLAS.maxPorMedio} noticias por medio en ${REGLAS.ventanaDias} días`],
  ['Regla 3', 'mín. 1 noticia por laboratorio si hay candidata en la ventana'],
  ['Regla 4', `prensa generalista <= ${REGLAS.maxPrensa * 100}% de la ventana`],
  ['Regla 5', 'lo destacado no se repite en la lista'],
  ['Regla 6', 'boletines semanales en bloque aparte, solo el último número'],
  ['Relevancia', `noticias con relevancia >= ${REGLAS.relevanciaMinima} (>= ${REGLAS.relevanciaMinimaLab} las de laboratorios)`],
  ['Destacadas', `máx. ${REGLAS.maxDestacadas}`],
];
console.log('\n== Comprobación de reglas ==');
for (const [clave, descripcion] of reglas) {
  const falladas = errores.filter((e) => e.startsWith(`${clave}:`));
  console.log(`  [${falladas.length === 0 ? 'OK   ' : 'FALLA'}] ${clave}: ${descripcion}`);
  for (const e of falladas) console.log(`           - ${e}`);
}
if (excepciones.length > 0) {
  console.log('\nExcepciones documentadas de la regla 3 (no son fallos):');
  for (const e of excepciones) console.log(`  - ${e}`);
}

if (errores.length > 0) {
  console.error(`\nFALLO: ${errores.length} incumplimiento(s) de las reglas.`);
  process.exit(1);
}
console.log('\nOK: se cumplen todas las reglas.');
