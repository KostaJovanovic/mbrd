// Arrangement engine.
//
// Every arrangement is a pure `(items, opts) => [{x, y}, ...]` in the same order
// as `items`, so the caller can use the result for a fresh import (positions for
// brand-new items) or for "Rearrange all" (new positions for existing ones)
// without either path knowing how the layout was computed.
//
// opts: { center: {x, y}, spacing: number, seed?: number }

export const ARRANGEMENTS = [
  { id: 'free',    label: 'Free (keep positions)' },
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

const LAYOUTS = {
  /** Free never moves anything - it just hands back what the items already have. */
  free: items => items.map(i => ({ x: i.x, y: i.y })),

  /** Square spiral of uniform cells, filling ring by ring outward from centre. */
  grid(items, o) {
    const cw = maxBy(items, i => i.w) + o.spacing;
    const ch = maxBy(items, i => i.h) + o.spacing;
    return items.map((_, n) => {
      const [col, row] = ringCell(n);
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
    return items.map((_, n) => {
      const r = c * Math.sqrt(n);
      const a = n * golden;
      return { x: o.center.x + r * Math.cos(a), y: o.center.y + r * Math.sin(a) };
    });
  },

  /** Fixed-width columns, each item dropped into the currently shortest one. */
  masonry(items, o) {
    const cols = Math.max(1, Math.round(Math.sqrt(items.length * 1.4)));
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
    const order = [...groups.keys()].sort();
    const blocks = order.map(k => groups.get(k));
    const gap = o.spacing * 3;

    // Size every block first so they can be centred as one row.
    const laid = blocks.map(idx => {
      const sub = idx.map(i => items[i]);
      const cols = Math.max(1, Math.ceil(Math.sqrt(sub.length)));
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
    const cols = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.6)));
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
