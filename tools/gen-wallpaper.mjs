// Draws the Softish wallpaper pieces (web/assets/img/wallpaper/<family>-<n>.svg)
// that are generated rather than hand-drawn: stand-ins for the photographs, to
// the contract in tests/wallpaper.test.js and research/wallpaper-graphics-2026-10-20.md.
// `node tools/gen-wallpaper.mjs [name...]` writes the named pieces, or all of them.
// green-1, -4 and -5 were drawn by hand and are not written from here.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { wallpaperTones } = await import(pathToFileURL(join(ROOT, 'web/assets/js/ui/wallpaper-pieces.ts')).href);
const { oklch, parseHex } = await import(pathToFileURL(join(ROOT, 'web/assets/js/color.ts')).href);
const lch = h => oklch(...parseHex(h));

/** A paper and an accent per family, light and dark: the preview colours a
 *  file carries for opening on its own, and what the preview renders use. */
export const PREVIEW = {
  red: ['#f1e1dc', '#b3332e', '#261a19', '#e0675d'],
  orange: ['#f3e5d6', '#c4621f', '#271d16', '#e8904f'],
  yellow: ['#f3ecd2', '#b8901a', '#25221a', '#e0c050'],
  green: ['#e6ebd3', '#3f7a3a', '#1f241b', '#7fbf6a'],
  blue: ['#dfe6f0', '#2f5fa8', '#181e27', '#6f9be0'],
  purple: ['#e8e1f0', '#6c45a0', '#1f1a27', '#a383d8'],
  pink: ['#f3e1ea', '#c24f86', '#271a21', '#e88ab7'],
  brown: ['#ece3d8', '#7a5232', '#221d18', '#b98a62'],
  white: ['#f4f2ee', '#e9e6df', '#1f1f1e', '#d8d4cc'],
  grey: ['#e7e8e9', '#7d8085', '#1e1f21', '#a5a8ad'],
  black: ['#e2e1df', '#222326', '#161617', '#4a4b50'],
};

export function previewTones(family, dark) {
  const [paper, accent, dpaper, daccent] = PREVIEW[family];
  return { paper: dark ? dpaper : paper, tones: wallpaperTones(lch(dark ? dpaper : paper), lch(dark ? daccent : accent), dark) };
}

function previewStyle(family) {
  const { paper, tones } = previewTones(family, false);
  const names = ['hi', '1', '2', '3', '4', '5', 'eye'];
  const rules = [`svg{background:${paper}}`];
  for (const [p, prop] of [['f', 'fill'], ['k', 'stroke'], ['s', 'stop-color']]) {
    for (const t of names) rules.push(`.${p}-${t}{${prop}:${tones[t]}}`);
  }
  return `<style>${rules.join('')}</style>`;
}

// ---- numbers and paths ----------------------------------------------------

const f1 = n => Math.round(n * 10) / 10;
const fi = n => Math.round(n);
const P = ([x, y]) => `${f1(x)} ${f1(y)}`;
const D2R = Math.PI / 180;
const dir = deg => [Math.cos(deg * D2R), Math.sin(deg * D2R)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const perp = a => [-a[1], a[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const rot = ([x, y], deg) => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [x * c - y * s, x * s + y * c]; };
/** Where the light comes from: the upper right, as every piece agrees. */
const LIGHT = norm([0.7, -0.7]);

/** Catmull-Rom through the points, as cubic segments after the first point. */
function seg(pts, closed = false) {
  const n = pts.length;
  const at = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  let d = '';
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    d += `C${P([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} ${P([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6])} ${P(p2)}`;
  }
  return d;
}
const open = pts => `M${P(pts[0])}${seg(pts)}`;
const closed = pts => `M${P(pts[0])}${seg(pts, true)}Z`;
const poly = pts => `M${pts.map(P).join('L')}Z`;

const cubic = (c, t) => {
  const u = 1 - t;
  return [0, 1].map(k => u * u * u * c[0][k] + 3 * u * u * t * c[1][k] + 3 * u * t * t * c[2][k] + t * t * t * c[3][k]);
};
const cubicTan = (c, t) => {
  const u = 1 - t;
  return norm([0, 1].map(k => 3 * u * u * (c[1][k] - c[0][k]) + 6 * u * t * (c[2][k] - c[1][k]) + 3 * t * t * (c[3][k] - c[2][k])));
};
const quad = (p0, p1, p2) => [p0, lerp(p0, p1, 2 / 3), lerp(p2, p1, 2 / 3), p2];

/** A tapered body along a curve: a stem, a rachis, a stalk. */
function ribbon(c, w0, w1, n = 14, t0 = 0, t1 = 1) {
  const l = [], r = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    const p = cubic(c, t), q = perp(cubicTan(c, t)), w = w0 + (w1 - w0) * i / n;
    l.push(add(p, mul(q, w))); r.push(sub(p, mul(q, w)));
  }
  return `M${P(l[0])}${seg(l)}L${P(r[n])}${seg(r.reverse())}Z`;
}

/**
 * A blade along +x from the origin: a leaf, a petal, a leaflet, a vane. `w(u)`
 * is the half-width at u along it; `bend` curls it toward +y. Returns the
 * outline and its two halves either side of the midrib, for folded shading.
 */
function blade(len, w, { bend = 0, n = 18, wobble = null } = {}) {
  const mid = [], top = [], bot = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const m = [u * len, bend * len * u * u];
    const q = perp(norm([1, 2 * bend * u]));
    const hw = w(u) * (wobble ? wobble(u) : 1);
    mid.push(m); top.push(sub(m, mul(q, hw))); bot.push(add(m, mul(q, hw)));
  }
  const rmid = [...mid].reverse();
  return {
    mid, top, bot,
    out: `M${P(top[0])}${seg(top)}L${P(bot[n])}${seg([...bot].reverse())}Z`,
    a: `M${P(top[0])}${seg(top)}L${P(rmid[0])}${seg(rmid)}Z`,
    b: `M${P(mid[0])}${seg(mid)}L${P(bot[n])}${seg([...bot].reverse())}Z`,
    rib: open(mid),
  };
}

