# How mbrd is put together

The one canonical description of the app's structure. `README.md` is for people
using a board; `CONTRIBUTING.md` is for working on the repository;
`docs/mbrd-format.md` and `docs/layout-settings.md` are specifications. This is
the map.

Read it before a first change, and read the header of any file you are about to
edit — module headers here carry the *why*, often at length, and are usually
more specific than anything below.

---

## The shape of the thing

There is no bundler, no build step and no runtime dependency. The browser loads
the ES modules under `web/` directly, so an edit is one refresh away.
`package.json` declares no runtime dependencies; its three devDependencies are
for the optional lint, typecheck and end-to-end runs only, and `npm test` needs
none of them.
Nothing in `tests/` is served.

```
web/                     the application, and the document root
  index.html             head, an empty tab strip, an empty panel body, dialogs
  sw.js                  the offline shell
  lab.html               a bench for the palette extractor, deliberately not cached
  assets/css/            eight subsystem files, in load order (= the cascade)
  assets/js/             the app, split by responsibility
serve.py, qr.py          the dev server and its terminal QR
tools/                   gen-formats.mjs, preset-oklch.mjs
tests/                   node --test, no install
docs/, research/         specifications, and the reasoning behind past decisions
```

### Layering

```
util / geometry  ←  state  ←  { import, storage, canvas }  ←  ui
```

`canvas` reaches into `import` only for the generated format catalog. **A `ui/`
module imported from `canvas/` is a layering regression** — `tests/layers.test.js`
enforces the graph, so it is a test failure and not a style note.

Anything that builds an item's DOM belongs under `canvas/`. That is why
`renderers.js`, `notes.js`, `audio.js` and `model.js` live there rather than
under `import/` or `ui/`.

The bottom of the graph is wider than `util`/`geometry`. `measure.js`,
`mesh.js`, `arrange/arrangements.js`, `import/budget.js` and `canvas/spatial.js`
are pure — no DOM, no `state` import — and are meant to stay that way.
`mesh.js` sits at the top level rather than under `canvas/` for exactly that
reason: it is struct reading, and only `canvas/model.js` turns its output into
pixels. `web-graph.js` and `web-route.js` are there for the same reason — the
spanning tree and its governor, and the orthogonal router, are arithmetic over
points and boxes, and only `canvas/web.js` draws what they decide. The router's
obstacles are handed in, which is what keeps it down here rather than reaching
up into `canvas/spatial.js` for them.

Six more sit down there for a different reason: they are what `state.js` was
split onto, and they took nearly half of it with them.

| module | holds |
| --- | --- |
| `board-store.js` | the `bus`, the `selection`, the dirty flag |
| `board-model.js` | the board's shape, its defaults, the `byId` index |
| `history.js` | the undo/redo engine |
| `sticky.js` | which note is stuck to what |
| `fences.js` | which card is inside which region |
| `layout.js` | the Mobile pack, both geometry profiles, the undoable geometry writes |
| `stacking.js` | z-order |

All of them are re-exported by `state.js` under their old names, so nothing
imports them directly and no caller knows they exist — and **none may ever import
`state.js` back**, since a concern lifted out of that file can only stay out if
what it stands on is lower than what it left. `tests/layers.test.js` lists them
as BASE, which is what enforces it; that list *is* the split, not a note about
it.

`fences.js` is the one that was never in `state.js` — it was written down here
because it belongs to the same floor and answers the same kind of question. It
reads `board.layouts` directly rather than through `layout.js`'s helper for it,
and that is deliberate: `layout.js` calls `refence()`, so reaching back the other
way would put the two on a cycle.

Two things about that shape are worth knowing before adding to it. The Mobile
pack and the layout profiles are **one** module however they read as two —
`placeMobileItems()` and `completeLayout()` call each other, so splitting them
would be two modules importing each other. And the façade is written out
explicitly rather than as a star re-export, which is deliberate: the one thing
that broke during the split was four names that `state.js` re-exports but never
uses itself, and being explicit is what made that break loudly in five test
files instead of quietly at runtime.

### Nothing is a dependency

`storage/zip.js` inflates its own entries, `mesh.js` reads STL/OBJ/GLB by hand,
`import/artwork.js` walks ID3v2 / MP4 atoms / FLAC blocks itself,
`optimize/opus.js` wraps WebCodecs' bare Opus packets in an Ogg container it
writes by hand, and `ui/pigments.js` does its own OKLCh. That is the repo's one
real property: zero runtime dependencies. A new format is a few hundred lines of
header reading in the same style, not an npm package.

---

## state.js is the only door

Every board mutation goes through `state.js`, which emits on a shared `bus`:
`items`, `geom`, `item`, `selection`, `settings`, `layout`, `board`,
`board:load`, `trash`, `history`. Subsystems subscribe; **they never call each
other**.

Undo/redo is command-based — `commit(label, redo, undo)` — so a new mutating
operation must push its own inverse rather than relying on a diff. A command
that closes over a whole-board snapshot passes a fourth argument, `weight`: the
number of items it retains, so the history evicts on what it holds and not only
on how many entries it has.

Undo is not the only way back. `ui/trash.js` is the bin, and the two are
different models on purpose: undo is a stack, so it returns the *last* thing and
only if nothing has happened since; the bin holds everything thrown away
(`TRASH_LIMIT`, 60) with no relation to what came after, taken back one at a
time. Restoring is a **drag** rather than a Restore button, because a deleted
item remembers where it was and that spot is usually why it was deleted — the
board has grown into the gap, so the drag is what says where it goes now. Title
and ghost cards are never binned: the title card is a singleton with its own
restore control in the dock, and a dismissed ghost does not come back at all.

