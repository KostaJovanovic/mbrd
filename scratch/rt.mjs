import { routeConnection } from '../web/assets/js/web-route.ts';
// Real board (world coords). from=top isolate, to=after effects.
const iso = { x:167, y:386, w:250, h:186 };
const ae  = { x:119, y:-600, w:222, h:222 };
const others = [
  {x:294,y:51,w:222,h:222},   // font
  {x:-791,y:13,w:296,h:166},  // gcode
  {x:405,y:371,w:250,h:186},{x:616,y:351,w:250,h:186},{x:649,y:181,w:250,h:186},
  {x:657,y:15,w:250,h:186},{x:665,y:-155,w:250,h:186},{x:-53,y:359,w:250,h:186},
  {x:-89,y:165,w:250,h:186},{x:-102,y:-1,w:250,h:186},{x:342,y:-285,w:250,h:186},
  {x:504,y:-245,w:250,h:186},{x:-60,y:-166,w:250,h:186},{x:116,y:-273,w:250,h:186},
];
for (const shape of ['square','curve']) {
  const r = routeConnection(iso, ae, others, { shape });
  console.log(shape, 'blocked=', !!r.blocked, 'pts=', r.points.length,
    r.points.slice(0,8).map(p=>`(${p.x|0},${p.y|0})`).join(' '));
}
