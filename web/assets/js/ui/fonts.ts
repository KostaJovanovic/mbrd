// Custom fonts that travel inside the .mbrd. Dropped .woff2 files become menu
// entries, stored as hashed assets. Family name is rebuilt from filename (never
// taken raw — it lands in a CSS declaration). Registration is undone on board
// switch because document.fonts is per-document, not per-board.

import { board, bus, setSetting } from '../state.ts';
import { addFile, assetURL } from '../storage/assets.ts';
import { isFamily } from '../util.ts';
import { toast } from '../notify.ts';
import { allow, fileKey, mb } from '../consent.ts';
import { addFontCard } from '../import/drop.ts';
import { PLAYFAIR_STACK, FRAUNCES_STACK } from '../layout-settings.ts';
import type { FontAxis, FontSpec } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';

// Injected by initFonts() so a dropped face can also land a specimen card at
// the current view centre. Null in a test with no board - the card step is
// then skipped, the way every other view-dependent step here is.
let vp: Viewport | null = null;

/**
 * A ceiling per face and a ceiling per board.
 *
 * 4MB passes any reasonable woff2 and stops a 200MB CJK .ttf being folded
 * into every save and export *without anybody being told* - the ceiling
 * asks rather than refuses. Eight faces is a flat cap on menu space, not memory.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FONTS = 8;

/** Matches MAX_FONT_AXES in state.ts - the two are one limit in two layers. */
const MAX_AXES = 32;

/**
 * hash -> { face, family }.
 *
 * The family is kept alongside rather than read back off `face.family`:
 * that getter returns the CSS *serialisation* of the name, quoted when it
 * has a space (most do) - fine as CSS, wrong doubled into
 * `"${family}", system-ui` or shown as a label with its quotes visible.
 */
const live = new Map<string, { face: FontFace, family: string }>();

/**
 * One face the masthead menu offers: what to call it, what to store, the stack
 * to set it in - and, for the bundled ones that state them, an opening size and
 * the axes its own file declares.
 */
type HeaderFace = {
  label: string,
  value: string,
  stack: string,
  size?: number,
  axes?: FontAxis[],
};

const BUILTIN_HEADER_FACES: HeaderFace[] = [
  { label: 'Default', value: '', stack: '' },
  {
    label: 'Playfair',
    value: 'Playfair',
    stack: PLAYFAIR_STACK,
    // The one face here with its own opening size - 15% of the strip vs.
    // 13% for the others - since a Didone's stem/hairline contrast makes the
    // same percentage read smaller than in Geist or Fraunces. An opening
    // position, not a floor: the size slider keeps its full 7-24 range.
    size: 15,
    // The shipped subset's fvar, verbatim - all three axes, uncapped. opsz
    // genuinely runs to 1200 (Playfair is drawn for signage); capping it
    // here would be indistinguishable from a bound in the file, which isn't
    // this table's call. wdth's default is 112.5 (its own range's top); 100
    // here matches the width the rest of the board sets via font-stretch,
    // so opening the panel doesn't move the masthead.
    axes: [
      { tag: 'wght', min: 300, default: 700, max: 900 },
      { tag: 'wdth', min: 87.5, default: 100, max: 112.5 },
      { tag: 'opsz', min: 5, default: 72, max: 1200 },
    ],
  },
  {
    label: 'Fraunces',
    value: 'Fraunces',
    stack: FRAUNCES_STACK,
    // `default` is the masthead's opening position, not the fvar default -
    // Fraunces's own default (opsz 9, wght 900) is a black caption, a poor
    // place to start a title. min/max are the file's.
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
    // 100-900, the file's real range. This used to read 300-700 (the old
    // @font-face descriptor), so the slider stopped short of what the font
    // can do - the descriptor and slider have to move together.
    axes: [{ tag: 'wght', min: 100, default: 700, max: 900 }],
  },
];

/**
 * Ranges for a tag whose real bounds could not be read. Only WOFF2 gets
 * here - every other container hands over its `fvar` and exact numbers (see
 * fontAxes); a file's own bounds always win.
 *
 * The five registered tags come first, then custom axes with published
 * ranges from the family that popularised each (Roboto Flex, Recursive,
 * Fraunces, Commissioner) - a good guess, not a fact, leaning wide since
 * overshooting only wastes slider travel while undershooting hides a face.
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

/** The panel's list of dropped faces, each with a remove control. */
let fontListHost: HTMLElement | null = null;

