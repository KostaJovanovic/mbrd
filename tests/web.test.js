// The web has exactly one rule - no two threads may cross - and the pass that
// enforces it was rewritten to test each candidate against a grid of the
// threads already accepted rather than against all of them.
//
// That is the kind of change that is fast and wrong: a grid that fails to
// return one overlapping thread lets a crossing through, and the failure is
// invisible until you happen to look at the right corner of the right board.
// So the check here is the invariant itself, on point sets chosen to break a
// grid rather than to look like a moodboard - a single far outlier stretching
// the cells, a row of collinear points closing one axis to nothing, and tight
// clusters that pile a whole neighbourhood into one bucket.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { threads } from '../web/assets/js/canvas/web.js';

/**
 * Deliberately not the module's own predicate.
 *
 * Reusing it would make this test agree with the implementation about what a
 * crossing is, which is the one thing it must not do - a bug in `crosses`
 * would then hide behind itself. This is the textbook orientation test,
 * written out, sharing nothing but the definition.
 */
function crossing(a, b, c, d) {
  if (a === c || a === d || b === c || b === d) return false;
  const turn = (p, q, r) => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
  };
  const on = (p, q, r) =>
    Math.min(p.x, q.x) - 1e-9 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-9 &&
    Math.min(p.y, q.y) - 1e-9 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-9;

  const o1 = turn(a, b, c), o2 = turn(a, b, d);
  const o3 = turn(c, d, a), o4 = turn(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear and overlapping: two threads lying along each other draw as one,
  // and the module rejects that too.
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
  }
  return false;
}

/** Repeatable noise, so a failing board can be reproduced from its seed. */
function rng(seed) {
  let h = seed >>> 0 || 1;
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

const uniform = (n, seed) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({ x: r() * 4000 - 2000, y: r() * 3000 - 1500 }));
};

/** Tight clumps with empty space between them: many points to one grid cell. */
const clustered = (n, seed) => {
  const r = rng(seed);
  const hubs = Array.from({ length: 6 }, () => ({ x: r() * 5000, y: r() * 5000 }));
  return Array.from({ length: n }, (_, i) => {
    const h = hubs[i % hubs.length];
    return { x: h.x + (r() - 0.5) * 60, y: h.y + (r() - 0.5) * 60 };
  });
};

/** One point a long way off, which is what forces an edge into the wide list. */
const withOutlier = (n, seed) => {
  const pts = uniform(n - 1, seed);
  pts.push({ x: 900000, y: -900000 });
  return pts;
};

/** A single row: the vertical extent is zero, so every cell is degenerate. */
const row = (n, seed) => {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ x: i * 130 + r() * 4, y: 0 }));
};

/** Points sharing coordinates, which is what a snapped grid layout produces. */
const lattice = n => {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_, i) => ({
    x: (i % side) * 200, y: Math.floor(i / side) * 200,
  }));
};

const noCrossings = (pts, label) => {
  const edges = threads(pts);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i], [c, d] = edges[j];
      assert.ok(
        !crossing(pts[a], pts[b], pts[c], pts[d]),
        `${label}: threads ${a}-${b} and ${c}-${d} cross`,
      );
    }
  }
  return edges;
};

test('no two threads cross, on scattered points', () => {
  for (const seed of [1, 2, 3, 7, 99]) {
    for (const n of [2, 3, 5, 12, 40, 120]) {
      noCrossings(uniform(n, seed), `uniform n=${n} seed=${seed}`);
    }
  }
});

test('no two threads cross, on clustered points', () => {
  for (const seed of [4, 11]) {
    for (const n of [30, 90, 200]) {
      noCrossings(clustered(n, seed), `clustered n=${n} seed=${seed}`);
    }
  }
});

test('no two threads cross with one far outlier', () => {
  for (const n of [20, 80]) noCrossings(withOutlier(n, 5), `outlier n=${n}`);
});

test('no two threads cross on a degenerate row', () => {
  for (const n of [3, 10, 60]) noCrossings(row(n, 6), `row n=${n}`);
});

test('no two threads cross on an aligned lattice', () => {
  for (const n of [9, 49, 144]) noCrossings(lattice(n), `lattice n=${n}`);
});

test('the web is one connected piece', () => {
  for (const n of [2, 6, 25, 100]) {
    const pts = uniform(n, 12);
    const edges = threads(pts);
    // Union-find over the edges: every point must end up in one component, or
    // the board shows islands of items with nothing joining them.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const [a, b] of edges) parent[find(a)] = find(b);
    const roots = new Set(Array.from({ length: n }, (_, i) => find(i)));
    assert.equal(roots.size, 1, `n=${n} split into ${roots.size} pieces`);
  }
});

test('a board too small to have threads returns none', () => {
  assert.deepEqual(threads([{ x: 0, y: 0 }]), []);
});

test('the second pass adds threads the tree alone does not have', () => {
  // A spanning tree over n points has exactly n-1 edges. The point of the
  // second pass is everything past that, so a run that returns n-1 has
  // silently stopped doing half the work.
  const pts = uniform(60, 21);
  assert.ok(threads(pts).length > pts.length - 1);
});
