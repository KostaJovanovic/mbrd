# How mbrd is put together

The one canonical description of the app's structure. `README.md` is for people
using a board; `CONTRIBUTING.md` is for working on the repository;
`research/docs/mbrd-format.md` and `research/docs/layout-settings.md` are specifications. This is
the map.

Read it before a first change, and read the header of any file you are about to
edit — module headers here carry the *why*, often at length, and are usually
more specific than anything below.

---

## The shape of the thing

There is no runtime dependency and no framework. There is a build step: the app
is TypeScript, and `index.html` loads `assets/app.js`, one bundle esbuild
writes from `main.ts`. `npm run dev` rebuilds it on save. The sources ship
beside it; no source map does.

`package.json` declares no runtime dependencies; its three devDependencies are
for the lint, the typecheck and the build. `npm test` needs none of them and no
install at all — Node strips types natively from 22.18. Nothing in `tests/` is
served.

```
web/                     the application, and the document root
  index.html             head, an empty tab strip, an empty panel body, dialogs
  sw.js                  the offline shell
  lab.html               a bench for the palette extractor, deliberately not cached
  assets/css/            fifteen subsystem files, in load order (= the cascade)
  assets/app.js          the built bundle - what the page actually loads
  assets/js/             the app in TypeScript, split by responsibility
tools/                   serve.py + qr.py (dev server and its terminal QR),
                         gen-formats.mjs, gen-stickers.mjs, preset-oklch.mjs
server.bat, save.bat     the Windows launcher, and the release stamper
tests/                   node --test, no install
research/                the reasoning behind past decisions; research/docs/
                         is the specifications, this file among them
```

### Layering

```
util / geometry  ←  state  ←  { import, storage, canvas }  ←  ui
```

`canvas` reaches into `import` only for the generated format catalog. **A `ui/`
module imported from `canvas/` is a layering regression** — `tests/layers.test.js`
enforces the graph, so it is a test failure and not a style note.

Anything that builds an item's DOM belongs under `canvas/`. That is why
`renderers.ts`, `notes.ts`, `audio.ts` and `model.ts` live there rather than
under `import/` or `ui/`.

The bottom of the graph is wider than `util`/`geometry`, and `util` itself is
narrower than it was. It had grown to 646 lines and seven unrelated concerns
while forty-four modules imported it, which made it the widest coupling in the
codebase and the least deliberate: a module that wanted `clamp` was taking a
hand-written SHA-256 and two DOM overlays with it. It is 218 lines now.
`crypto.ts` holds the digest (two callers, both in `storage/`), `prefs.ts` the
localStorage layer, `media/transport.ts` the waveform builders, and the toast
and the waiting strip split in two — see `notify.ts` below, which is the
interesting half.

`measure.ts`,
`mesh.ts`, `arrange/arrangements.ts`, `import/budget.ts` and `canvas/spatial.ts`
are pure — no DOM, no `state` import — and are meant to stay that way.
`mesh.ts` sits at the top level rather than under `canvas/` for exactly that
reason: it is struct reading, and only `canvas/model.ts` turns its output into
pixels. `web-graph.ts` and `web-route.ts` are there for the same reason — the
spanning tree and the orthogonal router are arithmetic over points and boxes,
and only `canvas/web.ts` draws what they decide. The router's
obstacles are handed in, which is what keeps it down here rather than reaching
up into `canvas/spatial.ts` for them.

Eleven more sit down there for a different reason: they are what `state.ts` was
split onto, and across two rounds of it they have taken two thirds of the file —
3,202 lines to 1,806, then a regrowth to 2,607, then 2,607 to 1,260.

| module | holds |
| --- | --- |
| `board-store.ts` | the `bus`, the `selection`, the dirty flag |
| `board-model.ts` | the board's shape, its defaults, the `byId` index |
| `history.ts` | the undo/redo engine |
| `sticky.ts` | which note or sticker is stuck to what, and which of them are pinned |
| `fences.ts` | which card is inside which region |
| `layout.ts` | the Mobile pack, both geometry profiles, the undoable geometry writes, and the board-wide snap sweep |
| `stacking.ts` | z-order |
| `board-schema.ts` | the `.mbrd` in both directions — every `normalize*` and `serialize*`, and `loadBoard` |
| `onboarding.ts` | the ghost, hint and 404 cards: their ids, their geometry, and the two session latches |
| `clipboard.ts` | the internal clipboard |
| `connections.ts` | every write to `board.connections` |
| `trash.ts` | the bin — delete and restore, which are two directions of one door |

And four more from the `util.ts` split, down here for the older reason — they
are what everything else stands on:

| module | holds |
| --- | --- |
| `crypto.ts` | the hand-written SHA-256, and its two callers are both in `storage/` |
| `prefs.ts` | the `localStorage` preference layer |
| `media/transport.ts` | the waveform path builders, shared by four players |
| `notify.ts` | `toast()` and `busy()` — the *channel*, with no DOM in it |

`notify.ts` is the one worth stopping on, because it is a layering answer rather
than a filing one. Five modules that are forbidden from importing `ui/` still
have to tell somebody something: `state.ts`, `clipboard.ts`, `connections.ts`
and both modules in `storage/`. Moving the toast into `ui/` would have made all
five illegal; leaving it in `util.ts` was what put a DOM overlay underneath
forty-four importers in the first place. So the message and the drawing of it
are two modules. `notify.ts` sits at the bottom with no imports at all and
`ui/overlays.ts` supplies the implementation through `setOverlays()` — the same
injection shape as `setAssetNameLookup()` and `setPrompt()`, and `main.ts` wires
it as its first statement.

Unwired, `toast()` does nothing and `busy()` hands back a frozen job whose
methods are no-ops. That is not a defensive nicety: it is what keeps all five of
those modules importable in a test with no browser, which is the property
`tests/imports.test.js` exists to hold. `ui/overlays.ts` has exactly one
importer.

The second round is worth reading as a set of arguments rather than as five more
files, because each one answers *why is this allowed out of the mutation door*
differently. `board-schema.ts` is out because reading a file is a pure
`raw → clean` transformation and only the assignment that swaps the result in is
a mutation — the reader has to be reachable without the door, or every change to
the format is a change to the door. `onboarding.ts` is out because it is content
and policy: every function in it is hydration, no commit and no history, which is
what made it the wrong tenant. `clipboard.ts` is out because nothing in it
touches the board at all — the clipboard is not board state, is never saved and
has nothing about it to undo — so cut and paste stayed up in `state.ts` and call
down into it. `connections.ts` and `trash.ts` are the two that are simply
mutations of one concern that had been filed by accident: `board-model.ts`
already owned the *shape* of a connection, and delete and restore had been
sitting four hundred lines apart. `TRASH_LIMIT` went to `board-model.ts` rather
than to `trash.ts`, because the file reader holds an arriving bin to it too and a
base module cannot reach up. There is now both a `trash.ts` at the base and a
`ui/trash.ts` at the top, which is the relation between them said out loud.

All of them are re-exported by `state.ts` under their old names, so nothing
imports them directly and no caller knows they exist — and **none may ever import
`state.ts` back**, since a concern lifted out of that file can only stay out if
what it stands on is lower than what it left. `tests/layers.test.js` lists them
as BASE, which is what enforces it; that list *is* the split, not a note about
it.

`fences.ts` is the one that was never in `state.ts` — it was written down here
because it belongs to the same floor and answers the same kind of question. It
reads `board.layouts` directly rather than through `layout.ts`'s helper for it,
and that is deliberate: `layout.ts` calls `refence()`, so reaching back the other
way would put the two on a cycle.

Two things about that shape are worth knowing before adding to it. The Mobile
pack and the layout profiles are **one** module however they read as two —
`placeMobileItems()` and `completeLayout()` call each other, so splitting them
would be two modules importing each other. And the façade is written out
explicitly rather than as a star re-export, which is deliberate: the one thing
that broke during the split was four names that `state.ts` re-exports but never
uses itself, and being explicit is what made that break loudly in five test
files instead of quietly at runtime.

### Nothing is a dependency

`storage/zip.ts` inflates its own entries, `mesh.ts` reads STL/OBJ/GLB by hand,
`import/artwork.ts` walks ID3v2 / MP4 atoms / FLAC blocks itself,
`optimize/opus.ts` wraps WebCodecs' bare Opus packets in an Ogg container it
writes by hand, `ui/markdown.ts` is its own CommonMark-and-GFM parser,
`import/document.ts` and `ui/documents.ts` read Office, OpenDocument, Krita,
Procreate, iWork and PSD out of their own containers, and `ui/pigments.ts` does
its own OKLCh. That is the repo's one real property: zero runtime dependencies.
A new format is a few hundred lines of header reading in the same style, not an
npm package.

The two document readers are the clearest illustration of what that buys and
what it costs. Between them they open eleven formats and neither imports
anything: every one of those formats is a ZIP with XML inside it, this repo
already owns a bounds-checking ZIP reader because a `.mbrd` *is* one, and the
browser owns an XML parser. What it costs is stated in `ui/documents.ts`'s own
header — it is layout and not typesetting, so a `.docx` reads as a flow of styled
runs rather than as the page Word would print.

---

## state.ts is the only door

Every board mutation goes through `state.ts`, which emits on a shared `bus`:
`items`, `geom`, `item`, `selection`, `settings`, `layout`, `board`,
`board:load`, `trash`, `history`. Subsystems subscribe; **they never call each
other**.

Undo/redo is command-based — `commit(label, redo, undo)` — so a new mutating
operation must push its own inverse rather than relying on a diff. A command
that closes over a whole-board snapshot passes a fourth argument, `weight`: the
number of items it retains, so the history evicts on what it holds and not only
on how many entries it has.

Undo is not the only way back. `ui/trash.ts` is the bin, and the two are
different models on purpose: undo is a stack, so it returns the *last* thing and
only if nothing has happened since; the bin holds everything thrown away
(`TRASH_LIMIT`, 60) with no relation to what came after, taken back one at a
time. Restoring is a **drag** rather than a Restore button, because a deleted
item remembers where it was and that spot is usually why it was deleted — the
board has grown into the gap, so the drag is what says where it goes now. Title
and ghost cards are never binned: the title card is a singleton with its own
restore control in the dock, and a dismissed ghost does not come back at all.

### The entry point and the command surface

`main.ts` is the wiring point and nothing else: it builds the `Viewport`, calls
every `init*()`, and hands `cmds` to whoever needs it. It is deliberately small.
It is also the module esbuild is pointed at, so the import graph reachable from
it *is* the bundle.

`commands.ts` owns `cmds` — the single command surface that sidebar buttons
(`data-cmd="…"`), the keyboard and the context menu all drive. **A new
user-facing action is an entry in `cmds`, not a second event listener.**

Six modules were lifted out of `main.ts` when it grew past being readable
(1,962 lines, and the file every feature touched), and each is now the place its
subject lives:

| module | owns |
| --- | --- |
| `commands.ts` | `cmds`, the command surface |
| `perf/view-perf.ts` | the view-change performance governor and its arming |
| `ui/hud.ts` | the corner readouts — zoom, history, snap, count, save state |
| `ui/board-title.ts` | the board name and title card, on both layouts |
| `ui/board-actions.ts` | save-with-cooldown, reset, the three-press clear, rearrange, reload |
| `ui/board-view.ts` | the framing — opening view, geometry profile, Mobile bounds |
| `ui/viewer.ts` | one item, full size — the dialog and the table of views |

One of those seven is quietly still doing the job it was lifted out of.
**`ui/board-actions.ts` is a second wiring point** — it reaches into ten
different modules under `canvas/`, from a file that is otherwise a set of small
policies about single controls. That is the widest reach in `ui/` and it
is wider than `main.ts`'s, which is the tell: it was the half of `main.ts` that
kept the reaching rather than the half that kept the wiring. Nothing is wrong
with any one of those imports — a Rearrange has to repaint the grid, the grain,
the paper and the frame, and something has to know that — but it is worth
knowing before adding to it that the alternative shape is a `repaintBoard()` the
canvas owns, and that every import added here makes that shape more expensive to
reach. The module's own header says the same thing.

#### The viewer

`ui/viewer.ts` is one `<dialog>` and a dispatch table, and the table is the whole
of its design: `VIEWS` is keyed by item type the way `RENDERERS` in
`canvas/renderers.ts` is, so a new thing to show is one entry and neither the
module nor the markup changes.

It is asked *before* that table whether the file is a document, and by extension
rather than by type — because a document has no type of its own on this board. A
`.docx` that carried a baked thumbnail imported as an `image` (see
`import/document.ts`); one that did not imported as `generic`. Neither says
"document" and both must open as one.

Three readers stand behind it. `ui/markdown.ts` renders `.md`. `ui/documents.ts`
reads Word, OpenDocument, slides, sheets, CSV, SVG and comic archives out of
their containers. `import/pdf.ts` gained `openPdf()`, a paging entry point beside
the single-raster one import uses. Every one of them lands its text in the page
as a **text node** — nothing in that chain touches `innerHTML` once, which is
what makes it safe to point at a file this app did not write, since there is then
no escaping to get right. SVG is the single exception, and it is parsed detached
and walked against an allow-list before anything of it reaches the page.

The Feed opens it on a tap and the canvas on a double-click; both also reach it
from the **Open** row that now leads the item menu.

#### One menu, drawn in three places

`ui/menu.ts` is the right-click menu, and it is also the renderer every other
menu in the app is drawn by. An array of plain entry objects goes in — `label`,
`icon`, `check`, `sep`, `sub`, `danger`, `action`, plus `swatch` for a row whose
subject is a colour and `range` for the one row that is a dial — and a placed
panel comes out, walked by the arrow keys and closed by the listeners
`initMenu()` puts on outside pointerdown, wheel, scroll, resize, blur and
Escape. `openContextMenu()` drops it at a cursor; `openAnchored()` hangs it
under an element. There is one `node`: a right-click and a flyout can never be
up at once, because the capture-phase pointerdown that closes on an outside
press fires before either could open the other.

The toolbar's hover flyouts are the second caller. Three buttons on the bar had
a choice behind them that was not on the bar — Arrange used a layout picked in
the settings panel, Note used a counter in `import/drop.ts` that nothing could
address, Colour opened a picker on grey — and dwelling on one of those three now
brings the choices down under it. `ui/flyout.ts` holds the timing, the anchoring
and the three lists, and nothing else; the `FLYOUTS` table maps a `data-cmd` to
the rows it shows, so **a button with a flyout is one entry there**, and a
button without one is a button. The press is untouched in every case: hovering
Arrange shows the seven layouts, clicking it still rearranges. It binds only
under `(hover: hover)` and ignores `pointerType === 'touch'`, because Note and
Colour are on the phone's tier and a tap there has to add the thing.

Two more callers, both later. `cmds.moreTools` hangs an anchored menu under the
phone toolbar's **More** button — a tap and not a hover, which is why it is a
command opening `openAnchored()` and not a fourth `FLYOUTS` entry. And the Feed
opens the item menu on a right-click or a hold, through
`openContextMenu(..., { mobile: true })`. That flag takes rows away and never
adds any: about a third of the item menu is spatial — z-order, sizes, zoom, a
note placed *here*, a fence — and the Feed throws every computed position away.
It is a flag on the existing rows rather than a second entry list, because two
lists of one menu drift the first time only one is edited, which is the whole
argument for there being one `ui/menu.ts`.

One thing to know before adding a seventh module here. `commands.ts` takes
`resetAppearance` and `setWhimsy` as arguments rather than importing them:
`ui/appearance.ts` is one of the three modules that touch a browser global at
import time, so importing it would make `commands.ts` unloadable without a DOM
and cost the fourth exemption in `tests/imports.test.js`. Same injection shape
as `setAssetNameLookup()` and `setPrompt()`.

---

## The sidebar is a table

`index.html` carries a head, an empty tab strip and an empty body; **every
control in the panel is a row in `ui/settings-schema.ts`**, built by
`ui/panel.ts`. A new setting is one entry there — id, tab, section, type,
`get`/`set`, and `when` if it only applies to one layout.

Three tabs (Board / Look / System), always opening on Board. `advanced: true`
sinks a control into its section's fold; `when` is *absence*, not disabling.
`external: true` means another module owns the behaviour and the builder only
makes the element under the id that module looks up — `ui/appearance.ts` (whimsy,
palette, the three token hosts) and `ui/sidebar.ts` (the board name) both predate
the builder and are handed their elements. The name field's behaviour is
`ui/board-title.ts`'s (`wireTitleField`/`paintTitleField`); `ui/sidebar.ts` only
points them at `#board-title`, because the masthead panel has the same field
under `#header-title` and one rename has to show in both. The panel is built **once**, before
those modules run, and repainted; it is never rebuilt, because they hold their
nodes.

A row's *shape* comes from `ui/controls.ts` — `field()` and `fieldStops()` — and
not from whoever is building it. `ui/panel.ts`, `ui/appearance.ts` and
`ui/mobile-header.ts` all call them, because the CSS pins that structure exactly
(`.field > span` is the flex head, `.field output` the readout,
`.field:has(select)` draws its own chevron), and a fourth site hand-building the
three elements gets a row that is very nearly right. **A new control *type* goes
there; a new control *instance* goes in the schema.**

### Chrome that is not in the panel

`ui/toolbar.ts` is the bar that says a board is made by putting things on it —
files, a note, a colour, a link, and the connector tool.
Every button on it carries a `data-cmd` and this module resolves it
against `cmds`, exactly as `ui/sidebar.ts` does for the panel; a tool is a button
in `index.html` and an entry in `commands.ts`, and nothing here hears about it.

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

That constraint now has a twin pointing the other way, and the pair is worth
reading together because neither is reorderable. **`#tour` must stay *after*
`#nowplaying`**, for the identical reason at the identical cost: the rule that
lifts the tour bar clear of the player is also a general sibling combinator, and
those only look forward. So the player has to be able to see the toolbar from
where it stands, and the tour bar has to be able to see the player from where it
stands, which fixes all three in one order. Getting either wrong breaks a layout
silently — the first only on a phone, the second only while something is playing.

The one thing it owns beyond wiring is the connector tool's armed state, which
is the app's only mode. See *Connections* below.

`ui/nowplaying.ts` is the bar along the foot that comes up when a clip starts:
the transport again, pinned to the glass, so the thing making a noise can be
stopped by whoever is listening rather than by whoever can find its card. It
carries **three buttons and a seek line** — open the playlist, play/pause, close
— and that is deliberate: shuffle, previous, next, repeat and the volume slider
all sat here once, which made the bar a second copy of a transport that already
exists in the playlist window, next to the list those buttons act on. Prev and
next beside a name with nothing else on screen move you through something you
cannot see. Close is not a transport control and stays; it is the only way to
put the bar away. It keeps playing off-screen because `sounding()` in
`canvas/items.ts` exempts the one card making a noise from the cull; removing a
media element from the document pauses it, so before that a pan stopped the
music.

**A track that ends hands over to the next only while the playlist is open.**
`canvas/audio.ts` takes the predicate by injection (`setAdvanceGate`) rather than
importing it, because the answer is "is the playlist on screen" and audio sits
below `ui/` — the same one-way seam `setAssetNameLookup` and `setPrompt` use.
`ui/nowplaying.ts` supplies it, because the full player is a lens on Mobile and a
floating window on the Desktop and this is the file that already knows both. The
gate is read when a track *ends*, so closing the playlist mid-track stops the
queue at the end of it and opening it lets the queue carry on; there is nothing
to arm. Only the automatic hand-over is gated — a Next press is somebody asking —
and repeat-'one' is left alone, since replaying one track is an instruction
already given about the track you chose rather than moving on to another.

The volume is the one of those five that came back, and only on one surface.
`#nowplaying` is hidden outright on the Mobile Playlist lens — the lens carries
its own transport, so the bar would be a second copy laid over the surface
showing the first — which leaves the lens as the only place a level can be
reached for at all while it is up. So the lens transport has a volume row and
the Desktop window still does not, and the reasoning is the same either way: a
level is a property of the room rather than of a list, and it belongs where the
sound is stopped. `volumeLocked()` is copied to both, because a slider iOS
ignores is a control that lies, and the row is not built at all rather than built
and disabled.

`ui/tour.ts` is the board read as a sequence of stops rather than as a surface.
`board.tour` — the itinerary, top-level in the `.mbrd` beside `connections` and
`audioOrder` for the same reason both of those are — existed end to end with
nothing consuming it; this is the runner, a camera move per stop and a bar saying
where you are. It is in `ui/` rather than `canvas/` on the one test that decides
that: it builds chrome, and `canvas/` never does. The commands that open and step
it are in `commands/view.ts` with the other journeys, and the one that puts a
card *on* the tour is in `commands/item-meta.ts` with the tag writes, which is
the same line those two files already draw between what you are looking at and
what the board says.

**Which stop you are on is not board state and there is no event for it.** The
file carries the itinerary, because that is a thing somebody made; the position
in it is a fact about a reading session — the same status as the Feed's scroll
offset — and writing it would make opening a board a change to it. The stop list
is also resolved live through `byId()` on every read rather than held, because a
tour running while cards are deleted is exactly the window in which `board.tour`
and the board disagree.

**Desktop canvas only, and it says so rather than failing quietly.** `vp.fit()`
opens with an `isMobile` branch that ignores its items entirely — the Mobile
camera is not free, the zoom follows the column count and the pan is a scroll —
so a tour there would light the bar, step the counter and never move. It declines
with a toast the way `lockZoom` does. The fit is capped near `BASE_ZOOM * 1.5`:
the default cap is 500%, at which a stop on a sticker fills the screen with one
object and the board vanishes. It is also deliberately absent from `ui/idle.ts`'s
fade list, because looking at one stop for fifteen still seconds is the normal
case and a faded control takes `pointer-events: none` with it.

