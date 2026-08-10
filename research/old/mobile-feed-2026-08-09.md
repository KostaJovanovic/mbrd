# Mobile feed — repurpose Mobile into a scrollable media feed

**Carried out.** Written 2026-08-09 before the work and moved here on the commit
that finished it, so it is now a record of the reasoning rather than a live plan —
read it as dated (the `old/` rule in `research/README.md`), and where it disagrees
with the code the code is right. The shape it describes shipped: a native-scroll
DOM feed in `ui/mobile-feed.js`, the pure masonry in `arrange/feed-layout.js`, and
the top-level `board.feedOrder` behind the sidebar edit toggle. Two departures
worth knowing: the video tile reuses `buildVideoPlayer()` wholesale rather than
hand-wiring `registerPlayer`, and the edit-mode row reaches the feed by a direct
ui→ui import rather than the injected command (the command exists too, for the
toast).

The Stage-3 work named as future here was carried out on a later commit, with one
change of shape from the plan's note. The plan said "extend `isFeedMedia`" - i.e.
mix audio into the picture feed - but the maintainer's call was that the playlist
is a **standalone view**, not audio rows among pictures. So the feed has two
lenses, Pictures and Playlist, with a switch (a body-level fixed control, above
the chrome's stacking context) that moves between them; a board with only one
kind forces the matching lens and hides the switch. The Playlist lens was then rebuilt into a proper music player (the maintainer
walked the design through several rounds of questions): the board masthead as the
header, then an Apple-Music track list - cover art or a note glyph, title over
artist, duration - where a tap plays the track and the current row lights in the
accent with an animated equalizer. Playback is a single shared queue in
canvas/audio.js (one `<audio>` the whole board reuses, registered like any
player) with next/previous, shuffle and three-state repeat; the now-playing lives
in the app's existing bottom bar, which grew those four controls (shown only when
the queue is the sound). Titles/artists/album and durations are read off the file
tags on demand - covering audio that predates the player as well as fresh imports
- and cached onto `meta` (see docs/mbrd-format.md). Because the queue is not a
row, switching to Pictures or leaving for the canvas leaves the music playing. Also done: the `feedColumns`
Feed-width setting (which replaced the dormant packer's "Grid width" control) and
reduced-motion tuning. A viewport bug the feed introduced was fixed with it -
hiding `#viewport` with `display:none` collapsed its cached size, so a `fit()` on
the way back to the canvas clamped the zoom to its floor; `visibility:hidden`
keeps the size.

And the feed's chrome was rebuilt to keep the Mobile board's identity, which the
first cut had thrown away: it is not an edge-to-edge scroller but the same
**fixed-width sheet** the world-space board is - a centred strip of a set width
(`--feed-w`) on a surround wash (the ink 6% of `#mobile-surround`), clearing the
top and bottom chrome by its margins, with the board name across the top as a
real masthead - not a plain stand-in but the shared header typography itself:
ui/mobile-header.js's `applyHeaderStyle` is injected into the feed (injected, not
imported, to stay off the `mobile-header → sidebar → panel → settings-schema →
mobile-feed` cycle), so the board's face, size, stretch, weight, italic, axes,
leading and offset all show, the feed hands the strip width to the same
`#mobile-board-title` size formula as `--mobile-board-width`, and the pen editor's
edits reach it on the `settings`/`mobileHeader` emit. So the feed reads the same
on a phone and a desktop, with more ground either side on the wider one, rather
than running full width up to the top. The one Stage-3 item deliberately
left undone is the last: *retiring* the mobile-canvas packer. It is gated in the
staging on "once the feed is proven", and it is load-bearing for the moment -
`completeLayout('mobile')` still fills and serialises `layouts.mobile`, which the
content-shared invariant and older readers both depend on. So the packer is
dormant behind the feed, not gone.

---

## What we are doing, and why

Today the **Mobile** layout is not a separate surface. It is the *same*
world-space `#world` canvas as Desktop, run with three constraints: zoom pinned
to a fit-derived value, `pan.x` pinned to `0`, and the pan clamp turned into a
finite vertical scroll range. "Scrolling" is literally `pan.y` moving,
composited by the single `translate() scale()` on `#world`. Items are packed into
a fixed-width **world-space column** by `layout.js` (`placeMobileItems`
→ `packRuns` → `packMobileGrid`, `fitMobile`, `completeLayout('mobile')`), and the
column is fully editable (tap-to-select, then drag). The masthead and sheet are
screen-space chrome drawn by `canvas/mobile-frame.js`. So the phone reuses
culling, mounting, the spatial index and `place()` unchanged — only the framing
and input differ.

