// The settings table, the only description of the sidebar. Asserts
// properties the panel used to get by hand and eye: a control appears
// once, a button names a command that exists, nothing Desktop-only
// reaches a phone, no tab shows a heading with nothing under it.
// ui/panel.ts turning the table into DOM needs a browser and isn't
// tested here; the decisions are, and they're all pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { appCss } from './helpers.js';
import {
  TABS, SECTIONS, sectionsFor, controlVisible, controlEnabled, sectionVisible,
} from '../web/assets/js/ui/settings-schema.ts';
import { board } from '../web/assets/js/state.ts';
import { createCommands } from '../web/assets/js/commands.ts';

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
  // ui/panel.ts shows TABS[0]; the order here is the order on screen.
  assert.equal(TABS[0].id, 'board');
  assert.deepEqual(TABS.map(t => t.id), ['board', 'look', 'system']);
});

test('no id is used twice', () => {
  // Every one of these is looked up by getElementById somewhere, so a
  // duplicate is a control that silently loses its wiring to another.
  const seen = new Map();
  for (const [s, c] of allControls()) {
    if (!c.id) continue;
    assert.equal(seen.has(c.id), false, `${c.id} appears in both ${seen.get(c.id)} and ${s.id}`);
    seen.set(c.id, s.id);
  }
});

test('every button names a command that exists', () => {
  // The panel reaches the app through one delegated listener on
  // data-cmd, so a typo is a button that silently does nothing.
  //
  // Asked of the real object rather than the source text: matching
  // `const cmds = { ... }` in commands.ts with a regex was only ever a
  // stand-in, and stopped working when createCommands() split across
  // commands/. Building the object costs nothing (it's a factory
  // precisely so it touches no browser global at import time), and
  // `key in cmds` is what the panel actually does.
  const cmds = createCommands(
    { toWorld: () => ({ x: 0, y: 0 }), left: 0, top: 0, cx: 0, cy: 0, fit() {}, recenter() {} },
    { resetAppearance() {}, setWhimsy() {} });
  const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  let checked = 0;
  for (const [, c] of allControls()) {
    for (const b of c.buttons || []) {
      if (!b.cmd) continue;
      checked++;
      const key = camel(b.cmd);
      assert.ok(key in cmds, `data-cmd="${b.cmd}" has no cmds.${key}`);
    }
  }
  // The loop has two ways to iterate nothing - no controls, or no
  // buttons with a cmd - and both left this passing with nothing checked.
  assert.ok(checked > 5, `only ${checked} data-cmd buttons found in the schema`);
});

test('a control that can be set can also be read', () => {
  // Except the external ones, where another module owns both halves,
  // and the decorative ones, which aren't controls at all.
  for (const [s, c] of allControls()) {
    if (c.external || !c.set) continue;
    assert.equal(typeof c.get, 'function', `${c.id || s.id} writes a value it cannot read back`);
  }
});

test('Tilt cards greys at Harsh and stays live on the other two tiers', () => {
  // Harsh stands every card square in quality.css, so the box there would
  // change nothing. Greyed rather than hidden, so the row does not jump.
  const [section, tilt] = allControls().find(([, c]) => c.id === 'opt-tilt');
  const was = board.settings.appearance;
  try {
    for (const [whimsy, live] of [[0, true], [1, true], [2, false]]) {
      board.settings.appearance = { ...was, whimsy };
      assert.equal(controlEnabled(tilt, section, DESKTOP), live, `whimsy ${whimsy}`);
    }
  } finally {
    board.settings.appearance = was;
  }
  assert.equal(tilt.get(), true, 'on by default');
});

test('Mobile is shown the arrangement it has and nothing it has not', () => {
  // setSetting() refuses paper, its orientation and its grips on a
  // Mobile board, so a row for any would be a control that does nothing.
  // Absence, not disabling. Spacing, snap, the grid, the axes and the
  // readout joined it on 2026-09-14 (R18): the Feed packs its wall by order
  // at a fixed gap and draws nothing over it, so none of them did anything.
  for (const id of ['opt-paper', 'paper-orient', 'opt-paper-resize', 'paper-hint',
    'opt-web', 'spacing', 'opt-snap', 'opt-tilt', 'opt-grid', 'opt-axes', 'opt-hud']) {
    assert.equal(controlVisible(byId(id), MOBILE), false, `${id} should be absent on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} should be present on Desktop`);
  }
  // No grid-width control the other way round: the Feed packs its
  // columns from the sheet width (ui/feed.ts), so the manual row was
  // retired. Its absence from the schema is the assertion now.
  assert.equal(byId('mobile-columns'), undefined, 'the manual Grid width row is retired');
});

