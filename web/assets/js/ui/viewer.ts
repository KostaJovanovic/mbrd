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

import { byId, itemAdjust, itemCrop, flipTransform } from '../state.ts';
import { displayURLReady, ensureDisplay } from '../canvas/display.ts';
import { assetURL, getAsset, readText } from '../storage/assets.ts';
import { baseName, formatBytes } from '../util.ts';
import { linkURL } from '../canvas/renderers.ts';
import { noteTint } from '../canvas/note-model.ts';
import { renderMarkdown } from './markdown.ts';
// Statically: the reader's only import is storage/zip.js, which is already in
// memory because it is what opens every .mbrd, and the browser's own DOMParser.
// There is no dependency to defer, so deferring it would only buy a second
// module fetch at the moment somebody asked to see something.
import { canReadDocument, readDocument } from './documents.ts';
import type { Item } from '../board-model.ts';

/**
 * `meta` is open by design (see board-model.ts), so the three things this file
 * reads out of it are narrowed here rather than trusted. A key that is not a
 * string is treated exactly as a missing one, which is what every one of these
 * reads already did by falling through a `||`.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The object URL for a hash out of `meta`, or null for anything that is not one. */
const urlOf = (hash: unknown): string | null => (typeof hash === 'string' ? assetURL(hash) : null);

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

// The dialog and its three slots, taken once in initViewer(). Everything past
// that guard reads them with `!`: initViewer() returns early without the
// dialog, and openViewer() refuses before it touches any of them.
let dlg: HTMLDialogElement | null = null;
let titleEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;

/** The blob URLs the open document minted, if this viewing is showing one. */
let releaseDoc: (() => void) | null = null;
/** The open PDF, if this viewing is one. Parsed documents are not small. */
let pdfDoc: { destroy: () => void } | null = null;

