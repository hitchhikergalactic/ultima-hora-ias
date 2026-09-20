# última hora IAs

Scraper que recolecta noticias sobre inteligencia artificial desde varios feeds RSS —tanto prensa en español (Xataka, Genbeta, El País Tecnología, BBC Mundo, Euronews Next), prensa de referencia y general en inglés (The New York Times, The Guardian, Financial Times, Politico, TechCrunch, VentureBeat, Wired, MIT Technology Review, The Verge), laboratorios (OpenAI, Google DeepMind) como fuentes especializadas en seguridad de la IA (Future of Life Institute, CAIS Newsletter, Transformer, Import AI)—, filtra las que tratan sobre **AI safety** (riesgos, alineamiento, evaluaciones, gobernanza y regulación) y las guarda **traducidas al 100% al español**.

## Requisitos

- Node.js 18 o superior
- Una clave de la API de Anthropic (necesaria para filtrar/traducir las noticias y para seleccionar las destacadas; si no está configurada, esos pasos se saltan con un aviso y se guardan las noticias sin filtrar ni traducir)

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

1. **Puntuación (Claude):** puntúa TODAS las noticias de 1 a 5 según su relevancia para AI safety (5 = incidente o riesgo grave; 4 = claramente AI safety; 3 = lo menciona pero el tema es otro; 2 = IA sin relación con la seguridad; 1 = nada que ver) y etiqueta con su historia las de 4 o 5. Solo se conservan las que llegan a `RELEVANCIA_MINIMA` (4, en `scraper.js`); subirla acorta y endurece la lista.
2. **Repetidas y topes (código):** si varias fuentes cuentan la misma historia se conserva una, la de la fuente de mayor `prioridad`, y de la prensa general se guardan como máximo `maxPorDia` por fuente, las de más relevancia.
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

Si un feed falla (por red, cambio de URL, etc.) se muestra un aviso en consola y el scraper continúa con el resto sin interrumpirse. Si falla la llamada a Anthropic para filtrar/traducir (o falta `ANTHROPIC_API_KEY`), se avisa por consola y se guardan las noticias tal cual, sin filtrar ni traducir.

Además, sobre ese conjunto ya filtrado y traducido, el scraper selecciona entre 2 y 3 noticias destacadas y genera un resumen de cada una. El resultado se guarda en:

- `data/destacadas-YYYY-MM-DD.json`
- `data/destacadas-latest.json`

Si `ANTHROPIC_API_KEY` no está configurada o la llamada falla, se muestra un aviso y el resto del scraper no se ve afectado.

## Añadir o quitar fuentes

Edita el array `feeds` en `feeds.js`:

```js
export const feeds = [
  { name: 'Nombre de la fuente', idioma: 'es', url: 'https://ejemplo.com/feed' },
  // ...
];
```

- `idioma` (`'es'` o `'en'`): idioma original de la fuente. La página muestra primero las noticias en español y después las internacionales.
- `prioridad` (1-3): si varias fuentes cuentan lo mismo se conserva la de menor número. 1 = fuente original (laboratorios, organizaciones de AI safety), 2 = prensa de referencia, 3 = prensa tecnológica general.
- `maxPorDia` (opcional): tope de noticias que se conservan de esa fuente tras filtrar. Se usa en la prensa general para que una cabecera no llene la lista. Si un sitio rechaza el user agent por defecto (VentureBeat da 429, Euronews 406 a los de navegador), se puede fijar uno por fuente con `userAgent`.

## Ejecución automática

El scraper corre solo todos los días mediante el GitHub Action definido en
`.github/workflows/scraper.yml` (cron diario a las 08:00 UTC, o manualmente
desde la pestaña Actions con "Run workflow"). Cada ejecución abre un pull
request con las noticias del día; no comitea directo a `main` y el merge
requiere aprobación manual.

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
├── scraper.js                     # lógica de descarga y guardado de noticias
├── feeds.js                       # lista de fuentes RSS
├── package.json
└── data/                          # noticias generadas, versionadas en git
```
