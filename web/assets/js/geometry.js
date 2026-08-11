// Where an item is, and what it covers.
//
// Every one of these answers had been written more than once, in modules that
// could not see each other, and they did not all agree. A point-in-item test
// that accounted for rotation lived in state.js; a rotation-aware bounding box
// lived in viewport.js/fit; the marquee in input.js tested the *unrotated*
// extents; the culler in items.js used a circumscribed square. Four takes on
// one question.
//
// Nothing sets `rot` today, so the disagreement is invisible - which is
// exactly the problem. Rotate handles are on the roadmap, and the day they
// land is the day a rotated item becomes selectable by a marquee that misses
// it, framed by a Fit that gets it right, and stuck to by a note that uses a
// third rule. Consolidating now is cheap; consolidating then is a bug hunt.
//
// The convention throughout: an item is a centre (x, y), a size (w, h) and a
// rotation `rot` in degrees, anticlockwise-positive, matching world axes where
// +y is up. Every function here is pure and takes items rather than ids, so
// none of it needs to know that a board exists.

const RAD = Math.PI / 180;

/**
 * How small and how large an item is allowed to get.
 *
 * Here rather than in input.js because a resize handle is no longer the only
 * thing that sets a size: snapping the whole board onto the lattice does too,
 * and it lives in state.js, which has no business importing from canvas/.
 *
 * 48 is where the eight resize grips stop fitting around a box - below it the
 * corners overlap, the edge strips collapse, and an item dragged down to a
 * speck could never be dragged back out. It is still well under half a note
 * (120x120) and under half the short side of the smallest default card
 * (200x112), so a deliberate shrink never runs into it.
 *
 * 20000 is a hundred default cards wide - far past anything a board wants, while
 * still spanning 400 screen pixels at the furthest zoom out, so even an item
 * used as a deliberate backdrop stays inside it.
 */
export const MIN_SIZE = 48;
export const MAX_SIZE = 20000;

/**
 * How much of a cell a snapped item gives back at *each* of its four sides, so
 * that two of them side by side have a seam between them instead of meeting.
 *
 * A board laid exactly on the lattice is a board where every neighbour touches:
 * the cell boundary is one line, and an item on each side of it fills right up
 * to it, so two photographs read as one wide photograph with a crease. The fix
 * is not to move anything - the block of cells an item occupies is still chosen
 * on the lattice, which is the whole point of snapping - but to leave a sliver
 * of that block unpainted.
 *
 * Four sides rather than two, and that is the correction worth writing down.
 * The seam used to be taken off the high edges alone: the whole of it, so the
 * space *between* two neighbours came out the same, but an item sat flush
 * against the lines on its left and bottom and short of them on its right and
 * top. Two items in one row read correctly and everything else did not - a lone
 * card was visibly off-centre in its cells, a row and the row above it were
 * spaced differently from a column and the column beside it, and an item against
 * the edge of a group had a margin on one side only. Halving the seam and
 * putting it on every side costs nothing anywhere the old rule looked right and
 * fixes it everywhere it did not.
 *
 * A fraction of the step rather than a fixed distance, because the step is not
 * fixed: it doubles and halves with the zoom and the user can set the base. At
 * 4% a side - so 8% between two neighbours, exactly what it was - the seam is a
 * shade under a fifth of the smallest gap between two cards a layout would
 * leave, which is small enough to read as a join rather than as space, and it
 * stays that way at every step size.
 */
export const CELL_GAP = 0.04;

/** The seam itself, in world units, for a given cell size. */
export const cellInset = step => step * CELL_GAP;

/**
 * A low edge laid on the lattice: a grid line, plus the seam.
 *
 * The offset is what makes the sides uniform, and it has to be applied by
 * everything that puts an edge on the grid - the drag gesture and the arrow keys
 * as well as the two callers of latticeBox() below - or an item dragged across a
 * snapped board would come to rest half a seam off the one that was laid there.
 */
export const latticeLow = (v, step) => {
  const inset = cellInset(step);
  return Math.round((v - inset) / step) * step + inset;
};

/**
 * A side laid on the lattice: a whole number of cells, less a seam at each end.
 *
 * Clamped, and a clamp can cost the box its whole number of cells. That is
 * accepted rather than worked around: the limits are absolute and the lattice is
 * a preference, and an item at either limit is far outside the range where
 * sitting flush in a cell is what anybody is looking at.
 */
