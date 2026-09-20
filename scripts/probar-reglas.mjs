// Pruebas de reglas.js con datos inventados (no llaman a la API).
//   node scripts/probar-reglas.mjs
import { REGLAS, seleccionarNoticias, verificarReglas } from '../reglas.js';

const AHORA = new Date('2026-09-20T12:00:00Z').getTime();
let fallos = 0;
const comprobar = (nombre, cumple, detalle = '') => {
  if (!cumple) fallos += 1;
  console.log(`${cumple ? 'OK   ' : 'FALLA'}  ${nombre}${cumple ? '' : `  -> ${detalle}`}`);
};

let contador = 0;
const N = (fuente, categoria, { rel = 5, evento, dias = 1, prioridad = 2, laboratorio, semanal } = {}) => {
  contador += 1;
  return {
    fuente,
    categoria,
    titulo: `${fuente} ${contador}`,
    enlace: `https://ejemplo.com/${contador}`,
    fecha: new Date(AHORA - dias * 86400000).toISOString(),
    resumen: 'x',
    prioridad,
    relevancia: rel,
    evento: evento ?? `evento-${contador}`,
    ...(laboratorio ? { laboratorio } : {}),
    ...(semanal ? { semanal: true } : {}),
  };
};
const seleccionar = (items) => seleccionarNoticias(items, { ahora: AHORA });
const contar = (lista, f) => lista.filter(f).length;

// Regla 1: un evento, la noticia mejor (más relevancia; a igualdad, fuente más original)
{
  const { lista } = seleccionar([
    N('NYT', 'prensa', { evento: 'gemini', rel: 4 }),
    N('FT', 'prensa', { evento: 'gemini', rel: 5, prioridad: 2 }),
    N('The Verge', 'prensa', { evento: 'gemini', rel: 5, prioridad: 3 }),
    N('CAIS', 'seguridad'), N('FLI', 'seguridad'), // sin no-prensa, la regla 4 vaciaría la lista
  ]);
  const gemini = lista.filter((n) => n.evento === 'gemini');
  comprobar('R1: un solo item por evento', gemini.length === 1, `quedan ${gemini.length}`);
  comprobar('R1: gana la de mayor relevancia y, a igualdad, la fuente más original', gemini[0]?.fuente === 'FT', gemini[0]?.fuente);
}

// Regla 2: máx. 2 por medio en la ventana (las mejores)
{
  const items = [1, 2, 3, 4, 5].map((r) => N('Politico', 'prensa', { rel: r === 1 ? 4 : 5 }));
  const otros = [N('CAIS', 'seguridad'), N('FLI', 'seguridad'), N('Transformer', 'seguridad'), N('Import', 'seguridad'), N('Otro', 'seguridad')];
  const { lista } = seleccionar([...items, ...otros]);
  comprobar('R2: máx. 2 por medio', contar(lista, (n) => n.fuente === 'Politico') === 2, `Politico=${contar(lista, (n) => n.fuente === 'Politico')}`);
  comprobar('R2: se quedan las mejores (no la de relevancia 4)', lista.filter((n) => n.fuente === 'Politico').every((n) => n.relevancia === 5));
}

// Regla 2 solo en la ventana: lo antiguo no se recorta por medio
{
  const viejas = [1, 2, 3, 4].map((i) => N('FLI', 'seguridad', { dias: 60 + i }));
  const { lista } = seleccionar(viejas);
  comprobar('R2: fuera de la ventana no se aplica el tope por medio', lista.length === 4, `quedan ${lista.length}`);
}

// Regla 3: laboratorio con evento ya cubierto por prensa -> lo sustituye, sin duplicar el evento
{
  const { lista, informe } = seleccionar([
    N('NYT', 'prensa', { evento: 'xai-grok', rel: 5 }),
    N('xAI (Google News)', 'laboratorio', { evento: 'xai-grok', rel: 3, laboratorio: 'xAI', prioridad: 3 }),
    N('CAIS', 'seguridad'), N('FLI', 'seguridad'),
  ]);
  comprobar('R3: xAI queda representado', contar(lista, (n) => n.laboratorio === 'xAI') === 1);
  comprobar('R3: el evento no se duplica', contar(lista, (n) => n.evento === 'xai-grok') === 1);
  comprobar('R3: informe marca xAI como colocada', informe.laboratorios.xAI.colocada === true);
}
// Regla 3: nada de relleno con relevancia baja ni sin candidatas
{
  const { lista, informe } = seleccionar([
    N('OpenAI News', 'laboratorio', { rel: 2, laboratorio: 'OpenAI', prioridad: 1 }),
    N('CAIS', 'seguridad'), N('FLI', 'seguridad'),
  ]);
  comprobar('R3: no se añade una noticia de laboratorio con relevancia < 3', contar(lista, (n) => n.laboratorio === 'OpenAI') === 0);
  comprobar('R3: informe indica 0 candidatas', informe.laboratorios.OpenAI.candidatas === 0);
}
// Regla 3: laboratorio con noticia de relevancia 3 y sin evento compartido -> se añade
{
  const { lista } = seleccionar([
    N('Meta AI (Google News)', 'laboratorio', { rel: 3, laboratorio: 'Meta', prioridad: 3 }),
    N('CAIS', 'seguridad'), N('FLI', 'seguridad'),
  ]);
  comprobar('R3: Meta con relevancia 3 y sin choque se incluye', contar(lista, (n) => n.laboratorio === 'Meta') === 1);
}

