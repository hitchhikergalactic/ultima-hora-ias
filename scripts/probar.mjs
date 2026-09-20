// Pruebas offline del pipeline con datos inventados. No hacen ninguna petición ni
// llamada a la API: la traducción es simulada.
//   node scripts/probar.mjs
import { USER_AGENTS, agenteDeUsuario, comprobarFeeds, deduplicar, finalizarPublicacion, normalizarItem, normalizarTitulo, pasaFiltro, prepararPublicacion } from '../pipeline.js';
import { hashUrl, LOTE, traducirNoticias, traductorSimulado } from '../traduccion.js';

const AHORA = new Date('2026-09-20T12:00:00Z').getTime();
const HORA = 3600000;
let fallos = 0;
const comprobar = (nombre, cumple, detalle = '') => {
  if (!cumple) fallos += 1;
  console.log(`${cumple ? 'OK   ' : 'FALLA'}  ${nombre}${cumple ? '' : `  -> ${detalle}`}`);
};

let n = 0;
const N = (categoria, titulo, { horas = 2, url, resumen = '', idioma = 'en', publicador } = {}) => {
  n += 1;
  return {
    fuente: `feed-${categoria}`,
    medio: publicador ?? `medio-${categoria}`,
    categoria,
    idioma,
    titulo,
    resumen,
    enlace: url ?? `https://ejemplo.com/${n}`,
    fecha: new Date(AHORA - horas * HORA).toISOString(),
    ...(publicador ? { publicador } : {}),
  };
};

// --- Filtro: solo la prensa ------------------------------------------------------
const prensa = (titulo, resumen = '') => pasaFiltro(N('prensa', titulo, { resumen }));
comprobar('Filtro: prensa con nombre de laboratorio pasa', prensa('OpenAI presenta un nuevo producto'));
comprobar('Filtro: prensa con nombre de modelo pasa', prensa('Le dijo a ChatGPT que quería hacer daño'));
comprobar('Filtro: IA + seguridad pasa (es)', prensa('Google admite que su IA ha hackeado a tres empresas'));
comprobar('Filtro: AI + regulation pasa (en)', prensa('EU delays AI Act enforcement as regulation debate grows'));
comprobar('Filtro: alineación con acento pasa', prensa('La alineación de la inteligencia artificial preocupa a los expertos'));
comprobar('Filtro: palabra de seguridad sin IA NO pasa', !prensa('El Gobierno aprueba una ley de seguridad vial'));
comprobar('Filtro: IA sin palabra de seguridad NO pasa', !prensa('Nuevo móvil con IA y mejor cámara'));
comprobar('Filtro: se mira también el resumen', prensa('Noticia sin pistas', 'El informe alerta del riesgo de la inteligencia artificial'));
comprobar('Filtro: laboratorios, seguridad y boletines pasan SIN palabras clave',
  ['laboratorio', 'seguridad', 'boletin'].every((c) => pasaFiltro(N(c, 'Titular cualquiera sin ninguna palabra clave'))));

// --- Duplicados exactos ----------------------------------------------------------
{
  const a = N('prensa', 'Titular A', { url: 'https://x.com/a?utm_source=tw#seccion' });
  const b = N('prensa', 'Otro titular distinto', { url: 'https://x.com/a' });
  comprobar('Duplicados: misma URL (ignorando utm_ y fragmento)', deduplicar([a, b]).length === 1);
}
{
  const a = N('prensa', 'Google admite que su IA hackeó a tres empresas', { url: 'https://a.com/1' });
  const b = N('prensa', 'GOOGLE admite  que su IA hackeó a tres empresas!', { url: 'https://b.com/2' });
  comprobar('Duplicados: mismo título normalizado (mayúsculas, espacios, signos)', deduplicar([a, b]).length === 1);
  comprobar('Duplicados: normalizarTitulo quita acentos', normalizarTitulo('Ñandú: ¡ACCIÓN!') === 'nandu accion');
}
{
  const lab = N('laboratorio', 'Mismo titular', { url: 'https://lab.com/1', publicador: 'Reuters' });
  const oficial = N('laboratorio', 'Mismo titular', { url: 'https://lab.com/2' });
  const prensaN = N('prensa', 'Mismo titular', { url: 'https://p.com/3' });
  const [ganadora] = deduplicar([prensaN, lab, oficial]);
  comprobar('Duplicados: gana la categoría más original y, dentro de ella, la que no es Google News', ganadora.enlace === 'https://lab.com/2');
}
{
  const distintas = [N('prensa', 'Uno'), N('prensa', 'Dos'), N('seguridad', 'Tres')];
  comprobar('Duplicados: noticias distintas se conservan (sin agrupar por tema ni tope por medio)', deduplicar(distintas).length === 3);
  const mismoMedio = Array.from({ length: 6 }, (_, i) => N('seguridad', `Titular ${i}`));
  comprobar('Sin topes por medio: 6 noticias del mismo medio se publican las 6', prepararPublicacion(mismoMedio, { ahora: AHORA }).noticias.length === 6);
}

