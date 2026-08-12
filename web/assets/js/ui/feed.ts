// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The Feed: the Mobile board as a Pinterest-style masonry of everything on it.
//
// This is the Mobile board now. Where Mobile used to be the world-space canvas
// run as a fixed-width column, it is a native-scrolling wall of DOM tiles - one
// per item, laid shortest-column-first so the wall packs tight with nothing
// wasted between. Images and video are pictures; notes, links, swatches and the
// rest are the small cards they are on the canvas; audio is a cover that hands
// off to the Playlist, the board's other lens. Everything the board holds is
// here, which is why it is the Feed and not the Pictures.
//
// Handed the viewport, the command set and the masthead styler rather than
// importing them, like initBoardView/initMobileFrame - so nothing here reaches a
// browser global at import time. The module body only declares functions and
// module state; every document reach is inside initFeed() or a handler after it.
//
// The masonry is absolute-positioned rather than CSS columns: column-count fills
// one column top to bottom before starting the next, which throws reading order
// away, and Grid masonry is not in the browser floor. So the boxes are computed
// (feedMasonry) and written as a transform and a width per tile, the same shape
// canvas/mobile-frame.js uses for the sheet - a compositor move, not a reflow.
//
// Video owns its own release discipline: a clip's <video> lives here, outside
// #world, so items.js sounding() cannot see it. A clip scrolled well away and not
// the now-playing one is released and its element dropped back to a poster; the
// now-playing one is kept mounted wherever it has scrolled to.

import { board, bus, isDefaultTitle, byId, stuckTo, isRider } from '../state.ts';
import { baseName, clamp } from '../util.ts';
import { mobileOrder } from '../arrange/arrangements.ts';
import { assetURL, readText } from '../storage/assets.ts';
import { linkURL, buildContent } from '../canvas/renderers.ts';
import { bindDial } from '../canvas/ghosts.ts';
import {
  registerPlayer, releasePlayers, nowPlaying, onNowPlaying, playTrack, PLAY_ICON, clock,
} from '../canvas/audio.ts';
import {
  STICKER_SPRITE, STICKER_VIEWBOX, stickerShape, DEFAULT_SHAPE,
} from '../stickers/catalogue.ts';
import { armedSticker, disarm } from './sticker-window.ts';
import { openViewer, canView, MARKDOWN } from './viewer.ts';
import { renderMarkdown } from './markdown.ts';

/**
 * The types the Feed does not draw as tiles: furniture and stickers.
 *
 * The hint cards used to be on this list and should not have been. They are the
 * whole of what a brand-new board has on it - four cards saying what to do with
 * it - and hiding them left the one board that most needs them showing "Nothing
 * to show yet" instead. That is the Feed telling somebody their empty board is
 * empty, which they knew, in place of the four cards telling them what to do
 * about it. They are drawn as tiles now, through the same buildContent() the
 * canvas draws them with.
 *
 * A sticker is here for a different reason from the two above, and it is the
 * one worth stating. It is not hidden - a *pinned* one is drawn on its host's
 * tile, at the fraction of the host it holds on the canvas, because the board
 * you made should be the board you see. What it does not get is a tile of its
 * own, since a wall panel containing one star is not a thing anybody wants in
 * their feed.
 *
 * A *loose* sticker has no host tile to be drawn on, and so is not drawn at
 * all. That is the one place this view is knowingly not the board - see the
 * open questions in research/stickers-2026-08-12.md. Not drawing it is the safe
 * read: the alternative is that lone panel.
 */
const HIDDEN = new Set(['title', 'fence', 'sticker']);

let root = null;        // #mobile-feed, the scroller
let sheet = null;       // the centred column the wall sits in
let mastheadEl = null;  // the board's title page across the top
let titleEl = null;
let gridEl = null;      // the positioning context for the absolute tiles
let empty = null;       // the "nothing to show" plate
let styleHeader = null; // styleFeedMasthead, injected from main.js
let cmds = null;        // the command surface, for the armed-sticker tap

/** id -> { el, item, ratio, kind, video } for every tile currently rendered. */
const tiles = new Map();

let cols = 2;
let mastheadRaf = 0;
let layoutRaf = 0;
let resizeObs = null;
let mastheadObs = null;

