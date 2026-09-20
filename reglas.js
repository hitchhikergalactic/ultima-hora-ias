// Reglas de diversidad de la lista de noticias. Se aplican EN CÓDIGO, no en el
// prompt: Claude solo puntúa la relevancia de cada noticia y le asigna un
// identificador de evento (las noticias sobre el mismo hecho comparten
// identificador). Todo lo demás lo decide este módulo, que no llama a la API
// y por eso se puede probar con datos inventados.
//
// Las reglas 2, 3 y 4 se aplican a la VENTANA de los últimos `ventanaDias`
// días, que es la que la página muestra por defecto. Las noticias más antiguas
// (p. ej. publicaciones de hace meses de organizaciones de AI safety, visibles
// con "Últimos 90 días" o "Todas") solo pasan el umbral de relevancia y la
// regla del evento.

export const REGLAS = {
  ventanaDias: 7,
  relevanciaMinima: 4,
  // Para la regla de los laboratorios se admite una relevancia algo menor (3 =
  // "menciona riesgos o seguridad"), pero nunca una noticia sin relación con la
  // seguridad de la IA: no se rellena con lanzamientos de producto.
  relevanciaMinimaLab: 3,
  maxPorEvento: 1,
  maxPorMedio: 2,
  maxPrensa: 0.5,
  maxDestacadas: 3,
  laboratorios: ['Anthropic', 'OpenAI', 'Google DeepMind', 'Meta', 'xAI', 'Moonshot'],
};

const DIA_MS = 24 * 60 * 60 * 1000;
const ms = (fecha) => new Date(fecha).getTime();
const porFechaDesc = (a, b) => ms(b.fecha) - ms(a.fecha);

// Negativo si `a` es mejor que `b`: mayor relevancia, luego fuente más
// original (prioridad más baja) y, a igualdad, la más reciente.
const mejor = (a, b) =>
  (b.relevancia - a.relevancia) ||
  ((a.prioridad ?? 9) - (b.prioridad ?? 9)) ||
  porFechaDesc(a, b);

// Regla 1: como máximo `max` noticia(s) por evento, la mejor.
function unoPorEvento(items) {
  const porEvento = new Map();
  const sinEvento = [];
  for (const n of items) {
    if (!n.evento) {
      sinEvento.push(n);
      continue;
    }
    const actual = porEvento.get(n.evento);
    if (!actual || mejor(n, actual) < 0) porEvento.set(n.evento, n);
  }
  return [...porEvento.values(), ...sinEvento];
}

// Regla 2: como máximo `max` noticias por medio (las mejores de cada uno).
function topePorMedio(items, max) {
  const usadas = new Map();
  return [...items].sort(mejor).filter((n) => {
    const antes = usadas.get(n.fuente) ?? 0;
    usadas.set(n.fuente, antes + 1);
    return antes < max;
  });
}

// Recibe TODAS las noticias puntuadas (cada una con: fuente, categoria,
// laboratorio?, semanal?, prioridad, fecha, relevancia y evento) y devuelve:
//   lista:     noticias que cumplen las reglas (sin los boletines).
//   boletines: el último número de cada boletín semanal (regla 6).
//   informe:   qué pasó con cada laboratorio (regla 3).
export function seleccionarNoticias(items, { ahora = Date.now(), reglas = REGLAS } = {}) {
  const limite = ahora - reglas.ventanaDias * DIA_MS;
  const enVentana = (n) => ms(n.fecha) >= limite;

  // Regla 6: los boletines semanales van aparte, fuera del corte por fechas.
  const ultimoPorBoletin = new Map();
  for (const n of items.filter((x) => x.semanal)) {
    const previo = ultimoPorBoletin.get(n.fuente);
    if (!previo || ms(n.fecha) > ms(previo.fecha)) ultimoPorBoletin.set(n.fuente, n);
  }
  const boletines = [...ultimoPorBoletin.values()].sort(porFechaDesc);
  const resto = items.filter((n) => !n.semanal);

  // Umbral de relevancia y regla 1.
  const unicas = unoPorEvento(resto.filter((n) => n.relevancia >= reglas.relevanciaMinima));
  let dentro = unicas.filter(enVentana);
  let fuera = unicas.filter((n) => !enVentana(n));

  // Regla 2.
  dentro = topePorMedio(dentro, reglas.maxPorMedio);

  // Regla 3: al menos una noticia por laboratorio, si existe alguna en la
  // ventana con relevancia suficiente. Si su evento ya está cubierto por otra
  // fuente, la noticia del laboratorio la sustituye (así se sigue cumpliendo
  // la regla 1); si el evento pertenece a otro laboratorio, se prueba con la
  // siguiente candidata.
  const laboratorios = {};
  for (const lab of reglas.laboratorios) {
    const candidatas = resto
      .filter((n) => n.laboratorio === lab && enVentana(n) && n.relevancia >= reglas.relevanciaMinimaLab)
      .sort(mejor);
    laboratorios[lab] = { candidatas: candidatas.length, colocada: false };
    if (dentro.some((n) => n.laboratorio === lab)) {
      laboratorios[lab].colocada = true;
      continue;
    }
    for (const candidata of candidatas) {
      const choque = [...dentro, ...fuera].find((n) => n.evento && n.evento === candidata.evento);
      if (choque?.laboratorio) continue;
      dentro = dentro.filter((n) => n !== choque);
      fuera = fuera.filter((n) => n !== choque);
      dentro.push(candidata);
      laboratorios[lab].colocada = true;
      break;
    }
    if (candidatas.length > 0 && !laboratorios[lab].colocada) {
      laboratorios[lab].motivo = 'todas sus candidatas comparten evento con otro laboratorio';
    }
  }

  // Regla 4: la prensa generalista es como máximo `maxPrensa` de la ventana.
  const noPrensa = dentro.filter((n) => n.categoria !== 'prensa');
  const maxPrensa = Math.floor((noPrensa.length * reglas.maxPrensa) / (1 - reglas.maxPrensa));
  const prensa = dentro.filter((n) => n.categoria === 'prensa').sort(mejor).slice(0, maxPrensa);
  dentro = [...noPrensa, ...prensa];

  return {
    lista: [...dentro, ...fuera].sort(porFechaDesc),
    boletines,
    informe: { laboratorios },
  };
}

