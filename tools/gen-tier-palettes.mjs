// Print the hand-written palettes dressed for Softish (pastel) and Harsh
// (bold). ONE-SHOT — output was pasted into tokens.css and hand-tuned since.
// Rerun to start a tier over or after adding a palette; never as a build step.

import { readFileSync } from 'node:fs';
import {
  PASTEL_DYE, PASTEL_PAPER_DROP,
  bolden, boldDeep, boldSecond, contrast, counterTurn, hex, oklch, pastel, pastelInk,
  toGround, NEUTRAL_C,
} from '../web/assets/js/ui/pigments.ts';
import { mixHex } from '../web/assets/js/color.ts';

const all = readFileSync(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
// Stop before the @supports-not legacy block to avoid reading palettes twice.
const css = all.slice(0, all.indexOf('@supports not (color: color-mix(in srgb, red, blue))'));

// Papyrus (base :root) gets the bare selector with no palette attribute.
const looks = [[null, css.slice(css.indexOf(':root {'), css.indexOf('/* ====', css.indexOf(':root {')))]];
for (const m of css.matchAll(/:root\[data-palette="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) {
  looks.push([m[1], m[2]]);
}

const PAPERS = ['--paper', '--paper-2', '--paper-3', '--paper-card', '--rule', '--rule-2'];
const INKS = ['--ink', '--ink-2', '--ink-3'];
// Print order, which is tokens.css's own: sheet, then print, then pigment.
const ORDER = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3', '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--leafy',
  '--accent-fg', '--accent-text',
];

/** Every literal pigment a block declares, in OKLCh. Mixes are skipped. */
function pigments(body) {
  const out = {};
  for (const token of ORDER) {
    const m = body.match(new RegExp(`${token}:\\s*(#[0-9a-f]{3,6})\\b`, 'i'));
    if (!m || m[1].length !== 7) continue;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(m[1].slice(i, i + 2), 16));
    out[token] = oklch(r, g, b);
  }
  return out;
}

/** Derive --accent-deep by preserving each palette's own accent-to-deep spacing. */
const twin = (dressed, accent, deep) => ({
  L: dressed.L - (accent.L - deep.L),
  C: dressed.C * (accent.C ? deep.C / accent.C : 1),
});

const selector = (tier, name) =>
  `:root[data-whimsy="${tier}"]${name ? `[data-palette="${name}"]` : ''}`;

function emit(tier, name, vars) {
  const w = Math.max(...Object.keys(vars).map(k => k.length)) + 2;
  console.log(`${selector(tier, name)} {`);
  for (const token of ORDER) {
    if (vars[token]) console.log(`  ${(token + ':').padEnd(w)}${vars[token]};`);
  }
  console.log('}\n');
}

// ---------------------------------------------------------------------------
// Tier 0: chalk. Paper takes the dye too — no live derivation at this end.
// ---------------------------------------------------------------------------

for (const [name, body] of looks) {
  const p = pigments(body);
  const vars = {};
  for (const token of PAPERS) {
    if (!p[token]) continue;
    vars[token] = hex(p[token].L - PASTEL_PAPER_DROP, p[token].C * PASTEL_DYE, p[token].h);
  }
  for (const token of INKS) {
    if (!p[token]) continue;
    const t = pastelInk(p[token], token);
    vars[token] = hex(t.L, t.C, p[token].h);
  }
  for (const token of ['--accent', '--accent-warm', '--leafy']) {
    if (!p[token]) continue;
    const t = pastel(p[token]);
    vars[token] = hex(t.L, t.C, p[token].h);
  }
  if (p['--accent'] && p['--accent-deep']) {
    const t = twin(pastel(p['--accent']), p['--accent'], p['--accent-deep']);
    vars['--accent-deep'] = hex(t.L, t.C, p['--accent-deep'].h);
  }
  // Pastel accent is too light for a label — use the ink instead.
  vars['--accent-fg'] = 'var(--ink)';
  emit(0, name, vars);
}

// ---------------------------------------------------------------------------
// Tier 2: poster. Quartet only — the sheet derives from var(--accent) via
// color-mix, so a boldened accent reaches paper/ink/rules on its own.
// Accent goes to the cusp; --accent-text walks it down for readability.
// ---------------------------------------------------------------------------

const harsh = css.slice(css.indexOf(':root[data-whimsy="2"]'));
const STOCK = harsh.match(/--stock:\s*(#[0-9a-f]{6})/i)[1];
const PAPER_MIX = 0.04;   // `--paper: color-mix(in srgb, var(--accent) 4%, var(--stock))`

for (const [name, body] of looks) {
  const p = pigments(body);
  const vars = {};
  let accent = null;
  if (p['--accent']) {
    const { h } = p['--accent'];
    // Accent at cusp; text form walked down until readable on the sheet.
    accent = bolden(p['--accent'], h);
    vars['--accent'] = hex(accent.L, accent.C, h);
    const paper = mixHex(STOCK, vars['--accent'], PAPER_MIX);
    const text = toGround(accent, h, paper);
    vars['--accent-text'] = hex(text.L, text.C, h);
  }
  // Dominant sheet hue takes the deep register only if the sheet has enough
  // chroma (NEUTRAL_C) — near-neutral sheets produce wrong colours there.
  const sheet = p['--paper'];
  const deepH = accent && sheet && sheet.C >= NEUTRAL_C
    ? counterTurn(sheet.h, p['--accent'].h) : null;
  if (p['--leafy']) {
    const t = deepH == null ? boldSecond() : boldDeep();
    vars['--leafy'] = hex(t.L, t.C, deepH ?? p['--leafy'].h);
  }
  if (p['--accent-warm']) {
    const t = boldSecond();
    // Displaced third hue, if any.
    vars['--accent-warm'] = hex(t.L, t.C,
      deepH == null || !p['--leafy'] ? p['--accent-warm'].h : p['--leafy'].h);
  }
  if (accent && p['--accent-deep']) {
    const t = twin(accent, p['--accent'], p['--accent-deep']);
    vars['--accent-deep'] = hex(t.L, t.C, p['--accent-deep'].h);
  }
  // Use ink as label when white no longer reads on the bold accent.
  if (vars['--accent'] && contrast(vars['--accent'], '#ffffff') < 4.5) {
    vars['--accent-fg'] = 'var(--ink)';
  }
  emit(2, name, vars);
}