We are **repurposing the Mobile presentation into a native-scrolling DOM feed** —
a Pinterest-style masonry of the board's **images and video** — so a phone
becomes a way to *browse* the same board's content rather than a cramped
mini-canvas. Desktop is untouched. Content stays shared (same `board.items`; only
geometry/settings differ per mode). This is the first of several planned feed
experiences; an **audio "playlist" lens** is a deliberate future slot the design
leaves room for, but is out of scope here.

### Decisions already made with the maintainer (do not relitigate)

1. **Visual feed first** — images + video only. Other item types (notes, links,
   models, audio) are simply hidden on Mobile.
2. **Native-scroll DOM surface** (`overflow-y:auto`), NOT the world-space canvas.
3. **Browse-only by default**, with a sidebar **edit-mode toggle** that enables
   **drag-to-reorder tiles**, persisting a custom order.
4. **Entry is the existing manual toggle only** — `cmds.toggleBoardMode` / the
   "Mobile board" sidebar setting. **No device auto-detect.** "Start on the same
   board" means the already-shared content, kept shared.

---

## Current-state briefing (so you can skip re-exploration)

### Rendering / scroll — `canvas/viewport.js`
- `boardMode` (`'desktop'|'mobile'`), `isMobile` getter (~`viewport.js:378`).
  Mobile world bounds are three scalars: `mobileWorldWidth/Top/Bottom`.
- `setBoardMode(mode, worldWidth, worldTop, worldBottom)` and the cheaper
  `setMobileBounds(...)` are driven from `ui/board-view.js` (`syncBoardMode` →
  `setBoardMode`; `syncMobileBoardBounds` → `setMobileBounds`), fed by
  `mobileBoardWidth/Top/Bottom()` from `state.js`/`layout.js`.
- No zoom on mobile: every zoom entry early-returns; zoom is forced to
  `_mobileZoom()`. `panByScreen` pins `pan.x=0`. `_constrainMobile()` clamps
  `pan.y`. `mobileScreenRect()` maps the finite board to screen px;
  `mobileHeaderPx()` is the masthead height (board width / 1.5); the masthead is
  **not an item** — its room is made purely in the pan clamp.
- `mobilePerfFlags = {legacyVars:false, chrome:true, gridPos:true}` — dev kill
  switches read by `mobile-frame.js` and `grid.js`. `chrome:false` makes
  `mobile-frame.js` `draw()` early-return (this is our per-frame short-circuit).

### Mounting / culling — `canvas/items.js`
- Mobile uses the SAME world-space mount/cull path as desktop (no mobile branch
  in the cull). `sync()` queries the spatial index over the padded visible rect.
- `ensureMounted(id)` force-mounts regardless of culling. `place()`/`placeBox()`
  write geometry; the **+y-up sign flip** lives here (`top = -item.y - item.h/2`,
  rotation negated) and in `viewport.js` only.
- `sounding(el)` — true while a `<video>/<audio>` inside a node is not paused; the
  detach pass skips a `sounding()` node so the one playing card survives leaving
  the screen. **This protection is specific to `#world` cards.** A feed `<video>`
  outside `#world` is NOT covered — the feed must run its own media-release
  discipline.
- Title card is the one place items.js diverges on mobile: excluded from mount,
  re-added only for desktop. The masthead is Mobile's title.

### Input — `canvas/input.js`
- One Pointer Events pipeline, single active gesture `g`. The `wheel` handler has
  a mobile branch collapsing everything to vertical `panByScreen`. Mobile uses a
  tap-first gate (press an unpicked card → pan, select on lift).
- **Do not touch this file for the feed.** The feed is a separate surface with a
  local pointer handler; that is correct, not a regression.

### Media / playback
- `canvas/renderers.js`: `classify(file)` sets `item.type`; `RENDERERS` builds
  per-type DOM. Media types are exactly `'image'|'video'|'audio'`. Aspect is
  already known — items are pre-sized to media aspect at import
  (`measureSize`/`adoptAspect`), and `adoptAspect()` emits a `geom` event when an
  image/video learns its true aspect.
- Items carry: `type`, `asset.hash`, `meta.cover` (embedded art / video poster
  hash), `meta.thumb` (image only, ~100px WebP made at import), `meta.peaks`
  (audio waveform). **No stored duration; no artist/title/album** (the
  `audioTags()` parser exists in `import/artwork.js` but is unused at import).
