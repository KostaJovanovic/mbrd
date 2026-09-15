// The two panel closes draw their hover plate and their cross in one svg the
// size of the button, so the ink and the plate cannot come apart
// (research/old/done-2026-09-15.md, R10). A 15 px glyph grid-centred on a
// background plate sat at a half pixel, and both engines snapped the two
// differently. This holds the numbers that keep the two centres one: the
// viewBox is the button, the plate fills it, the cross sits at its middle, and
// the cross is drawn at the middle of its own symbol.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(import.meta.dirname, '..', 'web');
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
const sprite = readFileSync(join(WEB, 'assets', 'icons.svg'), 'utf8');
const tokens = readFileSync(join(WEB, 'assets', 'css', 'tokens.css'), 'utf8');
const sidebar = readFileSync(join(WEB, 'assets', 'css', 'sidebar.css'), 'utf8');

const attr = (tag, name) => Number((new RegExp(`\\b${name}="([^"]+)"`).exec(tag) ?? [])[1]);

for (const id of ['side-close', 'header-close']) {
  test(`#${id}: the cross sits at the centre of the button's own box`, () => {
    const button = new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`).exec(html)?.[0];
    assert.ok(button, `no #${id} in index.html`);
    const svg = /<svg\b[^>]*>/.exec(button)[0];
    const use = /<use\b[^>]*>/.exec(button)[0];
    const box = (/\bviewBox="([^"]+)"/.exec(svg) ?? [])[1]?.split(/\s+/).map(Number);
    assert.ok(box, 'the svg needs a viewBox the size of the button');
    const [bx, by, bw, bh] = box;
    assert.deepEqual([bx, by], [0, 0]);
    assert.equal(bw, bh, 'a square box');

    const button_px = Number(/--icon-button:\s*(\d+)px/.exec(tokens)[1]);
    assert.equal(bw, button_px, 'the viewBox is the button, --icon-button in tokens.css');

    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(n => attr(use, n));
    assert.equal(w, h);
    assert.equal(x + w / 2, bw / 2, 'the cross is centred across');
    assert.equal(y + h / 2, bh / 2, 'the cross is centred down');
    assert.ok(Number.isInteger(x) && Number.isInteger(y), 'the cross starts on a whole pixel');

    // The plate is in the same svg, drawn first so the cross lies on top,
    // and fills the whole box.
    const plate = /<rect\b[^>]*class="close-plate"[^>]*>/.exec(button)?.[0];
    assert.ok(plate, 'the hover plate is a rect in the svg, not a background');
    assert.ok(button.indexOf(plate) < button.indexOf(use), 'the plate is drawn under the cross');
    assert.ok(!/\bx="/.test(plate) && !/\by="/.test(plate), 'the plate starts at the corner');
    assert.equal(attr(plate, 'width'), bw);
    assert.equal(attr(plate, 'height'), bh);
  });
}

test('the close cross is drawn at the centre of its symbol', () => {
  const symbol = /<symbol\b[^>]*id="i-close"[^>]*>([\s\S]*?)<\/symbol>/.exec(sprite);
  // Every stroke's own path, joined: each stroke is a path of its own, so the
  // two cannot cancel where they cross (icons.svg).
  const d = [...symbol[1].matchAll(/\bd="([^"]+)"/g)].map(m => m[1]).join(' ');
  // M x y l dx dy, twice: absolute starts, relative strokes.
  const xs = [], ys = [];
  for (const [, mx, my, lx, ly] of d.matchAll(/M\s*([\d.-]+)[\s,]+([\d.-]+)\s*l\s*([\d.-]+)[\s,]+([\d.-]+)/g)) {
    xs.push(+mx, +mx + +lx);
    ys.push(+my, +my + +ly);
  }
  assert.equal(xs.length, 4, `i-close changed shape: ${d}`);
  assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 8);
  assert.equal((Math.min(...ys) + Math.max(...ys)) / 2, 8);
});

test('the svg fills the button, with no inset to throw it off centre', () => {
  const rule = /#side-close svg,\s*#header-close svg\s*\{([^}]*)\}/.exec(sidebar)?.[1];
  assert.ok(rule, 'the svg rule moved');
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /height:\s*100%/);
  const button = /#side-close,\s*#header-close\s*\{([^}]*)\}/.exec(sidebar)[1];
  assert.match(button, /padding:\s*0;/);
  assert.match(button, /border:\s*0;/);
  assert.match(button, /background:\s*none;/);
  assert.doesNotMatch(button, /place-items|line-height/);
  // No state may paint the button's own background: that plate is the one
  // that came apart from the cross.
  for (const [, body] of sidebar.matchAll(/#(?:side|header)-close:[\w-]+[^{]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(body, /background/, `a state paints the button again: ${body.trim()}`);
  }
});
