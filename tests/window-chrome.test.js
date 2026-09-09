// The drawn title bar, and the app-wide scrollbar it arrived with.
//
// Both are things that fail *silently* and only on one shell, which is the
// shape this repository writes tests for. Nothing here runs the app: these are
// checks over the markup, the stylesheets and the command surface's source,
// the way tests/icons.test.js and tests/element-ids.test.js are.
//
// Three things can go quiet.
//
//   **A window button that presses nothing.** `data-cmd="window-close"` resolves
//   to `cmds.windowClose` through ui/window-chrome.ts's delegated listener, and
//   a rename on either side leaves a button that is drawn, hovers, depresses and
//   does nothing at all. There is no console warning: the dispatcher looks the
//   name up, finds nothing and returns.
//
//   **A frame rule that escaped `.is-framed`.** Every rule for this is supposed
//   to be desktop-only, and one written without the class would put a pill of
//   window buttons in the corner of the web app - where they would be three
//   buttons that cannot work, because platform.frame is the web's and answers
//   all three with silence.
//
//   **A scroller that took its scrollbar back.** Chromium treats
//   `scrollbar-width` or `scrollbar-color` on an element as the whole answer and
//   stops applying ::-webkit-scrollbar to it, so either property written outside
//   the one @supports block in base.css switches the app's own bar off on that
//   surface and puts the operating system's there instead. It looks like a
//   stylesheet that did nothing rather than one that undid something.

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
  // Guards every check below: a regex that matched nothing would let all of
  // them pass on an empty string.
  assert.ok(controls.length > 200, 'the #window-controls block was not found in index.html');
  assert.match(html, /<div id="window-drag"/);
});

test('every window button presses a command that exists', () => {
  const cmds = [...controls.matchAll(/data-cmd="([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(cmds, ['window-minimize', 'window-maximize', 'window-close']);

  // The same mapping ui/window-chrome.ts does at runtime, done here against the
  // source of the file that declares them. Reading the source rather than
  // importing the surface because createCommands() closes over a live Viewport
  // and there is no browser here to build one.
  for (const cmd of cmds) {
    const key = cmd.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.match(view, new RegExp(`\\b${key}:`), `data-cmd="${cmd}" has no cmds.${key}`);
  }
});

test('both elements ship hidden, so a browser never lays either of them out', () => {
  // ui/window-chrome.ts unhides them and only on a shell that answers own().
  // Shipping them visible would put a pill of dead buttons on the web app for
  // the whole of boot, and on /patch - which loads no bundle at all - forever.
  assert.match(html, /<div id="window-drag" hidden\b/);
  assert.match(html, /<div id="window-controls" hidden\b/);
});

test('the module asks the shell before it touches anything', () => {
  // The gate is a return and not a later hide. Order matters: a class written
  // on <html> before the question is a class a browser would keep.
  const gate = mod.indexOf('platform.frame.own()');
  assert.ok(gate > 0, 'the own() gate has moved or gone');
  assert.ok(gate < mod.indexOf('classList.add'), 'something is written before the gate');
});

test('nothing draws the frame without .is-framed', () => {
  // The two selectors that put either element on screen. Everything else -
  // colours, the seams, the glyph swap - hangs off those two and is only ever
  // reached through them, so this is the whole of the containment.
  for (const id of ['#window-drag', '#window-controls']) {
    const positioned = new RegExp(`\\.is-framed ${id} \\{`);
    assert.match(chrome, positioned,
      `${id} is positioned by a rule that does not carry .is-framed`);
  }
});

test('the drag band sits under the glass, not over it', () => {
  // Below --z-chrome so the paint order can answer the question the rule below
  // asks of it: a no-drag box only takes its own area back from a drag region
  // when it paints above the drag box.
  const band = /\.is-framed #window-drag \{[\s\S]*?\}/.exec(chrome)?.[0] ?? '';
  assert.match(band, /z-index: calc\(var\(--z-chrome\) - 1\)/);
  assert.match(band, /app-region: drag/);
});

test('body punches every control back out of the drag region', () => {
  // The load-bearing line, and the one this file exists for. A drag region is
  // hit-tested by the window manager before the page hears anything, so a
  // stacking order alone does not hold it back - and `no-drag` is not the
  // initial value, so a box that says nothing subtracts nothing. Without this
  // rule the band covers the whole chrome row and not one button in it can be
  // pressed, on the desktop only, with nothing logged. That shipped once.
  assert.match(chrome, /\.is-framed body \{[\s\S]*?app-region: no-drag/,
    'body no longer declares no-drag, so the drag band swallows the top row');
});

test('the buttons are not part of the handle they sit in', () => {
  // -webkit-app-region inherits, so a button inside a `drag` pill is draggable
  // unless it says otherwise - and a draggable button is one that never fires a
  // click, on the one platform this whole feature is for.
  assert.match(chrome, /#window-controls button \{[\s\S]*?app-region: no-drag/);
});

test('the whole top row steps below the drawn bar together', () => {
  // --frame-bar-h is the push: 0px on the web, the bar's height in a window
  // this app drew the frame of. Everything anchored to the top edge has to
  // carry the term or the bar lands on top of it - and the failure is partial,
  // so it reads as a layout bug in one element rather than a missing term in
  // one rule. The sidebar and the header panel are on the list for a sharper
  // reason than looks: they are --z-overlay and the bar is down on --z-chrome,
  // so a panel that did not step down would bury the window's own buttons.
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
  // A desktop window can be dragged narrower than the phone breakpoint, and
  // then mobile.css's own top rules win over the desktop ones above - including
  // #corner and #mobile-header-edit-btn, which move to the *top right*, which
  // is where the window's three buttons are. A sweep of eighteen window sizes
  // caught exactly this at 700px wide and below.
  //
  // Every top-anchored rule in mobile.css, checked by counting rather than by
  // name: `env(safe-area-inset-top)` appears only in rules that pin something
  // to the top edge, so each occurrence needs the term beside it.
  const mobile = read(join(CSS_DIR, 'mobile.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const decl of mobile.match(/[\w-]+:[^;]*env\(safe-area-inset-top\)[^;]*;/g) ?? []) {
    assert.match(decl, /var\(--frame-bar-h\)/,
      `a top-anchored rule in mobile.css misses the title bar's height: ${decl.trim()}`);
  }
  // And the short-landscape override, which writes a bare number instead.
  assert.match(mobile, /#sidebar, #header-panel \{ top: calc\(6px \+ var\(--frame-bar-h\)\)/);
});

test('base.css is the only place a scrollbar is described', () => {
  const strays = [];
  for (const rel of walk(CSS_DIR, ['.css'])) {
    const name = rel.split(/[\\/]/).pop();
    const src = read(join(WEB, rel)).replace(/\/\*[\s\S]*?\*\//g, '');
    // base.css declares the pair inside `@supports not selector(...)`, which is
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
  // The other direction, and the reason the test above is safe to keep: a sweep
  // that forbids the standard properties is only correct while something else
  // is drawing the bar.
  assert.match(base, /::-webkit-scrollbar-thumb \{/);
  assert.match(base, /@supports not selector\(::-webkit-scrollbar\)/);
});
