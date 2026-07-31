// The settings table, which is now the only description of the sidebar.
//
// Everything asserted here is a property the panel used to get by being written
// out by hand and read by eye: that a control appears once, that a button names
// a command that exists, that nothing Desktop-only reaches a phone, and that no
// tab can show a heading with nothing under it. ui/panel.js turning the table
// into DOM needs a browser and is not tested here; the decisions are, and they
// are all pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  TABS, SECTIONS, sectionsFor, controlVisible, sectionVisible,
} from '../web/assets/js/ui/settings-schema.js';

const DESKTOP = { mobile: false };
const MOBILE = { mobile: true };

const allControls = () => SECTIONS.flatMap(s => s.controls.map(c => [s, c]));
const byId = id => allControls().find(([, c]) => c.id === id)?.[1];

test('every section belongs to a tab that exists', () => {
  const tabs = new Set(TABS.map(t => t.id));
  for (const s of SECTIONS) {
    assert.ok(tabs.has(s.tab), `section ${s.id} is filed under an unknown tab ${s.tab}`);
  }
});

test('the panel opens on Board, and Board is first', () => {
  // ui/panel.js shows TABS[0]. The order here is the order on screen.
  assert.equal(TABS[0].id, 'board');
  assert.deepEqual(TABS.map(t => t.id), ['board', 'look', 'system']);
});

test('no id is used twice', () => {
  // Every one of these is looked up by getElementById somewhere - by
  // ui/appearance.js, canvas/audio.js, ui/sidebar.js or a test - so a duplicate
  // is a control that silently loses its wiring to another.
  const seen = new Map();
  for (const [s, c] of allControls()) {
    if (!c.id) continue;
    assert.equal(seen.has(c.id), false, `${c.id} appears in both ${seen.get(c.id)} and ${s.id}`);
    seen.set(c.id, s.id);
  }
});

test('every button names a command that exists', () => {
  // The panel reaches the app through one delegated listener on data-cmd, so a
  // typo here is a button that does nothing at all, silently.
  return readFile(new URL('../web/assets/js/main.js', import.meta.url), 'utf8').then(main => {
    const block = main.match(/const cmds = \{([\s\S]*?)\n\};/);
    assert.ok(block, 'the cmds object moved - this test cannot find it');
    const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    for (const [, c] of allControls()) {
      for (const b of c.buttons || []) {
        if (!b.cmd) continue;
        const key = camel(b.cmd);
        assert.match(block[1], new RegExp(`(^|\\n)\\s*${key}\\s*[:,(]`),
          `data-cmd="${b.cmd}" has no cmds.${key}`);
      }
    }
  });
});

test('a control that can be set can also be read', () => {
  // Except the external ones, where another module owns both halves, and the
  // decorative ones, which are not controls at all.
  for (const [s, c] of allControls()) {
    if (c.external || !c.set) continue;
    assert.equal(typeof c.get, 'function', `${c.id || s.id} writes a value it cannot read back`);
  }
});

test('Mobile is shown the arrangement it has and nothing it has not', () => {
  // setSetting() refuses paper, its orientation and its grips on a Mobile
  // board, and Mobile packs with no configurable gap - so a row for any of them
  // would be a control that does nothing. Absence, not disabling.
  for (const id of ['opt-paper', 'paper-orient', 'opt-paper-resize', 'paper-hint',
    'spacing', 'opt-web']) {
    assert.equal(controlVisible(byId(id), MOBILE), false, `${id} should be absent on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} should be present on Desktop`);
  }
  // And the one that is the other way round.
  assert.equal(controlVisible(byId('mobile-columns'), MOBILE), true);
  assert.equal(controlVisible(byId('mobile-columns'), DESKTOP), false);
});

test('the settings that are not about a layout are in both', () => {
  for (const id of ['opt-grid', 'opt-axes', 'opt-hud', 'opt-mediafit', 'opt-volume',
    'opt-units', 'opt-whimsy', 'opt-palette', 'opt-quality', 'board-title']) {
    assert.equal(controlVisible(byId(id), MOBILE), true, `${id} missing on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} missing on Desktop`);
  }
});

