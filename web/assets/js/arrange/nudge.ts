// Overlap removal: (boxes, opts) => [{x, y}], same order. Each box moves as
// little as it can so that no two overlap, which keeps the board's shape - who
// sits left of whom, what is near what - where an arrangement replaces it.
// Pure; fixed boxes never move and the rest are cleared off them.

import type { Point } from './arrangements.ts';

/** A box by its centre, as the board stores one. */
type NudgeBox = { x: number, y: number, w: number, h: number, fixed?: boolean };

type NudgeOpts = {
  /** Edge-to-edge clearance two boxes are pushed to. */
  gap?: number,
  /** Moves are whole multiples of this, so a snapped card stays on its lattice. 0 for none. */
  step?: number,
};

/** Passes before giving up on a pile; a pile of a hundred clears in well under it. */
const MAX_PASSES = 400;

/** Penetration below this is touching, not overlapping - float noise from the halving. */
const EPS = 1e-6;

/**
 * Push overlapping pairs apart along the axis they overlap least on, which is
 * the shortest move that separates them and the one that keeps their order on
 * the other axis - unless that move lands a box on a third one and the other
 * axis lands it clear of everything. Without that, a crowded row only ever parted
 * sideways: each push shoved the next card along and the row grew wider and
 * wider while the room above and below it stayed empty. Two free boxes split
 * the move; a fixed one makes the other take all of it. Repeated until a pass
 * finds nothing, since clearing one pair can push a box into the next.
 */
