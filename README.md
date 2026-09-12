# última hora IAs

Scraper que recolecta noticias sobre inteligencia artificial desde varios feeds RSS (TechCrunch, VentureBeat, Wired, MIT Technology Review, The Verge, Xataka, Genbeta y Google AI Blog) y las guarda en formato JSON.

## Requisitos

- Node.js 18 o superior

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

## Añadir o quitar fuentes

Edita el array `feeds` en `feeds.js`:

```js
export const feeds = [
  { name: 'Nombre de la fuente', url: 'https://ejemplo.com/feed' },
  // ...
];
```

## Estructura del proyecto

```
ultima-hora-ias/
├── scraper.js      # lógica de descarga y guardado de noticias
├── feeds.js        # lista de fuentes RSS
├── package.json
└── data/           # noticias generadas (ignoradas en git, excepto .gitkeep)
```
