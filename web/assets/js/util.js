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

/** SHA-256 hex of an ArrayBuffer/Uint8Array - the content id for assets. */
export async function sha256(buf) {
  const src = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', src);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let toastTimer = 0;
let toastHide = 0;
/**
 * How long the toast takes to fade, paired with the `transition` on #toast in
 * app.css. The element is only hidden once the fade has run - hiding it on the
 * old schedule would cut the fade off at its first frame.
 */
const TOAST_FADE_MS = 300;
/**
 * A sequence number, so a fade that is already in flight cannot hide a message
 * that arrived after it. Clearing the timers is not enough on its own: the
 * inner timeout is scheduled by the outer one, so the moment between them
 * belongs to no timer this call can see.
 */
let toastSeq = 0;

/** One-line status message at the bottom of the screen. */
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  const mine = ++toastSeq;
  clearTimeout(toastTimer);
  clearTimeout(toastHide);
  el.textContent = msg;
  el.classList.toggle('is-error', kind === 'error');
  // Back to full strength before anything else. A message arriving while the
  // last one is on its way out would otherwise inherit its dying opacity and
  // read as a flicker rather than as something new being said.
  el.classList.remove('is-going');
  el.hidden = false;
  toastTimer = setTimeout(() => {
    el.classList.add('is-going');
    toastHide = setTimeout(() => {
      if (mine !== toastSeq) return;
      el.hidden = true;
      el.classList.remove('is-going');
    }, TOAST_FADE_MS);
  }, kind === 'error' ? 6000 : 2600);
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
