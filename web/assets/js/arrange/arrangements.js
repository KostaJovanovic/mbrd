// Arrangement engine.
//
// Every arrangement is a pure `(items, opts) => [{x, y}, ...]` in the same order
// as `items`, so the caller can use the result for a fresh import (positions for
// brand-new items) or for "Rearrange all" (new positions for existing ones)
// without either path knowing how the layout was computed.
//
// opts: { center: {x, y}, spacing: number, seed?: number }
//
// `spacing` has exactly one meaning everywhere below: the gap left between two
// neighbouring cards, edge to edge, in world units. Every layout asks for room
// the same way - `item + spacing` - so the slider means the same thing whichever
// arrangement is in force, and a board relaid from one to another comes back
// equally tight. Where a layout needs a second distance it derives it from this
// one by a named constant, and each of those says what it is a multiple of.
//
// `seed` is permission to move the slots, not just to fill them differently.
// Without one every layout below is a pure function of the items it is handed,
// which is what makes an import reproducible: the same drop lands the same way
// twice. "Rearrange everything" wants the opposite - it has to look like
// something happened - so it passes a fresh seed and each layout answers with
// a different arrangement of the *same* kind. What varies is chosen per layout
// so that the layout's own identity survives it: a grid stays square, a spiral
// stays evenly packed, `date` stays in date order. See variation() below.
//
// No layout returns overlapping cards, and every one of them gets that the same
// way: by never placing a card where it would overlap. The four laid out on
// structure get it from the structure - see lattice() - and the two that have
// no structure get it from slideOut(), which finds each card the nearest place
// it actually fits. Nothing here separates cards after the fact.
//
// A card is a rectangle, and that is a working assumption rather than a
// remark. A layout that reasons in radii is reasoning about the circle around
// the card, which on an ordinary card is three times its area, and the board
// comes out mostly gap however tight the spacing is set.
//
// `free` is the one exception, and only because the positions it starts from
// are yours: two cards you deliberately stacked stay stacked.

import { cellInset } from '../geometry.js';

export const ARRANGEMENTS = [
  // First because it is the default a new board carries, and a menu whose top
  // entry is not what the thing is currently set to reads as a menu you have
  // to go looking through.
  { id: 'spiral',  label: 'Spiral' },
  // Not "keep positions" any more: a drop under Free falls back to the grid
  // (see import/drop.js) and Rearrange shakes the board loose, so the only
  // promise Free still makes is that it will not impose a shape on you.
  { id: 'free',    label: 'Free (no layout)' },
  { id: 'grid',    label: 'Grid rings' },
  { id: 'masonry', label: 'Masonry' },
  { id: 'type',    label: 'Cluster by type' },
  { id: 'date',    label: 'By date' },
  { id: 'scatter', label: 'Random scatter' },
];

/**
 * World y points up, but every layout below is written the way you read a page:
 * successive rows go *down*. So the centre goes in negated and the results come
 * back negated, and each layout gets to stay in the orientation it reads best
 * in. `free` is exempt - it hands back real world coordinates untouched.
 */
export function arrange(items, opts = {}) {
  const o = { center: { x: 0, y: 0 }, spacing: 12, ...opts };
  const name = o.name || 'grid';
  const fn = LAYOUTS[name] || LAYOUTS.grid;
  if (!items.length) return [];
  if (name === 'free') return fn(items, o);
  // When a caller is about to snap the result to a grid (`cellStep` is that
  // grid's cell size), the layout reserves each item a whole number of cells
  // instead of its bare rectangle - see toCells(). Without it, two cards packed
  // a hair under a cell apart are each snapped to the lattice independently
  // afterwards and both round toward the same line, so a tight Rearrange or a
  // snapped drop came back with cards overlapping. The positions returned are
  // still the real items' - only the room set aside for them grew.
  const laid = o.cellStep > 0 ? items.map(it => toCells(it, o.cellStep)) : items;
  const out = fn(laid, { ...o, center: { x: o.center.x, y: -o.center.y } });
  const world = out.map(p => ({ x: p.x, y: -p.y }));
  // `obstacles` are boxes already on the board that the fresh block must not land
  // on - a folder dropped onto a busy board. The layout above knows nothing of
  // them, so this pushes only the newcomers that would have overlapped outward
  // until they clear, leaving the rest exactly where the layout put them. See
  // avoidObstacles().
  return o.obstacles?.length ? avoidObstacles(laid, world, o) : world;
}