// The hold that opens a tile's menu on touch. See the listeners in initFeed().
const HOLD_MS = 500;
const HOLD_SLOP = 10;
let holdTimer = 0;
let holdFrom = null;
let heldOpen = false;

function cancelHold() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  holdFrom = null;
}

/** The item a press landed on, or null for the sheet between the tiles. */
function tileIdAt(target) {
  return target?.closest?.('.feed-tile')?.dataset.id || null;
}

const TILE_TARGET = 210;   // the width a column aims for; more screen, more columns
const MAX_COLS = 5;
const GAP = 10;

export function initFeed(_viewport, _commands, headerStyle) {
  styleHeader = typeof headerStyle === 'function' ? headerStyle : null;
  cmds = _commands;
  root = document.getElementById('mobile-feed');
  if (!root) return;

  sheet = div('feed-sheet');
  root.appendChild(sheet);

  mastheadEl = div('feed-masthead');
  titleEl = document.createElement('h2');
  titleEl.className = 'feed-title';
  mastheadEl.appendChild(titleEl);
  sheet.appendChild(mastheadEl);

  gridEl = div('feed-grid');
  sheet.appendChild(gridEl);

  empty = div('feed-empty');
  empty.innerHTML =
    '<p class="feed-empty-title">Nothing to show yet</p>'
    + '<p class="feed-empty-body">Drop pictures, video, notes or files on the board '
    + 'and they land here.</p>';
  sheet.appendChild(empty);

  paintMasthead();

  // Tap-to-place. Capture, and on the scroller rather than on each tile: the
  // tiles are rebuilt whenever the board changes and a per-tile listener would
  // be re-wired forty times for a gesture that fires once. Capture because an
  // armed board is placing a sticker and doing nothing else - the tap must not
  // also open a link card or start a track.
  root.addEventListener('pointerdown', e => {
    if (!armedSticker() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const shape = armedSticker().shape;
    const at = feedPointToWorld(e.clientX, e.clientY);
    disarm();
    // A tap that missed every tile puts the shape down instead of placing it.
    // There is nowhere for a loose sticker to go in the feed (see HIDDEN), so
    // placing one on the background would make something the person then could
    // not see - which is worse than doing nothing and saying so by disarming.
    if (at) cmds?.addStickerAt(shape, at);
  }, true);

  // The right-click slot, which the Feed did not own.
  //
  // There is exactly one contextmenu listener on the canvas side and it is bound
  // to #viewport (canvas/input.js). #mobile-feed is a fixed scroller at z-index 2
  // that covers the viewport entirely, so a press here never reached it and the
  // browser's own menu opened instead - on the surface that on a phone *is* the
  // board. Same for the hold gesture: the long-press timer is in the pointer
  // pipeline on #viewport, and a tile is not in it.
  //
  // Its own pair of listeners rather than an extension of that pipeline, and
  // that is deliberate: canvas/input.js is one pipeline with exactly one active
  // gesture and must not be split (CLAUDE.md). This is a hold timer beside the
  // sticker drag's own slop check, which is the same shape of decision in the
  // same file.
  root.addEventListener('contextmenu', e => {
    const id = tileIdAt(e.target);
    // Off a tile the browser menu is welcome to it - there is nothing this app
    // can usefully offer for the sheet itself, and suppressing a menu to then
    // show nothing is a press that goes nowhere.
    if (!id) return;
    e.preventDefault();
    cancelHold();
    cmds?.contextMenu(e.clientX, e.clientY, id, 1, { mobile: true });
  });
  root.addEventListener('pointerdown', e => {
    // Touch only. A mouse has the button above, and a pen reports its own
    // contextmenu on a barrel press; arming a timer for either would open the
    // menu twice or open it on a drag that was going to scroll.
    if (e.pointerType !== 'touch' || !tileIdAt(e.target)) return;
    holdFrom = { x: e.clientX, y: e.clientY, id: tileIdAt(e.target) };
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      if (!holdFrom) return;
      // Suppress the tap that would otherwise follow this press: the tile's own
      // click handler opens the viewer, and a hold that opened a menu and an
      // item is a press that did two things.
      heldOpen = true;
      cmds?.contextMenu(holdFrom.x, holdFrom.y, holdFrom.id, 1, { mobile: true });
    }, HOLD_MS);
  }, { passive: true });
  // A finger that moved is scrolling, and a scroll is not a hold. The slop is
  // the sticker drag's, for the reason it is the same question: how far a thumb
  // wanders while meaning to stay still.
  root.addEventListener('pointermove', e => {
    if (!holdFrom) return;
    if (Math.hypot(e.clientX - holdFrom.x, e.clientY - holdFrom.y) > HOLD_SLOP) cancelHold();
  }, { passive: true });
  root.addEventListener('pointerup', cancelHold, { passive: true });
  root.addEventListener('pointercancel', cancelHold, { passive: true });
  // Capture, so it runs before the tile's own click handler rather than after it.
  root.addEventListener('click', e => {
    if (!heldOpen) return;
    heldOpen = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  bus.on('board:load', () => { teardown(); render(); });
  bus.on('layout', () => (board.layoutMode === 'mobile' ? render() : teardown()));
  bus.on('lens', () => { if (board.layoutMode === 'mobile') { render(); scheduleLayout(); } });
  bus.on('items', render);
  bus.on('geom', scheduleLayout);
  bus.on('board', paintMasthead);
  bus.on('fonts', paintMasthead);
  bus.on('settings', key => {
    if (key === 'arrangement' || key === 'profile') render();
    else if (key === 'mobileHeader' || key === 'appearance') paintMasthead();
  });
  onNowPlaying(markPlaying);

  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(scheduleLayout);
    resizeObs.observe(root);
  }

  // Is the title page on screen? The pen top-right edits *that page* and nothing
  // else, so it has no business riding a wall of photographs a thousand pixels
  // below it. It used to be gated on the world-space board being at its top stop
  // (atMobileTop); the Feed replaced that board and the gate went with it.
  //
  // An observer rather than a line in the scroll handler below, for the reason
  // ui/mobile-header.js's own latch gives: the answer changes exactly twice in a
  // scroll, and asking on every frame to arrive at the state already there is the
  // cost every view listener in this app is written to avoid. The observer is the
  // browser answering instead of being asked.
  //
  // Announced rather than acted on. The button belongs to ui/mobile-header.js and
  // this module does not import it - same bargain initFeed() already makes with
  // the viewport and the command set.
  if (typeof IntersectionObserver === 'function') {
    mastheadObs = new IntersectionObserver(
      entries => {
        const last = entries[entries.length - 1];
        if (last) bus.emit('feed:masthead', last.isIntersecting);
      },
      { root },
    );
    mastheadObs.observe(mastheadEl);
  }
  addEventListener('resize', paintMasthead);
  root.addEventListener('scroll', releaseOffscreen, { passive: true });
  document.fonts?.ready?.then(paintMasthead).catch(() => {});

  render();
}