export function nudgeApart(boxes: NudgeBox[], opts: NudgeOpts = {}): Point[] {
  const gap = Math.max(opts.gap ?? 0, 0);
  const step = Math.max(opts.step ?? 0, 0);
  const pos = boxes.map(b => ({ x: b.x, y: b.y }));
  const hw = boxes.map(b => (b.w + gap) / 2);
  const hh = boxes.map(b => (b.h + gap) / 2);
  const n = boxes.length;
  if (n < 2) return pos;
  // Boxes on one centre have no direction between them, and a pile pushed
  // apart pair by pair with made-up directions undoes itself. So a pile is
  // fanned out first, a hair apart along a golden-angle spiral, and from then
  // on every push has a real direction to follow. Fixed boxes keep their spot.
  // On a lattice the fan is taken back off at the end: every other move is a
  // whole step, so what is left over is the fan and nothing else.
  const fan = pos.map(() => ({ x: 0, y: 0 }));
  const seen = new Map<string, number>();
  pos.forEach((p, i) => {
    if (boxes[i].fixed) return;
    const key = `${p.x},${p.y}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    if (!k) return;
    const a = k * Math.PI * (3 - Math.sqrt(5));
    fan[i] = { x: Math.cos(a) * Math.sqrt(k) * 1e-3, y: Math.sin(a) * Math.sqrt(k) * 1e-3 };
    p.x += fan[i].x;
    p.y += fan[i].y;
  });
  // Where the whole set sits. On a lattice a move cannot be split in two, so
  // one box of the pair takes it, and the one on the outside is the one that
  // goes: the set grows outward from its middle rather than drifting one way.
  let cx = 0, cy = 0;
  for (const p of pos) { cx += p.x / n; cy += p.y / n; }
  const quantum = (v: number) => (step > 0 ? Math.ceil(v / step - EPS) * step : v);
  const order = boxes.map((_, i) => i);
  /** How many boxes other than `a` and `b` box `who` would overlap at (x, y). */
  const clashes = (who: number, x: number, y: number, a: number, b: number) => {
    let c = 0;
    for (let k = 0; k < n; k++) {
      if (k === a || k === b) continue;
      if (hw[who] + hw[k] - Math.abs(pos[k].x - x) > EPS
        && hh[who] + hh[k] - Math.abs(pos[k].y - y) > EPS) c++;
    }
    return c;
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    // Sweep on the left edge so a pass is n log n plus the pairs that touch,
    // not every pair on the board. Positions change under the sweep; a pair it
    // misses because of that is found on the next pass, and the loop only ends
    // on a pass that finds nothing.
    order.sort((a, b) => (pos[a].x - hw[a]) - (pos[b].x - hw[b]));
    for (let s = 0; s < n; s++) {
      const i = order[s];
      for (let t = s + 1; t < n; t++) {
        const j = order[t];
        if (pos[j].x - hw[j] >= pos[i].x + hw[i]) break;
        if (boxes[i].fixed && boxes[j].fixed) continue;
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
        const ox = hw[i] + hw[j] - Math.abs(dx);
        const oy = hh[i] + hh[j] - Math.abs(dy);
        if (ox <= EPS || oy <= EPS) continue;
        // The move along one axis. A fixed box can still share a centre with a
        // free one; then j goes right. `away` points from i to j: j moves along
        // it, i against it.
        const plan = (alongX: boolean) => {
          const away = Math.sign(alongX ? dx : dy) || 1;
          const need = alongX ? ox : oy;
          let mi = 0, mj = 0;
          if (boxes[i].fixed) mj = quantum(need);
          else if (boxes[j].fixed) mi = quantum(need);
          else if (step > 0) {
            const mid = alongX ? (pos[i].x + pos[j].x) / 2 : (pos[i].y + pos[j].y) / 2;
            const outward = (mid - (alongX ? cx : cy)) * away >= 0;
            if (outward) mj = quantum(need); else mi = quantum(need);
          } else { mi = need / 2; mj = need / 2; }
          return { alongX, away, mi, mj };
        };
        // Where a plan leaves the two, counted against everything else.
        const cost = (p: ReturnType<typeof plan>) => {
          const ux = p.alongX ? p.away : 0, uy = p.alongX ? 0 : p.away;
          return (p.mi ? clashes(i, pos[i].x - ux * p.mi, pos[i].y - uy * p.mi, i, j) : 0)
            + (p.mj ? clashes(j, pos[j].x + ux * p.mj, pos[j].y + uy * p.mj, i, j) : 0);
        };
        // Only a clear spot wins over the shorter move. One that is merely
        // less crowded starts a chain of its own, and a longer one.
        let pick = plan(ox <= oy);
        if (cost(pick)) {
          const other = plan(!pick.alongX);
          if (!cost(other)) pick = other;
        }
        const { alongX, away, mi, mj } = pick;
        if (alongX) { pos[i].x -= away * mi; pos[j].x += away * mj; }
        else { pos[i].y -= away * mi; pos[j].y += away * mj; }
        moved = true;
      }
    }
    if (!moved) break;
  }
  if (step > 0) pos.forEach((p, i) => { p.x -= fan[i].x; p.y -= fan[i].y; });
  settle(boxes, pos, hw, hh, step, cx, cy);
  return pos;
}

/** Most spots tried for one box before it is set past the edge of everything. */
const MAX_TRIES = 400;

/**
 * The pairwise pushes clear a crowded board quickly and a deep pile slowly:
 * pushed apart one pair at a time, a stack of sixty undoes as much as it does.
 * So whatever still overlaps after them is taken out and set back one box at
 * a time, nearest the middle first, each at the free spot nearest where the
 * pushes had got it to. Free spots are found by stepping off the side of
 * whatever is in the way, which is where the nearest one always is.
 */
function settle(
  boxes: NudgeBox[], pos: Point[], hw: number[], hh: number[],
  step: number, cx: number, cy: number,
) {
  const n = boxes.length;
  const hits = (i: number, j: number, p: Point) =>
    hw[i] + hw[j] - Math.abs(pos[j].x - p.x) > EPS && hh[i] + hh[j] - Math.abs(pos[j].y - p.y) > EPS;
  const loose: number[] = [];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (boxes[i].fixed) continue;
    for (let j = 0; j < n; j++) {
      if (j !== i && !out.has(j) && hits(i, j, pos[i])) { loose.push(i); out.add(i); break; }
    }
  }
  if (!loose.length) return;
  const placed = [...Array(n).keys()].filter(i => !out.has(i));
  const far = (i: number) => (pos[i].x - cx) ** 2 + (pos[i].y - cy) ** 2;
  loose.sort((a, b) => far(a) - far(b));
  // On a lattice a spot is a whole number of steps from where the box began,
  // rounded away from what it is stepping off.
  const onLattice = (from: number, v: number, up: boolean) => {
    if (!(step > 0)) return v;
    const k = (v - from) / step;
    return from + (up ? Math.ceil(k - EPS) : Math.floor(k + EPS)) * step;
  };
  for (const i of loose) {
    const want = pos[i];
    const dist = (p: Point) => (p.x - want.x) ** 2 + (p.y - want.y) ** 2;
    const queue: Point[] = [{ x: want.x, y: want.y }];
    const tried = new Set<string>();
    let spot: Point | null = null;
    for (let k = 0; k < MAX_TRIES && queue.length; k++) {
      let best = 0;
      for (let q = 1; q < queue.length; q++) if (dist(queue[q]) < dist(queue[best])) best = q;
      const c = queue.splice(best, 1)[0];
      const key = `${c.x},${c.y}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const block = placed.find(j => hits(i, j, c));
      if (block === undefined) { spot = c; break; }
      const b = pos[block], bx = boxes[i].x, by = boxes[i].y;
      queue.push(
        { x: onLattice(bx, b.x + hw[block] + hw[i], true), y: c.y },
        { x: onLattice(bx, b.x - hw[block] - hw[i], false), y: c.y },
        { x: c.x, y: onLattice(by, b.y + hh[block] + hh[i], true) },
        { x: c.x, y: onLattice(by, b.y - hh[block] - hh[i], false) },
      );
    }
    if (!spot) {
      let edge = -Infinity;
      for (const j of placed) edge = Math.max(edge, pos[j].x + hw[j]);
      spot = { x: onLattice(boxes[i].x, edge + hw[i], true), y: want.y };
    }
    pos[i] = spot;
    placed.push(i);
  }
}