/**
 * Slide each freshly laid item out past what is already on the board.
 *
 * The layout has placed the new items among themselves without overlap; this
 * only has to keep them off the `obstacles` - the items already there. Each is
 * pushed straight out from the drop point along the ray it already sits on,
 * stopping at the first distance clear of every obstacle and every newcomer
 * placed before it, exactly as slideOut() packs an unstructured layout. One that
 * was already clear does not move at all - `from` is its current distance and a
 * clear ray returns it untouched - so the block keeps its shape and only what
 * would have collided flows around the things in the way.
 */
function avoidObstacles(items, world, o) {
  const c = o.center;
  const placed = o.obstacles.map(r => ({ x: r.x - c.x, y: r.y - c.y, hw: r.w / 2, hh: r.h / 2 }));
  return world.map((p, i) => {
    const box = roomFor(items[i], o.spacing);
    const dx = p.x - c.x, dy = p.y - c.y;
    const from = Math.hypot(dx, dy);
    const dir = from < 1e-6 ? { x: 0, y: -1 } : { x: dx / from, y: dy / from };
    const at = slideOut(dir, box, placed, from);
    placed.push({ ...box, x: at.x, y: at.y });
    return { x: c.x + at.x, y: c.y + at.y };
  });
}

/**
 * An item's box grown to the whole number of grid cells it occupies once
 * snapped: the same cell count latticeSide() in geometry.js lands on, times the
 * step. A snapped body is `cells*step` less a seam at each end and stays centred
 * in those cells, so a layout that keeps whole-cell gaps between footprints keeps
 * non-overlapping bodies after each is snapped to the lattice - a whole-cell
 * separation survives two independent edge-snaps where a body-width one is
 * rounded away.
 *
 * This holds where a cell is at least the smallest a card may be (MIN_SIZE),
 * which every real grid is - the default step is 64. A grid finer than that is
 * degenerate (a card cannot fit one cell) and is not a board the app offers.
 */
function toCells(it, step) {
  const gap = 2 * cellInset(step);
  const cells = v => Math.max(Math.round((v + gap) / step), 1);
  return { ...it, w: cells(it.w) * step, h: cells(it.h) * step };
}

/**
 * How far a shaken item can travel under `free`, as a fraction of its own size.
 * Half a card: far enough that the board visibly loosens, close enough that
 * something you had put beside something else is still beside it.
 */
const FREE_SHAKE = 0.5;

/**
 * The seam between two clusters, in gaps.
 *
 * A multiple of `spacing` rather than a distance of its own, so the whole
 * layout still answers to the one slider - but it has to be a multiple bigger
 * than one, because a block seam the width of the gaps inside a block is not a
 * seam. Three is the smallest that reads as a gutter at every spacing the
 * slider offers.
 */
const BLOCK_GAP = 3;

/**
 * How much of its disc a scatter aims to cover before anything is placed.
 *
 * A target rather than a result: cards are thrown at this disc and any that
 * land on one another slide outward until they do not, so what comes out is
 * always looser than what was asked for. Asking for a disc that is already
 * full is what makes the scatter read as a heap rather than as a ring - the
 * crowding in the middle is what pushes the overflow to the edge, which is
 * where a heap's overflow goes.
 *
 * It replaces a fudge factor on the radius, and it is the better of the two
 * knobs to have: a radius grown as sqrt(count) assumed every card was the size
 * of the largest, so one big photograph blew up the whole disc. Area adds up
 * honestly whatever the mix.
 */
const SCATTER_FILL = 1;