`ui/credits.ts` is the sheet the footer's Credits button opens — a plain module
beside `ui/dialog.ts` rather than a fourth mode inside it, because it asks
nothing and resolves to nothing, so none of `ask()`'s queueing applies. Its
markup is static in `index.html` for the same reason `#ask`'s is, and it shares
every `#ask` rule that is about being a sheet. The faces on it are committed
files under `assets/img`, not GitHub URLs: fetching them would make it a fourth
thing reaching outside, for decoration, on the screen about the people who wrote
the rule.

`ui/search.ts` is a palette over the canvas rather than a field in the sidebar —
a search you have to open a drawer to reach is one you stop using — and it exists
because an infinite canvas can lose a thing that is saved and intact, four
screens away at last week's zoom.

`ui/idle.ts` fades the corner controls after five seconds of nothing and brings
them back on any sign of life; waking too eagerly costs nothing, being invisible
when somebody reaches for a control costs everything.

`canvas/mobile-frame.ts` positions the Mobile sheet and masthead in screen space
itself, because doing it the old way — custom properties written onto `#viewport`
every frame — invalidated the computed style of all of `#world` beneath it.
**Inherited custom properties on an ancestor of `#world` are a whole-board cost;
keep new ones off it.**

---

## Quality is not board state

`quality.ts` sits in the base layer beside `measure.ts`: one dial (Light /
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
someone else's phone should work is not a property of your board. `ui/quality.ts`
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
`packRuns()` in `layout.ts` packs each run against everything already placed, so
a band is a barrier and nothing from a later run can climb into a gap in an
earlier one. **A board with fences is repacked whole whenever `completeLayout()`
runs**, because a fence drawn on Desktop would otherwise arrive as a lone band
with its members still scattered up the column; the cost is that hand-arranged
Mobile positions do not survive a mode switch on such a board, and a board with
no fences is untouched by any of it.

`layout-settings.ts` is the pure split: `splitAppearance()` / `mergeAppearance()`
send palette and typography tokens board-wide and keep radius, density, grid ink
and panel dimensions layout-local. Paper is Desktop-only. Adding a setting means
deciding which half it belongs to. `research/docs/layout-settings.md` is the reference,
and the `.mbrd` schema keeps top-level `items`/`settings`/`arrangement`
describing Desktop for older readers.

---

## Coordinates and rendering

World space is float, origin at board centre, **+y up** (maths plane, not screen
space). That sign flip lives in `canvas/viewport.ts` and `canvas/items.ts`
`place()` only — nothing else should think about it.

`#world` is one absolutely-positioned layer moved by a single
`translate(...) scale(...)`, so pan/zoom composite on the GPU and native
`<img>`/`<video>`/`<audio>` keep working. It carries `will-change: transform`
**permanently**. Toggling it around a gesture costs two full re-rasters of the
whole board per interaction — one when the layer is promoted, one when it is
thrown away — and each of them lands every hairline on a fresh pixel phase, which
reads as the borders changing weight every time the board is touched.

**Every line drawn inside `#world` is measured in screen pixels, not world
pixels.** A line authored in world units is scaled by the layer transform, so at
half zoom a one-pixel border is asked to paint half a device pixel and each of
its four edges rounds independently — a card comes out with a left and a top and
no right or bottom, and changes its mind as you pan. So `#world` derives
`--board-hairline` (`--hairline × --iz`) and everything on the board reads that
instead. *Derived*, not redeclared — `--hairline` is on `ui/look.ts`'s `TOKENS`
list, and a declaration for it **on** `#world` would outrank anything a `.mbrd`
writes inline on `:root`, silently taking the control away from every item.

**Only the width.** A card's inner rule (`.card::after`) sits at
`--card-rule-gap` in *world* units, because that gap is ornament printed on the
card — like its padding, its type and its corner — rather than chrome laid over
it. Deriving it too pins the plate rule a constant number of screen pixels from
the edge, so zooming in walks it into the ring and a ruled card reads as one
doubled outline.

The width has a second, narrower derivation at Harsh only: there
`--board-hairline` rounds down to a whole device pixel (`--device-px`, below).
That belongs to the one tier where `--item-shadow` is `none` and the ring is the
whole elevation model. Applied to every tier it costs a 150% display a third of
every line's coverage, which on Middle's 16%-ink border and Softish's pale
`--rule` is the difference between a drawn edge and no edge.

Width is only half of a one-pixel line, though. The other half is **position**,
and a card's four edges land at four unrelated positions *between* device pixels
— so the same one-pixel border reads black on one side of a card and grey and
twice as thick on the other. At Middle a drop shadow hides it; at Harsh, where
the ring is the entire tier, it is the only thing on screen. Thickening the line
only trades an uneven hair for an even beam, and is not the fix.

The fix is `deviceSnap()` in `canvas/items.ts`: each item is nudged by under a
pixel and scaled by under a part in a thousand so its **drawn** box begins and
ends on whole device pixels, and everything measured from that box — ring, inner
rule, caption plate — comes along. It rides `transform` (which nothing
transitions and which costs no layout) and runs on the settling frame, not per
frame, via the same `vp.onChange` listener as the cull. Two things make it mean
its most: the width should be a whole number of device pixels, which is why
`--device-px` rounds against a `--dpr` published by `canvas/viewport.ts` (125%
and 150% display scaling otherwise put a quarter-pixel of grey down one side of
every line) — Harsh takes that trade and the other two tiers do not, above — and
the card must not be rotated, since a leaning edge crosses pixel
rows along its own length and has no crisp case at any position — which is why
Harsh stands its cards up. **An item's drawn box is therefore up to one device
pixel off its stored box**; resize arithmetic, the marquee and everything saved
read `item.x/y/w/h`, the same bargain the resting tilt already strikes.

`canvas/grid.ts` paints the grid in *screen* space on `#viewport`, not inside the
transformed `#world`, which is why it stays hairline-crisp at any zoom — and why
it repaints on every view change. Two tiers, two techniques: Softish and Middle
are layered CSS radial gradients carrying `var()`, so a slider move restyles them
with no repaint and a pan is one `background-position` write; Harsh is a
`<canvas>`, because crosses are not circles. Spacing is quantised in powers of
two so zooming out never degenerates into a solid fill.

### Culling, and two memory ceilings

`canvas/items.ts` culls: nodes outside the viewport (plus `CULL_MARGIN`) are
detached, then either kept (media mid-playback, so a video survives leaving the
screen) or discarded. Which items are near the screen is answered by
`canvas/spatial.ts`, a uniform grid over world space — the scan used to be
O(all items) per view change, redone every frame of a zoom. **Assume an item's
node may not be in the DOM; `ensureMounted(id)` is the way in.**

Culling bounds how many nodes exist; two more modules bound what each one costs,
and both are memory ceilings rather than polish:

- `canvas/display.ts` mounts a copy capped at ~1200px on the long edge instead of
  the stored original — a decoded bitmap is `naturalWidth × naturalHeight × 4`
  however small the card is drawn, so one phone photograph is ~96 MB and a board
  framed by zoom-to-fit is what kills the tab on iOS Safari. The original is
  untouched and is still what Export writes.
- `canvas/stills.ts` is the same idea for time: past a zoom threshold each
  animated GIF's *current* frame is painted into a static twin and the two are
  swapped, because a browser gives no way to pause an `<img>`.

**One detail rung, and four names for it.** `farZoom`, `stillZoom` and
`thumbZoom` in `canvas/viewport.ts` are the same number — 0.4 with a mouse, 0.55
under a finger, since the same zoom factor is a smaller card on a phone. They
were separate thresholds four hundredths apart that nobody could perceive as two,
which made "zoomed out" mean something slightly different depending on which
module asked. Separate names because separate modules import them for separate
purposes; `tests/layout.test.js` asserts they agree, and a *missing* name in that
list is a decision recorded there (`webZoom` was the fourth until connections
stopped leaving at all). `#world.zoom-far` is the class the rung writes.

**Below the rung a card stops drawing its body and draws what it is instead.**
Captions, bars, shadows, video controls, model stages and embed frames all switch
off out there — and for most types what was left was the card's own contents
rendered at three pixels a line, a smear of grey on every card at once, on the
one view whose purpose is to show the shape of a board.

There are three rungs, and each is a different *kind* of answer rather than the
same answer at a different size:

| | zoom | what a card is |
|---|---|---|
| detail | ≥ 40% | the card, as built |
| index | 40 – 10% | what it is, and what it is called |
| swatch | < 10% | picture, tint or paper. no text at all |

**The index rung splits on one question — is there anything to look at?**

- **Nothing to look at** (text, link, model, embed, generic, audio without cover
  art) — the card becomes a *specimen label*: the extension in accent caps at the
  head, a hairline under it, the name set large beneath in up to three lines. That
  is the card's own anatomy — kicker, rule, name — at the card's scale rather than
  the stylesheet's.
- **A picture** (image, video, a sleeve, a swatch) — the picture, edge to edge,
  and nothing else. A photograph is its own name at any size, and a plate across
  the bottom of one is a caption on something that did not ask for one.
- **A note** — its tint and its opening line, set large, centred in the sheet. No
  kicker and no rule: a sticky is not a specimen. A note's name *is* its first
  line (`drop.ts` takes the first forty characters), so this costs nothing.

The structural idea, and why the two are not unified into one plate: **where the
name sits tells you whether there is anything to look at.** A label above paper,
nothing at all over a picture.

The rejected alternatives are worth keeping. A headline *centred* in the card
turned every card into a tile with a title in the middle of it, and a board of
those reads as a contact sheet of buttons. A *nameplate band* across every card's
foot fixed the smear and left the real problem standing: six types all became the
same blank white rectangle with a small name at the bottom, and the card's own
type mark was thrown away at exactly the zoom where three letters beat thirty.

Two things about the wiring are worth reading twice.

- **One element draws all of it.** `canvas/items.ts` builds one `.far-head` per
  card carrying two children — `.fh-kind` and `.fh-name` — and `items.css` styles
  it two ways. Restyling each renderer's own head sounds truer to "the same card,
  larger" and is not: a text card has no `.card-icon`, a model card is a
  `.title-card`, and a swatch is neither, so one rule per type would be six rules
  and an invitation for the seventh renderer to forget. `wantsHead()` is which
  cards get one; `farKind()` is the word above the rule — the extension in
  preference to anything else, the type word as fallback, empty for a note.
- **The size is in screen units, capped against the card.** A type size that is a
  share of the card shrinks *with* the card as you zoom out, so the further out
  you go the less readable the one thing you are meant to be reading; that was
  tried and drew a 180-unit card's name at under seven screen pixels. So it
  multiplies by `--iz` like every other piece of item chrome, and the cost is one
  relayout that `IZ_STEP` already paid down. The cap (`--half-h`, written by
  `placeBox()`) stops a small card wearing type taller than itself, and is also
  the graceful end into the swatch rung.

Audio without a sleeve is the one card that keeps something under its head: the
play button is worth hitting from across a board, so the head takes a fixed slice
off the top — one line of name, not three — and the button centres in what is
left. `--ix-head` names that slice once for both.

### Connections, input, and item types

Lines between cards are **drawn, not derived**. `board.connections` is a
top-level list of unordered item-id pairs — top-level because a connection is
between *items*, and items are shared across both layouts while geometry is not.
Three modules divide the work:

- `web-route.ts` (pure, top level) decides where a line runs: an orthogonal path
  that goes around the cards in between rather than through them. Not a grid
  search — world space is infinite and float, so any fixed cell size either
  misses real gaps or explodes. The lattice is built from the obstacles' own
  edges, pushed out by a clearance, and A\* runs over it with a cost of distance
  **plus a penalty per turn**. That penalty is the difference between a diagram
  and a staircase. Obstacles are handed in; this module never reaches for the
  spatial index or the board.

  **It concedes room before it concedes the route.** A straight line is not a
  failed route — it is the thing this module exists to stop drawing, since it
  scores through every card between the two ends. So a search that finds nothing
  is retried at a third of the clearance, then at none of it (hugging the edges,
  where only real overlap blocks), and finally with the cards that lie *on top
  of* an end dropped from the obstacle set — the one case margin cannot answer,
  because nothing can be routed around a card that is on top of the card being
  routed to. A lattice too large to search sheds its furthest obstacles until it
  fits rather than abandoning the route.

  And when all four find nothing, **the answer is still not a diagonal**. It is
  the plain two-bend elbow, drawn through whatever is left in the way. A line
  corner to corner scores across every card between the two ends at an angle
  nothing else on the board is drawn at, and it reads as damage; an elbow that
  passes *behind* a card reads as a connector, because `#web` is under the items
  (`z-index: -2`) — the line goes under the card and out the other side, which is
  what a wire behind a photograph does. So there is no such thing as a route that
  failed: there are routes that go round, and routes that go behind. The result
  carries no failure flag, and the dimmed dashed fallback style, its second bulk
  path in `canvas/web.ts` and the `.web-fallback` rule are all gone with it — a
  state worth marking as a failure has to look like one.

  **The shape of a route answers the whimsy axis**, through `opts.shape` — the
  router reads nothing, so `canvas/web.ts` hands it down. At Harsh the obstacle
  lines are quantized outward to the board's own `baseStep()`, so a turn round a
  card lands where the cards are standing (Harsh snaps them there — see
  `axisMoved()`); at the middle and at Softish the corridor A\* returns is
  **string-pulled** — drop each turn whose neighbours can see each other through
  the same blocks — which collapses to a single ruled line when nothing is in the
  way and otherwise bends by however much the detour needs. Softish is the taut
  shape with the *clearance raised*, and that is not a shortcut: the curve is
  drawn by rounding the corners in `pathData()`, a fillet cuts inside the corner
  it rounds, and a corner is exactly where the path is hugging a card. The room
  the curve will take is bought before the search rather than out of the card
  after it. The quantized attempt is a rung above the concession ladder, so the
  first thing given up is the lattice and not the clearance.

  The open set is a binary heap. It was a linear scan for the smallest `f`,
  which is quadratic in the open set — affordable for one search over a couple
  of thousand nodes, not for four, and it was what really bounded
  `MAX_OBSTACLES`. That cap is 40 rather than 24 now, and sits where the lattice
  puts it rather than where the queue did.
- `canvas/web.ts` draws them, and owns the performance rule the feature lives or
  dies by: **nothing is routed while anything is moving.** A stored route is kept
  exactly as long as both of its ends are where they were, so a card being
  dragged trails straight lines for the length of the gesture and a pass over the
  routes runs once the hand comes off. Nothing about a path is ever stored — it
  is a function of where the cards are now, so there is nothing to invalidate.

  Except the look. `look()` is where a `data-whimsy` attribute and the board's
  grid step become the router's three arguments, and because a route is cached on
  its two end boxes, moving the slider changes no signature and would leave every
  line carrying the shape it had at the old level. `reshape()` is the answer, on
  the `settings`/`appearance` event: drop each `routed` flag, keep every line.
  Not `resetWeb()`, which releases the settled set as well and would make the
  whole board blink on a slider move.
- `web-graph.ts` is what this used to be. Its minimum spanning tree drew the
  board's web automatically, and it survives as the **generator**
  (`cmds.connectSelection`): run once on demand over a selection, it emits real,
  stored, editable connections that then route like any other. So its
  no-crossing guarantee stops being a law the app imposes and becomes what the
  generator happens to produce — and several hundred lines of proven geometry go
  on earning their keep. What did *not* survive is its adaptive governor, which
  timed the spanning tree on every call and solved for the largest board this
  machine could rebuild inside half a frame. Every word of that was about a web
  rebuilt on every frame of a drag; run once on a button press it never had the
  calls to converge, and the number it had effectively frozen at is written down
  as `DENSE_LIMIT` instead. It has no button of its own; `cmds.connectSelection` is
  the whole-board door on `mbrd.cmds`, and the connector tool is the everyday
  one — see below. It is also how a board that had the old automatic web gets it
  back as real lines.

Making one is the app's **only mode**. `ui/toolbar.ts` holds the armed state and
the four-case step (`connectStep`); `canvas/input.ts` asks through `cmds` rather
than importing a `ui/` module, the same seam the title card's pen uses. The tool
stays armed after a pair — connecting five things is one trip to the toolbar —
and Escape always puts it down.

**The tool draws while you aim it.** From the moment an end is picked,
`canvas/web.ts` runs a draft path from that card to the pointer — straight while
the pointer moves, routed once it settles, which is the same bargain a dragged
card strikes — and the card under the pointer wears a dashed ring
(`setConnectAim`, the pick's quieter opposite number: a pick survives its card
being culled and rebuilt because it is a decision, an aim does not because it is
where the pointer is this moment). `ui/toolbar.ts` owns the pick and calls
`setDraftFrom`, so disarming, completing a pair and Escape all put the line away
without knowing they have. The draft lives here rather than in the input
pipeline because `canvas/input.ts` holds exactly one active gesture and a draft
is not one — the same reason the hover highlight is read on `#viewport`.

**The selection is read at the moment the tool arms**, once, and never again
while it is armed — what a press means must not depend on what happened to be
picked three presses ago. Two or more cards selected is the generator's question
rather than the tool's, so pressing the button runs `threads()` over them and
lands a set of lines in one undoable step; exactly one selected is half a pair,
so it becomes the picked end (`setArmed(on, from)`) and the next card completes
it. Either way the tool arms, because what follows a join is more joining.
Furniture, riders and fences are out of the pool at both doors — one `joinable()`
predicate in `commands.ts`, since a line to a hint, to a note stuck on its host,
or to a region is a line to no particular card.

**A line can be pointed at, and it is not a selection.** A press on bare board
that lands on a connection marks it (`cmds.pickConnection`); the mark stays lit
after the pointer moves on, Delete removes it when no card is selected, a double
click asks for its label, and the right-click editor is unchanged. It is
deliberately *not* a member of `selection`, which is a set of item ids that
band-select, group drag, arrange, align, delete, the trash and the sidebar count
all assume — widening it would put an "is this an item" clause in every one of
them to make one line clickable. One key in `canvas/web.ts`, beside the hover it
is the deliberate half of.

`ui/conn-chip.ts` is what the mark is worth: five icon buttons pinned over the
line's own midpoint (`activeConnectionAnchor`, `polyMidpoint` again, so on a
route that bends round three cards the chip is *on* the line). Arrows and dash
are cycles whose icon is also their readout, then label, then a way through to
the menu, then remove. It is not a second editor — colour and weight are a
choice from a list, which is what the menu is for — and it has no dismissal
logic of its own: the mark going away takes it, and every path that drops the
mark already runs through `canvas/input.ts` and `cmds`. It follows the line on
two signals, because one is not enough: `onActiveConnectionMove` covers an edit,
a reroute and a dragged card, and `vp.onChange` covers the pan `paint()`
deliberately returns from without redrawing.

