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

// The graph module, not the renderer. This was imported from canvas/web.js when
// the algorithm still lived inside it; the point of the split is that this file
// never needs the drawing half at all.
import { threads } from '../web/assets/js/web-graph.ts';

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
  // Before the loop, because everything below it is inside one. `threads()`
  // returning [] satisfied all five "no two threads cross" tests at once - the
  // strongest possible planarity guarantee, over no threads - and every caller
  // discarded the return value, so nothing downstream noticed either.
  //
  // Any connected web over n points has at least n-1 threads in it; that is the
  // weakest true statement about the output, and it is enough to make an empty
  // one fail here rather than pass everywhere.
  if (pts.length > 1) {
    assert.ok(edges.length >= pts.length - 1,
      `${label}: ${edges.length} threads over ${pts.length} points is not a web`);
  }
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
  // The empty case as well as the one-point one. `n = 0` slipped past the
  // DENSE_LIMIT guard, made `k = Math.min(14, -1)` and threw a RangeError out
  // of `new Float64Array(-1)` - a throw for the emptiest possible input, on a
  // function whose whole job is a list of pairs.
  assert.deepEqual(threads([]), []);
  assert.deepEqual(threads([{ x: 0, y: 0 }]), []);
});

test('the second pass adds threads the tree alone does not have', () => {
  // A spanning tree over n points has exactly n-1 edges. The point of the
  // second pass is everything past that, so a run that returns n-1 has
  // silently stopped doing half the work.
  const pts = uniform(60, 21);
  assert.ok(threads(pts).length > pts.length - 1);
});

// ---------------------------------------------------------------------------
// The dense limit
// ---------------------------------------------------------------------------
//
// Six tests stood here and went with the code they covered. The limit was an
// adaptive governor - it timed the tree, fitted a cost model and solved for the
// largest board it could rebuild inside half a frame - and what those tests
// guarded was not slowness but *instability*: a limit that chased a servo would
// drop, skip the second pass, measure a fast frame, climb, and change the web's
// shape every few frames while you dragged.
//
// Nobody drags this any more. It runs once, when somebody presses "Join these",
// so there is nothing to converge and the limit is a written-down number. What
// is left to test is the only thing that was ever true of it from the outside:
// past the limit the second pass is skipped, and the tree is not.

test('a board past the limit still gets a connected web', () => {
  // The second pass is what gets skipped, never the tree - so the guarantee
  // that the web is one piece has to survive the limit being hit.
  const pts = uniform(900, 33);
  const edges = threads(pts);
  const parent = Array.from({ length: pts.length }, (_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of edges) parent[find(a)] = find(b);
  assert.equal(new Set(pts.map((_, i) => find(i))).size, 1);
});

test('the extra-thread pass runs on cards with real width and height', () => {
  // A regression test for a ReferenceError, not for a graph property.
  //
  // CardGrid treats each card as an obstacle, and its constructor is the only
  // place that reads a point's w/h - so it is only entered once a board has
  // items with a real size AND enough candidates to get past the spanning tree
  // into the second pass. Every case above this one either passes bare points
  // or stops at the tree, so for the whole life of the module its constructor
  // called corners() and pointInItem() without web-graph.js importing either,
  // and threads() threw. The web stopped drawing past the tree and said
  // nothing. `npm run typecheck` is what finally noticed.
  //
  // Sized points, and a layout with far more candidate pairs than tree edges.
  const pts = [];
  for (let i = 0; i < 12; i++) {
    pts.push({ x: (i % 4) * 300, y: Math.floor(i / 4) * 300, w: 100, h: 100, rot: 0 });
  }
  const edges = threads(pts);
  // More than a spanning tree's n-1, which is what says the second pass ran
  // rather than merely not throwing.
  assert.ok(edges.length > pts.length - 1,
    `expected the extra-thread pass to add edges, got ${edges.length}`);

  // And a rotated card, which is the branch corners() exists for.
  const tilted = pts.map((p, i) => (i === 5 ? { ...p, rot: 30 } : p));
  assert.doesNotThrow(() => threads(tilted));
});
