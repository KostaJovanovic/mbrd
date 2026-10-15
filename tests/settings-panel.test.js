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
import { PAPERS } from '../web/assets/js/measure.ts';
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
  // Units joined them when the Paper section became a button that drops the
  // rest in behind it: a phone can raise no sheet, and no Mobile surface reads
  // the setting in any case - the scale bar is display:none there, and the
  // readout that would have is already on this list.
  const was = board.settings.paperShow;
  // The Desktop half of the claim is about a board with a sheet up. Without
  // one the paper rows are absent on Desktop too, which is its own test below.
  board.settings.paperShow = true;
  for (const id of ['opt-paper', 'paper-orient', 'opt-paper-resize', 'paper-hint', 'opt-units',
    'opt-web', 'spacing', 'opt-snap', 'opt-tilt', 'opt-grid', 'opt-axes', 'opt-hud']) {
    assert.equal(controlVisible(byId(id), MOBILE), false, `${id} should be absent on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} should be present on Desktop`);
  }
  board.settings.paperShow = was;
  // No grid-width control the other way round: the Feed packs its
  // columns from the sheet width (ui/feed.ts), so the manual row was
  // retired. Its absence from the schema is the assertion now.
  assert.equal(byId('mobile-columns'), undefined, 'the manual Grid width row is retired');
});

test('the settings that are not about a layout are in both', () => {
  // Units was on this list until the Paper section became Desktop-only in
  // full. It is in the list above instead - moved rather than dropped, so the
  // change is recorded in both places it used to be claimed.
  for (const id of ['opt-whimsy', 'opt-palette', 'opt-quality', 'board-title']) {
    assert.equal(controlVisible(byId(id), MOBILE), true, `${id} missing on Mobile`);
    assert.equal(controlVisible(byId(id), DESKTOP), true, `${id} missing on Desktop`);
  }
});

test('cropping photos to the grid is offered only where there is a grid', () => {
  const was = board.settings.snap;
  board.settings.snap = true;
  assert.equal(controlVisible(byId('opt-mediafit'), DESKTOP), true, 'on a snapped Desktop board');
  assert.equal(controlVisible(byId('opt-mediafit'), MOBILE), false, 'the Feed has no grid');
  board.settings.snap = false;
  assert.equal(controlVisible(byId('opt-mediafit'), DESKTOP), false, 'off the grid a card is its picture');
  board.settings.snap = was;
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
  assert.equal(keys.fold, 'Shortcuts');
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
      assert.ok(c.advanced || c.belowFold,
        `${c.id || c.type} in ${s.id} would be drawn above that section's own summary`);
    }
  }
  // Two left. Paper was the third and is a heading again: a section
  // behind one word is one nobody knows is there, and the sheet rows
  // are what the tab is opened for.
  assert.deepEqual(SECTIONS.filter(s => s.fold).map(s => s.id), ['keys', 'debug']);
  const paper = SECTIONS.find(s => s.id === 'real-size');
  assert.equal(paper.title, 'Paper');
  assert.equal(paper.controls.some(c => c.advanced), false,
    'a heading with every row folded under it is the fold it stopped being');
});

test('Clear everything is the last row of the tab, under the Debug fold', () => {
  // Outside the fold so it shows with Debug shut, and the last control of
  // the last section, so nothing is ever drawn below it.
  const tab = SECTIONS.filter(s => s.tab === 'system');
  const debug = tab.at(-1);
  assert.equal(debug.id, 'debug');
  const last = debug.controls.at(-1);
  assert.equal(last.belowFold, true);
  assert.equal(last.advanced, undefined, 'advanced would sink it back into the fold');
  assert.deepEqual(last.buttons.map(b => b.cmd), ['clear-data']);
});

// --- The Paper section's shape ---------------------------------------------
//
// Three decisions that read as one row of a table each and are invisible when
// broken: the sheet is raised by a button rather than by a size, the rows that
// describe it grey out while it is down instead of standing live over nothing,
// and Units sits with the readouts it names rather than at the head of the
// section.

const paperSection = () => SECTIONS.find(s => s.id === 'real-size');

test('the Paper section leads with the sheet, and Units sits with the readouts', () => {
  assert.deepEqual(
    paperSection().controls.map(c => c.id ?? c.buttons?.[0]?.cmd ?? c.type),
    [
      'paper-show', 'opt-paper', 'paper-orient', 'opt-paper-resize', 'paper-hint',
      'opt-units', 'reset-scale', 'scale-hint',
    ],
  );
});

