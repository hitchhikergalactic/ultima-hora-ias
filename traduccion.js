// Traducción de titular y resumen al español, una sola vez por noticia.
//
// El traductor se inyecta (`traductor`): en producción es Haiku 4.5 (ver
// scraper.js) y en las pruebas una traducción simulada, así no se gasta nada.
// Solo traduce: no resume, no añade y no decide qué se publica.
//
// La caché está indexada por el hash de la URL y se guarda en el repositorio
// (data/cache-traducciones.json), de modo que lo ya traducido no se vuelve a pagar
// en ejecuciones posteriores.

import { createHash } from 'crypto';

export const LOTE = 40;
const DIAS_EN_CACHE = 30;
const DIA_MS = 24 * 60 * 60 * 1000;

export const hashUrl = (url) => createHash('sha256').update(url).digest('hex').slice(0, 24);

// Traducción simulada para pruebas y ensayos: no llama a ninguna API.
export async function traductorSimulado(lote) {
  return lote.map(({ i, titulo, resumen }) => ({
    i,
    titulo: `[ES] ${titulo}`,
    resumen: resumen ? `[ES] ${resumen}` : '',
  }));
}

const trocear = (lista, tamano) => {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
};

// Devuelve las noticias con titular y resumen en español, la caché actualizada y
// las estadísticas. Si un lote falla, sus noticias se publican en el idioma
// original con `traducido: false` y se reintentan en la siguiente ejecución.
export async function traducirNoticias(noticias, cache, traductor, { ahora = Date.now(), log = () => {} } = {}) {
  const nuevaCache = { ...cache };
  const marca = new Date(ahora).toISOString();
  const stats = { yaEnEspanol: 0, deCache: 0, traducidas: 0, fallidas: 0, llamadas: 0 };
  const resultado = [...noticias];
  const pendientes = [];

  noticias.forEach((n, indice) => {
    if (n.idioma === 'es') {
      stats.yaEnEspanol += 1;
      return;
    }
    const hash = hashUrl(n.enlace);
    const guardada = cache[hash];
    if (guardada) {
      nuevaCache[hash] = { ...guardada, visto: marca };
      resultado[indice] = { ...n, titulo: guardada.titulo, resumen: guardada.resumen };
      stats.deCache += 1;
    } else {
      pendientes.push({ indice, hash });
    }
  });

  for (const lote of trocear(pendientes, LOTE)) {
    stats.llamadas += 1;
    try {
      const traducidas = await traductor(
        lote.map(({ indice }, i) => ({ i, titulo: noticias[indice].titulo, resumen: noticias[indice].resumen })),
      );
      const porIndice = new Map(traducidas.map((t) => [t.i, t]));
      lote.forEach(({ indice, hash }, i) => {
        const t = porIndice.get(i);
        if (t?.titulo) {
          const resumen = t.resumen ?? '';
          resultado[indice] = { ...noticias[indice], titulo: t.titulo, resumen };
          nuevaCache[hash] = { titulo: t.titulo, resumen, visto: marca };
          stats.traducidas += 1;
        } else {
          resultado[indice] = { ...noticias[indice], traducido: false };
          stats.fallidas += 1;
        }
      });
    } catch (err) {
      log(`No se pudo traducir un lote de ${lote.length} noticias: ${err.message}`);
      for (const { indice } of lote) resultado[indice] = { ...noticias[indice], traducido: false };
      stats.fallidas += lote.length;
    }
  }

  // La caché no crece sin límite: se descarta lo que hace más de 30 días que no se ve.
  for (const [hash, entrada] of Object.entries(nuevaCache)) {
    if (ahora - new Date(entrada.visto).getTime() > DIAS_EN_CACHE * DIA_MS) delete nuevaCache[hash];
  }
  return { noticias: resultado, cache: nuevaCache, stats };
}
