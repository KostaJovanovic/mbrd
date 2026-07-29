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

import { board, bus, setSetting } from '../state.js';
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

const BUILTIN_HEADER_FACES = [
  { label: 'Default', value: '', stack: '' },
  {
    label: 'Fraunces',
    value: 'Fraunces',
    stack: '"Fraunces", Georgia, serif',
    axes: [
      { tag: 'wght', min: 100, default: 700, max: 900 },
      { tag: 'opsz', min: 9, default: 72, max: 144 },
    ],
  },
  {
    label: 'Iowan Old Style',
    value: 'Iowan Old Style',
    stack: '"Iowan Old Style", Palatino, serif',
  },
  {
    label: 'Palatino',
    value: 'Palatino Linotype',
    stack: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  },
  { label: 'Georgia', value: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  {
    label: 'Times New Roman',
    value: 'Times New Roman',
    stack: '"Times New Roman", Times, serif',
  },
  {
    label: 'Geist (sans)',
    value: 'Geist',
    stack: '"Geist", system-ui, sans-serif',
    axes: [{ tag: 'wght', min: 300, default: 700, max: 700 }],
  },
];

const AXIS_FALLBACKS = {
  wght: { min: 100, default: 400, max: 900 },
  wdth: { min: 50, default: 100, max: 200 },
  opsz: { min: 6, default: 14, max: 144 },
  slnt: { min: -15, default: 0, max: 0 },
  ital: { min: 0, default: 0, max: 1 },
  GRAD: { min: -200, default: 0, max: 150 },
  SOFT: { min: 0, default: 0, max: 100 },
  WONK: { min: 0, default: 0, max: 1 },
};

export function initFonts() {
  bus.on('fonts:add', files => { addFontFiles(files).catch(() => {}); });
  // A board load replaces the faces wholesale, the same way it replaces the
  // items. Not awaited: the menus repaint when each face resolves.
  bus.on('board:load', () => { syncFonts().catch(() => {}); });
  bus.on('layout', () => { syncFonts().catch(() => {}); });
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

/** Faces offered by the Mobile masthead, including the board's own files. */
export function headerFontOptions() {
  const own = [...live.values()]
    .sort((a, b) => a.family.localeCompare(b.family))
    .map(({ family }) => ({
      label: family,
      value: family,
      stack: `"${family}", system-ui, sans-serif`,
    }));
  return [
    BUILTIN_HEADER_FACES[0],
    ...own,
    ...BUILTIN_HEADER_FACES.slice(1),
  ].map(face => ({ ...face, axes: face.axes?.map(axis => ({ ...axis })) }));
}

/** A safe CSS stack for one value stored in `board.mobileHeader.font`. */
export function headerFontStack(value) {
  if (!value) return '';
  const builtin = BUILTIN_HEADER_FACES.find(face => face.value === value);
  if (builtin) return builtin.stack;
  return live.size && [...live.values()].some(entry => entry.family === value)
    ? `"${value}", system-ui, sans-serif`
    : '';
}

/**
 * Variable axes belonging to a header face.
 *
 * An empty value follows the current display face, so the computed stack is
 * used only to decide which bundled descriptor applies.
 */
export function headerFontAxes(value, computedStack = '') {
  const chosen = value || computedStack;
  const builtin = BUILTIN_HEADER_FACES.find(face =>
    face.value && chosen.toLowerCase().includes(face.value.toLowerCase()));
  if (builtin) return (builtin.axes || []).map(axis => ({ ...axis }));
  const own = (board.settings.fonts || []).find(font =>
    font.family === value ||
    (!value && computedStack.toLowerCase().includes(font.family.toLowerCase())));
  return Array.isArray(own?.axes) ? own.axes.map(axis => ({ ...axis })) : [];
}

/**
 * The two cuts a family that is not variable can honestly be set in.
 *
 * Regular and Bold, because that is what a text face ships. The five-name list
 * this replaced - Regular, Medium, Semibold, Bold, Black - offered three
 * weights that no system serif has: the browser answers for them by picking
 * the nearest real cut, so Medium and Semibold both painted the Regular and
 * Black painted the Bold. Three controls that did nothing, and a stored weight
 * that did not describe what was on the screen.
 */
export const STATIC_WEIGHTS = Object.freeze([
  Object.freeze({ value: 400, label: 'Regular' }),
  Object.freeze({ value: 700, label: 'Bold' }),
]);

/**
 * The weights a header face offers when it has no `wght` axis to sweep.
 *
 * Empty means the control has no question to ask, and the caller takes it down
 * rather than showing a dial with one stop on it. Two cases end up there:
 *
 *   A variable face, which is not this control's business at all - its weight
 *   is a continuous axis and headerFontAxes() already describes it.
 *
 *   A face dropped onto this board with no axes, which is one static instance
 *   of somebody's family. Its own weight is the only real one in the file;
 *   every other value would be the browser drawing a fake bold over it, and a
 *   slider that fakes its own effect is worse than no slider.
 */
export function headerFontWeights(value, computedStack = '') {
  if (headerFontAxes(value, computedStack).some(axis => axis.tag === 'wght')) return [];
  const own = (board.settings.fonts || []).find(font =>
    font.family === value ||
    (!value && computedStack.toLowerCase().includes(font.family.toLowerCase())));
  if (own) return [];
  return STATIC_WEIGHTS.map(weight => ({ ...weight }));
}

/** Axis tags carried in the conventional `Family[opsz,wght].woff2` filename. */
export function axesFromFilename(filename) {
  const tags = String(filename || '').match(/\[([^\]]+)\]/)?.[1]?.split(',') || [];
  const seen = new Set();
  const axes = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    axes.push({ tag, ...(AXIS_FALLBACKS[tag] || { min: 0, default: 0, max: 100 }) });
  }
  return axes;
}