- `storage/assets.js` `assetURL(hash)` lazily mints + caches an object URL — this
  is how a card gets a playable/image URL. `getAsset(hash)` returns the entry.
- `canvas/audio.js`: `registerPlayer(el, item)` adds the element to a global
  players set, and on the element's own `play` event pauses **every other**
  player (one-clip-at-a-time) and calls `setCurrent({el,item})` which lights up
  the now-playing bar. `releasePlayers(root)` pauses + unregisters + drops the
  owner + clears now-playing if it was current — this is `items.js` `discard()`'s
  media contract. `nowPlaying()`/`onNowPlaying()` expose the current clip;
  volume is a global (`getVolume`/`setVolume`/`onVolume`), persisted to
  `localStorage`, NOT board state. None of this is on the `bus`.
- `ui/nowplaying.js` rebuilds a transport bound to the *same* element, so card and
  foot-bar stay in sync with no syncing code. No queue / next-track concept exists.

### Ordering — `arrange/arrangements.js`
- `MOBILE_ARRANGEMENTS` are six **orders** (fit/free/date/type/name/shuffle),
  shape `(items,opts)=>items`. `mobileOrder(items, {name})` resolves the
  comparator; `mobileArrangement(name)` coerces any stored id to a valid order.
  The sidebar `arrangement` select already switches to `MOBILE_ARRANGEMENTS` when
  mobile (`ui/settings-schema.js`). `mobileColumns` (6/8) is a mobile-only
  setting — these are grid SPACES for the canvas packer, fixed by the format spec.

### Persistence — `state.js`, `board-model.js`, `storage/mbrd.js`
- `board.layoutMode` is runtime-only, **not persisted** (asserted:
  `tests/state-board.test.js` `'layoutMode' in data === false`). `board.layouts`,
  `board.layoutSettings`, `board.arrangements` (each `{desktop, mobile}`) persist.
  Top-level `items`/`settings`/`arrangement` always describe **Desktop** for older
  readers, which ignore `layouts` entirely.
- `serializeBoard()` (in `state.js`) runs `completeLayout('desktop')` and
  `completeLayout('mobile')` then writes both profiles. `connections` is a
  top-level id-pair list with `normalizeConnections` — the precedent for storing
  an ordering of *shared* items at top level.
- Adding a new top-level field with a sane absent-default is backward-compatible
  and needs **no `version` bump**; changing the meaning of an existing field does
  (`docs/mbrd-format.md`).

### Gated behaviors
~25 behaviors are already conditioned on mobile mode (no connections, fences are
frozen bands, no zoom, no paper, title→masthead, snap-on, mobile appearance
vars). The feed hides the canvas, so most of these are irrelevant to it — the feed
is additive and does not need to touch them for the MVP.

---

## Target architecture

`board.layoutMode === 'mobile'` starts rendering a new DOM feed and hides the
canvas. The existing mobile-canvas machinery is **bypassed, not removed**:
`completeLayout('mobile')` still runs so `layouts.mobile` keeps serializing and
the content-shared invariant holds, but its per-frame drawing is short-circuited
(`mobilePerfFlags.chrome=false`) and `#viewport` is hidden by CSS.

### New files

- **`web/assets/js/ui/mobile-feed.js`** (`ui` layer — may import `canvas/`,
  `arrange/`, `storage/`, `state.js`; nothing below `ui` may import it). Owns the
  surface, bus wiring, tile building, drag-reorder, and media discipline.
- **`web/assets/js/arrange/feed-layout.js`** (pure, base layer beside
  `arrangements.js` — no DOM, no `state`). Owns the masonry math and the pure
  helpers, so they are unit-testable and eligible for `jsconfig.json`.

### `arrange/feed-layout.js` (pure)

- `feedMasonry(tiles, { columns, gap, width }) -> { boxes:[{x,y,w,h}], height }`.
  `tiles` = `[{ id, ratio }]` in reading order, `ratio = w/h`. Shortest-column
  placement: maintain `colH[]`, place each tile in `argmin(colH)` (ties → leftmost
  column so reading order is preserved), tile height = `colWidth / ratio`, advance
  that column by `height + gap`. Returns absolute pixel boxes + total height. Same
  idea as `arrangements.js` `masonry()`; differs only in fixed column width and
  returning y-tops rather than centres. Clamp extreme ratios (a 1:5 panorama) so
  one tile cannot dominate a column.