/** A small seeded generator, so a piece draws the same every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- a piece being drawn -------------------------------------------------

function canvas(name, seed) {
  const defs = [], items = [], made = new Set();
  const rand = rng(seed);
  const c = {
    name, rand,
    rr: (a, b) => a + (b - a) * rand(),
    id: s => `${name}-${s}`,
    url: s => `url(#${name}-${s})`,
    def(s) { defs.push(s); },
    once(key, fn) { if (!made.has(key)) { made.add(key); defs.push(fn()); } return c.url(key); },
    stops: stops => stops.map(([o, t, a]) => `<stop offset="${o}" class="s-${t}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`).join(''),
    /** A linear gradient along the shape's box, x1 y1 x2 y2 in fractions. */
    lin(key, [x1, y1, x2, y2], stops) {
      return c.once(key, () => `<linearGradient id="${c.id(key)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${c.stops(stops)}</linearGradient>`);
    },
    rad(key, [cx, cy, r, fx = cx, fy = cy], stops) {
      return c.once(key, () => `<radialGradient id="${c.id(key)}" cx="${cx}" cy="${cy}" r="${r}" fx="${fx}" fy="${fy}">${c.stops(stops)}</radialGradient>`);
    },
    /** A soft blur, for a sheen, an out-of-focus leaf, a cloud inside a stone. */
    soft(sd) { return c.once(`soft${sd}`, () => `<filter id="${c.id(`soft${sd}`)}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`); },
    /** One separately moving piece: its body once in defs, then a shadow and itself. */
    item(pivot, body, { shadow = 0.16, dx = -9, dy = 13, blur = 7 } = {}) {
      const id = `i${items.length + 1}`;
      defs.push(`<g id="${c.id(id)}">${body}</g>`);
      const sh = shadow ? c.once(`sh${shadow}-${blur}`, () => `<filter id="${c.id(`sh${shadow}-${blur}`)}" x="-30%" y="-30%" width="160%" height="160%"><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${shadow} 0"/><feGaussianBlur stdDeviation="${blur}"/></filter>`) : '';
      items.push(`<g class="wp-item" data-pivot="${fi(pivot[0])} ${fi(pivot[1])}">${shadow ? `<use href="#${c.id(id)}" filter="${sh}" transform="translate(${dx} ${dy})"/>` : ''}<use href="#${c.id(id)}"/></g>`);
    },
    svg(desc) {
      if (items.length < 1 || items.length > 3) throw new Error(`${name}: ${items.length} items`);
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 1000">
<!-- Preview colours for opening the file on its own; the app removes this and paints the palette's tones. -->
${previewStyle(name.split('-')[0])}
<!-- ${name}: ${desc}. Drawn by tools/gen-wallpaper.mjs; edit that, not this. -->
<defs>
${defs.join('\n')}
</defs>
${items.join('\n')}
</svg>
`;
    },
  };
  return c;
}

const g = (tf, body) => `<g transform="${tf}">${body}</g>`;
const at = (p, a = 0, s = 1, sy = s) => `translate(${f1(p[0])} ${f1(p[1])})${a ? ` rotate(${f1(a)})` : ''}${s !== 1 || sy !== s ? ` scale(${f1(s * 1000) / 1000}${sy !== s ? ` ${f1(sy * 1000) / 1000}` : ''})` : ''}`;
const path = (d, cls, extra = '') => `<path d="${d}"${cls ? ` class="${cls}"` : ''}${extra ? ` ${extra}` : ''}/>`;
const lit = (normal) => dot(norm(normal), LIGHT);

// ---- shared parts ---------------------------------------------------------

/** A faceted crystal along +x from its root: a hexagonal prism and its point. */
function prism(c, len, wid, { tip = 0.28, tones = 'mid', lines = true, streaks = 0, angle = 0 } = {}) {
  const tipLen = len * tip, body = len - tipLen;
  const e = [-0.5, -0.14 + c.rr(-0.06, 0.06), 0.24 + c.rr(-0.06, 0.06), 0.5].map(k => k * wid);
  const back = [c.rr(0.02, 0.1), c.rr(-0.04, 0.04), c.rr(0.04, 0.12), c.rr(0, 0.06)].map(k => k * len);
  const apex = [len, c.rr(-0.12, 0.12) * wid];
  // which way the -y face looks, in the world, decides which strip is lit
  const upLit = lit(rot([0, -1], angle)) > 0;
  const shades = { light: [['2', 'hi'], ['3', '1'], ['4', '2']], mid: [['3', '1'], ['4', '2'], ['5', '3']], deep: [['4', '2'], ['5', '3'], ['5', '4']] }[tones];
  const order = upLit ? [0, 1, 2] : [2, 1, 0];
  let out = '';
  for (let i = 0; i < 3; i++) {
    const [a, b] = shades[order[i]];
    const fill = c.lin(`pr-${a}-${b}`, [0, 0, 1, 0], [[0, a], [1, b]]);
    out += path(poly([[0, e[i]], [body - back[i], e[i]], [body - back[i + 1], e[i + 1]], [0, e[i + 1]]]), '', `fill="${fill}"`);
    const [ta, tb] = shades[Math.max(0, order[i] - 1)];
    const tf = c.lin(`pt-${ta}-${tb}`, [0, 0, 1, 0], [[0, ta], [1, tb]]);
    out += path(poly([[body - back[i], e[i]], apex, [body - back[i + 1], e[i + 1]]]), '', `fill="${tf}"`);
  }
  for (let s = 0; s < streaks; s++) {
    const y = c.rr(-0.4, 0.4) * wid, x0 = c.rr(0.05, 0.4) * body;
    out += path(`M${P([x0, y])}L${P([x0 + c.rr(0.2, 0.5) * body, y + c.rr(-2, 2)])}`, 'k-hi', `fill="none" stroke-width="${f1(c.rr(0.6, 1.6))}" opacity="${f1(c.rr(0.12, 0.3) * 100) / 100}"`);
  }
  if (lines) {
    out += path(`M0 ${f1(e[1])}L${P([body - back[1], e[1]])}L${P(apex)}M0 ${f1(e[2])}L${P([body - back[2], e[2]])}L${P(apex)}`, 'k-hi', 'fill="none" stroke-width="0.9" opacity=".45" stroke-linejoin="round"');
    out += path(poly([[0, e[0]], [body - back[0], e[0]], apex, [body - back[3], e[3]], [0, e[3]]]), 'k-5', 'fill="none" stroke-width="0.8" opacity=".35" stroke-linejoin="round"');
  }
  return out;
}

/** A smooth stone: wobbled ellipse, lit from the upper right. Returns the outline too, for clipping. */
function stoneOutline(c, rx, ry, wob = 0.06, n = 14) {
  const pts = [];
  const ph = c.rr(0, 6);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + wob * Math.sin(a * 2 + ph) + wob * 0.6 * Math.sin(a * 3 + ph * 2) + c.rr(-wob, wob) * 0.5;
    pts.push([Math.cos(a) * rx * k, Math.sin(a) * ry * k]);
  }
  return closed(pts);
}

// ---- the pieces -------------------------------------------------------------

const PIECES = {};

// Majesty palm: two fronds, each a short arching rachis with folded strap
// leaflets set along both sides, angled forward and drooping.
PIECES['green-2'] = () => {
  const c = canvas('green-2', 7);
  const BENDS = [0.1, 0.18, 0.27, 0.36];
  BENDS.forEach((bend, v) => {
    const b = blade(1000, u => 50 * Math.pow(Math.sin(Math.PI * Math.min(u, 0.999)), 0.75) * (1 - 0.45 * u) + 4 * (1 - u), { bend, n: 16 });
    c.def(`<path id="${c.id(`l${v}a`)}" d="${b.a}"/><path id="${c.id(`l${v}b`)}" d="${b.b}"/>`);
  });
  const frond = (p0, p1, p2, size, n, stem, tones) => {
    const cv = quad(p0, p1, p2);
    const back = [], front = [];
    for (let i = 0; i < n; i++) {
      const t = 0.26 + 0.71 * (i / (n - 1));
      const p = cubic(cv, t), tg = cubicTan(cv, t);
      const phi = Math.atan2(tg[1], tg[0]) / D2R;
      const u = (t - 0.26) / 0.71;
      const len = size * (0.55 + 0.45 * Math.sin(Math.PI * (0.15 + 0.75 * u))) * (1 - 0.45 * u * u) * (0.92 + 0.16 * c.rand());
      for (const side of [-1, 1]) {
        const theta = phi + (46 - 14 * u + (c.rand() - 0.5) * 8) * side;
        const flip = Math.cos(theta * D2R) >= 0 ? 1 : -1;
        const v = Math.min(3, Math.max(0, Math.round((1 - u) * 2.6 + c.rand() * 0.9 + (side > 0 ? 0.5 : 0))));
        const s = len / 1000;
        const [ta, tb] = side < 0 ? tones.upper : tones.lower;
        const leaf = g(at(p, theta, s, s * flip), `<use href="#${c.id(`l${v}a`)}" class="${flip > 0 ? ta : tb}"/><use href="#${c.id(`l${v}b`)}" class="${flip > 0 ? tb : ta}"/>`);
        (side > 0 ? back : front).push(leaf);
      }
    }
    const rachis = path(ribbon(cv, stem + 0.6, 0.8, 20), tones.stem) + path(open(Array.from({ length: 21 }, (_, i) => cubic(cv, i / 20))), 'k-2', 'fill="none" stroke-width="1.2" opacity=".55"');
    c.item(p0, back.join('') + rachis + front.join(''));
  };
  frond([-250, 560], [-40, 110], [300, 170], 230, 15, 4.5, { upper: ['f-1', 'f-3'], lower: ['f-3', 'f-4'], stem: 'f-3' });
  frond([-270, 1110], [-20, 690], [310, 780], 255, 15, 5, { upper: ['f-2', 'f-4'], lower: ['f-3', 'f-5'], stem: 'f-4' });
  return c.svg('majesty palm, two fronds reaching in past the left edge: a short arching stem, folded strap leaflets on both sides angled forward and drooping');
};

// Zebra haworthia: two rosettes seen from a little above, and a pup. Stiff
// keeled leaves in three rings, banded across with rows of white tubercles.
PIECES['green-3'] = () => {
  const c = canvas('green-3', 17);
  // leaf variants: the outline takes its tone from the <use>, the far half is
  // shaded over it, and the bands are dotted strokes clipped to the leaf
  for (let k = 0; k < 3; k++) {
    const b = blade(100, u => 16.5 * Math.min(1, u * 5 + 0.25) * (1 - u) ** (0.85 + 0.1 * k), { n: 12, bend: 0.06 + 0.05 * k });
    c.def(`<clipPath id="${c.id(`lc${k}`)}"><path d="${b.out}"/></clipPath>`);
    let bands = '';
    for (let x = 14; x < 92; x += 8.5) {
      const w = 17 * (1 - x / 100) + 1;
      const y = (0.06 + 0.05 * k) * 100 * (x / 100) ** 2;
      bands += `M${f1(x + 3)} ${f1(y - w)}Q${f1(x - 1.5)} ${f1(y)} ${f1(x + 3)} ${f1(y + w)}`;
    }
    c.def(`<g id="${c.id(`l${k}`)}"><path d="${b.out}"/>${path(b.b, 'f-5', 'opacity=".42"')}`
      + `<g clip-path="${c.url(`lc${k}`)}">${path(bands, 'k-hi', 'fill="none" stroke-width="2.3" stroke-linecap="round" stroke-dasharray="0 3.4" opacity=".85"')}</g>`
      + `${path(b.rib, 'k-hi', 'fill="none" stroke-width="0.8" opacity=".25"')}</g>`);
  }
  const rosette = (C, R, tilt) => {
    const rings = [{ n: 11, len: R, tone: 'f-4', off: 0 }, { n: 9, len: R * 0.74, tone: 'f-3', off: 17 }, { n: 7, len: R * 0.5, tone: 'f-2', off: 7 }, { n: 5, len: R * 0.28, tone: 'f-2', off: 30 }];
    let s = '';
    for (const ring of rings) {
      for (let i = 0; i < ring.n; i++) {
        const a = ring.off + (i / ring.n) * 360 + c.rr(-7, 7);
        // leaves curl toward the light side of the rosette less than away from it
        const sy = Math.sin(a * D2R) > 0 ? 1 : -1;
        s += `<use href="#${c.id(`l${Math.floor(c.rand() * 3)}`)}" class="${ring.tone}" transform="rotate(${f1(a)}) scale(${f1(ring.len * c.rr(0.9, 1.08)) / 100} ${f1(sy * ring.len) / 100})"/>`;
      }
    }
    return g(at(C, tilt, 1, 0.78), s + `<circle r="${fi(R * 0.07)}" class="f-3"/>`);
  };
  c.item([-300, 220], rosette([-30, 220], 190, -8));
  c.item([-300, 760], rosette([-20, 760], 130, 12));
  c.item([-300, 860], rosette([150, 855], 54, 30), { shadow: 0.18, blur: 5 });
  return c.svg('zebra haworthia, two rosettes seen from a little above and a pup, stiff keeled leaves banded with white tubercles, cut by the left edge');
};

// Anthurium: two glossy heart-shaped spathes with their spadix, each in front
// of a long heart leaf, on stems from beyond the edge.
PIECES['red-1'] = () => {
  const c = canvas('red-1', 11);
  const HEART = [[0, 0], [-0.1, -0.13], [-0.16, -0.29], [-0.11, -0.43], [0.05, -0.51], [0.27, -0.5], [0.5, -0.39], [0.7, -0.24], [0.87, -0.1], [1, 0],
    [0.87, 0.1], [0.7, 0.24], [0.5, 0.39], [0.27, 0.5], [0.05, 0.51], [-0.11, 0.43], [-0.16, 0.29], [-0.1, 0.13]];
  const heart = (L, W) => closed(HEART.map(([x, y]) => [x * L, y * W]));
  const veins = (L, W, k, cls, op, sw) => {
    let d = '';
    for (let i = 1; i <= k; i++) {
      const f = i / (k + 1);
      for (const s of [-1, 1]) d += `M${P([0.03 * L, s * 0.02 * W])}C${P([0.2 * L, s * (0.5 * f + 0.04) * W])} ${P([0.6 * L, s * 0.42 * f * W])} ${P([0.985 * L, 0])}`;
    }
    return path(d, cls, `fill="none" stroke-width="${sw}" opacity="${op}"`);
  };
  const clip = (L, W) => c.once(`h${fi(L)}-${fi(W)}`, () => `<clipPath id="${c.id(`h${fi(L)}-${fi(W)}`)}"><path d="${heart(L, W)}"/></clipPath>`);
  const spathe = (p, a, L) => {
    const W = L * 1.05;
    const fill = c.rad('sp', [0.42, 0.4, 0.7], [[0, '2'], [0.55, '3'], [1, '4']]);
    let s = path(heart(L, W), '', `fill="${fill}"`);
    s += `<g clip-path="${clip(L, W)}">${veins(L, W, 5, 'k-5', '.32', 1.6)}${g('translate(1.2 -1.2)', veins(L, W, 5, 'k-hi', '.28', 1))}</g>`;
    s += path(`M${P([0.02 * L, 0])}Q${P([0.5 * L, -0.03 * W])} ${P([0.985 * L, 0])}`, 'k-4', 'fill="none" stroke-width="1.6" opacity=".5"');
    s += `<ellipse cx="${fi(0.42 * L)}" cy="${fi(-0.2 * W)}" rx="${fi(0.26 * L)}" ry="${fi(0.12 * W)}" transform="rotate(-12 ${fi(0.42 * L)} ${fi(-0.2 * W)})" class="f-hi" opacity=".42" filter="${c.soft(6)}"/>`;
    // the spadix rises out of the spathe, toward the light
    const sc = [[0.02 * L, 0], [0.15 * L, -0.06 * L], [0.3 * L, -0.15 * L], [0.43 * L, -0.27 * L]];
    const sf = c.lin('spx', [0, 0, 1, 1], [[0, 'hi'], [0.6, '1'], [1, '3']]);
    s += path(ribbon(sc, 0.05 * L, 0.022 * L, 10), '', `fill="${sf}"`);
    const dots = c.once('dots', () => `<pattern id="${c.id('dots')}" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.1" class="f-3"/></pattern>`);
    s += path(ribbon(sc, 0.05 * L, 0.022 * L, 10), '', `fill="${dots}" opacity=".5"`);
    return g(at(p, a, 1, 0.86), s);
  };
  const leaf = (p, a, L) => {
    const W = L * 0.5;
    const fill = c.lin('lf', [0, 0, 1, 1], [[0, '3'], [0.6, '4'], [1, '5']]);
    let s = path(heart(L, W), '', `fill="${fill}"`);
    s += path(`M${P([0.02 * L, 0])}Q${P([0.5 * L, -0.02 * W])} ${P([0.985 * L, 0])}`, 'k-2', 'fill="none" stroke-width="2" opacity=".45"');
    let v = '';
    for (let i = 1; i <= 6; i++) {
      const x = i * 0.13 * L;
      for (const sgn of [-1, 1]) v += `M${P([x, 0])}Q${P([x + 0.08 * L, sgn * 0.25 * W])} ${P([x + 0.2 * L, sgn * 0.36 * W * (1 - i / 8)])}`;
    }
    s += `<g clip-path="${clip(L, W)}">${path(v, 'k-2', 'fill="none" stroke-width="1.1" opacity=".3"')}</g>`;
    return g(at(p, a), s);
  };
  const stem = (from, ctrl, to, w) => path(ribbon(quad(from, ctrl, to), w, w * 0.7), 'f-4');
  c.item([-320, 600],
    stem([-330, 480], [-200, 370], [-86, 322], 5) + leaf([-90, 320], -6, 330)
    + stem([-320, 600], [-60, 380], [66, 196], 4.5) + spathe([60, 190], -40, 200));
  c.item([-320, 1080],
    stem([-330, 1040], [-180, 930], [-84, 892], 5) + leaf([-90, 890], 10, 290)
    + stem([-320, 1080], [-90, 860], [36, 746], 4.2) + spathe([30, 740], -14, 180));
  return c.svg('anthurium, two glossy heart-shaped spathes with their spadix, each before a long heart leaf, on stems from beyond the left edge');
};