// ---------------------------------------------------------------------------
// Building the wall
// ---------------------------------------------------------------------------

/** Everything the Feed shows, in the board's arrangement order. */
function feedItems() {
  return mobileOrder(
    board.items.filter(it => !HIDDEN.has(it.type)),
    { name: board.arrangement });
}

/**
 * Reconcile the tiles to the board, then lay them out. Off Mobile this tears
 * down and the CSS shows the canvas; on Mobile it (re)builds one tile per item,
 * in order, and drops any whose item has gone.
 */
function render() {
  if (!root || board.layoutMode !== 'mobile') { teardown(); return; }
  paintMasthead();

  const items = feedItems();
  const present = new Set();
  for (const item of items) {
    present.add(item.id);
    let t = tiles.get(item.id);
    if (!t || t.kind !== kindOf(item)) {
      if (t) dropTile(t);
      t = buildTile(item);
      tiles.set(item.id, t);
    } else {
      t.item = item;
      t.ratio = ratioOf(item);
    }
    gridEl.appendChild(t.el);   // (re)append keeps DOM order matching feed order
  }
  for (const [id, t] of tiles) {
    if (!present.has(id)) { dropTile(t); tiles.delete(id); }
  }
  empty.classList.toggle('is-shown', items.length === 0);
  scheduleLayout();
  markPlaying();
}

