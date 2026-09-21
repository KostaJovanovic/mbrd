import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appearanceControlVisible,
  autoPaletteReady,
  AUTO_PALETTE_FLOOR,
  PALETTE_TOKENS,
  TYPOGRAPHY_TOKENS,
  mergeAppearance,
  splitAppearance,
  whimsyControlsSnap,
} from '../web/assets/js/layout-settings.ts';
import {
  board,
  loadBoard,
  setAppearance,
  setArrangement,
  setBoardMode,
  setSetting,
  serializeBoard,
} from '../web/assets/js/state.ts';
import { TOKENS } from '../web/assets/js/ui/look.ts';
import { hash } from './helpers.js';

const desktopFontHash = hash('desktop-font');
const mobileFontHash = hash('mobile-font');

test('appearance settings share palette and typography but keep local styling', () => {
  const look = {
    whimsy: 2,
    palette: 'photo',
    auto: false,
    derived: true,
    vars: {
      '--paper': '#fffaf0',
      '--accent': '#b4422f',
      '--radius': '14px',
      '--font-body': 'Example Sans',
      '--grid-alpha': '0.18',
    },
  };

  const { shared, local } = splitAppearance(look);

  assert.equal(shared.whimsy, 2);
  assert.equal(shared.palette, 'photo');
  assert.equal(shared.auto, false);
  assert.equal(shared.derived, true);
  assert.deepEqual(shared.vars, {
    '--paper': '#fffaf0',
    '--accent': '#b4422f',
    '--font-body': 'Example Sans',
  });
  assert.deepEqual(local.vars, {
    '--radius': '14px',
    '--grid-alpha': '0.18',
  });
});

test('shared palette values win when appearance profiles are merged', () => {
  const merged = mergeAppearance(
    { whimsy: 1, palette: 'ink', vars: { '--paper': '#fafafa' } },
    { vars: { '--paper': '#000', '--radius': '4px' } },
  );

  assert.equal(merged.whimsy, 1);
  assert.equal(merged.palette, 'ink');
  assert.deepEqual(merged.vars, {
    '--paper': '#fafafa',
    '--radius': '4px',
  });
});

test('whimsy never changes the Mobile profile snap choice', () => {
  assert.equal(whimsyControlsSnap('desktop'), true);
  assert.equal(whimsyControlsSnap('mobile'), false);
});

test('panel width is exposed only by the Desktop appearance controls', () => {
  assert.equal(appearanceControlVisible('--sidebar-w', 'desktop'), true);
  assert.equal(appearanceControlVisible('--sidebar-w', 'mobile'), false);
  assert.equal(appearanceControlVisible('--grid-alpha', 'mobile'), true);
});

test('a board colours itself at the third picture and not before', () => {
  // Extraction is on by default, so without this floor the first photo
  // dropped onto a fresh board turns the interface over uninvited.
  assert.equal(autoPaletteReady(0, false), false);
  assert.equal(autoPaletteReady(1, false), false);
  assert.equal(autoPaletteReady(2, false), false);
  assert.equal(autoPaletteReady(AUTO_PALETTE_FLOOR, false), true);
  assert.equal(autoPaletteReady(40, false), true);
});

test('a board already taking its colours from pictures follows them all the way down', () => {
  // The floor is about starting, not staying: a board already colouring
  // itself must not freeze when a picture is deleted below the floor, or a
  // colour it was thrown off would go on tinting it. Zero included: an empty
  // board's fallback is the caller's decision, not the gate's.
  for (const n of [0, 1, 2, 3]) {
    assert.equal(autoPaletteReady(n, true), true, `${n} pictures, already dynamic`);
  }
});

test('the shared appearance allowlist contains only palette colors', () => {
  assert.ok(PALETTE_TOKENS.includes('--paper'));
  assert.ok(PALETTE_TOKENS.includes('--accent'));
  assert.ok(!PALETTE_TOKENS.includes('--radius'));
  assert.ok(!PALETTE_TOKENS.includes('--font-body'));
  assert.ok(!PALETTE_TOKENS.includes('--grid-alpha'));
  assert.deepEqual(TYPOGRAPHY_TOKENS, ['--font-display', '--font-body']);
});

