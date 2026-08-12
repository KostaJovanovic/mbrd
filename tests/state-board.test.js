// The board itself: loading, serialising, refusing a file that is not one, and the faces it carries.
//
// state.js is a module singleton, which is right for an app with one board and
// awkward for tests, so every case starts by loading an empty board. That is
// the same door opening a .mbrd goes through, so it also exercises the reset.
//
// One of six files that were tests/state.test.js, split to mirror the modules
// state.js itself was split onto - see tests/layers.test.js for that list.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  board, selection, loadBoard, serializeBoard, addItems, removeItems, undo,
  redo, isDirty, markDirty, byId, topZ, select, duplicateItems, copyItems,
  cutItems, clipboardSize, renameItem, setSetting, setItemFit, snapshotGeom,
  applyGeom, commitGeom, setBoardMode, mobileBoardWidth, mobileBoardTop,
  mobileBoardBottom, baseStep, placeMobileItems, ensureTitleCard,
  restoreTitleCard, isTitleHidden, resetTitlePosition, TITLE_ID,
} from '../web/assets/js/state.js';
import { dropIdIndex } from '../web/assets/js/board-model.js';
import { itemBounds, overlapFraction, CELL_GAP } from '../web/assets/js/geometry.js';
import { hash } from './helpers.js';
import { fresh, note, photo } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
// ---------------------------------------------------------------------------
// Load and serialise
// ---------------------------------------------------------------------------

test('a loaded board is not dirty', () => {
  addItems([photo()]);
  assert.ok(isDirty());
  fresh();
  assert.ok(!isDirty(), 'opening a board must not present it as already edited');
});

test('loading clears the selection and the history', () => {
  const [a] = addItems([photo()]);
  select([a.id]);
  fresh();
  assert.equal(selection.size, 0);
  assert.equal(undo(), false);
});

test('serialising and reloading preserves the items', () => {
  addItems([photo({ x: 12.345, y: -6.7, name: 'a.png' }), note({ meta: { text: 'hi' } })]);
  const data = serializeBoard();
  fresh();
  loadBoard(data);
  assert.equal(board.items.length, 2);
  assert.equal(board.items[0].name, 'a.png');
  assert.equal(board.items[1].meta.text, 'hi');
});

test('opening a second board on Mobile does not read the first board index', () => {
  // byId()'s index is dropped on the 'items' event, which loadBoard() emits as
  // its second-to-last statement - after seedSticks(), completeLayout() and the
  // Mobile carry have all read the board through it. Until the index was dropped
  // where the array is *replaced*, every one of those reads was answered from
  // the board that had just left.
  //
  // On Mobile that threw: attachRiders() resolved the host through the live
  // board and then looked it up again through the index, which did not have it,
  // and stuckOffset() dereferenced undefined. The aftermath was the worse half -
  // openFile() catches, but board.items and board.title are already the new
  // board's with no event fired, so the old board's DOM sat over the new board's
  // state and the next autosave wrote the mixture over the session copy.
  //
  // A phone is in this mode from first paint (ui/sidebar.js reads the stored
  // pref), so "open a second .mbrd holding a stuck note" is the whole repro.
  fresh([photo({ id: 'only-in-a', x: 0, y: 0, w: 400, h: 300 })]);
  setBoardMode('mobile');
  byId('only-in-a');                       // populate the index against board A
  assert.doesNotThrow(() => loadBoard({
    title: 'B',
    items: [
      photo({ id: 'host', x: 0, y: 0, w: 400, h: 300, z: 1 }),
      note({ id: 'rider', x: 0, y: 0, w: 100, h: 100, z: 2 }),
    ],
  }));
  assert.equal(byId('only-in-a'), undefined, 'A is gone from the index');
  assert.equal(byId('host')?.id, 'host', 'and B is in it');
  setBoardMode('desktop');
});

test('the id index can be dropped without announcing anything', () => {
  // The tool loadBoard() reaches for, on its own. The lazy rebuild is keyed to
  // the 'items' event, which is right everywhere else and is exactly what cannot
  // be used at a swap: the emit comes at the end of the load and the reads come
  // in the middle. Dropping it has to be available *without* an announcement,
  // because announcing early would run every listener against a board that is
  // only half assembled.
  fresh([photo({ id: 'a' })]);
  byId('a');
  const before = board.items;
  board.items = [];
  assert.equal(byId('a')?.id, 'a', 'the index still describes the list that left');
  dropIdIndex();
  assert.equal(byId('a'), undefined);
  board.items = before;
  dropIdIndex();
});

