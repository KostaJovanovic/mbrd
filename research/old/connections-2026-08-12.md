# Connections: what the feature is missing

*Written 2026-08-12, before any of it was built, and carried out on the same
day. History, not a specification — where this disagrees with the code, the code
is right. The status block below is the half worth reading if something looks
wrong.*

## Status: all five landed, with three departures

Built, in the order staged at the bottom: route shape by tier and its
invalidation, the draft line and the aim ring, the active connection, colour and
weight, the focus lift. `npm test` is green at 992, including seven new shape
assertions in `tests/web-route.test.js`.

Three places the code does not do what this document says, each because writing
it made the reason plain:

1. **The router's shapes are `square`, `grid` and `taut` — there is no `soft`.**
   This proposed `'grid' | 'taut' | 'soft'`, and Softish turned out not to be a
   shape at all: it is the taut shape with `opts.clearance` raised, and shape and
   room are two arguments. A `'soft'` case would have been a name for a number
   the caller was already passing, and would have put a look decision inside the
   pure module twice over.
2. **The taut pass pins only the two edge points, not the stubs.** The argument
   here was that a connector should leave a card's face squarely, so the stub
   should survive the pull. It should not: the straight-line case above it
   already leaves both cards diagonally, so pinning the stubs would give a route
   with one bend a square exit and a route with none a diagonal one. One shape,
   one exit. The stub still does its original job everywhere else — it exists so
   an *orthogonal* route does not set off along the face of the card it left.
3. **`grid` quantizes the obstacle blocks and never the two ends.** So "every
   interior turn lands on a multiple of the step" is too strong, and the test
   asserts the honest version: the turn *taken round a card* is on the lattice.
   A two-bend elbow between two otherwise clear cards still turns on the cards'
   own anchor lines, because snapping those would move the line off the face of
   the card it just left — and a stub eighteen units out would be swallowed by a
   block grown sixty-four.

The midpoint chip left open under item 3 **was** built, a beat later and on
request, as `ui/conn-chip.js`. What the argument against it got right is in its
shape: it is not a second editor. It carries the two settings that are cycled
rather than chosen (arrows, dash), the one that is typed, the one that is final,
and a button through to the menu for everything else - so there are not two
places to choose a colour, and the menu stays the complete one.

One thing this document did not predict at all, found the moment the lines were
bright enough to look at: **hovering a card revealed the end of the line under
it.** A card's lean at the soft end is presentational and therefore not in
`item.rot`, so routes ended on the untilted box while the drawn card's corners
stuck out past it - and the hover lift then slid the card off the last few units
of its own line. The first fix was wrong in an
instructive way - padding every card's box out to the tier's maximum lean traded
a stub that appeared on hover for a gap that was there all the time. A card's
drawn outline is exactly knowable, so the answer is to stop exactly on it:
`items.js/tiltOf` reports the lean a card was actually dealt, `centres()` folds
it into the rotation the router sees, and `exitTowards()` clips the endpoint
against the *leaning rectangle* rather than the box around it. Everything else
in the router goes on using the box, because everywhere else too big is the safe
mistake and at an endpoint it is not.

Two more things the writing did not foresee, both about a taut line rather than
an orthogonal one. `anchorFor()` puts an end at the middle of a *face*, which is
exactly right for a route that leaves perpendicular and wrong for a ruled line:
a taut line is aimed at the two cards' middles, so its ends are where that line
crosses their edges. And the selected line was drawn as an opaque accent stroke
*over* the connection, which hid whether it was dashed or dotted at the one
moment somebody had selected it to change that - so the mark and the hover are
both haloes underneath now.

Colour and weight reached the menu as two folds rather than a row of swatches
(`sub:` entries, the same mechanism align/distribute uses). Direction and style
are four and three rows, colour and weight five and three more, and the eight on
the face of the menu would have made a right-click on a hairline the longest
menu in the app.

Connections are finished as data and thin as an interaction. `board.connections`
is a stored list of pairs with an additive third element for how each one is
drawn; `web-graph.js` offers to generate a set; `web-route.js` is a pure,
tested, orthogonal router that goes round the cards in the way; `canvas/web.js`
draws them with a fade, a cull, a hit-test and a routing budget. All of that
works. What is missing is everything between the person and the line.

