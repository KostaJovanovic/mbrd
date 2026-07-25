// Small shared helpers. Deliberately dependency-free.

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

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

/** SHA-256 hex of an ArrayBuffer/Uint8Array - the content id for assets. */
export async function sha256(buf) {
  const src = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', src);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let toastTimer = 0;
/** One-line status message at the bottom of the screen. */
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', kind === 'error');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 2600);
}
