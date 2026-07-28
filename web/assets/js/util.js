// Small shared helpers. Deliberately dependency-free.

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** The element with this id, or null. Every module wants this and no other. */
export const el = id => document.getElementById(id);

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

// ---------------------------------------------------------------------------
// Preferences
//
// The things that follow the *user* rather than the board - the look, the
// volume, whether the panel is open - as against everything in board.settings,
// which travels inside the .mbrd.
//
// Every one of these reads and writes has to be wrapped, because localStorage
// is not merely empty in a private window: touching it throws outright, and an
// uncaught throw on the way through boot would take the whole app with it over
// a remembered slider position. That wrapper was written out by hand six times
// before it was written down once.
// ---------------------------------------------------------------------------

export function readPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); return true; }
  catch { return false; }
}

/**
 * The same, for a value stored as JSON. Two ways to get nothing back - storage
 * refused, or what came out will not parse - and they want the same answer,
 * because a preference that cannot be read is a preference that was not set.
 */
export function readPrefJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Every key this app writes wears it. The only reason it is named here. */
export const PREF_PREFIX = 'mbrd.';

/**
 * Forget every preference, whichever module happens to own it.
 *
 * Swept by prefix rather than from a list, and that is deliberate: a list is a
 * second place to remember a new preference, and the one time it is read - a
 * user asking for everything to be deleted - is the one time being one key out
 * of date is a promise broken rather than a small bug. Each key's owner keeps
 * naming its own; nothing has to register anywhere.
 *
 * Collected before anything is removed, because removing from a live Storage
 * while walking it by index skips every other key.
 */
export function clearPrefs() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREF_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
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
 * Lives here, beside the function that makes them, because two layers that
 * never import each other both have to know: storage/mbrd.js spells a hash into
 * an archive path, and state.js decides whether an item arriving from a file is
 * allowed to claim one. Written twice, they would drift.
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
  [item?.asset?.hash, item?.meta?.cover, item?.meta?.shot, item?.meta?.thumb].filter(Boolean);

/**
 * SHA-256 hex of an ArrayBuffer/Uint8Array - the content id for assets.
 *
 * The browser's own implementation where there is one, and a hand-written one
 * where there is not. That second path is not a curiosity: `crypto.subtle`
 * exists only in a secure context, so an app served from `http://` at anything
 * other than localhost - a phone opening the dev server over the LAN, a board
 * shared off a machine on the desk - does not have it. Every import hashes its
 * bytes before it becomes an item, so without a fallback the entire way in
 * fails at once and says "Nothing could be imported", on a page that otherwise
 * looks perfectly well.
 *
 * Same digest either way, which is the point rather than a nicety: content ids
 * are written into `.mbrd` archives and compared across machines, so a file
 * added on the phone has to hash to what the same file hashes to here.
 */
export async function sha256(buf) {
  const bytes = buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return [...await sha256Words(bytes)].map(w => (w >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The first thirty-two bits of the fractional cube roots of the first 64 primes. */
const SHA_K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * How much is hashed between breaths, in bytes.
 *
 * This runs about twenty-five times slower than the native digest, so a video
 * dropped on a board is seconds of work rather than a fraction of one, and all
 * of it on the thread that draws. A quarter of a megabyte is roughly a frame's
 * worth: small enough that the board still answers a pan while it thinks,
 * large enough that the yields cost nothing measurable.
 */
const HASH_SLICE = 256 * 1024;

/**
 * Hand the thread back for one turn.
 *
 * A message channel rather than setTimeout, and the difference is not academic:
 * a timeout nested more than five deep is clamped to four milliseconds by every
 * browser, and this loop nests one per slice - which on a twelve megabyte file
 * is more time spent waiting out the clamp than hashing. A posted message is
 * scheduled as a task like any other, so the frame still gets drawn between
 * slices, but nothing is added to the wait.
 */
function breathe() {
  return new Promise(done => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); port2.close(); done(); };
    port2.postMessage(0);
  });
}

/**
 * FIPS 180-4, eight words out.
 *
 * Walked in place rather than over a padded copy - the input can be a video,
 * and a second three-hundred-megabyte array to write one 0x80 byte into is not
 * a thing to allocate. Only the final block, or the final two when the length
 * does not leave room for the count, is built separately.
 */