// Caso real del 20-09: dos titulares distintos en inglés que se traducen igual
{
  const a = N('laboratorio', 'Lawsuit says Anthropic, OpenAI and Google colluded', { url: 'https://a.com/1', horas: 3 });
  const b = N('laboratorio', 'Suit says Anthropic, OpenAI and Google colluded', { url: 'https://b.com/2', horas: 2 });
  const traducidas = [a, b].map((x) => ({ ...x, titulo: 'La demanda dice que Anthropic, OpenAI y Google se coludieron' }));
  comprobar('Antes de traducir son distintos (no son duplicados exactos)', deduplicar([a, b]).length === 2);
  const { noticias, duplicadas } = finalizarPublicacion(traducidas);
  comprobar('Tras traducir: el titular idéntico cuenta como duplicado exacto', noticias.length === 1 && duplicadas === 1, `quedan ${noticias.length}`);
}

// --- Ventana, orden, fechas ----------------------------------------------------
{
  const recientes = [N('seguridad', 'A', { horas: 1 }), N('seguridad', 'B', { horas: 30 }), N('boletin', 'C', { horas: 24 * 6 })];
  const viejas = [N('seguridad', 'D', { horas: 24 * 8 }), N('seguridad', 'E', { horas: 24 * 30 })];
  const sinFecha = { ...N('seguridad', 'F'), fecha: '' };
  const { noticias, descartes } = prepararPublicacion([...viejas, sinFecha, ...recientes], { ahora: AHORA });
  comprobar('Ventana: solo los últimos 7 días', noticias.length === 3, `hay ${noticias.length}`);
  comprobar('Ventana: cuenta las descartadas por antiguas y por no tener fecha', descartes.fueraDeVentana === 2 && descartes.sinFecha === 1, JSON.stringify(descartes));
  comprobar('Orden: fecha descendente', noticias.map((x) => x.titulo).join('') === 'ABC', noticias.map((x) => x.titulo).join(''));
}
{
  const { conteo24h } = prepararPublicacion(
    [N('seguridad', 'A', { horas: 2 }), N('prensa', 'Sin coincidencia alguna', { horas: 3 }), N('boletin', 'C', { horas: 60 })],
    { ahora: AHORA },
  );
  comprobar('Frescura: cuenta lo recibido, lo que pasa el filtro y lo publicado en 24 h',
    conteo24h.enFeeds === 2 && conteo24h.quePasanFiltro === 1 && conteo24h.publicadas === 1, JSON.stringify(conteo24h));
}

// --- Normalización de ítems (rss-parser -> noticia) -----------------------------
{
  const gn = { name: 'Anthropic (Google News)', categoria: 'laboratorio', laboratorio: 'Anthropic', idioma: 'en', googleNews: true };
  const item = { title: 'Anthropic thwarts bioweapons research - Reuters', source: 'Reuters', link: 'https://news.google.com/x', isoDate: '2026-09-19T10:00:00.000Z', contentSnippet: 'Anthropic thwarts bioweapons research Reuters' };
  const noticia = normalizarItem(gn, item);
  comprobar('Google News: el medio mostrado es el de "vía", no el laboratorio', noticia.medio === 'Reuters' && noticia.publicador === 'Reuters');
  comprobar('Google News: se quita el medio del final del titular', noticia.titulo === 'Anthropic thwarts bioweapons research');
  comprobar('Google News: se conserva el laboratorio para la tabla por laboratorio', noticia.laboratorio === 'Anthropic');
  comprobar('Google News: el resumen (que repite el titular) se descarta', noticia.resumen === '');
  const normal = normalizarItem({ name: 'METR', categoria: 'seguridad', idioma: 'en' }, { title: ' Hola ', content: '<p>Texto <b>con</b> etiquetas</p><style>.x{}</style>', link: 'https://metr.org/1', pubDate: 'Sat, 19 Sep 2026 10:00:00 GMT' });
  comprobar('Ítem normal: el medio es el feed y el HTML se limpia', normal.medio === 'METR' && normal.resumen === 'Texto con etiquetas' && normal.titulo === 'Hola');
  comprobar('Fechas inválidas quedan vacías (no se publican)', normalizarItem({ name: 'X', categoria: 'prensa', idioma: 'en' }, { title: 't', link: 'l' }).fecha === '');
}

