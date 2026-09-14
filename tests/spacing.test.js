// The spacing rhythm (research/old/done-2026-09-15.md, R17, from the
// design audit's D4): every pixel gap in the stylesheets is 2, 4, 6, 8 or 12.
// Thirteen values were in use, every integer from 1 to 10 among them, and a
// gap nobody chose is how they got there. A 1px gap is a seam, not spacing:
// the hairline between waveform bars or between buttons that nearly touch.
// Relative values (em, calc, var, clamp) scale with something and are not
// what this is about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers.js';

const CSS = join(WEB, 'assets', 'css');

/** The rhythm, and the seam. */
const RHYTHM = new Set([0, 1, 2, 4, 6, 8, 12]);

/** Every bare-pixel gap, row-gap and column-gap value, as `file:line value`. */
function gaps() {
  const out = [];
  for (const name of readdirSync(CSS).filter(f => f.endsWith('.css')).sort()) {
    const lines = readFileSync(join(CSS, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const decl of line.matchAll(/(?:^|[\s;{])(?:row-|column-)?gap\s*:\s*([^;}]+)/g)) {
        const parts = decl[1].trim().split(/\s+/);
        // A declaration is checked only when every part is a plain length.
        if (!parts.every(p => /^\d+(\.\d+)?(px)?$/.test(p))) continue;
        for (const p of parts) out.push({ at: `${name}:${i + 1}`, px: parseFloat(p) });
      }
    });
  }
  return out;
}

test('every pixel gap is on the rhythm', () => {
  const off = gaps().filter(g => !RHYTHM.has(g.px));
  assert.deepEqual(off.map(g => `${g.at} ${g.px}px`), [],
    'A gap off 2/4/6/8/12. Pick the nearest step, and look at it on screen.');
});

test('the check finds the gaps it is meant to hold', () => {
  // A regex that stopped matching would pass the test above with nothing in it.
  assert.ok(gaps().length > 100);
});
