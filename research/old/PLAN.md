# Moodboard app ("mbrd") — implementation plan

## Context
Greenfield project in `C:\Users\kosta\Projekti\mbrd` (currently empty). Goal: a
**moodboarding** app with a seemingly infinite, freeform grid — origin `(0,0)` in
the center, extending both axes. The user drops in files of any type (image,
audio, video, text, anything); each gets **world coordinates** and can be placed
anywhere (like a desktop with *align-to-grid off*), or auto-arranged from the
center outward via selectable arrangements plus a custom/free mode.

It ships as a **web app** (browser + PWA) and is wrapped with **Tauri v2** for
Windows, Linux, Android, and iOS/iPadOS. UI is minimal, slightly rounded, and
highly themeable via CSS variables, with a left hamburger that opens a sidebar.

Persistence uses a custom **`.mbrd`** file: a renamed ZIP holding a manifest,
the board data, and the embedded asset bytes (same idea as `.3mf`). A self-hosted
sync option is planned but deliberately deferred.

Conventions mirror the sibling project `C:\Users\kosta\Projekti\file-analyser`:
vanilla JS + ES modules, **no bundler**, a Python `serve.py` launched by
`server.bat`, and a git/versioning helper `save.bat`.

## Locked decisions
- **Stack:** Vanilla JS + ES modules, no bundler. Native CSS variables for theming.
  Tauri points `frontendDist` at the static `web/` folder; no build step to sync.
- **Storage:** `.mbrd` = ZIP container. ~~Vendored `fflate`~~ — **built instead**
  as `storage/zip.js` (~200 lines) on the platform's own
  `CompressionStream('deflate-raw')`, so there is no vendored blob at all. Only
  the container (headers + CRC32) is hand-rolled; verified byte-for-byte against
  Python's `zipfile`. Working state cached in IndexedDB; explicit Save writes
  the `.mbrd`.
- **`.mbrd` in browser:** File System Access API (`showSaveFilePicker` /
  `showOpenFilePicker`) when available; fall back to download / file-input upload.
- **Big media:** embed all bytes by default. Schema reserves an `external` asset
  ref for a later "link instead of embed" setting — not built in M1.
- **First milestone:** web-first working PWA; Tauri wrap after the web app works.
- **Rendering:** DOM "world" layer with a single CSS transform for pan/zoom, so
  native `<img>/<video>/<audio>` and text just work; viewport culling for scale.

## Architecture

### Coordinate + viewport model (`canvas/viewport.js`)
- World coords are floats, origin `(0,0)` at center, oriented like a **maths
  plane**: `+x` right, `+y` **up**. Top-right quadrant is `(+,+)`, bottom-left
  `(-,-)`. Rotation `rot` is likewise anticlockwise-positive. Items store center
  `x,y`, size `w,h`, `rot`, and `z`.
- Viewport = `pan` (world point shown at screen center) + `zoom` (scale). Screen
  y points down, so the vertical axis carries a sign flip — confined to
  `viewport.js` and `items.js/place()`:
  - `screenX = (worldX - panX) * zoom + centerX`
  - `screenY = (panY - worldY) * zoom + centerY`
- Arrangements are authored in reading order (rows go *down*); `arrange()`
  negates y on the way in and out so each layout stays in the orientation it
  reads best in.
- `#world` is a single absolutely-positioned layer; pan/zoom applied as one
  `transform: translate(...) scale(...)` (GPU-friendly). Items are children in
  world coords. A "recenter to 0,0" and "zoom to fit" are provided.

### Background grid (`canvas/grid.js`)
- Visual only. Rendered on `#viewport` via layered `background-image` dot/line
  gradients whose `background-size = step * zoom` and `background-position`
  tracks `pan`. Minor + major layers. Grid style/opacity are theme tokens.

### Input & gestures (`canvas/input.js`, Pointer Events)
- Pan: drag empty space / middle-mouse / space+drag / two-finger touch.
- Zoom: wheel (zoom-to-cursor) / pinch / `+ -` keys.
- Select: click; marquee on empty drag. Move: drag selection (free placement,
  **no snap by default**; optional snap-to-grid toggle). Resize/rotate handles.
- Live cursor world-coordinate readout in a corner.

