# última hora IAs

Recoge noticias de **seguridad de la IA** de laboratorios, organizaciones de seguridad y gobernanza, boletines y prensa, las traduce al español y las publica en una página con todo lo de los últimos 7 días, por fecha.

**Ningún modelo decide qué se publica.** Haiku 4.5 solo traduce.

## Cómo funciona

1. **Fuentes** (`feeds.js`, el único archivo de configuración). Cada una tiene nombre, url y categoría:
   - `laboratorio`: feeds oficiales (OpenAI, Google DeepMind, Mistral) y búsquedas de Google News para Anthropic, OpenAI, Google DeepMind, Meta AI, xAI, Moonshot y DeepSeek. Pasan sin filtro.
   - `seguridad`: METR, Alignment Forum, LessWrong, FLI, MIRI, Redwood, CSET y, por Google News, Epoch AI, Helen Toner, Miles Brundage, GovAI, Apollo Research y el AI Security Institute. Pasan sin filtro.
   - `boletin`: AI Safety Newsletter (CAIS), Import AI, Zvi, Transformer, ML Safety Newsletter y AI Snake Oil. Pasan sin filtro. Los feeds de `*.substack.com` devuelven 403 al runner de GitHub (Substack bloquea las IPs de datacenter): por eso Zvi usa su espejo de WordPress y Epoch, Toner y Brundage van por Google News.
   - `prensa`: Guardian, Wired, NYT, FT, Politico, TechCrunch, MIT Technology Review, El País, Euronews, Xataka y BBC Mundo.
2. **Ingesta** (`scraper.js`): descarga todos los feeds con 2 reintentos y registra cuántos ítems devuelve cada uno.
3. **Filtro** (`pipeline.js`): solo la prensa pasa por una lista de palabras clave: nombres de laboratorios y modelos, o bien contexto de IA junto a una palabra de seguridad, riesgo, alineación, control, regulación, incidente, evaluación, AI Act, AISI... Nada se descarta por puntuación ni por decisión de un modelo.
4. **Duplicados**: solo exactos (misma URL o mismo título normalizado). No se agrupa por evento ni hay topes por medio.
5. **Traducción** (`traduccion.js`): Haiku 4.5 traduce título y resumen una sola vez por noticia, con caché por hash de URL en `data/cache-traducciones.json`. Lo que ya está en español no se traduce.
6. **Publicación**: todo lo recibido en los últimos 7 días, por fecha descendente. La página (`index.html`) agrupa por día y tiene chips por categoría, un selector de medio y la opción de agrupar por medio. En Google News el medio que se muestra es el de "vía".
7. **Histórico**: cada ejecución archiva también lo publicado (mismo filtro, sin duplicar) en `data/historico/AAAA-MM.json`, un fichero por mes. La página tiene un buscador por palabra clave (título o resumen, en todo el histórico) y por fecha (un día o toda su semana), que pide bajo demanda solo los meses que hace falta.

## Datos generados (`data/`)

| Archivo | Contenido |
|---|---|
| `latest.json` | Las noticias publicadas: `medio`, `fuente`, `categoria`, `laboratorio`, `titulo`, `resumen`, `enlace`, `fecha`, `idioma` |
| `informe-latest.json` | Ítems recibidos por feed, feeds vacíos o caídos, recuento de las últimas 24 h, descartes y estadísticas de traducción |
| `cache-traducciones.json` | Traducciones ya hechas, por hash de URL |
| `historico/AAAA-MM.json` | Archivo acumulado (sin duplicar) de todo lo publicado ese mes, mismo formato que `latest.json` |
| `historico/indice.json` | Lista de los meses disponibles en `historico/`, para que la web sepa qué ficheros pedir |

## Requisitos

- Node.js 18 o superior.
- Una clave de la API de Anthropic, solo para traducir. Sin ella las noticias se publican sin traducir.

```bash
npm install
cp .env.example .env    # y añade ANTHROPIC_API_KEY=sk-ant-...
npm start               # node scraper.js
```

Si tu clave no está vinculada a un workspace, añade también `ANTHROPIC_WORKSPACE_ID` en `.env`.

## Ensayos sin gastar nada

```bash
node scripts/probar.mjs                                   # pruebas offline, sin red ni API
node scraper.js --capturar=/tmp/fixture.json              # guarda los feeds reales (solo peticiones HTTP)
node scraper.js --fixture=/tmp/fixture.json --traduccion-simulada --datos=/tmp/datos
DATOS_DIR=/tmp/datos node scripts/verificar.mjs
```

## Verificación

`scripts/verificar.mjs` imprime las tablas de noticias por categoría, por medio y por laboratorio y el recuento de ítems por feed, y sale con error si:

- algún feed configurado devuelve 0 ítems, o uno que ayer devolvía ítems hoy devuelve 0;
- no hay ninguna noticia de las últimas 24 horas habiéndolas en los feeds que pasan el filtro;
- la publicación es incoherente (duplicados, fuera de la ventana, sin ordenar, sin campos);
- queda algo sin traducir.

## Ejecución automática

El Action (`.github/workflows/scraper.yml`) corre cada día (cron a las 08:00 UTC, que GitHub suele retrasar varias horas) o a mano desde Actions. Ejecuta el scraper, verifica el contenido (si falla no se publica nada), abre un PR con los datos y lo fusiona; GitHub Pages republica en 1-2 minutos. Después comprueba feeds y traducción: si algo falla, el workflow termina en rojo y GitHub avisa, sin impedir la publicación de lo demás. `main` no debe exigir aprobaciones en los PR (Settings → Branches).

Hace falta el secret `ANTHROPIC_API_KEY` en Settings → Secrets and variables → Actions. Con Haiku 4.5 y la caché el coste es de céntimos al mes: solo se paga por lo que aún no está traducido.

## Estructura

```
ultima-hora-ias/
├── .github/workflows/scraper.yml  # scraper, verificación, PR y fusión diarios
├── feeds.js                       # fuentes con su categoría
├── pipeline.js                    # filtro de prensa, duplicados, ventana de 7 días
├── traduccion.js                  # traducción con caché (traductor inyectable)
├── scraper.js                     # ingesta, traducción con Haiku y guardado
├── scripts/                       # verificar.mjs y probar.mjs
├── index.html                     # la página (incluye el buscador)
└── data/                          # datos generados, versionados en git
    └── historico/                 # archivo mensual para la búsqueda por fecha/palabra clave
```
