// Items on the board: what they are called, what they say, and what is picked.
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
  byId, select, deselect, clearSelection, selectAll, setItemText, renameItem,
  NOTE_MAX, setItemCover, setItemPoster, setTitle, cleanBoardTitle,
  cleanBoardTitleDraft, BOARD_TITLE_MAX, setBoardMode, setItemBare,
} from '../web/assets/js/state.ts';
import { hash } from './helpers.js';
import { fresh, note, photo, clip } from './state-fixtures.js';

beforeEach(() => {
  setBoardMode('desktop');
  fresh();
});
test('board names are short portable filename stems wherever they enter state', () => {
  assert.equal(BOARD_TITLE_MAX, 32);
  assert.equal(cleanBoardTitleDraft('Mood '), 'Mood ',
    'live editing keeps the trailing space needed to type another word');
  assert.equal(cleanBoardTitleDraft('Mood Board'), 'Mood Board');
  assert.equal(cleanBoardTitle('  My / Board:*?  '), 'My Board');
  assert.equal(cleanBoardTitle('Mood Board'), 'Mood Board');
  assert.equal(cleanBoardTitle('123456789012345678901234567890123'), '12345678901234567890123456789012');
  assert.equal(cleanBoardTitle('CON'), '_CON', 'Windows device names are not filenames');
  assert.equal(cleanBoardTitle('A title.  '), 'A title');

  setTitle('An / invalid : board title');
  assert.equal(board.title, 'An invalid board title');

  loadBoard({ title: 'A far too long loaded board name that keeps going', items: [] });
  assert.equal(board.title, 'A far too long loaded board name',
    'opened boards obey the same limit as names typed in the UI');
});

