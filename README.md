# Piano Sheets

Lightweight sheet-music library and viewer, optimized for iPad and mobile Safari/Chrome. It serves PDFs from a local folder, generates/caches thumbnails on the server, and provides a smooth, single-button auto-scroll experience in the browser.

## Highlights

- Fast library (grid/list) with search, favorites, categories, and pagination
- Server-side thumbnail generation and caching for instant browsing
- Mobile-first viewer with single Play/Pause button (includes Screen-On behavior)
- Auto-scroll per page with per-file “seconds per page” setting
- iPad-optimized wake lock and scrolling behavior, resilient under low memory

## Target devices

- iPad / iPadOS Safari and Chrome (primary target)
- Desktop Safari/Chrome/Edge

The app is designed to be used on stage or during rehearsals: simple controls, robust performance, low memory usage.

---

## Project structure

```
.
├── server.js                # Express server, APIs, thumbnail generation
├── public/                  # Client app (index.html + UI/logic)
├── sheets/                  # Your PDF files (subfolders supported)
├── data/
│   ├── config.json          # Persisted favorites, per-file settings, categories
│   ├── thumbnails/          # Generated thumbnail cache (mirrors sheets/ layout)
│   └── vendor/              # Locally cached vendor scripts (pdf.js, fuse.js, nosleep)
├── package.json             # Scripts and dependencies
└── start-optimized.sh       # Optional optimized start script (macOS)
```

## Data model and persistence

All user data is stored locally on disk:

- data/config.json
  - favorites: string[] of PDF relative paths
  - files: { [relPath: string]: { secsPerPage?: number, categories?: string[] } }
  - categories: { id: string, name: string, color: string, icon: string }[]
- data/thumbnails/
  - Server-side JPEG thumbnails, refreshed when the source PDF changes (mtime) and aged out after 7 days.
- sheets/
  - Your actual PDFs. You can organize them in subfolders.

The server watches the sheets/ directory and refreshes its index automatically.

## Installation

Requirements:
- Node.js >= 16
- macOS, Linux, or Windows (thumbnail generation benefits from having native deps)

Install dependencies:

```bash
npm install
```

If canvas/sharp fail to build on your platform, you can try:

```bash
npm run install:deps
```

Notes for macOS users (if canvas fails):
- Ensure Xcode command-line tools are installed
- Optionally: `brew install pkg-config cairo pango libpng jpeg giflib` (for canvas)

## Running

Standard start:

```bash
npm start
```

Optimized start (recommended for iPad usage — includes extra Node flags and a tuned process):

```bash
npm run start:optimized
```

Explicit memory sizing:

```bash
npm run start:memory
```

The server starts on http://localhost:3000 by default. Place your PDFs under `sheets/` and open the app in your browser.

## Client features

- Library (grid/list) with:
  - Search by name
  - Sort by name, last modified, size
  - Pagination (page size capped for memory efficiency) or “all”
  - Favorites toggle
  - Category filter bar
  - Upload dialog (PDF only, supports initial secs/page, favorite, and categories)
- Cards include thumbnail, details, category chips, a favorite star, and a small “+” button to assign categories.
- Viewer:
  - Single Play/Pause button: starts auto-scroll and locks the screen (iOS-safe gesture handling)
  - Fullscreen button
  - Seconds per page input (persisted per file)
  - Smooth mobile scrolling; auto-scroll recalibrates as pages render

## APIs

Public static:
- `GET /` -> `public/index.html`
- `GET /sheets/<path>.pdf` -> Serves PDFs (range requests supported, size capped per range)
- `GET /thumbnails/<path>.jpg` -> Serves/generated thumbnails (JPEG)
- `GET /vendor/...` -> Locally cached vendor scripts (pdf.js, fuse.js, nosleep)

System/monitoring:
- `GET /api/system/memory` -> Server memory snapshot
- `POST /api/system/gc` -> Trigger GC (requires `--expose-gc`)
- `POST /api/system/cache/clear` -> Clear in-memory index

Library:
- `GET /api/sheets?q=&sort=&order=&page=&pageSize=&fav=&category=`
  - Returns `{ items, total, page, pageSize, categories, activeCategories, serverMemory }`

Upload:
- `POST /api/upload`
  - Headers:
    - `Content-Type: application/pdf`
    - `X-Upload-Name: <original filename>` (optional)
    - `X-Upload-Meta: { "secsPerPage": number, "favorite": boolean, "categories": [id] }` (JSON)
  - Body: raw PDF bytes
  - Response: `{ ok, item, favorites, maxUploadBytes }`

Preferences (favorites + per-file settings):
- `GET /api/prefs` -> Full config
- `POST /api/prefs/favorites` -> `{ name, favorite }`
- `GET /api/prefs/file?name=<rel>` -> `{ name, secsPerPage, categories, categoryIds }`
- `POST /api/prefs/file` -> `{ name, secsPerPage?, categories? }`

Categories:
- `GET /api/categories` -> `{ categories }`
- `POST /api/categories` -> create `{ name, color, icon }`
- `PUT /api/categories/:id` -> update `{ name?, color?, icon? }`
- `DELETE /api/categories/:id`

## How it works

Server
- Scans `sheets/` recursively and caches an index (with file size/mtime, folder info).
- Generates thumbnails on demand using pdf.js + canvas and optionally optimizes them with sharp; stores them under `data/thumbnails/` mirroring the structure of `sheets/`.
- Caches vendor scripts locally inside `data/vendor/` to support offline/poor-network scenarios.
- Persists favorites, per-file seconds-per-page, and categories in `data/config.json` with queued, atomic writes.

Client
- Renders the library, category bar, and the viewer in `public/index.html` (single-page app).
- Uses pdf.js (worker served locally) to render pages and virtualizes page rendering with IntersectionObserver to keep memory low.
- On iPad, the Play button synchronously activates a screen-on strategy and starts auto-scroll. The scroll logic is resilient to late-rendering pages (keeps ticking and recalibrates speed).

## Configuration

Server (in `server.js`):

```js
const MEMORY_SETTINGS = {
  maxIndexCacheAge: 300000,
  maxVendorRetries: 3,
  maxStatConcurrency: 32,
  enableGzipCompression: true,
  thumbnailSize: 200,
  thumbnailQuality: 80,
  maxThumbnailAge: 7 * 24 * 60 * 60 * 1000
};
```

Client (in `public/index.html`): internal limits for thumbnail cache and memory management are tuned for iPad usage.

## Security and deployment

- No authentication/authorization is included — intended for local/network use you control.
- Run behind a reverse proxy if exposing on a network.
- PDFs and config live on disk; ensure filesystem permissions are appropriate.

## Troubleshooting

Thumbnails not generated
- Check logs for `pdf.js` and `canvas` availability. If missing, install via `npm run install:deps`.
- As a fallback, a tiny JPEG is stored to keep the UI working.

High memory usage
- Reduce `MEMORY_SETTINGS.maxStatConcurrency`.
- Keep pageSize small in the UI (avoid `all` on very large libraries on low-memory devices).

Wake lock / auto-scroll on iOS
- Ensure you start auto-scroll via the Play button (single gesture). The app uses a gesture-safe wake strategy and keeps trying to reacquire if the tab becomes visible again.

## License

MIT — see LICENSE (or adapt as needed for your deployment).