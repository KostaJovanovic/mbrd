# Sidebar rebuild — plan

Status: **carried out, 2026-07-31.** Written and built the same day. Every
decision below was made by the user in a question round; the alternatives they
turned down are recorded so a later reader does not re-open them by accident.
What was actually built, and where it left the plan, is at the foot of the file.

## Why

The panel grew a section at a time and now reads as a pile. Concretely:

- **View is a junk drawer.** Two view *actions* (Zoom to fit, Back to 0,0), five
  board toggles, a media toggle, four paper controls, and — last of all —
  the board's **audio volume**.
- **Paper and Real size are one idea filed twice.** Dragging the paper outline's
  corners *is* how `settings.scale` gets set, and the two live in different
  sections with a heading between them.
- **Board layout and Arrange are one idea filed twice.** Desktop/Mobile, grid
  width, arrangement and spacing are all "how are things placed".
- **Nothing covers quality or performance,** although the app has ~7 real levers
  (see the table below) and none is reachable except by editing source or a URL
  hash.
- **Debug ships to everyone**, and the keyboard legend — 16 rows, the longest
  thing in the panel — sits between "Real size" and "This browser".

## Decisions

| # | Decision | Turned down |
|---|---|---|
| D1 | **Three tabs across the top: Board / Look / System.** | Four tabs; two tabs; no tabs (actions-then-settings order); moving actions out to the canvas furniture |
| D2 | **Short by default; each section folds its expert controls behind a caret,** the way Appearance's `.advanced` already does. | Show everything sorted; one global Advanced switch |
| D3 | **The panel opens on Board every time.** No tab memory. | Remember last tab; remember for the session |
| D4 | **Controls are generated from one declarative list in JS.** Adding a setting becomes one line in one file. | Hand-written markup; hybrid (markup + generated Quality only) |
| D5 | **New Quality section: one dial — Light / Balanced / Full — plus a fold of individual overrides.** | Dial only; switches only |
| D6 | **Full is the default and is exactly today's rendering.** Out of the box nothing changes. No Auto-detect position. | Auto (read the device); Balanced everywhere |
| D7 | **Quality is stored per device (localStorage), not in the `.mbrd`.** No format change. | In the board file; per-device with a board suggestion |
| D8 | **Same sections on phone and laptop, with the irrelevant ones absent** — not greyed out, not reordered. | Identical everywhere; a phone-specific order |
| D9 | **Paper + Real size merge into one section.** | Keep separate but adjacent; merge and fold |
| D10 | **Volume moves out of View** to sit with the other media settings. | — |
| D11 | **Keyboard legend stays in the panel** (folded, System tab). | Move to a help dialog / `?` key |
| D12 | **Debug section stays visible to everyone.** | localhost-only; URL flag |
| D13 | **The perf HUD stays URL-only** (`#perf`). No switch in the panel. | A switch in Quality |
| D14 | **Zoom to fit / Back to 0,0 leave the panel** — the corner cluster owns view movement. | Keep both; keep on phone only |
| D15 | **No new settings besides Quality** in this pass. | Autosave interval; open-last-board; default card size |
| D16 | **The masthead panel (`#header-panel`) is not touched.** It already holds exactly one thing. | Fold into Look; rebuild from the same table |

## Target structure

Absent on a Mobile board is marked **[D]** (Desktop-only); absent on a Desktop
board is marked **[M]**. Indented under a caret = inside that section's fold.

### Tab 1 — Board

```
Name          [board name field]
              New      Open
              Save     Export

Content       Add files     Write a note

Arrange       Desktop / Mobile        (toggle)
              Grid width          [M]  (mobile columns)
              Arrangement
              Spacing             [D]
              Rearrange everything
              ▸ Advanced
                  Snap to grid
```

`fit`'s label already flips to "Back to top" on Mobile — that logic moves to the
corner cluster's tooltip only, since D14 removes the panel button.

