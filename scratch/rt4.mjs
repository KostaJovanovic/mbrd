import { routeConnection, curvePoints } from '../web/assets/js/web-route.ts';
// Canvas negates world y. Replicate exactly.
const mk=(x,y,w,h)=>({x, y:-y, w, h});
const font=mk(294.34,51.62,222,222), ae=mk(119.82,-600.75,222,222), gcode=mk(-791.26,13.36,296,166);
const iso=[[167.51,386.82],[405.85,371.96],[616.31,351.49],[649.31,181.23],[657.15,15.42],[665.1,-155.49],[-53.68,359.92],[-89.97,165.27],[-102.8,-1.8],[342.63,-285.92],[504.85,-245.05],[-60.56,-166.34],[116.4,-273.43]].map(([x,y])=>mk(x,y,250.88,186.88));
for (const [n,A,B,obs] of [['font->ae',font,ae,[gcode,...iso]],['gcode->font',gcode,font,[ae,...iso]],['ae->iso',ae,iso[0],[font,gcode,...iso.slice(1)]]]) {
  const r = routeConnection(A,B,obs,{shape:'curve'});
  console.log(n,'blocked=',!!r.blocked,'pts=',r.points.length);
}