export const latticeSide = (v, step) => {
  const gap = 2 * cellInset(step);
  const cells = Math.max(Math.round((v + gap) / step), 1);
  return Math.min(Math.max(cells * step - gap, MIN_SIZE), MAX_SIZE);
};

/**
 * A box laid on the lattice, both halves at once.
 *
 * The one place this arithmetic is assembled. Both callers need exactly it -
 * state.js when snapping is switched on and the whole board is laid out at once,
 * and canvas/input.js on every gesture that has to keep it that way - and they
 * differ only in the step they pass: the base step for geometry that is being
 * stored, the on-screen step for something being dragged against the dots.
 */
export function latticeBox(box, step) {
  const w = latticeSide(box.w, step), h = latticeSide(box.h, step);
  return {
    x: latticeLow(box.x - box.w / 2, step) + w / 2,
    y: latticeLow(box.y - box.h / 2, step) + h / 2,
    w, h,
  };
}

/**
 * Half-extents of the axis-aligned box that contains a rotated item.
 *
 * The standard result: project the rotated rectangle's own half-extents onto
 * each world axis and add the two contributions. At rot = 0 it collapses to
 * (w/2, h/2), which is why callers can use it unconditionally without paying
 * for trig on a board where nothing is turned.
 */
export function rotatedExtents(it) {
  const rot = it.rot || 0;
  if (!rot) return { hw: it.w / 2, hh: it.h / 2 };
  const rad = rot * RAD;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return {
    hw: (it.w * c + it.h * s) / 2,
    hh: (it.w * s + it.h * c) / 2,
  };
}

/**
 * The axis-aligned box around a set of items, or null for none.
 *
 * Rotation-aware, so this is the box you can actually see rather than the one
 * the unturned rectangles would occupy. Used to frame a Fit, to centre a
 * paste, and to decide whether what the clipboard holds is on screen.
 */
export function itemBounds(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const it of items) {
    const { hw, hh } = rotatedExtents(it);
    if (it.x - hw < x0) x0 = it.x - hw;
    if (it.x + hw > x1) x1 = it.x + hw;
    if (it.y - hh < y0) y0 = it.y - hh;
    if (it.y + hh > y1) y1 = it.y + hh;
    any = true;
  }
  return any ? { x0, y0, x1, y1 } : null;
}

/**
 * Does an item overlap the world-space rectangle `[x0,x1] x [y0,y1]`?
 *
 * Box against box, using the rotated extents - the same forgiving test Fit
 * frames with. An exact rotated-rectangle intersection is available and is not
 * wanted: a marquee is a rough gesture, and catching an item whose corner
 * *nearly* reaches the band you dragged is the friendlier of the two mistakes.
 * What matters is that it is now the same approximation everything else makes.
 */
export function itemInRect(it, x0, y0, x1, y1) {
  const { hw, hh } = rotatedExtents(it);
  return it.x + hw >= x0 && it.x - hw <= x1 &&
         it.y + hh >= y0 && it.y - hh <= y1;
}

/**
 * Does the world-space rectangle `[x0,x1] x [y0,y1]` hold the whole item?
 *
 * The strict half of the pair above, and it exists for one caller: a fence is
 * larger than anything drawn inside it, so under the overlap test a band swept
 * across a region always caught the region itself - and then the offer that
 * followed miscounted, the fence it drew was unioned out to swallow its own
 * parent, and dragging what the band caught towed the whole thing.
 *
 * Overlap is right for a card, whose face is what you are pointing at. A fence's
 * face is not a target at all - items.css hands presses straight through it, and
 * only its name plate takes one - so a band crossing that face is a band drawn
 * *in* the region, not at it. Containment is what "at it" means for a shape you
 * cannot otherwise hit.
 *
 * Rotation-aware through the same extents, so it is the box you can see that has
 * to fit, and the same forgiving approximation everything else here makes.
 */
export function itemWithinRect(it, x0, y0, x1, y1) {
  const { hw, hh } = rotatedExtents(it);
  return it.x - hw >= x0 && it.x + hw <= x1 &&
         it.y - hh >= y0 && it.y + hh <= y1;
}