- `isFeedMedia(it) => it?.type === 'image' || it?.type === 'video'` — the filter,
  written so an audio lens is one extra branch later.
- `applyManualOrder(mediaItems, feedOrder) -> items` — stored order intersected
  with current media ids: drop ids no longer present, append new arrivals at the
  end in reading order. Empty/absent `feedOrder` → return input unchanged (caller
  falls back to the sort order).

### `ui/mobile-feed.js`

- Exports `initMobileFeed(viewport, cmds)` — handed in, not imported at module
  scope (same shape as `initBoardView`/`initMobileFrame`; keeps
  `tests/imports.test.js` green — no `document` in the module body).
- House-style header: state that this is the Mobile presentation, that it owns its
  own media-release discipline because its `<video>` lives outside `#world`, and
  that the audio-playlist lens is a future slot.
- Cheap early-return when `board.layoutMode !== 'mobile'`. Otherwise subscribe to
  the bus: `board:load` (full rebuild), `items` (membership → re-filter/re-lay),
  `geom` (aspect learned → reflow affected tiles), `settings` (arrangement/profile
  → re-order), `layout` (mode toggled → build on enter), `board` (title/appearance
  repaint). Plus a passive `scroll` listener for media release.
- Build sequence: filter with `isFeedMedia`; order with
  `mobileOrder(mediaItems, { name: board.arrangement })` for the sort orders, or
  `applyManualOrder(...)` when `board.arrangement === 'manual'`; get boxes from
  `feedMasonry`; render **absolute-positioned tiles** (`transform: translate(x,y)`
  + fixed width). Absolute (not CSS `column-count`, which breaks left-to-right
  reading order; not Grid `masonry`, not in our browser floor) gives exact reading
  order, cheap reflow, and a coordinate space the drag hit-test uses directly.
- Column count is **derived from scroller width**, decoupled from `mobileColumns`:
  `columns = clamp(round(width / ~180px), 2, N)`, recomputed on resize. Do not
  reuse `mobileColumns` — its 6/8 meaning is fixed by the format contract.

### DOM + CSS

- `web/index.html`: `<div id="mobile-feed" hidden aria-label="Board feed"></div>`
  as a **sibling immediately after `#viewport`** — never a child. It must live
  outside the transformed/`contain`ed canvas subtree so it never inherits `--iz`
  or triggers the whole-board custom-property invalidation the `mobile-frame.js`
  header warns about. Do **not** disturb the `#toolbar`→`#nowplaying` order.
- `web/assets/css/mobile.css` (reuse the file to avoid the new-CSS-file
  bookkeeping — a new file would need `index.html`, `SHELL` in `sw.js`, and
  `APP_CSS_ORDER` in `tests/helpers.js`). Show/hide keyed off the
  `:root[data-board-mode="mobile"]` attribute `syncBoardMode()` already writes,
  **outside any width media query** (entry is the toggle, not width — same pattern
  as the existing `#zoom-ctl/#scale-bar` hide the tests check):
  ```
  #mobile-feed { display: none; }
  :root[data-board-mode="mobile"] #mobile-feed { display: block; }
  :root[data-board-mode="mobile"] #viewport   { display: none; }
  ```
  Make `#mobile-feed` a real scroller: `overflow-y:auto`,
  `overscroll-behavior-y:contain`, `height:100dvh`/`100svh`,
  `contain:layout paint`, `env(safe-area-inset-*)` like the existing mobile chrome.

### Media & performance discipline

- **Images**: `<img loading="lazy" decoding="async">`, `src = assetURL(item.meta.thumb)`
  when a thumb exists (right resolution for a phone column), falling back to
  `assetURL(item.asset.hash)` only when there is none. Do NOT use the
  `canvas/display.js` ~1200px copy — the tile is column-sized. Per-tile
  `content-visibility:auto` + `contain-intrinsic-size:<w> <h>` so offscreen tiles
  skip layout/paint/decode. This mirrors the two canvas memory ceilings
  (`display.js` bitmap cap, `items.js` cull) — a phone feed of full-res photos is
  exactly the iOS-Safari killer they exist to prevent.