// --- Estado de los feeds ---------------------------------------------------------
{
  const previo = [{ nombre: 'A', items: 10 }, { nombre: 'B', items: 5 }, { nombre: 'C', items: 0 }];
  const actual = [{ nombre: 'A', items: 0 }, { nombre: 'B', items: 7 }, { nombre: 'C', items: 0 }, { nombre: 'D', items: 0 }];
  const { vacios, caidos } = comprobarFeeds(actual, previo);
  comprobar('Feeds: detecta los que devuelven cero', vacios.join() === 'A,C,D', vacios.join());
  comprobar('Feeds: "caído" = ayer tenía ítems y hoy 0', caidos.join() === 'A', caidos.join());
}

// --- User agent por intento -------------------------------------------------------
{
  comprobar('User agent: el primer intento usa el de rss-parser si el feed no define ninguno', agenteDeUsuario({}, 0) === undefined);
  comprobar('User agent: el primer intento respeta el del feed', agenteDeUsuario({ userAgent: 'X/1' }, 0) === 'X/1');
  comprobar('User agent: si falla, el segundo intento es un lector de feeds y el tercero un navegador',
    agenteDeUsuario({}, 1) === USER_AGENTS.lector && agenteDeUsuario({}, 2) === USER_AGENTS.navegador);
  comprobar('User agent: más intentos repiten el último', agenteDeUsuario({}, 5) === USER_AGENTS.navegador);
}

// --- Traducción con caché ---------------------------------------------------------
{
  const contar = () => {
    const llamadas = [];
    return { llamadas, traductor: async (lote) => { llamadas.push(lote.length); return traductorSimulado(lote); } };
  };
  const ingles = Array.from({ length: 95 }, (_, i) => N('seguridad', `English title ${i}`, { resumen: `summary ${i}` }));
  const espanol = [N('prensa', 'Ya está en español', { idioma: 'es' })];
  const { llamadas, traductor } = contar();
  const primera = await traducirNoticias([...ingles, ...espanol], {}, traductor, { ahora: AHORA });
  comprobar('Traducción: lotes de LOTE noticias', llamadas.join() === `${LOTE},${LOTE},${95 - 2 * LOTE}`, llamadas.join());
  comprobar('Traducción: no se traduce lo que ya está en español', primera.noticias.at(-1).titulo === 'Ya está en español' && primera.stats.yaEnEspanol === 1);
  comprobar('Traducción: titular y resumen traducidos', primera.noticias[0].titulo === '[ES] English title 0' && primera.noticias[0].resumen === '[ES] summary 0');
  comprobar('Traducción: la caché queda indexada por hash de URL', primera.cache[hashUrl(ingles[0].enlace)]?.titulo === '[ES] English title 0');

  const segunda = contar();
  const repetida = await traducirNoticias([...ingles, ...espanol], primera.cache, segunda.traductor, { ahora: AHORA });
  comprobar('Caché: la segunda ejecución no hace NINGUNA llamada', segunda.llamadas.length === 0 && repetida.stats.deCache === 95, `llamadas=${segunda.llamadas.length}`);
  comprobar('Caché: el resultado es el mismo', repetida.noticias[10].titulo === primera.noticias[10].titulo);

  const nueva = contar();
  const conNueva = await traducirNoticias([...ingles, N('seguridad', 'Brand new item')], primera.cache, nueva.traductor, { ahora: AHORA });
  comprobar('Caché: solo se traduce lo nuevo', nueva.llamadas.join() === '1' && conNueva.stats.traducidas === 1, nueva.llamadas.join());

  const rota = await traducirNoticias([N('seguridad', 'Falla')], {}, async () => { throw new Error('sin saldo'); }, { ahora: AHORA });
  comprobar('Fallo: la noticia se publica sin traducir y marcada', rota.noticias[0].titulo === 'Falla' && rota.noticias[0].traducido === false && rota.stats.fallidas === 1);
  comprobar('Fallo: lo no traducido no entra en la caché (se reintentará)', Object.keys(rota.cache).length === 0);

  const antigua = { [hashUrl('https://viejo.com')]: { titulo: 't', resumen: '', visto: new Date(AHORA - 40 * 86400000).toISOString() } };
  const podada = await traducirNoticias([N('seguridad', 'x')], antigua, traductorSimulado, { ahora: AHORA });
  comprobar('Caché: se descarta lo no visto en 30 días', !(hashUrl('https://viejo.com') in podada.cache));
}

console.log(fallos === 0 ? '\nTodas las pruebas pasan.' : `\n${fallos} prueba(s) fallan.`);
process.exit(fallos === 0 ? 0 : 1);