### The entry point and the command surface

`main.js` is the wiring point and nothing else: it builds the `Viewport`, calls
every `init*()`, and hands `cmds` to whoever needs it. It is deliberately small.

`commands.js` owns `cmds` — the single command surface that sidebar buttons
(`data-cmd="…"`), the keyboard and the context menu all drive. **A new
user-facing action is an entry in `cmds`, not a second event listener.**

Six modules were lifted out of `main.js` when it grew past being readable
(1,962 lines, and the file every feature touched), and each is now the place its
subject lives:

| module | owns |
| --- | --- |
| `commands.js` | `cmds`, the command surface |
| `perf/view-perf.js` | the view-change performance governor and its arming |
| `ui/hud.js` | the corner readouts — zoom, history, snap, count, save state |
| `ui/board-title.js` | the board name and title card, on both layouts |
| `ui/board-actions.js` | save-with-cooldown, reset, the three-press clear, rearrange, reload |
| `ui/board-view.js` | the framing — opening view, geometry profile, Mobile bounds |

One thing to know before adding a seventh. `commands.js` takes
`resetAppearance` and `setWhimsy` as arguments rather than importing them:
`ui/appearance.js` is one of the three modules that touch a browser global at
import time, so importing it would make `commands.js` unloadable without a DOM
and cost the fourth exemption in `tests/imports.test.js`. Same injection shape
as `setAssetNameLookup()` and `setPrompt()`.

---

## The sidebar is a table

`index.html` carries a head, an empty tab strip and an empty body; **every
control in the panel is a row in `ui/settings-schema.js`**, built by
`ui/panel.js`. A new setting is one entry there — id, tab, section, type,
`get`/`set`, and `when` if it only applies to one layout.

Three tabs (Board / Look / System), always opening on Board. `advanced: true`
sinks a control into its section's fold; `when` is *absence*, not disabling.
`external: true` means another module owns the behaviour and the builder only
makes the element under the id that module looks up — `ui/appearance.js` (whimsy,
palette, the three token hosts) and `ui/sidebar.js` (the board name) both predate
the builder and are handed their elements. The name field's behaviour is
`ui/board-title.js`'s (`wireTitleField`/`paintTitleField`); `ui/sidebar.js` only
points them at `#board-title`, because the masthead panel has the same field
under `#header-title` and one rename has to show in both. The panel is built **once**, before
those modules run, and repainted; it is never rebuilt, because they hold their
nodes.

A row's *shape* comes from `ui/controls.js` — `field()` and `fieldStops()` — and
not from whoever is building it. `ui/panel.js`, `ui/appearance.js` and
`ui/mobile-header.js` all call them, because the CSS pins that structure exactly
(`.field > span` is the flex head, `.field output` the readout,
`.field:has(select)` draws its own chevron), and a fourth site hand-building the
three elements gets a row that is very nearly right. **A new control *type* goes
there; a new control *instance* goes in the schema.**

### Chrome that is not in the panel

`ui/toolbar.js` is the bar that says a board is made by putting things on it —
files, a note, a colour, a link, and the connector tool.
Every button on it carries a `data-cmd` and this module resolves it
against `cmds`, exactly as `ui/sidebar.js` does for the panel; a tool is a button
in `index.html` and an entry in `commands.js`, and nothing here hears about it.

It is one component on two layouts, not two. Top-centre on a desktop, because
both side edges are spoken for by the panels and the whole bottom edge is the
bin, the history pair, the zoom cluster and the player. On a phone it collapses
to a handle in that bottom row — where the old `#add-bar` was, whose `data-add`
one-off it absorbed — and opens upward into a second tier, with the player
stepped up to a third. The tier is wider than the handle: the handle shares its
row with the bin and the history pair and has to clear them, the tier has a row
to itself and spans the whole foot, which is what pays for the words under the
icons — all four above 360px, Files alone below it. **`#toolbar` must stay before `#nowplaying` in `index.html`:**
the rules that move the player are general sibling combinators.

The one thing it owns beyond wiring is the connector tool's armed state, which
is the app's only mode. See *Connections* below.

`ui/nowplaying.js` is the bar along the foot that comes up when a clip starts:
the transport again, pinned to the glass, so the thing making a noise can be
stopped by whoever is listening rather than by whoever can find its card. Volume
is a row it took *out* of the sidebar — a volume dial is reached for while
something is playing, which is exactly when the bar is up. It keeps playing
off-screen because `sounding()` in `canvas/items.js` exempts the one card making
a noise from the cull; removing a media element from the document pauses it, so
before that a pan stopped the music.

`ui/credits.js` is the sheet the footer's Credits button opens — a plain module
beside `ui/dialog.js` rather than a fourth mode inside it, because it asks
nothing and resolves to nothing, so none of `ask()`'s queueing applies. Its
markup is static in `index.html` for the same reason `#ask`'s is, and it shares
every `#ask` rule that is about being a sheet. The faces on it are committed
files under `assets/img`, not GitHub URLs: fetching them would make it a fourth
thing reaching outside, for decoration, on the screen about the people who wrote
the rule.

`ui/search.js` is a palette over the canvas rather than a field in the sidebar —
a search you have to open a drawer to reach is one you stop using — and it exists
because an infinite canvas can lose a thing that is saved and intact, four
screens away at last week's zoom.