/** Kind buckets, which decide the tile shape and how it is filled. */
function kindOf(item) {
  if (item.type === 'image') return 'image';
  if (item.type === 'video') return 'video';
  if (item.type === 'audio') return 'audio';
  if (item.type === 'note') return 'note';
  if (item.type === 'link') return 'link';
  if (item.type === 'swatch') return 'swatch';
  // A text file shows its words here, as it does on the canvas. It used to fall
  // through to the file card below and come out as a filename over the literal
  // word "text" - which is a tile telling you the name of something you already
  // know the name of, on the one item type whose whole value is what is inside
  // it. classify() routes some fifty extensions to this, so it is most of the
  // notes, code and prose anybody drops on a board.
  if (item.type === 'text') return 'text';
  if (item.type === 'ghost') return 'hint';
  return pictureURL(item) ? 'image' : 'file';
}

/** The aspect (w/h) a tile is drawn at, clamped so nothing dominates a column. */
function ratioOf(item) {
  const kind = kindOf(item);
  if (kind === 'link') return 2.6;
  if (kind === 'swatch') return 1;
  if (kind === 'audio') return 1;
  if (kind === 'file') return 1.4;
  // A hint keeps the shape it was seeded at. ensureGhostCards() sizes these
  // against the column when Mobile is the live layout - the dial takes the whole
  // width, the three hints half of it - so the item's own box is already the
  // right proportion and the clamp below would only fight it.
  if (kind === 'hint') return clamp(item.w / Math.max(1, item.h), 0.5, 3);
  // Taller than wide, because a page of words is a page. The canvas card is
  // 300x360 and this is the same proportion; anything squarer shows four lines
  // and a lot of paper.
  if (kind === 'text') return 0.75;
  const r = item.w > 0 && item.h > 0 ? item.w / item.h : 1;
  return clamp(r, 0.5, 2);
}

/** A raster URL for anything that has one - a thumb, a poster, a cover, a shot. */
function pictureURL(item) {
  const m = item.meta || {};
  const hash = m.thumb || m.cover || m.poster || m.shot
    || (item.type === 'image' || item.type === 'video' ? item.asset?.hash : null);
  return hash ? assetURL(hash) : null;
}

function buildTile(item) {
  const kind = kindOf(item);
  const el = div('feed-tile');
  el.dataset.kind = kind;
  el.dataset.id = item.id;
  const t = { el, item, ratio: ratioOf(item), kind, video: null };
  fillTile(t);
  wireOpen(t);
  return t;
}

/**
 * A tap opens the item, for the kinds that have nothing else to do with one.
 *
 * The Feed had four tap meanings already and every one of them is left alone: a
 * link goes to its address, an audio tile hands off to the Playlist, a video
 * mounts and plays, and everything else did nothing at all. That last group is
 * the one this is for - a picture, a text file, a note, a named file - where the
 * only thing a tap could reasonably mean is "let me see that properly", and
 * until the viewer existed there was no properly to see it at.
 *
 * Video is deliberately not in here even though it is viewable: on the wall a
 * tap plays it in place, which is the better answer for a clip somebody is
 * scrolling past. The viewer is where the right-click menu sends it.
 */
function wireOpen(t) {
  if (!OPENS.has(t.kind) || !canView(t.item.id)) return;
  t.el.setAttribute('role', 'button');
  t.el.tabIndex = 0;
  t.el.addEventListener('click', () => openViewer(t.item.id));
  t.el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openViewer(t.item.id);
  });
}

/** The tile kinds whose tap means "open this". See wireOpen(). */
const OPENS = new Set(['image', 'text', 'note', 'file']);

function fillTile(t) {
  const { el, kind } = t;
  el.replaceChildren();
  if (kind === 'image') return fillImage(t);
  if (kind === 'video') return fillVideo(t);
  if (kind === 'audio') return fillAudio(t);
  if (kind === 'note') return fillNote(t);
  if (kind === 'link') return fillLink(t);
  if (kind === 'swatch') return fillSwatch(t);
  if (kind === 'text') return fillText(t);
  if (kind === 'hint') return fillHint(t);
  return fillFile(t);
}

