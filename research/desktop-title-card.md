# Desktop title card

A movable card on the **Desktop** board that shows the board name, styled
identically to the Mobile masthead, sharing one style with it. Symmetric to how
Mobile has its fixed masthead: Desktop gets a movable title card.

## Decisions (from the user)

- **Form:** a real movable canvas *item* (drag/select/Delete/context-menu for
  free), not a fixed band.
- **Chrome:** *bare* — the styled name only, no `.card` box, no border, no icon
  kicker. Looks exactly like the Mobile masthead name.
- **Style:** *fully shared* with the Mobile masthead. Edit font/size/weight on
  either side and both update.
- **Edit from Desktop:** when the card is selected, a pen icon pops up to its
  **right**; clicking it opens the existing header style panel (`#header-panel`).
  Deselecting the card closes the panel.
- **Default spot:** top-centre, above content, present by default on every
  Desktop board.
- **Delete:** does *not* go to the normal trash list. It sets a flag. When the
  bin panel is open and the flag is set, a small square restore button appears
  in the bin dock (next to the trash popup) → click puts the card back.
- **Desktop only:** never rendered/packed/rearranged on Mobile (which already
  has its masthead).

## Approach

New item type `title`, a **singleton** managed specially. It reuses the item
system for input, geometry (per-layout via `board.layouts`), selection and
delete, and mirrors the **rider** precedent for its carve-outs.

### 1. Shared style — move `mobileHeader` to board level

Today `mobileHeader` lives per-mode in `layoutSettings[mode]`, so Desktop and
Mobile would carry separate copies. Promote it to a board-level field
(`board.mobileHeader`), like `board.title`/`board.sharedAppearance`, so both the
masthead and the card read/write one object.

- `state.js`: add `board.mobileHeader`; drop it from `DEFAULT_SETTINGS`,
  `cloneSettings`, `defaultLayoutSettings`. `setSetting('mobileHeader', …)`
  writes `board.mobileHeader` and drops the `layoutMode === 'mobile'` gate (so
  Desktop can edit). Serialize top-level; normalize + assign on load. Keep
  `settings.mobileHeader` OUT of per-mode `.mbrd` sections. **Schema change** —
  note in `docs/mbrd-format.md`; old files with per-mode `settings.mobileHeader`
  must still load (read it as a fallback source for the board-level value).
- `ui/mobile-header.js` `header()` → `board.mobileHeader`.
- `ui/fonts.js` `headerFontAxes`/`headerFontWeights` read `board.settings.fonts`
  — unchanged (fonts stay per-layout).

### 2. Singleton lifecycle

- Fixed id `TITLE_ID` so geometry is stable across sessions.
- `board.titleHidden` (bool, persisted). Default `false`.
- `ensureTitleCard()`: on new board and after load, if `!titleHidden` and no
  `title` item exists, insert one at top-centre. Old boards (no flag) get one.
- Excluded from file `classify()` (never created from a drop).

### 3. Carve-outs (mirror riders)

- Mobile packing: skip `type === 'title'` at `state.js:694`, `:971`.
- Rearrange: exclude at `main.js:1185`.
- Desktop-only mount: in `canvas/items.js` `sync()`, don't mount a `title` item
  while `board.layoutMode === 'mobile'`; keep it out of the spatial index there.
- Exempt from culling so it's always mounted on Desktop (the UI styler needs the
  node present).

### 4. Renderer + styling across layers

- `canvas/renderers.js` `RENDERERS.title` returns a **bare** node
  (`.title-card` > `.title-name`), text = `board.title`. `defaultSize('title')`
  = `{w:384,h:256}` (6×4 grid spaces at the default step, a 3:2 masthead
  aspect). Not a `.card`, so no cover attaches. Side padding keeps the name off
  the card's edges.
- Font stacks resolve off the runtime `live` map in `ui/fonts.js`, so styling
  must run in the **UI layer**. Generalize `ui/mobile-header.js` `applyTitleStyle`
  to take a target element, and paint BOTH `#mobile-board-title` and the desktop
  card's `.title-name` on the same `settings`/`fonts`/`board`/`layout` events.
- Desktop font-size mirrors Mobile: `card-width × (size/100)`, via a CSS rule on
  `.title-name` using the same `--mobile-title-*` custom props.

### 5. Pen chrome + edit routing (layering-clean)

- `canvas/items.js` build appends a `.item-pen` button (pure DOM) to a selected
  `title` item, positioned to its left in `.item` space (zoom-stable via `--iz`),
  toggled in `paintSelection` alongside grips. Suppress resize grips on `title`.
- `canvas/input.js` (has `cmds`) hit-tests `.item-pen` at pointerdown →
  `cmds.editTitle()`.
- `main.js` `cmds.editTitle` → `openPanel()` (main may import ui). Generalize the
  panel so it opens on Desktop (remove the `layoutMode !== 'mobile'` auto-close).

### 6. Special delete + restore button

- `state.js` `removeItems`: partition out the `title` id — instead of trashing,
  set `titleHidden = true` and remove the item; undo clears the flag and
  restores. One commit, no trash entry.
- `ui/trash.js`: when the bin panel opens and `board.titleHidden`, show a small
  square restore button in the bin dock (`.bin-row`); click → clear flag +
  re-insert the card (`ensureTitleCard`), close nothing. `index.html` markup +
  `app.css`.

## Files touched

`state.js`, `canvas/renderers.js`, `canvas/items.js`, `canvas/input.js`,
`ui/mobile-header.js`, `ui/trash.js`, `main.js`, `web/index.html`,
`web/assets/css/app.css`. No new modules → no `sw.js` SHELL change. Schema note
in `docs/mbrd-format.md`. Tests: extend `tests/renderers.test.js`
(`hasRenderer('title')`), add state coverage for the singleton + delete/restore.

## Open / v2

- Inline rename on the card is deferred; rename via the sidebar field or Mobile
  masthead reflects live. Could add F2 → edit `board.title` later.
