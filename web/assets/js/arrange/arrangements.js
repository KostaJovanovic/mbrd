// Arrangement engine.
//
// Every arrangement is a pure `(items, opts) => [{x, y}, ...]` in the same order
// as `items`, so the caller can use the result for a fresh import (positions for
// brand-new items) or for "Rearrange all" (new positions for existing ones)
// without either path knowing how the layout was computed.
//
// opts: { center: {x, y}, spacing: number, seed?: number }
//
// `seed` is permission to move the slots, not just to fill them differently.
// Without one every layout below is a pure function of the items it is handed,
// which is what makes an import reproducible: the same drop lands the same way
// twice. "Rearrange everything" wants the opposite - it has to look like
// something happened - so it passes a fresh seed and each layout answers with
// a different arrangement of the *same* kind. What varies is chosen per layout
// so that the layout's own identity survives it: a grid stays square, a spiral
// stays evenly packed, `date` stays in date order. See variation() below.

export const ARRANGEMENTS = [
  // Not "keep positions" any more: a drop under Free falls back to the grid
  // (see import/drop.js) and Rearrange shakes the board loose, so the only
  // promise Free still makes is that it will not impose a shape on you.
  { id: 'free',    label: 'Free (no layout)' },
  { id: 'grid',    label: 'Grid rings' },
  { id: 'spiral',  label: 'Spiral' },
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
  const o = { center: { x: 0, y: 0 }, spacing: 32, ...opts };
  const name = o.name || 'grid';
  const fn = LAYOUTS[name] || LAYOUTS.grid;
  if (!items.length) return [];
  if (name === 'free') return fn(items, o);
  const out = fn(items, { ...o, center: { x: o.center.x, y: -o.center.y } });
  return out.map(p => ({ x: p.x, y: -p.y }));
}

/**
 * How far a shaken item can travel under `free`, as a fraction of its own size.
 * Half a card: far enough that the board visibly loosens, close enough that
 * something you had put beside something else is still beside it.
 */