/**
 * A hint card, drawn by the canvas's own renderer.
 *
 * buildContent() rather than a second hint card written for this surface. There
 * is one place that knows what a hint says, which of them carries the whimsy
 * dial and how the tape is laid on it (canvas/renderers.js, RENDERERS.ghost),
 * and a copy here would be a second thing to remember every time the words
 * change. The fragment it hands back is the same one canvas/items.js appends.
 *
 * Two things the canvas provides and this surface has to provide for itself.
 * --iz is the inverse of the board's zoom, which the ghost card's dashed border
 * is measured in so it stays one screen pixel at every zoom; the Feed has no
 * zoom, so the inverse is exactly 1. And the dial has to be wired: on the canvas
 * items.js binds it after mounting, and a slider nobody bound is a slider that
 * moves and changes nothing.
 */
function fillHint(t) {
  const host = div('feed-hint');
  // The value the border width is computed from. Not inherited from anywhere on
  // this surface - #world is where the canvas writes it.
  host.style.setProperty('--iz', '1');
  host.append(buildContent(t.item));
  t.el.appendChild(host);
  const dial = host.querySelector('input[type="range"]');
  if (dial) bindDial(dial);
}

function fillImage(t) {
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.alt = t.item.name || '';
  // The full-size picture, not the hundred-pixel thumb the card swaps in when the
  // board is zoomed right out: a feed tile is far bigger than 100px, so the thumb
  // reads as blurry. Thumb (via pictureURL) is only the fallback if there is no
  // asset to show.
  const url = (t.item.asset?.hash && assetURL(t.item.asset.hash)) || pictureURL(t.item);
  if (url) img.src = url;
  t.el.appendChild(img);
}

function fillVideo(t) {
  const url = pictureURL(t.item);
  if (url) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
    img.src = url;
    t.el.appendChild(img);
  }
  const badge = div('feed-play');
  badge.innerHTML = PLAY_ICON;
  t.el.appendChild(badge);
  t.el.setAttribute('role', 'button');
  t.el.tabIndex = 0;
  const play = () => mountVideo(t);
  t.el.addEventListener('click', play);
  t.el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
  });
}

/** Swap a video tile's poster for a live, registered <video>. */
function mountVideo(t) {
  if (t.video) return;
  const url = t.item.asset && assetURL(t.item.asset.hash);
  if (!url) return;
  const v = document.createElement('video');
  v.playsInline = true;
  v.controls = true;
  v.preload = 'metadata';
  v.src = url;
  const poster = pictureURL(t.item);
  if (poster) v.poster = poster;
  t.el.replaceChildren(v);
  t.video = v;
  registerPlayer(v, t.item);
  v.play().catch(() => {});
}

function fillAudio(t) {
  const item = t.item;
  const art = div('feed-tile-art');
  const cover = item.meta?.cover && assetURL(item.meta.cover);
  if (cover) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
    img.src = cover;
    art.appendChild(img);
  } else {
    // No embedded art, which is most loose MP3s: a still waveform stands in - the
    // same shape the canvas card draws for this file and the playlist row lights
    // when it plays, so a track reads as a track across all three.
    art.classList.add('is-placeholder');
    art.appendChild(waveBars());
  }
  // A tap plays the track right here on the Feed; the corner badge says so. The
  // shared queue is the board's audio, so it plays into the now-playing bar and the
  // Playlist follows along - but the Feed stays put, it does not jump to the Playlist.
  const badge = div('feed-tile-badge');
  badge.innerHTML = PLAY_ICON;

  const cap = div('feed-tile-cap');
  const title = div('feed-cap-title');
  title.textContent = item.meta?.trackTitle || baseName(item.name) || item.name || 'Audio';
  cap.appendChild(title);
  const bits = [];
  if (item.meta?.artist) bits.push(item.meta.artist);
  if (item.meta?.duration != null) bits.push(clock(item.meta.duration));
  if (bits.length) {
    const sub = div('feed-cap-sub');
    sub.textContent = bits.join(' · ');
    cap.appendChild(sub);
  }
  t.el.append(art, badge, cap);
  // A tap plays the track, in place - it does not leave the Feed.
  t.el.setAttribute('role', 'button');
  t.el.tabIndex = 0;
  const go = () => playTrack(item);
  t.el.addEventListener('click', go);
  t.el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
}

/** A still waveform for a coverless audio tile: fixed bars, so it does not cost a
 *  decode and does not dance a wall of tiles. Heights are a fixed pattern. */