test('every shared token is one a look is allowed to carry', () => {
  // Three token lists, three different questions:
  //
  //   look.ts TOKENS             what a board may name at all (appearance.test.js)
  //   PALETTE_TOKENS/TYPOGRAPHY_TOKENS  which are shared across layouts (this file)
  //   appearance.ts AXIS_TOKENS  which the whimsy dial itself writes
  //
  // The missing edge was between the first two: a token added here but not
  // to TOKENS would be declared shared, then silently refused on the way in
  // - saved, carried in a .mbrd, never applied.
  for (const token of [...PALETTE_TOKENS, ...TYPOGRAPHY_TOKENS]) {
    assert.ok(TOKENS.has(token),
      `${token} is shared across layouts but is not on look.ts's allowlist, so a `
      + 'board carrying it would save it and never apply it');
  }
});

test('new Mobile profiles use the compact grid defaults and eight spaces', () => {
  setBoardMode('mobile');
  loadBoard({ items: [] });

  assert.equal(board.settings.mobileColumns, 8);
  assert.equal(board.settings.appearance.vars['--grid-alpha'], '0.20');
  assert.equal(board.settings.appearance.vars['--grid-dot'], '1px');

  setSetting('mobileColumns', 6);
  setAppearance({
    ...board.settings.appearance,
    vars: {
      ...board.settings.appearance.vars,
      '--grid-alpha': '0.31',
      '--grid-dot': '2.2px',
    },
  });
  const saved = serializeBoard();
  loadBoard(saved);

  assert.equal(board.settings.mobileColumns, 6);
  assert.equal(board.settings.appearance.vars['--grid-alpha'], '0.31');
  assert.equal(board.settings.appearance.vars['--grid-dot'], '2.2px');
});

test('Desktop and Mobile retain independent settings and local appearance', () => {
  setBoardMode('desktop');
  loadBoard({ items: [] });

  setSetting('gridStep', 80);
  setSetting('spacing', 36);
  setSetting('hud', true);
  setSetting('paperShow', true);
  setSetting('paper', 'a4');
  setSetting('paperLandscape', true);
  setSetting('paperResize', true);
  setSetting('fonts', [{ family: 'Desktop Face', hash: desktopFontHash }]);
  setArrangement('grid');
  setAppearance({
    whimsy: 2,
    palette: 'photo',
    auto: false,
    derived: true,
    vars: {
      '--paper': '#fffaf0',
      '--accent': '#b4422f',
      '--radius': '14px',
      '--font-body': 'Desktop Face',
    },
  });

  setBoardMode('mobile');
  assert.equal(board.settings.gridStep, 64);
  assert.equal(board.settings.spacing, 0);
  assert.equal(board.settings.hud, false);
  // Only `paperShow` is pinned by the switch. Mobile's profile carries a size
  // and an orientation of its own, at the defaults, ready for nothing.
  assert.equal(board.settings.paperShow, false);
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);
  assert.deepEqual(board.settings.fonts, [
    { family: 'Desktop Face', hash: desktopFontHash },
  ]);
  // Mobile reads its stored id through its own catalogue: 'spiral' is a
  // shape a column can't make, and 'fit' is the nearest order to it.
  // See MOBILE_ARRANGEMENTS in arrange/arrangements.ts.
  assert.equal(board.arrangement, 'fit');
  assert.equal(board.settings.appearance.whimsy, 2);
  assert.equal(board.settings.appearance.palette, 'photo');
  assert.equal(board.settings.appearance.auto, false);
  assert.equal(board.settings.appearance.derived, true);
  assert.equal(board.settings.appearance.vars['--paper'], '#fffaf0');
  assert.equal(board.settings.appearance.vars['--accent'], '#b4422f');
  assert.equal(board.settings.appearance.vars['--radius'], undefined);
  assert.equal(board.settings.appearance.vars['--font-body'], 'Desktop Face');

  setSetting('paperShow', true);
  setSetting('paper', 'letter');
  setSetting('paperLandscape', true);
  setSetting('paperResize', true);
  assert.equal(board.settings.paperShow, false, 'Mobile refuses a sheet after the switch too');
  assert.equal(board.settings.paper, 'a4', 'and the size that would have gone with it');
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);

  setSetting('gridStep', 48);
  setSetting('mobileColumns', 8);
  // Mobile's own gap, kept apart from Desktop's like every layout-local
  // setting. Starts at zero (a tight-packed column, as before) and isn't
  // refused - paper needs a page, a gap needs nothing.
  setSetting('spacing', 20);
  assert.equal(board.settings.spacing, 20, 'Mobile has a gap of its own');
  setSetting('hud', false);
  setSetting('fonts', [{ family: 'Mobile Face', hash: mobileFontHash }]);
  setArrangement('type');
  setAppearance({
    ...board.settings.appearance,
    vars: {
      ...board.settings.appearance.vars,
      '--paper': '#f4efe5',
      '--radius': '5px',
      '--font-body': 'Mobile Face',
    },
  });

  setBoardMode('desktop');
  assert.equal(board.settings.gridStep, 80);
  assert.equal(board.settings.mobileColumns, 6);
  assert.equal(board.settings.spacing, 36);
  assert.equal(board.settings.hud, true);
  assert.equal(board.settings.paperShow, true);
  assert.equal(board.settings.paper, 'a4');
  assert.equal(board.settings.paperLandscape, true);
  assert.equal(board.settings.paperResize, true);
  assert.deepEqual(board.settings.fonts, [
    { family: 'Mobile Face', hash: mobileFontHash },
  ]);
  assert.equal(board.arrangement, 'grid');
  assert.equal(board.settings.appearance.vars['--paper'], '#f4efe5');
  assert.equal(board.settings.appearance.vars['--radius'], '14px');
  assert.equal(board.settings.appearance.vars['--font-body'], 'Mobile Face');

  setBoardMode('mobile');
  assert.equal(board.settings.gridStep, 48);
  assert.equal(board.settings.mobileColumns, 8);
  assert.equal(board.settings.spacing, 20);
  assert.deepEqual(board.settings.fonts, [
    { family: 'Mobile Face', hash: mobileFontHash },
  ]);
  assert.equal(board.arrangement, 'type');
  assert.equal(board.settings.appearance.vars['--paper'], '#f4efe5');
  assert.equal(board.settings.appearance.vars['--radius'], '5px');
  assert.equal(board.settings.appearance.vars['--font-body'], 'Mobile Face');
});

