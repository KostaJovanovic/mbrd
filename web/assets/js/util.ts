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
//
// The one import below is the other exception, and it is emitter()'s alone.
// "Dependency-free" was always a claim about *subjects* - this file carries no
// assets, no preferences, no messages - and errors.ts is not a subject, it is
// the place a thing that was caught goes so that it is not also lost. The
// alternative was an injected reporter and a fifth setter, which would have
// bought nothing: errors.ts imports notify.ts and nothing else, so the edge is
// two modules deep and stays inside the base layer.

import { reportCaught } from './errors.ts';

export const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

/** The element with this id, or null. Every module wants this and no other. */
export const el = (id: string) => document.getElementById(id);

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
export const readToken = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Fisher-Yates, in place, returning the same array.
 *
 * Every shuffle in the app wants an unbiased one and there is exactly one way
 * to write it, so it is written here rather than a fourth time: dealing the
 * tilt bag in canvas/items.js, and re-dealing the layout order in
 * main.js/rearrange.
 */
export function shuffle<T>(arr: T[]): T[] {
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

/**
 * Minimal string-keyed event bus. Handlers never throw into the emitter.
 *
 * The catch below is not defensive tidying, it is the contract: twenty
 * subscribers listen to 'geom' and one of them being broken must not stop the
 * other nineteen from repainting. That is right and it stays.
 *
 * What it used to do as well was lose the error. A subscriber that throws on
 * every geom - which is several a second while a card is being dragged - wrote
 * to a console nobody has open and reached window.onerror never, because the
 * throw was caught right here. It was the audit's own example of a board that
 * stops responding with nothing to read (Finding 6,
 * research/old/build-and-framework-audit-2026-08-12.md), and a global handler alone
 * would not have seen a single one of them. So the catch also says so, once:
 * errors.ts holds it to one toast per distinct fault however many times it
 * arrives, which is what makes this safe to call from the hot path at all.
 *
 * The type parameter is the bus's own event table - a plain object type mapping
 * each event name to what is handed to a handler of it (see BusEvents in
 * board-store.ts). It is the emitter that is generic and the caller that names
 * its events, because the two emitters in the app carry unrelated traffic and
 * neither should have to know about the other's.
 */
export type Emitter<E = Record<string, unknown>> = {
  on<K extends keyof E & string>(evt: K, fn: (payload: E[K]) => void): () => void,
  off<K extends keyof E & string>(evt: K, fn: (payload: E[K]) => void): void,
  emit<K extends keyof E & string>(evt: K, payload?: E[K]): void,
};

export function emitter<E = Record<string, unknown>>(): Emitter<E> {
  // Handlers of different events have different payload types, and a Map has
  // one value type for all of them. `never` in the parameter is what every
  // handler signature has in common - a function that accepts a string is a
  // function that accepts nothing narrower - so this stores all of them without
  // widening any to any.
  const map = new Map<string, Set<(payload: never) => void>>();
  return {
    on(evt, fn) {
      // Non-null twice: set() returns the Map, so get() straight after it finds
      // the Set that line just put there; and the unsubscriber can only run
      // after the same on() call registered the event.
      (map.get(evt) || map.set(evt, new Set()).get(evt)!).add(fn);
      return () => map.get(evt)!.delete(fn);
    },
    off(evt, fn) { map.get(evt)?.delete(fn); },
    emit(evt, payload) {
      for (const fn of map.get(evt) || []) {
        try {
          // SAFETY: safe by construction - on() checked this handler against
          // the payload type of this same event name, which is what the Map
          // cannot remember. The catch is for what the handler does, not for
          // this.
          (fn as (payload?: E[typeof evt]) => void)(payload);
        }
        catch (e) { reportCaught(e, 'handler for "' + evt + '"'); }
      }
    },
  };
}

/** Collapse repeated calls into one per animation frame. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void) {
  let id = 0;
  let lastArgs: A | null = null;
  return function (...args: A) {
    lastArgs = args;
    if (id) return;
    // Non-null: nothing clears lastArgs, and the line above set it before this
    // frame was ever asked for.
    id = requestAnimationFrame(() => { id = 0; fn(...lastArgs!); });
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

export function formatBytes(n: number) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

/**
 * Whether something is an object that may be looked into, key by key.
 *
 * Here for the same reason as everything else in this file: most of the graph
 * wants it and it is two lines long. Every module that reads a document it did
 * not write starts by asking this - the schema, the item reader, the quality
 * dial's saved override - and each had written `v && typeof v === 'object'` out
 * by hand, which says the same thing without narrowing anything. `null` is the
 * whole reason the second half exists.
 *
 * The values are `unknown`, not any: knowing that a key can be read is not the
 * same as knowing what came back, and the caller narrows what it takes.
 *
 * An array is not one. It used to be - `typeof [] === 'object'` and it is not
 * null - and every one of the ninety-odd callers then read named keys off a
 * list and got `undefined` back, which is the answer to a question nobody
 * asked. Where that mattered it mattered badly: a `.mbrd` whose `board.json` is
 * `[1,2,3]` passed the guard, spread into a board, and replaced the open one
 * with a blank. Nothing in the graph passes a list to this on purpose - the
 * comparators beside it compare four named fields, not elements - so the narrow
 * reading is the one every caller already meant.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Own-property test, written the long way round.
 *
 * `Object.hasOwn` is the modern spelling and says exactly this, but it landed in
 * **Safari 15.4** - and the six places that reached for it are guards on tables
 * anybody with a console can put a key into: a layout name, an embed kind, a
 * quality stop, a gesture, a renderer type, a sound cue. Every one of them runs
 * on an ordinary path and two of them run during boot, so on an older WebKit
 * this was a TypeError rather than a missing nicety.
 *
 * `Object.prototype.hasOwnProperty.call` is the same question asked of the same
 * object and is as old as the language. Called off the prototype rather than off
 * the value, which is the whole point of the exercise: the map being tested may
 * hold a key named `hasOwnProperty`, and asking it directly would be asking the
 * very thing under suspicion.
 */
export const hasOwn = <T extends object>(table: T, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

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
export const isHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

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
export const isFamily = (v: unknown): v is string =>
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
 *
 * Structurally typed rather than taking board-model.ts's Item, because
 * board-model.ts imports this file and the edge only goes one way. Anything
 * with the two fields answers, which is also what lets a half-built item from a
 * reader be asked.
 *
 * The predicate is filter(Boolean) with the answer written down: meta is
 * `unknown` per key on purpose (see board-model.ts), so the truthy ones have to
 * be called strings by hand. The one caller that would care if a key held
 * something else is the packer, which refuses a bad id rather than trusting it.
 */
export const itemHashes = (
  item: { asset?: { hash?: string } | null, meta?: Record<string, unknown> | null } | null | undefined,
): string[] =>
  [
    item?.asset?.hash, item?.meta?.cover, item?.meta?.shot,
    item?.meta?.thumb, item?.meta?.preview,
    // `poster` is a legacy key - nothing writes it any more, and
    // optimize/optimize.ts still resolves it. It was on neither this list nor
    // META_HASHES, so on a board old enough to carry one the bytes were in
    // neither the packer's reference union nor the autosave sweep's: the first
    // sweep after opening such a board deleted them, and the next export
    // omitted them. A key nothing writes is still a key files contain.
    item?.meta?.poster,
  ].filter((h): h is string => Boolean(h));

/**
 * Running against the local dev server - server.bat on localhost, or a LAN IP
 * when testing from a phone. sw.js makes the same test to turn itself into a
 * pass-through; it cannot import this module, so the two are kept in step by
 * hand rather than shared.
 *
 * **Nothing calls this, and it stays anyway.** tests/sw.test.js reads the regex
 * straight out of this file and asserts sw.js carries the same one, so this is
 * the anchor half of a parity check rather than dead code - deleting it does
 * not fail a type check or a lint, it fails that test, and the failure mode it
 * guards against is a service worker that caches the dev server.
 *
 * A function, and memoised, rather than the constant this used to be. A
 * constant meant `location` was read the moment this module was imported, and
 * because almost everything imports util.js that made the whole app impossible
 * to load anywhere without a `location` - which is to say, impossible to test
 * outside a browser. The answer cannot change within a document, so the read
 * still happens exactly once; it just happens on the first ask instead of on
 * import.
 */
let devHost: boolean | null = null;

export function isDev() {
  if (devHost === null) {
    const h = location.hostname;
    devHost = h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  }
  return devHost;
}

