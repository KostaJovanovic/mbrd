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
 * (120x120) and a third of the shortest default card (250x140), so a
 * deliberate shrink never runs into it.
 *
 * 20000 is eighty default cards wide - far past anything a board wants, while
 * still spanning 400 screen pixels at the furthest zoom out, so even an item
 * used as a deliberate backdrop stays inside it.
 */
export const MIN_SIZE = 48;
export const MAX_SIZE = 20000;

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