/**
 * How much wider than tall a block of items should come out.
 *
 * Screens are wider than they are tall and so is the room a board has to grow
 * into, so a block of items squared off exactly wastes the width and then runs
 * off the bottom. Masonry gets the gentler figure because its columns already
 * ragged the bottom edge; a page of dated items gets the fuller one because it
 * is read in rows and long rows are what reading wants.
 */
const MASONRY_ASPECT = 1.4;
const PAGE_ASPECT = 1.6;

/**
 * How far either side of its own angle a card in the spiral may look for
 * somewhere to sit, and how many directions it tries in there.
 *
 * A quarter turn each way. Wide enough that a card blocked straight ahead can
 * see round the obstruction, narrow enough that it is still going roughly where
 * the golden angle sent it - which is the whole of what makes this a spiral
 * rather than a heap. Let it look all the way round and every card simply goes
 * to the nearest hole, the angles stop meaning anything, and the arrangement
 * comes out no tighter for it.
 *
 * Seven tries, fifteen degrees apart. Packing greedily is not monotonic in how
 * hard you look - a card that squeezes nearer the middle can be the reason two
 * later ones do not - and measured across boards of identical cards, mixed
 * cards and wildly mixed ones, thirteen and nineteen tries were no better than
 * seven and sometimes worse. Seven is also the cheap answer, which settles it.
 */
const SPIRAL_SWEEP = Math.PI / 2;
const SPIRAL_TRIES = 7;