const FREE_SHAKE = 0.5;

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
   * called Free must not do. This is also the only layout that may overlap
   * items, and that is not a lapse: the positions it starts from are yours and
   * may already overlap, so refusing to would mean tidying, not shaking.
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

  /** Square spiral of uniform cells, filling ring by ring outward from centre. */
  grid(items, o) {
    const cw = maxBy(items, i => i.w) + o.spacing;
    const ch = maxBy(items, i => i.h) + o.spacing;
    // A quarter turn of the ring pattern. A ring that is completely full maps
    // onto itself under it, so a grid that comes out square comes out square
    // again - what moves is the last, unfinished ring, which is the only part
    // of a grid's outline there is to see change. Nothing else here can vary
    // without the result ceasing to be a grid.
    const rnd = variation(o);
    const turn = rnd ? Math.floor(rnd() * 4) : 0;
    return items.map((_, n) => {
      const [col, row] = spin(ringCell(n), turn);
      return { x: o.center.x + col * cw, y: o.center.y + row * ch };
    });
  },

  /** Phyllotaxis: the golden angle, so nothing lines up into visual rows. */
  spiral(items, o) {
    // In a phyllotaxis the nearest-neighbour distance is ~c, so c has to clear
    // the items themselves or the first ring self-overlaps. Sized off the
    // largest item, not the average, so one big photo can't sit on the rest.
    const c = (maxBy(items, i => i.w) + maxBy(items, i => i.h)) / 2 + o.spacing;
    const golden = Math.PI * (3 - Math.sqrt(5));
    // The whole spiral turned on its centre. Rotation is the one change a
    // phyllotaxis cannot be spoiled by: every distance in it is preserved, so
    // the rearranged spiral is packed exactly as evenly as the first one.
    const rnd = variation(o);
    const phase = rnd ? rnd() * Math.PI * 2 : 0;
    return items.map((_, n) => {
      const r = c * Math.sqrt(n);
      const a = n * golden + phase;
      return { x: o.center.x + r * Math.cos(a), y: o.center.y + r * Math.sin(a) };
    });
  },

  /** Fixed-width columns, each item dropped into the currently shortest one. */
  masonry(items, o) {
    // One column wider or narrower re-flows every item, because which column
    // is shortest changes the moment the first one does. It is the only change
    // masonry can make that is still masonry: the columns are the whole of it,
    // so moving items inside them would read as drift rather than as a layout.
    const rnd = variation(o);
    let cols = Math.max(1, Math.round(Math.sqrt(items.length * 1.4)));
    if (rnd) cols = reflow(cols, items.length, rnd);
    const colW = maxBy(items, i => i.w) + o.spacing;
    const heights = new Array(cols).fill(0);
    const out = items.map(it => {
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c]) c = k;
      const y = heights[c] + it.h / 2;
      heights[c] += it.h + o.spacing;
      return { x: (c - (cols - 1) / 2) * colW, y };
    });
    // Centre the whole block on the target point.
    const tallest = Math.max(...heights) - o.spacing;
    return out.map(p => ({ x: o.center.x + p.x, y: o.center.y + p.y - tallest / 2 }));
  },

  /** One grid block per type, blocks laid side by side in a stable order. */
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
    const blocks = order.map(k => groups.get(k));
    const gap = o.spacing * 3;

    // Size every block first so they can be centred as one row.
    const laid = blocks.map(idx => {
      const sub = idx.map(i => items[i]);
      // Each block reshapes as well as moving. Needed on its own account: a
      // board of one type is a single block, and shuffling a list of one
      // leaves it exactly where it was - so without this, the commonest board
      // there is would be the one board Rearrange could not rearrange.
      let cols = Math.max(1, Math.ceil(Math.sqrt(sub.length)));
      if (rnd) cols = reflow(cols, sub.length, rnd);
      const cw = maxBy(sub, i => i.w) + o.spacing;
      const ch = maxBy(sub, i => i.h) + o.spacing;
      const rows = Math.ceil(sub.length / cols);
      return { idx, cols, cw, ch, width: cols * cw, height: rows * ch };
    });
    const total = laid.reduce((s, b) => s + b.width, 0) + gap * (laid.length - 1);

    const out = new Array(items.length);
    let cursor = o.center.x - total / 2;
    for (const b of laid) {
      b.idx.forEach((itemIndex, n) => {
        const col = n % b.cols, row = Math.floor(n / b.cols);
        out[itemIndex] = {
          x: cursor + col * b.cw + b.cw / 2,
          y: o.center.y - b.height / 2 + row * b.ch + b.ch / 2,
        };
      });
      cursor += b.width + gap;
    }
    return out;
  },

  /** Oldest first, reading order. Falls back to import order when undated. */
  date(items, o) {
    const order = items.map((it, i) => i)
      .sort((a, b) => (items[a].meta?.mtime || 0) - (items[b].meta?.mtime || 0) || a - b);
    // Oldest-first is the entire meaning of this layout, so unlike every other
    // one here the items may not be re-dealt - `order` is not the caller's to
    // vary. What can change is the shape of the page they are read on: a
    // wider or narrower block reflows every row while leaving the reading
    // order exactly where it was.
    const rnd = variation(o);
    let cols = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.6)));
    if (rnd) cols = reflow(cols, items.length, rnd);
    const cw = maxBy(items, i => i.w) + o.spacing;
    const ch = maxBy(items, i => i.h) + o.spacing;
    const rows = Math.ceil(items.length / cols);
    const out = new Array(items.length);
    order.forEach((itemIndex, n) => {
      const col = n % cols, row = Math.floor(n / cols);
      out[itemIndex] = {
        x: o.center.x + (col - (cols - 1) / 2) * cw,
        y: o.center.y + (row - (rows - 1) / 2) * ch,
      };
    });
    return out;
  },

  /** Loose scatter in a disc whose area grows with the item count. */
  scatter(items, o) {
    const avg = items.reduce((s, i) => s + Math.max(i.w, i.h), 0) / items.length;
    const R = Math.sqrt(items.length) * (avg + o.spacing) * 0.72;
    // Seeded, so one scatter is reproducible - but the seed is the caller's to
    // choose. An import wants the default (the same drop lands the same way);
    // "Rearrange everything" passes a fresh one, because there the whole point
    // is that it comes out different.
    const rnd = mulberry32(o.seed ?? (items.length * 2654435761 >>> 0));
    return items.map(() => {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;   // sqrt keeps the density even across the disc
      return { x: o.center.x + r * Math.cos(a), y: o.center.y + r * Math.sin(a) };
    });
  },
};

const maxBy = (arr, fn) => arr.reduce((m, v) => Math.max(m, fn(v)), 0);

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