/**
 * Where a point sits relative to a rectangle, as four bits.
 *
 * Cohen and Sutherland's, from 1967, and still the cheapest way to ask this:
 * one comparison per edge, and the answers compose. Two codes ORed to nothing
 * means both ends are inside; two codes ANDed to anything means both ends are
 * beyond the same edge, and a straight line between them cannot have visited
 * the rectangle in between.
 */
const OUT_LEFT = 1, OUT_RIGHT = 2, OUT_BELOW = 4, OUT_ABOVE = 8;

const outcode = (x, y, r) =>
  (x < r.x0 ? OUT_LEFT : x > r.x1 ? OUT_RIGHT : 0) |
  (y < r.y0 ? OUT_BELOW : y > r.y1 ? OUT_ABOVE : 0);

/**
 * Does the segment a-b touch the rectangle `r` ({x0,y0,x1,y1})?
 *
 * Exact, where the obvious test - does the segment's bounding box meet the
 * rectangle - is not. The two agree on everything axis-aligned and part company
 * on the diagonal, which is the case that matters: a thread from one corner of
 * a board to the other has a bounding box covering the whole board, so it
 * passes a box test from every view there is while actually crossing almost
 * none of them.
 *
 * The loop is the classic clip, stopped one step early. Each turn takes an
 * endpoint that is outside, moves it onto the edge it is outside of, and asks
 * again; an endpoint can be outside on at most two edges, so this settles in
 * four turns at the very worst. The clipped points are thrown away - the
 * question here is only whether anything survived.
 *
 * No division by zero. The vertical branches are reached only when exactly one
 * endpoint is above or below, which cannot happen with both ends at the same y
 * - that case has already left through the shared-edge rejection.
 */
export function segmentMeetsRect(a, b, r) {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  let c0 = outcode(x0, y0, r), c1 = outcode(x1, y1, r);
  for (;;) {
    if (!(c0 | c1)) return true;
    if (c0 & c1) return false;
    const out = c0 || c1;
    let x, y;
    if (out & OUT_ABOVE)      { x = x0 + (x1 - x0) * (r.y1 - y0) / (y1 - y0); y = r.y1; }
    else if (out & OUT_BELOW) { x = x0 + (x1 - x0) * (r.y0 - y0) / (y1 - y0); y = r.y0; }
    else if (out & OUT_RIGHT) { y = y0 + (y1 - y0) * (r.x1 - x0) / (x1 - x0); x = r.x1; }
    else                      { y = y0 + (y1 - y0) * (r.x0 - x0) / (x1 - x0); x = r.x0; }
    if (out === c0) { x0 = x; y0 = y; c0 = outcode(x0, y0, r); }
    else            { x1 = x; y1 = y; c1 = outcode(x1, y1, r); }
  }
}

/**
 * The radius of a circle centred on the item that contains it whatever its
 * rotation - half its diagonal.
 *
 * For the culler, which asks this question about every item on every frame of
 * every pan and wants an answer that costs no trig and never says "no" to
 * something that is really on screen.
 */
export function itemRadius(it) {
  return Math.sqrt(it.w * it.w + it.h * it.h) / 2;
}

/**
 * Whether a world point lies inside an item's box.
 *
 * Tested in the item's *own* frame: the point is brought back through the
 * item's rotation and compared against the unrotated extents. That is the same
 * box the resize grips work in and the same one Fit frames, and it is the one
 * on screen. Testing the axis-aligned bounding box instead would be visibly
 * wrong for a rotated item - a card turned 45 degrees draws a diamond, and its
 * bounding box reaches half its diagonal past that into empty space, so a note
 * parked in one of those corners would claim to be stuck to nothing.
 *
 * `rot` is the only rotation accounted for. Items also rest at a small
 * presentational tilt (--item-tilt, dealt in items.js) which is deliberately
 * not part of the geometry model. It is a couple of degrees, so leaving it out
 * can only disagree with the eye a hair's breadth from an edge, which is
 * exactly where "is it over it or not" had no obvious answer anyway.
 */
