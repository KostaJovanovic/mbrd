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

import { board, bus, isDefaultTitle } from '../state.js';
import { baseName, clamp } from '../util.js';
import { mobileOrder } from '../arrange/arrangements.js';
import { assetURL } from '../storage/assets.js';
import {
  registerPlayer, releasePlayers, nowPlaying, onNowPlaying, playTrack, PLAY_ICON, clock,
} from '../canvas/audio.js';

/** The types the Feed does not draw: furniture and the leaving hints. */
const HIDDEN = new Set(['title', 'ghost', 'fence']);

let root = null;        // #mobile-feed, the scroller
let sheet = null;       // the centred column the wall sits in
let mastheadEl = null;  // the board's title page across the top
let titleEl = null;
let gridEl = null;      // the positioning context for the absolute tiles
let empty = null;       // the "nothing to show" plate
let styleHeader = null; // styleFeedMasthead, injected from main.js

/** id -> { el, item, ratio, kind, video } for every tile currently rendered. */
const tiles = new Map();

let cols = 2;
let mastheadRaf = 0;
let layoutRaf = 0;
let resizeObs = null;

const TILE_TARGET = 210;   // the width a column aims for; more screen, more columns
const MAX_COLS = 5;
const GAP = 10;

export function initFeed(_viewport, _commands, headerStyle) {
  styleHeader = typeof headerStyle === 'function' ? headerStyle : null;
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
  return pictureURL(item) ? 'image' : 'file';
}

/** The aspect (w/h) a tile is drawn at, clamped so nothing dominates a column. */
function ratioOf(item) {
  const kind = kindOf(item);
  if (kind === 'link') return 2.6;
  if (kind === 'swatch') return 1;
  if (kind === 'audio') return 1;
  if (kind === 'file') return 1.4;
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
  return t;
}

function fillTile(t) {
  const { el, item, kind } = t;
  el.replaceChildren();
  if (kind === 'image') return fillImage(t);
  if (kind === 'video') return fillVideo(t);
  if (kind === 'audio') return fillAudio(t);
  if (kind === 'note') return fillNote(t);
  if (kind === 'link') return fillLink(t);
  if (kind === 'swatch') return fillSwatch(t);
  return fillFile(t);
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
  const card = div('feed-link');
  const name = div('feed-link-name');
  name.textContent = t.item.name || t.item.meta?.href || 'Link';
  const host = div('feed-link-host');
  host.textContent = hostOf(t.item);
  card.append(name, host);
  t.el.appendChild(card);
  const href = t.item.meta?.href;
  if (href) {
    t.el.setAttribute('role', 'link');
    t.el.tabIndex = 0;
    const open = () => window.open(href, '_blank', 'noopener');
    t.el.addEventListener('click', open);
    t.el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); open(); }
    });
  }
}

function hostOf(item) {
  const href = item.meta?.href;
  if (!href) return '';
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return href; }
}

function fillSwatch(t) {
  const block = div('feed-swatch');
  const color = t.item.meta?.color || t.item.name || '#888';
  block.style.background = color;
  const label = div('feed-swatch-label');
  label.textContent = color;
  t.el.append(block, label);
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
  for (const t of tiles.values()) {
    if (!t.video || t.video === npEl) continue;
    const y = t.el.getBoundingClientRect().top - root.getBoundingClientRect().top;
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