test('two items with the longest legal id both survive the load', () => {
  // dedupeIds() suffixed and then truncated back to 64, so on an id already at
  // the cap every candidate was the id itself, `seen` rejected all of them and
  // the loop never ended - a hand-made or hand-edited file froze the tab on
  // open. research/docs/mbrd-format.md declares 64 legal, so this is a file the format
  // permits rather than a malformed one.
  const long = 'a'.repeat(64);
  loadBoard({
    title: 'T',
    items: [photo({ id: long, x: 0, y: 0 }), photo({ id: long, x: 10, y: 10 })],
    trash: [{ at: 1, item: photo({ id: long, x: 20, y: 20 }) }],
  });
  const ids = board.items.map(i => i.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set([...ids, board.trash[0].item.id]).size, 3, 'all three are distinct');
  for (const id of ids) assert.ok(id.length <= 64, `${id} is inside the cap`);
});

test('Mobile can use a six-column grid layout', () => {
  fresh([
    photo({ id: 'wide', x: 300, y: 200, w: 800, h: 400 }),
    note({ id: 'note', x: -500, y: 100 }),
  ]);

  assert.ok(setBoardMode('mobile'));
  setSetting('mobileColumns', 6);
  assert.equal(mobileBoardWidth(), 384);
  assert.equal(mobileBoardTop(), 384);
  const [wide, noteItem] = board.items;
  const inset = baseStep() * CELL_GAP;
  assert.equal(wide.w + 2 * inset, mobileBoardWidth());
  assert.equal(wide.meta.presnap.w + 2 * inset, mobileBoardWidth());
  assert.equal(
    wide.meta.presnap.h,
    wide.meta.presnap.w / 2,
    'the pre-grid fit keeps the original aspect ratio',
  );
  assert.equal((wide.h + 2 * inset) / baseStep(), 3, 'the visible item spans three rows');
  for (const item of board.items) {
    assert.ok(item.x - item.w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(item.x + item.w / 2 <= mobileBoardWidth() / 2);
    assert.equal(item.rot, 0);
  }
  assert.equal(
    wide.y + wide.h / 2,
    mobileBoardTop() - inset,
    'the first item starts at the first inset grid edge',
  );
  assert.ok(Math.abs(
    wide.y - wide.h / 2 - (noteItem.y + noteItem.h / 2) - 2 * inset,
  ) < 1e-9, 'adjacent grid spans keep the lattice seam');
});

test('Mobile can switch between six- and eight-column grids', () => {
  fresh(Array.from({ length: 4 }, (_, index) =>
    photo({ id: `card-${index}`, w: 100, h: 100 })));
  setBoardMode('mobile');
  assert.equal(board.settings.mobileColumns, 8, 'eight columns are the Mobile default');
  setSetting('mobileColumns', 6);
  assert.equal(board.settings.mobileColumns, 6);
  assert.equal(mobileBoardWidth(), 384);
  assert.notEqual(byId('card-0').y, byId('card-3').y,
    'six columns fit three two-cell cards per row');

  setSetting('mobileColumns', 8);
  assert.equal(board.settings.mobileColumns, 8);
  assert.equal(mobileBoardWidth(), 512);
  assert.equal(new Set(board.items.map(item => item.y)).size, 1,
    'eight columns fit four two-cell cards in the first row');
  for (let i = 0; i < board.items.length; i++) {
    assert.ok(board.items[i].x - board.items[i].w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(board.items[i].x + board.items[i].w / 2 <= mobileBoardWidth() / 2);
    for (let j = i + 1; j < board.items.length; j++) {
      assert.equal(overlapFraction(board.items[i], board.items[j]), 0);
    }
  }

  setBoardMode('desktop');
  assert.equal(board.settings.mobileColumns, 6, 'Desktop does not inherit the Mobile width');
  setSetting('mobileColumns', 8);
  assert.equal(board.settings.mobileColumns, 6, 'Desktop cannot change the Mobile-only setting');
  setBoardMode('mobile');
  assert.equal(board.settings.mobileColumns, 8, 'the Mobile profile keeps its choice');
});

test('missing or invalid Mobile grid widths fall back to eight columns', () => {
  setBoardMode('mobile');
  setSetting('mobileColumns', 6);
  loadBoard({ items: [] });
  assert.equal(board.settings.mobileColumns, 8,
    'a new board does not inherit the previous board width');

  loadBoard({
    items: [],
    layouts: {
      mobile: { items: [], settings: { mobileColumns: 7 } },
    },
  });
  assert.equal(board.settings.mobileColumns, 8);
});

test('a new Mobile board starts with grid snapping on', () => {
  fresh();
  assert.equal(board.settings.snap, false);
  setBoardMode('mobile');
  assert.equal(board.settings.snap, true);
  fresh();
  assert.equal(board.settings.snap, true, 'New keeps the Mobile default');
  loadBoard({ title: 'Saved choice', settings: { snap: false } });
  assert.equal(board.settings.snap, false, 'an opened board keeps its explicit choice');
});

test('a Mobile folder import is appended without overlaps', () => {
  fresh();
  setBoardMode('mobile');
  addItems([photo({ id: 'existing', x: 0, y: 0, w: 300, h: 220 })]);
  const imported = addItems([
    photo({ x: 900, y: 100, w: 800, h: 400 }),
    note({ x: -900, y: 100, w: 260, h: 180 }),
    photo({ x: 0, y: 100, w: 320, h: 500 }),
  ], 'Add folder', { avoidOverlap: true });

  const all = [byId('existing'), ...imported];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.equal(overlapFraction(all[i], all[j]), 0,
        `${all[i].id} overlaps ${all[j].id}`);
    }
  }
  for (const item of imported) {
    assert.ok(item.x - item.w / 2 >= -mobileBoardWidth() / 2);
    assert.ok(item.x + item.w / 2 <= mobileBoardWidth() / 2);
  }

  setSetting('snap', false);
  for (let i = 0; i < board.items.length; i++) {
    for (let j = i + 1; j < board.items.length; j++) {
      assert.equal(overlapFraction(board.items[i], board.items[j]), 0,
        'leaving the grid restored an overlapping import');
    }
  }
});

