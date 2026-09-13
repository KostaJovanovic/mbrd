// Throwaway: does the blocked flag fire, and does any drawn curve cross a card
// body, on a dense overlapping cluster like the Spotify screenshot?
// Run: node scratch/blocked-debug.mjs
import { routeConnection, curvePoints, blockOf } from '../web/assets/js/web-route.ts';

const card = (id, x, y, w = 230, h = 120) => ({ id, x, y, w, h, rot: 0 });

// A tight, overlapping cluster (centres ~150px apart, cards 230x120 => heavy
// overlap), plus one outlier top-right. y-down screen-ish coords.
const cards = [
  card('c0', 200, 250), card('c1', 340, 250), card('c2', 480, 250),
  card('c3', 200, 360), card('c4', 340, 360), card('c5', 480, 360),
  card('c6', 200, 470), card('c7', 340, 470), card('c8', 480, 470),
  card('out', 950, 90),           // the separated top-right card
];
const byId = id => cards.find(c => c.id === id);

// MST-ish: chain the cluster, then the outlier to the nearest cluster card.
const conns = [
  ['c0', 'c1'], ['c1', 'c2'], ['c0', 'c3'], ['c3', 'c6'], ['c4', 'c5'],
  ['c4', 'c7'], ['c2', 'c5'], ['c5', 'c8'], ['c1', 'c4'], ['c4', 'out'],
];

// Deepest penetration of the sampled curve into a non-endpoint card body.
function deepestHit(pts, obstacles) {
  let worst = { id: null, depth: 0 };
  for (const o of obstacles) {
    const b = blockOf(o, 0);
    for (const p of pts) {
      // Inside the box => how far past the nearest edge (min of the four insets).
      if (p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1) {
        const d = Math.min(p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y);
        if (d > worst.depth) worst = { id: o.id, depth: d };
      }
    }
  }
  return worst;
}

let blockedCount = 0, crossCount = 0;
for (const [aId, bId] of conns) {
  const a = byId(aId), b = byId(bId);
  const obstacles = cards.filter(c => c.id !== aId && c.id !== bId);
  const r = routeConnection(a, b, obstacles, { shape: 'curve', clearance: 30 });
  const pts = curvePoints(r.points, r.ends);
  const hit = deepestHit(pts, obstacles);
  const drawnCross = hit.id && !r.blocked;   // a crossing only matters if it is drawn
  if (r.blocked) blockedCount++;
  if (drawnCross) crossCount++;
  console.log(
    `${aId}->${bId}  blocked=${!!r.blocked}  routePts=${r.points.length}  ` +
    (r.blocked ? 'not drawn (badge)' : hit.id ? `DRAWN + CROSSES ${hit.id} by ${hit.depth.toFixed(0)}px` : 'drawn, clear'),
  );
}
console.log(`\nblocked: ${blockedCount}/${conns.length}   DRAWN-and-crossing (must be 0): ${crossCount}`);