// Garnets: dodecahedral crystals set in two pieces of dark matrix rock, and one loose.
PIECES['red-2'] = () => {
  const c = canvas('red-2', 23);
  const gem = (cx, cy, R, a0) => {
    const V = Array.from({ length: 6 }, (_, i) => add([cx, cy], mul(dir(a0 + i * 60 + c.rr(-6, 6)), R * c.rr(0.92, 1.06))));
    const C = add([cx, cy], mul([-0.5, 0.45], R * 0.18));
    let s = '';
    // a garnet is deep: its brightest facet stops short of the highlight
    const tones = ['5', '5', '4', '3', '2', '1'];
    for (let i = 0; i < 6; i++) {
      const A = V[i], B = V[(i + 1) % 6];
      const k = lit(sub(lerp(A, B, 0.5), C));
      const t = tones[Math.max(0, Math.min(5, Math.round((k + 1) / 2 * 4.2)))];
      s += path(poly([C, A, B]), `f-${t}`);
    }
    // the rhombic faces: three long edges from the centre, three creases
    let e = '', cr = '';
    for (let i = 0; i < 6; i++) {
      if (i % 2) cr += `M${P(C)}L${P(V[i])}`;
      else e += `M${P(C)}L${P(V[i])}`;
    }
    s += path(e, 'k-hi', 'fill="none" stroke-width="0.8" opacity=".4"') + path(cr, 'k-5', 'fill="none" stroke-width="0.6" opacity=".35"');
    s += path(poly(V), 'k-5', 'fill="none" stroke-width="0.9" opacity=".5" stroke-linejoin="round"');
    s += `<circle cx="${f1(cx + R * 0.32)}" cy="${f1(cy - R * 0.36)}" r="${f1(R * 0.09)}" class="f-hi" opacity=".85"/>`;
    return s;
  };
  const matrix = (cx, cy, rx, ry, gems) => {
    const key = `m${fi(cx)}${fi(cy)}`;
    const d = stoneOutline(c, rx, ry, 0.1, 16);
    c.def(`<clipPath id="${c.id(key)}"><path d="${d}" transform="translate(${fi(cx)} ${fi(cy)})"/></clipPath>`);
    const fill = c.rad('mx', [0.62, 0.32, 0.8], [[0, '3'], [0.5, '4'], [1, '5']]);
    let s = path(d, '', `fill="${fill}" transform="translate(${fi(cx)} ${fi(cy)})"`);
    let sp = '';
    for (let i = 0; i < 150; i++) {
      const p = [cx + c.rr(-rx, rx), cy + c.rr(-ry, ry)];
      sp += `<circle cx="${fi(p[0])}" cy="${fi(p[1])}" r="${f1(c.rr(0.6, 2.2))}" class="${c.rand() < 0.5 ? 'f-5' : 'f-2'}" opacity="${f1(c.rr(0.2, 0.6))}"/>`;
    }
    s += `<g clip-path="${c.url(key)}">${sp}</g>`;
    for (const [x, y, r, a] of gems) s += gem(x, y, r, a);
    return s;
  };
  c.item([-300, 190], matrix(-90, 200, 175, 140, [[60, 120, 34, 8], [92, 192, 44, -4], [48, 270, 30, 20], [10, 70, 26, 14], [-4, 160, 22, 2], [26, 330, 20, -10]]));
  c.item([-300, 780], matrix(-70, 780, 135, 110, [[40, 730, 30, 12], [56, 800, 36, -6], [8, 856, 24, 18]]));
  c.item([-300, 870], gem(170, 880, 27, 16), { shadow: 0.2, blur: 5 });
  return c.svg('garnets, dodecahedral crystals set in two pieces of dark matrix rock reaching in past the left edge, and one loose');
};

// Pincushion protea: two heads of curved styles with knobbed tips, on leafy stems.
PIECES['orange-1'] = () => {
  const c = canvas('orange-1', 31);
  const head = (C, R, tilt) => {
    let s = '';
    // the perianth: a dome of curly tubes under the styles
    const dome = c.rad('dome', [0.55, 0.4, 0.7], [[0, '2'], [0.6, '3'], [1, '5']]);
    s += `<ellipse cx="0" cy="0" rx="${fi(R * 0.42)}" ry="${fi(R * 0.36)}" fill="${dome}"/>`;
    let tubes = '';
    for (let i = 0; i < 26; i++) {
      const a = c.rr(-200, 20), r0 = R * 0.2, r1 = R * c.rr(0.36, 0.5);
      const p0 = mul(dir(a), r0), p1 = mul(dir(a + c.rr(-30, 30)), r1);
      tubes += `M${P(p0)}Q${P(add(lerp(p0, p1, 0.5), mul(perp(norm(sub(p1, p0))), c.rr(-6, 6))))} ${P(p1)}`;
    }
    s += path(tubes, 'k-4', 'fill="none" stroke-width="1.4" opacity=".6" stroke-linecap="round"');
    // the styles, curving up and in toward a point above the head
    const top = [0, -R * 0.9];
    const styles = [], knobs = [];
    const N = 44;
    for (let i = 0; i < N; i++) {
      const a = -195 + 210 * (i / (N - 1)) + c.rr(-3, 3);
      const base = mul(dir(a), R * c.rr(0.18, 0.3));
      const reach = R * c.rr(0.85, 1.05);
      const end = add(mul(dir(a), reach * 0.92), mul(top, 0.35 + 0.25 * Math.max(0, -Math.sin(a * D2R))));
      const ctrl = add(mul(dir(a), reach * 0.8), [0, R * 0.12]);
      const back = Math.sin(a * D2R) > 0.2;
      styles.push([back, `M${P(base)}Q${P(ctrl)} ${P(end)}`]);
      knobs.push([back, end, norm(sub(end, ctrl))]);
    }
    for (const want of [true, false]) {
      s += path(styles.filter(([b]) => b === want).map(([, d]) => d).join(''), want ? 'k-4' : 'k-2', `fill="none" stroke-width="${want ? 1.8 : 2.3}" stroke-linecap="round"`);
      // a knob is a short stroke with round caps, gathered into one path per tone
      const bins = {};
      for (const [b, e, d] of knobs) {
        if (b !== want) continue;
        const cls = want ? 'k-3' : c.rand() < 0.55 ? 'k-eye' : 'k-1';
        bins[cls] = (bins[cls] || '') + `M${P(sub(e, mul(d, 1.6)))}l${P(mul(d, 3.2))}`;
      }
      for (const [cls, d] of Object.entries(bins)) s += path(d, cls, 'fill="none" stroke-width="5" stroke-linecap="round"');
    }
    // bracts cupping it from below
    let br = '';
    for (let i = 0; i < 7; i++) {
      const a = 40 + i * 17 + c.rr(-4, 4);
      const b = blade(R * 0.34, u => R * 0.07 * Math.sin(Math.PI * Math.min(u, 0.98)) ** 0.7, { bend: 0.1 });
      br += g(at(mul(dir(a), R * 0.2), a), path(b.out, i % 2 ? 'f-4' : 'f-3'));
    }
    return g(at(C, tilt), br + s);
  };
  const leaf = (p, a, L, cls) => {
    const b = blade(L, u => L * 0.13 * Math.sin(Math.PI * Math.min(u, 0.96)) ** 0.55 * (1 - 0.2 * u), { bend: 0.06 });
    return g(at(p, a), path(b.a, cls[0]) + path(b.b, cls[1]) + path(b.rib, 'k-hi', 'fill="none" stroke-width="0.8" opacity=".3"'));
  };
  const plant = (from, ctrl, to, R, tilt, leaves) => {
    const cv = quad(from, ctrl, to);
    let s = path(ribbon(cv, 5.5, 3.5), 'f-4');
    for (const [t, side, L] of leaves) {
      const p = cubic(cv, t), tg = cubicTan(cv, t);
      s += leaf(p, Math.atan2(tg[1], tg[0]) / D2R + side * 38, L, side < 0 ? ['f-2', 'f-3'] : ['f-3', 'f-4']);
    }
    return s + head(to, R, tilt);
  };
  c.item([-300, 520], plant([-300, 520], [-60, 320], [96, 178], 96, 14, [[0.35, -1, 120], [0.5, 1, 110], [0.64, -1, 100], [0.78, 1, 84]]));
  c.item([-300, 1160], plant([-300, 1160], [-80, 920], [66, 830], 78, 26, [[0.4, 1, 104], [0.56, -1, 96], [0.72, 1, 80]]));
  return c.svg('pincushion protea, two heads of curved styles with knobbed tips on leafy stems from beyond the left edge');
};