export function initViewer() {
  // SAFETY: #viewer is the <dialog> in index.html; the showModal test in
  // openViewer() is the real guard, and it covers an engine with no dialog
  // support too - which is why this is a cast rather than an instanceof.
  dlg = document.getElementById('viewer') as HTMLDialogElement | null;
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
    const r = dlg!.getBoundingClientRect();
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
export function canView(id: string) {
  const item = byId(id);
  if (!item) return false;
  return !!viewFor(item);
}

/**
 * Which view opens this item.
 *
 * Documents are asked about *first*, and by extension rather than by type,
 * because a document does not have a type of its own on this board: a .docx that
 * carried a thumbnail imported as an `image` (import/document.js found its baked
 * preview) and one that did not imported as `generic`. Neither says "document",
 * and both should open as one. The type table below is the fallback and covers
 * everything the board draws natively.
 */
function viewFor(item: Item): View | null {
  if (!item.asset?.hash) return VIEWS[item.type] || null;
  if (PDF_EXTS.has(str(item.meta?.ext))) return pdfView;
  if (canReadDocument(item.meta?.ext)) return documentView;
  return VIEWS[item.type] || null;
}

/** The two extensions the PDF renderer opens. See isPdf() in import/drop.js. */
const PDF_EXTS = new Set(['pdf', 'ai']);

export function openViewer(id: string) {
  const item = byId(id);
  if (!dlg || typeof dlg.showModal !== 'function' || !item) return;
  const view = viewFor(item);
  if (!view) return;

  titleEl!.textContent = baseName(item.name) || item.name || item.type;
  metaEl!.textContent = describe(item);
  bodyEl!.replaceChildren();
  dlg.dataset.type = item.type;
  // Which of the two shapes this viewing is - a lightbox or a page. The test is
  // on the view that was *dispatched to* rather than on the item's type, and
  // that is the whole reason it is here and not a lookup in the stylesheet: a
  // .docx that imported as an `image` because import/document.ts found its baked
  // preview is type image and opens as a document, and a document read on a
  // black ground with no page under it would be unreadable. viewFor() has
  // already answered this question; this only writes down what it said.
  if (view === VIEWS.image || view === VIEWS.video) dlg.dataset.media = '';
  else delete dlg.dataset.media;
  view(item, bodyEl!);
  // The picture, once the view has mounted it. A clip is deliberately left out:
  // its controls are things to press, and a wheel or a drag over them meaning
  // zoom would take the scrubber away.
  const pic = bodyEl!.querySelector<HTMLImageElement>('img.viewer-media');
  if (pic) detachZoom = attachZoomPan(pic, bodyEl!);
  dlg.showModal();
  // The body, not the close button. Scrolling a long file with the keyboard is
  // the first thing anybody does in here, and a focused button swallows Space.
  bodyEl!.focus?.();
}

function closeViewer() {
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
  for (const el of bodyEl?.querySelectorAll?.<HTMLMediaElement>('video, audio') || []) {
    try { el.pause(); } catch { /* already gone */ }
    el.removeAttribute('src');
    el.load?.();
  }
  // A document's pictures come out of its own container as blob URLs this app
  // minted, and those are not in the asset store - nothing else will ever revoke
  // them. Opening a hundred-page comic and closing it again would otherwise leak
  // a hundred decoded images for the life of the tab.
  releaseDoc?.();
  releaseDoc = null;
  // And the parsed PDF, which holds the whole file plus its object graph. The
  // body is emptied a line below, which is also what stops a batch still running
  // - it checks that the page list is still connected between pages.
  pdfDoc?.destroy();
  pdfDoc = null;
  // The zoom's listeners are on the picture, which is about to be thrown away -
  // but two of them are not: the window resize and the stage's own click. This
  // is what takes those off, and it has to run before the body is emptied so the
  // handler cannot fire against a picture that is no longer in the document.
  detachZoom?.();
  detachZoom = null;
  bodyEl?.replaceChildren();
  // Only bound as a listener on the dialog, so there is one here to clear.
  delete dlg!.dataset.type;
  delete dlg!.dataset.media;
}

// ---------------------------------------------------------------------------
// Zoom and pan, for the one view that is looked at rather than read
// ---------------------------------------------------------------------------

/** Torn down with the viewing. See teardown(). */
let detachZoom: (() => void) | null = null;

/** How far in a picture goes. Past this a photograph is pixels, not detail. */
const ZOOM_MAX = 8;
/** What one plain click asks for, which is a look rather than an inspection. */
const ZOOM_CLICK = 2.5;
/** Movement past this, in screen pixels, makes a press a drag and not a click. */
const DRAG_SLOP = 6;

/**
 * Wheel, pinch and drag over an open picture.
 *
 * The viewer's whole argument is that a card is too small to see a photograph
 * in; fitting it to the window is most of the answer and not all of it, because
 * a 6000px scan fitted to a laptop is still a tenth of its own detail. So the
 * fitted picture is where this starts and not where it ends.
 *
 * **One transform on the picture itself.** No wrapper, no second element to keep
 * in step: `translate(...) scale(...)` written to the element's own style, which
 * is the compositor's cheapest path and survives the picture being swapped
 * underneath it (the crop's display copy arrives asynchronously and replaces
 * `src`, not the node). Setting `.style` from script is fine under the CSP; a
 * `style` attribute in markup would not be.
 *
 * **The zoom goes to the pointer, not to the middle.** With the origin at the
 * centre, holding the point under the cursor still costs one correction:
 * `t += (cursor - centre) * (1 - next/current)`. Zooming to the middle of the
 * window instead is the thing that makes every other image viewer feel like it
 * is fighting you - you point at a face and the face leaves.
 *
 * **The pan is clamped, not free.** Half the scaled picture past the window edge
 * plus a margin, so a fling cannot put the thing somewhere it has to be hunted
 * for. Returns its own detach, because two of the four listeners are not on the
 * picture and would outlive it.
 */
function attachZoomPan(img: HTMLElement, stage: HTMLElement): () => void {
  let scale = 1, tx = 0, ty = 0;
  // Whatever the view already wrote, read once and kept underneath everything
  // this function does. That is the mirror (see the image view above), and
  // reading it rather than being told it means this knows nothing about flips:
  // any future base transform composes the same way.
  //
  // Last in the list, so it happens *first* - a CSS transform list applies right
  // to left. The picture is turned in its own space and then panned and zoomed
  // in the window's, which is the only order where a drag on a mirrored
  // photograph still follows the hand.
  const base = img.style.transform;

  const paint = () => {
    img.style.transform =
      scale === 1 ? base : `translate(${tx}px, ${ty}px) scale(${scale}) ${base}`.trimEnd();
    img.classList.toggle('is-zoomed', scale > 1);
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; paint(); };

  const clampPan = () => {
    // offsetWidth is the *laid out* size, which is the fitted picture - the
    // transform does not touch it. That is what makes this arithmetic stable
    // while the thing it is measuring is scaled.
    const w = img.offsetWidth || 1;
    const h = img.offsetHeight || 1;
    const maxX = Math.max(0, (w * scale - innerWidth) / 2) + 40;
    const maxY = Math.max(0, (h * scale - innerHeight) / 2) + 40;
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };

  const zoomTo = (next: number, cx: number, cy: number) => {
    const ns = Math.min(ZOOM_MAX, Math.max(1, next));
    if (ns === scale) return;
    const r = img.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    tx += dx * (1 - ns / scale);
    ty += dy * (1 - ns / scale);
    scale = ns;
    // All the way out is all the way back: a picture at 1 that is still offset
    // is a picture sitting somewhere nobody put it.
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    paint();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  };

  // pointerId -> where it is now. Two of these is a pinch; one is a drag.
  const points = new Map<number, { x: number, y: number }>();
  let pinchFrom = 0, pinchScale = 1, lastX = 0, lastY = 0;
  let downX = 0, downY = 0, dragging = false, moved = false;

  const onDown = (e: PointerEvent) => {
    img.setPointerCapture(e.pointerId);
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) { downX = e.clientX; downY = e.clientY; moved = false; }
    if (points.size === 2) {
      const [a, b] = [...points.values()];
      pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
      pinchScale = scale;
      dragging = false;
      // A pinch that ended where it started is still a pinch, never a click.
      moved = true;
    } else if (scale > 1) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      img.classList.add('is-panning');
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP) moved = true;
    if (points.size === 2 && pinchFrom) {
      const [a, b] = [...points.values()];
      const now = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo(pinchScale * (now / pinchFrom), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    clampPan();
    paint();
  };

  const onUp = (e: PointerEvent) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinchFrom = 0;
    if (!points.size) {
      dragging = false;
      img.classList.remove('is-panning');
    }
  };

  // A plain click on the picture is the cheap way in and the cheap way out: in
  // to a look at the detail under the pointer, out to the whole frame again.
  // Guarded by `moved`, or the lift at the end of every pan would toggle it.
  const onClick = (e: MouseEvent) => {
    if (moved) { moved = false; return; }
    if (scale > 1) reset();
    else zoomTo(ZOOM_CLICK, e.clientX, e.clientY);
  };

  // The ground around the picture is the way out, which is what a dark surround
  // has always meant. Only the stage itself - a press that reached the picture
  // is handled above and never arrives here.
  const onStageClick = (e: MouseEvent) => { if (e.target === stage) closeViewer(); };

  // A resized window re-fits the picture underneath a transform that was
  // computed against the old one, so the offset is now measured off nothing.
  // Putting it back is the honest answer and the one that cannot be subtly wrong.
  const onResize = () => { if (scale !== 1) reset(); };

  img.addEventListener('wheel', onWheel, { passive: false });
  img.addEventListener('pointerdown', onDown);
  img.addEventListener('pointermove', onMove);
  img.addEventListener('pointerup', onUp);
  img.addEventListener('pointercancel', onUp);
  img.addEventListener('click', onClick);
  stage.addEventListener('click', onStageClick);
  addEventListener('resize', onResize);

  return () => {
    stage.removeEventListener('click', onStageClick);
    removeEventListener('resize', onResize);
    // Back to the base, not to nothing: what this attached to was a picture that
    // may already have been mirrored, and detaching the zoom is not an undo of
    // the flip. The node is usually thrown away a line later anyway; on the path
    // where it is not, this leaves it as it was found.
    img.style.transform = base;
  };
}

