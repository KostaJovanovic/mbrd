// Throwaway: a ring of cards with a hollow centre, a far-left card, and an
// outlier below — the arrangement in the "giant arc" screenshot. Check that a
// long cross-ring join no longer draws a vast bow, and that nothing drawn crosses
// a card. Run: node scratch/ring-debug.mjs
import { routeConnection, curvePoints, blockOf, HANDLE_MAX } from '../web/assets/js/web-route.ts';

const card = (id, x, y, w = 150, h = 100) => ({ id, x, y, w, h, rot: 0 });

// 10 cards on a ring (centre ~ (640,420), radius ~ 230), plus centre + outliers.
const ring = [];
const N = 10;
for (let i = 0; i < N; i++) {
  const a = (i / N) * Math.PI * 2;
  ring.push(card('r' + i, 640 + Math.cos(a) * 230, 420 + Math.sin(a) * 230));
}
const centre = card('font', 640, 420);
const geode = card('geode', 95, 460, 190, 105);   // far left
const ae = card('ae', 625, 835);                    // outlier below
const cards = [...ring, centre, geode, ae];
const byId = id => cards.find(c => c.id === id);

// The hard ones: outlier/far-left joined across the ring, and a centre join.
const conns = [
  ['ae', 'r2'], ['ae', 'r7'], ['geode', 'r5'], ['geode', 'r0'],
  ['font', 'r0'], ['font', 'r5'], ['r0', 'r5'],
];

function deepestHit(pts, obstacles) {
  let worst = { id: null, depth: 0 };
  for (const o of obstacles) {
    const b = blockOf(o, 0);
    for (const p of pts) {
      if (p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1) {
        const d = Math.min(p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y);
        if (d > worst.depth) worst = { id: o.id, depth: d };
      }
    }
  }
  return worst;
}

let drawnCross = 0;
for (const [aId, bId] of conns) {
  const a = byId(aId), b = byId(bId);
  const obstacles = cards.filter(c => c.id !== aId && c.id !== bId);
  const r = routeConnection(a, b, obstacles, { shape: 'curve', clearance: 30 });
  const pts = curvePoints(r.points, r.ends);
  // Largest handle magnitude on this curve (the "how big is the bow" measure).
  const bow = r.ends ? Math.max(Math.hypot(r.ends[0].x, r.ends[0].y), Math.hypot(r.ends[1].x, r.ends[1].y)) : 0;
  const hit = deepestHit(pts, obstacles);
  const cross = hit.id && !r.blocked;
  if (cross) drawnCross++;
  console.log(
    `${aId}->${bId}  blocked=${!!r.blocked}  routePts=${r.points.length}  bow=${bow.toFixed(0)}` +
    (r.blocked ? '  (badge)' : cross ? `  DRAWN+CROSSES ${hit.id} by ${hit.depth.toFixed(0)}px` : '  drawn clear'),
  );
}
console.log(`\nHANDLE_MAX=${HANDLE_MAX}   DRAWN-and-crossing (must be 0): ${drawnCross}`);