const LAYOUTS = {
  /**
   * Free imposes no structure, so unseeded it hands back exactly what the items
   * already have.
   *
   * A seed is Rearrange asking it to do something anyway, and the only thing
   * "no structure" can honestly do is loosen: every item shaken off its own
   * position, nothing collected anywhere. Free that gathered the board into a
   * disc round a centre would be `scatter` under a second name, and would throw
   * away the arrangement you made by hand - which is the one thing a layout
   * called Free must not do. This is also the only layout that may hand back
   * overlapping items, and that is not a lapse: the positions it starts from
   * are yours and may already overlap, so refusing to would mean tidying, not
   * shaking.
   */
  free(items, o) {
    const rnd = variation(o);
    if (!rnd) return items.map(i => ({ x: i.x, y: i.y }));
    return items.map(i => {
      const reach = (Math.max(i.w, i.h) + o.spacing) * FREE_SHAKE;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * reach;
      return { x: i.x + r * Math.cos(a), y: i.y + r * Math.sin(a) };
    });
  },

  /** Square spiral of cells, filling ring by ring outward from centre. */
  grid(items, o) {
    // A quarter turn of the ring pattern. A ring that is completely full maps
    // onto itself under it, so a grid that comes out square comes out square
    // again - what moves is the last, unfinished ring, which is the only part
    // of a grid's outline there is to see change. Nothing else here can vary
    // without the result ceasing to be a grid.
    const rnd = variation(o);
    const turn = rnd ? Math.floor(rnd() * 4) : 0;
    // Cell (0, 0) is the origin of the lattice, so the first item lands exactly
    // on the point asked for - which for an import is the point you dropped on.
    const { pos } = lattice(items.map((_, n) => spin(ringCell(n), turn)), items, o.spacing);
    return pos.map(p => ({ x: o.center.x + p.x, y: o.center.y + p.y }));
  },

  /**
   * Phyllotaxis: the golden angle, so nothing lines up into visual rows.
   *
   * The textbook form is r = c*sqrt(n) for a fixed c, and it is written for
   * points. Giving each card the slot that form implies means giving it a
   * *circle* big enough to hold it whichever way its neighbour lies - and a
   * card is a rectangle, so three quarters of that circle is thrown away. On a
   * board of 320x240 cards it came out a quarter covered with the spacing at
   * zero, which is not what "no gap" is supposed to look like.
   *
   * So only the angles come from the phyllotaxis now. The radius is asked
   * rather than computed: each card slides out from the centre and stops at the
   * first distance where its rectangle is clear of every rectangle already
   * down. Cards fall into the gaps their neighbours leave, and no two of them
   * can overlap - not because a pass afterwards pulled them apart, but because
   * no card was ever put anywhere it would have to be pulled from.
   *
   * And it looks a little either side of its own angle before choosing, which
   * is where most of the tightening comes from. One fixed ray is one degree of
   * freedom: a card whose ray happens to point down a corridor between two
   * others rides it all the way out, past pockets a few degrees round that it
   * would have dropped straight into. Trying a fan of directions and taking
   * whichever comes to rest nearest the middle is the difference between a
   * board a quarter covered and one nearly two thirds covered.
   */
  spiral(items, o) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    // The whole spiral turned on its centre. Rotation is the one change a
    // phyllotaxis cannot be spoiled by: it deals the same sequence of
    // directions starting somewhere else, so the packing is exactly as good.
    const rnd = variation(o);
    const phase = rnd ? rnd() * Math.PI * 2 : 0;
    const placed = [];
    return items.map((it, n) => {
      const box = roomFor(it, o.spacing);
      let best = null, near = Infinity;
      for (let k = 0; k < SPIRAL_TRIES; k++) {
        const a = n * golden + phase + SPIRAL_SWEEP * (k / (SPIRAL_TRIES - 1) - 0.5);
        const at = slideOut({ x: Math.cos(a), y: Math.sin(a) }, box, placed);
        const r = Math.hypot(at.x, at.y);
        if (r < near) { near = r; best = at; }
      }
      placed.push({ ...box, x: best.x, y: best.y });
      return { x: o.center.x + best.x, y: o.center.y + best.y };
    });
  },

  /** Columns, each item dropped into the currently shortest one. */
  masonry(items, o) {
    // One column wider or narrower re-flows every item, because which column
    // is shortest changes the moment the first one does. It is the only change
    // masonry can make that is still masonry: the columns are the whole of it,
    // so moving items inside them would read as drift rather than as a layout.
    const rnd = variation(o);
    let cols = Math.max(1, Math.round(Math.sqrt(items.length * MASONRY_ASPECT)));
    if (rnd) cols = reflow(cols, items.length, rnd);
    cols = Math.min(cols, items.length);

    // Which column an item lands in depends only on heights, so the widths can
    // be gathered on the way past and spent afterwards - each column exactly as
    // wide as the widest thing that chose it.
    const heights = new Array(cols).fill(0);
    const widths = new Array(cols).fill(0);
    const placed = items.map(it => {
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c]) c = k;
      const y = heights[c] + it.h / 2;
      heights[c] += it.h + o.spacing;
      widths[c] = Math.max(widths[c], it.w + o.spacing);
      return { c, y };
    });

    const mid = [];
    let edge = 0;
    for (const w of widths) { mid.push(edge + w / 2); edge += w; }
    // Centre the whole block on the target point.
    const tallest = Math.max(...heights) - o.spacing;
    return placed.map(p => ({
      x: o.center.x + mid[p.c] - edge / 2,
      y: o.center.y + p.y - tallest / 2,
    }));
  },

  /** One block per type, blocks laid side by side in a stable order. */
  type(items, o) {
    const groups = new Map();
    items.forEach((it, i) => {
      const k = it.type || 'generic';
      (groups.get(k) || groups.set(k, []).get(k)).push(i);
    });
    // Alphabetical, so an unseeded run of the same board deals the blocks the
    // same way twice. Seeded, the blocks change places: the clustering is what
    // this layout is for and survives untouched, while which cluster you meet
    // first from the left never meant anything and is free to move.
    const rnd = variation(o);
    const order = [...groups.keys()].sort();
    if (rnd) shuffleWith(order, rnd);

    // Lay every block first, so they can be spaced by the width each one
    // actually came out at rather than by a cell count times a shared cell.
    const laid = order.map(key => {
      const idx = groups.get(key);
      const sub = idx.map(i => items[i]);
      // Each block reshapes as well as moving. Needed on its own account: a
      // board of one type is a single block, and shuffling a list of one
      // leaves it exactly where it was - so without this, the commonest board
      // there is would be the one board Rearrange could not rearrange.
      let cols = Math.max(1, Math.ceil(Math.sqrt(sub.length)));
      if (rnd) cols = reflow(cols, sub.length, rnd);
      const cells = sub.map((_, n) => [n % cols, Math.floor(n / cols)]);
      return { idx, ...lattice(cells, sub, o.spacing) };
    });
    const seam = o.spacing * BLOCK_GAP;
    const width = b => b.box.x1 - b.box.x0;
    const total = laid.reduce((s, b) => s + width(b), 0) + seam * (laid.length - 1);

    const out = new Array(items.length);
    let cursor = o.center.x - total / 2;
    for (const b of laid) {
      const mid = (b.box.y0 + b.box.y1) / 2;
      b.idx.forEach((itemIndex, n) => {
        out[itemIndex] = {
          x: cursor + b.pos[n].x - b.box.x0,
          y: o.center.y + b.pos[n].y - mid,
        };
      });
      cursor += width(b) + seam;
    }
    return out;
  },

  /** Oldest first, reading order. */
  date(items, o) {
    const order = dateOrder(items);
    // Oldest-first is the entire meaning of this layout, so unlike every other
    // one here the items may not be re-dealt - `order` is not the caller's to
    // vary. What can change is the shape of the page they are read on: a
    // wider or narrower block reflows every row while leaving the reading
    // order exactly where it was.
    const rnd = variation(o);
    let cols = Math.max(1, Math.ceil(Math.sqrt(items.length * PAGE_ASPECT)));
    if (rnd) cols = reflow(cols, items.length, rnd);
    const cells = new Array(items.length);
    order.forEach((itemIndex, n) => { cells[itemIndex] = [n % cols, Math.floor(n / cols)]; });
    const { pos, box } = lattice(cells, items, o.spacing);
    const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
    return pos.map(p => ({ x: o.center.x + p.x - mx, y: o.center.y + p.y - my }));
  },

  /** Loose scatter in a disc whose area grows with what is in it. */
  scatter(items, o) {
    const area = items.reduce((s, i) => s + (i.w + o.spacing) * (i.h + o.spacing), 0);
    const R = Math.sqrt(area / (Math.PI * SCATTER_FILL));
    // Seeded, so one scatter is reproducible - but the seed is the caller's to
    // choose. An import wants the default (the same drop lands the same way);
    // "Rearrange everything" passes a fresh one, because there the whole point
    // is that it comes out different.
    const rnd = mulberry32(o.seed ?? (items.length * 2654435761 >>> 0));
    const placed = [];
    return items.map(it => {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;   // sqrt keeps the density even across the disc
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const box = roomFor(it, o.spacing);
      // Outward from where it fell, never back towards the middle: the drawn
      // point is what makes this a scatter and moving a card inward would take
      // it somewhere it was not thrown. So a card lands where it was thrown
      // unless somebody is already there, and then it lands just past them.
      const at = slideOut(dir, box, placed, r);
      placed.push({ ...box, x: at.x, y: at.y });
      return { x: o.center.x + at.x, y: o.center.y + at.y };
    });
  },
};

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/**
 * Positions for items dealt onto integer cells, on a lattice whose columns and
 * rows are each only as wide and as tall as what actually landed in them.
 *
 * `cells` is one `[col, row]` per item, parallel to `items`. Cell (0, 0) is
 * centred on the origin; the block's own extent comes back as `box` so a caller
 * that would rather centre the whole thing can.
 *
 * The uniform alternative - one cell for the board, sized from the largest item
 * on it - is what this replaces, and its failure is any board with one big
 * photograph on it: every note is given a photograph's worth of room, and what
 * you get back is a board that is mostly gap. Per column and per row, that
 * photograph widens the one column and heightens the one row it is in, and
 * nothing else on the board moves at all.
 *
 * Non-overlap comes free and exactly: two items in the same column are in
 * different rows and each sits inside its own row's height, and the other way
 * about. That is why the four layouts built on this need no separation pass.
 */
