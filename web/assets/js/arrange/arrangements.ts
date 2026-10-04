// Pure layout engine: each layout is (items, opts) => [{x, y}, ...], same order as input.
// `spacing` is edge-to-edge gap in world units, shared by all layouts.
// `seed` permits variation; without one, layouts are deterministic.
// MOBILE_ARRANGEMENTS further down are orders, not shapes: (items, opts) => items.

import { cellInset } from '../geometry.ts';
import { hasOwn, shuffle } from '../util.ts';
import { packColumns } from './columns.ts';

/** Position in world units. */
export type Point = { x: number, y: number };

/** Existing box on the board that new items must avoid. */
export type Obstacle = { x: number, y: number, w: number, h: number };

/** Rectangle + position + the fields order-based layouts sort on. */
export type ArrangeItem = {
  x: number,
  y: number,
  w: number,
  h: number,
  id?: string,
  type?: string,
  name?: string,
  meta?: { mtime?: number, tags?: unknown } | null,
};

/** Half-extents: rectangle plus half a gap. */
type Box = { hw: number, hh: number };

/** Placed box in slide coordinates. */
type Placed = Box & Point;

/** Bounding box of a laid block. */
type Extent = { x0: number, x1: number, y0: number, y1: number };

// Leading space cannot collide with real tags and sorts before all of them.
const UNTAGGED = ' untagged';

// Alphabetically first tag, or UNTAGGED. Sorts defensively rather than
// trusting the input, and avoids importing board-model.ts to stay below state.
function firstTag(it: ArrangeItem): string {
  const raw = it.meta?.tags;
  if (!Array.isArray(raw)) return UNTAGGED;
  let best: string | undefined;
  for (const t of raw) {
    if (typeof t === 'string' && t && (best === undefined || t < best)) best = t;
  }
  return best ?? UNTAGGED;
}

export const ARRANGEMENTS = [
  { id: 'spiral',  label: 'Spiral' },       // default for new boards
  { id: 'free',    label: 'Free (no layout)' },
  { id: 'grid',    label: 'Grid rings' },
  { id: 'masonry', label: 'Masonry' },
  { id: 'type',    label: 'Cluster by type' },
  { id: 'tag',     label: 'Cluster by tag' },
  { id: 'date',    label: 'By date' },
  { id: 'scatter', label: 'Random scatter' },
];

export type ArrangeOpts = {
  name?: string,
  center?: Point,
  spacing?: number,
  /** Snap lattice cell size, 0 for none. */
  cellStep?: number,
  seed?: number,
  obstacles?: Obstacle[],
  /** Masonry only: the width the block should fit, which sets the column count. */
  width?: number,
};

/** ArrangeOpts with defaults filled in. */
type Laying = ArrangeOpts & { center: Point, spacing: number };

/** Items in, one position per item out, same order. */
type Layout = (items: ArrangeItem[], o: Laying) => Point[];

// Y is negated in and out so layouts can work top-down; `free` is exempt.
export function arrange(items: ArrangeItem[], opts: ArrangeOpts = {}): Point[] {
  const o = { center: { x: 0, y: 0 }, spacing: 12, ...opts };
  // hasOwn guards against inherited keys from untrusted .mbrd input.
  const asked = o.name || 'grid';
  const name = hasOwn(LAYOUTS, asked) ? asked : 'grid';
  const fn = LAYOUTS[name];
  if (!items.length) return [];
  // `free` skips negation but still respects obstacles.
  if (name === 'free') {
    const loose = fn(items, o);
    return o.obstacles?.length ? avoidObstacles(items, loose, o) : loose;
  }
  // Reserve whole-cell footprints so snapping cannot cause overlap.
  const step = o.cellStep ?? 0;
  const laid = step > 0 ? items.map(it => toCells(it, step)) : items;
  const out = fn(laid, { ...o, center: { x: o.center.x, y: -o.center.y } });
  const world = out.map(p => ({ x: p.x, y: -p.y }));
  return o.obstacles?.length ? avoidObstacles(laid, world, o) : world;
}

