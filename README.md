# última hora IAs

Scraper que recolecta noticias sobre inteligencia artificial desde varios feeds RSS —tanto prensa en español (Xataka, Genbeta, El País Tecnología, BBC Mundo, Euronews Next), prensa de referencia y general en inglés (The New York Times, The Guardian, Financial Times, Politico, TechCrunch, VentureBeat, Wired, MIT Technology Review, The Verge), laboratorios (OpenAI, Google DeepMind) como fuentes especializadas en seguridad de la IA (Future of Life Institute, CAIS Newsletter, Transformer, Import AI)—, filtra las que tratan sobre **AI safety** (riesgos, alineamiento, evaluaciones, gobernanza y regulación) y las guarda **traducidas al 100% al español**.

## Requisitos

- Node.js 18 o superior
- Una clave de la API de Anthropic (necesaria para filtrar/traducir las noticias y para seleccionar las destacadas; sin ella el scraper termina con error y no guarda nada)

## Instalación

```bash
npm install
cp .env.example .env
```

Edita `.env` (nunca lo subas a git, ya está en `.gitignore`) y añade tu clave:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Si tu clave no está vinculada a un workspace, la API devolverá un error `invalid_request_error` pidiendo un `anthropic-workspace-id`. En ese caso añade también en `.env` el ID del workspace (lo encuentras en la URL de `console.anthropic.com` dentro del workspace correspondiente):

```
ANTHROPIC_WORKSPACE_ID=wrkspc_...
```

## Uso

```bash
npm start
```

o directamente:

```bash
node scraper.js
```

Esto descarga hasta 30 entradas por cada feed definido en `feeds.js` y las procesa en tres pasos:

1. **Puntuación (Claude):** puntúa TODAS las noticias de 1 a 5 según su relevancia para AI safety (5 = incidente o riesgo grave; 4 = claramente AI safety; 3 = lo menciona pero el tema es otro; 2 = IA sin relación con la seguridad; 1 = nada que ver) y asigna un **evento** a las de 3, 4 o 5: las noticias sobre el mismo hecho comparten identificador.
2. **Reglas de diversidad (código, `reglas.js`):** se aplican en código y no en el prompt (ver más abajo).
3. **Traducción (Claude):** solo las que sobreviven, y solo las de fuentes que no están en español.

Genera dos archivos dentro de `data/`:

- `data/noticias-YYYY-MM-DD.json` — snapshot del día, ya filtrado a AI safety y en español
- `data/latest.json` — siempre contiene la ejecución más reciente

Cada noticia tiene esta forma:

```json
{
  "fuente": "TechCrunch AI",
  "titulo": "...",
  "enlace": "https://...",
  "fecha": "2026-09-12T18:00:00.000Z",
  "resumen": "...",
  "idioma": "en"
}
```

Si un feed falla (por red, cambio de URL, etc.) se muestra un aviso en consola y el scraper continúa con el resto sin interrumpirse. Si falla la llamada a Anthropic para puntuar o traducir (o falta `ANTHROPIC_API_KEY`), o si ningún feed devuelve noticias, el scraper termina con error y **no guarda nada**: en el Action eso hace que no se abra el PR del día y la web conserve las noticias buenas del último PR fusionado, en vez de publicar noticias sin filtrar ni traducir.

Además, sobre ese conjunto ya filtrado y traducido, el scraper selecciona entre 2 y 3 noticias destacadas y genera un resumen de cada una. El resultado se guarda en:

- `data/destacadas-YYYY-MM-DD.json`
- `data/destacadas-latest.json`

Si `ANTHROPIC_API_KEY` no está configurada o la llamada falla, se muestra un aviso y el resto del scraper no se ve afectado.

## Añadir o quitar fuentes

Edita el array `feeds` en `feeds.js`:

```js
export const feeds = [
  { name: 'Nombre de la fuente', idioma: 'es', categoria: 'prensa', prioridad: 2, url: 'https://ejemplo.com/feed' },
  // ...
];
```