### Tab 2 — Look

```
Appearance    Whimsy        (0..2 dial, unchanged)
              Palette
              ▸ Advanced
                  Display / Body faces        (the paired row)
                  Pigment
                  Take colours from pictures
                  Pictures used               (demoted, see D-demote)
                  Corner radius
                  Grid strength               (demoted)
                  Grid weight                 (demoted)
                  Panel width                 (demoted)
                  Start over

Board & grid  Show grid
              Show axes
              Show readout
              Show web                   [D]
              Fill photos & videos
              Volume                          (moved out of View, D10)

Real size     Units                           (merged section, D9)
              Paper outline              [D]
              Portrait / Landscape       [D]
              Resize by its corners      [D]
              Reset size                 [D]
              Set from selection…
              <the scale sentence>
```

D-demote: the four controls the user marked as no-longer-front-and-centre —
panel width, grid strength, grid weight, pictures used — are not deleted, they
move inside the fold. Snap / axes / readout were explicitly **left** at top
level.

### Tab 3 — System

```
Quality       Light   Balanced   Full          (dial, default Full)
              <one sentence describing the current stop>
              ▸ Advanced
                  Animate GIFs & videos
                  Card shadows
                  Picture sharpness
                  Grid & web detail
                  Blur behind panels
                  Build ahead                  (cards built per frame)
                  Animations

This browser  Optimize
              Restart mbrd
              Clear everything

▸ By hand     <the 16-row key legend, folded>       [D-ish: still shipped on
                                                     phones, per D11]

Debug         Highlight resize grips
```

## The settings table (D4)

New module `ui/settings-schema.js` — data only, no DOM. One entry per control:

```js
{
  id:    'opt-snap',            // kept identical to today's ids where one exists
  tab:   'board',
  section: 'arrange',
  label: 'Snap to grid',
  type:  'check',               // check | range | select | buttons | text | slot
  advanced: true,               // lives inside the section's fold
  when:  ctx => !ctx.mobile,    // absence, not disabling (D8)
  get:   () => board.settings.snap,
  set:   v => setSetting('snap', v),
  // range: min/max/step/unit/format · select: options() · buttons: choices
}
```

and `ui/panel.js` — the builder, plus tabs. Three rules that keep this honest:

1. **`type: 'slot'` is the escape hatch.** Bespoke controls — the appearance
   type pair, the pigment swatch, the generated `--var` sliders, the key legend
   — declare a slot; the builder creates the empty host element with today's id
   and `ui/appearance.js` / `ui/fonts.js` fill it exactly as they do now. Those
   modules are **not** rewritten in this pass.
2. **`when` removes, never disables** (D8). The builder rebuilds affected
   sections on the `layout` bus event; `paint()` stops being the place that
   hides things by hand (`sidebar.js:276`, `:295`, `:325-332` all go).
3. **No browser globals at module scope**, or `tests/imports.test.js` fails —
   the schema's `get`/`set` are closures called after boot, which is already how
   `bindCheck` behaves.

`index.html`'s `<aside id="sidebar">` shrinks to a head, a tablist, three empty
tabpanels and the footer. That is the cost the user accepted with D4: the panel
is no longer readable as markup.

Tabs: `role="tablist"` / `role="tab"` / `role="tabpanel"`, arrow-key movement,
`aria-selected`. Panels are `hidden` rather than unmounted, so each keeps its own
scroll position while the app is open. Opens on Board (D3) — no pref written.

## Quality (D5–D7)

Two modules, because of the layering graph:

- **`web/assets/js/quality.js`** — new **base-layer** module beside `measure.js`.
  Pure: the level table, the resolved flags object, a subscribe function. No DOM,
  no `state` import. `canvas/*` imports it. It must be added to `BASE` in
  `tests/layers.test.js`.
- **`web/assets/js/ui/quality.js`** — reads/writes the `mbrd.quality` pref, sets
  `document.documentElement.dataset.quality`, calls into the base module.

