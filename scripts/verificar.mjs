// Verifica los datos generados por scraper.js. Sale con código 1 si algo falla.
//
//   node scripts/verificar.mjs               todas las comprobaciones
//   node scripts/verificar.mjs --contenido   la publicación es coherente y está fresca
//   node scripts/verificar.mjs --feeds       ningún feed devolvió 0 ítems ni se cayó
//   node scripts/verificar.mjs --traduccion  no quedó nada sin traducir
//
// Imprime las tablas de noticias por categoría, por medio y por laboratorio y el
// recuento de ítems por feed. En el Action se ejecuta --contenido antes de publicar
// (si falla no se publica) y --feeds --traduccion después (el workflow termina en
// rojo y GitHub avisa, sin impedir que se publique lo demás).
//
// Uso local con datos de ensayo: DATOS_DIR=/ruta node scripts/verificar.mjs

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { feeds } from '../feeds.js';
import { CATEGORIAS, normalizarTitulo, normalizarUrl } from '../pipeline.js';

const DATA = process.env.DATOS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const banderas = new Set(process.argv.slice(2));
const todas = !['--contenido', '--feeds', '--traduccion'].some((b) => banderas.has(b));
const quiere = (bandera) => todas || banderas.has(bandera);

const DIA_MS = 24 * 60 * 60 * 1000;
const errores = [];
const avisos = [];

const leer = async (nombre) => JSON.parse(await readFile(path.join(DATA, nombre), 'utf-8'));