**A card's drawn lean is part of its box here.** Cards rest crooked at the soft
end (`--item-tilt` × `--tilt-max`, up to 3°) and that lean is presentational, so
it is not in `item.rot` — which meant a route ended on the *untilted* box, and a
tilted card's corners stick out past it, so a line's last few units sat under the
picture. Invisible, until the hover lift moved the card off it and left a stub in
the gap. `drawnTilt()` adds the tier's maximum lean to the magnitude of every
card's rotation (never a fence, never at Harsh or on a snapped board, where
nothing is drawn crooked), so a line may stop a hair further out than it must and
can never stop underneath.

**What a line can say** is its third element: `dir`, `style`, `label`, and now
`color` and `weight`. All five are *names* validated against closed lists in
`connMeta()`, resolved to tokens by one CSS rule each — this object arrives out
of somebody else's file, and a value that reached a stroke would reach the
CSSOM. Defaults are omitted, so a plain connection is still `["a","b"]` on disk
and no version bump was owed. A line with meta already leaves the bulk path for
its own element in the decoration layer (one shared `d` can only carry one
stroke), so colour and weight cost nothing structurally.

**Selecting or pointing at a card lifts its own threads.** The focused subpaths
are drawn a second time into `.web-focus` over a bulk path the `is-focused` class
dims, which is one extra `d` string while a focus exists and nothing stored at
all. Two triggers, and the precedence is the rule: a selection wins, and the
pointer speaks only when there is nothing selected to drown out. Hover is fenced
twice — ignored while a gesture runs, since a pan drags the whole board under the
cursor, and ignored whenever anything is selected — and the opacity transition
does the rest. Whether anything lit is counted over *every* line on screen and
not off the bulk path's string: a styled line is its own element in the
decoration layer, so a card whose connections all carried a colour used to light
an empty string and dim nothing.

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
— a quality setting that silently hides work the user did is not a trade, and
**connections are not on the zoom detail ladder either**. They used to fade out
across a band above the rung and vanish below it, on the argument that a few
hundred non-scaling hairlines over a postage-stamp board are a grey scribble.
That argument belonged to the derived web: the far view is the only one that
shows the whole graph at once, so it is where a drawn line is worth the most and
was exactly where it used to disappear. What that costs is named in
`canvas/web.ts` — the furthest-out view is the one with nothing culled, so the
`d` string is longest precisely where it used to be skipped.

### Fences