// Pheasant tail feathers: three long barred feathers reaching in at different heights.
PIECES['orange-2'] = () => {
  const c = canvas('orange-2', 41);
  const barbs = (key, a) => c.once(key, () => `<pattern id="${c.id(key)}" width="3.2" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(${a})"><path d="M1.6 0V40" class="k-hi" stroke-width="0.7" opacity=".5"/></pattern>`);
  const feather = (base, a, L, W, k) => {
    const curve = u => 0.07 * L * u * u;
    const half = (side, w) => {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        // full by a tenth of the way, tapering over the last fifth, the edge a little ragged
        const hw = w * (u < 0.1 ? 0.35 + 6.5 * u : 1) * (u > 0.8 ? Math.sqrt(Math.max(0, (1 - u) / 0.2)) : 1) * (1 + 0.05 * Math.sin(u * 47 + k * 3 + side));
        pts.push([u * L, curve(u) + side * hw]);
      }
      const rib = Array.from({ length: 25 }, (_, i) => [(1 - i / 24) * L, curve(1 - i / 24)]);
      return `M${P(pts[0])}${seg(pts)}L${P(rib[0])}${seg(rib)}Z`;
    };
    const top = half(-1, W * 0.9), bot = half(1, W);
    const id = `v${k}`;
    c.def(`<clipPath id="${c.id(id)}"><path d="${top}${bot.replace('M', 'M')}"/></clipPath>`);
    const body = c.lin('body', [0, 0, 1, 0], [[0, '3'], [0.5, '2'], [1, '3']]);
    let s = path(top, '', `fill="${body}"`) + path(bot, '', `fill="${body}"`);
    s += path(top, '', `fill="${barbs('bt', 38)}"`) + path(bot, '', `fill="${barbs('bb', -38)}"`);
    // chevron bars pointing to the tip, each with a pale edge
    let bars = '', edges = '';
    const step = 30;
    for (let x = L * 0.08; x < L * 0.92; x += step) {
      const back = 14, wdt = 11;
      const pts = [[x - back, -W * 1.2], [x, curve(x / L)], [x - back, W * 1.2], [x - back + wdt, W * 1.2], [x + wdt, curve(x / L)], [x - back + wdt, -W * 1.2]];
      bars += poly(pts);
      edges += `M${P([x - back + wdt + 1.5, -W * 1.2])}L${P([x + wdt + 1.5, curve(x / L)])}L${P([x - back + wdt + 1.5, W * 1.2])}`;
    }
    s += `<g clip-path="${c.url(id)}">${path(bars, 'f-5', `opacity=".6" filter="${c.soft(1.2)}"`)}${path(edges, 'k-hi', 'fill="none" stroke-width="1.6" opacity=".4"')}</g>`;
    const rib = Array.from({ length: 13 }, (_, i) => [(i / 12) * L * 0.98, curve(i / 12)]);
    s += path(open(rib), 'k-1', 'fill="none" stroke-width="1.8" stroke-linecap="round"');
    return g(at(base, a), s);
  };
  c.item([-330, 420], feather([-330, 420], -32, 720, 32, 1));
  c.item([-330, 440], feather([-330, 440], -15, 680, 28, 2), { shadow: 0.14 });
  c.item([-320, 1060], feather([-320, 1060], -22, 650, 30, 3));
  return c.svg('pheasant tail feathers, three long barred feathers reaching in past the left edge at different heights');
};

// Mimosa: two sprigs of fluffy pom-pom flowers among feathery bipinnate leaves.
PIECES['yellow-1'] = () => {
  const c = canvas('yellow-1', 53);
  // a pom-pom: a soft ball with a fringe of stamen tips
  for (const [k, inner, outer, fringe] of [['a', '1', '3', 'f-hi'], ['b', '2', '4', 'f-1']]) {
    const fill = c.rad(`pg${k}`, [0.6, 0.38, 0.62], [[0, inner], [1, outer]]);
    let fr = '';
    for (let i = 0; i < 18; i++) {
      const p = mul(dir(i * 20 + c.rr(-6, 6)), c.rr(8.4, 10.2));
      fr += `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="${f1(c.rr(1.1, 1.8))}"/>`;
    }
    c.def(`<g id="${c.id(`pom${k}`)}"><circle r="9" fill="${fill}"/><g class="${fringe}">${fr}</g></g>`);
  }
  // one feathery leaf: a rachis with pairs of pinnae, each a comb of leaflets
  {
    const pinna = blade(34, u => 2.2 * Math.sin(Math.PI * Math.min(u, 0.97)) ** 0.5, { n: 8 });
    let teeth = '';
    for (let i = 1; i < 12; i++) for (const s of [-1, 1]) teeth += `M${f1(i * 2.8)} 0l${f1(2.4)} ${f1(s * 4.4 * (1 - i / 13))}`;
    c.def(`<g id="${c.id('pin')}">${path(pinna.out, 'f-3')}${path(teeth, 'k-3', 'fill="none" stroke-width="1.3" stroke-linecap="round"')}</g>`);
    let leaf = path('M0 0L150 6', 'k-4', 'fill="none" stroke-width="1.4"');
    for (let i = 0; i < 9; i++) {
      const x = 14 + i * 15;
      for (const s of [-1, 1]) leaf += `<use href="#${c.id('pin')}" transform="${at([x, x * 0.04], s * (58 - i * 2), 1 - i * 0.05)}"/>`;
    }
    c.def(`<g id="${c.id('leaf')}">${leaf}</g>`);
  }
  const sprig = (from, ctrl, to, branches, leaves) => {
    const cv = quad(from, ctrl, to);
    let back = '', front = '', poms = '';
    for (const [t, side, len, a] of leaves) {
      const p = cubic(cv, t), tg = cubicTan(cv, t);
      back += `<use href="#${c.id('leaf')}" transform="${at(p, Math.atan2(tg[1], tg[0]) / D2R + side * a, len / 150)}" opacity=".95"/>`;
    }
    back += path(ribbon(cv, 3.2, 1.4), 'f-4');
    for (const [t, side, len, n] of branches) {
      const p = cubic(cv, t), tg = cubicTan(cv, t);
      const ang = Math.atan2(tg[1], tg[0]) / D2R + side * c.rr(28, 46);
      const end = add(p, mul(dir(ang), len));
      const bc = quad(p, add(lerp(p, end, 0.5), mul(perp(dir(ang)), side * 10)), end);
      front += path(open(Array.from({ length: 7 }, (_, i) => cubic(bc, i / 6))), 'k-4', 'fill="none" stroke-width="1.6"');
      for (let i = 0; i < n; i++) {
        const q = cubic(bc, 0.25 + 0.75 * i / Math.max(1, n - 1));
        const off = add(q, mul(perp(dir(ang)), (i % 2 ? 1 : -1) * c.rr(4, 9)));
        poms += `<use href="#${c.id(c.rand() < 0.62 ? 'poma' : 'pomb')}" transform="${at(off, 0, c.rr(0.75, 1.15))}"/>`;
      }
    }
    return back + front + poms;
  };
  c.item([-300, 400], sprig([-300, 400], [-40, 190], [270, 160],
    [[0.42, -1, 80, 6], [0.5, 1, 70, 5], [0.6, -1, 90, 7], [0.7, 1, 76, 6], [0.8, -1, 70, 5], [0.9, 1, 54, 4], [0.98, -1, 40, 3]],
    [[0.35, 1, 170, 22], [0.5, -1, 150, 30], [0.66, 1, 140, 26]]));
  c.item([-300, 1030], sprig([-300, 1030], [-60, 830], [240, 830],
    [[0.45, 1, 76, 6], [0.56, -1, 84, 6], [0.68, 1, 70, 5], [0.8, -1, 66, 5], [0.93, 1, 48, 4]],
    [[0.4, -1, 160, 26], [0.56, 1, 150, 24], [0.72, -1, 130, 30]]));
  return c.svg('mimosa, two sprigs of fluffy pom-pom flowers among feathery bipinnate leaves, reaching in past the left edge');
};

// Citrine: a large point, a cluster on a druzy base, and one small loose point.
PIECES['yellow-2'] = () => {
  const c = canvas('yellow-2', 61);
  const point = (p, a, len, wid, tones, streaks) => g(at(p, a), prism(c, len, wid, { tones, streaks, angle: a }));
  c.item([-300, 200], point([-110, 330], -48, 250, 80, 'deep', 3) + point([-150, 250], -16, 400, 118, 'mid', 6));
  let cl = '';
  const base = [-70, 880];
  for (const [a, len, wid, tones] of [[-62, 150, 46, 'deep'], [-40, 230, 70, 'mid'], [-16, 260, 84, 'mid'], [8, 190, 60, 'light'], [28, 140, 44, 'mid'], [-28, 120, 38, 'light']]) {
    cl += point(add(base, mul(dir(a), 40)), a, len, wid, tones, 3);
  }
  const druzy = c.rad('dz', [0.6, 0.35, 0.7], [[0, '3'], [1, '5']]);
  let sp = '';
  for (let i = 0; i < 70; i++) {
    const q = add(base, [c.rr(-90, 70), c.rr(-50, 70)]);
    sp += `<circle cx="${fi(q[0])}" cy="${fi(q[1])}" r="${f1(c.rr(0.8, 2))}" class="${c.rand() < 0.4 ? 'f-hi' : 'f-2'}" opacity="${f1(c.rr(0.4, 0.9))}"/>`;
  }
  c.item([-300, 880], g(at(base), path(stoneOutline(c, 110, 80, 0.12), '', `fill="${druzy}"`)) + sp + cl);
  c.item([-300, 70], point([110, 80], -38, 100, 34, 'light', 1), { shadow: 0.2, blur: 5 });
  return c.svg('citrine, a large point, a cluster on a druzy base, and one small loose point, cut by the left edge');
};