test('no tab can show a heading with nothing under it', () => {
  for (const ctx of [DESKTOP, MOBILE]) {
    for (const s of SECTIONS) {
      if (!sectionVisible(s, ctx)) continue;
      const shown = s.controls.filter(c => controlVisible(c, ctx));
      assert.ok(shown.length, `${s.id} is visible with no visible control`);
    }
    // And every tab still has something in it, in both layouts.
    for (const t of TABS) {
      assert.ok(sectionsFor(t.id, ctx).length, `tab ${t.id} is empty when mobile=${ctx.mobile}`);
    }
  }
});

test('each section keeps something above its fold', () => {
  // A section that is entirely advanced is a heading you have to open to find
  // out is empty. The keyboard legend is the one exception and says so: it has
  // no heading at all, only the fold's own summary.
  for (const s of SECTIONS) {
    if (s.fold) continue;
    assert.ok(s.controls.some(c => !c.advanced), `${s.id} is nothing but a fold`);
  }
  const keys = SECTIONS.find(s => s.id === 'keys');
  assert.equal(keys.title, undefined, 'the legend section draws no h2 of its own');
  assert.equal(keys.fold, 'By hand');
});

test('the four demoted controls are below a fold, not gone', () => {
  // Panel width, the two grid sliders and the palette source count: set once or
  // never, and they were crowding the two dials that do the work.
  for (const id of ['opt-palette-sources']) {
    assert.equal(byId(id).advanced, true, `${id} should be inside the fold`);
  }
  // The three that live in ui/appearance.js's own CONTROLS list are checked
  // there - here we only hold the host they are built into.
  const host = byId('appearance-advanced-vars');
  assert.equal(host.type, 'slot');
  assert.equal(host.advanced, true);
});

test('the palette source dial has one stop past its highest count', async () => {
  // The last stop is "Every photo" and is stored as 0 - see
  // normalizePaletteSources() in state.js. Two files know that number: the table
  // shapes the element, ui/appearance.js rewrites `max` from MAX_SOURCES on the
  // way past. They have to agree, or the top stop is either unreachable or a
  // count nothing will honour.
  const { MAX_SOURCES } = await import('../web/assets/js/ui/pigments.js');
  assert.equal(byId('opt-palette-sources').max, MAX_SOURCES + 1);
  const src = await readFile(
    new URL('../web/assets/js/ui/appearance.js', import.meta.url), 'utf8');
  assert.match(src, /ALL_SOURCES_STOP = MAX_SOURCES \+ 1/);
  assert.match(src, /n >= ALL_SOURCES_STOP \? 0 : n/, 'the top stop stores zero');
});

test('the whimsy stops keep the id the stylesheet sets them by', async () => {
  // Each of the three is a specimen of the tier it names - serif italic, sans
  // italic, sans bold - and app.css pins those three faces to
  // #whimsy-stop-labels and to nothing else. Left to the builder's default the
  // row would be #opt-whimsy-stops, the rule would match nothing, and all three
  // names would come out set in whatever the slider had just moved the display
  // face to, which is the one thing a specimen must not do.
  assert.equal(byId('opt-whimsy').stopsId, 'whimsy-stop-labels');
  const css = await readFile(
    new URL('../web/assets/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /#whimsy-stop-labels span:nth-child\(1\)/);
});

test('quality reads the live flags rather than a copy', async () => {
  const { quality, initQuality, setQualityLevel } = await import('../web/assets/js/quality.js');
  initQuality(null);
  assert.equal(byId('q-shadows').get(), quality.shadows);
  setQualityLevel('light');
  assert.equal(byId('q-shadows').get(), false, 'the checkbox follows the dial');
  assert.equal(byId('q-sharpness').get(), '1024');
  initQuality(null);
});