function tabla(titulo, filas, cabecera) {
  console.log(`\n== ${titulo} ==`);
  if (filas.length === 0) return console.log('  (vacío)');
  const ancho = Math.max(...filas.map(([nombre]) => String(nombre).length), cabecera[0].length);
  console.log(`  ${cabecera[0].padEnd(ancho)}  ${cabecera[1]}`);
  for (const [nombre, valor] of filas) console.log(`  ${String(nombre).padEnd(ancho)}  ${valor}`);
}
const contar = (lista, clave) => {
  const cuenta = new Map();
  for (const n of lista) cuenta.set(clave(n), (cuenta.get(clave(n)) ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

const informe = await leer('informe-latest.json').catch(() => null);
const noticias = await leer('latest.json').catch(() => null);
if (!informe || !Array.isArray(noticias)) {
  console.error('No existen data/informe-latest.json y data/latest.json: el scraper no llegó a guardar datos.');
  process.exit(quiere('--contenido') ? 1 : 0);
}
const generado = new Date(informe.generado).getTime();

// --- Feeds: cuántos ítems devolvió cada uno --------------------------------------
if (quiere('--feeds')) {
  tabla(
    `Ítems recibidos por feed (${informe.generado.slice(0, 16)}Z)`,
    informe.feeds.map((f) => [f.nombre, f.error ? `ERROR: ${f.error}` : `${String(f.items).padStart(3)} ítems  (${f.categoria})`]),
    ['feed', 'recibidos'],
  );
  const total = informe.feeds.reduce((suma, f) => suma + f.items, 0);
  console.log(`  ${'TOTAL'.padEnd(Math.max(...informe.feeds.map((f) => f.nombre.length)))}  ${String(total).padStart(3)} ítems de ${informe.feeds.length} feeds`);

  for (const f of informe.feeds.filter((x) => x.items === 0)) errores.push(`Feed sin ítems: "${f.nombre}"${f.error ? ` (${f.error})` : ''}`);
  for (const nombre of informe.feedsCaidos ?? []) errores.push(`Feed caído: "${nombre}" devolvió ítems ayer y hoy devuelve 0`);
  const enInforme = new Set(informe.feeds.map((f) => f.nombre));
  for (const f of feeds.filter((x) => !enInforme.has(x.name))) errores.push(`Feed configurado que no aparece en el informe: "${f.name}"`);
}

// --- Contenido: qué se publica -----------------------------------------------------
if (quiere('--contenido')) {
  const desde = generado - (informe.ventanaDias ?? 7) * DIA_MS;

  tabla('Noticias por categoría', contar(noticias, (n) => CATEGORIAS[n.categoria] ?? `(desconocida: ${n.categoria})`).map(([c, k]) => [c, `${k}  (${Math.round((100 * k) / noticias.length)}%)`]), ['categoría', 'noticias']);
  tabla('Noticias por medio', contar(noticias, (n) => n.medio), ['medio', 'noticias']);
  const laboratorios = contar(noticias.filter((n) => n.laboratorio), (n) => n.laboratorio);
  tabla('Noticias por laboratorio', laboratorios, ['laboratorio', 'noticias']);

  // Coherencia de la publicación.
  if (noticias.length === 0) errores.push('No hay ninguna noticia publicada');
  for (const n of noticias) {
    for (const campo of ['medio', 'categoria', 'titulo', 'enlace', 'fecha']) {
      if (!n[campo]) errores.push(`Falta "${campo}" en una noticia: "${(n.titulo ?? '?').slice(0, 50)}"`);
    }
    if (!(n.categoria in CATEGORIAS)) errores.push(`Categoría desconocida "${n.categoria}" en "${n.titulo.slice(0, 50)}"`);
    if (new Date(n.fecha).getTime() < desde) errores.push(`Fuera de la ventana de ${informe.ventanaDias} días: "${n.titulo.slice(0, 50)}" (${n.fecha.slice(0, 10)})`);
  }
  for (let i = 1; i < noticias.length; i += 1) {
    if (new Date(noticias[i].fecha) > new Date(noticias[i - 1].fecha)) {
      errores.push('Las noticias no están ordenadas por fecha descendente');
      break;
    }
  }
  const vistasUrl = new Set();
  const vistosTitulo = new Set();
  for (const n of noticias) {
    const url = normalizarUrl(n.enlace);
    const titulo = normalizarTitulo(n.titulo);
    if (vistasUrl.has(url)) errores.push(`URL duplicada: ${n.enlace}`);
    vistasUrl.add(url);
    if (titulo && vistosTitulo.has(titulo)) errores.push(`Título duplicado: "${n.titulo.slice(0, 60)}"`);
    vistosTitulo.add(titulo);
  }

  // Frescura: si en las últimas 24 h hay noticias que deberían publicarse (pasan el
  // filtro), tiene que haber alguna publicada.
  const publicadas24h = noticias.filter((n) => new Date(n.fecha).getTime() >= generado - DIA_MS).length;
  const u = informe.ultimas24h;
  const masReciente = noticias.length > 0 ? noticias[0].fecha : null;
  console.log('\n== Frescura (últimas 24 h) ==');
  console.log(`  Ítems recibidos de los feeds con fecha de las últimas 24 h:  ${u.enFeeds}`);
  console.log(`  ...de ellos, los que pasan el filtro y deben publicarse:     ${u.quePasanFiltro}`);
  console.log(`  Noticias publicadas de las últimas 24 h:                     ${publicadas24h}`);
  console.log(`  Noticia más reciente publicada:                              ${masReciente ? masReciente.slice(0, 16) + 'Z' : '(ninguna)'}`);
  if (u.quePasanFiltro > 0 && publicadas24h === 0) {
    errores.push(`Hay ${u.quePasanFiltro} noticia(s) de las últimas 24 h en los feeds y no se ha publicado ninguna`);
  } else if (u.enFeeds > 0 && u.quePasanFiltro === 0) {
    avisos.push('Hay ítems de las últimas 24 h en los feeds, pero ninguno pasa el filtro (prensa sin palabras clave)');
  }
  if (publicadas24h !== u.publicadas) avisos.push(`El informe dice ${u.publicadas} publicadas en 24 h y latest.json tiene ${publicadas24h}`);
}

// --- Traducción --------------------------------------------------------------------
if (quiere('--traduccion')) {
  const t = informe.traduccion;
  const sinTraducir = noticias.filter((n) => n.traducido === false).length;
  console.log(`\n== Traducción (${t.modelo}) ==`);
  console.log(`  nuevas: ${t.traducidas} en ${t.llamadas} llamada(s) | de la caché: ${t.deCache} | ya en español: ${t.yaEnEspanol} | sin traducir: ${t.fallidas}`);
  if (t.fallidas > 0 || sinTraducir > 0) errores.push(`Hay ${Math.max(t.fallidas, sinTraducir)} noticia(s) sin traducir`);
}

// --- Resultado -----------------------------------------------------------------------
for (const aviso of avisos) console.log(`\nAVISO: ${aviso}`);
if (errores.length > 0) {
  console.error(`\nFALLO (${errores.length}):`);
  for (const e of errores) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nOK: todas las comprobaciones pasan.');