// Sea holly: two branching stems of cone-shaped heads, each in a ruff of spiny bracts.
PIECES['blue-1'] = () => {
  const c = canvas('blue-1', 71);
  const teeth = u => 0.55 + 0.7 * Math.max(0, Math.sin(u * Math.PI * 7));
  const bract = blade(60, u => 5.5 * Math.sin(Math.PI * Math.min(u, 0.985)) ** 0.6 * (1 - 0.5 * u), { n: 26, wobble: teeth, bend: 0.05 });
  c.def(`<path id="${c.id('ba')}" d="${bract.a}"/><path id="${c.id('bb')}" d="${bract.b}"/>`);
  const cone = c.rad('cone', [0.62, 0.35, 0.7], [[0, '1'], [0.55, '3'], [1, '4']]);
  const bumps = c.once('bumps', () => `<pattern id="${c.id('bumps')}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="2.5" cy="2.5" r="1.4" class="f-hi" opacity=".5"/></pattern>`);
  const head = (p, a, s) => {
    let back = '', front = '';
    const n = 11;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * 360 + c.rr(-8, 8);
      // the ruff lies flat around the head, seen from the side: squash its depth
      const v = dir(ang), q = [v[0], v[1] * 0.42];
      const da = Math.atan2(q[1], q[0]) / D2R;
      const sc = (0.75 + 0.25 * Math.hypot(...q)) * c.rr(0.85, 1.1);
      const isBack = v[1] < 0;
      const u = `<g transform="${at(mul(q, 6), da, sc)}"><use href="#${c.id('ba')}" class="${isBack ? 'f-4' : 'f-2'}"/><use href="#${c.id('bb')}" class="${isBack ? 'f-5' : 'f-3'}"/></g>`;
      if (isBack) back += u; else front += u;
    }
    const h = `<ellipse cx="0" cy="-22" rx="14" ry="25" fill="${cone}"/><ellipse cx="0" cy="-22" rx="14" ry="25" fill="${bumps}"/>`;
    return g(at(p, a, s), back + h + front);
  };
  const plant = (from, ctrl, to, heads) => {
    const cv = quad(from, ctrl, to);
    let s = path(ribbon(cv, 3.4, 2.2), 'f-4'), hs = '';
    for (const [t, dx, dy, sc] of heads) {
      const p = cubic(cv, t), end = add(p, [dx, dy]);
      const bc = quad(p, add(lerp(p, end, 0.5), [-8, 6]), end);
      s += path(ribbon(bc, 2.2, 1.4, 8), 'f-4');
      const tg = cubicTan(bc, 1);
      hs += head(end, Math.atan2(tg[1], tg[0]) / D2R + 90, sc);
    }
    return s + hs + head(to, Math.atan2(cubicTan(cv, 1)[1], cubicTan(cv, 1)[0]) / D2R + 90, 1.25);
  };
  c.item([-300, 560], plant([-300, 560], [-80, 320], [150, 180], [[0.55, 60, -120, 1], [0.7, 120, 10, 0.95], [0.4, 20, -180, 0.85]]));
  c.item([-300, 1160], plant([-300, 1160], [-100, 920], [130, 830], [[0.6, 80, 60, 1], [0.5, 40, -80, 0.9]]));
  return c.svg('sea holly, two branching stems of cone-shaped heads, each in a ruff of spiny bracts, reaching in past the left edge');
};

// Lapis lazuli with sea glass: a polished slab veined with calcite and flecked
// with pyrite, and two frosted pebbles of sea glass.
PIECES['blue-2'] = () => {
  const c = canvas('blue-2', 83);
  {
    const d = stoneOutline(c, 170, 112, 0.05);
    c.def(`<clipPath id="${c.id('lap')}"><path d="${d}"/></clipPath>`);
    const fill = c.rad('lapf', [0.62, 0.32, 0.8], [[0, '3'], [0.55, '4'], [1, '5']]);
    let s = path(d, '', `fill="${fill}"`);
    let veins = '';
    for (let i = 0; i < 4; i++) {
      const y = c.rr(-80, 80);
      veins += path(open([[-180, y], [-80, y + c.rr(-30, 30)], [20, y + c.rr(-30, 30)], [100, y + c.rr(-30, 30)], [190, y + c.rr(-30, 30)]]), 'k-1', `fill="none" stroke-width="${f1(c.rr(4, 14))}" opacity="${f1(c.rr(0.35, 0.6) * 100) / 100}" filter="${c.soft(3)}"`);
    }
    // pyrite comes in drifts, not stars: clustered, small
    let fl = '';
    for (let k = 0; k < 4; k++) {
      const ctr = [c.rr(-120, 120), c.rr(-70, 70)];
      for (let i = 0; i < 12; i++) {
        const q = add(ctr, [c.rr(-30, 30), c.rr(-16, 16)]);
        fl += `<circle cx="${fi(q[0])}" cy="${fi(q[1])}" r="${f1(c.rr(0.5, 1.3))}"/>`;
      }
    }
    s += `<g clip-path="${c.url('lap')}">${veins}<g class="f-1" opacity=".7">${fl}</g></g>`;
    s += `<ellipse cx="70" cy="-60" rx="70" ry="22" transform="rotate(-18 70 -60)" class="f-hi" opacity=".3" filter="${c.soft(8)}"/>`;
    s += path(d, 'k-hi', 'fill="none" stroke-width="1.2" opacity=".22"');
    c.item([-300, 210], g(at([-20, 210], -10), s));
  }
  // the frosting: fine noise, kept only where the glass is, as pale grain
  c.def(`<filter id="${c.id('frost')}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1.4 -0.55"/><feComposite in2="SourceGraphic" operator="in"/></filter>`);
  const glass = (p, a, rx, ry, inner, outer) => {
    const d = stoneOutline(c, rx, ry, 0.08);
    // a worn edge: sea glass is milkier at its rim than through its middle
    const fill = c.rad(`gl${inner}`, [0.5, 0.5, 0.55], [[0, outer, 0.8], [0.7, inner, 0.88], [1, 'hi', 0.95]]);
    return g(at(p, a), path(d, '', `fill="${fill}"`) + path(d, 'f-hi', `filter="${c.url('frost')}" opacity=".3"`)
      + path(d, 'k-hi', `fill="none" stroke-width="5" opacity=".5" filter="${c.soft(2.5)}"`)
      + `<ellipse cx="${fi(rx * 0.25)}" cy="${fi(-ry * 0.3)}" rx="${fi(rx * 0.35)}" ry="${fi(ry * 0.18)}" transform="rotate(-12 ${fi(rx * 0.25)} ${fi(-ry * 0.3)})" class="f-hi" opacity=".5" filter="${c.soft(4)}"/>`);
  };
  c.item([-300, 950], glass([150, 945], 18, 48, 33, '1', '2'), { shadow: 0.12, blur: 6 });
  c.item([-300, 830], glass([30, 830], -12, 64, 42, '2', '3'), { shadow: 0.12, blur: 6 });
  return c.svg('lapis lazuli with sea glass: a polished slab veined with calcite and flecked with pyrite, and two frosted pebbles, cut by the left edge');
};

// Lavender: two loose bunches of stems, each ending in a spike of whorled buds.
PIECES['purple-1'] = () => {
  const c = canvas('purple-1', 97);
  // a whorl: buds around the stem, the far one darker; two of them to alternate
  for (const [k, tones] of [['a', ['f-4', 'f-2', 'f-3']], ['b', ['f-5', 'f-3', 'f-2']]]) {
    const bud = (x, y, a, cls) => `<ellipse cx="${x}" cy="${y}" rx="5.6" ry="3.4" transform="rotate(${a} ${x} ${y})" class="${cls}"/>`;
    c.def(`<g id="${c.id(`w${k}`)}">${bud(-1, -4.5, -42, tones[0])}${bud(-1, 4.5, 42, tones[1])}${bud(-2, -1.5, -14, tones[1])}${bud(1.5, 0.5, 6, tones[2])}<circle cx="3" cy="-1.4" r="1.1" class="f-hi" opacity=".6"/></g>`);
  }
  const bunch = (root, angles, lens) => {
    let stems = '', spikes = '';
    angles.forEach((a, i) => {
      const L = lens[i];
      const end = add(root, mul(dir(a), L));
      const cv = quad(root, add(root, mul(dir(a - 6), L * 0.55)), end);
      stems += `M${P(root)}${seg(Array.from({ length: 6 }, (_, j) => cubic(cv, j / 5)))}`.replace(/^M[^C]+/, `M${P(root)}`);
      // whorls spaced wide at the bottom of the spike, packed at the top
      const n = 17;
      for (let j = 0; j < n; j++) {
        const u = j / (n - 1);
        const t = 0.74 + 0.26 * (1 - (1 - u) ** 1.5);
        const p = cubic(cv, t), tg = cubicTan(cv, t);
        spikes += `<use href="#${c.id(j % 2 ? 'wa' : 'wb')}" transform="${at(p, Math.atan2(tg[1], tg[0]) / D2R, 1.45 - 0.7 * u)}"/>`;
      }
    });
    return path(stems, 'k-4', 'fill="none" stroke-width="1.7" stroke-linecap="round"') + spikes;
  };
  c.item([-300, 470], bunch([-300, 470], [-50, -42, -34, -27, -20, -13], [520, 560, 600, 580, 540, 500]));
  c.item([-300, 1080], bunch([-300, 1080], [-34, -26, -18, -10, -3], [500, 540, 560, 520, 480]));
  return c.svg('lavender, two loose bunches of stems from beyond the left edge, each ending in a spike of whorled buds');
};

// Amethyst geode: a broken half, its rind and agate band round a cavity of
// inward-pointing crystals, and one loose point.
PIECES['purple-2'] = () => {
  const c = canvas('purple-2', 101);
  const C = [-80, 250], RX = 260, RY = 200;
  const ring = (k, wob) => {
    const pts = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const w = 1 + wob[i % wob.length];
      pts.push([Math.cos(a) * RX * k * w, Math.sin(a) * RY * k * w]);
    }
    return closed(pts);
  };
  const wob = Array.from({ length: 20 }, () => c.rr(-0.05, 0.05));
  const rind = c.rad('rind', [0.62, 0.35, 0.75], [[0, '3'], [0.7, '4'], [1, '5']]);
  let s = path(ring(1, wob), '', `fill="${rind}"`);
  s += path(ring(0.9, wob), 'f-2') + path(ring(0.87, wob), 'f-hi', 'opacity=".55"') + path(ring(0.84, wob), 'f-3');
  const cav = c.rad('cav', [0.5, 0.5, 0.55], [[0, '5'], [1, '4']]);
  s += path(ring(0.8, wob), '', `fill="${cav}"`);
  // crystals, rim inward: big and pale at the rim, small and deep toward the centre
  let xs = '';
  for (let r = 0.76; r > 0.12; r -= 0.075) {
    const n = Math.round(30 * r + 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 360 + c.rr(-4, 4) + r * 40;
      const base = add([0, 0], [Math.cos(a * D2R) * RX * r, Math.sin(a * D2R) * RY * r]);
      if (C[0] + base[0] < -30) continue;
      const inward = norm(mul(base, -1));
      const size = (14 + 30 * r) * c.rr(0.8, 1.2);
      const tip = add(base, mul(inward, size * 1.15));
      const side = mul(perp(inward), size * 0.42);
      const l = add(base, side), rt = sub(base, side), m = add(base, mul(inward, size * 0.3));
      const depth = r > 0.55 ? 0 : r > 0.3 ? 1 : 2;
      const [hi, lo] = [['1', '3'], ['2', '4'], ['3', '5']][depth];
      const litLeft = lit(perp(inward)) > 0;
      xs += path(poly([l, tip, m]), `f-${litLeft ? hi : lo}`) + path(poly([rt, tip, m]), `f-${litLeft ? lo : hi}`);
    }
  }
  s += xs;
  c.item([-320, 250], g(at(C), s));
  // two loose points below, so the bottom answers the geode at the top
  c.item([-300, 860], g(at([40, 880], -26), prism(c, 170, 56, { tones: 'mid', streaks: 2, angle: -26 }))
    + g(at([20, 930], 4), prism(c, 130, 44, { tones: 'deep', streaks: 1, angle: 4 })), { shadow: 0.2, blur: 5 });
  return c.svg('amethyst geode, a broken half cut by the left edge: rind, agate band and a cavity of inward-pointing crystals, and one loose point');
};

