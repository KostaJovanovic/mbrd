// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// Small shared helpers. Deliberately dependency-free - and now actually small.
//
// This file said the same sentence for a year while holding seven unrelated
// concerns, and forty-four modules imported it - tied with state.js for the
// highest fan-in in the codebase. Almost none of them wanted what was in here.
// A module that wanted clamp() got a hand-written SHA-256, a toast renderer, a
// progress bar, a localStorage wrapper and a waveform SVG builder along with
// it, and every one of those was a thing a *specific* pair of layers needed and
// the rest merely carried. Four of them have gone:
//
//   crypto.ts           the SHA-256 and the content id it makes (2 consumers)
//   notify.ts           the announcement channel every layer speaks through
//   ui/overlays.ts      the toast and the waiting strip, which draw it
//   prefs.ts            everything that goes through localStorage
//   media/transport.ts  the scrubber's wave
//
// What is left is the actual definition of this file, and the test for whether
// something belongs in it: it is here if *most* of the graph wants it and it is
// two lines long. Anything with a subject - assets, preferences, audio,
// messages to the person - has a subject-shaped module waiting for it, and
// adding it here instead is how this file got the way it was.
//
// Deliberately not a barrel. There are no re-export shims for the five that
// left: unlike state.js, which is a facade on purpose, this was never a door,
// and a shim would let the fan-in stay exactly where it was while looking as
// though it had been fixed. Every call site names the module it means.
//
// Two functions here do touch the document - el() and readToken() - and both do
// it inside the call rather than at import time, which is what keeps every
// module that imports this loadable outside a browser (tests/imports.test.js).
// That is the one exception the "dependency-free" claim gets, and it is
// justified by the same argument as everything else here: every layer looks
// things up by id and by token name, and neither lookup has a subject.

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** The element with this id, or null. Every module wants this and no other. */
export const el = id => document.getElementById(id);

/**
 * The value of a CSS custom property on :root, trimmed.
 *
 * The design tokens are the app's single source of truth for colour, spacing,
 * duration and corner radius, and eight modules read one back out at runtime -
 * to hand a duration to a JS-driven animation, to paint a canvas in the same
 * ink as the DOM, to seed a colour picker with the accent as it currently
 * stands. All eight had written `getComputedStyle(root).getPropertyValue(n)`
 * out by hand, in five slightly different spellings: some trimmed, some did
 * not, some cached the CSSStyleDeclaration and some re-read it, one called it
 * cssVar and another readVar.
 *
 * The trim is the part that matters and the part that was inconsistent. A
 * custom property keeps the whitespace after its colon, so `--dur-palette: 300ms`
 * reads back as ` 300ms`, and whether that is harmless depends entirely on what
 * the caller does with it next - parseFloat copes, string comparison does not,
 * and concatenating it into another declaration produces something that mostly
 * works. One spelling means one answer.
 *
 * Not cached. getComputedStyle is a style flush, so this is not free and must
 * not be called per frame - canvas/grid.js says so at its own call site - but a
 * cache here would be wrong rather than merely slow: the tokens change under
 * the whimsy dial, the palette and the theme, and a stale value would be an
 * interface that is one look behind.
 */
export const readToken = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Fisher-Yates, in place, returning the same array.
 *
 * Every shuffle in the app wants an unbiased one and there is exactly one way
 * to write it, so it is written here rather than a fourth time: dealing the
 * tilt bag in canvas/items.js, and re-dealing the layout order in
 * main.js/rearrange.
 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let _seq = 0;
export function uid(prefix = 'i') {
  // Monotonic + random: unique inside a session and across merged boards.
  return prefix + (++_seq).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Minimal string-keyed event bus. Handlers never throw into the emitter. */
export function emitter() {
  const map = new Map();
  return {
    on(evt, fn) {
      (map.get(evt) || map.set(evt, new Set()).get(evt)).add(fn);
      return () => map.get(evt).delete(fn);
    },
    off(evt, fn) { map.get(evt)?.delete(fn); },
    emit(evt, payload) {
      for (const fn of map.get(evt) || []) {
        try { fn(payload); } catch (e) { console.error('[mbrd] handler for "' + evt + '"', e); }
      }
    },
  };
}

/** Collapse repeated calls into one per animation frame. */
export function rafThrottle(fn) {
  let id = 0, lastArgs = null;
  return function (...args) {
    lastArgs = args;
    if (id) return;
    id = requestAnimationFrame(() => { id = 0; fn(...lastArgs); });
  };
}

export function extOf(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(name = '') {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

/**
 * Whether something is a content id of the shape sha256() produces.
 *
 * Here rather than beside sha256() in crypto.ts, and the distance is on
 * purpose: this is the *shape* of an id, asked by layers that never make one -
 * storage/mbrd.ts spelling a hash into an archive path, state.ts deciding
 * whether an item arriving from a file may claim one, board-schema.ts holding a
 * field to it. None of them should have to import a hundred and thirty lines of
 * FIPS 180-4 to ask a question about a string. Written twice, the two would
 * drift, which is why it is written once - just not in there.
 */
export const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * A CSS family name a board is allowed to carry, for a face dropped into it.
 *
 * Here beside isHash for exactly the same reason: state.js holds the field to
 * this shape on the way in from a file, ui/fonts.js builds names that satisfy
 * it, and those two do not import each other.
 *
 * The alphabet is the point. This string is substituted into a real declaration
 * - `--font-display: "Name", serif` - and it is the only part of that
 * declaration that came out of a filename, which is to say out of a .mbrd
 * somebody else wrote. No quote to close the string early, no `;` or `}` to end
 * the declaration, no backslash to escape its way past either. Length-capped
 * because a family name is a name.
 */
export const isFamily = v =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(v);

/**
 * Every content id an item depends on: its own bytes, the picture it was given
 * (see setItemCover in state.js), and - for a model - the still that stands in
 * for it until somebody asks to turn it over (see canvas/model.js).
 *
 * Here beside isHash for the same reason isHash is here - the packer, the
 * autosave sweep, that sweep's error message and the session restore all need
 * it, and they sit in layers that do not import one another. Four inline copies
 * of `item.asset?.hash` is exactly how a second id gets missed, and missing it
 * in the sweep is the expensive one: the sweep deletes whatever no item claims,
 * so an id it has not heard of is bytes deleted out from under a live card.
 *
 * Filtered for presence, not validity. makeItem() drops an id that is not a
 * digest, and the one caller that must not silently skip a malformed one is the
 * packer - it spells the id into an archive path and refuses the whole export
 * over a bad one. Filtering here would take that refusal away and write the
 * hole instead.
 */
export const itemHashes = item =>
  [item?.asset?.hash, item?.meta?.cover, item?.meta?.shot, item?.meta?.thumb, item?.meta?.preview]
    .filter(Boolean);

/**
 * Running against the local dev server - server.bat on localhost, or a LAN IP
 * when testing from a phone. sw.js makes the same test to turn itself into a
 * pass-through; it cannot import this module, so the two are kept in step by
 * hand rather than shared.
 *
 * A function, and memoised, rather than the constant this used to be. A
 * constant meant `location` was read the moment this module was imported, and
 * because almost everything imports util.js that made the whole app impossible
 * to load anywhere without a `location` - which is to say, impossible to test
 * outside a browser. The answer cannot change within a document, so the read
 * still happens exactly once; it just happens on the first ask instead of on
 * import.
 */
let devHost = null;

export function isDev() {
  if (devHost === null) {
    const h = location.hostname;
    devHost = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  }
  return devHost;
}