`ui/idle.js` fades the corner controls after five seconds of nothing and brings
them back on any sign of life; waking too eagerly costs nothing, being invisible
when somebody reaches for a control costs everything.

`canvas/mobile-frame.js` positions the Mobile sheet and masthead in screen space
itself, because doing it the old way — custom properties written onto `#viewport`
every frame — invalidated the computed style of all of `#world` beneath it.
**Inherited custom properties on an ancestor of `#world` are a whole-board cost;
keep new ones off it.**

---

## Quality is not board state

`quality.js` sits in the base layer beside `measure.js`: one dial (Light /
Balanced / Full) resolving six flags that `canvas/*` reads — `motion`,
`shadows`, `blur`, `anim`, `sharpness`, `build`. Full is the default and is
exactly what shipped before it existed, so the numbers in `PRESETS.full` are the
constants they replaced (`DISPLAY_MAX`, `BUILD_BUDGET`).

There were seven. `threads` went when the web stopped being computed on every
drag frame: a flag that had been a real trade became a switch that silently hid
lines somebody had drawn, which is a missing feature rather than a quality
setting. Worth remembering as the shape of the question — a flag here has to be
work the board can afford not to do, never work the user has already done.

It is stored **per device** in `localStorage`, never in the `.mbrd` — how hard
someone else's phone should work is not a property of your board. `ui/quality.js`
writes the level and three flags onto `<html>`; the CSS half is in
`assets/css/quality.css`, which must stay the last stylesheet loaded, since
`[data-quality]` and `[data-whimsy]` have identical specificity.

---

## Two layouts, one board

Desktop and Mobile share **items** and differ in everything spatial. `board`
carries `layouts` (mode → geometry per item), `layoutSettings` (mode →
settings), `arrangements` (mode → name) and `sharedAppearance`; `board.settings`
and `board.arrangement` are the *active* mode's, rebuilt by `setBoardMode()`.
`board.layoutMode` is local UI state and is deliberately not persisted, so a
phone and a laptop each remember their own choice.

A fence is the one thing that crosses that divide as a *shape* rather than as
geometry. On Mobile it becomes a full-width band with its members packed as a
contiguous run beneath it, which is the honest translation — `arrangement` there
names an order, not a shape, and a run is an order. `mobileRuns()` decides the
sequence (a run ranks where its earliest member does, loose cards last) and
`packRuns()` in `layout.js` packs each run against everything already placed, so
a band is a barrier and nothing from a later run can climb into a gap in an
earlier one. **A board with fences is repacked whole whenever `completeLayout()`
runs**, because a fence drawn on Desktop would otherwise arrive as a lone band
with its members still scattered up the column; the cost is that hand-arranged
Mobile positions do not survive a mode switch on such a board, and a board with
no fences is untouched by any of it.

`layout-settings.js` is the pure split: `splitAppearance()` / `mergeAppearance()`
send palette and typography tokens board-wide and keep radius, density, grid ink
and panel dimensions layout-local. Paper is Desktop-only. Adding a setting means
deciding which half it belongs to. `docs/layout-settings.md` is the reference,
and the `.mbrd` schema keeps top-level `items`/`settings`/`arrangement`
describing Desktop for older readers.

---

## Coordinates and rendering

World space is float, origin at board centre, **+y up** (maths plane, not screen
space). That sign flip lives in `canvas/viewport.js` and `canvas/items.js`
`place()` only — nothing else should think about it.

`#world` is one absolutely-positioned layer moved by a single
`translate(...) scale(...)`, so pan/zoom composite on the GPU and native
`<img>`/`<video>`/`<audio>` keep working.

`canvas/grid.js` paints the grid in *screen* space on `#viewport`, not inside the
transformed `#world`, which is why it stays hairline-crisp at any zoom — and why
it repaints on every view change. Two tiers, two techniques: Softish and Middle
are layered CSS radial gradients carrying `var()`, so a slider move restyles them
with no repaint and a pan is one `background-position` write; Harsh is a
`<canvas>`, because crosses are not circles. Spacing is quantised in powers of
two so zooming out never degenerates into a solid fill.

### Culling, and two memory ceilings

`canvas/items.js` culls: nodes outside the viewport (plus `CULL_MARGIN`) are
detached, then either kept (media mid-playback, so a video survives leaving the
screen) or discarded. Which items are near the screen is answered by
`canvas/spatial.js`, a uniform grid over world space — the scan used to be
O(all items) per view change, redone every frame of a zoom. **Assume an item's
node may not be in the DOM; `ensureMounted(id)` is the way in.**

Culling bounds how many nodes exist; two more modules bound what each one costs,
and both are memory ceilings rather than polish:

- `canvas/display.js` mounts a copy capped at ~1200px on the long edge instead of
  the stored original — a decoded bitmap is `naturalWidth × naturalHeight × 4`
  however small the card is drawn, so one phone photograph is ~96 MB and a board
  framed by zoom-to-fit is what kills the tab on iOS Safari. The original is
  untouched and is still what Export writes.
- `canvas/stills.js` is the same idea for time: past a zoom threshold each
  animated GIF's *current* frame is painted into a static twin and the two are
  swapped, because a browser gives no way to pause an `<img>`.

### Connections, input, and item types

Lines between cards are **drawn, not derived**. `board.connections` is a
top-level list of unordered item-id pairs — top-level because a connection is
between *items*, and items are shared across both layouts while geometry is not.
Three modules divide the work:

- `web-route.js` (pure, top level) decides where a line runs: an orthogonal path
  that goes around the cards in between rather than through them. Not a grid
  search — world space is infinite and float, so any fixed cell size either
  misses real gaps or explodes. The lattice is built from the obstacles' own
  edges, pushed out by a clearance, and A\* runs over it with a cost of distance
  **plus a penalty per turn**. That penalty is the difference between a diagram
  and a staircase. Obstacles are handed in; this module never reaches for the
  spatial index or the board.
- `canvas/web.js` draws them, and owns the performance rule the feature lives or
  dies by: **nothing is routed while anything is moving.** A stored route is kept
  exactly as long as both of its ends are where they were, so a card being
  dragged trails straight lines for the length of the gesture and a pass over the
  routes runs once the hand comes off. Nothing about a path is ever stored — it
  is a function of where the cards are now, so there is nothing to invalidate.
- `web-graph.js` is what this used to be. Its minimum spanning tree drew the
  board's web automatically, and it survives as the **generator**
  (`cmds.connectSelection`): run once on demand over a selection, it emits real,
  stored, editable connections that then route like any other. So its
  no-crossing guarantee stops being a law the app imposes and becomes what the
  generator happens to produce — and several hundred lines of proven geometry go
  on earning their keep. It has no button; it is on `mbrd.cmds` and nowhere
  else, because it is a thing you do once to a board rather than a tool. It is
  also how a board that had the old automatic web gets it back as real lines.

Making one is the app's **only mode**. `ui/toolbar.js` holds the armed state and
the four-case step (`connectStep`); `canvas/input.js` asks through `cmds` rather
than importing a `ui/` module, the same seam the title card's pen uses. The tool
stays armed after a pair — connecting five things is one trip to the toolbar —
and Escape always puts it down.

**Dangling is tolerated, not prevented.** A connection whose item is gone is
simply not drawn, which is why delete, undo, trash and restore need no
bookkeeping at any of them: the item comes back and its lines come back with it,
because they never left. Pruning happens exactly twice, on the way into a file
and on the way out of one, against the items that file holds — live *and*
binned, so restoring a card brings its lines back.

`settings.web` is still called that. It is the key an older build reads to
decide whether to draw anything at all between cards, and renaming it would open
every board that had the web switched on with nothing between them. It defaults
to **on** now, where the automatic web defaulted to off: an effect nobody asked
for is an imposition, and a line you drew yourself and cannot see is a bug. For
the same reason the quality dial's `threads` flag is gone rather than left inert
— a quality setting that silently hides work the user did is not a trade.

### Fences

A **fence** is a labelled rectangle, and the cards inside it belong to it.
`fences.js` holds the relation and `docs/mbrd-format.md` holds the schema; what
matters here is that it is `sticky.js`'s argument with a different predicate —
membership is a fact about where two things are, measured and remembered, never
stored as a list that could disagree with the geometry beside it. Delete, undo,
bin and restore therefore need no bookkeeping, exactly as connections do not.

Seven things about it are load-bearing and none is obvious:

- **The rubber band is the way in.** `canvas/input.js` reports every marquee that
  was a rectangle somebody drew rather than a modified click (`drewRectangle()`),
  and `cmds.fencePrompt` decides whether there is anything worth offering; the
  offer itself is `ui/fence-prompt.js`, a button beside the cursor that withdraws
  when the pointer strays ~2.5cm from it. That withdrawal is the design: the
  gesture has already been made, so the offer must cost nothing to decline. The
  band may draw an *empty* region because it has a rectangle to go on; the group
  menu's `Fence these N` may not, and needs two cards, because with nothing drawn
  the selection is the whole of the instruction. `fenceBox()` unions the two —
  the drawn rectangle exactly as drawn, the items with a step of margin — which
  is what stops a fence from opening not containing its own contents, since a
  marquee catches a *card* by overlap. It catches a *fence* only by covering it
  outright (`marqueeHit()` over `itemWithinRect()`): a fence is always larger
  than what is drawn inside it, so under one rule for both, every band drawn
  within a region also caught the region — which counted it in the offer, drew a
  fence unioned out to swallow its own parent, and towed the whole thing when the
  cards it caught were dragged. To take a region, enclose it or press its name.
- **It is an item** (`type: "fence"`), not a top-level key like `connections`.
  That is a format decision, argued in the format doc: an older build drops an
  unrecognised top-level key on save and carries an unrecognised `type` through
  untouched. As a list it would have destroyed people's groupings; as an item it
  degrades to a large empty named card.
- **Membership is measured on Desktop geometry and only there.** On Mobile a
  fence is a band with its members packed *beneath* it, so nothing is
  geometrically inside its fence on that layout — measuring there would find
  every fence empty and then save that. The phone reads membership; it never
  computes it, which is also why you cannot re-fence a card from one.
- **Moving a fence does not re-measure; resizing one does.** A photograph's edges
  are incidental to what lies on it and `sticky.js` says so; a fence's edges *are*
  the fence, and dragging a corner out over three more cards is the only gesture
  that means "and these too". `commitGeom()` carries both halves. It only works
  outwards: a grip stops when the rectangle reaches its own contents
  (`holdFloor()` in `canvas/input.js`, frozen at the start of the drag), because
  a corner pulled in a little too far used to drop cards silently and the only
  sign was a region that had quietly stopped owning half of itself. Letting a
  card go is the card's own gesture — drag it out. `resetSize` skips fences for
  the same reason: a fence has no size it was born at. The floor is Desktop-only
  and measured in the fence's own frame (`holdOffset()`), because both the layout
  and the rotation it is read through have to be the ones membership was decided
  in.