// Peony: a full bloom in three rings of ruffled petals, a second smaller bloom and a bud, with lobed leaves.
PIECES['pink-1'] = () => {
  const c = canvas('pink-1', 113);
  const petalFill = k => k ? c.lin('pl', [0, 0, 1, 0], [[0, '3'], [0.5, '2'], [1, '1']]) : c.lin('pd', [0, 0, 1, 0], [[0, '4'], [0.55, '3'], [1, '2']]);
  // six ruffled petals, 100 long and 40 wide, scaled into place
  for (let k = 0; k < 6; k++) {
    // narrow at the base, broadest near the end, the end rounded and ruffled
    const p = blade(100, u => 40 * u ** 0.5 * Math.sqrt(Math.max(0, 1 - u ** 5)) * (1 - 0.15 * u), { n: 16, wobble: u => 1 + 0.1 * Math.sin(u * 30 + k * 1.7) * u * u });
    c.def(`<g id="${c.id(`pv${k}`)}"><path d="${p.out}"/>${path(p.rib, 'k-hi', 'fill="none" stroke-width="0.8" opacity=".3"')}</g>`);
  }
  const bloom = (C, R, tilt) => {
    const layers = [{ n: 7, len: R, wid: R * 0.42, off: 0 }, { n: 9, len: R * 0.74, wid: R * 0.32, off: 20 }, { n: 11, len: R * 0.46, wid: R * 0.22, off: 8 }];
    const backs = [], fronts = [];
    layers.forEach((L, li) => {
      for (let i = 0; i < L.n; i++) {
        const a = L.off + (i / L.n) * 360 + c.rr(-8, 8);
        const sx = L.len * c.rr(0.88, 1.08) / 100, sy = L.wid * c.rr(0.9, 1.1) / 40;
        const isLit = lit(dir(a)) > -0.2;
        const body = `<use href="#${c.id(`pv${Math.floor(c.rand() * 6)}`)}" fill="${petalFill(isLit)}" transform="rotate(${f1(a)}) scale(${f1(sx * 100) / 100} ${f1(sy * 100) / 100})"/>`;
        (Math.sin(a * D2R) < 0 || li === 2 ? backs : fronts).push([li, body]);
      }
    });
    // far petals first, outer to inner; the near ones of the outer rings overlap the heart
    const order = [...backs.sort((x, y) => x[0] - y[0]), ...fronts.sort((x, y) => y[0] - x[0])];
    const heart = c.rad('heart', [0.5, 0.5, 0.5], [[0, '4'], [1, '3', 0]]);
    return g(at(C, tilt, 1, 0.74), order.map(([, b]) => b).join('') + `<circle r="${fi(R * 0.18)}" fill="${heart}"/>`);
  };
  // a leaf is three leaflets, one drawn once and placed three times
  {
    const b = blade(100, u => 16 * Math.sin(Math.PI * Math.min(u, 0.97)) ** 0.7, { bend: 0.04, n: 12 });
    c.def(`<g id="${c.id('lt')}">${path(b.a, 'f-3')}${path(b.b, 'f-4')}${path(b.rib, 'k-2', 'fill="none" stroke-width="1" opacity=".5"')}</g>`);
  }
  const leaf = (p, a, L) => g(at(p, a), [[-28, 0.78], [0, 1], [28, 0.8]].map(([da, k]) => `<use href="#${c.id('lt')}" transform="rotate(${da}) scale(${f1(L * k) / 100})"/>`).join(''));
  const stem = (a, b, ctl, w) => path(ribbon(quad(a, ctl, b), w, w * 0.75), 'f-4');
  c.item([-300, 520],
    stem([-300, 520], [70, 200], [-60, 280], 5) + leaf([-60, 320], 14, 150) + leaf([10, 250], -64, 120) + bloom([72, 190], 138, -18));
  const bud = (p) => {
    const f = c.rad('bud', [0.62, 0.36, 0.62], [[0, '1'], [0.6, '3'], [1, '4']]);
    const sep = blade(34, u => 9 * Math.sin(Math.PI * Math.min(u, 0.97)) ** 0.6, { bend: 0.15 });
    return g(at(p), `<circle r="20" fill="${f}"/>` + g('translate(-6 14) rotate(-80)', path(sep.out, 'f-4')) + g('translate(4 16) rotate(-120)', path(sep.out, 'f-5')));
  };
  c.item([-300, 1150],
    stem([-300, 1150], [50, 830], [-70, 930], 4.6) + stem([-60, 920], [146, 738], [60, 790], 3) + leaf([-90, 970], 22, 140)
    + leaf([40, 800], -40, 80) + bud([148, 734]) + bloom([52, 840], 104, -6));
  return c.svg('peony, a full bloom in three rings of ruffled petals, a second smaller bloom and a bud on stems from beyond the left edge, with lobed leaves');
};

// Rose quartz: a raw faceted chunk and two tumbled pebbles, milky inside.
PIECES['pink-2'] = () => {
  const c = canvas('pink-2', 127);
  {
    const V = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * 360 + c.rr(-12, 12);
      return [Math.cos(a * D2R) * 175 * c.rr(0.8, 1.05), Math.sin(a * D2R) * 135 * c.rr(0.8, 1.05)];
    });
    const C = [40, -30];
    let s = '';
    const tones = ['4', '3', '3', '2', '1', 'hi'];
    for (let i = 0; i < V.length; i++) {
      const A = V[i], B = V[(i + 1) % V.length];
      const k = lit(sub(lerp(A, B, 0.5), C));
      s += path(poly([C, A, B]), `f-${tones[Math.max(0, Math.min(5, Math.round((k + 1) / 2 * 5)))]}`);
    }
    c.def(`<clipPath id="${c.id('chunk')}"><path d="${poly(V)}"/></clipPath>`);
    let cloud = '';
    for (let i = 0; i < 5; i++) cloud += `<ellipse cx="${fi(c.rr(-110, 90))}" cy="${fi(c.rr(-80, 80))}" rx="${fi(c.rr(30, 70))}" ry="${fi(c.rr(16, 40))}" class="f-hi" opacity="${f1(c.rr(0.2, 0.4) * 100) / 100}"/>`;
    s += `<g clip-path="${c.url('chunk')}"><g filter="${c.soft(10)}">${cloud}</g></g>`;
    let e = '';
    for (const v of V) e += `M${P(C)}L${P(v)}`;
    s += path(e, 'k-hi', 'fill="none" stroke-width="0.9" opacity=".3"') + path(poly(V), 'k-4', 'fill="none" stroke-width="1" opacity=".35" stroke-linejoin="round"');
    c.item([-320, 210], g(at([-40, 210], 8), s));
  }
  const tumbled = (p, a, rx, ry, k) => {
    const d = stoneOutline(c, rx, ry, 0.07);
    c.def(`<clipPath id="${c.id(`t${k}`)}"><path d="${d}"/></clipPath>`);
    const f = c.rad('tum', [0.6, 0.36, 0.72], [[0, '1'], [0.6, '2'], [1, '3']]);
    let cl = '';
    for (let i = 0; i < 3; i++) cl += `<ellipse cx="${fi(c.rr(-rx, rx) * 0.5)}" cy="${fi(c.rr(-ry, ry) * 0.5)}" rx="${fi(rx * c.rr(0.3, 0.55))}" ry="${fi(ry * c.rr(0.25, 0.45))}" class="f-hi" opacity=".35"/>`;
    return g(at(p, a), path(d, '', `fill="${f}"`) + `<g clip-path="${c.url(`t${k}`)}"><g filter="${c.soft(6)}">${cl}</g></g>`
      + `<ellipse cx="${fi(rx * 0.3)}" cy="${fi(-ry * 0.42)}" rx="${fi(rx * 0.3)}" ry="${fi(ry * 0.14)}" transform="rotate(-14 ${fi(rx * 0.3)} ${fi(-ry * 0.42)})" class="f-hi" opacity=".7" filter="${c.soft(2)}"/>`);
  };
  c.item([-300, 950], tumbled([150, 950], 14, 58, 44, 1), { shadow: 0.14, blur: 6 });
  c.item([-300, 830], tumbled([30, 830], -10, 76, 52, 2), { shadow: 0.14, blur: 6 });
  return c.svg('rose quartz, a raw faceted chunk and two tumbled pebbles, milky inside, cut by the left edge');
};

// Fern: three arching fronds of lobed pinnae, folded and lit from the right.
PIECES['brown-1'] = () => {
  const c = canvas('brown-1', 131);
  for (let k = 0; k < 4; k++) {
    const b = blade(100, u => 13 * Math.sin(Math.PI * Math.min(u, 0.98)) ** 0.6 * (1 - 0.5 * u), { n: 22, bend: 0.06 + k * 0.03, wobble: u => 0.62 + 0.38 * Math.abs(Math.sin(u * Math.PI * (7 + k))) });
    c.def(`<path id="${c.id(`pa${k}`)}" d="${b.a}"/><path id="${c.id(`pb${k}`)}" d="${b.b}"/>`);
  }
  const frond = (p0, p1, p2, size, n, tones) => {
    const cv = quad(p0, p1, p2);
    let s = '', lower = '';
    for (let i = 0; i < n; i++) {
      const t = 0.18 + 0.8 * (i / (n - 1));
      for (const side of [-1, 1]) {
        const tt = Math.min(0.99, t + (side > 0 ? 0.012 : 0));
        const p = cubic(cv, tt), tg = cubicTan(cv, tt);
        const u = Math.min(1, (tt - 0.18) / 0.8);
        const len = size * Math.max(0, Math.sin(Math.PI * (0.12 + 0.86 * u))) ** 0.7 * (1 - 0.55 * u) + 8;
        const theta = Math.atan2(tg[1], tg[0]) / D2R + side * (68 - 20 * u);
        const flip = Math.cos(theta * D2R) >= 0 ? 1 : -1;
        const v = Math.floor(c.rand() * 4);
        const [ta, tb] = side < 0 ? tones.upper : tones.lower;
        const u2 = g(at(p, theta, len / 100, flip * len / 100), `<use href="#${c.id(`pa${v}`)}" class="${flip > 0 ? ta : tb}"/><use href="#${c.id(`pb${v}`)}" class="${flip > 0 ? tb : ta}"/>`);
        if (side > 0) lower += u2; else s += u2;
      }
    }
    return lower + path(ribbon(cv, 3, 0.8, 18), tones.stem) + s;
  };
  // one big frond arching over the top; below, a small dark one lying low
  // behind the second, as two fronds of one plant would
  c.item([-280, 470], frond([-280, 470], [-20, 110], [300, 130], 105, 24, { upper: ['f-1', 'f-3'], lower: ['f-2', 'f-4'], stem: 'f-4' }));
  c.item([-300, 1090], frond([-300, 1090], [-60, 980], [230, 960], 70, 18, { upper: ['f-3', 'f-4'], lower: ['f-4', 'f-5'], stem: 'f-5' }), { shadow: 0.12 });
  c.item([-280, 1120], frond([-280, 1120], [-30, 800], [290, 820], 100, 23, { upper: ['f-2', 'f-3'], lower: ['f-3', 'f-4'], stem: 'f-4' }));
  return c.svg('fern, three arching fronds of lobed pinnae reaching in past the left edge');
};