A **fence** is a labelled rectangle, and the cards inside it belong to it.
`fences.ts` holds the relation and `research/docs/mbrd-format.md` holds the schema; what
matters here is that it is `sticky.ts`'s argument with a different predicate —
membership is a fact about where two things are, measured and remembered, never
stored as a list that could disagree with the geometry beside it. Delete, undo,
bin and restore therefore need no bookkeeping, exactly as connections do not.

Seven things about it are load-bearing and none is obvious:

- **The rubber band is the way in.** `canvas/input.ts` reports every marquee that
  was a rectangle somebody drew rather than a modified click (`drewRectangle()`),
  and `cmds.fencePrompt` decides whether there is anything worth offering; the
  offer itself is `ui/fence-prompt.ts`, a button beside the cursor that withdraws
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
  While the offer stands, `#fence-ghost` holds the region on the board — the band
  is the marquee's and ends with the gesture, so otherwise the question is asked
  about an area nobody can see. It draws `wouldFence()`, the box the accept would
  actually make, which is why it is not simply the marquee left up: the union is
  larger than the band whenever a card was caught with part of it outside. It is
  screen-space and placed once, because the offer closes on any view change and a
  rectangle that cannot go stale needs no frame loop.
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
  are incidental to what lies on it and `sticky.ts` says so; a fence's edges *are*
  the fence, and dragging a corner out over three more cards is the gesture that
  means "and these too". `commitGeom()` carries both halves.
- **A resize carries the contents, exactly as a card carries its stuck notes.**
  `startResize()` takes `travelling([id])` as its followers instead of
  `stuckFollowers([id])`, and the per-frame code is unchanged — `stuckPlacement()`
  already keeps a follower at the same *fractional* spot in the box, which is the
  whole of it. So pulling a region in gathers its cards and pushing it out spreads
  them, and a card is *in* a region the way a sticky is *on* a card.
  `travelling()` rather than the members alone, since a note stuck to a card
  inside the region has to come too and neither relation sees that on its own —
  and it is the same set a *move* would carry, so the two gestures cannot disagree
  about what is in a region. Desktop only, for the reason above: on Mobile a band
  is a row of a packed column and its cards are underneath rather than inside it,
  so there is no fraction of it for them to hold. Fractional placement moves a
  nested fence without resizing it, so a nested region's own cards spread further
  than it does and some may be re-measured out of it on release — the cost of not
  scaling a whole subtree. `resetSize` still skips fences: a fence has no size it
  was born at.
- **And it still stops when the contents fill it** (`carryFloor()`). Keeping a
  card's fraction is not the same as keeping it inside: the fraction holds a
  *centre*, and a card is a box whose size does not shrink with the region — so
  past a point the cards sit at the right fractions and hang over the border
  anyway. A card at fraction `fx` needs `w >= hw / (0.5 - |fx|)`, and the binding
  card is whichever asks for the most. There is no corner arithmetic, unlike the
  floor this replaced: the fraction is preserved whichever edge is dragged, so the
  floor is a fact about the box's size alone. Capped at the size the drag started
  from, so a card already hanging out of a region cannot make a grip snap it open.
- **A fence hangs straight.** A lean is a card pinned up by hand; a region is a
  line drawn on the board, and it turns about its own centre, so across two
  thousand units the corners travel far enough that the region visibly disagrees
  with the cards inside it — which keep their own leans. `canvas/items.ts` gives
  it no resting lean *and does not draw one from the bag*, since the
  one-in-three-straight split is a property of the pack; `items.css` zeroes
  `rotate` outright, which also covers the drag lean and is how the snapped board
  says the same thing. `item.rot` is untouched — that lives in `transform`.
- **A region can be arranged from the inside**, and that is what the canvas menu
  offers when the right-click was inside one — `cmds.fenceUnder(at)` swaps
  *Rearrange everything* for *Rearrange fence*, since a press on a fence's face
  falls through to the board and the board is not what that click was about. The
  name plate is the other way in, through the item menu. It lays the contents out
  in **masonry** whatever the board's arrangement is: the board's arrangement is
  chosen for the shape of the whole, and a region is a shelf, where what you want
  is everything visible at once with nothing wasted between. `rearrange()` takes
  it as three options — `name`, `center` (the region, not the middle of its
  contents) and `enclose` — and the last is load-bearing: the layout is bounded by
  nothing, so the region closes around the result inside the same commit, or a
  region that came out not holding its own contents would have them measured
  straight out of it. Closing runs **twice**: once to the cards' bounds, then
  again with `barHeight()` of room added at the top, because a fence's plate lies
  across the top of its box and a block closed to a bare margin puts its first row
  under the region's own name. The second pass is what makes the measurement
  honest — the name is set at `2.8cqi` of the region's width, so it can only be
  measured once that width is real, and `'geom'` places nodes synchronously. Both
  writes land before the commit, so it is still one undo. Only here: where a fence
  is *made*, the rectangle is one somebody drew and `fenceBox()` takes it as
  drawn.
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
  those and Bring to front still separates them. The band is sunk one further:
  `paintStack()` writes it *below* `#item-shadows` and `#web`, because a fence has
  a face like any other item and card shadows live in one underlay beneath the
  item layer — so a region in the item stack painted out the shadow of every card
  inside it, and read as a page with its cards printed flat on it rather than
  lying on it. Ground goes under the shadows. Both underlays refuse the pointer,
  so passing beneath them costs a fence no hit area.
- **The face is a well, on the same stock as the board.** `--paper-2` is the
  palette's inset-and-well tone, so a region reads a shade *under* the board where
  a card (`--paper-card`) reads a shade over it, and it follows the look without
  a colour of its own. Over it, `.fence-card::after` repeats the same grain tile
  as `#grain` with the same blend and the same two dials — a region marked off on
  the paper is still the paper. Two things differ, both because this copy lives
  inside `#world`: the tile is 512px flat (world units, so the transform gives the
  on-screen size `#grain` has to be told every frame), and the phase is the
  element's own corner, which is invisible because the grain is isotropic noise.
  `--grain-fade` is written to the **root** rather than to the grain layer, since
  `#grain` sits outside `#viewport` and a fence is inside it — otherwise a
  zoomed-out board keeps its texture in exactly the regions that have given it up.
  At **softish only** (`[data-whimsy="0"]`) the region stops being paper and
  becomes a cork board: `cork-board.webp` laid over `--cork` instead of the grain
  multiplied into `--paper-2`. That tier is the one where a board is a scrapbook,
  and every card already lands on a fence wearing a shadow, so the cards read as
  pinned to it. `--cork` is the tile's own mean, sampled from it rather than
  derived from a pigment, because it is what the texture fades back to on the way
  out — derived from an ink, a region would change colour as it went. The middle
  and Harsh keep the paper.
- **The interior takes no presses**, and the rule that says so is on `.item`, not
  on `.item-body` — `.item` is what takes a card's presses and the body is already
  transparent to them for every type, so the first version of the rule was a copy
  of the one it meant to overturn and a region went on swallowing every
  empty-space gesture it covered. A fence is large, and a large card that
  swallowed clicks would end "drag empty space to pan" over most of the board. The
  name plate and the resize grips take the pointer back (a descendant set to
  `auto` is hit inside a `none` ancestor); the plate is the whole of its hit area
  — and it is the one label set at the
  *region's* size rather than a card's (`clamp(10.5px, 2.8cqi, 30.8px)`, the same
  container-query trick the Desktop title card uses), the one that survives
  `#world.zoom-far` — **plate and label both**, since the label lives inside the
  plate and unhiding a child of a hidden parent buys nothing — and the one with a
  default name, because zooming out to find your way around is the moment a
  region's name is what you came for, and because a hidden plate is a region with
  no hit area anywhere on it.
- **The band's offer stands down inside a region.** A rubber band drawn within a
  fence is how you reach for part of what is in one, so when everything it caught
  is already in the same fence `cmds.fencePrompt` opens nothing (`sharedFence()`):
  the grouping it would propose already exists, and the button lands where the
  hand is about to reach for the cards it just selected. Cards from two regions,
  or a band that swallowed the fence itself, still offer. Making a *nested* region
  from part of one is what this trades away, and it keeps the group menu's
  *Fence these*.

Two relations now answer "what travels", and they have to be closed over
together: a note stuck to a card inside a fence travels with the fence, which
neither can see alone. `travelling()` in `layout.ts` is that fixed point — beside
the geometry writes it feeds rather than in the gesture that first needed it,
because a third reading of the two relations is exactly what it exists to
prevent. Both halves go one way only, down: to riders and to contents, never to a
host or to the region around one. `canvas/items.ts` reads it for the **hover
lift**, so the group that rises under the pointer is the group a drag would pick
up — point at a region's name plate and its cards lift with it; point at one of
those cards and the region stays put. They meet again in `stackRoot()`, which
walks both — a fence is drawn behind its members, so raising one has to carry
them or it would cover its own contents.

`isContent()` in `board-model.ts` is the second half of `isFurniture()`'s
question, and exists for the same recorded reason: a fence is nobody's furniture
and is not content either, so the count and the ghost latch both ask one
predicate rather than drifting apart.

`canvas/input.ts` is one Pointer Events pipeline for mouse, pen and touch with
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
Those numbers were got from a per-swipe console log behind a `cmds.debugWheel()`
toggle, which is gone: it had answered its question, and a development aid whose
finding is written down above is a row in the Debug fold that nobody will ever
press again. The measurements stand; the tool that took them does not.

`canvas/renderers.ts` is one entry per item type — `RENDERERS` plus a branch in
`classify()`. Adding a type touches nothing else, and those two stayed in one
file deliberately: they are the pair a new type edits, and splitting them would
double that. What did move out is what was never type dispatch —
`canvas/note-model.ts` (the sticky-note formatting model: pure, and read by the
editor as much as by the renderer) and `canvas/poster.ts` (the video
first-frame grab). Both are re-exported by `renderers.ts`, so no caller had to
learn they moved; `canvas/notes.ts` reads the model directly, because it is the
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

### Stickers, and what "stuck" means

Two changes that only look like one: what stuckness *does*, and a second kind of
thing that has it.

**A stuck item pins — ten seconds after you let go of it.** A note lying on a
card used to travel with the card and still be free to be dragged off it; it now
becomes fixed there, and a press on it takes hold of its host instead —
`dragRoot()` walks up the pile, so a sticker on a note on a photograph moves the
photograph. The pile reads as one object under the pointer, which is what the
hover lift has always promised (`travelling()` lifts the whole group), so the
drag was brought into line with the lift rather than given a rule of its own.
**Selection is deliberately not redirected**: clicking a pinned star still
selects the star, so its menu, its colour and Delete all still reach it. What
you have selected and what you are moving coming apart is the one genuinely new
idea here.