export function initFonts(viewport: Viewport | null = null) {
  vp = viewport;
  fontListHost = document.getElementById('appearance-fonts');
  bus.on('fonts:add', files => { addFontFiles(files).catch(() => {}); });
  // A board load replaces the faces wholesale, the same way it replaces the
  // items. Not awaited: the menus repaint when each face resolves.
  bus.on('board:load', () => { syncFonts().catch(() => {}); });
  bus.on('layout', () => { syncFonts().catch(() => {}); });
  // syncFonts() and every add/remove end in bus.emit('fonts'); the list follows it.
  bus.on('fonts', renderFontList);
  syncFonts().catch(() => {});
  renderFontList();
}

/**
 * The list of the board's own faces in the Look tab, each a row of the name
 * (set in its own face) and an X to take it back off. Hidden entirely when
 * the board carries none.
 */
function renderFontList() {
  if (!fontListHost) return;
  const faces = [...live.entries()]
    .map(([hash, e]) => ({ hash, family: e.family }))
    .sort((a, b) => a.family.localeCompare(b.family));
  fontListHost.replaceChildren();
  fontListHost.hidden = faces.length === 0;
  for (const { hash, family } of faces) {
    const row = document.createElement('div');
    row.className = 'font-row';
    const name = document.createElement('span');
    name.className = 'font-row-name';
    name.textContent = family;
    name.style.fontFamily = `"${family}", system-ui, sans-serif`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'font-row-remove';
    rm.setAttribute('aria-label', `Remove ${family}`);
    rm.title = 'Remove this face';
    rm.innerHTML = '<svg class="ico" aria-hidden="true"><use href="assets/icons.svg#i-close"/></svg>';
    rm.addEventListener('click', () => removeFont(hash));
    row.append(name, rm);
    fontListHost.append(row);
  }
}

/**
 * Take one dropped face back off the board. It leaves the saved list and syncFonts()
 * unregisters the FontFace; a look still pointing at it falls back the same way it
 * would after opening a board whose face never arrived.
 */
function removeFont(hash: string) {
  const list = fontList();
  if (!list.some(f => f.hash === hash)) return;
  setSetting('fonts', list.filter(f => f.hash !== hash));
  syncFonts().catch(() => {});
}

/**
 * The faces this board carries, as menu entries. Only the ones actually
 * registered - a .mbrd naming a face whose bytes never arrived would
 * otherwise offer a menu entry that silently does nothing when chosen.
 */
export function customFaces() {
  return [...live.values()].map(e => e.family).sort().map(family => ({
    label: family,
    // Quoted, with a fallback behind it: a face that fails to paint for any
    // reason lands on the body stack rather than the browser's default serif.
    value: `"${family}", system-ui, sans-serif`,
  }));
}