test('the settings that are not about a layout are in both', () => {
  for (const id of ['opt-mediafit',
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
    // Every tab still has something in it, in both layouts.
    for (const t of TABS) {
      assert.ok(sectionsFor(t.id, ctx).length, `tab ${t.id} is empty when mobile=${ctx.mobile}`);
    }
  }
});

test('each section keeps something above its fold', () => {
  // A section entirely advanced is a heading you have to open to find
  // out is empty. The keyboard legend is the one exception: it has no
  // heading at all, only the fold's own summary.
  for (const s of SECTIONS) {
    if (s.fold) continue;
    assert.ok(s.controls.some(c => !c.advanced), `${s.id} is nothing but a fold`);
  }
  const keys = SECTIONS.find(s => s.id === 'keys');
  assert.equal(keys.title, undefined, 'the legend section draws no h2 of its own');
  assert.equal(keys.fold, 'By hand');
});

test('a section that is all fold is all fold', () => {
  // The keyboard legend and Paper are whole sections behind one summary,
  // both carrying `fold` and no title. buildSection() appends a
  // non-`advanced` control straight to the section, above the fold -
  // which in a section with no h2 puts a bare row over the summary meant
  // to be its heading. So the two facts must travel together; the
  // missing title is also what ui/panel.ts marks .is-head from.
  for (const s of SECTIONS) {
    if (!s.fold) continue;
    assert.equal(s.title, undefined, `${s.id} is a fold and a heading both`);
    for (const c of s.controls) {
      assert.equal(c.advanced, true,
        `${c.id || c.type} in ${s.id} would be drawn above that section's own summary`);
    }
  }
  // The set the rule was written for is still the set. Debug joined it:
  // three development toggles nobody using a board reads, a stronger
  // version of the keyboard legend's argument - the legend is at least read once.
  assert.deepEqual(SECTIONS.filter(s => s.fold).map(s => s.id),
                   ['real-size', 'keys', 'debug']);
});

test('the four demoted controls are below a fold, not gone', () => {
  // Panel width, the two grid sliders and the palette source count: set
  // once or never, crowding the two dials that do the work.
  for (const id of ['opt-palette-sources']) {
    assert.equal(byId(id).advanced, true, `${id} should be inside the fold`);
  }
  // The three living in ui/appearance.ts's own CONTROLS list are checked
  // there; here we only hold the host they're built into.
  const host = byId('appearance-advanced-vars');
  assert.equal(host.type, 'slot');
  assert.equal(host.advanced, true);
});

test('the Look tab opens on three dials, and type is one of them', () => {
  // The fold is for controls a board is no worse for never touching,
  // and a typeface is not one: the display serif is the loudest decision
  // on a board, and a dropped face becomes an entry in these menus - so
  // hiding them made a feature that worked into one that couldn't be
  // found. The hint says exactly that and must travel with it.
  // The hint has two wordings, one per layout: a phone cannot drop, so it
  // is told the Add button's way in (R18, 2026-09-14).
  const look = SECTIONS.find(s => s.id === 'appearance');
  for (const ctx of [DESKTOP, MOBILE]) {
    const above = look.controls.filter(c => !c.advanced && controlVisible(c, ctx));
    assert.deepEqual(above.map(c => c.id ?? c.type),
      ['opt-whimsy', 'opt-palette', 'appearance-type', 'hint', 'appearance-fonts']);
    assert.match(above[3].html, /\.woff2/, 'the added-face hint stayed with the menus');
    assert.match(above[3].html, ctx.mobile ? /Add, then Files/ : /Drop a/);
    // The added-face list rides with the hint and menus, above the
    // fold, so an added face can be taken back off without opening the
    // advanced controls.
    assert.equal(above[4].id, 'appearance-fonts');
  }
});

test('the palette source dial has one stop past its highest count', async () => {
  // The last stop is "Every photo", stored as 0 (see
  // normalizePaletteSources() in state.ts). Two files know that number:
  // the table shapes the element, ui/appearance.ts rewrites `max` from
  // MAX_SOURCES. They must agree, or the top stop is unreachable or
  // uncounted.
  const { MAX_SOURCES } = await import('../web/assets/js/ui/pigments.ts');
  assert.equal(byId('opt-palette-sources').max, MAX_SOURCES + 1);
  // The stop is *defined* by the picture palette and *consumed* by the panel,
  // which reaches it through the look model's injected dependency bag rather
  // than by import. The palette loads in Node since R22, so it is asked.
  const { ALL_SOURCES_STOP } = await import('../web/assets/js/ui/picture-palette.ts');
  assert.equal(ALL_SOURCES_STOP, MAX_SOURCES + 1);
  const controls = await readFile(
    new URL('../web/assets/js/ui/appearance-controls.ts', import.meta.url), 'utf8');
  assert.match(controls, /n >= d\.ALL_SOURCES_STOP \? 0 : n/, 'the top stop stores zero');
});

test('the palette menu carries Dynamic, and it is the only way to ask for it', async () => {
  // One decision, one control. "Take colours from pictures" used to be
  // a checkbox below this menu, inside the fold, quietly overruling
  // whichever palette the menu claimed - so a board could say Papyrus
  // and be set in its own photographs' colours, the explanation two
  // clicks away.
  const options = byId('opt-palette').options();
  assert.equal(options[0].label, 'Dynamic', 'first, above the four named palettes');
  assert.deepEqual(options.map(o => o.label),
    ['Dynamic', 'Papyrus', 'Absinthe', 'Tea rose', 'Orca']);
  assert.equal(SECTIONS.flatMap(s => s.controls).some(c => c.id === 'opt-auto-palette'),
    false, 'the checkbox it replaced is gone, not merely hidden');

  // The value is one string in two files that don't import each other:
  // this table is data with no panel imports; ui/appearance-controls.ts
  // owns what the menu does with it. Same bargain as the source dial's top stop.
  const controls = await readFile(
    new URL('../web/assets/js/ui/appearance-controls.ts', import.meta.url), 'utf8');
  const owned = controls.match(/DYNAMIC = '([a-z0-9-]+)'/)[1];
  assert.equal(options[0].value, owned, 'the menu offers a value the panel answers to');
  // Never a palette name: it isn't written to look.palette and no
  // [data-palette] block answers to it, so a stylesheet growing one
  // would be a silent clash.
  const tokens = await readFile(
    new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(tokens, new RegExp(`\\[data-palette=["']?${owned}`));

  // The mirror of the last one: the row draws each palette's own
  // colours by walking tokens.css for the block its value names
  // (paletteSwatches in ui/palettes.ts). A named palette with no block
  // opens with no chips beside it, looking like a rendering fault rather
  // than a missing stylesheet.
  //
  // Dynamic and Papyrus are exempt for their usual reasons: Dynamic has
  // no block by design, and Papyrus *is* the bare `:root`.
  for (const { value, label } of options) {
    if (!value || value === owned) continue;
    assert.match(tokens, new RegExp(`\\[data-palette=["']?${value}["']?\\]`),
      `${label} is offered by the panel but tokens.css declares no block for it`);
  }
});

test('the whimsy stops keep the id the stylesheet sets them by', async () => {
  // Each of the three is a specimen of the tier it names - serif
  // italic, sans italic, sans bold - and app.css pins those faces to
  // #whimsy-stop-labels only. Left to the builder's default the row
  // would be #opt-whimsy-stops, matching nothing, and all three names
  // would come out set in whatever face the slider just moved to - the
  // one thing a specimen must not do.
  assert.equal(byId('opt-whimsy').stopsId, 'whimsy-stop-labels');
  const css = appCss();
  assert.match(css, /#whimsy-stop-labels span:nth-child\(1\)/);
});

test('quality reads the live flags rather than a copy', async () => {
  const { quality, initQuality, setQualityLevel } = await import('../web/assets/js/quality.ts');
  initQuality(null);
  assert.equal(byId('q-shadows').get(), quality.shadows);
  setQualityLevel('light');
  assert.equal(byId('q-shadows').get(), false, 'the checkbox follows the dial');
  assert.equal(byId('q-sharpness').get(), '1024');
  initQuality(null);
});
