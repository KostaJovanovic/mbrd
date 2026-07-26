// Faces a board brought with it.
//
// Drop a .woff2 on the board and it does not become a card - it becomes an
// entry in the two type menus, and it travels inside the .mbrd like any other
// asset. Which is the only way a custom face can work here at all: the app
// fetches nothing, so a board set in a face nobody else has would open as a
// board set in the fallback, and the look someone made would not survive being
// sent to anyone.
//
// Three rules hold this together, and each of them is a thing that bit:
//
//   The family name is rebuilt, never taken. It ends up inside a CSS
//   declaration - `--font-display: "Name", serif` - out of a filename, which is
//   the one string in this whole path that came from outside. FAMILY is what
//   survives, and it is narrow on purpose.
//
//   The bytes live in the asset store, under their own hash, like a photograph.
//   That is what makes them travel, dedupe and autosave with everything else,
//   and it is why `settings.fonts` holds a hash rather than a blob.
//
//   Registration is undone on the way out. document.fonts is per-document, not
//   per-board, so a face added by one board is still there for the next one
//   unless it is taken back off - and the menu would offer a face the board
//   does not carry, which then vanishes for whoever it is sent to.

import { board, bus, markDirty } from '../state.js';
import { addFile, assetURL } from '../storage/assets.js';
import { isFamily, toast } from '../util.js';

/**
 * A ceiling per face and a ceiling per board.
 *
 * A 4MB cap passes every reasonable woff2 - a full variable family is well
 * under one - and stops a 200MB CJK .ttf being quietly folded into every save
 * and every export of the board from then on. Eight faces is past any real
 * use of two menus with two slots.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FONTS = 8;

/**
 * hash -> { face, family }.
 *
 * The family is kept alongside rather than read back off `face.family`, which
 * is the trap here: that getter returns the *CSS serialisation* of the name, so
 * a family with a space in it - which is most of them - comes back quoted. Used
 * as a label it shows the quotes, and folded back into `"${family}", system-ui`
 * it builds a declaration with two sets of quotes that no browser will parse.
 * The string this module chose is the string this module keeps.
 */
const live = new Map();

export function initFonts() {
  bus.on('fonts:add', files => { addFontFiles(files).catch(() => {}); });
  // A board load replaces the faces wholesale, the same way it replaces the
  // items. Not awaited: the menus repaint when each face resolves.
  bus.on('board:load', () => { syncFonts().catch(() => {}); });
  syncFonts().catch(() => {});
}

/**
 * The faces this board carries, as menu entries.
 *
 * Only the ones actually registered. A board whose .mbrd names a face whose
 * bytes did not arrive - a hand-assembled archive, a truncated download - would
 * otherwise offer a menu entry that silently does nothing when chosen.
 */
export function customFaces() {
  return [...live.values()].map(e => e.family).sort().map(family => ({
    label: family,
    // Quoted, and with a fallback behind it: a face that fails to paint for any
    // reason should land on the body stack rather than on the browser's default
    // serif, which belongs to no palette here.
    value: `"${family}", system-ui, sans-serif`,
  }));
}

/**
 * A filename, reduced to something that can be a CSS family name.
 *
 * The bracket group goes entirely, contents and all. That is where a variable
 * font keeps its axes - "Fraunces[opsz,wght].woff2" is the normal shape of the
 * good ones - and it is a description of the file, not part of the name. Turned
 * into spaces instead, which was the first thing tried, it leaves the axis tags
 * behind as words: a face called "Fraunces opsz wght".
 *
 * What is left then gets the ordinary treatment - separators to spaces, the
 * rest of the alphabet dropped - so "Inter-Regular (1).woff2" comes back as
 * "Inter Regular 1" rather than being refused for having a bracket in it.
 */
export function familyFor(filename) {
  const stem = String(filename || '').replace(/\.[^.]*$/, '');
  const cleaned = stem
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[[\]()_-]+/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return isFamily(cleaned) ? cleaned : 'Custom face';
}

async function addFontFiles(files) {
  let added = 0;
  for (const file of files) {
    const list = fontList();
    if (list.length >= MAX_FONTS) {
      toast(`A board can carry ${MAX_FONTS} faces`);
      break;
    }
    if (file.size > MAX_BYTES) {
      toast(`${file.name} is too big to travel with a board`, 'error');
      continue;
    }
    const hash = await addFile(file);
    // Same bytes, already here. Nothing to add and nothing to say - dropping a
    // face twice is not an error, it is somebody making sure.
    if (list.some(f => f.hash === hash)) continue;

    const family = uniqueFamily(familyFor(file.name), list);
    if (!(await register(hash, family))) {
      toast(`${file.name} is not a font this browser can read`, 'error');
      continue;
    }
    board.settings.fonts = [...list, { hash, family }];
    added++;
  }
  if (!added) return;
  markDirty();
  // Two signals, because two different things changed: the menus have new
  // entries, and the board now has bytes in it that were not there before.
  bus.emit('fonts');
  bus.emit('settings', 'fonts');
  toast(added === 1 ? 'Face added' : `${added} faces added`);
}

/**
 * Make the registered set match what the board says it carries.
 *
 * Both directions, and the removal half is the one that matters: without it,
 * opening a plain board after one carrying three faces leaves those three in
 * the menus, offering a look the board cannot save.
 */
async function syncFonts() {
  const want = fontList();
  const keep = new Set(want.map(f => f.hash));
  for (const hash of [...live.keys()]) {
    if (keep.has(hash)) continue;
    document.fonts.delete(live.get(hash).face);
    live.delete(hash);
  }
  for (const { hash, family } of want) await register(hash, family);
  bus.emit('fonts');
}

/**
 * The board's font list.
 *
 * Trusted, because normalizeBoard() in state.js has already held it to shape -
 * valid hashes, family names inside isFamily(), no duplicates. That is where
 * the check belongs: settings are spread wholesale out of a .mbrd, so every
 * field in them arrives from a file this app did not necessarily write, and one
 * module reading it defensively would leave every other module reading it
 * trustingly.
 */
const fontList = () =>
  Array.isArray(board.settings.fonts) ? board.settings.fonts : [];

/**
 * Register one face with the document.
 *
 * Two files can honestly reduce to one family name - "Inter-Regular.woff2" and
 * "Inter-Italic.woff2" both become "Inter" - and document.fonts keyed by family
 * would let the second silently replace the first in every menu that named it.
 * uniqueFamily() below is what stops that; this only has to be idempotent.
 */
async function register(hash, family) {
  if (live.has(hash)) return true;
  const url = assetURL(hash);
  if (!url) return false;
  try {
    // Loaded before it is added, so a file that is not a font is a caught
    // rejection here rather than a family in the menus that paints nothing.
    const face = new FontFace(family, `url("${url}")`);
    await face.load();
    document.fonts.add(face);
    live.set(hash, { face, family });
    return true;
  } catch {
    return false;
  }
}

/** "Inter", "Inter 2", "Inter 3" - so two files never share a family. */
function uniqueFamily(want, list) {
  const taken = new Set(list.map(f => f.family));
  if (!taken.has(want)) return want;
  for (let n = 2; n <= MAX_FONTS + 1; n++) {
    const tryName = `${want} ${n}`.slice(0, 40).trim();
    if (!taken.has(tryName) && isFamily(tryName)) return tryName;
  }
  return want;
}
