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

import { appCss } from './helpers.js';
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
  // The command surface lives in commands.js, built by createCommands(vp) so it
  // can close over the Viewport without touching a browser global at import
  // time. The object is one indent in, hence the closing brace this matches.
  return readFile(new URL('../web/assets/js/commands.js', import.meta.url), 'utf8').then(main => {
    const block = main.match(/const cmds = \{([\s\S]*?)\n {2}\};/);
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
  // board - so a row for any of them would be a control that does nothing.
  // Absence, not disabling. Spacing is deliberately not on this list any more:
  // a fixed-width strip has no page to fit anything onto, but it can perfectly
  // well have a gap between its cards, and it now does - starting at zero.
  for (const id of ['opt-paper', 'paper-orient', 'opt-paper-resize', 'paper-hint',
    'opt-web']) {
    assert.equal(controlVisible(byId(id), MOBILE), false, `${id} should be absent on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} should be present on Desktop`);
  }
  // There is no longer a grid-width control the other way round: the Feed packs
  // its columns from the sheet width (ui/feed.js), so the manual "Grid width" row
  // was retired. Its absence from the schema is the assertion now.
  assert.equal(byId('mobile-columns'), undefined, 'the manual Grid width row is retired');
});

test('the settings that are not about a layout are in both', () => {
  for (const id of ['opt-grid', 'opt-axes', 'opt-hud', 'opt-mediafit',
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

test('a section that is all fold is all fold', () => {
  // The keyboard legend and Paper are whole sections behind one summary, and
  // both carry `fold` and no title. buildSection() appends a control that is not
  // `advanced` straight to the section, above the fold - which in a section with
  // no h2 puts a bare row over the summary that is supposed to be its heading.
  // So the two facts have to travel together, and the missing title is also what
  // ui/panel.js marks .is-head from.
  for (const s of SECTIONS) {
    if (!s.fold) continue;
    assert.equal(s.title, undefined, `${s.id} is a fold and a heading both`);
    for (const c of s.controls) {
      assert.equal(c.advanced, true,
        `${c.id || c.type} in ${s.id} would be drawn above that section's own summary`);
    }
  }
  // And the pair the rule was written for are still the pair.
  assert.deepEqual(SECTIONS.filter(s => s.fold).map(s => s.id), ['real-size', 'keys']);
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

test('the Look tab opens on three dials, and type is one of them', () => {
  // The fold is for controls a board is no worse for never touching, and a
  // typeface is not one: the display serif is the loudest decision on a board,
  // and a face dropped onto the board itself becomes an entry in these menus -
  // so hiding them made a feature that worked into one that could not be found.
  // Its hint says exactly that and has to travel with it.
  const look = SECTIONS.find(s => s.id === 'appearance');
  const above = look.controls.filter(c => !c.advanced);
  assert.deepEqual(above.map(c => c.id ?? c.type),
    ['opt-whimsy', 'opt-palette', 'appearance-type', 'hint', 'appearance-fonts']);
  assert.match(above[3].html, /\.woff2/, 'the dropped-face hint stayed with the menus');
  // The dropped-face list rides with the hint and the menus, above the fold, so a
  // face you added can be taken back off without opening the advanced controls.
  assert.equal(above[4].id, 'appearance-fonts');
});

test('the palette source dial has one stop past its highest count', async () => {
  // The last stop is "Every photo" and is stored as 0 - see
  // normalizePaletteSources() in state.js. Two files know that number: the table
  // shapes the element, ui/appearance.js rewrites `max` from MAX_SOURCES on the
  // way past. They have to agree, or the top stop is either unreachable or a
  // count nothing will honour.
  const { MAX_SOURCES } = await import('../web/assets/js/ui/pigments.js');
  assert.equal(byId('opt-palette-sources').max, MAX_SOURCES + 1);
  // The stop is *defined* by the look model and *consumed* by the panel, which
  // are two files since the appearance split - and the panel reaches it through
  // the injected dependency bag rather than by import, which is the seam.
  const model = await readFile(
    new URL('../web/assets/js/ui/appearance.js', import.meta.url), 'utf8');
  assert.match(model, /ALL_SOURCES_STOP = MAX_SOURCES \+ 1/);
  const controls = await readFile(
    new URL('../web/assets/js/ui/appearance-controls.js', import.meta.url), 'utf8');
  assert.match(controls, /n >= d\.ALL_SOURCES_STOP \? 0 : n/, 'the top stop stores zero');
});

test('the palette menu carries Dynamic, and it is the only way to ask for it', async () => {
  // One decision, one control. "Take colours from pictures" used to be a
  // checkbox below this menu and inside the fold, quietly overruling whichever
  // palette the menu claimed - so a board could say Papyrus and be set in the
  // colours of its own photographs, with the explanation two clicks away.
  const options = byId('opt-palette').options();
  assert.equal(options[0].label, 'Dynamic', 'first, above the four named palettes');
  assert.deepEqual(options.map(o => o.label),
    ['Dynamic', 'Papyrus', 'Absinthe', 'Tea rose', 'Orca']);
  assert.equal(SECTIONS.flatMap(s => s.controls).some(c => c.id === 'opt-auto-palette'),
    false, 'the checkbox it replaced is gone, not merely hidden');

  // And the value is one string in two files that do not import each other:
  // this table is data with no panel imports, ui/appearance-controls.js owns
  // what the menu does with it. Same bargain as the source dial's top stop.
  const controls = await readFile(
    new URL('../web/assets/js/ui/appearance-controls.js', import.meta.url), 'utf8');
  const owned = controls.match(/DYNAMIC = '([a-z0-9-]+)'/)[1];
  assert.equal(options[0].value, owned, 'the menu offers a value the panel answers to');
  // Never a palette name: it is not written to look.palette and no [data-palette]
  // block answers to it, so a stylesheet that grew one would be a silent clash.
  const tokens = await readFile(
    new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(tokens, new RegExp(`\\[data-palette=["']?${owned}`));
});

test('the whimsy stops keep the id the stylesheet sets them by', async () => {
  // Each of the three is a specimen of the tier it names - serif italic, sans
  // italic, sans bold - and app.css pins those three faces to
  // #whimsy-stop-labels and to nothing else. Left to the builder's default the
  // row would be #opt-whimsy-stops, the rule would match nothing, and all three
  // names would come out set in whatever the slider had just moved the display
  // face to, which is the one thing a specimen must not do.
  assert.equal(byId('opt-whimsy').stopsId, 'whimsy-stop-labels');
  const css = appCss();
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