**Stuck and pinned are the same relation a few seconds apart**, and only the
second half waits. Sticking is instant and has to be — a photograph dragged
straight after a note was dropped on it must take the note along. Pinning is the
trap if it is: you drop a sticky, see it is two millimetres off, reach for it,
and the photograph moves. So `SETTLE_MS` (10s) buys a window in which the item
is stuck and still free, `isPinned()` is `stuckTo() && !isSettling()`, and
`dragRoot()` stops at the first thing that has not set. The clock starts
wherever `restick()` runs — `commitGeom()`'s committed pair, so an undo that puts
an item back on a card gives it the same window a hand would — and at `addNote()`
and `addSticker()`, since a thing that has just appeared has just been let go.

Runtime only, and absence of a stamp means *set*: a board being opened has been
sitting still however long ago it was written, so `seedSticks()` clears the
clocks with the memo. There is no timer in the rule, either — the drag redirect
and the hover badge both ask at the moment they run, so a comparison against a
stamp is the whole mechanism. The one `setTimeout` is in `canvas/items.ts`, and
it exists only so the badge appears under a hand that is already resting on the
card rather than waiting for the next hover.

"Immovable" has four doors and three answers, which is why `isPinned()` is one
predicate and the responses are not. A pointer drag redirects to the host; the
arrow keys **unstick and nudge**, because the keyboard is the fine-positioning
tool and having ← move a photograph would be an enormous effect from a very
small key; align, distribute, rearrange and the snap sweep **skip** pinned
items, since a rider's place is a fraction of its host and the host is what the
sweep moved.

**Unstick asks a wider question than the rest** — `isRider()`, not `isPinned()`.
Unsticking something inside its settle window is exactly what you want to be
able to do: it is how you say "leave this here but do not fix it", without
waiting for it to fix itself so that you can unfix it.

**`meta.loose` is the app's first durable piece of stickiness**, and it is the
exception that keeps `sticky.ts`'s rule honest. The positive relation stays
measured — a file that also recorded it could disagree with its own geometry —
but "I unstuck this on purpose" cannot be re-derived, because the usual reason
to unstick a note is to nudge it and the note is therefore still lying on the
card it came off. One guard at the top of `stuckTo()` implements the whole of
it: a loose item behaves exactly as one lying over nothing, so riders, travel,
Mobile placement, stack order and the `meta.stuckTo` stamp all follow with no new
code path. `wouldStick()` is deliberately *not* guarded — a drag that finds a
host is the way back, and `resettle()` clears the flag on any pointer drop that
lands on a card. The flag rides the geometry snapshot pair (`snapshotGeom`), so
one undo restores the decision along with the position; `resettle()` runs in
front of the commit rather than inside it, since replaying it would mean undo
could never restore "loose" at all.

**A sticker is a board item of `type: 'sticker'`**, not a decoration in the
host's `meta`, and that is the load-bearing choice. As an item it gets undo,
selection, z-order, the trash, `.mbrd` serialization, the hover lift, culling —
and every line of the stick machinery above. As a field it would need a parallel
implementation of all of them. The cost is one more branch wherever a type is
switched on, which in this codebase is a short list by design: `RENDERERS`, a
`defaultSize`, and what the feed, the trash and the snapshot should say.

- **`isSticky()`** is the predicate that says which kinds stick, read by
  `sticky.ts`, `stacking.ts` and the serializer. Completeness is the point of
  exporting it: a kind that sticks in `stuckTo()` and is not recognised by
  `stuckFollowers()` is a thing that gets left behind when its host moves.
- **`cannotHost()` gets a sticker exemption**, not a general loosening. A sticker
  may land on a fence and on the title card, both of which a note may not, and
  both refusals had the same reason — a note riding a Mobile band or landing in
  the packed first row as an obstacle nothing packed around. For decoration that
  is the desired behaviour, not the bug it was for a note. Hint cards are still
  refused: a hint is deleted the moment real content arrives.
- **Deleting the host takes its stickers and leaves its notes**, in one undo
  entry (`stickerCascade()`). Two rules because the things are two: a star on a
  photograph is a remark about it and means nothing once it is gone, while a note
  is something you wrote. The walk collects stickers alone, which is also what
  cuts it short at the first surviving host.
- **A loose sticker is a fence member and a pinned one is a rider**, which needs
  no new code — it falls out of `isRider()`. `isJoinEnd()` in `board-model.ts` is
  what keeps a sticker out of the web, and it is deliberately not `isContent()`:
  the same predicate serving connection eligibility *and* fence membership would
  have taken loose stickers out of fences to keep them out of the web.
- **The artwork is Phosphor, and `web/assets/stickers.svg` is generated.**
  `tools/gen-stickers.mjs` vendors forty-five glyphs at a pinned revision — the
  same bargain `tools/gen-formats.mjs` makes with file-analyser, and the same
  do-not-hand-edit rule. It is a second sprite, kept out of `icons.svg` so
  `tests/icons.test.js` can stay strict in both directions: these are content
  picked at runtime, so nothing static can reference them.

  Two weights, by one rule. **Duotone** for anything with a body — it is two
  paths, a background silhouette and the outline over it, which is exactly the
  paper-and-ink construction a sticker wanted, already drawn. **Bold** for the
  marks that *are* a line (the cross, the plus, the arrows), because Phosphor
  gives a line glyph a generic rounded-square plate as its duotone background,
  and a plus sticker that came out as a paper card with a plus on it is a
  different object.

  Nothing is stroked. Phosphor draws every weight as a *filled* path, outline
  weights included, so there is no line-weight token and `items.css` writes
  `stroke: none` out. The paint arrives by inheritance — `fill` is the paper,
  `color` is the tint — and a path opts out with `fill="currentColor"`, which is
  the only value that still follows the tint. Inherited properties are the only
  reason a stylesheet can reach past an external `<use>` at all, which is the
  same fact the icon sprite turns on. The generator is what inverts Phosphor's
  own convention (`fill="currentColor"` on the root, `opacity="0.2"` on the
  background) into this one.
- **`stickers/catalogue.ts`** is a hand-written table and stays one, which is
  the line between the drawings and the decisions: which glyph a shape is drawn
  as is upstream's business, while which forty-five are worth having, what each
  is called, where it is filed and what colour it is *born* is not. The ids are
  mbrd's rather than Phosphor's, because an id is written into a `.mbrd` as
  `meta.shape` and cannot move when an upstream icon is renamed. It imports
  nothing at all, which makes it the lowest module in the graph.
- **`ui/sticker-window.ts`** is the pad: a floating window sharing its move and
  resize gestures with the Playlist's player (`ui/float-window.ts`). Drag a tile
  onto the board, or tap a tile and then tap the board — the second is the only
  one that works on a phone and it works on both. Favourites are app-wide and
  live in `localStorage`, not in the `.mbrd`: a board you send somebody carries
  your stickers and not your picks.
- **Mobile is the one genuinely new mechanism.** The feed is a DOM masonry rather
  than the world drawn small, so there is no transform between a tap and a world
  point — `feedPointToWorld()` goes through the *item* instead: which tile, where
  in the tile, then the same fraction of that item's own box. Pinned stickers are
  drawn on their host's tile at the fraction they hold on the canvas; a loose one
  has no tile to be drawn on and is not drawn, which is the one place this view is
  knowingly not the board.

### Ghosts, exits, grain, models

Ghost cards — the hints a blank board opens with, three sentences and the whimsy
dial — are **real items** in `board.items`, not an overlay, because an overlay
would have meant a second gesture pipeline beside `canvas/input.ts` for the sake
of four cards. `onboarding.ts` owns their ids (`GHOST_IDS`) and their geometry —
it is under `state.ts` rather than in it, because every function in it is
hydration and none of it goes through the door — and `canvas/ghosts.ts` owns the
words and the moment they go, since neither of those two sits anywhere near
user-facing prose. An item carries only a key in `meta.hint`. Being furniture
rather than content is enforced at exactly three
places: `serializeBoard()` strips them so no `.mbrd` carries one, `removeItems()`
does not bin them, and `dismissGhosts()` is hydration rather than a command — no
commit, no history — which is what makes their leaving survive an undo of the
import that triggered it.

`canvas/exit-anim.ts` is the animation a card plays as it is deleted, and the
whole trick is that it runs on a **clone** lifted into a screen-space overlay
while the real node is discarded on schedule. Nothing there touches state, undo,
media release or culling; the clone is stripped of its `<video>`/`<audio>` source
so a card fading out cannot hold a stream open, and undo can rebuild the item
immediately without two nodes fighting for the same id. `exitKindFor()` is pure —
the whimsy tier picks the feel, except a title card, which vanishes and drops a
chip toward the bin.

`canvas/grain.ts` takes both its position **and** its size from the board: the
paper travels on a pan and scales on a zoom, because flecks that belong to the
sheet are a fixed size *on the sheet*. Locked to the glass it reads as dirt on
the lens; travelling but not scaling reads as a second surface with its own idea
of how big things are. The cost is that a pinch is now a full-screen re-raster
rather than a re-position — a pan is still one `background-position` write — and
that a scaling grain sweeps its frequency through the grid's. The noise is
isotropic rather than a lattice, which is what turns what would be hard moiré
into a broad swim; a zoom-out over a Harsh board is where to check.

`canvas/model.ts` holds **one** WebGL context for the whole app and blits it into
each card's 2D canvas; browsers cap contexts around sixteen and a panning board
would spend them all. Model cards are stored as self-photographed WebP stills
until "Rotate model" hands the geometry back.

---

## Size and arrangement

`measure.ts` sits beside `util`/`geometry` at the bottom — pure, no DOM, no
`state` import. It defines the board's one link to reality: `settings.scale` is
**world units per millimetre**, and `settings.units` only chooses the names the
numbers are dressed in. Geometry never reads either. `canvas/paper.ts` draws a
real A4/A3/Letter outline through that scale, and dragging its corners sets the
scale — that is the intended way to set it, not typing a number.

`arrange/arrangements.ts` is likewise pure: every arrangement is
`(items, opts) => [{x, y}]` in input order, so a fresh import and "Rearrange all"
share one code path. `spacing` always means edge-to-edge gap; passing a `seed` is
what makes a layout move its slots, so seedless calls stay reproducible.

---

## Assets and persistence

Items never hold a Blob or URL, only `asset: { hash, embedded: true }`.
`storage/assets.ts` is the hash → bytes registry, which is what makes
dedupe-by-content free. `storage/zip.ts` is a hand-rolled ZIP over the browser's
own `CompressionStream('deflate-raw')`; `storage/mbrd.ts` is the `.mbrd`
container on top of it (`research/docs/mbrd-format.md` is the spec).

`storage/storage.ts` keeps **Save and Export deliberately separate**: Save writes
to IndexedDB (same store as the autosave interval), Export packs the `.mbrd` file
via the File System Access API where available. They fail differently, and the UI
says which is which.

