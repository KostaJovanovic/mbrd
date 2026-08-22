# Revising how a connection is drawn — 2026-08-22

**Carried out**, all five items, in the order below. The record of what was
decided and why; the code carries the same arguments in its own headers, and
`research/docs/architecture.md` carries the summary. What is *not* done is
listed at the foot.

The brief was three complaints about the *picture*, not about the
tool that makes one: lines land on top of each other, the shape is at once too
tight to the cards and too stiff, and a route that gives up goes behind a card.
Nothing here touches `board.connections`, the `.mbrd` schema, the connector
mode, or the chip — see `research/tester-feedback-2026-08-21.md` for that half.

Everything below is `web-route.ts` (pure, 878 lines) and the pass in
`canvas/web.ts` that feeds it. The split stays exactly where it is: the router
is arithmetic over boxes and is handed everything it knows.

---

## 0. What is actually wrong, before deciding what to change

**`anchorFor()` commits to one face per end, before the search, and never
reconsiders.** The dominant axis picks it — mostly-sideways leaves a side,
mostly-up leaves the top — and every rung of the concession ladder then runs
against that one choice. Park a card flat against that face and the route is
sealed: four searches fail, the uncovered pass fails, and `elbow()` fires and
draws the line behind whatever is in the way. Three other faces were open the
whole time and nothing ever looked at them.

This is the largest single cause of "goes behind", and it is also why the two
other complaints are the same repair: the face is also where lines stack.

**Every line into a card leaves at the same point.** `anchorFor` returns the
*midpoint* of the face — `{ x, y: from.y }` on a side. Five cards joined to one
card, all approaching from the left, produce five routes that begin at one
pixel and run the same corridor. They are not crossing; they are coincident,
which is worse, because a crossing reads as a diagram and a coincidence reads
as one line that is somehow thicker.

**The clearance is doing two jobs and they pull opposite ways.** `CLEARANCE`
(14) is the margin the search keeps off a card, *and* the margin `pull()` tests
the string against. Raise it for air and every taut line straightens less,
because `pull()` drops a turn only when it can see through the same fattened
blocks. So "more air" and "less stiff" cannot both be bought with one number,
and today they are.

**A comment already disagrees with its number.** `STUB`'s header says it is
"smaller than CLEARANCE would be". It is 18 and `CLEARANCE` is 14. One of the
two was changed without the other; whichever way it settles, it settles by
writing the sentence again.

---

## 1. A face becomes a ranked set

`anchorFor(from, to)` → `anchorsFor(from, to)`, returning four anchors in
preference order: the dominant face, the other axis's *near* face, then the two
away faces. `anchorFor` stays as `anchorsFor(...)[0]` so every existing test and
every caller that wants one answer still gets the one it always got.

`routeConnection` then has a face pair to choose as well as a rung. The order
matters, because the cross product is 16 searches and most boards need none of
them:

- `simple()` and the straight taut line are tried on the **dominant pair only**.
  That is the answer on nearly every board and it must not get slower.
- The rungs run on the dominant pair, as now.
- **Only when every rung has failed** do the faces escalate: the three
  next-best pairs at full clearance, then the whole cross product at zero.

So an ordinary board pays nothing, a crowded one pays four more searches, and a
sealed one pays sixteen before it concedes — which is the case that is
currently conceding immediately.

## 2. The ladder stops ending in an elbow

The tail becomes: rungs → uncovered → **face escalation** → and then, only if a
card *overlaps one of the two end boxes*, `elbow()`.

That last condition is the whole of it. At zero clearance the blocks are the
cards' own boxes, the lattice is built from their edges, and `segmentBlocked()`
deliberately lets a segment run *along* an edge — so there is a path round the
outside of any finite set of rectangles unless one of them encloses an end. A
card lying on top of the card being joined is the one case nothing can be
routed around, because the route is not passing it, it is arriving under it.
There the elbow is honest and stays.

Everywhere else, no elbow. If the search finds nothing and no end is covered,
that is a bug in the lattice, not a picture — and it should be found by a test
rather than papered over by a line drawn through three photographs.

One hole stays open and is worth naming rather than fixing: `MAX_NODES`
shedding drops the furthest obstacles until the lattice fits, so a very dense
patch can still produce a route that clips a card the search never saw. It is
sorted nearest-first, so what is shed is what is least likely to be in the way.
Accepted, not hidden.

## 3. Lines spread along the face they share

Cross-route knowledge belongs to `canvas/web.ts`, which holds every seg; the
router keeps knowing about one line at a time. So the slot is handed in:

- `opts.fromSlot` / `opts.toSlot` — `{ index, count }`.
- `anchorsFor` places the edge point at `(index + 1) / (count + 1)` along the
  face rather than at its middle. `count: 1` is the midpoint, so an unslotted
  call is byte-identical to today.
- `routePass()` groups the segs it is about to route by *(item id, dominant
  face)* — the same cheap arithmetic the router does, done once outside — and
  sorts each group by the bearing of the far end, so the fan does not cross
  itself at the card it leaves.

The router may escalate to a different face and lose its slot. That is fine and
rare: a route that had to change face was not one of a tidy fan.

## 4. Routes notice each other, cheaply and only where it matters

The header currently says connections do not avoid each other, and the argument
is right about *crossings*: every diagram in existence crosses, and making
routes avoid routes multiplies the cost of each by the number of them. It is
wrong about **coincidence**, which is the complaint.

So the paragraph gets rewritten rather than deleted. Routes are still not
obstacles; a lattice edge that lies **collinear and overlapping** with another
route's segment simply costs more:

- `opts.avoid?: Point[][]` — the nearby routes' polylines, a handful, supplied
  by `routePass()` from `lastSeg`.
- `search()`'s `step()` adds `OVERLAP_COST` when the edge coincides with an
  avoid segment. Crossing costs nothing.
- The test is an axis-aligned overlap check, so it is cheap, and the penalty is
  non-negative, so the Manhattan heuristic stays admissible and the first pop of
  the goal is still optimal.

Order-dependent and best-effort by construction: a line routed early does not
know about one routed after it. Documented as such. The alternative is a
global pass that reroutes everything whenever anything moves, which is the rule
`canvas/web.ts` exists to avoid.

## 5. The numbers

- `CLEARANCE` 14 → **22**. The ceiling is 32: two cards a single grid step (64)
  apart must still have a corridor between them, and two margins have to fit in
  it. 22 leaves 20 units of corridor at the tightest real spacing.
- `STUB` 18 → **20**, under the clearance, and the header's sentence made true
  again rather than quietly dropped.
- A new `PULL_CLEARANCE` (≈ `CLEARANCE / 2`) that `pull()` tests against,
  separate from what the search kept clear. This is what buys "less stiff"
  without spending "more air": the corridor is found generously and the string
  is pulled through it tightly, so a taut line straightens past a card the
  search would not have squeezed past.
- Whimsy tiers unchanged. Harsh keeps `grid`, which is the tier's whole
  argument; the middle and Softish are already `taut`.

---

## Order of work

1. `anchorsFor` + face escalation (§1) — largest win, and §2 and §3 both need it.
2. Drop the elbow to the covered-end case (§2). Test: no route through a card
   unless an end is covered.
3. Slots (§3), router side then `routePass()` side.
4. `PULL_CLEARANCE` and the numbers (§5) — cheap, visible, last so the shape
   changes are judged against a settled algorithm.
5. Overlap cost (§4) — the only item that adds a per-route cost, so it is the
   one to measure and the first to drop if it does not pay.

## What was left open

- **A route still concedes when a card lies over one of its ends.** Sixteen ways
  out of a sealed box are sixteen ways of finding there is none. The elbow stays
  for that case and only that case, and it is the honest picture there.
- **`MAX_NODES` shedding can still let a route clip.** A very dense patch drops
  its furthest obstacles until the lattice fits, and one of them can turn out to
  have been in the way. Sorted nearest-first, so what is shed is least likely to
  matter. Not hidden, not fixed.
- **Avoidance is order-dependent.** A line settled earlier in a pass is avoided
  and one settled later is not, so two lines that would coincide are separated by
  whichever of them settles second. The alternative is rerouting the board on
  every move.
- **The taut straight-line shortcut is not charged for overlap.** Two diagonals
  coincide only when they share an angle as well as a line, which is an accident
  between two routes pulled through different corridors — and `segmentsOf()`
  drops diagonals, so there is nothing to charge against anyway.

## Also changed, and not from this brief

**The world axes now fade with the threads.** `#axis-ink` was the one set of
lines left at full strength while a focused card's own threads were lifted out
of a board dropped to 0.18 — not by decision, but because the axes are a canvas
in screen space outside `#world` and no selector aimed at `#web` reaches them.
A `web-lifted` class on the root, written beside `is-focused`, and the axes go
to 0.4: back far enough to stop competing, near enough that the board can still
be read against them.

## What has to be said afterwards

`research/docs/architecture.md:822` already says "the tool stays armed after a
pair", which the uncommitted one-shot change made false. Whatever lands here,
that section is rewritten in the same pass — the routing paragraphs at
`:735–790` are where §1, §2 and §4 all change the recorded argument.