// Regla 4: prensa <= 50%
{
  const prensa = [1, 2, 3, 4, 5, 6].map((i) => N(`Medio${i}`, 'prensa'));
  const otros = [N('CAIS', 'seguridad'), N('FLI', 'seguridad')];
  const { lista } = seleccionar([...prensa, ...otros]);
  const p = contar(lista, (n) => n.categoria === 'prensa');
  comprobar('R4: la prensa no supera el 50%', p / lista.length <= 0.5, `${p} de ${lista.length}`);
  comprobar('R4: se conserva la máxima cantidad de prensa permitida', p === 2, `p=${p}`);
}

// Regla 6: boletines aparte, solo el último número
{
  const { lista, boletines } = seleccionar([
    N('AISN (CAIS)', 'seguridad', { semanal: true, dias: 20 }),
    N('AISN (CAIS)', 'seguridad', { semanal: true, dias: 3 }),
    N('AISN (CAIS)', 'seguridad', { semanal: true, dias: 10 }),
    N('FLI', 'seguridad'),
  ]);
  comprobar('R6: los boletines no entran en la lista', contar(lista, (n) => n.fuente === 'AISN (CAIS)') === 0);
  comprobar('R6: solo el último número de cada boletín', boletines.length === 1 && new Date(boletines[0].fecha).getTime() === AHORA - 3 * 86400000);
}

// Umbral de relevancia
{
  const { lista } = seleccionar([N('FLI', 'seguridad', { rel: 3 }), N('CAIS', 'seguridad', { rel: 4 })]);
  comprobar('Umbral: relevancia 3 fuera, 4 dentro', lista.length === 1 && lista[0].fuente === 'CAIS');
}

// verificarReglas: acepta un resultado correcto...
const FEEDS = [{ name: 'AISN (CAIS)', semanal: true }, { name: 'FLI' }, { name: 'NYT' }];
const informeOk = { laboratorios: Object.fromEntries(REGLAS.laboratorios.map((l) => [l, { candidatas: 0, colocada: false }])) };
const verificar = (noticias, destacadas = [], informe = informeOk) => verificarReglas({ noticias, destacadas, informe, feeds: FEEDS, ahora: AHORA });
{
  const ok = [N('FLI', 'seguridad'), N('FLI', 'seguridad'), N('NYT', 'prensa'), { ...N('AISN (CAIS)', 'seguridad', { semanal: true }), bloque: 'boletines' }];
  comprobar('Verificador: acepta datos que cumplen todas las reglas', verificar(ok).errores.length === 0, verificar(ok).errores.join(' | '));
}
// ... y detecta cada incumplimiento
const detecta = (nombre, noticias, prefijo, destacadas, informe) => {
  const errores = verificar(noticias, destacadas, informe).errores;
  comprobar(`Verificador: detecta ${nombre}`, errores.some((e) => e.startsWith(prefijo)), `errores: ${errores.join(' | ') || 'ninguno'}`);
};
detecta('evento repetido (R1)', [N('FLI', 'seguridad', { evento: 'a' }), N('NYT', 'prensa', { evento: 'a' })], 'Regla 1');
detecta('3 noticias de un medio (R2)', [N('FLI', 'seguridad'), N('FLI', 'seguridad'), N('FLI', 'seguridad')], 'Regla 2');
detecta('laboratorio con candidatas y sin noticia (R3)', [N('FLI', 'seguridad')], 'Regla 3', [], { laboratorios: { ...informeOk.laboratorios, Anthropic: { candidatas: 2, colocada: false } } });
detecta('prensa por encima del 50% (R4)', [N('FLI', 'seguridad'), N('NYT', 'prensa'), N('NYT', 'prensa')], 'Regla 4');
{
  const repetida = N('FLI', 'seguridad');
  detecta('destacada repetida en la lista (R5)', [repetida], 'Regla 5', [repetida]);
}
detecta('boletín semanal en la lista principal (R6)', [N('AISN (CAIS)', 'seguridad', { semanal: true })], 'Regla 6');
detecta('relevancia por debajo del umbral', [N('FLI', 'seguridad', { rel: 3 })], 'Relevancia');

console.log(fallos === 0 ? '\nTodas las pruebas pasan.' : `\n${fallos} prueba(s) fallan.`);
process.exit(fallos === 0 ? 0 : 1);