Nothing goes into `board.settings`, so `docs/mbrd-format.md` is untouched (D7).

| Lever | Full (today) | Balanced | Light | Where |
|---|---|---|---|---|
| Animate GIFs & videos | as now | GIFs freeze when still, videos need a tap | frozen / no autoplay | `canvas/stills.js`, `canvas/video.js` |
| Card shadows | as now | as now | none, and `#item-shadows` stops being mirrored | `--item-shadow`/`--note-shadow` + `canvas/items.js` |
| Picture sharpness | 1280px long edge | 1152 | 1024 | `DISPLAY_MAX`, `canvas/display.js:42` |
| Grid & web detail | as now | web off while moving | Harsh grid paints as Middle; web off | `canvas/grid.js`, `canvas/web.js` |
| Blur behind panels | as now | as now | `backdrop-filter: none` | `app.css:~1527`, `:~4090` |
| Build ahead | 12 cards/frame | 8 | 4 | `BUILD_BUDGET`, `canvas/items.js:300` |
| Animations | as now | as now | `--dur-*` collapsed | `tokens.css:280-292` |

Four things to get right when this is built:

- **`display.js`'s cache is keyed by hash alone** (`display.js:48`). Changing the
  cap mid-session must either key on `hash + cap` or `clearDisplay()` and remount;
  otherwise a copy made at 800 is served forever after the dial goes back to Full.
- **Quality's token overrides must come last in `tokens.css`.**
  `:root[data-quality="light"]` and `:root[data-whimsy="2"]` have identical
  specificity, so source order is the whole of the cascade here.
- **Whimsy already zeroes shadows and shortens durations at the Harsh tier.**
  Quality is a second, independent axis over the same tokens — Light must not
  *raise* anything whimsy lowered.
- **`prefers-reduced-motion` already collapses durations** (`tokens.css:334`,
  `app.css:4178`, and three JS readers). Quality's Animations lever composes with
  it; it does not replace it.

Side effect worth naming: `stills.js` never fires on a Mobile board today,
because Mobile's fitted zoom (~0.70) never drops below `stillZoom()` on touch
(`LOD_ZOOM_TOUCH = 0.55`, `viewport.js:221`). At Light and Balanced the freeze
becomes unconditional, which closes that gap without touching the threshold.

## What this breaks

- **`tests/sw.test.js`** — `quality.js`, `ui/quality.js`, `ui/settings-schema.js`
  and `ui/panel.js` must all be added to `SHELL` in `web/sw.js`.
- **`tests/layers.test.js`** — `quality.js` joins `BASE` (line 126).
- **`tests/appearance.test.js`** — asserts against the appearance host ids; those
  ids survive as slots, so this should pass unchanged. Verify, don't assume.
- **`tests/viewport-mode.test.js`, `tests/layout.test.js`** — anything asserting
  on `#opt-*` markup or on `paint()`'s hiding behaviour.
- **`ui/sidebar.js`** loses `wirePaper`, `wireScale`, `bindCheck` and most of
  `paint()` to the schema; it keeps open/close, the slider-focus gesture, the
  `data-cmd` delegation and the title field.
- Nothing in `.mbrd`, nothing in IndexedDB, no migration. The only new
  localStorage key is `mbrd.quality`.

## Staging

Even delivered in one go, build it in this order — each step runs on its own:

1. `ui/settings-schema.js` + `ui/panel.js`, generating **today's** sections in
   today's order. Nothing moves; the panel just builds itself. Tests green here
   is the real checkpoint.
2. Tabs. Three panels, the sections distributed per the map above, still
   unfolded.
3. The folds (D2) and the demotions (D-demote).
4. `quality.js` + `ui/quality.js` + the CSS blocks, with every lever wired but
   the dial defaulting to Full — so step 4 is a no-op visually until moved.
