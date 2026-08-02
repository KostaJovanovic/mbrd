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

/** Matches MAX_FONT_AXES in state.js - the two are one limit in two layers. */
const MAX_AXES = 32;

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
    label: 'Playfair',
    value: 'Playfair',
    stack: '"Playfair", Georgia, serif',
    // The one face here that opens at a size of its own - 15% of the strip
    // against the 13% every other face takes from DEFAULT_MOBILE_HEADER. A
    // Didone gives up more of its height to the contrast between stem and
    // hairline than the others do, so the same percentage reads smaller set in
    // this than in Geist or Fraunces, and the name arrives looking timid.
    //
    // An opening position, not a floor: the size slider is untouched and keeps
    // its full 7-24 range. Picking Playfair moves it there; picking anything
    // else leaves the size exactly where it stands, since no other face states
    // one. Coming back to Playfair puts it at 15 again, which is what "starts
    // at" has to mean if it is to mean anything.
    size: 15,
    // The shipped subset's fvar, verbatim - all three axes.
    //
    // opsz genuinely runs to 1200; Playfair is drawn for signage at the top of
    // it. This was capped at 144 for a while on the argument that the last 88%
    // of the travel does almost nothing you would want, which is true and is
    // still not this table's call to make: a bound written here is
    // indistinguishable, to everything downstream, from a bound in the file.
    // Ranges are what the face has. Taste belongs to whoever drags the slider.
    //
    // wdth spent even longer missing, and worse than capped - the subsets were
    // fetched with it instanced out, so for a while the honest answer to "where
    // is the width slider" was that the file had no width in it. Its default is
    // 112.5, the top of its own range; 100 here is the normal width the rest of
    // the board sets it to through font-stretch, so opening the panel does not
    // move the masthead.
    axes: [
      { tag: 'wght', min: 300, default: 700, max: 900 },
      { tag: 'wdth', min: 87.5, default: 100, max: 112.5 },
      { tag: 'opsz', min: 5, default: 72, max: 1200 },
    ],
  },
  {
    label: 'Fraunces',
    value: 'Fraunces',
    stack: '"Fraunces", Georgia, serif',
    // `default` is the masthead's opening position, not the fvar default, and
    // that is the one number here allowed to be a choice: Fraunces defaults to
    // opsz 9 and wght 900, which is a caption cut in black - a poor place to
    // start a title. min and max are the file's.
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
    // 100 to 900, which is the file. This read 300 to 700 - the old @font-face
    // descriptor - and so the slider stopped where the descriptor did rather
    // than where Geist does. Both are fixed together, and they have to be: the
    // slider drives font-weight, which the descriptor clamps, so widening one
    // without the other is either a control that lies or a font that is hidden.
    axes: [{ tag: 'wght', min: 100, default: 700, max: 900 }],
  },
];

/**
 * Ranges for a tag whose real bounds could not be read.
 *
 * Only WOFF2 gets here - every other container hands over its `fvar` and the
 * exact numbers with it (see fontAxes). For those files this table is never
 * consulted, and none of these guesses can override a bound the font actually
 * stated.
 *
 * The five registered tags are first; the rest are custom axes with their
 * published ranges from the family that popularised each one - Roboto Flex for
 * the parametrics, Recursive for CASL/CRSV/MONO, Fraunces for SOFT/WONK,
 * Commissioner for FLAR/VOLM. A file using the same tag with different bounds
 * is entirely legal, so these are a good guess and not a fact.
 *
 * Which is why, where a guess had to lean, it leans wide. CSS clamps a
 * variation value to the axis, so a slider that overshoots the real range ends
 * in a dead stretch at one end - visibly nothing happening, and recoverable by
 * dragging back. One that undershoots hides part of the face with no sign that
 * anything is missing, which is the failure this whole table exists to reduce.
 * An unlisted tag still gets 0..100, and that is a shrug, not a claim.
 */