Five things, in the order they are worth doing. The first is the only one that
is a new idea rather than a missing affordance, and it is the one this document
spends its words on.

---

## 1. The shape of a route should answer the whimsy axis

### What is wrong

Every route in the app is an orthogonal staircase, at every level of the look
slider. The axis reaches connectors exactly once, in `cornerRadius()` at the
bottom of `canvas/web.js`: 0 at Harsh, 9 in the middle, 14 at Softish. That
function's own comment states the principle it is defending —

> A connector with a corner style of its own would be the one element on the
> board with an opinion about how the interface looks.

— and then the module rounds the corners of a picture whose *shape* has an
opinion of its own at every level. Softish rounds the paper, softens the
shadows, tapes the hints down and waves the player's fill line, and the
connectors running across that board are right angles with a 14-unit fillet.
Harsh squares everything and snaps the cards to the lattice, and the connectors
are the same right angles at radius 0, turning wherever the obstacle edges
happened to fall rather than on the lattice the cards are standing on.

The corner is the smallest possible reading of a decision that belongs to the
whole path.

### What it should be

| level | shape | corner |
| --- | --- | --- |
| Harsh (2) | orthogonal, and every turn on the board's own lattice | square |
| Middle (1) | taut: straight when nothing is in the way, fewest bends when something is, no obligation to 90 degrees | 9 |
| Softish (0) | the same taut path, curving round what it passes | large |

Three shapes, one axis, and each of them is the shape that level already means
everywhere else on the board.

### Harsh: route on the lattice the cards are already on

This is half-built and nobody has said so. `axisMoved()` in `ui/appearance.js`
ties Harsh to `settings.snap` — moving the slider to the hard end snaps the
board — so at that level the cards are *already* on multiples of `baseStep()`.
The router, meanwhile, builds its lattice out of the obstacle edges pushed out
by `CLEARANCE`, which on a snapped board is a set of lines sitting 14 units off
the grid. A snapped board with unsnapped connectors is the axis half-applied.

So at Harsh, quantize the candidate lines: an obstacle's `x0 - CLEARANCE`
becomes the nearest grid multiple at or beyond it, and the same outward
rounding on all four sides. Outward, never inward — the whole point of the
clearance is that a route does not graze a card, and rounding towards the card
would eat it. The two ends' own edge and stub lines stay where they are: a route
has to actually leave the card it starts from, and a card can sit off-grid even
on a snapped board (a fence, a rotated card, anything dropped before snapping
was switched on).

The cost is a slightly longer path, and the gain is that the drawn picture at
that level is one lattice rather than two lattices a few units apart.

**Rejected: a grid-only router at Harsh** — throw the obstacle lattice away and
search a uniform grid of `baseStep()` cells. This is what the module's own
header rejects for the general case ("Why a lattice and not a grid"), and the
reason survives at Harsh: world space is infinite and float, a long route across
a large board is hundreds of thousands of cells, and a route between two cards
three grid squares apart would have no lines to turn on that the obstacle
lattice does not already give it. Quantizing the existing lattice gets the
picture without the search.

### Middle: taut, not orthogonal

The middle of the axis is the bare stylesheet — the level with no opinion — and
a right-angled staircase is an opinion. What that level should draw is the line
somebody would draw with a ruler: straight from one card to the other, bending
only where something is in the way, and bending by however many degrees the
detour actually needs.

Two steps, and neither is a second router:

1. **Straight first.** If the segment between the two boundary points is clear
   of every obstacle, that is the route: two points, no stub, no bend. The
   router already tries a cheap two-bend `simple()` path before it builds a
   lattice for exactly this reason; this is the same idea one step cheaper, and
   on an ordinary board it will be the answer most of the time.
2. **Otherwise, run the existing search and pull the string.** A* over the
   orthogonal lattice produces a corridor that is known to clear everything.
   Walk it and drop point *i* whenever the segment from *i-1* to *i+1* still
   clears every obstacle block; repeat until a pass drops nothing. What is left
   is a taut polyline with the fewest bends the corridor allows, and every
   segment of it has been checked against the same blocks the router used.