// Comprueba TODAS las reglas sobre lo que ve el lector (destacadas + lista +
// boletines) y devuelve las tablas y la lista de incumplimientos.
//   noticias: el contenido de data/latest.json (lista + boletines).
//   feeds:    la definición de feeds.js.
export function verificarReglas({ noticias, destacadas = [], informe, feeds, ahora = Date.now(), reglas = REGLAS }) {
  const limite = ahora - reglas.ventanaDias * DIA_MS;
  const enVentana = (n) => ms(n.fecha) >= limite;
  const errores = [];

  const boletines = noticias.filter((n) => n.bloque === 'boletines');
  const lista = noticias.filter((n) => n.bloque !== 'boletines');
  const todas = [...destacadas, ...lista];
  const ventana = todas.filter(enVentana);

  const contar = (items, clave) => {
    const cuenta = {};
    for (const n of items) cuenta[clave(n)] = (cuenta[clave(n)] ?? 0) + 1;
    return cuenta;
  };

  const porMedio = contar(ventana, (n) => n.fuente);
  const porCategoria = contar(ventana, (n) => n.categoria ?? '(sin categoría)');
  const porLaboratorio = Object.fromEntries(reglas.laboratorios.map((l) => [l, 0]));
  for (const n of ventana) if (n.laboratorio in porLaboratorio) porLaboratorio[n.laboratorio] += 1;

  // Regla 1
  const porEvento = contar(todas.filter((n) => n.evento), (n) => n.evento);
  for (const [evento, cuantas] of Object.entries(porEvento)) {
    if (cuantas > reglas.maxPorEvento) errores.push(`Regla 1: el evento "${evento}" aparece ${cuantas} veces (máx. ${reglas.maxPorEvento})`);
  }
  // Regla 2
  for (const [medio, cuantas] of Object.entries(porMedio)) {
    if (cuantas > reglas.maxPorMedio) errores.push(`Regla 2: "${medio}" tiene ${cuantas} noticias en ${reglas.ventanaDias} días (máx. ${reglas.maxPorMedio})`);
  }
  // Regla 3
  const excepciones = [];
  for (const lab of reglas.laboratorios) {
    const datos = informe?.laboratorios?.[lab];
    if (porLaboratorio[lab] >= 1) continue;
    if (!datos || datos.candidatas === 0) {
      excepciones.push(`${lab}: sin candidatas con relevancia >= ${reglas.relevanciaMinimaLab} en la ventana`);
    } else if (datos.motivo) {
      excepciones.push(`${lab}: ${datos.motivo}`);
    } else {
      errores.push(`Regla 3: ${lab} tiene ${datos.candidatas} candidata(s) en la ventana y ninguna noticia`);
    }
  }
  // Regla 4
  const prensa = porCategoria.prensa ?? 0;
  if (ventana.length > 0 && prensa / ventana.length > reglas.maxPrensa) {
    errores.push(`Regla 4: la prensa generalista es ${prensa} de ${ventana.length} (${Math.round((100 * prensa) / ventana.length)}%, máx. ${reglas.maxPrensa * 100}%)`);
  }
  // Regla 5
  const enlacesDestacadas = new Set(destacadas.map((n) => n.enlace));
  for (const n of lista) {
    if (enlacesDestacadas.has(n.enlace)) errores.push(`Regla 5: "${n.titulo.slice(0, 60)}" está en Destacadas y también en la lista`);
  }
  if (destacadas.length > reglas.maxDestacadas) errores.push(`Destacadas: hay ${destacadas.length} (máx. ${reglas.maxDestacadas})`);
  // Regla 6
  const semanales = new Set(feeds.filter((f) => f.semanal).map((f) => f.name));
  for (const n of lista) {
    if (semanales.has(n.fuente)) errores.push(`Regla 6: "${n.fuente}" es un boletín semanal y aparece en la lista principal`);
  }
  for (const n of boletines) {
    if (!semanales.has(n.fuente)) errores.push(`Regla 6: "${n.fuente}" está en el bloque de boletines pero no es semanal`);
  }
  const boletinesPorFuente = contar(boletines, (n) => n.fuente);
  for (const [fuente, cuantas] of Object.entries(boletinesPorFuente)) {
    if (cuantas > 1) errores.push(`Regla 6: el boletín "${fuente}" aparece ${cuantas} veces (solo el último número)`);
  }
  // Umbral de relevancia (salvo la excepción de los laboratorios)
  for (const n of lista) {
    const minimo = n.laboratorio ? reglas.relevanciaMinimaLab : reglas.relevanciaMinima;
    if (n.relevancia !== undefined && n.relevancia < minimo) errores.push(`Relevancia: "${n.titulo.slice(0, 60)}" tiene ${n.relevancia} (mínimo ${minimo})`);
  }

  return { errores, excepciones, tablas: { porMedio, porCategoria, porLaboratorio }, totales: { ventana: ventana.length, lista: lista.length, destacadas: destacadas.length, boletines: boletines.length } };
}