/** Push new items outward along their rays until they clear all obstacles. */
function avoidObstacles(items: ArrangeItem[], world: Point[], o: Laying): Point[] {
  const c = o.center;
  const placed: Placed[] = (o.obstacles ?? [])
    .map(r => ({ x: r.x - c.x, y: r.y - c.y, hw: r.w / 2, hh: r.h / 2 }));
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

/** Grow item to whole-cell footprint so snapping preserves non-overlap. */
function toCells(it: ArrangeItem, step: number): ArrangeItem {
  const gap = 2 * cellInset(step);
  const cells = (v: number) => Math.max(Math.round((v + gap) / step), 1);
  return { ...it, w: cells(it.w) * step, h: cells(it.h) * step };
}

/** Shake radius for `free` rearrange, as a fraction of item size. */
const FREE_SHAKE = 0.5;

/** Gutter between clusters, as a multiple of `spacing`. */
const BLOCK_GAP = 3;

/** Target fill fraction for the scatter disc. 1.0 = full, overflow slides out. */
const SCATTER_FILL = 1;

/** Width-to-height target for block shapes. */
const MASONRY_ASPECT = 1.4;
const PAGE_ASPECT = 1.6;

/** Fan half-width and number of directions tried per spiral card. */
const SPIRAL_SWEEP = Math.PI / 2;
const SPIRAL_TRIES = 7;

const LAYOUTS: Record<string, Layout> = {
  /** Unseeded: identity. Seeded: shake each item off its position. May overlap. */
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
    // Variation: rotate the ring pattern by a quarter turn.
    const rnd = variation(o);
    const turn = rnd ? Math.floor(rnd() * 4) : 0;
    const { pos } = lattice(items.map((_, n) => spin(ringCell(n), turn)), items, o.spacing);
    return pos.map(p => ({ x: o.center.x + p.x, y: o.center.y + p.y }));
  },

  /** Golden-angle phyllotaxis. Angles from the sequence, radius from slideOut(). */
  spiral(items, o) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    // Variation: rotate the whole spiral.
    const rnd = variation(o);
    const phase = rnd ? rnd() * Math.PI * 2 : 0;
    const placed: Placed[] = [];
    return items.map((it, n) => {
      const box = roomFor(it, o.spacing);
      let best: Point | null = null, near = Infinity;
      for (let k = 0; k < SPIRAL_TRIES; k++) {
        const a = n * golden + phase + SPIRAL_SWEEP * (k / (SPIRAL_TRIES - 1) - 0.5);
        const at = slideOut({ x: Math.cos(a), y: Math.sin(a) }, box, placed);
        const r = at.x * at.x + at.y * at.y; // squared distance suffices
        if (r < near) { near = r; best = at; }
      }
      // SAFETY: rays are never axis-aligned here, so slideOut() always lands.
      const landed = best as Point;
      placed.push({ ...box, x: landed.x, y: landed.y });
      return { x: o.center.x + landed.x, y: o.center.y + landed.y };
    });
  },

  /** Columns, each item dropped into the currently shortest one. */
  masonry(items, o) {
    // Variation: add or remove a column.
    const rnd = variation(o);
    let cols = Math.max(1, Math.round(Math.sqrt(items.length * MASONRY_ASPECT)));
    if (o.width && o.width > 0) {
      // As many columns of the average card as the width holds. A column is as
      // wide as its widest card, so a mixed set can still run over; the caller
      // decides what happens then.
      const avg = items.reduce((s, it) => s + it.w + o.spacing, 0) / items.length;
      cols = Math.max(1, Math.floor(o.width / avg));
    } else if (rnd) cols = reflow(cols, items.length, rnd);
    cols = Math.min(cols, items.length);

    const { spots, height: tallest } = packColumns(items, { cols, gap: o.spacing });

    // Each column is as wide as its widest item.
    const widths = new Array<number>(cols).fill(0);
    items.forEach((it, i) => {
      const c = spots[i].col;
      widths[c] = Math.max(widths[c], it.w + o.spacing);
    });
    const placed = items.map((it, i) => ({ c: spots[i].col, y: spots[i].top + it.h / 2 }));

    const mid: number[] = [];
    let edge = 0;
    for (const w of widths) { mid.push(edge + w / 2); edge += w; }
    return placed.map(p => ({
      x: o.center.x + mid[p.c] - edge / 2,
      y: o.center.y + p.y - tallest / 2,
    }));
  },

  /** One block per type, blocks laid side by side in a stable order. */
  type(items, o) {
    return clustered(items, o, it => it.type || 'generic');
  },

  /** One block per first-alphabetical tag; untagged items form their own block. */
  tag(items, o) {
    return clustered(items, o, firstTag);
  },

  /** Oldest first, reading order. */
  date(items, o) {
    const order = dateOrder(items);
    // Variation: reflow columns (order is always preserved).
    const rnd = variation(o);
    let cols = Math.max(1, Math.ceil(Math.sqrt(items.length * PAGE_ASPECT)));
    if (rnd) cols = reflow(cols, items.length, rnd);
    const cells = new Array<[number, number]>(items.length);
    order.forEach((itemIndex, n) => { cells[itemIndex] = [n % cols, Math.floor(n / cols)]; });
    const { pos, box } = lattice(cells, items, o.spacing);
    const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
    return pos.map(p => ({ x: o.center.x + p.x - mx, y: o.center.y + p.y - my }));
  },

  /** Loose scatter in a disc whose area grows with item count. */
  scatter(items, o) {
    const area = items.reduce((s, i) => s + (i.w + o.spacing) * (i.h + o.spacing), 0);
    const R = Math.sqrt(area / (Math.PI * SCATTER_FILL));
    const rnd = mulberry32(o.seed ?? (items.length * 2654435761 >>> 0));
    const placed: Placed[] = [];
    return items.map(it => {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;   // sqrt keeps the density even across the disc
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const box = roomFor(it, o.spacing);
      // Slide outward only, never back towards the middle.
      const at = slideOut(dir, box, placed, r);
      placed.push({ ...box, x: at.x, y: at.y });
      return { x: o.center.x + at.x, y: o.center.y + at.y };
    });
  },
};

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/** Shared body of `type` and `tag`: one block per key, blocks side by side. */
function clustered(
  items: ArrangeItem[],
  o: Laying,
  keyOf: (it: ArrangeItem) => string,
): Point[] {
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = keyOf(it);
    (groups.get(k) || groups.set(k, []).get(k)!).push(i);
  });
  const rnd = variation(o);
  const order = [...groups.keys()].sort();
  if (rnd) shuffle(order, rnd);

  const laid = order.map(key => {
    const idx = groups.get(key)!;
    const sub = idx.map(i => items[i]);
    let cols = Math.max(1, Math.ceil(Math.sqrt(sub.length)));
    if (rnd) cols = reflow(cols, sub.length, rnd);
    const cells = sub.map((_, n): [number, number] => [n % cols, Math.floor(n / cols)]);
    return { idx, ...lattice(cells, sub, o.spacing) };
  });
  const seam = o.spacing * BLOCK_GAP;
  const width = (b: { box: Extent }) => b.box.x1 - b.box.x0;
  const total = laid.reduce((s, b) => s + width(b), 0) + seam * (laid.length - 1);

  const out = new Array<Point>(items.length);
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
}