function lattice(cells, items, gap) {
  const colW = new Map(), rowH = new Map();
  let c0 = 0, c1 = 0, r0 = 0, r1 = 0;
  cells.forEach(([c, r], i) => {
    colW.set(c, Math.max(colW.get(c) || 0, items[i].w + gap));
    rowH.set(r, Math.max(rowH.get(r) || 0, items[i].h + gap));
    if (c < c0) c0 = c; else if (c > c1) c1 = c;
    if (r < r0) r0 = r; else if (r > r1) r1 = r;
  });
  const [colX, xs] = track(colW, c0, c1);
  const [rowY, ys] = track(rowH, r0, r1);
  return {
    pos: cells.map(([c, r]) => ({ x: colX.get(c), y: rowY.get(r) })),
    box: { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] },
  };
}

/**
 * Centres of every track along one axis, and the two outer edges.
 *
 * Walked outward from track 0 in both directions rather than accumulated from
 * the low end, because track 0 has to straddle the origin whatever is on either
 * side of it - that is what lets `grid` promise the first item the exact point
 * it was given while the ring around it sizes itself freely.
 */
function track(span, lo, hi) {
  const mid = new Map();
  const first = span.get(0) || 0;
  let edge = -first / 2;
  for (let k = 0; k <= hi; k++) {
    const s = span.get(k) || 0;
    mid.set(k, edge + s / 2);
    edge += s;
  }
  const high = edge;
  edge = -first / 2;
  for (let k = -1; k >= lo; k--) {
    const s = span.get(k) || 0;
    edge -= s;
    mid.set(k, edge + s / 2);
  }
  return [mid, [edge, high]];
}