/**
 * Read a font's OpenType `fvar` table.
 *
 * SFNT/OTF tables are direct slices. WOFF may deflate each table independently;
 * WOFF2 transforms the entire stream and has no browser decoder API, so its
 * normal bracketed filename is the honest fallback.
 */
export async function fontAxes(file) {
  const fallback = axesFromFilename(file?.name);
  if (!file?.arrayBuffer) return fallback;
  try {
    const found = findFvar(await file.arrayBuffer());
    if (!found) return fallback;
    let bytes = found.bytes;
    if (found.compressed) {
      if (typeof DecompressionStream !== 'function') return fallback;
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return parseFvar(bytes) || fallback;
  } catch {
    return fallback;
  }
}

function findFvar(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 12) return null;
  const magic = tagAt(bytes, 0);
  if (magic === 'wOF2') return null;
  if (magic === 'wOFF') {
    if (bytes.length < 44) return null;
    const count = view.getUint16(12);
    if (count > 128 || 44 + count * 20 > bytes.length) return null;
    for (let i = 0; i < count; i++) {
      const at = 44 + i * 20;
      if (tagAt(bytes, at) !== 'fvar') continue;
      const offset = view.getUint32(at + 4);
      const length = view.getUint32(at + 8);
      const original = view.getUint32(at + 12);
      if (!tableFits(bytes, offset, length) || original > 1024 * 1024) return null;
      return {
        bytes: bytes.slice(offset, offset + length),
        compressed: length < original,
      };
    }
    return null;
  }

  const count = view.getUint16(4);
  if (count > 128 || 12 + count * 16 > bytes.length) return null;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (tagAt(bytes, at) !== 'fvar') continue;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (!tableFits(bytes, offset, length) || length > 1024 * 1024) return null;
    return { bytes: bytes.slice(offset, offset + length), compressed: false };
  }
  return null;
}

function parseFvar(bytes) {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint16(4);
  const count = view.getUint16(8);
  const size = view.getUint16(10);
  if (!count || count > 16 || size < 20 || offset + count * size > bytes.length) return null;
  const axes = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * size;
    const tag = tagAt(bytes, at);
    const min = fixed(view.getInt32(at + 4));
    const fallback = fixed(view.getInt32(at + 8));
    const max = fixed(view.getInt32(at + 12));
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || !(max > min)) continue;
    axes.push({ tag, min, default: Math.max(min, Math.min(max, fallback)), max });
  }
  return axes.length ? axes : null;
}

const tableFits = (bytes, offset, length) =>
  Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
  offset >= 0 && length >= 0 && offset + length <= bytes.length;
const tagAt = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
const fixed = value => value / 65536;

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
    const [hash, axes] = await Promise.all([addFile(file), fontAxes(file)]);
    // Same bytes, already here. Nothing to add and nothing to say - dropping a
    // face twice is not an error, it is somebody making sure.
    if (list.some(f => f.hash === hash)) continue;

    const family = uniqueFamily(familyFor(file.name), list);
    if (!(await register(hash, family, axes))) {
      toast(`${file.name} is not a font this browser can read`, 'error');
      continue;
    }
    setSetting('fonts', [...list, {
      hash,
      family,
      ...(axes.length ? { axes } : {}),
    }]);
    added++;
  }
  if (!added) return;
  // Two signals, because two different things changed: the menus have new
  // entries, and the board now has bytes in it that were not there before.
  bus.emit('fonts');
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
  for (const { hash, family, axes } of want) await register(hash, family, axes);
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
async function register(hash, family, axes = []) {
  if (live.has(hash)) return true;
  const url = assetURL(hash);
  if (!url) return false;
  try {
    // Loaded before it is added, so a file that is not a font is a caught
    // rejection here rather than a family in the menus that paints nothing.
    const weight = axes.find(axis => axis.tag === 'wght');
    const descriptors = weight
      ? { weight: `${Math.max(1, weight.min)} ${Math.min(1000, weight.max)}` }
      : {};
    const face = new FontFace(family, `url("${url}")`, descriptors);
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