test('the size list no longer offers None', () => {
  // "None" was how a board said it had no sheet. An empty value left in this
  // list would put `paper` in a state PAPERS has no entry for, which now reads
  // as a sheet that is up and cannot be drawn.
  const opts = byId('opt-paper').options(DESKTOP);
  assert.deepEqual(opts.map(o => o.value), PAPERS.map(p => p.id));
  for (const o of opts) assert.ok(o.value, 'an option with an empty value is back');
});

const rowName = c => c.id ?? c.buttons?.[0]?.cmd ?? c.type;

test('the section is one button until there is a sheet, then all of it', () => {
  const paper = paperSection();
  const was = board.settings.paperShow;
  // Everything but the button that raises the sheet - the scale half included.
  const rows = paper.controls.filter(c => c.id !== 'paper-show');

  board.settings.paperShow = false;
  for (const c of rows) {
    assert.equal(controlVisible(c, DESKTOP), false, `${rowName(c)} is on screen over no sheet`);
  }
  assert.equal(controlVisible(paper.controls.find(c => c.id === 'paper-show'), DESKTOP), true,
    'the button that raises a sheet went down with the rows it raises');

  board.settings.paperShow = true;
  for (const c of rows) {
    assert.equal(controlVisible(c, DESKTOP), true, `${rowName(c)} did not come back with the sheet`);
    // Absence, not disabling: they were greyed for a while and are not now.
    assert.equal(controlEnabled(c, paper, DESKTOP), true, `${rowName(c)} came back greyed`);
  }
  board.settings.paperShow = was;
});

test('the whole section comes down on Mobile, and nothing there misses it', () => {
  // Mobile can never raise a sheet, so every row's `when` is false and
  // sectionVisible() takes the heading with them. That is only honest because
  // no Mobile surface reads settings.units: the scale bar is display:none
  // there, the readout and the sheet's caption are Desktop-only, and the
  // picker was changing the wording of one sentence in this panel.
  const paper = paperSection();
  const was = board.settings.paperShow;

  for (const flag of [false, true]) {
    board.settings.paperShow = flag;
    assert.equal(sectionVisible(paper, MOBILE), false,
      `Paper is on screen on Mobile with paperShow ${flag}`);
    for (const c of paper.controls) {
      assert.equal(controlVisible(c, MOBILE), false, `${rowName(c)} reaches a phone`);
    }
  }

  // Desktop still has the heading with the sheet down, so the rule above is
  // about Mobile and not about the section quietly vanishing everywhere.
  board.settings.paperShow = false;
  assert.equal(sectionVisible(paper, DESKTOP), true);
  board.settings.paperShow = was;
});

// --- Reveal runs -----------------------------------------------------------
//
// `reveal` puts a run of rows in one box that slides open and shut (slideBox,
// ui/panel.ts). What it animates is a height, so the run has to be one box
// with one answer - and every way of breaking that is silent on screen: the
// rows still come and go, just without the movement, or with it running from
// nothing to nothing.

test('every reveal run is consecutive and agrees on when it is there', () => {
  for (const s of SECTIONS) {
    let head = null;
    for (const c of s.controls) {
      if (!c.reveal) { head = null; continue; }
      const name = `${s.id}/${c.id ?? c.type}`;
      // `advanced` sinks a row into the section's fold, which is a different
      // box in a different place - it would leave the run's box measuring
      // less than the rows it thinks it holds.
      assert.notEqual(c.advanced, true, `${name} is both reveal and advanced`);
      // Without a `when` the row is always visible, so the box never shuts and
      // the mark buys nothing.
      assert.equal(typeof c.when, 'function', `${name} reveals but is always there`);
      if (!head) head = c;
      // One predicate per run, by identity: the box is open when any row in it
      // is, so a row that came and went on its own inside it would change the
      // height without the movement.
      else assert.equal(c.when, head.when, `${name} does not share its run's when`);
    }
  }
});

test('the Paper rows are one run behind the button that raises them', () => {
  const paper = paperSection();
  // The button is the only row outside the box - it has to stay put, or there
  // would be nothing on screen to press when the sheet is down.
  assert.equal(paper.controls[0].id, 'paper-show');
  assert.equal(paper.controls[0].reveal, undefined);
  assert.equal(paper.controls.slice(1).every(c => c.reveal === true), true,
    'a row after the button is outside the box and will not move with it');
});