// An owl feather with two oak leaves and an acorn.
PIECES['brown-2'] = () => {
  const c = canvas('brown-2', 137);
  {
    const L = 360, W = 74;
    const curve = u => 0.05 * L * u * u;
    const half = (side, w) => {
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const u = i / 20;
        const hw = w * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, u * 0.62 + 0.18)) ** 0.8) * Math.sqrt(Math.max(0, 1 - u ** 3));
        pts.push([u * L, curve(u) + side * hw]);
      }
      const rib = Array.from({ length: 21 }, (_, i) => [(1 - i / 20) * L, curve(1 - i / 20)]);
      return `M${P(pts[0])}${seg(pts)}L${P(rib[0])}${seg(rib)}Z`;
    };
    const top = half(-1, W * 0.62), bot = half(1, W);
    c.def(`<clipPath id="${c.id('vane')}"><path d="${top}${bot}"/></clipPath>`);
    const body = c.lin('fb', [0, 0, 1, 0], [[0, '3'], [0.5, '2'], [1, '2']]);
    const barbs = (key, a) => c.once(key, () => `<pattern id="${c.id(key)}" width="3" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(${a})"><path d="M1.5 0V40" class="k-hi" stroke-width="0.6" opacity=".4"/></pattern>`);
    let s = path(top, '', `fill="${body}"`) + path(bot, '', `fill="${body}"`) + path(top, '', `fill="${barbs('ft', 50)}"`) + path(bot, '', `fill="${barbs('fb2', -50)}"`);
    // soft wavy bars across the vane, and mottling
    let bars = '';
    for (let x = 40; x < L; x += 34) {
      const y0 = curve(x / L);
      bars += `M${P([x - 20, y0 - W])}Q${P([x + 6, y0 - W * 0.4])} ${P([x, y0])}T${P([x - 22, y0 + W])}`;
    }
    let mot = '';
    for (let i = 0; i < 40; i++) mot += `<circle cx="${fi(c.rr(20, L - 30))}" cy="${fi(c.rr(-W * 0.6, W))}" r="${f1(c.rr(2, 6))}"/>`;
    s += `<g clip-path="${c.url('vane')}">${path(bars, 'k-4', `fill="none" stroke-width="11" opacity=".5" filter="${c.soft(3)}"`)}<g class="f-4" opacity=".3" filter="${c.soft(2)}">${mot}</g></g>`;
    s += path(`${top}${bot}`, 'k-2', `fill="none" stroke-width="4" opacity=".5" filter="${c.soft(2)}"`);
    s += path(open(Array.from({ length: 11 }, (_, i) => [i / 10 * L * 0.97, curve(i / 10)])), 'k-1', 'fill="none" stroke-width="2.4" stroke-linecap="round"');
    c.item([-220, 200], g(at([-90, 210], -16), s));
  }
  const oak = (p, a, L, tones) => {
    const lobes = u => 0.5 + 0.5 * Math.abs(Math.cos(u * Math.PI * 4.5)) ** 0.7;
    const b = blade(L, u => L * 0.22 * Math.sin(Math.PI * Math.min(u, 0.98) ** 0.8) ** 0.7, { n: 36, wobble: lobes, bend: 0.05 });
    let veins = '';
    for (let i = 1; i <= 4; i++) {
      const u = i / 4.5 - 0.02;
      for (const sgn of [-1, 1]) veins += `M${P([u * L * 0.86, 0.05 * L * u * u])}L${P([u * L + 0.08 * L, sgn * L * 0.2 * Math.sin(Math.PI * u) ** 0.7])}`;
    }
    return g(at(p, a), path(b.a, tones[0]) + path(b.b, tones[1]) + path(b.rib + veins, 'k-hi', 'fill="none" stroke-width="1.1" opacity=".35"'));
  };
  // an oak leaf under the feather at the top, the other with the acorns below
  c.item([-300, 360], oak([-40, 340], -6, 230, ['f-2', 'f-3']) + path(ribbon(quad([-300, 380], [-160, 360], [-40, 340]), 2.6, 2), 'f-4'));
  const acorn = (p, a) => {
    const nut = c.rad('nut', [0.6, 0.35, 0.65], [[0, '1'], [0.6, '3'], [1, '4']]);
    const cup = c.rad('cup', [0.6, 0.3, 0.7], [[0, '3'], [1, '5']]);
    const scales = c.once('scl', () => `<pattern id="${c.id('scl')}" width="6" height="5" patternUnits="userSpaceOnUse"><path d="M0 5Q3 0 6 5" class="k-5" fill="none" stroke-width="1" opacity=".55"/></pattern>`);
    return g(at(p, a), `<path d="M-20 -6Q-22 34 0 42Q22 34 20 -6Z" fill="${nut}"/><circle cx="0" cy="44" r="2.5" class="f-4"/>`
      + `<path d="M-25 -2Q-26 -24 0 -26Q26 -24 25 -2Q0 6 -25 -2Z" fill="${cup}"/><path d="M-25 -2Q-26 -24 0 -26Q26 -24 25 -2Q0 6 -25 -2Z" fill="${scales}"/>`
      + `<path d="M0 -26Q2 -36 8 -40" class="k-4" fill="none" stroke-width="3" stroke-linecap="round"/>`
      + `<ellipse cx="8" cy="12" rx="5" ry="13" class="f-hi" opacity=".45" filter="${c.soft(2)}"/>`);
  };
  c.item([-300, 770], oak([-60, 790], 12, 190, ['f-3', 'f-4']) + acorn([150, 750], -28) + acorn([112, 790], 14), { shadow: 0.15 });
  return c.svg('an owl feather with two oak leaves and a pair of acorns, cut by the left edge');
};

// Magnolia: two cupped blooms and a furred bud on a dark branch with glossy leaves.
PIECES['white-1'] = () => {
  const c = canvas('white-1', 149);
  for (let k = 0; k < 4; k++) {
    const b = blade(100, u => 34 * u ** 0.45 * Math.sqrt(Math.max(0, 1 - u ** 4)) * (1 + 0.04 * k), { n: 14, bend: -0.04 + k * 0.03 });
    c.def(`<g id="${c.id(`mp${k}`)}"><path d="${b.out}"/>${path(b.rib, 'k-2', 'fill="none" stroke-width="0.8" opacity=".25"')}</g>`);
  }
  const back = c.lin('mb', [0, 0, 1, 0], [[0, '3'], [0.5, '2'], [1, '1']]);
  const front = c.lin('mf', [0, 0, 1, 0], [[0, '2'], [0.45, '1'], [1, 'hi']]);
  const bloom = (p, a, R) => {
    let s = '';
    // the far petals open wide behind, the near ones stand up in front
    const petals = [[-160, 1, back], [-118, 1.06, back], [-62, 1.05, back], [-22, 0.98, back], [-140, 0.86, front], [-92, 0.9, front], [-44, 0.88, front]];
    petals.forEach(([ang, len, f], i) => {
      // the receptacle sits between the far petals and the near ones
      if (i === 4) s += `<ellipse cx="0" cy="-4" rx="${fi(R * 0.12)}" ry="${fi(R * 0.07)}" class="f-3"/>`;
      s += `<use href="#${c.id(`mp${Math.floor(c.rand() * 4)}`)}" fill="${f}" transform="rotate(${f1(ang + c.rr(-5, 5))}) scale(${f1(R * len / 100 * 100) / 100})"/>`;
    });
    return g(at(p, a), s);
  };
  const leaf = (p, a, L) => {
    const b = blade(L, u => L * 0.2 * Math.sin(Math.PI * Math.min(u, 0.97)) ** 0.75, { bend: 0.05 });
    return g(at(p, a), path(b.a, 'f-3') + path(b.b, 'f-4') + path(b.rib, 'k-2', 'fill="none" stroke-width="1.2" opacity=".5"')
      + `<ellipse cx="${fi(L * 0.5)}" cy="${fi(-L * 0.07)}" rx="${fi(L * 0.3)}" ry="${fi(L * 0.04)}" class="f-hi" opacity=".3" filter="${c.soft(3)}"/>`);
  };
  const bud = (p, a) => {
    const f = c.rad('bud', [0.6, 0.35, 0.65], [[0, '2'], [1, '4']]);
    let hair = '';
    for (let i = 0; i < 30; i++) {
      const t = c.rr(-1, 1);
      hair += `M${P([t * 10, c.rr(-26, 10)])}l${P([c.rr(-2, 3), c.rr(-4, -1)])}`;
    }
    return g(at(p, a), `<ellipse cx="0" cy="-10" rx="12" ry="24" fill="${f}"/>${path(hair, 'k-hi', 'fill="none" stroke-width="0.7" opacity=".45"')}`);
  };
  const branch = cv => path(ribbon(cv, 7, 2.6, 16), 'f-5') + path(open(Array.from({ length: 9 }, (_, i) => add(cubic(cv, i / 8), [0.6, -1.6]))), 'k-3', 'fill="none" stroke-width="1.4" opacity=".5"');
  // a bloom with its leaves held up along the top; the second, with its bud,
  // low, the leaf swung down under it rather than up into the middle
  const b1 = quad([-300, 440], [-60, 300], [90, 200]);
  c.item([-300, 440], branch(b1) + leaf(cubic(b1, 0.5), -10, 150) + leaf(cubic(b1, 0.7), -80, 110) + bloom([96, 200], -18, 128));
  const b2 = quad([-300, 1110], [-40, 960], [70, 870]);
  c.item([-300, 1110], branch(b2) + leaf(cubic(b2, 0.6), 34, 140) + bud([176, 770], 30) + path(ribbon(quad(cubic(b2, 0.82), [136, 840], [168, 792]), 3, 2), 'f-5') + bloom([74, 870], -8, 104));
  return c.svg('magnolia, two cupped blooms and a furred bud on dark branches with glossy leaves, reaching in past the left edge');
};

// Clear quartz: two clusters of points and one loose point.
PIECES['white-2'] = () => {
  const c = canvas('white-2', 151);
  const cluster = (base, spec) => spec.map(([a, len, wid, tones]) => g(at(add(base, mul(dir(a), 30)), a), prism(c, len, wid, { tones, streaks: 3, angle: a }))).join('');
  // the big cluster fans down from the top, the small one up from the bottom
  // with its loose point beside it
  c.item([-300, 200], cluster([-110, 200], [[-40, 180, 50, 'mid'], [-18, 300, 78, 'light'], [6, 340, 90, 'light'], [28, 260, 70, 'mid'], [46, 180, 56, 'light'], [-6, 160, 40, 'deep'], [-62, 140, 40, 'mid']]));
  c.item([-300, 840], cluster([-90, 840], [[-50, 200, 60, 'light'], [-24, 250, 70, 'mid'], [0, 200, 56, 'light'], [22, 150, 44, 'mid'], [-70, 130, 40, 'deep']]));
  c.item([-300, 890], g(at([180, 895], -14), prism(c, 110, 36, { tones: 'light', streaks: 1, angle: -14 })), { shadow: 0.18, blur: 5 });
  return c.svg('clear quartz, two clusters of points and one loose point, cut by the left edge');
};

