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
} from '../web/assets/js/layout-settings.js';
import {
  board,
  loadBoard,
  setAppearance,
  setArrangement,
  setBoardMode,
  setSetting,
  serializeBoard,
} from '../web/assets/js/state.js';
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
  // The floor is the whole of the difference between a feature and a fault: the
  // extraction is on by default, so without it the first photograph dropped onto
  // a fresh board turns the entire interface over uninvited.
  assert.equal(autoPaletteReady(0, false), false);
  assert.equal(autoPaletteReady(1, false), false);
  assert.equal(autoPaletteReady(2, false), false);
  assert.equal(autoPaletteReady(AUTO_PALETTE_FLOOR, false), true);
  assert.equal(autoPaletteReady(40, false), true);
});

test('a board already taking its colours from pictures follows them all the way down', () => {
  // The floor is about starting, not about staying. A board that has been
  // colouring itself since its third photograph must not freeze at two when you
  // delete one - a colour thrown off the board would go on tinting the board it
  // was thrown off, which is the one case where the palette is provably not a
  // representation of the pictures any more. Zero included: an empty board hands
  // the sheet back, and that decision belongs to the caller, not to the gate.
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
  assert.equal(board.settings.paper, '');
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);
  assert.deepEqual(board.settings.fonts, [
    { family: 'Desktop Face', hash: desktopFontHash },
  ]);
  // Mobile reads its stored id through its own catalogue: 'spiral' is a shape a
  // column cannot make, and 'fit' is the order nearest to it. See
  // MOBILE_ARRANGEMENTS in arrange/arrangements.js.
  assert.equal(board.arrangement, 'fit');
  assert.equal(board.settings.appearance.whimsy, 2);
  assert.equal(board.settings.appearance.palette, 'photo');
  assert.equal(board.settings.appearance.auto, false);
  assert.equal(board.settings.appearance.derived, true);
  assert.equal(board.settings.appearance.vars['--paper'], '#fffaf0');
  assert.equal(board.settings.appearance.vars['--accent'], '#b4422f');
  assert.equal(board.settings.appearance.vars['--radius'], undefined);
  assert.equal(board.settings.appearance.vars['--font-body'], 'Desktop Face');

  setSetting('paper', 'letter');
  setSetting('paperLandscape', true);
  setSetting('paperResize', true);
  assert.equal(board.settings.paper, '', 'Mobile refuses a sheet after the switch too');
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);

  setSetting('gridStep', 48);
  setSetting('mobileColumns', 8);
  // Mobile's own gap, kept apart from Desktop's like every other layout-local
  // setting. It starts at zero - a column packed tight is what every board
  // written before this looked like - and it is not refused, which is the half
  // of the old rule that was wrong: paper needs a page, a gap needs nothing.
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