async function sha256Words(bytes) {
  const H = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  const n = bytes.length;
  const whole = n - (n % 64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < whole; i += 64) {
    shaBlock(H, w, view, i);
    if (i && i % HASH_SLICE === 0) await breathe();
  }

  // 0x80, then zeros, then the length in bits as a big-endian 64. Two blocks
  // when the remainder leaves fewer than nine bytes for it.
  const rest = n - whole;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(bytes.subarray(whole));
  tail[rest] = 0x80;
  const tv = new DataView(tail.buffer);
  const bits = n * 8;
  tv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  tv.setUint32(tail.length - 4, bits >>> 0);
  for (let i = 0; i < tail.length; i += 64) shaBlock(H, w, tv, i);
  return H;
}

function shaBlock(H, w, view, off) {
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

/**
 * How long a toast takes to fade, paired with the `transition` on .toast-line in
 * app.css. A line is only removed once the fade has run - removing it on the old
 * schedule would cut the fade off at its first frame.
 */
const TOAST_FADE_MS = 300;

/**
 * The most lines kept on screen at once.
 *
 * They stack rather than replace one another now, so a sequence - "Loading the
 * encoder…", then what it did - can be read in order instead of the last word
 * wiping out the one that explained it. A cap so a burst (an import that touches
 * forty files) cannot paper the screen; the oldest drops when a new one would
 * push past it.
 */
const TOAST_MAX = 5;

/** One-line status message at the foot of the screen. Newest at the bottom. */
export function toast(msg, kind = '') {
  // Same bargain isDev() makes below: nothing in this file may assume a
  // browser is present, or the modules that import it stop being loadable
  // outside one. Saying something to a user who is not there is not an error,
  // it is a no-op - so state.js can leave a receipt without every caller
  // having to know whether there is a screen to leave it on.
  if (typeof document === 'undefined') return;
  const host = document.getElementById('toast');
  if (!host) return;
  // A line of its own rather than the host's text, so a new message rises under
  // the last instead of overwriting it. The host is a bottom-anchored column, so
  // appending puts the newest at the foot and lifts the older ones above it.
  const line = document.createElement('div');
  line.className = kind === 'error' ? 'toast-line is-error' : 'toast-line';
  line.textContent = msg;
  host.append(line);
  // Over the cap: the oldest goes at once, before it has finished its own life.
  while (host.children.length > TOAST_MAX) host.firstChild.remove();
  // Each line keeps its own clock - errors linger, the rest are receipts - and
  // fades then removes itself. A line dropped early by the cap is already off the
  // DOM, so remove() on it is a harmless no-op when the timer comes round.
  setTimeout(() => {
    line.classList.add('is-going');
    setTimeout(() => line.remove(), TOAST_FADE_MS);
  }, kind === 'error' ? 6000 : 2600);
}

// ---------------------------------------------------------------------------
// The waiting strip
//
// Here beside toast() and for the same reason: it is a thing every layer needs
// to be able to say and no layer should have to own. The importer, the
// optimiser, the packer and the model loader all sit below ui/ and all of them
// can take seconds - and this file is the one place below them that is allowed
// to touch the document (see the note inside toast()).
//
// The two of them divide the job cleanly. A toast is a *receipt*: it arrives
// after the fact, says what happened, and goes. This is a *state*: it is up for
// exactly as long as the app is unable to answer, and it says what is being
// waited on. That is why they can be on screen together and why neither
// replaces the other.
// ---------------------------------------------------------------------------

/**
 * How long a job must last before it is worth mentioning.
 *
 * Most imports are one small file and finish inside a frame or two. Showing a
 * panel for those would be a flash of furniture rather than information, and a
 * flash reads as a fault. Anything under this simply happens.
 */
const BUSY_SHOW_MS = 180;

/**
 * And how long it stays once it has appeared.
 *
 * The pair matters more than either number. Without a floor, a job that crosses
 * the delay by a hair puts the strip up and takes it away in the same breath -
 * which is the flash the delay was there to prevent, arriving by the other
 * door.
 */
const BUSY_MIN_MS = 450;

/** Live jobs, oldest first. The newest one gets to say what it is doing. */
const busyJobs = [];
let busyShowTimer = 0;
let busyHideTimer = 0;
let busyShownAt = 0;
/**
 * Whether the strip is meant to be up, tracked separately from the class that
 * puts it up.
 *
 * The class is applied a frame after the decision, so that the panel has a
 * previous state to animate from. A job that ends inside that frame would find
 * no class to remove and leave the pending frame to raise a strip that nothing
 * is left to lower - a spinner that never stops, over a board that is perfectly
 * idle. The flag is what that frame checks.
 */
let busyOpen = false;

/**
 * Say that something is being waited on. Returns the handle that ends it.
 *
 *   const job = busy('Reading 40 files');
 *   job.step(12, 40);            // a bar that means something
 *   job.label('Optimising');     // the same wait, a different phase
 *   job.end();                   // always, including on the failure path
 *
 * Jobs stack rather than replace: two things running at once keep the strip up
 * until both are done, and the strip shows the most recent, because that is the
 * one whose progress is still changing.
 *
 * `end()` is idempotent, so a `finally` that runs twice cannot leave the count
 * below zero - which would strand the strip open for the rest of the session.
 */
export function busy(label = 'Working') {
  const job = { label, done: 0, total: 0, live: true };
  busyJobs.push(job);
  busySchedule();
  return {
    label(text) { job.label = text || job.label; busyPaint(); },
    /** Switch the bar from "something is happening" to "this much of it". */
    step(done, total) { job.done = done; job.total = total; busyPaint(); },
    end() {
      if (!job.live) return;
      job.live = false;
      const i = busyJobs.indexOf(job);
      if (i >= 0) busyJobs.splice(i, 1);
      busySchedule();
    },
  };
}

function busySchedule() {
  if (typeof document === 'undefined') return;
  if (busyJobs.length) {
    clearTimeout(busyHideTimer);
    busyPaint();
    if (busyOpen || busyShowTimer) return;
    busyShowTimer = setTimeout(() => {
      busyShowTimer = 0;
      if (!busyJobs.length) return;
      busyOpen = true;
      busyShownAt = Date.now();
      busyPaint();
      const node = document.getElementById('busy');
      if (node) node.hidden = false;
      // Same one-frame gap the threads in canvas/web.js need: an element that
      // arrives and is told its target in the same tick has nothing to
      // interpolate from, so the entrance simply does not play.
      requestAnimationFrame(() => {
        if (busyOpen && node) node.classList.add('is-up');
      });
    }, BUSY_SHOW_MS);
    return;
  }

  // Nothing left to wait for.
  clearTimeout(busyShowTimer);
  busyShowTimer = 0;
  if (!busyOpen) return;
  const shown = Date.now() - busyShownAt;
  if (shown >= BUSY_MIN_MS) busyClose();
  else busyHideTimer = setTimeout(busyClose, BUSY_MIN_MS - shown);
}

function busyClose() {
  busyOpen = false;
  const node = document.getElementById('busy');
  if (!node) return;
  node.classList.remove('is-up');
  // Left in the tree until the exit has run, then taken out of the accessibility
  // tree properly rather than merely being transparent.
  busyHideTimer = setTimeout(() => { if (!busyOpen) node.hidden = true; }, 260);
}

function busyPaint() {
  if (typeof document === 'undefined') return;
  const node = document.getElementById('busy');
  if (!node || !busyOpen) return;
  const job = busyJobs[busyJobs.length - 1];
  if (!job) return;
  const label = document.getElementById('busy-label');
  const count = document.getElementById('busy-count');
  const fill = document.getElementById('busy-fill');
  if (label) label.textContent = busyJobs.length > 1 ? `${job.label} (+${busyJobs.length - 1})` : job.label;
  const known = job.total > 0;
  if (count) count.textContent = known ? `${job.done}/${job.total}` : '';
  // Two different bars sharing one element. Determinate is a width this code
  // sets; indeterminate is a transform a stylesheet animates - and it has to be
  // the stylesheet, because the work being waited on is often synchronous and
  // would sit on any animation this thread was running. A compositor-driven
  // slide keeps moving while the main thread hashes a video; a rAF loop stops
  // dead at exactly the moment somebody is looking at it for reassurance.
  node.classList.toggle('is-counting', known);
  if (fill && known) fill.style.width = Math.round(100 * Math.min(1, job.done / job.total)) + '%';
  else if (fill) fill.style.width = '';
}

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