test('Mobile placement packs a large batch into grid rows and columns', () => {
  fresh();
  setBoardMode('mobile');
  const batch = Array.from({ length: 60 }, (_, i) =>
    photo({ id: `dense-${i}`, x: 0, y: 0, w: [100, 164, 228][i % 3], h: 100 }));
  const placed = placeMobileItems(batch, []);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(overlapFraction(placed[i], placed[j]) < 1e-12,
        `${placed[i].id} overlaps ${placed[j].id}`);
    }
  }

  const step = baseStep();
  const inset = step * CELL_GAP;
  for (const item of placed) {
    const bounds = itemBounds([item]);
    assert.ok(Math.abs((bounds.x0 - inset) / step -
      Math.round((bounds.x0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((bounds.y0 - inset) / step -
      Math.round((bounds.y0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((item.w + 2 * inset) / step -
      Math.round((item.w + 2 * inset) / step)) < 1e-9);
    assert.ok(Math.abs((item.h + 2 * inset) / step -
      Math.round((item.h + 2 * inset) / step)) < 1e-9);
  }
  assert.equal(placed[0].y, placed[1].y, 'compatible spans share a row');
  assert.ok(placed[0].x < placed[1].x, 'the shared row fills left to right');
  assert.ok(new Set(placed.slice(0, 6).map(item => item.x)).size > 1,
    'packing uses more than the centre column');
});

test('the Mobile gap widens the seam and nothing else', () => {
  fresh();
  setBoardMode('mobile');
  const step = baseStep();
  const batch = () => Array.from({ length: 12 }, (_, i) =>
    photo({ id: `gap-${i}`, x: 0, y: 0, w: 100, h: 100 }));

  // Zero is the default a Mobile profile is born with, and at zero the packer
  // is the one that shipped before the setting existed.
  assert.equal(board.settings.spacing, 0);
  const tight = placeMobileItems(batch(), []);

  const gap = 24;
  setSetting('spacing', gap);
  assert.equal(board.settings.spacing, gap, 'Mobile takes a gap now');
  const loose = placeMobileItems(batch(), []);

  // Still packed, still non-overlapping, and still on the lattice - the gap
  // buys room around each card, it does not change what the packer is doing.
  for (let i = 0; i < loose.length; i++) {
    for (let j = i + 1; j < loose.length; j++) {
      assert.ok(overlapFraction(loose[i], loose[j]) < 1e-12,
        `${loose[i].id} overlaps ${loose[j].id}`);
    }
  }
  // Each card claims more of the column, so the same twelve run further down
  // it. Measured on the lowest edge, which is the only thing a reader of a
  // phone board would notice.
  const bottom = list => Math.min(...list.map(it => it.y - it.h / 2));
  assert.ok(bottom(loose) < bottom(tight), 'a gap did not lengthen the column');

  // And every neighbour in a row is at least the gap apart, seam included.
  const rows = new Map();
  for (const it of loose) {
    const key = it.y.toFixed(6);
    (rows.get(key) || rows.set(key, []).get(key)).push(it);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const between = (row[i].x - row[i].w / 2) - (row[i - 1].x + row[i - 1].w / 2);
      assert.ok(between >= gap - 1e-9,
        `${row[i - 1].id} and ${row[i].id} are ${between.toFixed(2)} apart, under the ${gap} asked for`);
    }
  }

  setSetting('spacing', 0);
  assert.equal(step, baseStep());
});

test('Mobile rearrangement preserves visible sizes and stays inside cell seams', () => {
  fresh();
  setBoardMode('mobile');
  const step = baseStep();
  const inset = step * CELL_GAP;
  const latticeSizes = [
    { w: 2 * step - 2 * inset, h: step - 2 * inset },
    { w: step - 2 * inset, h: 2 * step - 2 * inset },
    { w: 3 * step - 2 * inset, h: 2 * step - 2 * inset },
  ];
  const items = latticeSizes.map((size, index) => photo({
    id: `stable-${index}`,
    ...size,
    meta: {
      presnap: {
        x: 800 - index * 300,
        y: index * 90,
        w: 91 + index * 17,
        h: 73 + index * 13,
      },
    },
  }));

  const first = placeMobileItems(items, [], { preserveSize: true });
  const second = placeMobileItems(first, [], { preserveSize: true });
  assert.deepEqual(
    second.map(item => ({ w: item.w, h: item.h })),
    latticeSizes,
    'repeated rearrangement must not rebuild visible sizes from presnap',
  );

  for (const item of second) {
    const bounds = itemBounds([item]);
    assert.ok(Math.abs((bounds.x0 - inset) / step -
      Math.round((bounds.x0 - inset) / step)) < 1e-9);
    assert.ok(Math.abs((bounds.y1 + inset) / step -
      Math.round((bounds.y1 + inset) / step)) < 1e-9);
    assert.ok(bounds.x0 >= -mobileBoardWidth() / 2 + inset - 1e-9);
    assert.ok(bounds.x1 <= mobileBoardWidth() / 2 - inset + 1e-9);
  }
  for (let i = 0; i < second.length; i++) {
    for (let j = i + 1; j < second.length; j++) {
      assert.equal(overlapFraction(second[i], second[j]), 0);
    }
  }
});

test('Mobile keeps freely moved items clear of the board border', () => {
  fresh();
  setBoardMode('mobile');
  setSetting('snap', false);
  const step = baseStep();
  const inset = step * CELL_GAP;
  const [item] = addItems([photo({
    id: 'edge',
    x: -10000,
    y: 10000,
    w: mobileBoardWidth(),
    h: 100,
  })]);
  const bounds = itemBounds([item]);

  assert.equal(item.w, mobileBoardWidth() - 2 * inset);
  assert.ok(Math.abs(bounds.x0 - (-mobileBoardWidth() / 2 + inset)) < 1e-9);
  assert.ok(Math.abs(bounds.x1 - (mobileBoardWidth() / 2 - inset)) < 1e-9);
  assert.ok(Math.abs(bounds.y1 - (mobileBoardTop() - inset)) < 1e-9);
});

test('a Mobile rearrangement can restore its collision-free unsnapped grid', () => {
  fresh([
    photo({ id: 'left', x: 900, y: 0, w: 100, h: 100 }),
    photo({ id: 'right', x: -900, y: 0, w: 164, h: 100 }),
  ]);
  setBoardMode('mobile');
  const before = snapshotGeom(['left', 'right']);
  const packed = placeMobileItems(board.items, []);
  applyGeom(before.map((geometry, index) => ({
    ...geometry,
    x: packed[index].x,
    y: packed[index].y,
    w: packed[index].w,
    h: packed[index].h,
    rot: packed[index].rot,
    presnap: packed[index].meta.presnap,
  })));
  commitGeom('Rearrange', before, ['left', 'right'], { preservePresnap: true });

  const packedX = byId('left').x;
  undo();
  assert.equal(byId('left').x, before[0].x);
  assert.deepEqual(byId('left').meta.presnap, before[0].presnap);
  redo();
  assert.equal(byId('left').x, packedX);

  setSetting('snap', false);
  assert.equal(byId('left').y, byId('right').y, 'the raw spans still share a row');
  assert.equal(overlapFraction(byId('left'), byId('right')), 0);
});

test('Mobile is at least twenty-five rows tall and follows its lowest item', () => {
  fresh([photo({ id: 'card', w: 200, h: 100 })]);
  setBoardMode('mobile');

  const step = baseStep();
  const inset = step * CELL_GAP;
  assert.equal(mobileBoardTop() - mobileBoardBottom(), 25 * step);
  applyGeom([{ ...snapshotGeom(['card'])[0], y: 100000 }]);
  assert.equal(byId('card').y + byId('card').h / 2, mobileBoardTop() - inset);
  applyGeom([{ ...snapshotGeom(['card'])[0], y: -100000 }]);
  assert.equal(byId('card').y, -100000);
  assert.equal(
    mobileBoardBottom(),
    byId('card').y - byId('card').h / 2 - 15 * step,
  );
});

test('Desktop and Mobile keep independent geometry in one file', () => {
  fresh([photo({ id: 'card', x: 120, y: 40, w: 200, h: 100 })]);

  setBoardMode('mobile');
  applyGeom([{ ...snapshotGeom(['card'])[0], x: 0, y: -700, w: 300, h: 180 }]);
  setBoardMode('desktop');
  assert.equal(byId('card').x, 120);
  applyGeom([{ ...snapshotGeom(['card'])[0], x: 500, y: 80 }]);

  setBoardMode('mobile');
  assert.equal(byId('card').y, -700);
  const data = serializeBoard();
  assert.equal(data.items[0].x, 500, 'the legacy item geometry stays Desktop');
  assert.equal(data.layouts.desktop.items[0].x, 500);
  assert.equal(data.layouts.mobile.items[0].y, -700);
  assert.equal('layoutMode' in data, false, 'the device choice does not travel');

  loadBoard(data);
  assert.equal(byId('card').y, -700);
  setBoardMode('desktop');
  assert.equal(byId('card').x, 500);
});

test('content is shared between both layouts, settings are not', () => {
  fresh([note({ id: 'shared', name: 'before', meta: { text: 'same note' } })]);
  setBoardMode('mobile');
  renameItem('shared', 'after');
  setSetting('spacing', 36);
  setBoardMode('desktop');

  // One set of items under two arrangements: a rename made in either is a
  // rename of the same note.
  assert.equal(byId('shared').name, 'after');
  assert.equal(byId('shared').meta.text, 'same note');

  // Spacing is layout-local, so each of the two keeps the gap it was given and
  // neither can see the other's - see research/docs/layout-settings.md. Mobile starts at
  // zero rather than at Desktop's 12, which is what every board saved before it
  // had a gap of its own actually looked like.
  assert.equal(board.settings.spacing, 12, 'Desktop keeps its own spacing');
  setBoardMode('mobile');
  assert.equal(board.settings.spacing, 36, 'Mobile keeps the gap it was given');
});

test('The board name style is board-wide, editable from either layout, and round-trips', () => {
  fresh();
  setBoardMode('mobile');
  setSetting('mobileHeader', {
    font: 'Fraunces',
    size: 17.5,
    stretch: 135,
    weight: 625,
    italic: true,
    axes: { opsz: 72, BAD: 4, 'TOO-LONG': 9 },
  });
  // Board-level now (board.mobileHeader), not per-layout: the Mobile masthead
  // and the Desktop title card are one style. Bad or over-long axis tags are
  // dropped; the unwritten fields land on their defaults - 100 is the face's own
  // line height, wrap is on, offset centres. See DEFAULT_MOBILE_HEADER.
  assert.deepEqual(board.mobileHeader, {
    font: 'Fraunces',
    size: 17.5,
    stretch: 135,
    leading: 100,
    weight: 625,
    offset: 0,
    italic: true,
    wrap: true,
    axes: { opsz: 72 },
  });

  const data = serializeBoard();

  // Shared, not per-layout: Desktop sees the very same style...
  setBoardMode('desktop');
  assert.equal(board.mobileHeader.size, 17.5, 'Desktop sees the shared style');
  // ...and may edit it (the title card's pen), with Mobile then seeing the change.
  setSetting('mobileHeader', { ...board.mobileHeader, size: 24 });
  assert.equal(board.mobileHeader.size, 24, 'Desktop can edit the shared style');
  setBoardMode('mobile');
  assert.equal(board.mobileHeader.size, 24, 'the edit crossed to the other layout');

  // The serialised style comes back whole.
  loadBoard(data);
  assert.equal(board.mobileHeader.size, 17.5);
  assert.equal(board.mobileHeader.stretch, 135);
  assert.equal(board.mobileHeader.leading, 100);
  assert.equal(board.mobileHeader.weight, 625);
  assert.equal(board.mobileHeader.italic, true);
  assert.deepEqual(board.mobileHeader.axes, { opsz: 72 });
});

test('media fit is a board-wide default with an undoable per-item override', () => {
  fresh([
    { id: 'pic', type: 'image', asset: { hash: hash('a'), embedded: true } },
    { id: 'clip', type: 'video', asset: { hash: hash('b'), embedded: true } },
  ]);
  // Defaults to fit (fill is opt-in), whatever a caller passes that is not the
  // one other value.
  assert.equal(board.mediaFit, 'contain');

  // Board-wide, and one value for both layouts.
  setSetting('mediaFit', 'cover');
  assert.equal(board.mediaFit, 'cover');
  setBoardMode('mobile');
  assert.equal(board.mediaFit, 'cover', 'the default is board-wide, not per-layout');
  setBoardMode('desktop');

  // A per-item override is undoable and independent of the default.
  setItemFit('pic', 'contain');
  assert.equal(byId('pic').meta.fit, 'contain');
  undo();
  assert.equal(byId('pic').meta.fit, undefined, 'undo clears the override');
  redo();
  assert.equal(byId('pic').meta.fit, 'contain', 'redo restores it');

  // Only photos and videos are steerable, and the value is validated.
  setItemFit('clip', 'sideways');
  assert.equal(byId('clip').meta.fit, undefined, 'a bad value is ignored');

  // Both the default and the override survive a round-trip.
  const data = serializeBoard();
  loadBoard(data);
  assert.equal(board.mediaFit, 'cover', 'the board default round-trips');
  assert.equal(byId('pic').meta.fit, 'contain', 'the per-item override round-trips');
});

test('paletteSources is a board-wide count, clamped and round-tripped', () => {
  fresh();
  assert.equal(board.paletteSources, 12, 'defaults to the count the feature always used');

  setSetting('paletteSources', 6);
  assert.equal(board.paletteSources, 6);
  setBoardMode('mobile');
  assert.equal(board.paletteSources, 6, 'the count is board-wide, not per-layout');
  setBoardMode('desktop');

  // Clamped to [1, 24] and rounded, whatever a caller or an edited file offers.
  setSetting('paletteSources', 99);
  assert.equal(board.paletteSources, 24, 'held under the sampler ceiling');

  // Except 0, which is the stop past the top of the dial: every picture on the
  // board. It used to be clamped up to 1, which is the opposite reading - the
  // dullest palette available rather than the fullest one.
  setSetting('paletteSources', 0);
  assert.equal(board.paletteSources, 0, 'zero means every picture');
  setSetting('paletteSources', -3);
  assert.equal(board.paletteSources, 1, 'and below zero is still at least one');
  setSetting('paletteSources', 0);

  const data = serializeBoard();
  loadBoard(data);
  assert.equal(board.paletteSources, 0, 'round-trips');
  loadBoard({ title: 'T', items: [] });
  assert.equal(board.paletteSources, 12, 'a file without the key reads as the default');
});

test('A board that stored the name style under settings still loads it', () => {
  fresh();
  // Files written before the style moved to board level carry it inside
  // settings; loadBoard reads that as the fallback source.
  loadBoard({ settings: { mobileHeader: { font: 'Georgia', size: 20 } } });
  assert.equal(board.mobileHeader.font, 'Georgia');
  assert.equal(board.mobileHeader.size, 20);
});

test('the title card is a singleton the app seeds and holds to one', () => {
  fresh();
  // loadBoard leaves it to the app - a bare board of items carries none.
  assert.equal(board.items.filter(i => i.type === 'title').length, 0);
  ensureTitleCard();
  const titles = board.items.filter(i => i.type === 'title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].id, TITLE_ID);
  ensureTitleCard();
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'seeding twice adds nothing');
});

test('deleting the title card hides it rather than binning it, and undo reverses that', () => {
  fresh();
  ensureTitleCard();
  const binned = board.trash.length;
  removeItems([TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  assert.equal(board.items.some(i => i.type === 'title'), false);
  assert.equal(board.trash.length, binned, 'the title card never enters the bin');
  undo();
  assert.equal(isTitleHidden(), false);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true, 'undo puts it back');
});

test('a mixed delete bins the ordinary items and only hides the title card', () => {
  fresh([photo({ id: 'p' })]);
  ensureTitleCard();
  removeItems(['p', TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  assert.equal(board.trash.length, 1, 'the photo is binned');
  assert.equal(board.trash[0].item.id, 'p');
  assert.equal(board.trash.some(t => t.item.id === TITLE_ID), false);
});

test('restoreTitleCard brings the deleted card back', () => {
  fresh();
  ensureTitleCard();
  removeItems([TITLE_ID]);
  assert.equal(isTitleHidden(), true);
  restoreTitleCard();
  assert.equal(isTitleHidden(), false);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true);
});

test('the title card and its deleted state survive a save and reload', () => {
  fresh();
  ensureTitleCard();
  loadBoard(serializeBoard());
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'the saved card comes back');
  assert.equal(isTitleHidden(), false);

  removeItems([TITLE_ID]);
  loadBoard(serializeBoard());
  assert.equal(isTitleHidden(), true, 'the deleted state persists');
  ensureTitleCard();
  assert.equal(board.items.some(i => i.type === 'title'), false,
    'a board that threw the card away keeps it away');
});

test('the title card cannot be copied, cut or duplicated, and a group skips it', () => {
  fresh([photo({ id: 'a', w: 100, h: 100 })]);
  ensureTitleCard();

  // On its own: nothing lands on the clipboard, nothing is duplicated.
  assert.equal(copyItems([TITLE_ID]), '', 'the title card copies to nothing');
  assert.equal(clipboardSize(), 0);
  assert.equal(duplicateItems([TITLE_ID]).length, 0, 'the title card does not duplicate');
  assert.equal(board.items.filter(i => i.type === 'title').length, 1, 'still a singleton');

  // In a group: the ordinary card comes along, the title card is left behind.
  copyItems(['a', TITLE_ID]);
  assert.equal(clipboardSize(), 1, 'only the ordinary card is on the clipboard');
  const copies = duplicateItems(['a', TITLE_ID]);
  assert.equal(copies.length, 1, 'the group duplicates without the title card');
  assert.equal(copies.every(c => c.type !== 'title'), true);

  // Cutting a group leaves the title card on the board (not copied, not binned).
  cutItems(['a', TITLE_ID]);
  assert.equal(board.items.some(i => i.id === TITLE_ID), true, 'the title card survives a cut');
});

test('resetTitlePosition sends the card home, undoably, and no-ops when already there', () => {
  fresh();
  ensureTitleCard();
  const title = () => board.items.find(i => i.type === 'title');
  const home = { x: title().x, y: title().y };

  resetTitlePosition();
  assert.equal(undo(), false, 'already home: nothing to undo');

  applyGeom([{ id: title().id, x: 500, y: -500, w: title().w, h: title().h, rot: 0, z: title().z }]);
  resetTitlePosition();
  assert.deepEqual({ x: title().x, y: title().y }, home, 'back to the default spot');
  assert.ok(undo(), 'the reset is one undo step');
  assert.deepEqual({ x: title().x, y: title().y }, { x: 500, y: -500 }, 'undo restores where it was');
});

test('Mobile refuses a paper sheet however it is asked', () => {
  fresh([photo({ id: 'card', w: 200, h: 100 })]);
  setSetting('paper', 'a4');
  setSetting('paperResize', true);

  setBoardMode('mobile');
  assert.equal(board.settings.paper, '', 'the switch takes the sheet down');
  assert.equal(board.settings.paperResize, false);

  // The switch-time fixup runs once; this is the write that used to get past it.
  setSetting('paper', 'letter');
  setSetting('paperLandscape', true);
  setSetting('paperResize', true);
  assert.equal(board.settings.paper, '');
  assert.equal(board.settings.paperLandscape, false);
  assert.equal(board.settings.paperResize, false);

  setBoardMode('desktop');
  assert.equal(board.settings.paper, 'a4', 'Desktop still has the sheet it had');
  assert.equal(board.settings.paperResize, true);
});

// ---------------------------------------------------------------------------
// Loading a board that is not one
//
// board.json arrives parsed but unvalidated, out of a file this app did not
// necessarily write. There is no undo across a load, so a load that fails
// half-way has no way back - which makes "all or nothing" the only acceptable
// outcome, and these are the shapes that used to break it.
// ---------------------------------------------------------------------------

test('a board whose items are not a list does not replace anything', () => {
  addItems([photo({ name: 'keep.png' })]);
  loadBoard({ title: 'poison', items: {} });
  assert.equal(board.title, 'poison', 'the load should still complete');
  assert.equal(board.items.length, 0);
  // The failure mode this replaced: title taken from the new board, items left
  // over from the old one, and no way back to either.
  assert.equal(serializeBoard().items.length, 0);
});

test('junk in the item list is dropped, not thrown over', () => {
  loadBoard({ title: 'T', items: [null, 'nonsense', 42, { type: 'note' }] });
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].type, 'note');
});

test('settings that are not an object fall back to the defaults', () => {
  loadBoard({ title: 'T', items: [], settings: 'nope' });
  assert.equal(board.settings.grid, true);
  assert.deepEqual(board.settings.appearance.vars, {});
});

test('a trash entry with no item is skipped', () => {
  loadBoard({ title: 'T', items: [], trash: [{ at: 1 }, null, { at: 2, item: { type: 'note' } }] });
  assert.equal(board.trash.length, 1);
});

test('an item field of the wrong type falls back rather than throwing', () => {
  loadBoard({ title: 'T', items: [{ id: 7, x: 'left', w: null, meta: 'text', name: 12 }] });
  const [it] = board.items;
  assert.equal(typeof it.id, 'string');
  assert.equal(it.x, 0);
  assert.equal(it.w, 240);
  assert.equal(it.name, '');
  assert.deepEqual(it.meta, {});
});

test('coordinates are rounded on the way out, not mangled', () => {
  addItems([photo({ x: 1 / 3, y: -2 / 3 })]);
  const data = serializeBoard();
  assert.equal(data.items[0].x, 0.33);
  assert.equal(data.items[0].y, -0.67);
});

// --- persisted-state invariants (AUD-07) -----------------------------------

test('infinite and non-positive geometry is refused on load', () => {
  loadBoard({ title: 'T', items: [{ id: 'a', x: Infinity, y: -Infinity, w: -5, h: 0, rot: NaN }] });
  const [it] = board.items;
  assert.equal(it.x, 0);
  assert.equal(it.y, 0);
  assert.equal(it.w, 240);
  assert.equal(it.h, 180);
  assert.equal(it.rot, 0);
});

test('a coordinate far past the range is clamped, not carried', () => {
  loadBoard({ title: 'T', items: [{ id: 'a', x: 1e9, y: -1e9 }] });
  const [it] = board.items;
  assert.equal(it.x, 1e7);
  assert.equal(it.y, -1e7);
});

test('duplicate item ids are made unique on load', () => {
  loadBoard({ title: 'T', items: [
    { id: 'dup', type: 'note' }, { id: 'dup', type: 'note' }, { id: 'dup', type: 'note' },
  ] });
  const ids = board.items.map(i => i.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'dup');
});

test('a restored bin item cannot collide with a live id', () => {
  loadBoard({ title: 'T',
    items: [{ id: 'x', type: 'note' }],
    trash: [{ at: 1, item: { id: 'x', type: 'note' } }] });
  assert.notEqual(board.items[0].id, board.trash[0].item.id);
});

test('an over-long items array is capped on load', () => {
  const many = Array.from({ length: 20050 }, (_, i) => ({ id: 'i' + i, type: 'note' }));
  loadBoard({ title: 'T', items: many });
  assert.equal(board.items.length, 20000);
});

test('the bin travels with the board', () => {
  const [a] = addItems([photo({ name: 'gone.png' })]);
  removeItems([a.id]);
  const data = serializeBoard();
  assert.equal(data.trash.length, 1);
  fresh();
  loadBoard(data);
  assert.equal(board.trash.length, 1, 'saving must not be a trapdoor under the bin');
  assert.equal(board.trash[0].item.name, 'gone.png');
});

test('topZ grows as items are added', () => {
  assert.equal(topZ(), 0);
  addItems([photo(), photo()]);
  assert.equal(topZ(), 2);
  addItems([photo()]);
  assert.equal(topZ(), 3);
});

test('markDirty is idempotent', () => {
  fresh();
  assert.ok(!isDirty());
  markDirty(true);
  markDirty(true);
  assert.ok(isDirty());
  markDirty(false);
  assert.ok(!isDirty());
});

// ---------------------------------------------------------------------------
// The faces a board carries
// ---------------------------------------------------------------------------

const FONT_HASH = 'a'.repeat(64);
const FONT_HASH_2 = 'b'.repeat(64);

test('a board with no font list gets an empty one, not undefined', () => {
  fresh();
  assert.deepEqual(board.settings.fonts, []);
  // And it survives the round trip out, so the packer has something to walk.
  assert.deepEqual(serializeBoard().settings.fonts, []);
});

test('a well-formed font list is carried through', () => {
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    { hash: FONT_HASH, family: 'Test Face' },
    { hash: FONT_HASH_2, family: 'Other' },
  ] } });
  assert.deepEqual(board.settings.fonts, [
    { hash: FONT_HASH, family: 'Test Face' },
    { hash: FONT_HASH_2, family: 'Other' },
  ]);
});