const AXIS_FALLBACKS = {
  wght: { min: 100, default: 400, max: 900 },
  wdth: { min: 25, default: 100, max: 200 },
  opsz: { min: 5, default: 14, max: 1200 },
  slnt: { min: -20, default: 0, max: 0 },
  ital: { min: 0, default: 0, max: 1 },
  CASL: { min: 0, default: 0, max: 1 },
  CRSV: { min: 0, default: 0.5, max: 1 },
  MONO: { min: 0, default: 0, max: 1 },
  GRAD: { min: -200, default: 0, max: 150 },
  SOFT: { min: 0, default: 0, max: 100 },
  WONK: { min: 0, default: 0, max: 1 },
  FLAR: { min: 0, default: 0, max: 100 },
  VOLM: { min: 0, default: 0, max: 100 },
  ROND: { min: 0, default: 0, max: 100 },
  BLED: { min: 0, default: 0, max: 100 },
  EDPT: { min: 0, default: 100, max: 200 },
  EHLT: { min: 0, default: 12, max: 24 },
  ELGR: { min: 1, default: 1, max: 2 },
  ELSH: { min: 0, default: 0, max: 100 },
  XTRA: { min: 323, default: 468, max: 603 },
  XOPQ: { min: 27, default: 96, max: 175 },
  YOPQ: { min: 25, default: 79, max: 135 },
  YTAS: { min: 649, default: 750, max: 854 },
  YTDE: { min: -305, default: -203, max: -98 },
  YTFI: { min: 560, default: 738, max: 788 },
  YTLC: { min: 416, default: 514, max: 570 },
  YTUC: { min: 528, default: 712, max: 760 },
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
 * The size a face asks to open at, or null to keep whatever is set.
 *
 * Null for "Default" and for every dropped face, so this only ever speaks for a
 * bundled face that named a number. See the Playfair entry above, which is the
 * only one that does.
 */
export function headerFontSize(value) {
  if (!value) return null;
  return BUILTIN_HEADER_FACES.find(face => face.value === value)?.size ?? null;
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

/**
 * Is this a variable font, whatever its axes turn out to be?
 *
 * A weaker question than fontAxes() asks, and the point is that WOFF2 can
 * answer it. Its *table data* is one Brotli stream with no browser decoder to
 * put through it, which is why the axes themselves are out of reach - but its
 * table directory is not compressed at all. Walking that says whether an `fvar`
 * is in there without decoding a byte of it.
 *
 * Which is worth knowing on its own, because register() has to choose a weight
 * descriptor before anything renders, and the two wrong answers are not
 * symmetrical: see the note there.
 */
export async function fontIsVariable(file) {
  if (!file?.arrayBuffer) return false;
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12) return false;
    return tagAt(bytes, 0) === 'wOF2'
      ? woff2HasFvar(bytes, new DataView(buffer))
      : !!findFvar(buffer);
  } catch {
    return false;
  }
}

/** WOFF2's fixed header, before the table directory starts. */
const WOFF2_HEADER = 48;
/**
 * The three entries of WOFF2's 63-tag table this has to recognise.
 *
 * A directory entry names its table by index into that list rather than by
 * spelling the tag out, and only 63 - the escape - means four literal bytes
 * follow. The whole list is not here because only three of its members change
 * what this function does: `fvar` is what is being looked for, and `glyf` and
 * `loca` are the two tables whose transform flag reads backwards from every
 * other table's, which decides whether an entry carries one length or two.
 * Getting that wrong desynchronises the walk rather than skipping a table.
 */
const WOFF2_TAGS = { glyf: 10, loca: 11, fvar: 47, escape: 63 };

function woff2HasFvar(bytes, view) {
  if (bytes.length < WOFF2_HEADER) return false;
  const numTables = view.getUint16(12);
  if (!numTables) return false;
  let at = WOFF2_HEADER;
  for (let i = 0; i < numTables; i++) {
    if (at >= bytes.length) return false;
    const flags = bytes[at++];
    const known = flags & 0x3F;
    let tag = '';
    if (known === WOFF2_TAGS.escape) {
      if (at + 4 > bytes.length) return false;
      tag = tagAt(bytes, at);
      at += 4;
    }
    if (known === WOFF2_TAGS.fvar || tag === 'fvar') return true;
    // glyf and loca are transformed when their version is 0 and left alone at
    // 3; every other table is the other way round. A transformed entry carries
    // a second length, and reading the wrong number of them here would put the
    // walk out of step with the directory for every table after this one.
    const paired = known === WOFF2_TAGS.glyf || known === WOFF2_TAGS.loca ||
      tag === 'glyf' || tag === 'loca';
    const version = flags >> 6;
    at = skipBase128(bytes, at);
    if (paired ? version === 0 : version !== 0) at = skipBase128(bytes, at);
    if (at < 0) return false;
  }
  return false;
}

