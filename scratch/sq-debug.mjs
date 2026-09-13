import { routeConnection } from '../web/assets/js/web-route.ts';
const C = (id, x, y, w, h) => ({ id, x, y: -y, w, h, rot: 0 });
const iso0 = C('iso0', 167, 386, 250, 186);
const gcode = C('gcode', -717, 80, 296, 166);
const all = [
  C('iso6', -53, 359, 250, 186), C('iso7', -92, 183, 250, 186),
  C('iso8', -102, 11, 250, 186), C('iso11', -60, -166, 250, 186),
  C('iso1', 405, 371, 250, 186), C('iso12', 123, -277, 250, 186),
  C('iso9', 342, -285, 250, 186), C('font', 294, 51, 222, 222),
  C('iso2', 616, 351, 250, 186), C('iso3', 649, 181, 250, 186),
  C('iso4', 657, 15, 250, 186), C('iso5', 665, -155, 250, 186),
  C('iso10', 504, -245, 250, 186),
];
for (const n of [4, 8, 13]) {
  const r = routeConnection(iso0, gcode, all.slice(0,n), { shape: 'square', clearance: 30 });
  console.log(`square n=${n}: blocked=${!!r.blocked} pts=${r.points.length}`);
}