The clearance test that makes step 2 safe is already written — `segmentBlocked()`
does exactly this for the axis-aligned case, and the diagonal case is a
segment-versus-box test the codebase also already has in `geometry.js`
(`segmentMeetsRect`, which `canvas/web.js` imports for culling). Note the
difference the router's own comment draws between the two: `segmentBlocked()`
deliberately allows a segment to *run along* a block's edge, because the lattice
is built from those edges. A taut segment is not on a lattice line any more, so
the strict test is the right one here, and using the lenient one would let a
pulled string lie flat against a card.

**The stubs are a real decision.** `anchorFor()` picks the side of the card that
faces the other one and pushes a `STUB` of 18 units straight out of it, so a
route leaves a card squarely rather than sliding along its face. Under
string-pulling the stub is the first thing that would be dropped, and dropping
it is wrong: a connector that leaves the face of a card at fifteen degrees reads
as a line that happens to touch the card, not one that comes out of it. So the
first and last points are pinned and only the interior is pulled — except in
case 1 above, where the direct line *is* the picture and a stub would be a
detour on the way to nowhere.

**Rejected: a real any-angle search** (Theta*, or a visibility graph over the
obstacle corners). Both give shorter paths than pull-the-string, and neither is
worth its cost here. The visibility graph is quadratic in the corners and this
runs inside a per-frame budget on boards with hundreds of cards; Theta*
line-of-sight checks turn the same A* into something several times slower for a
picture nobody could tell apart at the two or three bends a card-to-card
connector actually has. The corridor is already optimal-ish and already paid
for. Pull it and stop.

### Softish: curve round, and pay for the curve up front

The taut path again, with its bends drawn as curves rather than as corners.

Reuse `pathData()`. It already takes a radius, already replaces a corner with a
quadratic through the turn point, and already clamps the radius to half the
shorter of the two runs meeting there — which is the clause that stops an arc
from overshooting the next corner and drawing a knot. It is written, it is
tested, and it does not care whether the two runs are axis-aligned, which is
what makes it work on a taut path as well as an orthogonal one.

**The cost, named rather than discovered later:** a fillet cuts *inside* the
corner, and at Softish the radius wants to be large. A corner in a route is
precisely where the path is hugging an obstacle at `CLEARANCE` — that is what
put the corner there — so a large fillet at that corner eats into the clearance
and, past about 14 units, into the card. Smoothing a path that was routed at
full clearance and hoping is how a curve ends up lying across a photograph.

So Softish routes against an inflated clearance: `CLEARANCE + SOFT_RADIUS`,
paid before the search rather than after it. The route comes back wider round
every obstacle, the fillet takes the width back, and the drawn curve clears by
the same margin the straight one did. It also means the fallback ladder in
`routeConnection()` — full clearance, a third of it, none, then ignoring cards
that overlap an end — starts one rung higher at Softish and degrades through the
same rungs, which is the behaviour that already exists rather than a new one.

**Rejected: a Catmull-Rom spline through the taut points.** Prettier in the
abstract and unbounded in practice — a spline through three points can bulge
outside their convex hull, which is to say into the card the route was avoiding,
and the fix is a clearance re-check plus a subdivision loop plus a fallback for
when it fails. That is a new algorithm with its own failure mode, to replace one
that is thirty lines and provably stays inside the corner.

### Where the mode comes from, and why the router still cannot see it

`web-route.js` imports `geometry.js` and nothing else. That is not an accident
of tidiness — `tests/layers.test.js` holds the list, and the reason the module
exists at all is that the algorithm is the half that can be checked in node.
Reading `document.documentElement.dataset.whimsy` from inside it, or importing
`baseStep()` from `layout.js`, would end that.

So the mode is a **parameter**. `routeConnection(from, to, obstacles, opts)`
where `opts` carries `{ shape: 'grid' | 'taut' | 'soft', step, clearance }`, and
`canvas/web.js` — which already reads the DOM for `cornerRadius()` and the board
for everything else — is what turns the whimsy level and `baseStep()` into that
object. The router stays a function of its arguments, and the three shapes
become three things `tests/web-route.test.js` can assert without a browser:

- at `taut`, two cards with nothing between them produce exactly two points;
- at `grid`, every interior turn lands on a multiple of `step`;
- at every shape, no point of the returned path lies inside any obstacle block
  grown by the clearance that was asked for.

### The invalidation nobody owes today