/** Step over one UIntBase128, or -1 if what is there is not a valid one. */
function skipBase128(bytes, at) {
  if (at < 0 || at >= bytes.length) return -1;
  // A leading 0x80 encodes a leading zero, which the format forbids outright -
  // it is the shape a padded length would take, and refusing it is what keeps
  // one encoding per value.
  if (bytes[at] === 0x80) return -1;
  for (let i = 0; i < 5; i++) {
    if (at >= bytes.length) return -1;
    if (!(bytes[at++] & 0x80)) return at;
  }
  return -1;
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
  if (!count || size < 20 || offset + count * size > bytes.length) return null;
  const axes = [];
  // Read up to the cap rather than refusing a font that exceeds it. `count > 16`
  // used to be part of the guard above, which meant a face with seventeen axes
  // returned null and fell through to the filename - so the most variable fonts
  // there are were the ones that offered no sliders at all. The table still has
  // to fit its own declared length, which is the check that actually defends
  // against a corrupt header; the cap is only about how many controls a panel
  // can usefully hold. See MAX_FONT_AXES in state.js, which is the same number
  // one layer down - a board may not store more than this either.
  for (let i = 0; i < Math.min(count, MAX_AXES); i++) {
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
    const [hash, axes, variable] = await Promise.all([
      addFile(file), fontAxes(file), fontIsVariable(file),
    ]);
    // Same bytes, already here. Nothing to add and nothing to say - dropping a
    // face twice is not an error, it is somebody making sure.
    if (list.some(f => f.hash === hash)) continue;

    const family = uniqueFamily(familyFor(file.name), list);
    if (!(await register(hash, family, axes, variable))) {
      toast(`${file.name} is not a font this browser can read`, 'error');
      continue;
    }
    // `variable` is only worth storing when it is the whole of what is known.
    // With axes in hand it is implied by them, and a second field saying the
    // same thing is a second field that can disagree.
    setSetting('fonts', [...list, {
      hash,
      family,
      ...(axes.length ? { axes } : variable ? { variable: true } : {}),
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
  for (const { hash, family, axes, variable } of want) {
    await register(hash, family, axes, variable);
  }
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
async function register(hash, family, axes = [], variable = false) {
  if (live.has(hash)) return true;
  const url = assetURL(hash);
  if (!url) return false;
  try {
    // Loaded before it is added, so a file that is not a font is a caught
    // rejection here rather than a family in the menus that paints nothing.
    //
    // The weight descriptor is a claim about what this face covers, and leaving
    // it off does not mean "no claim" - it means `normal`, which is 400 flat.
    // On a variable font that pins the weight axis at Regular and hands every
    // bold on the board to the synthesiser, out of a file that has real ones
    // in it. So an unread axis must not fall through to the empty case.
    //
    // 1 1000 when the axes could not be read but the file is known to have an
    // `fvar` - a bracketless .woff2, whose bounds are unknowable here. It is a
    // guess, and it is the right way round: overshooting a real axis costs a
    // stretch of weights that all paint the same, and every one of them is a
    // weight the face actually drew. Understating it costs the weights
    // themselves. The one case it gets wrong is a variable font with no `wght`
    // axis at all - a handful of width-only and optical-only faces exist - and
    // there the claim is empty and bold stops being synthesised. Rare, against
    // a default that is wrong for almost every variable font there is.
    const weight = axes.find(axis => axis.tag === 'wght');
    const descriptors = weight
      ? { weight: `${Math.max(1, weight.min)} ${Math.min(1000, weight.max)}` }
      : variable ? { weight: '1 1000' } : {};
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