Those are two of three failure models that once shared one 949-line file, so it
is now three: `storage/storage.ts` is the **file** half (the picker, Save,
Export, Open, New), `storage/session.ts` is the browser's own copy (the
IndexedDB working cache, the background autosave, the restore at boot), and
`storage/naming.ts` is the pure title ↔ filename pair both need. The split had
to answer *who owns the file handle*, and the answer is `storage.ts` — a handle
is about the document somebody chose on disk, a session is about the copy this
browser keeps. So `session.ts` is handed the handle, the created-stamp, Export
and the discard prompt through `initSession()` and never imports back;
`storage.ts` re-exports what moved, so no caller had to learn about it.

Any path that can replace the current board must go through the discard
confirmation, which is `ask()` in `ui/dialog.ts` — it replaces `confirm()`
because a destructive question has *three* answers, and the useful one is "no,
let me save this first". It resolves to `'go'`, `'keep'` or `'cancel'`, and every
accidental way out (Escape, backdrop, close) is `'cancel'`; with no document it
resolves to `'cancel'` too, so an unanswerable question about discarding
somebody's work is answered "don't". Passing a `field` changes the contract to
"what" rather than "which", and it resolves to the trimmed string or `null`.

`storage/idb.ts` is the whole IndexedDB surface — two stores, `kv` for the board
snapshot and `assets` for Blobs by hash — and it is **crash recovery only**. The
durable artefact is always the `.mbrd` the user saved.

`optimize/` is loaded by dynamic `import()` and never runs on its own — it is a
button. Nothing in it fires on import, on save or on a timer; it says what it is
about to do first, and originals stay under `meta.was` so the undo is real. It
touches only what it can make meaningfully smaller (`WORTH_IT` in `optimize.ts`),
which is why it is allowed to be lossy at all. The browser does the work:
pictures through `picture.ts`, sound through `opus.ts`. Video is deliberately
left alone — a wasm encoder pins a core for the length of the clip — so
`optimize/media.ts` is down to one job, pulling a first frame out of a clip no
browser here can decode (H.265 from a phone), and that is the one path that needs
ffmpeg.

`import/budget.ts` is the importer's memory boundary and the only one: the
500-file cap in `import/drop.ts` is a UX guard, not a limit on bytes, since one
50 KB PNG can claim 30000×30000 and cost gigabytes at `createImageBitmap()`. New
import paths take `IMPORT_LIMITS` and a byte budget, not a file count.

---

## Three things that reach outside

Everything else in mbrd renders the same with the network off, and opening a
board tells nobody. Three modules are the exceptions and each is built so the
exception is a choice:

- `canvas/embed.ts` is the only code that talks to a third party — a link card
  becomes a YouTube or Spotify player **per click, never by default**, because
  loading an embed tells someone else's server what is on this board.
- `ui/fonts.ts` takes a dropped `.woff2` into the type menus and inside the
  `.mbrd` as an asset rather than fetching a face, so a board keeps its look when
  it is sent to someone else. The family name there is *rebuilt* from the
  filename, never taken — it lands inside a CSS declaration.
- `optimize/media.ts` is the third and the only one that fetches: the ffmpeg core
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
`ui/appearance.ts` writes them onto `:root`. That module is the look *model* —
what a look is, how it is applied, stored and derived from pictures — and
`ui/appearance-controls.ts` is the panel that drives it. They are a seam rather
than a cut: the controls reached upward for thirteen names and the model back
down for eleven, so the panel is handed what it borrows through
`initAppearanceControls()`, with `current` passed as a **getter** because the
model reassigns it whenever a board arrives. `settings.appearance.vars` is the
only part of a board that reaches the browser as *code*, so it is filtered
through the `TOKENS` allowlist in `ui/look.ts` — keep it that way.
`ui/pigments.ts` derives whole palettes in OKLCh from board pictures (48×48
canvas, nothing uploaded) and repairs contrast afterwards.

The palette menu is the one control for "what colour is this board?": four named
palettes and **Dynamic**, which is the board's own pictures. There is no separate
switch — choosing Dynamic allows the extraction and runs it, and choosing a name
takes the permission away and drops every pigment the look was carrying. What the
menu *shows* is derived rather than stored (`dynamicOn()`: permission plus
pigments actually inline), because neither `auto` (permission) nor `derived`
(provenance, and absent from older looks) answers "is this board wearing its
pictures' colours right now". The board reaches Dynamic on its own at
`AUTO_PALETTE_FLOOR` pictures — three, in `layout-settings.ts` with the pure gate
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
| `chrome.css` | the corner, HUD readouts, the toolbar, the now-playing bar |
| `trash.css` | the bin and its panel (`ui/trash.ts`), and the fly-out a deleted card plays (`canvas/exit-anim.ts`) |
| `menu.css` | the panels that open over the board to be answered — Find, the context menu and the toolbar flyouts, the fence offer, the connection chip |
| `library.css` | the board switcher (`ui/library.ts`) |
| `status.css` | what the app says while it works — the drop target, the waiting strip, the toast slips — plus the global `prefers-reduced-motion` stop, which is here because its one exception is the indeterminate bar |
| `dialog.css` | the sheets — the question dialog, the note composer, the credits roll |
| `viewer.css` | the viewer (`ui/viewer.ts`) and documents read inside it (`ui/documents.ts`) |
| `color-picker.css` | the saturation square and the hue (`ui/color-picker.ts`) |
| `sticker-pad.css` | the drawer of shapes (`ui/sticker-window.ts`) |
| `mobile.css` | touch, small screens, and the mobile-only rules |
| `quality.css` | the `[data-whimsy]` and `[data-quality]` tails — **must stay last**, because both have the same specificity as what they override and win on document order alone |

This was one 6,000-line `app.css` until it became the file every interface
change had to touch at once. The eight from `trash.css` to `sticker-pad.css`
were then one 2,370-line `overlays.css` until *that* file had eleven unrelated
subsystems in it and had become the thing the first split was for. The order
above is `index.html`'s, and **the order is the cascade** — it is not cosmetic,
and `quality.css` being last is load-bearing rather than tidy.

### The stack

Every `z-index` in the app, in one place, because the order was reconstructible
only by opening fourteen files and each of them could only ever explain its own
number.

The field runs `1` to `90` with a `100000 !important` at the top of it, which
looks like one axis with an outlier on the end and is not. **There are four
stacking contexts, and a number only ever means something against its siblings
inside one of them.** Two of the three seams are made by properties nobody wrote
for the purpose: `#viewport` carries `contain: layout paint`, and `#world`
carries a permanent `transform`. Both of those create a stacking context as a
side effect, which is what seals the board's own numbers away from the chrome's —
and is the whole explanation of the `100000`, which cannot reach the toolbar at
`20` however large it is. The third seam is `paintStack()`'s own inline number,
which makes every mounted card a context as well. Above all four is the **top
layer**, which is not a z-index at all.

**The root context** — the children of `<body>`. This is the only table where a
number is a claim about the whole screen.

| z | what | declared in |
| --- | --- | --- |
| *top layer* | `#ask`, `#pick`, `#compose`, `#viewer`, `#credits` — a `<dialog>` opened with `showModal()` is promoted out of the page entirely | `dialog.css`, `color-picker.css`, `viewer.css` — **none of them declares a `z-index`, and none can**: the top layer is above every number here by definition |
| 99999 | the view-change debug strip | `perf/view-perf.ts`, as an inline style — the one thing in the app that outranks the app |
| 90 | `#splash`, the boot cover; `#nojs`, its no-JavaScript twin | `base.css`; the `<noscript>` `<style>` in `index.html` |
| 70 | `#search` — over the context menu, which it can be opened from | `menu.css` |
| 61 | `#fence-prompt`, the offer under a rubber band | `menu.css` |
| 60 | `#ctx-menu`; `#bin-ghost`; `.sticker-ghost` | `menu.css`; `trash.css`; `sticker-pad.css` |
| 59 | `#conn-chip` — deliberately *under* the menu, because the menu is opened from the chip and then covers it | `menu.css` |
| 55 | `#busy`, the waiting strip | `status.css` |
| 50 | `#toast` | `status.css` |
| 41 | `#mobile-header-edit-btn`, but only while `#sidebar.is-open` | `sidebar.css` |
| 40 | `#sidebar`, `#header-panel`; `#library`; `.player-window`; `.sticker-window` | `sidebar.css`; `library.css`; `mobile.css`; `sticker-pad.css` |
| 30 | `#menu-btn`, `#mobile-header-edit-btn`, `#mobile-find-btn` | `sidebar.css` |
| 25 | `#drop-overlay` | `status.css` |
| 24 | `#exit-layer`, the delete fly-out | `trash.css` |
| 20 | `#corner`, `#toolbar`, `#nowplaying`; `#bin` | `chrome.css`; `trash.css` |
| 2 | `#mobile-feed`, `#mobile-playlist` | `mobile.css` |
| *auto* | `#viewport`, then `#grain`, then the paper on `<body>` — document order, no number | `canvas.css`, `base.css` |

Three of those are worth reading as decisions rather than as numbers. **59, 60,
61 are one conversation**: the connection chip is below the context menu because
the menu can be opened *from* the chip, and the fence offer is above it because
the two can never be up together and a right-click withdraws the offer. **41 over
40** is the masthead pen keeping the top-left corner the sidebar slides over,
which is right on a desktop and wrong on a phone, where `mobile.css` takes the
pen away instead. And **the two feed surfaces at 2 are siblings of `#viewport`,
never children of it** — `index.html` says why, and it is not about layering: a
surface nested inside `#viewport` would inherit `--iz` and be caught by the
whole-board style invalidation `canvas/mobile-frame.ts` exists to avoid.

One comment disagrees with this table and nothing depends on it. `base.css`
justifies the boot cover as sitting "above the sidebar (40), the dialogs (70) and
the toast (50)": 70 is `#search`, and a modal `<dialog>` is in the top layer and
therefore *above* `#splash` rather than below it. Nothing opens a dialog before
the cover is dismissed, so the arrangement is fine and only the reason given for
it is not.

**Inside `#viewport`** — sealed by `contain: layout paint`. Every number here is
under all of the chrome, because `#viewport` itself is `auto` in the table above.

| z | what | declared in |
| --- | --- | --- |
| 21 | `.note-toolbar.is-mobile`, the formatting bar across the top of a phone | `items.css` |
| 6 | `.note-toolbar`, the desktop float — screen space, so it is never scaled by zoom nor clipped by the item box | `items.css` |
| 5 | `#marquee`; `#fence-ghost` — the same number for the same reason, both being board furniture the toolbar and the panels have to stay over | `canvas.css`; `menu.css` |
| *auto* | `#world` | `canvas.css` |

The `21` is the one that looks like it is reaching for the chrome and is not: it
cannot outrank `#toolbar` at 20 from in here, which is why the phone's note edit
mode *hides* the two corner buttons through `:root.note-edit-mobile` rather than
trying to cover them. When the same bar is mounted in the note composer instead,
it is inside a `<dialog>` and so in the top layer, and none of this applies.

