// Throwaway: compute Softish curve routes for the four-card board in the
// screenshots and inspect them. Run: node scratch/route-debug.mjs
import { routeConnection, curvePoints, blockOf, bestFaces } from '../web/assets/js/web-route.ts';

const card = (id, x, y, w, h) => ({ id, x, y, w, h, rot: 0 });

// Screen-ish coords (y-down), read off the full-board screenshot.
const isolate = card('iso', 390, 119, 180, 118);
const gcode   = card('gc', 181, 373, 213, 120);
const ae      = card('ae', 402, 455, 160, 130);
const font    = card('fo', 615, 379, 156, 162);
const all = [isolate, gcode, ae, font];

const conns = [
  ['gc', 'fo'], ['iso', 'fo'], ['iso', 'gc'], ['iso', 'ae'], ['gc', 'ae'], ['fo', 'ae'],
];
const byId = id => all.find(c => c.id === id);

// Closest approach of a polyline to a card's box (negative = inside).
function gap(pts, cardBox, skipIds) {
  const b = blockOf(cardBox, 0);
  let min = Infinity;
  for (const p of pts) {
    const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
    const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
    min = Math.min(min, Math.hypot(dx, dy));
  }
  return min;
}

for (const [aId, bId] of conns) {
  const a = byId(aId), b = byId(bId);
  const obstacles = all.filter(c => c.id !== aId && c.id !== bId);
  const r = routeConnection(a, b, obstacles, { shape: 'curve', clearance: 30 });
  const pts = curvePoints(r.points, r.ends);
  // Nearest non-endpoint card the drawn curve comes to.
  const gaps = obstacles.map(o => `${o.id}:${gap(pts, o).toFixed(0)}`).join(' ');
  const ownGap = `${aId}:${gap(pts, a).toFixed(0)} ${bId}:${gap(pts, b).toFixed(0)}`;
  const bf = bestFaces(a, b);
  console.log(`\n${aId}->${bId}  routePts=${r.points.length}  norms=${JSON.stringify(r.ends)}`);
  console.log(`  settled ends: (${r.points[0].x.toFixed(0)},${r.points[0].y.toFixed(0)}) -> (${r.points.at(-1).x.toFixed(0)},${r.points.at(-1).y.toFixed(0)})`);
  console.log(`  drag    ends: (${bf.a.x.toFixed(0)},${bf.a.y.toFixed(0)}) -> (${bf.b.x.toFixed(0)},${bf.b.y.toFixed(0)})  na=${JSON.stringify(bf.na)} nb=${JSON.stringify(bf.nb)}`);
  console.log(`  gap to pass-by cards: ${gaps}   own ends: ${ownGap}`);
}