- **Video**: a tile at rest is a poster (`assetURL(item.meta.cover)`) + play
  button — never a mounted `<video>`. On tap, build `<video playsInline>` (mirror
  `RENDERERS.video`: preload, poster, src from `assetURL(item.asset.hash)`), then
  call `registerPlayer(video, item)`. That one call buys exclusivity, global
  volume, and now-playing — identical to a canvas clip. Reuse
  `buildVideoPlayer(item, video)` for the same scrub/mute wiring if it fits.
- **Feed-local release (load-bearing)**: a feed `<video>` is outside `#world`, so
  `sounding()` and the cull never see it. When a video scrolls well offscreen and
  is not `nowPlaying()?.el`, call `releasePlayers(tileEl)` then remove it. Keep the
  now-playing video mounted even offscreen (the analogue of `sounding()` exempting
  the playing card); release it on end/pause+scroll or when a new clip starts. On
  leaving mobile / `board:load`, `releasePlayers('#mobile-feed')`. Use an
  IntersectionObserver (or the scroll handler) — this is the feed's version of the
  cull's three-way answer (discard / keep-for-media / keep-the-one-sounding).

### Ordering + manual reorder persistence

- **Manual order lives top-level: `board.feedOrder` (array of ids)** — an ordering
  of shared items, exactly the argument `board-model.js` makes for `connections`.
  - `board-model.js`: add `feedOrder: []` default + `normalizeFeedOrder(raw, liveIds)`
    beside `normalizeConnections` (strings only, dedupe, drop ids the file does not
    carry, cap at `MAX_ITEMS`).
  - `state.js`: write it in `serializeBoard()`; read it in `normalizeBoard()`; add
    a `setFeedOrder(ids)` mutator (`setArrangement('manual')` + `markDirty()` +
    `bus.emit('settings','feedOrder')`).
  - Additive top-level field, absent → `[]`, older readers drop the unknown key on
    save ⇒ **no version bump**. Document it in `docs/mbrd-format.md` and flag it in
    the PR. (Avoid `layoutSettings.mobile.feedOrder`: it would survive load but only
    as an unvalidated shallow-shared array, and it is conceptually about shared
    items, not geometry.)
  - Add `{ id:'manual', label:'Manual' }` to `MOBILE_ARRANGEMENTS`; keep
    `mobileOrder` pure by resolving `manual` inside the feed via `applyManualOrder`.
- **Edit mode = drag-to-reorder**, a *local* pointer handler inside
  `ui/mobile-feed.js` (never `canvas/input.js`). Hit-test against the pure masonry
  boxes for the nearest slot, animate tiles with transform transitions, commit on
  drop via `setFeedOrder(ids)`. The first drag commits `arrangement='manual'`;
  choosing any other order from the arrangement select leaves manual mode and
  re-sorts. Undo off-stack for MVP (consistent with `setArrangement`); wrap in
  `commit()` later if wanted.

### Sidebar & entry wiring

- `commands.js`: add `toggleFeedEdit`/`setFeedEdit`; **inject the feed callback
  from `main.js`** rather than importing the feed module into `commands.js` (same
  injection shape as `resetAppearance`/`setWhimsy`; keeps layering clean).
- `ui/settings-schema.js`: a mobile-gated row in the `arrange` section
  (`when: mobile`), e.g. `{ id:'feed-edit', label:'Rearrange by hand', ... }`.
  Reuse the existing arrangement select (already `MOBILE_ARRANGEMENTS` on mobile);
  the new `manual` id shows up in that same menu.
- `commands.js` `toggleBoardMode`: update the toast/label to describe the feed
  ("Mobile feed: images & video"). Keep `cmd:'toggle-board-mode'` / the `data-cmd`
  id unchanged so nothing rewires. Entry stays the manual toggle only; the initial
  preference detection in `ui/sidebar.js` is unchanged.
- `main.js`: `initMobileFeed(vp, cmds)` in the init block.

---

## Staging

1. **MVP — browse feed.** `#mobile-feed` + CSS show/hide; hide `#viewport`,
   short-circuit `mobile-frame` draw; `ui/mobile-feed.js` (filter → `mobileOrder`
   → `feedMasonry` → absolute tiles; images lazy + content-visibility; video
   tap-to-mount with `registerPlayer` + feed release); wire `main.js` + toast;
   pure-fn tests + `SHELL`/layers/imports bookkeeping.
2. **Edit mode.** Drag-to-reorder + `board.feedOrder` persistence + `'manual'`
   order + the `feed-edit` sidebar row + `docs/mbrd-format.md` entry + round-trip
   tests.