export function pointInItem(px, py, it) {
  const dx = px - it.x, dy = py - it.y;
  // Cheap reject first, and it takes almost every pair: no rotation of the box
  // reaches outside the circle that circumscribes it, and this costs no trig.
  if (dx * dx + dy * dy > (it.w * it.w + it.h * it.h) / 4) return false;
  if (!it.rot) return Math.abs(dx) <= it.w / 2 && Math.abs(dy) <= it.h / 2;
  // rot is anticlockwise-positive in world space, so undoing it is a rotation
  // by -rot: the usual matrix with the signs on the sines swapped.
  const rad = it.rot * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  return Math.abs(c * dx + s * dy) <= it.w / 2 &&
         Math.abs(c * dy - s * dx) <= it.h / 2;
}

/** An item's four corners, in world coordinates, anticlockwise. */
export function corners(it) {
  const rad = (it.rot || 0) * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = it.w / 2, hh = it.h / 2;
  const at = (u, v) => ({ x: it.x + c * u - s * v, y: it.y + s * u + c * v });
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Twice the signed area of a polygon. Positive when it winds anticlockwise. */
function shoelace2(poly) {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return sum;
}

/**
 * How much of `a` lies over `b`, as a fraction of `a`'s own area.
 *
 * Exact rather than sampled, and rotation-aware, because it decides whether a
 * sticky note is stuck: both boxes are convex, so `a` is clipped against each
 * of `b`'s four edges in turn (Sutherland-Hodgman) and what survives is the
 * intersection. Sampling would be simpler and would put the threshold in a
 * different place for every note depending on where the samples happened to
 * fall, which is not a thing to build a visible rule on.
 *
 * Returns a number in [0, 1]. Zero for a degenerate `a`, since "what fraction
 * of nothing" has no answer worth having and the callers want a boolean.
 */
export function overlapFraction(a, b) {
  const areaA = a.w * a.h;
  if (!(areaA > 0) || !(b.w * b.h > 0)) return 0;
  // Cheap reject, and on a real board it takes almost every pair: two boxes
  // whose circumscribing circles miss cannot overlap, and this costs no trig.
  const dx = a.x - b.x, dy = a.y - b.y;
  const reach = itemRadius(a) + itemRadius(b);
  if (dx * dx + dy * dy > reach * reach) return 0;

  let poly = corners(a);
  const bs = corners(b);
  for (let i = 0, j = bs.length - 1; i < bs.length; j = i++) {
    if (!poly.length) return 0;
    // Inside is to the left of the directed edge j -> i, which holds because
    // corners() winds anticlockwise for both.
    const ex = bs[i].x - bs[j].x, ey = bs[i].y - bs[j].y;
    const side = p => ex * (p.y - bs[j].y) - ey * (p.x - bs[j].x);
    const next = [];
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
      const cur = poly[k], prev = poly[m];
      const dCur = side(cur), dPrev = side(prev);
      if (dCur >= 0) {
        // Crossing in: add the intersection first, then the point itself.
        if (dPrev < 0) {
          const t = dPrev / (dPrev - dCur);
          next.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
        }
        next.push(cur);
      } else if (dPrev >= 0) {
        const t = dPrev / (dPrev - dCur);
        next.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;
  const frac = Math.abs(shoelace2(poly)) / 2 / areaA;
  // Clamped rather than trusted: floating point on a clip that came out very
  // slightly larger than the box it started as would otherwise report 1.0000001,
  // which is only ever going to be compared against a threshold anyway.
  return frac > 1 ? 1 : frac;
}

/**
 * The furthest anything inside `rect` moved on screen between two views.
 *
 * Answers "did that view change actually change the picture?" for anything
 * painted in screen space from world coordinates - the grid is the caller, and
 * the reason this exists: it repaints full-viewport on every view frame, and
 * two gestures deliver a stream of frames that move nothing anybody can see.
 * The tail of an inertial pan settles below a pixel per frame long before it
 * stops emitting, and a precision wheel or trackpad hands over zoom in
 * fractions far under one.
 *
 * A view here is the transform itself, `{ pan: {x, y}, zoom }`, in the sense
 * viewport.js's toScreen() uses it: screen = (world - pan) * zoom, with y
 * negated for the sign flip. Both views are measured against the *same*
 * rectangle - the one visible now - because the question is about the marks on
 * screen this moment, not about where a point used to be.
 *
 * Only the corners are evaluated, and that is exact rather than a sample: the
 * mapping is affine in the world point, so the displacement between two of them
 * is affine too, and an affine function over a rectangle takes its extremes at
 * the corners. Four evaluations bound the whole frame.
 *
 * Returns the larger of the two axes, in screen pixels. Compare it against one
 * device pixel to learn that every mark landed in the row and column it was
 * already in.
 */
export function viewShift(prev, next, rect) {
  let worst = 0;
  for (const wx of [rect.x0, rect.x1]) {
    for (const wy of [rect.y0, rect.y1]) {
      const dx = (wx - next.pan.x) * next.zoom - (wx - prev.pan.x) * prev.zoom;
      const dy = (next.pan.y - wy) * next.zoom - (prev.pan.y - wy) * prev.zoom;
      worst = Math.max(worst, Math.abs(dx), Math.abs(dy));
    }
  }
  return worst;
}

/** The two ends of an item's top edge, in world coordinates (+y is up). */
export function topEdge(it) {
  const rad = (it.rot || 0) * RAD;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = it.w / 2, hh = it.h / 2;
  return [
    { x: it.x - c * hw - s * hh, y: it.y - s * hw + c * hh },
    { x: it.x + c * hw - s * hh, y: it.y + s * hw + c * hh },
  ];
}

/**
 * Move each item so a chosen edge or centre of the selection lines up.
 *
 * `edge` is one of 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'.
 * An item is a centre, so lining up a left edge is setting each centre to the
 * selection's shared left plus that item's own half-width - and the half-extents
 * are the rotated ones (rotatedExtents), so a turned card aligns by the box you
 * can see, the same box Fit frames and a marquee catches. `top` is the larger y
 * because +y is up here.
 *
 * Returns [{id, x, y}] for every item, in input order, for applyGeom to merge -
 * only the axis the edge names is moved; the other keeps its value. The commit
 * path is what makes it one undo step and what re-snaps it if snapping is on, so
 * nothing here snaps or clamps.
 */
export function alignTargets(items, edge) {
  const b = itemBounds(items);
  if (!b) return [];
  return items.map(it => {
    const { hw, hh } = rotatedExtents(it);
    let { x, y } = it;
    switch (edge) {
      case 'left':    x = b.x0 + hw; break;
      case 'right':   x = b.x1 - hw; break;
      case 'hcenter': x = (b.x0 + b.x1) / 2; break;
      case 'top':     y = b.y1 - hh; break;
      case 'bottom':  y = b.y0 + hh; break;
      case 'vcenter': y = (b.y0 + b.y1) / 2; break;
    }
    return { id: it.id, x, y };
  });
}

/**
 * Space the selection evenly along one axis, with equal clear gaps between
 * neighbours. `axis` is 'x' or 'y'.
 *
 * The two outermost items stay put - they define the span - and everything
 * between them is dealt so the space you can see between adjacent boxes is the
 * same. Gaps rather than centres on purpose: three cards of different widths
 * distributed by centre still read as bunched, because a wide card eats into the
 * gap on both sides of it. With fewer than three items there is nothing to even
 * out, and it returns nothing.
 *
 * Rotation-aware through the per-axis half-extent, so a turned card takes the
 * width of the box it actually occupies. Returns [{id, x, y}] only for the
 * interior items that move.
 */
export function distributeTargets(items, axis) {
  if (items.length < 3) return [];
  const half = it => (axis === 'x' ? rotatedExtents(it).hw : rotatedExtents(it).hh);
  const pos = it => (axis === 'x' ? it.x : it.y);
  const sorted = [...items].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const lead = pos(first) + half(first);          // trailing edge of the first
  const tail = pos(last) - half(last);            // leading edge of the last
  let span = tail - lead;
  for (let i = 1; i < sorted.length - 1; i++) span -= 2 * half(sorted[i]);
  const gap = span / (sorted.length - 1);
  const out = [];
  let cursor = lead;
  for (let i = 1; i < sorted.length - 1; i++) {
    const it = sorted[i];
    const h = half(it);
    const centre = cursor + gap + h;
    cursor = centre + h;
    out.push(axis === 'x'
      ? { id: it.id, x: centre, y: it.y }
      : { id: it.id, x: it.x, y: centre });
  }
  return out;
}