A route becomes a function of the whimsy level, and routes are **cached**:
`build()` keeps a stored path for exactly as long as `sigOf()` — the two end
boxes — is unchanged. Move the slider and no card moves, so every signature
matches, so every line keeps the shape it had at the old level. The board would
re-skin around a set of connectors that did not.

`axisMoved()` emits `bus.emit('settings', 'appearance')`. `canvas/web.js`
listens for `settings` and acts on one key:

```js
bus.on('settings', key => { if (key === 'web') requestBuild(); });
```

That branch needs a second clause: on `'appearance'`, clear `seg.routed` across
`lastSeg` and request a build, so the next `routePass()` re-routes everything
against the new shape. Not `resetWeb()` — that releases the fading elements and
the settled set as well, which would make every line on the board blink on a
slider move. This is the narrow version of the same idea, and `resetWeb()`'s
header is the explanation of why it has to exist at all: a cached route survives
the one command whose purpose is to put things right.

It is worth noticing that this bug exists already, in miniature: `cornerRadius()`
is read in `paint()`, and a slider move does not currently request a paint
either, so corners change at the next unrelated repaint. Fixing the shape fixes
the corner with it.

---

## 2. The tool draws blind

Arm the connector, press a card: it gets a `data-pick` ring and that is the
entire feedback loop. Nothing follows the cursor, nothing says which card would
be the other end, and the only way to find out what the line will look like is
to finish it.