### Import (`import/drop.js`, `import/renderers.js`)
- Sources: HTML5 drag-drop (`dataTransfer.files`), clipboard paste, "Add files"
  button (file input on web / Tauri dialog on native), and dropping a `.mbrd`
  to open it.
- On drop: convert drop point to world coords, create items there. Multiple
  files arrange outward from that point using the active arrangement.
- Type detection by MIME + extension → renderer. Renderers:
  `image`→`<img>`, `video`→`<video>`+poster, `audio`→card+`<audio>`,
  `text`→text card (txt/md), `generic`→file card (icon, name, size, ext).
  Each renderer supplies a thumbnail, a full view, and a default size hint.

### Arrangements (`arrange/arrangements.js`)
- Pluggable `(items, {center, spacing, ...}) => positions`. Included:
  grid-rings, spiral (phyllotaxis), masonry/packed, by-type cluster, by-date,
  random scatter, and **free/custom** (preserves user positions). Used on import
  and via a "Rearrange all" command; Free mode never overwrites custom coords.

### State & history (`state.js`)
- Central board state: `{ view, settings, items[], arrangement }`. Command-based
  undo/redo. Emits change events the renderer/sidebar subscribe to.
- Culling: only items whose bbox intersects viewport (+margin) stay mounted;
  a node pool recycles DOM. (Render-all acceptable in M1; culling lands M2.)

### `.mbrd` format (`storage/mbrd.js`)
```
myboard.mbrd            (ZIP, renamed)
├── manifest.json       { format:"mbrd", version, app, created, modified, title }
├── board.json          { view:{pan,zoom}, settings, arrangement,
│                         items:[{id,x,y,w,h,rot,z,type,asset,name,meta}] }
├── assets/<hash>.<ext> embedded file bytes, deduped by content hash
└── thumbnails/<hash>.webp  cached previews (optional)
```
- `asset` = `{ hash, embedded:true }` (default) or reserved
  `{ external:{ path } }` for the future link-instead-of-embed setting.
- Pack/unpack via vendored `assets/vendor/fflate.module.js`.

### Storage backends (`storage/storage.js`, `storage/idb.js`)
- Interface: `openBoard()`, `saveBoard(handle?)`, `saveBoardAs()`,
  `readAsset(hash)`, `writeAsset(bytes)`. Detect Tauri via `window.__TAURI__`.
  - **web**: FS Access API when present, else download/upload; asset Blobs +
    board snapshot cached in **IndexedDB** for reload/crash recovery + autosave.
  - **tauri**: dialog + fs plugin (scoped) read/write the `.mbrd` on disk.
- Object URLs drive rendering; revoked on unload to avoid leaks.

### UI (`ui/sidebar.js`, `ui/appearance.js`)
- Top-left hamburger toggles a slide-in sidebar. Sections: **Board**
  (new/open/save/save-as/recent), **Add files**, **Arrange** (pick + rearrange),
  **View** (fit, recenter 0,0, grid toggle, snap toggle), **Appearance**
  (live CSS-variable controls: colors, corner radius, spacing/density, grid
  style), and later a **Layers** list.
- Minimal, slightly rounded (`--radius`). Theme via CSS custom properties on
  `:root`, persisted to `localStorage`; per-board appearance also saved in
  `board.json.settings` so a board carries its look.

### Design tokens & CSS (`assets/css/tokens.css`, `app.css`)
- `tokens.css`: colors (light/dark via `prefers-color-scheme` + `data-theme`
  override, like file-analyser), radius, spacing, shadows, grid colors,
  transitions — all runtime-overridable from the Appearance panel.
- `app.css`: layout, sidebar, canvas chrome, item cards, selection handles.

### PWA (`web/manifest.json`, `web/sw.js`)
- Web app manifest (distinct from the `.mbrd` manifest) + a service worker that
  caches the shell for offline use, modeled on file-analyser's `sw.js`.

### Tauri (M4/M5)
- Tauri v2 in `src-tauri/`. `tauri.conf.json`: `build.frontendDist = "../web"`,
  `build.devUrl = "http://localhost:3000"`, no before-dev/build commands.
  Plugins: `dialog`, `fs` (scoped). Register `.mbrd` file association / open-with
  on desktop. Mobile via `tauri android init` / `tauri ios init`; touch gestures
  reused from `canvas/input.js`, plus OS share-target import.