// Silver-dollar eucalyptus: three arching stems of round, powdery leaves.
PIECES['grey-1'] = () => {
  const c = canvas('grey-1', 163);
  for (let k = 0; k < 3; k++) {
    const b = blade(100, u => 50 * Math.sin(Math.PI * Math.min(u, 0.985)) ** (0.75 + k * 0.1) * (1 - 0.1 * u), { n: 18, bend: 0.03 * k });
    c.def(`<g id="${c.id(`e${k}`)}"><path d="${b.out}"/>${path(b.rib, 'k-hi', 'fill="none" stroke-width="1" opacity=".35"')}</g>`);
  }
  const pale = c.rad('ep', [0.62, 0.35, 0.7], [[0, '1'], [0.7, '2'], [1, '3']]);
  const deep = c.rad('ed', [0.62, 0.35, 0.7], [[0, '2'], [0.7, '3'], [1, '4']]);
  const stem = (p0, p1, p2, n, size) => {
    const cv = quad(p0, p1, p2);
    let leaves = '';
    for (let i = 0; i < n; i++) {
      const t = 0.3 + 0.68 * i / (n - 1);
      const side = i % 2 ? 1 : -1;
      const p = cubic(cv, t), tg = cubicTan(cv, t);
      const L = size * (1 - 0.45 * (i / n)) * c.rr(0.9, 1.1);
      const a = Math.atan2(tg[1], tg[0]) / D2R + side * c.rr(40, 70);
      const q = add(p, mul(dir(a), 6));
      // turned a little away or toward: a coin seen at an angle
      const sy = c.rr(0.6, 1);
      leaves += path(`M${P(p)}L${P(q)}`, 'k-3', 'fill="none" stroke-width="1.6"');
      leaves += `<use href="#${c.id(`e${i % 3}`)}" fill="${c.rand() < 0.55 ? pale : deep}" transform="${at(q, a, L / 100, sy * L / 100)}"/>`;
    }
    return path(ribbon(cv, 2.4, 1, 14), 'f-4') + leaves;
  };
  // one stem arching over the top; two at the bottom, the shorter one
  // drooping under the other
  c.item([-300, 400], stem([-300, 400], [-40, 120], [260, 130], 13, 70));
  c.item([-300, 1020], stem([-300, 1020], [-40, 900], [220, 885], 9, 58), { shadow: 0.12 });
  c.item([-300, 1000], stem([-300, 1000], [-40, 740], [250, 730], 12, 66));
  return c.svg('silver-dollar eucalyptus, three arching stems of round powdery leaves reaching in past the left edge');
};

// River stones: three smooth flat stones, one banded with quartz, one speckled.
PIECES['grey-2'] = () => {
  const c = canvas('grey-2', 173);
  const stone = (p, a, rx, ry, k, kind) => {
    const d = stoneOutline(c, rx, ry, 0.06);
    c.def(`<clipPath id="${c.id(`c${k}`)}"><path d="${d}"/></clipPath>`);
    const f = c.rad(`r${k}`, [0.6, 0.34, 0.75], kind === 'dark' ? [[0, '3'], [0.7, '4'], [1, '5']] : [[0, '1'], [0.65, '2'], [1, '4']]);
    let inner = '';
    if (kind === 'band') inner = path(`M${-rx * 1.2} ${ry * 0.1}C${-rx * 0.4} ${-ry * 0.5} ${rx * 0.3} ${ry * 0.6} ${rx * 1.2} ${-ry * 0.2}`, 'k-hi', `fill="none" stroke-width="${fi(ry * 0.3)}" opacity=".5" filter="${c.soft(3)}"`);
    if (kind === 'speck') for (let i = 0; i < 60; i++) inner += `<circle cx="${fi(c.rr(-rx, rx))}" cy="${fi(c.rr(-ry, ry))}" r="${f1(c.rr(0.6, 1.8))}" class="${c.rand() < 0.5 ? 'f-4' : 'f-hi'}" opacity=".6"/>`;
    return g(at(p, a), path(d, '', `fill="${f}"`) + `<g clip-path="${c.url(`c${k}`)}">${inner}</g>`
      + `<ellipse cx="${fi(rx * 0.28)}" cy="${fi(-ry * 0.4)}" rx="${fi(rx * 0.42)}" ry="${fi(ry * 0.2)}" class="f-hi" opacity=".3" filter="${c.soft(6)}"/>`);
  };
  // the banded stone with the small dark one tucked under it at the top, the
  // speckled one alone at the bottom
  c.item([-300, 200], stone([-10, 200], -8, 160, 92, 1, 'band'));
  c.item([-300, 330], stone([150, 320], 14, 66, 40, 2, 'dark'), { shadow: 0.16, blur: 6 });
  c.item([-300, 780], stone([20, 780], -14, 110, 64, 3, 'speck'));
  return c.svg('river stones, three smooth flat stones, one banded with quartz and one speckled, cut by the left edge');
};

// Hellebores: two nodding flowers on arching stems, and a palmate leaf.
PIECES['black-1'] = () => {
  const c = canvas('black-1', 181);
  const sep = blade(100, u => 52 * u ** 0.5 * Math.sqrt(Math.max(0, 1 - u ** 3)), { n: 16 });
  c.def(`<g id="${c.id('sep')}"><path d="${sep.out}"/>${path(sep.rib, 'k-2', 'fill="none" stroke-width="1" opacity=".35"')}</g>`);
  const sf = c.rad('sf', [0, 0.5, 1], [[0, '5'], [0.6, '4'], [0.92, '3'], [1, '2']]);
  const flower = (p, a, R) => {
    let s = '';
    for (let i = 0; i < 5; i++) {
      const ang = -90 + i * 72 + c.rr(-6, 6);
      s += `<use href="#${c.id('sep')}" fill="${sf}" transform="rotate(${f1(ang)}) scale(${f1(R / 100 * 100) / 100})"/>`;
    }
    let st = '', heads = '';
    for (let i = 0; i < 26; i++) {
      const ang = i * 360 / 26 + c.rr(-5, 5), r = R * c.rr(0.2, 0.3);
      const e = mul(dir(ang), r);
      st += `M${P(mul(dir(ang), R * 0.08))}L${P(e)}`;
      heads += `<circle cx="${f1(e[0])}" cy="${f1(e[1])}" r="1.7"/>`;
    }
    s += `<circle r="${fi(R * 0.12)}" class="f-3"/>` + path(st, 'k-2', 'fill="none" stroke-width="1"') + `<g class="f-hi">${heads}</g>`;
    // nodding: the face turned down and away, seen foreshortened
    return g(at(p, a, 1, 0.66), s);
  };
  // the leaves: broad, leathery and plain, so nothing reads as another plant's
  const leaf = (p, a, L) => {
    const b = blade(L, u => L * 0.17 * Math.sin(Math.PI * Math.min(u, 0.98)) ** 0.7, { bend: 0.06 });
    return g(at(p, a), path(b.a, 'f-3') + path(b.b, 'f-4') + path(b.rib, 'k-2', 'fill="none" stroke-width="1.1" opacity=".45"'));
  };
  const stem = (a, ctl, b) => path(ribbon(quad(a, ctl, b), 3.6, 2.2), 'f-4');
  // each flower nods over leaves of its own, one pair at the top, one below
  c.item([-300, 400], leaf([-60, 300], -10, 190) + leaf([-50, 330], 20, 140) + stem([-300, 400], [-10, 60], [110, 200]) + flower([116, 220], 28, 84));
  c.item([-300, 1010], leaf([-70, 890], -4, 170) + stem([-300, 1010], [-20, 650], [90, 780]) + flower([94, 800], 14, 72));
  return c.svg('hellebores, two nodding flowers on arching stems and a palmate leaf, reaching in past the left edge');
};

// Obsidian and black tourmaline: a striated tourmaline cluster, a glassy
// obsidian chunk with conchoidal ripples, and one small loose crystal.
PIECES['black-2'] = () => {
  const c = canvas('black-2', 191);
  const tourmaline = (p, a, len, wid) => {
    let s = prism(c, len, wid, { tip: 0.08, tones: 'deep', lines: true, angle: a });
    let st = '';
    for (let i = 0; i < 9; i++) {
      const y = (-0.45 + 0.9 * i / 8) * wid;
      st += `M${f1(len * c.rr(0, 0.08))} ${f1(y)}L${f1(len * c.rr(0.8, 0.9))} ${f1(y)}`;
    }
    s += path(st, 'k-hi', 'fill="none" stroke-width="0.6" opacity=".18"');
    return g(at(p, a), s);
  };
  const base = [-90, 210];
  let cl = '';
  for (const [a, len, wid] of [[-50, 260, 46], [-28, 340, 58], [-8, 300, 52], [14, 220, 40]]) cl += tourmaline(add(base, mul(dir(a), 20)), a, len, wid);
  c.item([-300, 210], cl);
  {
    const d = stoneOutline(c, 120, 86, 0.16, 9);
    c.def(`<clipPath id="${c.id('ob')}"><path d="${d}"/></clipPath>`);
    const f = c.rad('obf', [0.62, 0.32, 0.75], [[0, '3'], [0.5, '4'], [1, '5']]);
    let rip = '';
    for (let i = 1; i <= 5; i++) rip += `<ellipse cx="-40" cy="30" rx="${i * 26}" ry="${i * 18}" transform="rotate(-20 -40 30)"/>`;
    const s = path(d, '', `fill="${f}"`) + `<g clip-path="${c.url('ob')}"><g class="k-hi" fill="none" stroke-width="1.4" opacity=".16">${rip}</g></g>`
      + path('M20 -62C60 -60 92 -38 104 -6C82 -30 56 -46 20 -62Z', 'f-hi', 'opacity=".55"')
      + `<ellipse cx="44" cy="-30" rx="38" ry="10" transform="rotate(24 44 -30)" class="f-hi" opacity=".22" filter="${c.soft(4)}"/>`;
    c.item([-300, 790], g(at([30, 790], -6), s));
  }
  c.item([-300, 880], tourmaline([190, 890], -30, 120, 26), { shadow: 0.2, blur: 5 });
  return c.svg('obsidian and black tourmaline: a striated tourmaline cluster, a glassy obsidian chunk with conchoidal ripples, and one small loose crystal, cut by the left edge');
};

// ---- writing --------------------------------------------------------------

async function main(names) {
  const want = names.length ? names : Object.keys(PIECES);
  for (const name of want) {
    if (!PIECES[name]) throw new Error(`no piece ${name}`);
    const svg = PIECES[name]();
    if (svg.length > 45 * 1024) throw new Error(`${name}: ${svg.length} bytes, over 45 KB`);
    await writeFile(join(ROOT, 'web/assets/img/wallpaper', `${name}.svg`), svg);
    console.log(`${name}.svg ${(svg.length / 1024).toFixed(1)} KB`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
