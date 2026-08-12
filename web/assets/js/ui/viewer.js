// The viewer: one item off the board, as big as the window will allow.
//
// A board is a wall of things at a glance, and that is what it is for - but
// until this there was no second look. A photograph was however many pixels its
// card happened to be; a clip had no full screen; a text file showed its first
// screenful and stopped at whatever the card's height cut it off at. On the Feed
// - which on a phone *is* the board - a tap on most types did nothing at all.
//
// One surface for every type rather than one per type. VIEWS below is the same
// shape as RENDERERS in canvas/renderers.js: a table keyed by what the item is,
// each entry handed the item and the body to fill. A new type is one entry, and
// nothing else in this file or in the markup changes. That is deliberate and it
// is why this was built before it was needed for documents - the argument for
// the surface is images and video, which need no parser at all; the document
// formats are entries that arrive later.
//
// A real <dialog>, opened with showModal(). Three things come free with that and
// each of them is a thing not to reimplement: the top layer (so nothing on the
// board can paint over it), the backdrop, and Escape. canvas/input.js already
// stands the board's own shortcuts down while a modal is up, so arrow keys and
// Delete do not reach the board through this.
//
// Nothing here reaches `document` at import time - initViewer() does, and
// tests/imports.test.js holds this file to that.

import { byId } from '../state.js';
import { assetURL, getAsset, readText } from '../storage/assets.js';
import { baseName, formatBytes } from '../util.js';
import { linkURL } from '../canvas/renderers.js';
import { renderMarkdown } from './markdown.js';

/**
 * How much of a text file the viewer reads.
 *
 * Ten times the card's preview and five times the Feed tile's, because this is
 * the place the whole file is supposed to be. Still a cap: a board can hold a
 * log nobody meant to drop on it, and a dialog that locks the tab laying out
 * forty megabytes of one line is a worse answer than a truncated read that says
 * so at the bottom.
 */
const TEXT_MAX = 200000;

/** The extensions that get read as prose rather than shown as source. */
export const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);

let dlg = null;
let titleEl = null;
let metaEl = null;
let bodyEl = null;

export function initViewer() {
  dlg = document.getElementById('viewer');
  if (!dlg) return;
  titleEl = document.getElementById('viewer-title');
  metaEl = document.getElementById('viewer-meta');
  bodyEl = document.getElementById('viewer-body');
  document.getElementById('viewer-close')?.addEventListener('click', () => closeViewer());
  // A press on the backdrop closes, the way every other overlay in this app
  // does. A <dialog> fills the top layer, so the press lands on the dialog
  // itself and the only way to tell backdrop from sheet is where it landed.
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeViewer();
  });
  // Escape reaches the dialog as a close request whatever had focus. The
  // teardown has to run for it too, or the next viewing inherits a video still
  // playing behind a closed dialog.
  dlg.addEventListener('close', teardown);
}

/**
 * Is there anything worth showing this item full size?
 *
 * Asked by the callers rather than answered with an empty dialog: a tap that
 * opens a sheet saying "nothing to show" is worse than a tap that does nothing,
 * because it costs a second press to get back to where you were.
 */
export function canView(id) {
  const item = byId(id);
  if (!item) return false;
  return !!VIEWS[item.type];
}

export function openViewer(id) {
  const item = byId(id);
  if (!dlg || typeof dlg.showModal !== 'function' || !item) return;
  const view = VIEWS[item.type];
  if (!view) return;

  titleEl.textContent = baseName(item.name) || item.name || item.type;
  metaEl.textContent = describe(item);
  bodyEl.replaceChildren();
  dlg.dataset.type = item.type;
  view(item, bodyEl);
  dlg.showModal();
  // The body, not the close button. Scrolling a long file with the keyboard is
  // the first thing anybody does in here, and a focused button swallows Space.
  bodyEl.focus?.();
}

export function closeViewer() {
  if (dlg?.open) dlg.close();   // 'close' runs teardown
}

/**
 * Everything this viewing was holding, put down.
 *
 * A <video> left in a detached subtree keeps its decoder and, on some engines,
 * keeps playing - so it is stopped and emptied by hand rather than trusted to be
 * collected. Nothing else needs releasing: every URL in here comes from
 * assetURL(), which mints one per asset for the life of the board and revokes
 * them all when the board closes. Revoking one here would take the picture off
 * the card that is still showing it.
 */
function teardown() {
  for (const el of bodyEl?.querySelectorAll?.('video, audio') || []) {
    try { el.pause(); } catch { /* already gone */ }
    el.removeAttribute('src');
    el.load?.();
  }
  bodyEl?.replaceChildren();
  delete dlg.dataset.type;
}

