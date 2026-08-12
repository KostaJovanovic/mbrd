// Shared bits for the test suite.
//
// The app has no build step and no dependencies, and neither does this. Tests
// import the real modules out of web/ and run them under `node --test`.
//
// Anything a module needs from the browser is stubbed here rather than in the
// module itself: the point of the refactor that introduced these tests was to
// stop browser globals being reached for at import time, not to start writing
// the app around a test runner.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

/** Repo root, from tests/ */
export const ROOT = resolve(import.meta.dirname, '..');
export const WEB = join(ROOT, 'web');
export const JS = join(WEB, 'assets', 'js');

/** Every file under `dir` matching one of `exts`, as paths relative to `from`. */
export function walk(dir, exts, from = WEB) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, exts, from));
      continue;
    }
    if (exts.some(e => entry.endsWith(e))) {
      // Forward slashes: these are compared against URLs in sw.js, not paths.
      out.push(relative(from, full).split(sep).join('/'));
    }
  }
  return out;
}

export const read = path => readFileSync(path, 'utf8');

/**
 * The app's stylesheets in cascade order, concatenated - what used to be
 * app.css before it was split by subsystem.
 *
 * A test asserting that some rule exists is asking about the app's CSS, not
 * about which of eight files a rule happens to live in. Reading them as one
 * string keeps such a test true when a rule moves between subsystems, and stops
 * the split from being a thing every future assertion has to know about.
 *
 * The order is index.html's, which is the cascade - so a test that cares about
 * *precedence* (quality.css wins on document order, not specificity) still gets
 * an honest answer.
 *
 * tokens.css and fonts.css are deliberately out: they are the property table
 * and the @font-face set, and a test wanting either should say so.
 */
export const APP_CSS_ORDER = [
  'base.css', 'canvas.css', 'items.css', 'sidebar.css', 'chrome.css',
  'trash.css', 'menu.css', 'library.css', 'status.css', 'dialog.css',
  'viewer.css', 'color-picker.css', 'sticker-pad.css',
  'mobile.css', 'quality.css',
];

export const appCss = () => APP_CSS_ORDER
  .map(name => readFileSync(join(WEB, 'assets', 'css', name), 'utf8'))
  .join('\n');

/**
 * A board item, with the defaults the geometry helpers assume. Tests override
 * only the fields they care about, which keeps a case about rotation from
 * being buried in eight irrelevant properties.
 */
export function item(props = {}) {
  return { id: 'i1', type: 'generic', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 1, name: '', asset: null, meta: {}, ...props };
}

/** Deterministic bytes, so a failure is reproducible rather than a one-off. */
export function bytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let h = seed >>> 0;
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    out[i] = h & 0xff;
  }
  return out;
}

/** Bytes that compress hard - a run of one value. For ratio/bomb tests. */
export const zeros = n => new Uint8Array(n);

/**
 * A content id of the right *shape*, from a short readable label.
 *
 * Tests used to write hashes as 'abc123', which read nicely and hid the fact
 * that a hash is a 64-character hex digest that the storage layer now checks
 * before letting it name a file. `hash('photo')` keeps a case readable while
 * being something the app would accept.
 *
 * Shape only - these do not digest to anything. Where the *content* has to
 * match the id, use realHash().
 */
export const hash = label => {
  const hex = [...label].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return (hex + 'f'.repeat(64)).slice(0, 64);
};

/** The actual SHA-256 of some bytes, for the paths that verify content. */
export async function realHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