- **A rearrangement carries a region rather than dealing it out.** `rearrange()`
  lays out fences and loose cards; a fence's contents ride it by the translation
  it took, the way a stuck note rides its host, and are not `driven` — so nothing
  re-measures and nothing can be re-parented. Flat, an arrangement gave every
  fence a slot as though it were a card and its contents slots of their own, and
  since membership is derived, what came back was whatever landed inside whichever
  rectangle: one press of Rearrange took every grouping apart. Fences also sit out
  the lattice re-size for the reason `resetSize` does. Mobile needs none of this —
  `packRuns()` lays the column out in runs already.
- **Every fence is behind every card**, and that is a band in
  `visualStackOrder()`, not a z value — the mirror of the note band above it. It
  used to be arranged instead (a new fence took a z below its members), which is
  true when it is drawn and false the moment anything changes: resize a fence out
  over a card already lower than it and the card was picked up and then hidden
  behind the thing that picked it up. A band cannot drift, because there is
  nothing stored to drift. Within the band fences run largest first, so a nested
  region is never buried by the one around it: z cannot express that (a nested
  fence needs a value under its cards and over its parent, and on a board a whole
  number apart there is none), while area can, because containment already
  requires strictly more of it. Equal areas cannot nest, so raw z still orders
  those and Bring to front still separates them.
- **The interior takes no presses**, and the rule that says so is on `.item`, not
  on `.item-body` — every card's body already refuses the pointer, so the first
  version of it was a copy of the rule it meant to overturn and the face went on
  swallowing every empty-space gesture it covered. A fence is large, and a large
  card that swallowed clicks would end "drag empty space to pan" everywhere it
  covered. The name plate and the resize grips take it back (a descendant set to
  `auto` is hit inside a `none` ancestor); the plate is the whole of its hit area
  otherwise — and it is the one label set at the
  *region's* size rather than a card's (`clamp(15px, 4cqi, 44px)`, the same
  container-query trick the Desktop title card uses), the one that survives
  `#world.zoom-far`, and the one with a default name, because zooming out to find
  your way around is the moment a region's name is what you came for.

Two relations now answer "what travels", and they have to be closed over
together: a note stuck to a card inside a fence travels with the fence, which
neither can see alone. `travelling()` in `canvas/input.js` is that fixed point.
They meet again in `stackRoot()`, which walks both — a fence is drawn behind its
members, so raising one has to carry them or it would cover its own contents.

`isContent()` in `board-model.js` is the second half of `isFurniture()`'s
question, and exists for the same recorded reason: a fence is nobody's furniture
and is not content either, so the count and the ghost latch both ask one
predicate rather than drifting apart.

`canvas/input.js` is one Pointer Events pipeline for mouse, pen and touch with
exactly one active gesture (`g`); a second finger always wins and converts a drag
into a pinch. **Its header carries the full gesture map — read it before adding a
binding, and do not split the file.**

The `wheel` handler is the one place that guesses at hardware. A touchpad and a
mouse wheel arrive at the same event and mean opposite things — two fingers is a
*scroll* and should pan in both axes, a notch is the zoom this app has always had
— and no API says which sent it. `readWheel()` is the heuristic, pure and
exported so `tests/input.test.js` can pin the cases: `ctrlKey` is a pinch (every
engine reports one that way, and it is the only pinch notification a page gets),
a non-zero `deltaMode` is a mouse, and otherwise a sideways or fractional or
sub-notch delta is a pad. The answer is **latched for the length of a burst**
(`WHEEL_STREAM_MS`), because a swipe starts slow and reads correctly on its first
event but can look exactly like a wheel once it is moving.

The other thing the handler answers to is the platform's **axis rail**, which
comes in two strengths. A swipe committed to one axis has the other suppressed
outright — straight sideways reports `deltaY` of exactly zero, and nothing can
invent a movement the page was never told about; `Shift` is the way out of that
one (it moves the whole delta onto the horizontal, `dx || dy` so it is right
whether or not the browser already swapped, and it is applied *after* the device
is latched or a mouse would stay latched into panning for the notch after the key
came up). A swipe the platform is only **withholding** is the half `unrail()`
gives back, lifting that axis by up to `UNRAIL_GAIN`.

What it keys off is **how often the minor axis arrives, not how big it is** —
two different questions, and only the first is evidence of a rail. From one pad
within a minute: a railed swipe gave 5257px down and 973px across with the across
in *75 of 349* events; a free one gave 791px down and 1147px across with it in
*58 of 59*. The ratio cannot separate those — a sideways flick with a little
drift looks as lopsided as a vertical swipe with the sideways half confiscated,
and lifting the drift slides the board out from under the gesture. Presence
separates them exactly, because zeroing events is what the rail does. Both
measures start at "delivered whole", so nothing is lifted on the strength of the
first event or two, and `UNRAIL_CAP` bounds the invention on top so a delta the
driver held back and released in one lump cannot be multiplied into a jerk.
`cmds.debugWheel()` (also `#wheel`, also System → Debug) prints one line per
swipe, which is how all of those numbers were got.