test('custom font axes survive but malformed axis metadata does not', () => {
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    {
      hash: FONT_HASH,
      family: 'Variable Face',
      axes: [
        { tag: 'wght', min: 100, default: 425, max: 900 },
        { tag: 'bad', min: 0, default: 0, max: 1 },
        { tag: 'opsz', min: 9, default: 500, max: 144 },
      ],
    },
  ] } });
  assert.deepEqual(board.settings.fonts, [{
    hash: FONT_HASH,
    family: 'Variable Face',
    axes: [
      { tag: 'wght', min: 100, default: 425, max: 900 },
      { tag: 'opsz', min: 9, default: 144, max: 144 },
    ],
  }]);
});

test('a font entry that could break a stylesheet is dropped', () => {
  // The family becomes a CSS family name inside a real declaration, out of a
  // .mbrd somebody else wrote. One bad entry costs its own entry - the same
  // bargain `vars` gets - rather than costing the board its other faces.
  loadBoard({ title: 'T', items: [], settings: { fonts: [
    { hash: FONT_HASH, family: 'a", monospace; display: none; "' },
    { hash: FONT_HASH_2, family: 'Good' },
    { hash: 'not-a-hash', family: 'Good' },
    { hash: FONT_HASH_2, family: 'Duplicate hash' },
    { family: 'No hash' },
    { hash: 'c'.repeat(64) },
    'not an object',
    null,
  ] } });
  assert.deepEqual(board.settings.fonts, [{ hash: FONT_HASH_2, family: 'Good' }]);
});

test('a font list is not a list', () => {
  for (const junk of ['fonts', 42, { hash: FONT_HASH }, null]) {
    loadBoard({ title: 'T', items: [], settings: { fonts: junk } });
    assert.deepEqual(board.settings.fonts, []);
  }
});

test('a board cannot carry a thousand faces', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    hash: String(i).padStart(64, '0'), family: 'Face ' + i,
  }));
  loadBoard({ title: 'T', items: [], settings: { fonts: many } });
  assert.equal(board.settings.fonts.length, 8);
});

test('the defaults are not shared between boards', () => {
  // DEFAULT_SETTINGS holds `fonts` by reference, so a board that pushed onto it
  // in place would be editing the defaults every later board is built from.
  fresh();
  board.settings.fonts.push({ hash: FONT_HASH, family: 'Leaked' });
  fresh();
  assert.deepEqual(board.settings.fonts, []);
});