**Inside `#world`** — sealed by the permanent `transform` that makes pan and zoom
one composited layer.

| z | what | declared in |
| --- | --- | --- |
| 100000 `!important` | `.item[data-type="title"]` while hovered or selected, at every zoom rung except `.zoom-tiny` | `canvas.css` |
| *per item, inline* | the visual stack — `paintStack()` in `canvas/items.ts` writes each `.item` its rank, with every fence in a band below every card | `canvas/items.ts` |
| −1 | `#item-shadows`, the shared underlay every card's shadow is painted into | `canvas.css` |
| −2 | `#web`, the connection lines — under the items, which is why a route that cannot go around goes *behind* and still reads as a wire | `canvas.css` |

**The `100000` is correct and should stay.** It is not competing with the
chrome — it cannot, from inside two nested stacking contexts — it is competing
with the other cards, and it has to beat all of them at once because the number
it must exceed is whatever `paintStack()` last wrote to the topmost item. The
title card's pen and buttons straddle its edge and hang outside its box, so
without the lift they are reachable only when the card happens to be on top
already. `!important` because the inline z-index it is overriding is written by
JavaScript, and an inline declaration cannot be beaten by a stylesheet any other
way.

**Inside one `.item`** — every mounted item is a stacking context of its own,
because `paintStack()` gives it a numeric `z-index`. So these four numbers repeat
on every card on the board and never interact between two of them.

| z | what | declared in |
| --- | --- | --- |
| 3 | the title card's pen; and the controls raised over the grips — `.vbig`, `.wave`, `.vtrack`, `.card-link .card-name` | `canvas.css`; `items.css` |
| 2 | the resize grips and corner marks | `items.css` |
| 1 | the title card's strike-out gutter; `.far-head`; the ring drawn at `#world.zoom-far`; the flat shadow substitute under `[data-q-shadows="off"]` | `canvas.css`; `items.css`; `quality.css` |

`.feed-sticker` in `items.css` also carries a `2`, and it is the exception that
proves the arrangement: it is drawn on a Feed tile rather than on a board item,
so it is inside `#mobile-feed` at the root's `2` and has nothing to do with the
grips it shares a number with.

**Adding one.** Decide which of the four contexts the element is actually in
before choosing a number — the mistake this table exists to prevent is picking a
value from the wrong table, which produces an element that is either invisible or
permanently on top and no console anywhere will say so. New chrome that must
cover the panels goes above 40 and below 50; new board furniture goes at 5 beside
the marquee; anything that must cover *everything* is a `<dialog>`, not a bigger
number.

### The icons

Every icon in the app is a `<symbol>` in `web/assets/icons.svg`, reached by name:

```html
<svg class="ico"><use href="assets/icons.svg#i-note"/></svg>
```

`index.html` writes that by hand; `ui/menu.ts` builds it with `icon()`, which
`ui/fence-prompt.ts` imports so the offer under a rubber band and the
`Fence these 5` menu entry are one drawing. **A new icon is a symbol here and a
reference to it**, never a path pasted into a button — which is what this
replaced: twenty-four inline `<svg>` blocks, three of them the same close cross
and two the same pen, each a few characters from its twin because they had been
edited at different times, and stroke weights running 1.3 to 1.7 across the set.

The drawing spec is one CSS rule (`.ico` in `base.css`), and it can be, because
**a `<use>` renders its symbol into a shadow tree that inherited properties cross
and selectors do not.** Both halves of that are load-bearing:

- Inheritance is what makes the set a set. `fill`, `stroke`, `stroke-width`,
  the caps and joins, `currentColor` and custom properties all reach inside, so
  forty drawings take their weight from one declaration, and an icon is the
  colour of the row it sits on without either knowing about the other. Every
  surface that had an opinion about size before the sprite existed still has it,
  because every one of those is an id selector and outranks `.ico`.
- The absence of selectors is what constrains membership. Anything whose
  *insides* are addressed from a stylesheet cannot live here. `#origin-mark` is
  the one that stayed inline: `quality.css` picks one of its three rings by
  whimsy tier. `#zoom-lock` had the same problem and moved anyway — it is two
  symbols and two wrappers now, and `chrome.css` hides a wrapper rather than a
  path. Getting this wrong is silent: the rule matches nothing and the padlock
  draws both shackles at once.

The sprite is in `SHELL` in `web/sw.js` — without it an offline board opens with
every button blank. `tests/icons.test.js` checks that every reference resolves,
that nothing in the file is unreferenced, that no two symbols are the same
drawing, that every menu entry carries one, and that nothing new has been written
inline. A misspelled id is otherwise not an error anywhere: the browser finds no
such fragment and draws nothing.

A new rule goes next to the subsystem it styles. A new *file* has to be added to
`index.html`, to `SHELL` in `web/sw.js`, and to `APP_CSS_ORDER` in
`tests/helpers.js` — `tests/sw.test.js` walks `assets/css` and will fail until
the second of those is done. The banner at the top of `base.css` repeats this
list, which is where somebody opening the stylesheets will look first.

---

## Invariants the tests enforce

- **No browser globals at import time.** Reaching for `document` inside a
  function is fine; reaching for it in a module body is not. The only exceptions
  are `main.ts`, `ui/appearance.ts` and `optimize/media-worker.js`, listed in
  `tests/imports.test.js`. Adding a fourth is a regression. The odd extension on
  the third is not a slip: it is fetched by URL at runtime as a *classic* worker
  and a browser cannot fetch a `.ts` file, which is also why it is the one module
  outside the bundle and named in `SHELL` on its own.
- **Every shipped asset appears in `SHELL` in `web/sw.js`** (`tests/sw.test.js`).
  That list drifted once and left a font uncached offline. What counts as a
  shipped asset changed when the bundle landed: the test walks `assets/css` and
  `assets/fonts` and **no longer walks `assets/js`**, because the modules under
  it are sources rather than assets — what the page loads is `assets/app.js`, and
  the shell names that one artifact plus the media worker beside it. The test
  gained a check that no `.ts` path ever appears in the shell, which is the guard
  against somebody re-adding the module list it used to walk.

  `web/lab.html` is the thing that arrangement has to keep possible: a bench for
  the palette extractor, deliberately out of the offline shell, sitting at
  `web/`'s top level only because the dev server's document root is `web/` and
  that is the one place a page can reach the real `ui/pigments.ts` rather than a
  copy of it. It is a single file with no module of its own under `assets/js`,
  which used to be because the walk would have demanded it be precached and is
  now because a module of its own would be a second thing to build. `robots.txt`
  deliberately does not block it — the `noindex` in its head has to be fetched to
  work, and a `Disallow` would stop the fetch that delivers it.
- **The layering graph is executable** (`tests/layers.test.js`), not advice.
- **Every icon reference resolves to a symbol in `assets/icons.svg`, and every
  symbol is referenced** (`tests/icons.test.js`). A misspelled fragment id is not
  an error in any browser — it draws nothing at all — so the check has to be here
  or it is nowhere. The same test holds the line the sprite exists to hold: no
  two symbols are the same drawing, and nothing new is written inline.
- **Every bundled `woff2` family has its licence file beside it**
  (`tests/fonts-license.test.js`). Geist shipped without one for several
  versions; the OFL requires it.
- `web/sw.js`'s `VERSION` and `web/assets/js/version.js` are bumped by regex at
  release — do not hand-edit or reformat those lines.
- `web/assets/js/import/formats.ts` is generated. Regenerate it, never edit it.

Two optional runs sit beside the suite, neither required to contribute:
`npm run lint` (oxlint, correctness only, no formatter — adding one would be a
regression) and `npm run typecheck` (above). Both want `npm install`; `npm test`
never does. There is no browser-driven suite: what a headless test structurally
cannot see — pan and zoom, add/select/delete/undo, save → refresh → recover, and
that the app boots with a clean console — is checked by launching the app.

Tests are still not a substitute for looking: for canvas or storage changes,
launch the app and exercise pan/zoom, selection, save/open, refresh recovery and
the browser console.

---

## Why this is not built on a framework

It gets asked, so the numbers are here rather than in someone's memory.

Of ~31,600 lines of application code, about **11,500 are in modules that never
touch `document` or `window`** — struct reading, ZIP containers, OKLCh
arithmetic, spanning trees, packing. A view framework has nothing to say about
any of it.

Of the rest, most is imperative because the app is. `canvas/input.ts` runs one
Pointer Events pipeline where a synthetic event system would be the thing to
escape. `canvas/items.ts` detaches nodes by hand for memory reasons — the
opposite of a reconciler owning the tree. `canvas/viewport.ts` owns a single
composited transform a framework would have to be told not to touch. The media
modules must **not** remount, because remounting a `<video>` stops playback.

That leaves the genuinely view-shaped code — the panel, sidebar, menu, dialog,
search, bin, now-playing bar, mobile header — at roughly 5,000 lines, of which
maybe 3,000 is actual view. A rewrite would put 32,000 lines at risk to shorten
3,000, and would trade away the zero-runtime-dependency property that is the
project's whole shape.

There *is* a build step now, and it is worth being exact about what that does and
does not concede. It converts the source tree from the artifact into the input to
one, which is the trade the bundler was bought for. It does not put anything
between the app and the browser at runtime: nothing is fetched, nothing is
polyfilled, `THIRD-PARTY.md` is still four fonts long, and the three
devDependencies are a linter, a typechecker and a bundler, none of which ships.
The property a framework would take is a different one — a reconciler owning the
DOM, a synthetic event system over the pointer pipeline, a component lifecycle
over the cull — and none of that is any cheaper to adopt for esbuild being in the
loop.

And the declarative layer a framework would sell already exists here:
`ui/settings-schema.ts` plus `ui/panel.ts` is data-driven UI with a test on it.

The one real gap — no compile-time safety — was closed with JSDoc and `checkJs`
over nine files, and then closed properly: the app is TypeScript. `npm run
typecheck` runs `tsc --noEmit` under `strict`, nothing is emitted, and no
TypeScript ships — esbuild builds the bundle, tsc only checks.

The types are not all written yet, and the ledger is explicit rather than
implied. A mechanical rename moved 104 modules in one step and left 4,935
errors under `strict`; the unannotated ones carry `// @ts-nocheck` and
`tests/ts-debt.test.js` holds the count with a ceiling that may only fall. So
what the typecheck asserts is *everything not on that list is clean under
strict* — true today, truer each time a module is converted. Converting one is
deleting its pragma and lowering the ceiling. It paid for itself on the first
run by finding `web-graph.ts` calling `corners()` and `pointInItem()` without
importing either — a `ReferenceError` out of `threads()` that stopped the
relationship web drawing past its spanning tree, silently, for the life of the
module.

The full reasoning, with per-module line counts, is in
`research/old/open-source-readiness-2026-08-02.md`.
