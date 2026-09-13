import { routeConnection, curvePoints } from '../web/assets/js/web-route.ts';
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
const sq = routeConnection(iso0, gcode, all, { shape: 'square', clearance: 30 });
console.log('square pts:', sq.points.map(p=>`(${p.x|0},${p.y|0})`).join(' '));
const cv = routeConnection(iso0, gcode, all, { shape: 'curve', clearance: 30 });
console.log('curve blocked:', !!cv.blocked, 'pts:', cv.points.map(p=>`(${p.x|0},${p.y|0})`).join(' '), 'ends:', JSON.stringify(cv.ends));
import { blockOf } from '../web/assets/js/web-route.ts';
function hits(pts, obs) {
  const out = [];
  for (const o of obs) {
    const b = blockOf(o, 0);
    for (let i=1;i<pts.length;i++){
      const [p,q]=[pts[i-1],pts[i]];
      // sample the straight segment
      for (let t=0;t<=1;t+=0.05){const x=p.x+(q.x-p.x)*t,y=p.y+(q.y-p.y)*t;
        if(x>b.x0&&x<b.x1&&y>b.y0&&y<b.y1){out.push(o.id);i=99;break;}}
    }
  }
  return [...new Set(out)];
}
console.log('square crosses bodies:', hits(sq.points, all));
