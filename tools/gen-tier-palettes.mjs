// The presets, dressed for the two ends of the whimsy axis.
//
// ui/pigments.js dresses an *extracted* palette per tier - pastel() at Softish,
// bolden() at Harsh, the tables untouched in the middle. The four palettes
// written by hand in tokens.css get no such pass, because nothing measures
// them: they are literals. This prints what those same two transforms make of
// each literal, so the CSS starting point and the extraction agree about what
// each end of the axis means.
//
// A ONE-SHOT PRINTER, NOT A BUILD STEP. Its output was pasted into tokens.css
// section 3b once and has been hand-tuned there since - the numbers below are
// a place to start an eye from, not an answer. Running this again and pasting
// again would overwrite that tuning, which is why it writes nothing itself and
// why doing so has to stay a deliberate act. Rerun it to start a tier over, or
// after a new palette is added upstairs; never as part of a build.
//
// Run: node tools/gen-tier-palettes.mjs
//
// Sits beside tools/preset-oklch.mjs and reads tokens.css the same way.

import { readFileSync } from 'node:fs';
import {
  PASTEL_DYE, PASTEL_PAPER_DROP,
  bolden, boldDeep, boldSecond, contrast, counterTurn, hex, oklch, pastel, pastelInk,
  toGround, NEUTRAL_C,
} from '../web/assets/js/ui/pigments.ts';
import { mixHex } from '../web/assets/js/color.ts';

const all = readFileSync(new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
// Everything above the legacy section only. The `@supports not` block restates
// three of the palettes with their color-mix() companions spelled out, and a
// palette read twice would print twice.
const css = all.slice(0, all.indexOf('@supports not (color: color-mix(in srgb, red, blue))'));

// The base :root block is Papyrus and is the default look - it gets the bare
// `[data-whimsy=n]` selector, with no palette attribute to qualify it.
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

/**
 * --accent-deep as this palette's own darker twin of a dressed accent.
 *
 * Not deepen()'s fixed drop: each hand-written palette spends a different
 * distance between its accent and its deep - Orca's is a shade, Tearose's is a
 * step - and that spacing is part of what tells them apart. So the drop and the
 * chroma ratio are read off the literals and re-applied to the dressed accent,
 * at the deep's own hue.
 */
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
// Tier 0: chalk. The whole sheet plus the whole quartet, because at this end
// the paper takes the dye too - there is no live derivation to leave alone.
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
  // The middle darkens the accent until a light label clears it. A pastel
  // accent cannot be darkened that far and stay pastel, so the label is the
  // ink instead - by name, so it follows any tuning done to the ink above.
  vars['--accent-fg'] = 'var(--ink)';
  emit(0, name, vars);
}

// ---------------------------------------------------------------------------
// Tier 2: poster. The quartet only. The hand-written [data-whimsy="2"] block
// derives its whole sheet from var(--accent) by color-mix, so a boldened accent
// reaches the paper, the ink and the rules on its own - writing sheet literals
// here would cut that derivation off.
//
// The accent goes to its hue's cusp and stays there, because that is the fill;
// --accent-text is the same pigment walked back down the wall until it can be
// read on this end's sheet. --accent-warm takes the light register, which is
// where the non-text roles live.
//
// --leafy is the second loud voice, and which hue it wears is the one thing
// that differs per palette. A palette with a dominant hue to spare - a sheet
// carrying real colour, standing apart from its accent - has a colour this
// tier would otherwise erase, so that hue takes the deep register and the
// palette's own leafy moves along to the wash. None of the four qualify today
// and the branch is dormant; see the gate below for why that is the answer
// rather than a gap. All of these rules are pigments.ts's, applied to literals
// here.
//
// The sheet that descent is measured against is the Harsh block's own --stock,
// read out of the file rather than restated, plus the 4% of --accent that block
// mixes into it - which is knowable here because --accent is the cusp and does
// not depend on the answer.
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
    // The fill keeps the cusp; the text form is the same pigment walked down
    // until it reads on the sheet. The sheet is the Harsh block's --stock with
    // the 4% of --accent that block mixes into it, and --accent is the cusp -
    // so unlike the accent itself this needs no second pass to settle.
    accent = bolden(p['--accent'], h);
    vars['--accent'] = hex(accent.L, accent.C, h);
    const paper = mixHex(STOCK, vars['--accent'], PAPER_MIX);
    const text = toGround(accent, h, paper);
    vars['--accent-text'] = hex(text.L, text.C, h);
  }
  // A preset has no vote, so unlike an extraction its accent stays where its
  // author put it and the dominant hue takes the deep register instead - but
  // only where there is a dominant hue to take it.
  //
  // This is the gate an extraction gets for free and a literal does not. A hue
  // that won a vote cleared NEUTRAL_C to be counted at all; the four sheets
  // above cleared nothing, and section 2 says outright that they are held to
  // chroma 0.003 to 0.007 so that they do not cast the photographs pinned to
  // them. Papyrus's cream reads as h 89 against an h 44 accent - 45 degrees
  // apart, which passes the separation test - but that angle is what is left
  // of a colour after it has been drained almost to neutral, not a colour
  // anyone chose. Handing the deep register to it printed a dull olive where
  // the tier wanted its loudest second voice.
  const sheet = p['--paper'];
  const deepH = accent && sheet && sheet.C >= NEUTRAL_C
    ? counterTurn(sheet.h, p['--accent'].h) : null;
  if (p['--leafy']) {
    const t = deepH == null ? boldSecond() : boldDeep();
    vars['--leafy'] = hex(t.L, t.C, deepH ?? p['--leafy'].h);
  }
  if (p['--accent-warm']) {
    const t = boldSecond();
    // The displaced third hue, where there was one to displace.
    vars['--accent-warm'] = hex(t.L, t.C,
      deepH == null || !p['--leafy'] ? p['--accent-warm'].h : p['--leafy'].h);
  }
  if (accent && p['--accent-deep']) {
    const t = twin(accent, p['--accent'], p['--accent-deep']);
    vars['--accent-deep'] = hex(t.L, t.C, p['--accent-deep'].h);
  }
  // The hand block's `--accent-fg: #fff` stands wherever white still reads on
  // the bold accent. Where it does not, the ink takes the label - which at this
  // tier is near-black, and black on a poster colour is the reference look
  // rather than a fallback.
  if (vars['--accent'] && contrast(vars['--accent'], '#ffffff') < 4.5) {
    vars['--accent-fg'] = 'var(--ink)';
  }
  emit(2, name, vars);
}