/** The room an item wants: its own rectangle with half a gap all round. */
const roomFor = (it, gap) => ({ hw: (it.w + gap) / 2, hh: (it.h + gap) / 2 });

/**
 * Slide a box out along a ray from the origin and stop at the first distance
 * where it is clear of every box already placed.
 *
 * This is the whole of how the two unstructured layouts avoid overlap, and it
 * is worth being exact rather than iterative. A box travelling along the ray
 * is at (t*dx, t*dy), so it clashes with a placed box while both
 * `|t*dx - X| < W` and `|t*dy - Y| < H` hold - each of which is an interval of
 * t, and the clash is where the two intervals meet. Every placed box therefore
 * bans one interval of the ray, and the answer is the first point at or after
 * `from` that no interval covers: sort by where they open, walk, and jump to
 * the far end of each one still covering you.
 *
 * The intervals are open, so a box may come to rest exactly touching - which is
 * what a spacing of zero is supposed to mean. An axis the ray does not move
 * along (dx or dy of zero) is a standing yes or no rather than an interval, and
 * a standing no rules that box out of the question entirely.
 *
 * Exact, so there is no residue to clean up afterwards and no cap to hit. The
 * cost is a pass over what is already down, per direction tried, per item: a
 * board of 500 - which is also the most a single drop may bring - lays out in
 * about 40ms, a board of 2000 in half a second. Both are paid once, by a
 * gesture that already animates every card on the board to somewhere new.
 */
function slideOut(dir, box, placed, from = 0) {
  const bans = [];
  for (const p of placed) {
    const span = (d, c, reach) => {
      if (d === 0) return Math.abs(c) < reach ? [-Infinity, Infinity] : null;
      const a = (c - reach) / d, b = (c + reach) / d;
      return a < b ? [a, b] : [b, a];
    };
    const sx = span(dir.x, p.x, box.hw + p.hw);
    if (!sx) continue;
    const sy = span(dir.y, p.y, box.hh + p.hh);
    if (!sy) continue;
    const lo = Math.max(sx[0], sy[0]), hi = Math.min(sx[1], sy[1]);
    if (hi > lo && hi > from) bans.push([lo, hi]);
  }
  bans.sort((a, b) => a[0] - b[0]);
  let t = from;
  for (const [lo, hi] of bans) {
    if (lo > t) break;          // clear from here on out
    if (hi > t) t = hi;
  }
  return { x: dir.x * t, y: dir.y * t };
}