/** The line under the name: what the file is and how big. */
function describe(item) {
  const asset = item.asset?.hash ? getAsset(item.asset.hash) : null;
  const ext = (item.meta?.ext || '').toUpperCase();
  return [ext, asset && formatBytes(asset.size)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

const VIEWS = {
  /**
   * A picture, at its own size or the window's, whichever is smaller.
   *
   * The original asset and not meta.thumb or meta.preview: this is the one place
   * in the app where the full-size file is what is wanted, since every other
   * surface is showing it inside a box. The preview is the fallback, and for an
   * undecodable original (HEIC, RAW) it is the only thing that will draw - so it
   * is tried second rather than not at all.
   */
  image(item, host) {
    const url = assetURL(item.asset?.hash) || assetURL(item.meta?.preview);
    if (!url) return void host.append(nothing('That picture is not in this board'));
    const img = document.createElement('img');
    img.className = 'viewer-media';
    img.alt = item.name || '';
    img.decoding = 'async';
    img.src = url;
    host.append(img);
  },

  /**
   * A clip, with the browser's own controls.
   *
   * Its poster is on it, so the frame is there before the first byte of video
   * is - which on a phone is the difference between a black rectangle and the
   * picture the card was already showing. Not autoplaying: opening a thing to
   * look at it is not the same as asking it to start.
   */
  video(item, host) {
    const url = assetURL(item.asset?.hash);
    if (!url) return void host.append(nothing('That clip is not in this board'));
    const el = document.createElement('video');
    el.className = 'viewer-media';
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
    const poster = assetURL(item.meta?.cover || item.meta?.poster);
    if (poster) el.poster = poster;
    el.src = url;
    host.append(el);
  },

  /** A sound file, with its cover above it when it carries one. */
  audio(item, host) {
    const cover = assetURL(item.meta?.cover);
    if (cover) {
      const art = document.createElement('img');
      art.className = 'viewer-cover';
      art.alt = '';
      art.src = cover;
      host.append(art);
    }
    const url = assetURL(item.asset?.hash);
    if (!url) return void host.append(nothing('That track is not in this board'));
    const el = document.createElement('audio');
    el.className = 'viewer-audio';
    el.controls = true;
    el.preload = 'metadata';
    el.src = url;
    host.append(el);
  },

  /**
   * A text file, whole and scrolling - as prose if it is Markdown, as source if
   * it is anything else.
   *
   * The split is by extension and only by extension. Markdown is the one thing
   * in this bucket written to be *read*, and reading a README as hashes and
   * asterisks is reading the scaffolding instead of the building. Everything
   * else classify() routes here - JSON, CSS, a log, a Python file - is written
   * to be read as source, and rendering it would be the viewer deciding it knew
   * better.
   *
   * Both paths end in text nodes. <pre> plus textContent for source; for
   * Markdown, ui/markdown.js builds DOM and never touches innerHTML, so raw HTML
   * inside the file shows as the characters it is made of rather than running.
   * That is not a nicety here: these are files the app did not write.
   */
  text(item, host) {
    const md = MARKDOWN.has(item.meta?.ext || '');
    const holder = document.createElement(md ? 'div' : 'pre');
    holder.className = md ? 'viewer-md' : 'viewer-text';
    host.append(holder);
    const hash = item.asset?.hash;
    if (!hash) return;
    readText(hash, TEXT_MAX).then(text => {
      if (!holder.isConnected) return;
      if (md) holder.append(renderMarkdown(text));
      else holder.textContent = text;
      if (text.length >= TEXT_MAX) {
        const more = document.createElement('p');
        more.className = 'viewer-note';
        more.textContent = `first ${formatBytes(TEXT_MAX)} shown`;
        holder.after(more);
      }
    }).catch(() => { holder.textContent = ''; });
  },

  /** A sticky, at reading size rather than at whatever the board shrank it to. */
  note(item, host) {
    const sheet = document.createElement('div');
    sheet.className = 'viewer-note-sheet';
    const rich = item.meta?.rich;
    sheet.textContent = Array.isArray(rich?.blocks) && rich.blocks.length
      ? rich.blocks.map(b => b?.text || '').join('\n').trim()
      : (item.meta?.text || item.name || '').trim();
    const tint = item.meta?.color;
    if (tint) sheet.style.background = tint;
    host.append(sheet);
  },

  /** A link: its address, large, and a way to follow it. */
  link(item, host) {
    const u = linkURL(item.meta?.url);
    if (!u) return void host.append(nothing('That is not an address this app will open'));
    const a = document.createElement('a');
    a.className = 'viewer-link';
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = u.href;
    host.append(a);
  },
};

/** A card is not always openable, and saying so beats an empty sheet. */
function nothing(words) {
  const p = document.createElement('p');
  p.className = 'viewer-note';
  p.textContent = words;
  return p;
}