`canvas/renderers.js` is one entry per item type — `RENDERERS` plus a branch in
`classify()`. Adding a type touches nothing else, and those two stayed in one
file deliberately: they are the pair a new type edits, and splitting them would
double that. What did move out is what was never type dispatch —
`canvas/note-model.js` (the sticky-note formatting model: pure, and read by the
editor as much as by the renderer) and `canvas/poster.js` (the video
first-frame grab). Both are re-exported by `renderers.js`, so no caller had to
learn they moved; `canvas/notes.js` reads the model directly, because it is the
note *editor* and reaching through the renderer for it was a backwards arrow.

`composeNote()` in that same file is how a new note is written, and it is worth
knowing what it is *not*: there is no second editor. The note is made first and
is an ordinary item from the first keystroke; the card the canvas built for it
is moved out of `#world` into `<dialog id="compose">` for as long as it is being
written, and put back afterwards. `editNote()` takes one option for this —
`surface`, an element that counts as part of the edit, so the bar mounts inside
it and a press on the dialog's own buttons does not commit the note out from
under the press. Three things make it work and each is load-bearing: the card is
`position: static` in the mount, so the board coordinates it carries inline stop
meaning anything while its inline width and height go on meaning exactly what
they mean on the board; the mount reserves `SHEET_ZOOM` times that box and the
card is scaled into it, since a note is 120px and a transform (unlike `zoom`)
leaves `offsetHeight` alone for `noteHeight()` to measure; and the caret is put
on the sheet in an animation frame *after* `showModal()`, because a modal's
focusing steps are flushed at the next rendering opportunity and would otherwise
take it.

Cancelling calls `finish(true)`, which commits nothing, and then takes back the
add. That is why `composeNote()` is handed *how* to make the note rather than a
note: it captures `lastCommand()` either side of the call and hands that token
to `takeBack()`, which undoes it **only if it is still the top of the stack** and
leaves no redo behind — a withdrawal rather than a step through the user's own
history. The first version reasoned instead that the add must still be the
newest thing, because `growNote()` is not undoable, `setNoteContent()` no-ops on
unchanged text and `dismissGhosts()` is hydration. All three are true; none of
them is this file's business, and one of them changing would have silently
undone something else. `takeBack()` asks the question, and `removeItems()` is
the fallback when the answer is no.

### Ghosts, exits, grain, models

Ghost cards — the hints a blank board opens with, three sentences and the whimsy
dial — are **real items** in `board.items`, not an overlay, because an overlay
would have meant a second gesture pipeline beside `canvas/input.js` for the sake
of four cards. `state.js` owns their ids (`GHOST_IDS`) and their geometry;
`canvas/ghosts.js` owns the words and the moment they go, since `state.js` sits
below the canvas and holds no user-facing prose — an item carries only a key in
`meta.hint`. Being furniture rather than content is enforced at exactly three
places: `serializeBoard()` strips them so no `.mbrd` carries one, `removeItems()`
does not bin them, and `dismissGhosts()` is hydration rather than a command — no
commit, no history — which is what makes their leaving survive an undo of the
import that triggered it.

`canvas/exit-anim.js` is the animation a card plays as it is deleted, and the
whole trick is that it runs on a **clone** lifted into a screen-space overlay
while the real node is discarded on schedule. Nothing there touches state, undo,
media release or culling; the clone is stripped of its `<video>`/`<audio>` source
so a card fading out cannot hold a stream open, and undo can rebuild the item
immediately without two nodes fighting for the same id. `exitKindFor()` is pure —
the whimsy tier picks the feel, except a title card, which vanishes and drops a
chip toward the bin.

`canvas/grain.js` takes both its position **and** its size from the board: the
paper travels on a pan and scales on a zoom, because flecks that belong to the
sheet are a fixed size *on the sheet*. Locked to the glass it reads as dirt on
the lens; travelling but not scaling reads as a second surface with its own idea
of how big things are. The cost is that a pinch is now a full-screen re-raster
rather than a re-position — a pan is still one `background-position` write — and
that a scaling grain sweeps its frequency through the grid's. The noise is
isotropic rather than a lattice, which is what turns what would be hard moiré
into a broad swim; a zoom-out over a Harsh board is where to check.

`canvas/model.js` holds **one** WebGL context for the whole app and blits it into
each card's 2D canvas; browsers cap contexts around sixteen and a panning board
would spend them all. Model cards are stored as self-photographed WebP stills
until "Rotate model" hands the geometry back.

---

## Size and arrangement

`measure.js` sits beside `util`/`geometry` at the bottom — pure, no DOM, no
`state` import. It defines the board's one link to reality: `settings.scale` is
**world units per millimetre**, and `settings.units` only chooses the names the
numbers are dressed in. Geometry never reads either. `canvas/paper.js` draws a
real A4/A3/Letter outline through that scale, and dragging its corners sets the
scale — that is the intended way to set it, not typing a number.

`arrange/arrangements.js` is likewise pure: every arrangement is
`(items, opts) => [{x, y}]` in input order, so a fresh import and "Rearrange all"
share one code path. `spacing` always means edge-to-edge gap; passing a `seed` is
what makes a layout move its slots, so seedless calls stay reproducible.

---

## Assets and persistence

Items never hold a Blob or URL, only `asset: { hash, embedded: true }`.
`storage/assets.js` is the hash → bytes registry, which is what makes
dedupe-by-content free. `storage/zip.js` is a hand-rolled ZIP over the browser's
own `CompressionStream('deflate-raw')`; `storage/mbrd.js` is the `.mbrd`
container on top of it (`docs/mbrd-format.md` is the spec).