/** The line under the name: what the file is and how big. */
function describe(item: Item) {
  const asset = item.asset?.hash ? getAsset(item.asset.hash) : null;
  const ext = str(item.meta?.ext).toUpperCase();
  return [ext, asset && formatBytes(asset.size)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/** One entry of the table below: an item, and the body it fills. */
type View = (item: Item, host: HTMLElement) => void;

const VIEWS: Record<string, View> = {
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
    const url = urlOf(item.asset?.hash) || urlOf(item.meta?.preview);
    if (!url) return void host.append(nothing('That picture is not in this board'));
    const img = document.createElement('img');
    img.className = 'viewer-media';
    img.alt = item.name || '';
    img.decoding = 'async';
    img.src = url;
    // A cropped picture is shown cropped, and the crop arrives the only way it
    // exists: as the display copy, which is where canvas/display.ts bakes it.
    // So this is the one case where the viewer does not show the original file -
    // and it must not, because the original is a picture the person has already
    // said they are not showing. The copy is bounded by the quality dial's
    // sharpness rather than by the file, which is a real loss of resolution
    // here and the honest trade: the alternative is a full-size view that
    // disagrees with every card on the board.
    //
    // Asynchronous and layered over the original rather than replacing it,
    // because the copy may not be made yet - the card is usually what made it,
    // and a card that has never been on screen has not. The full frame shows for
    // that moment, which is the same stand-in the card itself uses.
    const crop = itemCrop(item);
    const hash = item.asset?.hash;
    if (crop && hash) {
      const ready = displayURLReady(hash, crop);
      if (ready) img.src = ready;
      else ensureDisplay(hash, crop).then(u => { if (u && img.isConnected) img.src = u; });
    }
    // The grade is a filter and applies whatever the source, so it rides on top
    // of either branch above.
    const adjust = itemAdjust(item);
    if (adjust) {
      img.style.filter =
        `brightness(${adjust.brightness}) contrast(${adjust.contrast}) saturate(${adjust.saturation})`;
    }
    // And the mirror, which rides on top of either branch for the same reason
    // the grade does - it is a transform of whatever picture arrived, not a
    // property of the file. Written before the zoom is attached, deliberately:
    // attachZoomPan() reads this as the base it composes onto, so the order of
    // these two lines is the order of the two transforms. See flipTransform().
    const flip = flipTransform(item);
    if (flip) img.style.transform = flip;
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
    const url = urlOf(item.asset?.hash);
    if (!url) return void host.append(nothing('That clip is not in this board'));
    const el = document.createElement('video');
    el.className = 'viewer-media';
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
    const poster = urlOf(item.meta?.cover || item.meta?.poster);
    if (poster) el.poster = poster;
    el.src = url;
    // The grade, as on the card. A clip can be adjusted and cannot be cropped -
    // see setItemCrop() in state.ts, which explains why the two differ.
    const adjust = itemAdjust(item);
    if (adjust) {
      el.style.filter =
        `brightness(${adjust.brightness}) contrast(${adjust.contrast}) saturate(${adjust.saturation})`;
    }
    host.append(el);
  },

  /** A sound file, with its cover above it when it carries one. */
  audio(item, host) {
    const cover = urlOf(item.meta?.cover);
    if (cover) {
      const art = document.createElement('img');
      art.className = 'viewer-cover';
      art.alt = '';
      art.src = cover;
      host.append(art);
    }
    const url = urlOf(item.asset?.hash);
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
    const md = MARKDOWN.has(str(item.meta?.ext));
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
    // The rich body is a note's own structure and arrives out of a file, so it
    // is walked as unknown: a blocks array of anything, each entry keeping its
    // `text` only if that is what it is.
    const rich = item.meta?.rich;
    const blocks = rich && typeof rich === 'object' && 'blocks' in rich
      && Array.isArray(rich.blocks) ? rich.blocks : null;
    sheet.textContent = blocks?.length
      ? blocks.map(b => (b && typeof b === 'object' && 'text' in b ? str(b.text) : '')).join('\n').trim()
      : (str(item.meta?.text) || item.name || '').trim();
    // meta.tint, not meta.color - see noteTint(). `color` is a key nothing in
    // the app has ever written, so this both failed to tint a yellow note and
    // put whatever a hand-edited file did put there straight into a background.
    const tint = noteTint(item.meta?.tint);
    if (tint) sheet.style.background = `var(--note-${tint})`;
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

/**
 * A document, read out of its own container.
 *
 * Asynchronous and slow enough to say so: a .docx has to be unzipped, its XML
 * parsed and its pictures decoded, and the dialog is already open by then. A
 * line of text while that happens is the honest thing to show - the alternative
 * is a blank sheet that looks like the file was empty.
 */
function documentView(item: Item, host: HTMLElement) {
  const asset = getAsset(item.asset?.hash);
  if (!asset) return void host.append(nothing('That file is not in this board'));
  const waiting = nothing('Reading it…');
  host.append(waiting);
  readDocument(asset.blob, item.meta?.ext)
    .then(({ node, release }) => {
      if (!waiting.isConnected) { release(); return; }
      releaseDoc = release;
      waiting.replaceWith(node);
    })
    .catch(err => {
      if (!waiting.isConnected) return;
      // The reader's own message where it has one - "that presentation has no
      // slides" says more than "could not be read" - and a plain fallback where
      // the failure came from somewhere with nothing to say.
      waiting.textContent = err?.message || 'That file could not be read';
    });
}

/** How many pages of a PDF are rendered before it waits to be asked for more. */
const PDF_BATCH = 5;

/**
 * A PDF, page by page.
 *
 * The one view here that reaches the network, and the reason it is the only one:
 * a PDF is a page-description language and rendering it is an interpreter, which
 * is the app's first outside-code dependency (import/pdf.js, fetched on demand
 * from a CDN). Offline or CDN down, this says so and the file is still what it
 * was - which is the same degradation the import path takes.
 *
 * In batches, because a two-hundred-page report rendered eagerly is two hundred
 * canvases and a tab that stops answering. Five is about a screenful and a half
 * on a desktop; the button below asks for the next five.
 */
function pdfView(item: Item, host: HTMLElement) {
  const asset = getAsset(item.asset?.hash);
  if (!asset) return void host.append(nothing('That file is not in this board'));
  const waiting = nothing('Opening it…');
  host.append(waiting);

  const pages = document.createElement('div');
  pages.className = 'doc-pages';

  import('../import/pdf.ts').then(({ openPdf }) => openPdf(asset.blob)).then(async doc => {
    if (!waiting.isConnected) { doc.destroy(); return; }
    pdfDoc = doc;
    waiting.replaceWith(pages);
    // The width the page is drawn at, taken from the box it is going into, at
    // device resolution so it is sharp on a phone and on a retina display.
    const width = Math.max(320, pages.clientWidth || bodyEl!.clientWidth || 800)
      * Math.min(2, globalThis.devicePixelRatio || 1);
    let shown = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'viewer-more';

    const batch = async () => {
      more.disabled = true;
      const to = Math.min(doc.pages, shown + PDF_BATCH);
      for (let n = shown + 1; n <= to; n++) {
        // Checked every page, not once: closing the dialog part way through a
        // long document must stop the work rather than finish it into a node
        // nobody will see.
        if (!pages.isConnected) return;
        try {
          const canvas = await doc.render(n, width);
          canvas.className = 'doc-page';
          pages.append(canvas);
        } catch {
          const bad = document.createElement('p');
          bad.className = 'doc-missing';
          bad.textContent = `Page ${n} could not be drawn.`;
          pages.append(bad);
        }
      }
      shown = to;
      more.disabled = false;
      if (shown >= doc.pages) more.remove();
      else {
        more.textContent = `Show more (${shown} of ${doc.pages})`;
        pages.after(more);
      }
    };

    more.addEventListener('click', batch);
    await batch();
  }).catch(() => {
    if (!waiting.isConnected) return;
    waiting.textContent = 'That PDF could not be opened. It needs the page renderer, '
      + 'which is fetched the first time one is used - so this may be an offline session.';
  });
}

/** A card is not always openable, and saying so beats an empty sheet. */
function nothing(words: string) {
  const p = document.createElement('p');
  p.className = 'viewer-note';
  p.textContent = words;
  return p;
}