/** Centre per cell plus the bounding box of the whole block. */
type Lattice = { pos: Point[], box: Extent };

/**
 * Place items on integer cells with per-column widths and per-row heights.
 * Cell (0,0) is at the origin. Non-overlap is guaranteed by construction.
 */
function lattice(
  cells: [number, number][],
  items: ArrangeItem[],
  gap: number,
): Lattice {
  const colW = new Map<number, number>(), rowH = new Map<number, number>();
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
    pos: cells.map(([c, r]) => ({ x: colX.get(c)!, y: rowY.get(r)! })),
    box: { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] },
  };
}

/** Centre per track and outer edges, walked outward from track 0. */
function track(
  span: Map<number, number>,
  lo: number,
  hi: number,
): [Map<number, number>, [number, number]] {
  const mid = new Map<number, number>();
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

/** Half-extents including half a gap on each side. */
const roomFor = (it: ArrangeItem, gap: number): Box =>
  ({ hw: (it.w + gap) / 2, hh: (it.h + gap) / 2 });

/**
 * Slide a box along a ray from the origin, stop at the first clear distance.
 * Exact: each placed box bans an interval of t; the answer is the first gap.
 * O(n) per item -- quadratic on the board, acceptable up to ~2000 items.
 */
function slideOut(dir: Point, box: Box, placed: Placed[], from = 0): Point {
  const bans: [number, number][] = [];
  for (const p of placed) {
    const span = (d: number, c: number, reach: number): [number, number] | null => {
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

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** Item indices sorted oldest-first; undated items last; ties broken by name. */
function dateOrder(items: ArrangeItem[]): number[] {
  const when = (i: number) => items[i].meta?.mtime || 0;
  const named = (i: number) => items[i].name || '';
  return items.map((_, i) => i).sort((a, b) => {
    const ta = when(a), tb = when(b);
    if (!ta !== !tb) return ta ? -1 : 1;
    return ta - tb
      || named(a).localeCompare(named(b), undefined, { numeric: true })
      || a - b;
  });
}

// ---------------------------------------------------------------------------
// Mobile: the same question, and a different answer
// ---------------------------------------------------------------------------
// Mobile boards are packed columns; layouts become orders: (items, opts) => items.
// Shared ids (`free`, `date`, `type`) survive a Desktop/Mobile switch.

export const MOBILE_ARRANGEMENTS = [
  { id: 'fit', label: 'Tight fit' },    // default -- tall items first packs best
  { id: 'free', label: 'As placed' },
  { id: 'date', label: 'By date' },
  { id: 'type', label: 'By kind' },
  { id: 'tag', label: 'By tag' },
  { id: 'name', label: 'By name' },
  { id: 'shuffle', label: 'Shuffle' },
];

/** Default Mobile order. */
export const MOBILE_DEFAULT = 'fit';

/** Map a stored Desktop arrangement id to one a Mobile column can show. */
export function mobileArrangement(name?: string): string {
  if (name && MOBILE_ARRANGEMENTS.some(a => a.id === name)) return name;
  return name === 'scatter' ? 'shuffle' : MOBILE_DEFAULT;
}

/** Top-to-bottom, left-to-right. Stable sort preserves input order for ties. */
const readingOrder = (items: ArrangeItem[]): ArrangeItem[] =>
  [...items].sort((a, b) => (b.y || 0) - (a.y || 0) || (a.x || 0) - (b.x || 0));

/** Same items reordered for the packer. */
type Order = (items: ArrangeItem[], o: ArrangeOpts) => ArrangeItem[];

const ORDERS: Record<string, Order> = {
  free: items => readingOrder(items),
  fit: items => readingOrder(items).sort((a, b) => b.h - a.h || b.w - a.w),
  date: items => dateOrder(items).map(i => items[i]),
  type: items => readingOrder(items)
    .sort((a, b) => (a.type || 'generic').localeCompare(b.type || 'generic')),
  // Untagged items sorted last (not first) despite the sentinel's sort order.
  tag: items => {
    const keyed = readingOrder(items).map(it => ({ it, key: firstTag(it) }));
    keyed.sort((a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === UNTAGGED) return 1;
      if (b.key === UNTAGGED) return -1;
      return a.key.localeCompare(b.key);
    });
    return keyed.map(k => k.it);
  },
  name: items => readingOrder(items)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })),
  shuffle: (items, o) => {
    const rnd = variation(o);
    return rnd ? shuffle([...items], rnd) : [...items];
  },
};