**A draft path.** `canvas/web.js` already owns an `<svg>` inside `#world` with
the right transform and a non-scaling stroke; the draft is one more `<path>` in
it, in the accent, dashed, under `.web-draft`. Straight while the pointer is
moving and routed once it settles — which is not a new rule, it is the rule the
whole feature already lives by ("no routing during a drag, and only the affected
connections rerouted on the drop"). A draft is a drag by another name.

**A target ring.** The card under the pointer gets an attribute in the same
family as `data-pick`, and the same outline treatment: outside the card, not
over it, following the card's own radius, so it reads on a photograph. The
existing `.item[data-pick]` rule is the pattern and most of the CSS.

**Escape already works** — `ui/toolbar.js` disarms on it, and the draft only has
to be cleared alongside the pick.

**Rejected, or at least deferred: drag from one card to the other in one
gesture.** It is the gesture every other tool of this kind uses, and it costs
more here than it looks. `canvas/input.js` is one pipeline with exactly one
active gesture and must not be split; a press on a card that might become a
connection-drag and might become a card-drag is a new branch in the one place
this codebase has decided not to grow branches. And the tap-tap flow is not a
compromise — the toolbar's own comment defends it: the tool stays armed after a
pair, so connecting five things is one trip to the toolbar rather than five.
Worth revisiting after the draft path exists, because the draft is most of the
work either way.

---

## 3. A line can be edited exactly one way

`cmds.connectionUnder` → `connectionEntries()` in `ui/menu.js` is a complete
editor: direction, style, label, remove, each a ticked row filing one undo step.
It is reachable by right-click and by nothing else. There is a hover state
(`.web-hover`, the accent, two units heavier) that promises a line is a thing
you can act on, and then the only act available is the one that needs the other
mouse button.

**An active connection, owned by `canvas/web.js`.** A click on a line makes it
active; `.web-active` draws it; Delete or Backspace removes it; double-click
opens `cmds.editConnectionLabel`. The right-click editor stays exactly as it is.

**Not part of the item selection**, and this is the decision worth writing down.
Selection in `state.js` is a set of item ids, and everything downstream assumes
it: band-select, group drag, arrange, align, delete, the trash, the sidebar's
count. Widening it to hold a heterogeneous thing so that one line can be clicked
is a large blast radius for a small affordance, and every one of those consumers
would grow an "is this an item" clause. A single active pair in the draw layer,
exposed through `cmds`, cleared when the selection changes or the tool arms, is
the same affordance with none of that.

The one thing it costs: Delete has to check the active connection before it
reaches the item path, which is a branch in the key handler — and that branch is
the honest one, because with a line lit up and nothing selected, Delete means
the line.

**Open: a midpoint chip.** `polyMidpoint()` already exists (labels use it), so a
small floating row of buttons at the middle of the active line is cheap to
place. It is the discoverable version of the context menu and it is also one
more thing on the board. Decide during implementation, with the active state
built first — the chip is worthless without it and possibly unnecessary with it.

---

## 4. Every line means the same thing

`connMeta()` validates `dir`, `style` and `label`. Three properties, and none of
them is colour, which is the first thing anybody reaches for when two kinds of
relationship are on one board.

Add `color` and `weight` to the same third element. Both from a **closed
vocabulary** — named swatches that resolve to tokens, and three or four named
steps for weight, never free values. The reason is the reason `look.js` keeps a
`SAFE_VALUE` regex: this object comes out of a file somebody else wrote, and a
string that reaches a stroke attribute is a string that reaches the CSSOM.

Everything else about it is already true:

- **Additive, no version bump.** Defaults are omitted, not stored, so a plain
  connection stays `[a, b]` on disk and an older reader ignores what it does not
  know. This is the argument `board-model.js` already makes for the third
  element; colour is another instance of it, not a new claim.
- **Free to draw.** A connection with meta already leaves the bulk path for its
  own element in `decoLayer` — that is how a dash and an arrowhead are drawn
  today — so a per-line stroke costs nothing architecturally. Only the bulk path
  can carry one colour, and a coloured line is not on it.
- **`docs/mbrd-format.md` moves with it**, and the change gets called out as a
  `.mbrd` schema change when the work is reported, per `CLAUDE.md`.

The menu grows a row of swatches and a short radio, in the shape
`connectionEntries()` already uses.

---

## 5. A board with a hundred lines is unreadable

Nothing lifts one card's connections out of the rest. At the far zoom — the view
whose whole purpose is to show the shape of the board, and the reason the web
has no zoom floor any more — every thread is drawn and they are all the same
weight.

**A focus path.** A second `<path>` holding only the threads of the focused card,
drawn in the accent at full strength, and a class on `#web` that drops the bulk
path's opacity while a focus exists. Two `d` strings instead of one, only while
something is focused, and no stored state at all — the same split the fade
machinery already makes between the bulk path and the elements that leave it.

**Open: what focuses it.** Selection is quiet, survives a pointer leaving the
card, composes with everything else, and has to be discovered. Hover is
immediate and turns a pan across a dense board into a strobe. The likely answer
is selection, with hover considered only if it can be made to settle — but this
is a judgement about how the board feels, and it should be made with it on the
screen rather than here.

---

## What stays out

Listed, because a document that only proposes additions reads as a roadmap and
this is not one.

- **Connections stay off Mobile.** The Mobile layout is a reading-order feed, not
  a spatial map; `webVisible()` says so and `build()` releases the geometry
  rather than hiding it. Nothing above changes that.
- **Lines still do not avoid other lines.** Only cards are obstacles. The
  router's header has the argument and it is unaffected by any of this:
  connections avoiding each other multiplies the cost of every route by the
  number of routes, for something nobody looks at, and two crossing lines are
  what every diagram in existence draws.
- **Routes are still not cached across sessions.** A path is a function of where
  the cards are now. There is nothing to invalidate and nothing to go stale —
  except, after item 1, the whimsy level, which is exactly why that item ends
  with an invalidation clause rather than a cache key.
- **`settings.web` keeps its name.** An older build reads that key to decide
  whether to draw anything between cards. Renaming it costs the SHELL list, the
  layers test, three passages of `docs/architecture.md` and a silent change to
  every board that had the web switched on, for nothing.

---

## Staging

Each stage is worth landing on its own, and they are in dependency order rather
than in value order — item 1 touches the pure layer and wants to be settled
before three other things start drawing against it.

1. **Route shape by tier.** `web-route.js` grows the `opts` argument and the two
   post-passes; `canvas/web.js` turns the whimsy level and `baseStep()` into
   them, and grows the `'appearance'` invalidation clause. Tests are shape
   assertions in `tests/web-route.test.js`, no browser needed.
2. **The draft path and the target ring.** `canvas/web.js`, `ui/toolbar.js`,
   `canvas/input.js` (one branch, no split), `canvas.css`.
3. **The active connection**, Delete, double-click-to-label. Adds the key branch
   and a `cmds` entry; no model change.
4. **Colour and weight.** `board-model.js`, the menu, `docs/mbrd-format.md`, and
   a schema call-out in the report.
5. **Focus.** `canvas/web.js` and one CSS rule, once the question of what
   focuses it has been answered on a real board.
