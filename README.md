# última hora IAs

Scraper que recolecta noticias sobre inteligencia artificial desde varios feeds RSS (TechCrunch, VentureBeat, Wired, MIT Technology Review, The Verge, Xataka, Genbeta y Google AI Blog) y las guarda en formato JSON.

## Requisitos

- Node.js 18 o superior
- Una clave de la API de Anthropic en la variable de entorno `ANTHROPIC_API_KEY` (necesaria para la selección y resumen de noticias destacadas; si no está configurada, ese paso se salta con un aviso y el resto del scraper sigue funcionando)

## Instalación

```bash
npm install
```

## Uso

```bash
npm start
```

o directamente:

```bash
node scraper.js
```

Esto descarga las últimas entradas de cada feed definido en `feeds.js` y genera dos archivos dentro de `data/`:

- `data/noticias-YYYY-MM-DD.json` — snapshot de las noticias del día
- `data/latest.json` — siempre contiene la ejecución más reciente

Cada noticia tiene esta forma:

```json
{
  "fuente": "TechCrunch AI",
  "titulo": "...",
  "enlace": "https://...",
  "fecha": "2026-09-12T18:00:00.000Z",
  "resumen": "..."
}
```

Si un feed falla (por red, cambio de URL, etc.) se muestra un aviso en consola y el scraper continúa con el resto sin interrumpirse.

Además, usando la API de Anthropic (Claude), el scraper selecciona entre 2 y 3 noticias destacadas y genera un resumen de cada una, siempre en español (traduciendo el contenido si la fuente original está en otro idioma). El resultado se guarda en:

- `data/destacadas-YYYY-MM-DD.json`
- `data/destacadas-latest.json`

Si `ANTHROPIC_API_KEY` no está configurada o la llamada falla, se muestra un aviso y el resto del scraper no se ve afectado.

## Añadir o quitar fuentes

Edita el array `feeds` en `feeds.js`:

```js
export const feeds = [
  { name: 'Nombre de la fuente', url: 'https://ejemplo.com/feed' },
  // ...
];
```

## Ejecución automática con cron

Para que el scraper corra solo todos los días (por ejemplo, a las 08:00), añade una entrada a tu `crontab`:

```bash
crontab -e
```

```
0 8 * * * cd /ruta/a/ultima-hora-ias && /opt/homebrew/bin/node scraper.js >> scraper.log 2>&1
```

Ajusta la ruta del proyecto y la ruta de `node` (`which node`) a tu sistema. Los logs de cada ejecución quedan en `scraper.log` (ignorado por git).

## Estructura del proyecto

```
ultima-hora-ias/
├── scraper.js      # lógica de descarga y guardado de noticias
├── feeds.js        # lista de fuentes RSS
├── package.json
└── data/           # noticias generadas (ignoradas en git, excepto .gitkeep)
```