/** Order items for the Mobile packer. Pure; seedless calls are deterministic. */
export function mobileOrder(items: ArrangeItem[], opts: ArrangeOpts = {}): ArrangeItem[] {
  const fn = ORDERS[mobileArrangement(opts.name)] || ORDERS[MOBILE_DEFAULT];
  return items.length ? fn(items, opts) : [];
}

/** Reorder by saved id list; unknown items go last in their incoming order. Pure. */
export function applyAudioOrder<T extends { id: string }>(items: T[], order: unknown): T[] {
  if (!Array.isArray(order) || !order.length) return items.slice();
  const pos = new Map<string, number>(order.map((id: string, i: number) => [id, i]));
  const known: T[] = [];
  const fresh: T[] = [];
  for (const it of items) (pos.has(it.id) ? known : fresh).push(it);
  known.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  return [...known, ...fresh];
}

/** PRNG from the seed, or null for deterministic (no seed). */
function variation(o: ArrangeOpts): (() => number) | null {
  return o.seed == null ? null : mulberry32(o.seed);
}

/** Column-count offsets for variation. Never 0 -- that would be no change. */
const COL_STEPS = [-2, -1, 1, 2];

/** Shift column count by a random step, clamped to 1..n. */
function reflow(cols: number, n: number, rnd: () => number): number {
  if (n <= 1) return cols;
  const step = COL_STEPS[Math.floor(rnd() * COL_STEPS.length)];
  const moved = Math.max(1, Math.min(n, cols + step));
  if (moved !== cols) return moved; // clamp landed back? step the other way

  return cols > 1 ? cols - 1 : Math.min(n, cols + 1);
}


/** Rotate a cell by `turn` quarter-turns. */
function spin([col, row]: [number, number], turn: number): [number, number] {
  switch (turn & 3) {
    case 1:  return [-row, col];
    case 2:  return [-col, -row];
    case 3:  return [row, -col];
    default: return [col, row];
  }
}

/** The nth cell of a square spiral: 0 -> (0,0), then outward ring by ring. */
function ringCell(n: number): [number, number] {
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
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