`storage/storage.js` keeps **Save and Export deliberately separate**: Save writes
to IndexedDB (same store as the autosave interval), Export packs the `.mbrd` file
via the File System Access API where available. They fail differently, and the UI
says which is which.

Those are two of three failure models that once shared one 949-line file, so it
is now three: `storage/storage.js` is the **file** half (the picker, Save,
Export, Open, New), `storage/session.js` is the browser's own copy (the
IndexedDB working cache, the background autosave, the restore at boot), and
`storage/naming.js` is the pure title ↔ filename pair both need. The split had
to answer *who owns the file handle*, and the answer is `storage.js` — a handle
is about the document somebody chose on disk, a session is about the copy this
browser keeps. So `session.js` is handed the handle, the created-stamp, Export
and the discard prompt through `initSession()` and never imports back;
`storage.js` re-exports what moved, so no caller had to learn about it.

Any path that can replace the current board must go through the discard
confirmation, which is `ask()` in `ui/dialog.js` — it replaces `confirm()`
because a destructive question has *three* answers, and the useful one is "no,
let me save this first". It resolves to `'go'`, `'keep'` or `'cancel'`, and every
accidental way out (Escape, backdrop, close) is `'cancel'`; with no document it
resolves to `'cancel'` too, so an unanswerable question about discarding
somebody's work is answered "don't". Passing a `field` changes the contract to
"what" rather than "which", and it resolves to the trimmed string or `null`.

`storage/idb.js` is the whole IndexedDB surface — two stores, `kv` for the board
snapshot and `assets` for Blobs by hash — and it is **crash recovery only**. The
durable artefact is always the `.mbrd` the user saved.

`optimize/` is loaded by dynamic `import()` and never runs on its own — it is a
button. Nothing in it fires on import, on save or on a timer; it says what it is
about to do first, and originals stay under `meta.was` so the undo is real. It
touches only what it can make meaningfully smaller (`WORTH_IT` in `optimize.js`),
which is why it is allowed to be lossy at all. The browser does the work:
pictures through `picture.js`, sound through `opus.js`. Video is deliberately
left alone — a wasm encoder pins a core for the length of the clip — so
`optimize/media.js` is down to one job, pulling a first frame out of a clip no
browser here can decode (H.265 from a phone), and that is the one path that needs
ffmpeg.

`import/budget.js` is the importer's memory boundary and the only one: the
500-file cap in `import/drop.js` is a UX guard, not a limit on bytes, since one
50 KB PNG can claim 30000×30000 and cost gigabytes at `createImageBitmap()`. New
import paths take `IMPORT_LIMITS` and a byte budget, not a file count.

---

## Three things that reach outside

Everything else in mbrd renders the same with the network off, and opening a
board tells nobody. Three modules are the exceptions and each is built so the
exception is a choice:

- `canvas/embed.js` is the only code that talks to a third party — a link card
  becomes a YouTube or Spotify player **per click, never by default**, because
  loading an embed tells someone else's server what is on this board.
- `ui/fonts.js` takes a dropped `.woff2` into the type menus and inside the
  `.mbrd` as an asset rather than fetching a face, so a board keeps its look when
  it is sent to someone else. The family name there is *rebuilt* from the
  filename, never taken — it lands inside a CSS declaration.
- `optimize/media.js` is the third and the only one that fetches: the ffmpeg core
  lives at jsdelivr and is pulled on first use, since thirty megabytes is not
  something to ship in the shell. Nothing about a board is sent — only the
  request for the core — and it is the one thing in `optimize/` deliberately
  absent from `SHELL` in `web/sw.js`, so video posters are the single feature
  that degrades offline until the core has been fetched once. Everything there
  fails to "no poster", never to a broken card, and the dialog says which case it
  is in.

Adding a fourth needs an argument in the pull request.

---

## Look

Every colour, radius and spacing value is a CSS custom property in `tokens.css`;
`ui/appearance.js` writes them onto `:root`. That module is the look *model* —
what a look is, how it is applied, stored and derived from pictures — and
`ui/appearance-controls.js` is the panel that drives it. They are a seam rather
than a cut: the controls reached upward for thirteen names and the model back
down for eleven, so the panel is handed what it borrows through
`initAppearanceControls()`, with `current` passed as a **getter** because the
model reassigns it whenever a board arrives. `settings.appearance.vars` is the
only part of a board that reaches the browser as *code*, so it is filtered
through the `TOKENS` allowlist in `ui/look.js` — keep it that way.
`ui/pigments.js` derives whole palettes in OKLCh from board pictures (48×48
canvas, nothing uploaded) and repairs contrast afterwards.

The palette menu is the one control for "what colour is this board?": four named
palettes and **Dynamic**, which is the board's own pictures. There is no separate
switch — choosing Dynamic allows the extraction and runs it, and choosing a name
takes the permission away and drops every pigment the look was carrying. What the
menu *shows* is derived rather than stored (`dynamicOn()`: permission plus
pigments actually inline), because neither `auto` (permission) nor `derived`
(provenance, and absent from older looks) answers "is this board wearing its
pictures' colours right now". The board reaches Dynamic on its own at
`AUTO_PALETTE_FLOOR` pictures — three, in `layout-settings.js` with the pure gate
`autoPaletteReady()` — and that floor is on the automatic path only; asking for
it by name has none.

### The stylesheets

