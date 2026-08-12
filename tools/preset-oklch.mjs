// Where the four presets actually sit in OKLCh.
//
// ui/pigments.js builds a palette out of photographs to the same rule the
// presets were built on, and "the same rule" has to mean numbers off the real
// thing rather than numbers that sound about right. This reads tokens.css,
// converts every literal pigment in it, and prints the range and mean per token
// - which is where the SHEET and PIGMENT tables in that file come from.
//
// Run: node tools/preset-oklch.mjs

import { readFileSync } from 'node:fs';
import { oklch } from '../web/assets/js/ui/pigments.ts';

const css = readFileSync(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');

// Palette blocks only. The base :root block is Papyrus and counts as a preset;
// the whimsy blocks are not palettes and their tokens are mostly not colours.
const blocks = [['papyrus', css.slice(css.indexOf(':root {'), css.indexOf('/* ====', css.indexOf(':root {')))]];
for (const m of css.matchAll(/:root\[data-palette="([a-z-]+)"\]\s*\{([^}]*)\}/g)) {
  blocks.push([m[1], m[2]]);
}

const TOKENS = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3', '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--leafy',
];

const seen = new Map(TOKENS.map(t => [t, []]));
const hueOf = new Map();

for (const [name, body] of blocks) {
  const hues = {};
  for (const token of TOKENS) {
    const m = body.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i'));
    if (!m) continue;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(m[1].slice(i, i + 2), 16));
    const c = oklch(r, g, b);
    seen.get(token).push(c);
    hues[token] = c.h;
  }
  hueOf.set(name, hues);
}

const f = (n, d = 3) => n.toFixed(d).padStart(d + 3);
console.log('token'.padEnd(14), 'L min  mean   max  |  C min  mean   max  | n');
for (const token of TOKENS) {
  const xs = seen.get(token);
  if (!xs.length) continue;
  const L = xs.map(x => x.L), C = xs.map(x => x.C);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(
    token.padEnd(14),
    f(Math.min(...L)), f(mean(L)), f(Math.max(...L)), ' | ',
    f(Math.min(...C)), f(mean(C)), f(Math.max(...C)), ' |', xs.length,
  );
}

// How far each token's hue sits from its palette's --accent, which is what the
// dh offsets in PIGMENT encode.
const turn = (a, b) => { const d = (b - a + 540) % 360 - 180; return d; };
console.log('\nhue offset from --accent, per palette');
for (const [name, hues] of hueOf) {
  const base = hues['--accent'];
  console.log(
    name.padEnd(10),
    ['--accent-warm', '--accent-deep', '--leafy', '--paper', '--ink']
      .map(t => `${t.replace('--', '')} ${turn(base, hues[t]).toFixed(0).padStart(4)}`)
      .join('  '),
  );
}