- `idioma` (`'es'` o `'en'`): idioma original de la fuente. La página muestra primero las noticias en español y después las internacionales.
- `categoria`: `'laboratorio'` (blog oficial de un laboratorio o, si no tiene RSS oficial, búsqueda de Google News sobre él), `'seguridad'` (organizaciones y boletines de AI safety) o `'prensa'` (medios generalistas).
- `laboratorio` (opcional): laboratorio al que se refiere la fuente; cuenta para la regla 3.
- `semanal` (opcional): boletín semanal. Va en un bloque aparte de la página, solo con su último número.
- `prioridad` (1-3): si varias fuentes cuentan lo mismo, gana la de menor número. 1 = fuente original, 2 = prensa de referencia, 3 = prensa general o cobertura de terceros.
- `googleNews` y `terminos` (opcionales): para búsquedas de Google News. El titular debe nombrar alguno de los `terminos` para que la noticia cuente como del laboratorio; si no, pasa a prensa generalista.
- `userAgent` (opcional): algunos sitios rechazan el user agent por defecto (VentureBeat da 429 y Euronews 406 a los de navegador).

Anthropic, Meta, xAI, Moonshot y DeepSeek no tienen RSS oficial de noticias (se comprobó con peticiones reales), por eso usan Google News.

## Reglas de diversidad

Se aplican en `reglas.js` sobre la ventana de los últimos 7 días (la que la página muestra por defecto). Las noticias más antiguas solo pasan el umbral de relevancia y la regla 1.

1. Como máximo 1 noticia por evento: la de mayor puntuación (a igualdad, la fuente más original).
2. Como máximo 2 noticias por medio.
3. Al menos 1 noticia por laboratorio (Anthropic, OpenAI, Google DeepMind, Meta, xAI, Moonshot) si existe alguna candidata en la ventana con relevancia >= 3. No se rellena con noticias sin relación con la seguridad: si no hay candidata, no se añade nada.
4. La prensa generalista es como máximo el 50% de la ventana.
5. Lo que sale en Destacadas no se repite en la lista.
6. Los boletines semanales (AI Safety Newsletter de CAIS, Import AI) van en un bloque aparte, fuera del corte por fechas y de "Mostrando N de M". Solo se conserva el último número.

Los parámetros están en `REGLAS` (`reglas.js`).

### Verificación

```bash
node scripts/probar-reglas.mjs        # pruebas offline con datos inventados
node scripts/verificar.mjs            # comprueba las reglas sobre data/ y falla si se incumple alguna
node scripts/verificar.mjs --feeds    # falla si algún feed devolvió 0 ítems
```

`verificar.mjs` imprime las tablas de noticias por medio, por categoría y por laboratorio. En el Action se ejecuta antes de publicar (si falla no se abre el PR) y, con `--feeds`, después de publicar: si algún feed devuelve 0 ítems el workflow termina en rojo y GitHub avisa, sin impedir la publicación del resto.

## Ejecución automática

El scraper corre solo todos los días mediante el GitHub Action definido en
`.github/workflows/scraper.yml` (cron diario a las 08:00 UTC, aunque GitHub
suele retrasarlo varias horas, o manualmente desde la pestaña Actions con
"Run workflow"). Cada ejecución abre un pull request con las noticias del día
y lo fusiona a `main` automáticamente; GitHub Pages republica la web en 1-2
minutos. Si el scraper falla (sin saldo en la API, feeds caídos...) el
workflow termina con error, no se abre ni se fusiona ningún PR y la web
conserva las últimas noticias buenas. Para que la fusión automática funcione,
`main` no debe exigir aprobaciones en los pull requests (Settings → Branches).

Para que funcione hace falta configurar el secret `ANTHROPIC_API_KEY` (y
opcionalmente `ANTHROPIC_WORKSPACE_ID`) en Settings → Secrets and
variables → Actions del repositorio.

No uses además un cron local para esta misma tarea: ejecutar el scraper
dos veces al día (local + Action) duplica las llamadas a la API de
Anthropic sin ningún beneficio.

## Estructura del proyecto

```
ultima-hora-ias/
├── .github/workflows/scraper.yml  # Action que ejecuta el scraper y abre el PR diario
├── scraper.js                     # descarga, puntuación, traducción y guardado
├── reglas.js                      # reglas de diversidad (código puro, sin API)
├── feeds.js                       # lista de fuentes con su categoría
├── scripts/                       # verificar.mjs y probar-reglas.mjs
├── package.json
└── data/                          # noticias generadas, versionadas en git
```