test('the hint measures the sheet and never explains it', () => {
  // It used to fall back to a sentence describing what a paper outline is,
  // for the case where there was no sheet. The row is absent without one now,
  // so measuring is the whole of its job.
  const was = { show: board.settings.paperShow, resize: board.settings.paperResize };
  const text = byId('paper-hint').text;

  board.settings.paperShow = true;
  board.settings.paperResize = false;
  assert.match(text(DESKTOP), /px, centred on 0,0\./);
  assert.doesNotMatch(text(DESKTOP), /Outlines a sheet/);
  // The invitation prints only where the corners will answer it.
  assert.doesNotMatch(text(DESKTOP), /Drag a corner/);
  board.settings.paperResize = true;
  assert.match(text(DESKTOP), /Drag a corner/);

  board.settings.paperResize = was.resize;
  board.settings.paperShow = was.show;
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

test('the Look tab opens on two dials and the theme, and the faces are one fold in', () => {
  // The two that move every token at once stand alone with light-or-dark,
  // the one other colour question anybody comes here to ask; the type menus,
  // the faces added to the board and the tip that says how to add one
  // are together one fold down. The three must not come apart: the tip
  // is the only place the drop is named, and the list of added faces is
  // the only way to take one back off.
  const look = SECTIONS.find(s => s.id === 'appearance');
  for (const ctx of [DESKTOP, MOBILE]) {
    const above = look.controls.filter(c => !c.advanced && controlVisible(c, ctx));
    assert.deepEqual(above.map(c => c.id ?? c.type), ['opt-whimsy', 'opt-palette', 'opt-dark']);
    const folded = look.controls.filter(c => c.advanced && controlVisible(c, ctx));
    assert.deepEqual(folded.slice(0, 3).map(c => c.id),
      ['appearance-type', 'type-hint', 'appearance-fonts']);
  }
});

test('the typeface tip is a (?) on the row it explains, in both layouts', () => {
  // A tip is drawn onto the end of the control built before it
  // (buildSection, ui/panel.ts), so the two have to be in the same half
  // of the section - a tip marked advanced after a row that is not
  // would drag that row into the fold.
  const look = SECTIONS.find(s => s.id === 'appearance');
  const i = look.controls.findIndex(c => c.id === 'type-hint');
  assert.equal(look.controls[i - 1].id, 'appearance-type', 'the row it belongs to');
  assert.equal(look.controls[i - 1].advanced, look.controls[i].advanced);
  const tip = look.controls[i];
  assert.equal(typeof tip.tip, 'string', 'the (?) needs a name to be read out as');
  assert.equal(tip.html, undefined, 'a tip is prose, painted as text');
  // A phone cannot drop, so it is told the Add button's way in
  // (R18, 2026-09-14). One control, both wordings.
  assert.match(tip.text(DESKTOP), /^Drop a \.woff2/);
  assert.match(tip.text(MOBILE), /Add, then Files/);
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

test('a pigment picked by hand reads as Custom, which the menu does not offer', async () => {
  // The state a colour picked below this menu puts it in. Not a row:
  // an entry that picks the colour already on screen answers nothing,
  // and the way back is any palette - setPalette() drops every pigment
  // token, so the choice is forgotten by the thing that replaces it.
  const palette = byId('opt-palette');
  const options = palette.options();
  assert.equal(typeof palette.unlisted, 'function',
    'without this the picker draws an empty box for a value it cannot name');
  assert.equal(palette.unlisted('custom'), 'Custom');
  assert.equal(palette.unlisted(''), '', 'every other value is the menu\'s to name');
  assert.equal(options.some(o => o.label === 'Custom' || o.value === 'custom'), false,
    'Custom is a state the control is put into, never one it offers');

  // The same bargain Dynamic has: one string in two files that do not
  // import each other.
  const controls = await readFile(
    new URL('../web/assets/js/ui/appearance-controls.ts', import.meta.url), 'utf8');
  assert.equal(controls.match(/CUSTOM = '([a-z0-9-]+)'/)[1], 'custom');
  // And never a palette name, for the reason Dynamic isn't: a
  // [data-palette="custom"] block would be a silent clash.
  const tokens = await readFile(
    new URL('../web/assets/css/tokens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(tokens, /\[data-palette=["']?custom/);
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