test('layout settings round-trip in the responsive .mbrd schema', () => {
  // Its own board setup, not inherited: this used to read whatever the test
  // above left in the module singleton, so it proved nothing about a round
  // trip and failed when run alone. There's no beforeEach in this file.
  setBoardMode('desktop');
  loadBoard({ items: [] });
  setSetting('gridStep', 80);
  setSetting('mobileColumns', 6);
  setArrangement('grid');
  setAppearance({ ...board.settings.appearance, vars: { '--radius': '14px' } });

  setBoardMode('mobile');
  setSetting('gridStep', 48);
  setSetting('mobileColumns', 8);
  setSetting('spacing', 20);
  setArrangement('type');
  setAppearance({ ...board.settings.appearance, vars: { '--radius': '5px' } });

  const saved = serializeBoard();

  assert.equal(saved.layouts.desktop.settings.gridStep, 80);
  assert.equal(saved.layouts.desktop.arrangement, 'grid');
  assert.equal(saved.layouts.mobile.settings.gridStep, 48);
  assert.equal(saved.layouts.mobile.settings.mobileColumns, 8);
  assert.equal(saved.layouts.mobile.settings.spacing, 20);
  assert.equal(saved.layouts.mobile.arrangement, 'type');
  assert.equal(saved.layouts.desktop.settings.appearance.vars['--radius'], '14px');
  assert.equal(saved.layouts.mobile.settings.appearance.vars['--radius'], '5px');
  assert.equal(saved.settings.gridStep, 80);
  assert.equal(saved.arrangement, 'grid');

  loadBoard(saved);
  assert.equal(board.layoutMode, 'mobile', 'a load does not change the device choice');
  assert.equal(board.settings.gridStep, 48);
  assert.equal(board.settings.mobileColumns, 8);
  assert.equal(board.settings.appearance.vars['--radius'], '5px');
  setBoardMode('desktop');
  assert.equal(board.settings.gridStep, 80);
  assert.equal(board.settings.mobileColumns, 6);
  assert.equal(board.settings.appearance.vars['--radius'], '14px');
});