5. The merges and moves: Paper into Real size, volume out of View, the two view
   buttons dropped.

## Open

- **Which tab holds Real size.** The map puts it under Look, because the paper
  outline is a drawn thing and the merge is anchored to the paper. The argument
  for Board is that scale is a property of the board's contents. Low stakes,
  decide when building.
- **Whether `Build ahead` deserves a user-facing control at all,** or should
  simply follow the dial with no override row. It is the one lever whose effect
  is a trade rather than a reduction, and the `worst` 117–133 ms outlier in
  `research/2026-07-30-mobile-scroll-perf.md` is still unexplained with
  `BUILD_BUDGET` as the named suspect — measuring that first may set this row's
  values for us.

---

## Built

New: `web/assets/js/quality.js` (base layer), `web/assets/js/ui/quality.js`,
`web/assets/js/ui/settings-schema.js`, `web/assets/js/ui/panel.js`,
`tests/quality.test.js`, `tests/settings-panel.test.js`.

Changed: `index.html` (the sidebar is now a head, an empty `.side-tabs`, an
empty `.side-body` and a foot — ~270 lines of markup gone; the inline pre-paint
guard also reads the quality level), `ui/sidebar.js` (395 → 240 lines: open and
close, the delegated `data-cmd` click, the slider-focus gesture, the board name
and the paper orientation pair — the rest is the table), `canvas/items.js`,
`canvas/display.js`, `canvas/web.js`, `canvas/stills.js` (one flag each),
`main.js`, `app.css`, `tokens.css`, `sw.js`, `tests/layers.test.js`,
`tests/storage.test.js`, `CLAUDE.md`.

643 tests pass. Verified in headless Edge against the running dev server: the
panel builds, all five external hosts are filled by their owning modules, the
Mobile-width load hides exactly the seven Desktop-only controls, and
`data-quality="light"` reaches `<html>` with its three flag attributes.

## Where it left the plan

- **The ornament lever is threads only.** The plan said "grid & web detail". The
  grid was measured at 0.2% of frames in
  `research/2026-07-30-mobile-scroll-perf.md` — noise — and the only real
  saving available was to stop drawing the Harsh tier's lattice, which would be
  a second, hidden "off" switch sitting next to the real one in Board & grid.
  The row is called *Threads between cards* and does one thing.
- **"Blur behind panels" is "Blurred backdrops".** There is no blur behind the
  panels; the two `backdrop-filter` sites are the question dialog's scrim and
  the transport button over an audio cover. The label now says what it turns
  off.
- **The motion lever is GIFs.** There was no video autoplay left to take away —
  `88dcde8` already holds video sources until the first play on touch.
- **Build ahead got its row after all** (the plan's first open question). It is
  in the Quality fold as *Cards built per frame*, labelled with the trade rather
  than the number alone.
- **Real size went to Look** (the second open question), because the merge is
  anchored to the paper sheet and the sheet is a drawn thing.
- **The sharpness ladder was raised after it shipped.** The plan's
  1280/1024/800 came from "a card is a few hundred world units, so pixels past
  ~1200 never reach the eye" — true at zoom 1, false the moment anyone zooms in,
  which is what a board is for. At 800 a photograph looked visibly upscaled.
  Now 1280/1152/1024. Decode cost is the square of the edge, so Light still
  takes about a third of the picture memory off, and the flags around it —
  shadows, threads, blur, anim — were always the ones saving an old phone.
  `tests/quality.test.js` holds the 1024 floor.
- **`ownVisibility`**, which the plan did not foresee: `ui/appearance.js` takes
  the palette source count down whenever the extraction switch above it is off,
  and a panel repaint would have put it back on every settings event. One flag
  in the table says who decides.

## Not done, deliberately

- The masthead panel is untouched (D16).
- No new settings beyond Quality (D15).
- The perf HUD is still `#perf`-only (D13), Debug still ships (D12), the
  keyboard legend is still in the panel (D11).