3. **Future (out of scope here).** Audio-playlist lens (extend `isFeedMedia`, a
   tile reusing `buildTransport`, next-track on the `ended` event); optional
   feed-column setting; reduced-motion tuning; eventual retirement of the dormant
   mobile-canvas packer once the feed is proven.

---

## Tests

- **New** `tests/feed-layout.test.js` — `feedMasonry`: shortest-column placement,
  left-to-right reading order (tie → leftmost), total height, gap handling,
  extreme-ratio clamp, columns 2/3.
- **New** `tests/feed-order.test.js` — `isFeedMedia`; `applyManualOrder`
  reconciliation (removed ids dropped, new ids appended in reading order, empty
  stored order falls back).
- **Extend** `tests/state-board.test.js` — `feedOrder` round-trips through
  serialize/load; `normalizeFeedOrder` drops unknown/duplicate ids; absent → `[]`.
  The `'layoutMode' in data === false` assertion must stay true.
- **Extend** `tests/viewport-mode.test.js` — a CSS assertion (same style as the
  existing `#zoom-ctl/#scale-bar` one) that mobile hides `#viewport` and shows
  `#mobile-feed`, outside any width media query. The "no inherited custom prop on
  `#viewport`" test must stay green — add no `#viewport` style writes.
- `tests/sw.test.js` picks up the new `SHELL` entries automatically once you add
  `ui/mobile-feed.js` and `arrange/feed-layout.js` to `SHELL` in `web/sw.js`
  (**no apostrophes anywhere in that array**, comments included).
- `tests/layers.test.js` / `tests/imports.test.js` cover the new modules' import
  edges and import-time purity.

---

## Invariants to respect (each has bitten before)

- `#mobile-feed` is a **sibling** of `#viewport`, never a descendant (the
  inherited-custom-property trap). Add **no** `#viewport` style writes.
- Reuse `registerPlayer` + `releasePlayers` verbatim; never leave a detached
  `<video>` holding a stream; keep the now-playing clip alive.
- New glyphs (play, drag handle) are `<symbol>`s in `assets/icons.svg` via `<use>`
  (reuse the play glyph from `audio.js` where possible). No inline icons —
  `tests/icons.test.js` forbids new inline SVG and unreferenced symbols.
- Do **not** persist `layoutMode`. Keep `completeLayout('mobile')` +
  `layouts.mobile` so the content-shared / both-profiles invariants hold.
- Layering: `ui/mobile-feed.js` stays in `ui`; `arrange/feed-layout.js` imports
  nothing above base; `commands.js` must not import the feed — inject from
  `main.js`. No `document` at import time.
- `feedOrder` is additive top-level, absent-default `[]`, backward-compatible, no
  version bump — but still document it in `docs/mbrd-format.md` and call it out in
  the PR.
- Import paths are case-sensitive on the CI Linux leg — match filenames exactly.
- Subscribe to `geom` so `adoptAspect()`'s late aspect update reflows tiles;
  prefer laying out from stored `w/h` for a correct first paint.

---

## Verification

`npm test`; `node --check` on each touched `.js`. Then `python serve.py`, toggle
to Mobile, and check on a phone via the LAN URL: a masonry of images + video
scrolls smoothly; offscreen tiles stay cheap (no decoded full-res photos); a
video plays with the now-playing bar and stops correctly when scrolled away or
when another clip starts; and (Stage 2) drag-reorder in edit mode survives a
save → refresh. Tests are not a substitute for looking — exercise scroll, a video
play/stop, save/open, and the browser console.

## Critical files

- **New:** `web/assets/js/ui/mobile-feed.js`, `web/assets/js/arrange/feed-layout.js`.
- `web/assets/js/board-model.js` (`feedOrder` default, `normalizeFeedOrder`).
- `web/assets/js/state.js` (serialize/normalize `feedOrder`, `setFeedOrder`).
- `web/assets/js/arrange/arrangements.js` (`manual` in `MOBILE_ARRANGEMENTS`).
- `web/assets/js/commands.js` (`toggleFeedEdit`, `toggleBoardMode` toast).
- `web/assets/js/ui/settings-schema.js` (mobile-gated `feed-edit` row).
- `web/assets/js/main.js` (`initMobileFeed(vp, cmds)`).
- `web/index.html` (`#mobile-feed`), `web/assets/css/mobile.css` (feed + show/hide).
- `web/sw.js` (add the two new `.js` to `SHELL`).
- `docs/mbrd-format.md` (document `feedOrder`, Stage 2).