test('a video still fills an empty picture slot and never replaces a chosen one', () => {
  const cut = hash('poster');
  const chosen = hash('chosen');

  // The case the whole thing exists for: a clip with nothing to show, which on
  // a phone is a black rectangle until it is tapped.
  const [a] = addItems([clip()]);
  setItemPoster(a.id, cut);
  assert.equal(byId(a.id).meta.cover, cut);

  // Derived output, so no history entry of its own - the same bargain
  // setItemThumb makes. If this were undoable, the optimiser's stills pass
  // would spend one slot per clip on a board of video and throw the session's
  // real undo away. One undo goes straight past it to the add.
  assert.ok(undo());
  assert.equal(board.items.length, 0, 'the still was not an entry between here and the add');

  // A picture somebody chose outranks a frame cut from the clip, and this is
  // what makes the non-undoable write safe: it can only ever add.
  const [b] = addItems([clip()]);
  setItemCover(b.id, chosen);
  setItemPoster(b.id, cut);
  assert.equal(byId(b.id).meta.cover, chosen);

  // Undoing the *choice* leaves the slot empty rather than falling back to a
  // still that was never stored.
  assert.ok(undo());
  assert.equal(byId(b.id).meta?.cover, undefined);
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test('a note is capped on the way in', () => {
  const [a] = addItems([note({ meta: { text: 'x'.repeat(NOTE_MAX + 500) } })]);
  assert.equal(a.meta.text.length, NOTE_MAX);
});

test('editing a note is undoable', () => {
  const [a] = addItems([note({ meta: { text: 'before' } })]);
  setItemText(a.id, 'after');
  assert.equal(byId(a.id).meta.text, 'after');
  undo();
  assert.equal(byId(a.id).meta.text, 'before');
});

test('setting a note to what it already says commits nothing', () => {
  const [a] = addItems([note({ meta: { text: 'same' } })]);
  setItemText(a.id, 'same');
  assert.equal(undo(), true, 'the only undo entry should be the add');
  assert.equal(board.items.length, 0);
});

test('an empty rename falls back to the name rather than clearing it', () => {
  const [a] = addItems([photo({ name: 'holiday.jpg' })]);
  renameItem(a.id, '   ');
  assert.equal(byId(a.id).name, 'holiday.jpg', 'clearing a name is a one-way door');
});

test('clearing a name gives back the file it arrived as', () => {
  const [a] = addItems([photo({ name: 'DSC_0431.JPG', meta: { origName: 'DSC_0431.JPG' } })]);
  renameItem(a.id, 'Sunset over the bay');
  assert.equal(byId(a.id).name, 'Sunset over the bay');
  renameItem(a.id, '');
  assert.equal(byId(a.id).name, 'DSC_0431.JPG');
});

test('the original filename survives a save and reopen', () => {
  // It used to live only in the asset registry, which is rebuilt from the
  // archive on every open - and the archive carries bytes and hashes, not
  // filenames. So after a round trip, clearing a renamed item's name handed
  // back the renamed value and the original was gone for good.
  const [a] = addItems([photo({ name: 'DSC_0431.JPG', meta: { origName: 'DSC_0431.JPG' } })]);
  renameItem(a.id, 'Sunset over the bay');
  const data = serializeBoard();
  fresh();
  loadBoard(data);
  const back = board.items[0];
  assert.equal(back.name, 'Sunset over the bay');
  renameItem(back.id, '');
  assert.equal(byId(back.id).name, 'DSC_0431.JPG');
});

test('renaming is undoable', () => {
  const [a] = addItems([photo({ name: 'a.png' })]);
  renameItem(a.id, 'b.png');
  assert.equal(byId(a.id).name, 'b.png');
  undo();
  assert.equal(byId(a.id).name, 'a.png');
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('select replaces, additive select adds', () => {
  const [a, b] = addItems([photo(), photo()]);
  select([a.id]);
  assert.deepEqual([...selection], [a.id]);
  select([b.id]);
  assert.deepEqual([...selection], [b.id]);
  select([a.id], true);
  assert.equal(selection.size, 2);
});

test('select all takes everything, clear takes nothing', () => {
  addItems([photo(), photo(), photo()]);
  selectAll();
  assert.equal(selection.size, 3);
  clearSelection();
  assert.equal(selection.size, 0);
});

test('deselect removes one selected item and leaves the rest', () => {
  const [a, b] = addItems([photo(), photo()]);
  select([a.id, b.id]);
  assert.equal(deselect(a.id), true);
  assert.deepEqual([...selection], [b.id]);
  assert.equal(deselect(a.id), false);
});

test('deleting an item drops it from the selection', () => {
  const [a] = addItems([photo()]);
  select([a.id]);
  removeItems([a.id]);
  assert.equal(selection.size, 0);
});


// ---------------------------------------------------------------------------
// The card, on or off
//
// A cut-out - a logo or a leaf saved with a transparent background - was landing
// in a box drawn round its bounding rectangle, which for a cut-out is mostly
// empty. meta.bare is the flag that says this one is a shape rather than a
// photograph. What is asserted here is the write; the paint is a stylesheet
// question and the guess is import/drop.js's.
// ---------------------------------------------------------------------------

test('a picture can have its card taken away, and given back', () => {
  const [p] = addItems([photo()]);
  setItemBare(p.id, true);
  assert.equal(byId(p.id).meta.bare, true);
  setItemBare(p.id, false);
  assert.equal('bare' in (byId(p.id).meta || {}), false,
    'stored only when true - `bare: false` on every ordinary photograph would be '
    + 'a byte per card in every file to say nothing is unusual');
});

test('a note can lose its paper, and keeps its words', () => {
  // Text lying straight on the board, which is what a caption over a photograph
  // and a title across a corner both wanted and had to be faked with a
  // transparent image. Only the paint goes - cards.css cancels the pad colour,
  // the adhesive band and the inset line, and nothing about the box moves.
  const [n] = addItems([note()]);
  setItemBare(n.id, true);
  assert.equal(byId(n.id).meta.bare, true);
  setItemBare(n.id, false);
  assert.equal('bare' in (byId(n.id).meta || {}), false, 'stored only when true');
});

test('nothing else can lose its card', () => {
  // A video without its card loses the surface its controls sit on. The list is
  // pictures and notes - see canSetBare() in commands/item-meta.ts, which is the
  // same list and says why - and this is the door refusing everything off it, so
  // a flag nothing draws never reaches a file.
  const [v] = addItems([clip()]);
  setItemBare(v.id, true);
  assert.equal(byId(v.id).meta?.bare, undefined);
});

test('taking the card away is undoable, and survives a file', () => {
  const [p] = addItems([photo()]);
  setItemBare(p.id, true);
  undo();
  assert.equal(byId(p.id).meta?.bare, undefined, 'undone');
  setItemBare(p.id, true);
  const written = JSON.parse(JSON.stringify(serializeBoard()));
  loadBoard(written);
  assert.equal(board.items[0].meta.bare, true);
});

test('the write door stores true or nothing, whatever it was handed', () => {
  // Named for what it asserts. It was called "anything other than true is not a
  // flag" and its comment quoted `v === true ? true : null` as though that were
  // the door - but that validator is patchMeta's *fifth* argument, and the
  // value reaching it is already `bare ? true : null` from the third. So a
  // truthy junk value is coerced at the door and `true` is what lands in the
  // file; nothing is ever stored as 'yes' or 1.
  //
  // The old name mattered: it described a stricter door than the code has, and
  // anyone tightening the door to match the name would have reddened a suite
  // that was pinning the opposite the whole time.
  const [p] = addItems([photo()]);
  for (const junk of ['true', 1, {}, [], 'yes']) {
    setItemBare(p.id, junk);
    assert.equal(byId(p.id).meta?.bare, true,
      `${JSON.stringify(junk)} is coerced to the flag it obviously means`);
    setItemBare(p.id, null);
    assert.equal(byId(p.id).meta?.bare, undefined,
      'and cleared rather than stored as false');
  }
  loadBoard({ title: 'T', items: [photo({ id: 'p', meta: { bare: 'yes' } })] });
  assert.equal(byId('p').meta?.bare, 'yes',
    'the schema does not validate meta - the write door is what holds the shape, '
    + 'and writeFit only answers to === true');
});