// A note on what is deliberately *not* here: a pass that walks each card back
// towards the centre after it lands, axis by axis, until something stops it.
// It is the obvious next idea and it was written, measured and taken out again.
// Packing greedily from the middle outward is not helped by pulling each card
// as far in as it will go: the middle clogs, later cards are pushed further
// out than they would otherwise have been, and every board tried came out
// looser than leaving them where they first fitted - identical cards worst, at
// 46% covered down to 40%.

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * Item indices, oldest first.
 *
 * Undated items go last rather than first. A missing modification time is not a
 * time of zero, and treating it as one put every note and every pasted link
 * ahead of a photograph from 1912 - a "By date" layout whose first row is the
 * things that have no date reads as broken from the first glance.
 *
 * Equal times fall through to the name, naturally, so that a burst of frames
 * written in the same second comes out 2, 3, 10 rather than 10, 2, 3; and equal
 * names fall through to the order they arrived in, which is stable and is the
 * order the caller chose.
 */
function dateOrder(items) {
  const when = i => items[i].meta?.mtime || 0;
  const named = i => items[i].name || '';
  return items.map((_, i) => i).sort((a, b) => {
    const ta = when(a), tb = when(b);
    if (!ta !== !tb) return ta ? -1 : 1;
    return ta - tb
      || named(a).localeCompare(named(b), undefined, { numeric: true })
      || a - b;
  });
}

/**
 * A layout's licence to come out differently, or null for the canonical one.
 *
 * Null rather than a generator seeded with a constant, so that "was I given a
 * seed" is a question each layout answers once and cheaply, and so that adding
 * variation to a layout can never accidentally cost an unseeded caller its
 * reproducibility - there is nothing to draw from.
 */
function variation(o) {
  return o.seed == null ? null : mulberry32(o.seed);
}

/**
 * How far a column count may move off its natural value. Never onto it: the
 * natural count is what an unseeded run gives, so landing back there would be a
 * rearrangement that did nothing, which is the exact complaint the seed exists
 * to answer. Two either way rather than one, because a single step leaves only
 * two possible boards and a Rearrange that alternates between two layouts is a
 * toggle rather than a shuffle.
 */
const COL_STEPS = [-2, -1, 1, 2];

/** A column count moved off its natural value, kept inside 1..n. */
function reflow(cols, n, rnd) {
  const step = COL_STEPS[Math.floor(rnd() * COL_STEPS.length)];
  return Math.max(1, Math.min(n, cols + step));
}

/** Fisher-Yates, in place, from a supplied generator. */
function shuffleWith(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** A ring cell turned a quarter at a time about the centre. */
function spin([col, row], turn) {
  switch (turn & 3) {
    case 1:  return [-row, col];
    case 2:  return [-col, -row];
    case 3:  return [row, -col];
    default: return [col, row];
  }
}

/**
 * Nth cell of a square spiral: 0 -> (0,0), then right, up, left, down in
 * growing rings. Gives "outward from the centre" without any sorting.
 */
function ringCell(n) {
  if (n === 0) return [0, 0];
  const ring = Math.ceil((Math.sqrt(n + 1) - 1) / 2);
  const side = 2 * ring;
  const prev = (side - 1) * (side - 1);       // cells enclosed by the previous ring
  let i = n - prev;
  const per = side;                            // cells per edge of this ring
  if (i < per)       return [ring, -ring + 1 + i];
  i -= per;
  if (i < per)       return [ring - 1 - i, ring];
  i -= per;
  if (i < per)       return [-ring, ring - 1 - i];
  i -= per;
  return [-ring + 1 + i, -ring];
}

/** Small deterministic PRNG, so a scatter re-run looks the same. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
