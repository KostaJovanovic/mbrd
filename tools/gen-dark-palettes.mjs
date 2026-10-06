// Print the four palettes' dark twins at all three tiers: tokens.css section
// 3c. ONE-SHOT, like gen-tier-palettes.mjs - the output is pasted by hand and
// may be tuned since, and tests/dark.test.js checks the floors, not the bytes.
// The transform is darkSheet() in ui/pigments.ts, which Dynamic also wears.

import { readFileSync } from 'node:fs';
import { darkSheet } from '../web/assets/js/ui/pigments.ts';
import { mixHex } from '../web/assets/js/color.ts';

const all = readFileSync(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
const css = all.slice(0, all.indexOf('@supports not (color: color-mix(in srgb, red, blue))'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

const ORDER = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3', '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--leafy',
  '--accent-fg', '--accent-text',
];

/** The literal #rrggbb pigments a selector's last top-level block declares (3b follows 3). */
function literals(selector) {
  const at = css.lastIndexOf(`\n${selector} {`);
  if (at < 0) return {};
  const body = css.slice(at, css.indexOf('\n}', at));
  const out = {};
  for (const token of ORDER) {
    const m = body.match(new RegExp(`\\s${token}:\\s*(#[0-9a-f]{6})\\b`, 'i'));
    if (m) out[token] = m[1].toLowerCase();
  }
  return out;
}

/** Harsh's sheet, worked out of its accent as the [data-whimsy="2"] block mixes it. */
function harshSheet(accent) {
  const stock = css.match(/--stock:\s*(#[0-9a-f]{6})/i)[1];
  const paper = mixHex(stock, accent, 0.04);
  const ink = mixHex('#000000', accent, 0.13);
  return {
    '--paper': paper,
    '--paper-2': mixHex(paper, ink, 0.04),
    '--paper-3': mixHex(paper, ink, 0.09),
    '--paper-card': '#ffffff',
    '--ink': ink,
    '--ink-2': mixHex(paper, ink, 0.74),
    '--ink-3': mixHex(paper, ink, 0.52),
    '--rule': mixHex(paper, ink, 0.13),
    '--rule-2': ink,
  };
}

const PALETTES = [null, ...[...css.matchAll(/:root\[data-palette="([a-z0-9-]+)"\]\s*\{/g)].map(m => m[1])];

const scheme = ':root[data-scheme="dark"]';
const selector = (tier, name) =>
  `${scheme}${tier === 1 ? '' : `[data-whimsy="${tier}"]`}${name ? `[data-palette="${name}"]` : ''}`;

for (const tier of [1, 0, 2]) {
  for (const name of PALETTES) {
    const middle = literals(':root');
    if (name) Object.assign(middle, literals(`:root[data-palette="${name}"]`));
    const dressed = tier === 1 ? {}
      : literals(`:root[data-whimsy="${tier}"]${name ? `[data-palette="${name}"]` : ''}`);
    let light = { ...middle, ...dressed };
    if (tier === 2) light = { ...light, ...harshSheet(light['--accent']) };
    // Both labels are worked out afresh in the dark, so any value asks for them.
    light['--accent-fg'] = '#ffffff';
    light['--accent-text'] = light['--accent'];
    const dark = darkSheet(light, tier);
    const w = Math.max(...Object.keys(dark).map(k => k.length)) + 2;
    console.log(`${selector(tier, name)} {`);
    for (const token of ORDER) if (dark[token]) console.log(`  ${(token + ':').padEnd(w)}${dark[token]};`);
    console.log('}\n');
  }
}