const WAVE_PATTERN = [38, 62, 90, 54, 78, 100, 46, 70, 58, 84, 42, 66];
function waveBars() {
  const w = div('feed-bars');
  w.innerHTML = WAVE_PATTERN.map(h => `<i style="height:${h}%"></i>`).join('');
  return w;
}

function fillNote(t) {
  const body = div('feed-note');
  const text = noteText(t.item);
  body.textContent = text;
  const tint = t.item.meta?.color;
  if (tint) body.style.background = tint;
  t.el.appendChild(body);
}

/** The note's words, from the rich model if it has one, else the flat text. */
function noteText(item) {
  const rich = item.meta?.rich;
  if (Array.isArray(rich?.blocks) && rich.blocks.length) {
    return rich.blocks.map(b => b?.text || '').join('\n').trim();
  }
  return (item.meta?.text || item.name || '').trim();
}

function fillLink(t) {
  // A link stores its URL in meta.url (like the canvas card, renderers.js); validate
  // it through the same scheme check so a non-http(s) string makes an inert card
  // rather than a live window.open.
  const u = linkURL(t.item.meta?.url);
  const host = u ? u.hostname.replace(/^www\./, '') : '';
  const card = div('feed-link');
  const name = div('feed-link-name');
  name.textContent = t.item.name || host || t.item.meta?.url || 'Link';
  const hostEl = div('feed-link-host');
  hostEl.textContent = host;
  card.append(name, hostEl);
  t.el.appendChild(card);
  if (u) {
    t.el.setAttribute('role', 'link');
    t.el.tabIndex = 0;
    const open = () => window.open(u.href, '_blank', 'noopener');
    t.el.addEventListener('click', open);
    t.el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
}

function fillSwatch(t) {
  const block = div('feed-swatch');
  const color = t.item.meta?.color || t.item.name || '#888';
  block.style.background = color;
  const label = div('feed-swatch-label');
  label.textContent = color;
  t.el.append(block, label);
}

/**
 * How much of a text file a tile shows.
 *
 * Well under the canvas card's 20 000, and the difference is the point: a tile
 * is a few hundred pixels of a scrolling wall and will draw perhaps forty lines
 * of it. Reading a hundred kilobytes to lay out forty lines is work the feed
 * pays on every text file the board holds, at the moment it is trying to draw
 * everything at once. The rest of the file lives one tap away, in the viewer.
 */
const TILE_TEXT = 2000;

/**
 * A text file, showing its words.
 *
 * The read is asynchronous and the tile is built synchronously, so the card goes
 * up with its name and the body arrives when it arrives - the same bargain
 * fillImage() makes with a lazily-decoded picture, and the same one the canvas
 * text renderer makes.
 *
 * <pre> and textContent, never innerHTML: half of what classify() routes here is
 * markup, and a tile that rendered the HTML file it is meant to be showing you
 * would be executing a file the app did not write.
 */
function fillText(t) {
  const md = MARKDOWN.has(t.item.meta?.ext || '');
  const card = div('feed-text');
  const name = div('feed-text-name');
  name.textContent = baseName(t.item.name) || t.item.name || 'untitled';
  // Markdown reads as prose here as it does in the viewer - a tile showing a
  // README's hashes and asterisks is showing its scaffolding. Everything else
  // classify() routes to 'text' is source and stays source.
  const body = document.createElement(md ? 'div' : 'pre');
  body.className = md ? 'feed-text-md' : 'feed-text-body';
  card.append(name, body);
  t.el.appendChild(card);

  const hash = t.item.asset?.hash;
  if (!hash) return;
  readText(hash, TILE_TEXT).then(text => {
    // The tile may have been dropped or rebuilt while the read was out - a
    // delete, a layout switch, an undo. Writing into a detached node is
    // harmless and writing into a *rebuilt* one is not, so check the body is
    // still the one this call built.
    if (!body.isConnected) return;
    if (md) body.append(renderMarkdown(text));
    else body.textContent = text;
  }).catch(() => { /* an unreadable file keeps its name and nothing else */ });
}

function fillFile(t) {
  const card = div('feed-file');
  const name = div('feed-file-name');
  name.textContent = baseName(t.item.name) || t.item.name || t.item.type;
  const kind = div('feed-file-kind');
  kind.textContent = t.item.type;
  card.append(name, kind);
  t.el.appendChild(card);
}

// ---------------------------------------------------------------------------
// The masonry
// ---------------------------------------------------------------------------

/**
 * Shortest-column packing. `list` is the tiles in reading order; each lands in
 * whichever column is shortest so far, leftmost on a tie - the same rule
 * arrange/arrangements.js's masonry() uses. Returns the boxes and the height of
 * the tallest column, which is the wall's height. Pure but for reading `cols`.
 */
function feedMasonry(list, width) {
  const colW = (width - (cols - 1) * GAP) / cols;
  const heights = new Array(cols).fill(0);
  const boxes = [];
  for (const t of list) {
    let c = 0;
    for (let i = 1; i < cols; i++) if (heights[i] < heights[c] - 0.5) c = i;
    const h = colW / t.ratio;
    boxes.push({ t, x: c * (colW + GAP), y: heights[c], w: colW, h });
    heights[c] += h + GAP;
  }
  return { boxes, colW, height: Math.max(0, ...heights) - GAP };
}

// ---------------------------------------------------------------------------
// Stickers on the wall
//
// The one mechanism in the Feed with no equivalent on the canvas, and the whole
// of it is the function below. Everywhere else in the app a screen point
// becomes a world point through vp.toWorld(), which is a pan and a zoom; the
// Feed is not the world drawn small, it is a different arrangement of the same
// items, and there is no transform between the two. So the way back is through
// the *item*: which tile the tap landed on, where in that tile, and then the
// same place in the item's own box.
// ---------------------------------------------------------------------------

/**
 * A tap on the wall, as a world point on the item it landed on - or null if it
 * landed on no tile at all.
 *
 * Two steps, and only the first is new. The tap becomes a fraction of the tile
 * it hit; the fraction becomes a point in the item's current-layout box, which
 * is the arithmetic stuckPlacement() already does for a rider crossing between
 * layouts. Item coordinates are centres and world y points up, which is where
 * the halves and the minus come from.
 *
 * The fraction is *approximate* and knowingly so: a tile's aspect is clamped to
 * between 1:2 and 2:1 (ratioOf) so no one picture can own a column, and a very
 * tall photograph is therefore drawn shorter here than it is on the board. A
 * star pressed onto the bottom of such a tile lands a little higher up the
 * photograph than the thumb did. The alternative is refusing to place on the
 * clamped tiles at all, which is a worse answer to a smaller problem.
 */
export function feedPointToWorld(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY)?.closest('.feed-tile');
  const item = el && byId(el.dataset.id);
  if (!item) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  return { x: item.x + (fx - 0.5) * item.w, y: item.y - (fy - 0.5) * item.h };
}

