// The actual failing board, pulled from the live app via CDP. World coords are
// y-up; the router works y-down, so y is negated (as cardOf does). Test whether
// routeConnection — given ALL other cards as obstacles — can route the two pairs
// the app marked blocked. If it can, the app's obstacle filter is the bug; if it
// cannot, the router's search budget is. Run: node scratch/real-debug.mjs
import { routeConnection, curvePoints, blockOf } from '../web/assets/js/web-route.ts';

// name, worldX, worldY(up), w, h  -> stored y-down.
const raw = [
  ['ae', 306, -694, 222, 222], ['font', 294, 51, 222, 222], ['gcode', -717, 80, 296, 166],
  ['iso0', 167, 386, 250, 186], ['iso1', 405, 371, 250, 186], ['iso2', 616, 351, 250, 186],
  ['iso3', 649, 181, 250, 186], ['iso4', 657, 15, 250, 186], ['iso5', 665, -155, 250, 186],
  ['iso6', -53, 359, 250, 186], ['iso7', -92, 183, 250, 186], ['iso8', -102, 11, 250, 186],
  ['iso9', 342, -285, 250, 186], ['iso10', 504, -245, 250, 186], ['iso11', -60, -166, 250, 186],
  ['iso12', 123, -277, 250, 186],
];
const cards = raw.map(([id, x, y, w, h]) => ({ id, x, y: -y, w, h, rot: 0 }));
const byId = id => cards.find(c => c.id === id);

const pairs = [
  ['iso0', 'gcode'],   // app: blocked router — but path around the outside exists?
  ['ae', 'iso0'],      // app: blocked router
  ['gcode', 'font'],   // app: blocked router — font enclosed, SHOULD stay blocked
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

for (const [aId, bId] of pairs) {
  const a = byId(aId), b = byId(bId);
  const obstacles = cards.filter(c => c.id !== aId && c.id !== bId);
  const r = routeConnection(a, b, obstacles, { shape: 'curve', clearance: 30 });
  const pts = curvePoints(r.points, r.ends);
  const hit = deepestHit(pts, obstacles);
  console.log(`${aId}->${bId}  blocked=${!!r.blocked}  routePts=${r.points.length}` +
    (hit.id ? `  curve crosses ${hit.id} by ${hit.depth.toFixed(0)}px` : '  clear'));
}