## Tooling files (mirror file-analyser)
- **`serve.py`** — trimmed adaptation: serve `web/` statically, bind `0.0.0.0`
  for phone access, SPA fallback to `index.html`, custom `404`. Drop the
  file-analyser `/api/stats` mock endpoints.
- **`server.bat`** — near-verbatim copy: title "mbrd server", `PORT=3000`, kill
  existing listener on the port, detect LAN IP, open the browser, run
  `python serve.py %PORT% %LOCAL_IP%`.
- **`save.bat`** — simplified git helper: menu `save / commit / push / pull`,
  auto version-bump stamped into a `VERSION` constant (`assets/js/version.js`)
  and the `sw.js` cache epoch on each commit; graceful no-remote / rejected-push
  handling. Drops file-analyser's format-prerender and stats-backup steps.
  Note: repo isn't initialized yet — first use needs `git init` + a remote.

## Milestones
- **M1 — Core canvas:** viewport + pan/zoom + background grid + coordinate
  readout; drop images; free placement; select/move; save/open `.mbrd` (images);
  `server.bat` + `save.bat` + `serve.py` + PWA shell.
- **M2 — All media & editing:** video/audio/text/generic renderers + thumbnails;
  resize/rotate; multi-select/marquee; delete; undo/redo; paste; IndexedDB
  autosave + crash recovery; viewport culling.
- **M3 — Arrangements & theming:** arrangement engine + "Rearrange all";
  Appearance panel (live CSS-var controls); per-board appearance saved.
- **M4 — Tauri desktop:** Windows + Linux; fs/dialog backends; `.mbrd` file
  association; packaging.
- **M5 — Mobile:** Android + iOS/iPadOS; touch-gesture polish; share-target
  import; packaging.
- **Later:** self-hosted sync of `.mbrd` files (no schema change needed).

## Initial scaffold (M1 files to create)
```
web/index.html
web/manifest.json                     web/sw.js
web/assets/css/tokens.css             web/assets/css/app.css
web/assets/js/main.js                 web/assets/js/state.js
web/assets/js/version.js
web/assets/js/canvas/viewport.js      web/assets/js/canvas/grid.js
web/assets/js/canvas/input.js         web/assets/js/canvas/items.js
web/assets/js/import/drop.js          web/assets/js/import/renderers.js
web/assets/js/arrange/arrangements.js
web/assets/js/storage/storage.js      web/assets/js/storage/mbrd.js
web/assets/js/storage/idb.js          web/assets/js/storage/zip.js
web/assets/js/storage/assets.js
web/assets/js/ui/sidebar.js           web/assets/js/ui/appearance.js
web/assets/img/icon.svg               web/assets/img/icon-maskable.svg
web/404.html
serve.py    server.bat    save.bat
README.md   .gitignore    .gitattributes   (.mbrd marked binary)
```
(No `vendor/` — `storage/zip.js` replaced the vendored fflate.)
(`src-tauri/` is added in M4.)

## Verification
- Run `server.bat` → browser opens `http://localhost:3000`; the infinite grid
  renders with `(0,0)` centered.
- Pan (drag/space), zoom (wheel/pinch, zooms to cursor), recenter to `0,0`, and
  "zoom to fit" all work; cursor world-coordinate readout updates.
- Drag several images onto the canvas → they appear at the drop point with
  distinct coordinates; drag one freely (no snap); toggle snap and confirm.
- Save → produces a `.mbrd`; rename to `.zip` and confirm it contains
  `manifest.json`, `board.json`, and `assets/`. Reload, Open the `.mbrd`, and
  confirm items reappear at identical coordinates with the same view.
- Reload mid-edit without saving → IndexedDB recovery restores the board (M2+).
- Phone on same Wi-Fi opens the Network URL from `server.bat` and can pan/zoom
  and drop from the share sheet (mobile import M5).
- Later: `tauri dev` loads the same `web/` folder; native Open/Save dialogs read
  and write `.mbrd` on disk; double-clicking a `.mbrd` opens the app (M4).
