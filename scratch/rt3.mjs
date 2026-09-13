import { routeConnection } from '../web/assets/js/web-route.ts';
const font={x:294.34,y:51.62,w:222,h:222}, ae={x:119.82,y:-600.75,w:222,h:222}, gcode={x:-791.26,y:13.36,w:296,h:166};
const iso=[[167.51,386.82],[405.85,371.96],[616.31,351.49],[649.31,181.23],[657.15,15.42],[665.1,-155.49],[-53.68,359.92],[-89.97,165.27],[-102.8,-1.8],[342.63,-285.92],[504.85,-245.05],[-60.56,-166.34],[116.4,-273.43]].map(([x,y])=>({x,y,w:250.88,h:186.88}));
const t=(n,A,B,obs,sh)=>{const r=routeConnection(A,B,obs,{shape:sh});console.log(n,sh,'blocked=',!!r.blocked,'pts=',r.points.length);};
t('font->ae',font,ae,[gcode,...iso],'square'); t('font->ae',font,ae,[gcode,...iso],'curve');
t('gcode->font',gcode,font,[ae,...iso],'square'); t('gcode->font',gcode,font,[ae,...iso],'curve');