/** Faces offered by the Mobile masthead, including the board's own files. */
export function headerFontOptions() {
  const own: HeaderFace[] = [...live.values()]
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
export function headerFontStack(value: string) {
  if (!value) return '';
  const builtin = BUILTIN_HEADER_FACES.find(face => face.value === value);
  if (builtin) return builtin.stack;
  return live.size && [...live.values()].some(entry => entry.family === value)
    ? `"${value}", system-ui, sans-serif`
    : '';
}

/**
 * The size a face asks to open at, or null to keep whatever is set. Null for
 * "Default" and every dropped face - only a bundled face (Playfair) states one.
 */
export function headerFontSize(value: string) {
  if (!value) return null;
  return BUILTIN_HEADER_FACES.find(face => face.value === value)?.size ?? null;
}

/**
 * Variable axes belonging to a header face.
 *
 * An empty value follows the current display face, so the computed stack is
 * used only to decide which bundled descriptor applies.
 */
export function headerFontAxes(value: string, computedStack = ''): FontAxis[] {
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
 * The two cuts a non-variable family can honestly be set in: Regular and
 * Bold. Replaces a five-name list (Regular/Medium/Semibold/Bold/Black) where
 * three weights no system serif has just got mapped to the nearest real
 * cut, so those controls did nothing and the stored weight lied.
 */
const STATIC_WEIGHTS = Object.freeze([
  Object.freeze({ value: 400, label: 'Regular' }),
  Object.freeze({ value: 700, label: 'Bold' }),
]);

/**
 * The weights a header face offers when it has no `wght` axis to sweep.
 * Empty means no question to ask - the caller removes the control rather
 * than show a one-stop dial. Covers a variable face (headerFontAxes()
 * already handles it) or a dropped face with no axes (one static instance;
 * any other value would be a fake synthesised bold).
 */
export function headerFontWeights(value: string, computedStack = '') {
  if (headerFontAxes(value, computedStack).some(axis => axis.tag === 'wght')) return [];
  const own = (board.settings.fonts || []).find(font =>
    font.family === value ||
    (!value && computedStack.toLowerCase().includes(font.family.toLowerCase())));
  if (own) return [];
  return STATIC_WEIGHTS.map(weight => ({ ...weight }));
}

/** Axis tags carried in the conventional `Family[opsz,wght].woff2` filename. */
export function axesFromFilename(filename: unknown): FontAxis[] {
  const tags = String(filename || '').match(/\[([^\]]+)\]/)?.[1]?.split(',') || [];
  const seen = new Set<string>();
  const axes: FontAxis[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    // SAFETY: the assertion is the lookup, not a claim about the tag - the
    // `|| { … }` beside it is what a tag AXIS_FALLBACKS has never heard of
    // gets. `tag` is already held to four characters by the test above.
    axes.push({ tag, ...(AXIS_FALLBACKS[tag as keyof typeof AXIS_FALLBACKS] || { min: 0, default: 0, max: 100 }) });
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
export async function fontAxes(file: File | null | undefined): Promise<FontAxis[]> {
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
 * Is this a variable font, whatever its axes turn out to be? A weaker
 * question than fontAxes(), one WOFF2 can still answer: its table *data* is
 * one undecoded Brotli stream, but the directory itself isn't compressed,
 * so walking it says whether `fvar` exists without decoding it. Needed
 * because register() must choose a weight descriptor before anything
 * renders, and the two wrong answers aren't symmetrical (see there).
 */
export async function fontIsVariable(file: File | null | undefined) {
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
 * A directory entry names its table by index into that list, or - for index
 * 63, the escape - spells the tag out in four literal bytes. Only three tags
 * matter here: `fvar` is what's being looked for, and `glyf`/`loca` are the
 * two whose transform flag reads backwards from every other table's, which
 * decides whether an entry carries one length or two. Getting that wrong
 * desynchronises the walk rather than just skipping a table.
 */
const WOFF2_TAGS = { glyf: 10, loca: 11, fvar: 47, escape: 63 };

function woff2HasFvar(bytes: Uint8Array, view: DataView) {
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
    // glyf/loca are transformed at version 0, untouched at 3; every other
    // table is the reverse. A transformed entry carries a second length.
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
function skipBase128(bytes: Uint8Array, at: number) {
  if (at < 0 || at >= bytes.length) return -1;
  // A leading 0x80 encodes a leading zero, which the format forbids - it's
  // the shape a padded length would take, and refusing it keeps one
  // encoding per value.
  if (bytes[at] === 0x80) return -1;
  for (let i = 0; i < 5; i++) {
    if (at >= bytes.length) return -1;
    if (!(bytes[at++] & 0x80)) return at;
  }
  return -1;
}

const findFvar = (buffer: ArrayBuffer) => findTable(buffer, 'fvar');

/**
 * Find one SFNT/WOFF table by tag, returning its bytes and whether they are
 * deflated (WOFF only). WOFF2 is `null` - its table data is one Brotli stream
 * with no browser decoder - and so is a directory that does not fit its own
 * header. Every offset is bounds-checked before the slice: this walks a file
 * the app did not write.
 */
function findTable(buffer: ArrayBuffer, want: string) {
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
      if (tagAt(bytes, at) !== want) continue;
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
    if (tagAt(bytes, at) !== want) continue;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (!tableFits(bytes, offset, length) || length > 1024 * 1024) return null;
    return { bytes: bytes.slice(offset, offset + length), compressed: false };
  }
  return null;
}

function parseFvar(bytes: Uint8Array) {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint16(4);
  const count = view.getUint16(8);
  const size = view.getUint16(10);
  if (!count || size < 20 || offset + count * size > bytes.length) return null;
  const axes: FontAxis[] = [];
  // Read up to the cap rather than refusing a font that exceeds it - `count
  // > 16` used to be part of the guard above, so a 17-axis face returned
  // null and fell through to the filename: the most variable fonts got no
  // sliders at all. The table still has to fit its own declared length (the
  // check that actually defends against a corrupt header); the cap is only
  // about how many controls a panel can hold. Matches MAX_FONT_AXES in state.ts.
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

const tableFits = (bytes: Uint8Array, offset: number, length: number) =>
  Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
  offset >= 0 && length >= 0 && offset + length <= bytes.length;
const tagAt = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
const fixed = (value: number) => value / 65536;

/**
 * A filename, reduced to something that can be a CSS family name.
 *
 * The bracket group goes entirely, contents and all - that's where a
 * variable font's axes live ("Fraunces[opsz,wght].woff2"), a description of
 * the file rather than part of the name. What's left gets the ordinary
 * treatment (separators to spaces, non-alphanumerics dropped), so
 * "Inter-Regular (1).woff2" comes back as "Inter Regular 1".
 */
export function familyFor(filename: unknown) {
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

/**
 * The family name the face declares of itself, or null.
 *
 * The filename is a guess ("BasicallyAMono-Bold.otf"); the font's own `name`
 * table is the fact ("Basically a mono"). Typographic Family (nameID 16) is the
 * weight-independent umbrella and is preferred; the basic Family (nameID 1) is
 * next, and for a standard Bold/Italic style it already excludes the weight
 * (that lives in the subfamily), so either drops the "Bold". A Windows/Unicode
 * record (UTF-16BE) wins over a Mac one. Cleaned to what isFamily() accepts,
 * since it lands in a CSS declaration the same as the filename would.
 */
function familyFromNameTable(bytes: Uint8Array): string | null {
  if (bytes.length < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  if (!count || 6 + count * 12 > bytes.length) return null;
  let best: { score: number, value: string } | null = null;
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    const platform = view.getUint16(rec);
    const nameID = view.getUint16(rec + 6);
    if (nameID !== 1 && nameID !== 16) continue;
    const length = view.getUint16(rec + 8);
    const start = storage + view.getUint16(rec + 10);
    if (!length || start + length > bytes.length) continue;
    const cleaned = cleanFamily(decodeNameString(platform, bytes.subarray(start, start + length)));
    if (!cleaned) continue;
    const score = (nameID === 16 ? 2 : 0) + (platform === 3 || platform === 0 ? 1 : 0);
    if (!best || score > best.score) best = { score, value: cleaned };
  }
  return best?.value || null;
}

/** Windows (3) and Unicode (0) name strings are UTF-16BE; a Mac (1) string is a
 *  byte run whose ASCII range covers every Latin family name that matters. */
function decodeNameString(platform: number, bytes: Uint8Array): string {
  if (platform === 3 || platform === 0) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return String.fromCharCode(...bytes);
}

/** To what isFamily() accepts: separators to spaces, everything else dropped,
 *  capped at 40. Shared by the name-table read and the filename fallback. */
function cleanFamily(raw: string): string | null {
  const cleaned = raw
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return isFamily(cleaned) ? cleaned : null;
}

/**
 * The family for a dropped file: its own `name` table when it can be read, the
 * filename otherwise. WOFF may deflate the table (handled like fvar); WOFF2
 * cannot be decoded here, so a bracketed WOFF2 name falls through to familyFor.
 */
export async function familyFrom(file: File | null | undefined): Promise<string> {
  const fallback = familyFor(file?.name);
  if (!file?.arrayBuffer) return fallback;
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12 || tagAt(bytes, 0) === 'wOF2') return fallback;
    const found = findTable(buffer, 'name');
    if (!found) return fallback;
    let data = found.bytes;
    if (found.compressed) {
      if (typeof DecompressionStream !== 'function') return fallback;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return familyFromNameTable(data) || fallback;
  } catch {
    return fallback;
  }
}

// Serialized: each drop reads the whole font list, awaits hashing/registration,
// then writes the list back. Two files arriving as separate 'fonts:add' events
// could both read the pre-write list, and the second setSetting would clobber the
// first face. Chaining makes each call read what the previous one wrote.
let fontAddQueue = Promise.resolve();
function addFontFiles(files: Iterable<File>) {
  fontAddQueue = fontAddQueue.then(() => runAddFontFiles(files), () => runAddFontFiles(files));
  return fontAddQueue;
}

async function runAddFontFiles(files: Iterable<File>) {
  let added = 0;
  // Cascade so several faces dropped at once do not stack on one point.
  let placed = 0;
  const at = vp ? vp.toWorld(vp.left + vp.cx, vp.top + vp.cy) : null;
  for (const file of files) {
    const list = fontList();
    if (list.length >= MAX_FONTS) {
      toast(`A board can carry ${MAX_FONTS} faces`);
      break;
    }
    // Offered, with what it costs. A CJK face genuinely is 200MB and that's
    // not a mistake - it's accepting that every save and share carries it.
    // Declined, nothing happens and the next file in the loop is tried.
    if (file.size > MAX_BYTES && !await allow(
      fileKey(file),
      `${file.name} - ${mb(file.size)}`,
      [{
        ceiling: 'font-bytes',
        what: `This face is ${mb(file.size)}, past the ${mb(MAX_BYTES)} one is packed into a board at.`,
      }],
      'Add it',
    )) {
      continue;
    }
    const [hash, axes] = await Promise.all([addFile(file), fontAxes(file)]);
    // Same bytes, already here - dropping a face twice isn't an error.
    if (list.some(f => f.hash === hash)) continue;

    const family = uniqueFamily(await familyFrom(file), list);
    // `variable` is only consulted when there's no wght axis, so it's only
    // asked for then - sparing a second parse of the whole file for every
    // face that already carries one (the variable ones do).
    const variable = axes.some(a => a.tag === 'wght') ? false : await fontIsVariable(file);
    if (!(await register(hash, family, axes, variable))) {
      toast(`${file.name} is not a font this browser can read`, 'error');
      continue;
    }
    // `variable` is only worth storing when it's the whole of what's known -
    // with axes in hand it's implied by them, and a second field saying the
    // same thing is a second field that can disagree.
    setSetting('fonts', [...list, {
      hash,
      family,
      ...(axes.length ? { axes } : variable ? { variable: true } : {}),
    }]);
    added++;
    // A specimen on the board, in this face - the menu entry says its name, the
    // card shows its letters. Only for a face that actually registered, so a
    // declined or unreadable file leaves no card behind.
    if (at) {
      addFontCard({ x: at.x + placed * 28, y: at.y + placed * 28 }, hash, family);
      placed++;
    }
  }
  if (!added) return;
  // Two signals, because two different things changed: the menus have new
  // entries, and the board now has bytes in it that were not there before.
  bus.emit('fonts');
  toast(added === 1 ? 'Face added' : `${added} faces added`);
}

/**
 * Make the registered set match what the board says it carries. Both
 * directions - the removal half matters most: without it, opening a plain
 * board after one carrying three faces leaves those three in the menus,
 * offering a look the board cannot save.
 */
async function syncFonts() {
  const want = fontList();
  const keep = new Set(want.map(f => f.hash));
  for (const hash of [...live.keys()]) {
    if (keep.has(hash)) continue;
    // The key came out of this same map a line above.
    document.fonts.delete(live.get(hash)!.face);
    live.delete(hash);
  }
  for (const { hash, family, axes, variable } of want) {
    await register(hash, family, axes, variable);
  }
  bus.emit('fonts');
}

/**
 * The board's font list. Trusted, since normalizeBoard() in state.ts has
 * already held it to shape (valid hashes, family names inside isFamily(),
 * no duplicates) - settings are spread wholesale out of a .mbrd, so that's
 * where the check belongs rather than repeated defensively here.
 */
const fontList = () =>
  Array.isArray(board.settings.fonts) ? board.settings.fonts : [];

/**
 * Register one face with the document. Two files can honestly reduce to
 * one family name ("Inter-Regular.woff2" and "Inter-Italic.woff2" both
 * become "Inter"), and document.fonts keyed by family would let the second
 * silently replace the first - uniqueFamily() stops that; this only needs
 * to be idempotent.
 */
async function register(hash: string, family: string, axes: FontAxis[] = [], variable = false) {
  if (live.has(hash)) return true;
  const url = assetURL(hash);
  if (!url) return false;
  try {
    // Loaded before added, so a non-font file is a caught rejection here,
    // not a menu entry that paints nothing.
    //
    // Omitting the weight descriptor means `normal` (400 flat), which on a
    // variable font pins the weight axis and hands every bold to the
    // synthesiser - so an unread axis must not fall through to the empty case.
    //
    // 1-1000 when axes couldn't be read but the file has an `fvar`
    // (bracketless .woff2, bounds unknowable) - overshooting only wastes
    // slider travel, understating costs real weights.
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
function uniqueFamily(want: string, list: FontSpec[]) {
  const taken = new Set(list.map(f => f.family));
  if (!taken.has(want)) return want;
  for (let n = 2; n <= MAX_FONTS + 1; n++) {
    const tryName = `${want} ${n}`.slice(0, 40).trim();
    if (!taken.has(tryName) && isFamily(tryName)) return tryName;
  }
  return want;
}
