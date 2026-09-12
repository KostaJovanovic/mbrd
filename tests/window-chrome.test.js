// Drawn title bar and app-wide scrollbar — both fail silently. Checks:
// window buttons wire to real commands, frame rules stay behind .is-framed,
// scrollbar-width/color stays inside base.css's @supports block.

import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WEB, JS, read, walk } from './helpers.js';

const CSS_DIR = join(WEB, 'assets', 'css');
const html = read(join(WEB, 'index.html'));
const base = read(join(CSS_DIR, 'base.css'));
const chrome = read(join(CSS_DIR, 'chrome.css'));
const view = read(join(JS, 'commands', 'view.ts'));
const mod = read(join(JS, 'ui', 'window-chrome.ts'));

/** The `<div id="window-controls">…</div>` block, markup and all. */
const controls = /<div id="window-controls"[\s\S]*?\n<\/div>/.exec(html)?.[0] ?? '';

test('the window controls are in the markup at all', () => {
  // Guards every check below: a regex matching nothing would pass them
  // all on an empty string.
  assert.ok(controls.length > 200, 'the #window-controls block was not found in index.html');
  assert.match(html, /<div id="window-drag"/);
});

test('every window button presses a command that exists', () => {
  const cmds = [...controls.matchAll(/data-cmd="([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(cmds, ['window-minimize', 'window-maximize', 'window-close']);

  // The same mapping ui/window-chrome.ts does at runtime, done here
  // against the source directly - createCommands() closes over a live
  // Viewport, and there is no browser here to build one.
  for (const cmd of cmds) {
    const key = cmd.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.match(view, new RegExp(`\\b${key}:`), `data-cmd="${cmd}" has no cmds.${key}`);
  }
});

test('both elements ship hidden, so a browser never lays either of them out', () => {
  // ui/window-chrome.ts unhides them only on a shell that answers own().
  // Visible by default would put dead buttons on the web app through
  // boot, and forever on /patch, which loads no bundle at all.
  assert.match(html, /<div id="window-drag" hidden\b/);
  assert.match(html, /<div id="window-controls" hidden\b/);
});

test('the module asks the shell before it touches anything', () => {
  // The gate is a return, not a later hide - a class written on <html>
  // before the question is a class a browser would keep.
  const gate = mod.indexOf('platform.frame.own()');
  assert.ok(gate > 0, 'the own() gate has moved or gone');
  assert.ok(gate < mod.indexOf('classList.add'), 'something is written before the gate');
});

test('nothing draws the frame without .is-framed', () => {
  // The two selectors that put either element on screen. Everything else
  // - colours, seams, the glyph swap - hangs off those two, so this is
  // the whole of the containment.
  for (const id of ['#window-drag', '#window-controls']) {
    const positioned = new RegExp(`\\.is-framed ${id} \\{`);
    assert.match(chrome, positioned,
      `${id} is positioned by a rule that does not carry .is-framed`);
  }
});

test('the drag band sits under the glass, not over it', () => {
  // Below --z-chrome so the rule below can hold: a no-drag box only takes
  // its own area back from a drag region when it paints above it.
  const band = /\.is-framed #window-drag \{[\s\S]*?\}/.exec(chrome)?.[0] ?? '';
  assert.match(band, /z-index: calc\(var\(--z-chrome\) - 1\)/);
  assert.match(band, /app-region: drag/);
});

test('body punches every control back out of the drag region', () => {
  // The load-bearing line this file exists for. A drag region is
  // hit-tested by the window manager before the page hears anything, so
  // stacking order alone cannot hold it back, and `no-drag` is not the
  // initial value - a box saying nothing subtracts nothing. Without this
  // rule the band swallows the whole chrome row, desktop-only, silently.
  // That shipped once.
  assert.match(chrome, /\.is-framed body \{[\s\S]*?app-region: no-drag/,
    'body no longer declares no-drag, so the drag band swallows the top row');
});

test('the buttons are not part of the handle they sit in', () => {
  // -webkit-app-region inherits, so a button inside a `drag` pill is
  // draggable unless it says otherwise - and a draggable button never
  // fires a click.
  assert.match(chrome, /#window-controls button \{[\s\S]*?app-region: no-drag/);
});

test('the whole top row steps below the drawn bar together', () => {
  // --frame-bar-h is the push: 0px on the web, the bar's height in a
  // self-drawn frame. Everything anchored to the top edge must carry the
  // term, or the bar lands on top of it - and the failure looks like a
  // layout bug in one element rather than a missing term. The sidebar and
  // header panel matter for a sharper reason: they are --z-overlay above
  // the bar's --z-chrome, so a panel that did not step down would bury
  // the window's own buttons.
  assert.match(chrome, /--frame-bar-h: 0px;/, 'the push is not zero on the web');
  assert.match(chrome, /\.is-framed \{[\s\S]*?--frame-bar-h: \d+px/);

  const anchored = [
    ['chrome.css', '#toolbar'],
    ['sidebar.css', '#menu-btn'],
    ['sidebar.css', '#sidebar'],
    ['sidebar.css', '#header-panel'],
    ['status.css', '#busy'],
  ];
  for (const [sheet, id] of anchored) {
    const src = read(join(CSS_DIR, sheet));
    // The rule's own block, from the selector to its closing brace.
    const rule = new RegExp(`${id}[^{}]*\\{[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';
    assert.ok(rule, `${sheet} has no rule for ${id}`);
    assert.match(rule, /var\(--frame-bar-h\)/,
      `${id} in ${sheet} does not step below the drawn title bar`);
  }
});

test('the phone tier steps down too, and it is the corner that proves it', () => {
  // A desktop window dragged narrower than the phone breakpoint lets
  // mobile.css's top rules win, including #corner and
  // #mobile-header-edit-btn moving to the *top right* - where the
  // window's three buttons are. An eighteen-size sweep caught this at
  // 700px and below.
  //
  // Checked by counting, not by name: `env(safe-area-inset-top)` appears
  // only in rules pinning something to the top edge, so each occurrence
  // needs the term beside it.
  const mobile = read(join(CSS_DIR, 'mobile.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const decl of mobile.match(/[\w-]+:[^;]*env\(safe-area-inset-top\)[^;]*;/g) ?? []) {
    assert.match(decl, /var\(--frame-bar-h\)/,
      `a top-anchored rule in mobile.css misses the title bar's height: ${decl.trim()}`);
  }
  // The short-landscape override writes a bare number instead.
  assert.match(mobile, /#sidebar, #header-panel \{ top: calc\(6px \+ var\(--frame-bar-h\)\)/);
});

test('base.css is the only place a scrollbar is described', () => {
  const strays = [];
  for (const rel of walk(CSS_DIR, ['.css'])) {
    const name = rel.split(/[\\/]/).pop();
    const src = read(join(WEB, rel)).replace(/\/\*[\s\S]*?\*\//g, '');
    // base.css declares the pair inside `@supports not selector(...)`,
    // the Firefox half and the one place they are right.
    const text = name === 'base.css' ? src.replace(/@supports not selector\([\s\S]*?\n\}/, '') : src;
    for (const m of text.matchAll(/\bscrollbar-(?:width|color)\s*:/g)) {
      strays.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(strays, [],
    'scrollbar-width and scrollbar-color replace ::-webkit-scrollbar in Chromium '
    + 'rather than backing it up, so either one written on a scroller takes the '
    + "app's own bar away from it. See the head of this file.");
});

test('the app really does draw one', () => {
  // The other direction, and why the test above is safe to keep: forbidding
  // the standard properties is only correct while something else draws the bar.
  assert.match(base, /::-webkit-scrollbar-thumb \{/);
  assert.match(base, /@supports not selector\(::-webkit-scrollbar\)/);
});