/**
 * Draw every pinned sticker on its host's tile.
 *
 * Positioned as a percentage of the tile rather than in pixels, which is what
 * lets this run once per render and survive every relayout underneath it: the
 * columns are re-measured on every resize and the sticker's *fraction* of its
 * host does not change when the tile does.
 *
 * A sticker on a note on a photograph is drawn on the note's tile, because the
 * note is what it is stuck to - the same walk stuckTo() gives everywhere else,
 * taken one step rather than to the root.
 */
function paintStickers() {
  if (!gridEl) return;
  for (const el of gridEl.querySelectorAll('.feed-sticker')) el.remove();
  for (const it of board.items) {
    if (it.type !== 'sticker' || !isRider(it)) continue;
    const host = stuckTo(it);
    const tile = host && tiles.get(host.id);
    if (!tile || !host.w || !host.h) continue;
    tile.el.append(stickerOverlay(it, host));
  }
}

function stickerOverlay(it, host) {
  const shape = stickerShape(it.meta?.shape) ? it.meta.shape : DEFAULT_SHAPE;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sticker-art feed-sticker');
  svg.setAttribute('viewBox', STICKER_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${STICKER_SPRITE}#${shape}`);
  svg.append(use);
  if (it.meta?.tint) svg.dataset.tint = it.meta.tint;
  // Centre-relative fractions turned into the top-left percentages CSS wants,
  // with the shape's own centre pulled back over the point by a translate.
  svg.style.left = `${((it.x - host.x) / host.w + 0.5) * 100}%`;
  svg.style.top = `${(0.5 - (it.y - host.y) / host.h) * 100}%`;
  svg.style.width = `${(it.w / host.w) * 100}%`;
  svg.style.height = `${(it.h / host.h) * 100}%`;
  // Negated, like canvas/items.js: world angles run the other way from screen.
  svg.style.rotate = `${-(it.rot || 0)}deg`;
  return svg;
}

function scheduleLayout() {
  if (layoutRaf || typeof requestAnimationFrame !== 'function') return;
  layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
}

/** Recompute the column count for the current width and place every tile. */
function layout() {
  if (!gridEl || board.layoutMode !== 'mobile') return;
  const width = gridEl.clientWidth;
  if (width < 1) return;
  cols = clamp(Math.round(width / TILE_TARGET), 2, MAX_COLS);
  const list = feedItems().map(it => tiles.get(it.id)).filter(Boolean);
  const { boxes, height } = feedMasonry(list, width);
  for (const b of boxes) {
    b.t.el.style.width = `${b.w}px`;
    b.t.el.style.height = `${b.h}px`;
    b.t.el.style.transform = `translate(${b.x.toFixed(2)}px, ${b.y.toFixed(2)}px)`;
  }
  gridEl.style.height = `${Math.max(0, height)}px`;
  // Here rather than in render(), because a sticker's *fraction* of its host
  // changes when the host is resized - which arrives as a bare 'geom' and never
  // rebuilds a tile. layout() is what already listens for that, and it is
  // rAF-throttled, so this cannot run twice in a frame however the event storms.
  paintStickers();
  releaseOffscreen();
}

// ---------------------------------------------------------------------------
// Media discipline
// ---------------------------------------------------------------------------

/**
 * Drop any mounted video that has scrolled well clear of the window and is not
 * the one now playing. A parked <video> holds a decoder; a phone rations those
 * hard, so a feed that mounted every clip it passed would exhaust them.
 */
function releaseOffscreen() {
  if (!root) return;
  const npEl = nowPlaying()?.el || null;
  const top = -root.clientHeight;
  const bottom = root.clientHeight * 2;
  // Hoisted: the scroll container's own top does not move as fillTile swaps a
  // child video for a poster, so reading it once keeps the loop from forcing a
  // layout flush for the invariant rect on every mounted tile.
  const rootTop = root.getBoundingClientRect().top;
  for (const t of tiles.values()) {
    if (!t.video || t.video === npEl) continue;
    const y = t.el.getBoundingClientRect().top - rootTop;
    if (y < top || y > bottom) {
      releasePlayers(t.el);
      t.video = null;
      fillTile(t);      // back to a poster
    }
  }
}

/** Light the video tile whose clip is the one playing. */
function markPlaying() {
  const npEl = nowPlaying()?.el || null;
  for (const t of tiles.values()) {
    t.el.classList.toggle('is-playing', !!t.video && t.video === npEl);
  }
}

// ---------------------------------------------------------------------------
// The masthead
// ---------------------------------------------------------------------------

function paintMasthead() {
  if (!titleEl) return;
  titleEl.textContent = board.title;
  titleEl.classList.toggle('is-default', isDefaultTitle(board.title));
  scheduleMasthead();
}

function scheduleMasthead() {
  if (mastheadRaf || !titleEl) return;
  mastheadRaf = requestAnimationFrame(() => {
    mastheadRaf = 0;
    const w = mastheadEl ? mastheadEl.clientWidth : 0;
    if (w > 0) {
      titleEl.style.setProperty('--mobile-board-width', w + 'px');
      titleEl.style.setProperty('--mobile-header-height',
        (mastheadEl.clientHeight || w / 1.5) + 'px');
    }
    if (styleHeader) styleHeader(titleEl, mastheadEl);
  });
}

// ---------------------------------------------------------------------------

function dropTile(t) {
  if (t.video) { releasePlayers(t.el); t.video = null; }
  t.el.remove();
}

/** Leave the Feed: release every clip and clear the wall. */
function teardown() {
  for (const t of tiles.values()) dropTile(t);
  tiles.clear();
}

function div(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