CSS is a set of files loaded in order from `index.html`, each covering one
subsystem, and **the order is the cascade** — later files win at equal
specificity:

| file | covers |
| --- | --- |
| `fonts.css` | the bundled `@font-face` set |
| `tokens.css` | every custom property |
| `base.css` | reset, type, the page, paper, grain, the surround, the boot cover |
| `canvas.css` | `#viewport`, `#world`, the transform layer, the grid, the connections, item shadows, the paper outline, the Mobile sheet and masthead in screen space |
| `items.css` | the cards per type, the ghost hints, the grips, and what the board stops paying for while it is being moved |
| `sidebar.css` | the panel — tabs, sections, folds, `.field` and its variants |
| `chrome.css` | the corner, HUD readouts, the drop overlay, toasts, the now-playing bar |
| `overlays.css` | the bin, the delete fly-out, the context menu, Find, the waiting strip |
| `mobile.css` | touch, small screens, and the mobile-only rules |
| `quality.css` | the `[data-whimsy]` and `[data-quality]` tails — **must stay last**, because both have the same specificity as what they override and win on document order alone |

This was one 6,000-line `app.css` until it became the file every interface
change had to touch at once. The order above is `index.html`'s, and **the order
is the cascade** — it is not cosmetic, and `quality.css` being last is load-
bearing rather than tidy.

A new rule goes next to the subsystem it styles. A new *file* has to be added to
`index.html`, to `SHELL` in `web/sw.js`, and to `APP_CSS_ORDER` in
`tests/helpers.js` — `tests/sw.test.js` walks `assets/css` and will fail until
the second of those is done. The banner at the top of `base.css` repeats this
list, which is where somebody opening the stylesheets will look first.

---

## Invariants the tests enforce

- **No browser globals at import time.** Reaching for `document` inside a
  function is fine; reaching for it in a module body is not. The only exceptions
  are `main.js`, `ui/appearance.js` and `optimize/media-worker.js`, listed in
  `tests/imports.test.js`. Adding a fourth is a regression.
- **Every shipped asset appears in `SHELL` in `web/sw.js`** (`tests/sw.test.js`).
  That list drifted once and left a font uncached offline. The test walks
  `assets/js`, `assets/css` and `assets/fonts`, which is what makes `web/lab.html`
  possible: a bench for the palette extractor, deliberately out of the offline
  shell, sitting at `web/`'s top level only because `serve.py`'s document root is
  `web/` and that is the one place a page can `import` the real `ui/pigments.js`
  rather than a copy. It is a single file with no module of its own under
  `assets/js` for exactly that reason — put one there and the walk would rightly
  demand it be precached.
- **The layering graph is executable** (`tests/layers.test.js`), not advice.
- **Every bundled `woff2` family has its licence file beside it**
  (`tests/fonts-license.test.js`). Geist shipped without one for several
  versions; the OFL requires it.
- `web/sw.js`'s `VERSION` and `web/assets/js/version.js` are bumped by regex at
  release — do not hand-edit or reformat those lines.
- `web/assets/js/import/formats.js` is generated. Regenerate it, never edit it.

Three optional runs sit beside the suite, none required to contribute:
`npm run lint` (oxlint, correctness only, no formatter — adding one would be a
regression), `npm run typecheck` (above) and `npm run test:e2e`, a small Playwright set
covering what a headless test structurally cannot see — pan and zoom,
add/select/delete/undo, save → refresh → recover, and that the app boots with a
clean console. Both want `npm install`; `npm test` never does.

Tests are still not a substitute for looking: for canvas or storage changes,
launch the app and exercise pan/zoom, selection, save/open, refresh recovery and
the browser console.

---

## Why this is not built on a framework

It gets asked, so the numbers are here rather than in someone's memory.

Of ~31,600 lines of JavaScript, about **11,500 are in modules that never touch
`document` or `window`** — struct reading, ZIP containers, OKLCh arithmetic,
spanning trees, packing. A view framework has nothing to say about any of it.

Of the rest, most is imperative because the app is. `canvas/input.js` runs one
Pointer Events pipeline where a synthetic event system would be the thing to
escape. `canvas/items.js` detaches nodes by hand for memory reasons — the
opposite of a reconciler owning the tree. `canvas/viewport.js` owns a single
composited transform a framework would have to be told not to touch. The media
modules must **not** remount, because remounting a `<video>` stops playback.

That leaves the genuinely view-shaped code — the panel, sidebar, menu, dialog,
search, bin, now-playing bar, mobile header — at roughly 5,000 lines, of which
maybe 3,000 is actual view. A rewrite would put 32,000 lines at risk to shorten
3,000, and would trade away the zero-dependency, zero-build property that is the
project's whole shape.

And the declarative layer a framework would sell already exists here:
`ui/settings-schema.js` plus `ui/panel.js` is data-driven UI with a test on it.

The one real gap — no compile-time safety — is closed with JSDoc types and
`checkJs`: `npm run typecheck` runs `tsc --noEmit` over plain JavaScript, no
TypeScript ships, nothing is emitted and there is still no build step.
`jsconfig.json` scopes it to the pure layer and lists what is in; widening that
`include` is how it grows, a module at a time. It paid for itself on the first
run by finding `web-graph.js` calling `corners()` and `pointInItem()` without
importing either — a `ReferenceError` out of `threads()` that stopped the
relationship web drawing past its spanning tree, silently, for the life of the
module.

The full reasoning, with per-module line counts, is in
`research/old/open-source-readiness-2026-08-02.md`.
