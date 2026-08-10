// The Playlist: the board's audio as a proper player, in two homes.
//
// One is the Mobile board's second lens - Feed | Playlist - where it fills the
// screen as an Apple-Music-style player: an album header (a mosaic of the board's
// own covers, the board's name, "N songs, M min", and Play / Shuffle) over a
// track list you can drag to reorder. The other is a floating window on the
// Desktop board, opened from the sidebar - the same header and list, compact, and
// without the reordering (it is a player, not an editor).
//
// It owns no <audio>. It drives the shared queue in canvas/audio.js - setQueue,
// playTrack, toggleShuffle - and the global now-playing bar is the transport, so
// the music keeps playing across a lens switch, a trip to the canvas, or the
// window being closed. Only a whole new board stops it (clearQueue on board:load),
// because its tracks and their asset URLs are gone. Play / Shuffle here are the
// two things a bar cannot be: the way to *start* the board, from cold.
//
// The hand-arranged order lives in board.audioOrder (a list of ids, saved with
// the board). applyAudioOrder() resolves it against the audio actually present;
// a drag commits a new one through setAudioOrder(), which persists and comes back
// round as an 'audioOrder' event that re-renders both homes.
//
// Handed nothing it imports at module scope that touches the browser: every
// document reach is inside initPlaylist() or a handler that runs after it.

import {
  board, bus, isDefaultTitle, markDirty, setAudioOrder,
} from '../state.js';
import { baseName, clamp } from '../util.js';
import { mobileOrder, applyAudioOrder } from '../arrange/arrangements.js';
import { assetURL, getAsset, addFile } from '../storage/assets.js';
import {
  nowPlaying, onNowPlaying, onQueue, clock,
  setQueue, playTrack, toggleShuffle, cycleRepeat, queueState,
  queueNext, queuePrev, togglePlayback, bindScrub,
  isQueuePlayer, clearQueue, PLAY_ICON, PAUSE_ICON,
} from '../canvas/audio.js';
import { audioTags, coverArt } from '../import/artwork.js';

const NOTE_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 2.5v7.1a2.2 2.2 0 11-1-1.84V4.3l-4.5.98v5.06a2.2 2.2 0 11-1-1.84V3.2z"/></svg>';
const DISC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/><path d="M12 3.5a8.5 8.5 0 016.4 2.9" stroke-linecap="round"/></svg>';
const GRIP_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>';
const SHUFFLE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h2.2c1 0 1.6.5 2.2 1.3l3.2 5.4c.6.8 1.2 1.3 2.2 1.3H14"/><path d="M2 12h2.2c1 0 1.6-.5 2.2-1.3l.8-1.3M9.4 6.6l.8-1.3C10.8 4.5 11.4 4 12.4 4H14"/><path d="M12.2 2.3 14 4l-1.8 1.7M12.2 10.3 14 12l-1.8 1.7"/></svg>';
const PREV_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3.5h1.5v9H4.5z"/><path d="M12 3.9v8.2L6.3 8z"/></svg>';
const NEXT_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 3.5h1.5v9H10z"/><path d="M4 3.9v8.2L9.7 8z"/></svg>';
const REPEAT_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6V5.2A1.7 1.7 0 0 1 6.2 3.5H12"/><path d="m10.3 1.8 1.9 1.7-1.9 1.7"/><path d="M11.5 10v.8a1.7 1.7 0 0 1-1.7 1.7H4"/><path d="m5.7 14.2-1.9-1.7 1.9-1.7"/></svg>';
const REPEAT_ONE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6V5.2A1.7 1.7 0 0 1 6.2 3.5H12"/><path d="m10.3 1.8 1.9 1.7-1.9 1.7"/><path d="M11.5 10v.8a1.7 1.7 0 0 1-1.7 1.7H4"/><path d="m5.7 14.2-1.9-1.7 1.9-1.7"/><text x="8" y="10.2" font-size="6" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

let mobileView = null;    // the Mobile lens
let windowEl = null;      // the Desktop floating window, or null when closed
let windowView = null;    // the list inside it
let windowPlayer = null;  // the Desktop window's transport, or null when closed

/** Every visible header's Play / Shuffle pair, so play state paints in both. */
const actionGroups = new Set();
/** The shared queue element, once we have wired play/pause listeners to it. */
let wiredEl = null;

/** Tracks whose tags/duration have been read this session, so it happens once. */
const tagged = new Set();

/** The reorder drag in flight, or null. */
let drag = null;

export function initPlaylist(_viewport, _commands, _headerStyle) {
  const host = document.getElementById('mobile-playlist');
  if (host) mobileView = createView(host, { reorderable: true, variant: 'lens' });

  bus.on('board:load', () => { clearQueue(); tagged.clear(); wiredEl = null; closePlayerWindow(); renderAll(); });
  bus.on('layout', () => {
    // The window is a Desktop thing; leaving for the Mobile board takes it away.
    if (board.layoutMode === 'mobile') closePlayerWindow();
    renderAll();
  });
  bus.on('items', renderAll);
  bus.on('audioOrder', renderAll);
  bus.on('settings', key => {
    if (key === 'arrangement' || key === 'profile') renderAll();
  });
  bus.on('board', updateMetaAll);
  bus.on('fonts', updateMetaAll);
  onNowPlaying(() => { wirePlayback(); markPlaying(); refreshActions(); windowPlayer?.bind(); });
  onQueue(refreshActions);

  renderAll();
}

// ---------------------------------------------------------------------------
// The list, in both homes
// ---------------------------------------------------------------------------

/** The board's audio, in the hand-arranged order over the board arrangement. */
function orderedAudio() {
  const audio = board.items.filter(it => it.type === 'audio');
  return applyAudioOrder(mobileOrder(audio, { name: board.arrangement }), board.audioOrder);
}

/**
 * Render whichever home is live and point the shared queue at the board's audio.
 *
 * Mobile: the lens is the player. Desktop: the window is, when it is open. They
 * are never both live, so only one setQueue runs and there is no fight over it.
 * The idle home is cleared so it holds no stale rows.
 */
function renderAll() {
  const audio = orderedAudio();
  if (board.layoutMode === 'mobile') {
    windowView && windowView.clear();
    setQueue(audio);
    mobileView && mobileView.fill(audio);
  } else {
    mobileView && mobileView.clear();
    if (windowView) { setQueue(audio); windowView.fill(audio); }
  }
  markPlaying();
  refreshActions();
  windowPlayer?.bind();
}

function updateMetaAll() {
  const audio = orderedAudio();
  mobileView && mobileView.updateMeta(audio);
  windowView && windowView.updateMeta(audio);
}

function markPlaying() {
  mobileView && mobileView.markPlaying();
  windowView && windowView.markPlaying();
}

// ---------------------------------------------------------------------------
// Playback state - Play / Shuffle, and keeping their icons true
// ---------------------------------------------------------------------------

/** The shared queue's element while it is the sound, or null. */
function queueEl() {
  const np = nowPlaying();
  return np && isQueuePlayer(np.el) ? np.el : null;
}

/** Play the queue from cold, resume it, or pause it - whichever applies. */
function togglePlay() {
  const el = queueEl();
  if (el) { el.paused ? el.play().catch(() => {}) : el.pause(); return; }
  const audio = orderedAudio();
  if (audio.length) playTrack(audio[0]);
}

/** Shuffle on (if it was off) and start somewhere in it. */
function shufflePlay() {
  if (!queueState().shuffle) toggleShuffle();
  const audio = orderedAudio();
  if (audio.length) playTrack(audio[Math.floor(Math.random() * audio.length)]);
}

/**
 * The shared <audio> is made once and reused, but pausing or resuming it does not
 * change the now-playing track, so onNowPlaying never fires for it. Wire play and
 * pause directly, once, so the Play button flips between its two faces.
 */
function wirePlayback() {
  const el = queueEl();
  if (!el || el === wiredEl) return;
  wiredEl = el;
  const onState = () => { refreshActions(); windowPlayer?.refresh(); };
  el.addEventListener('play', onState);
  el.addEventListener('pause', onState);
  el.addEventListener('ended', onState);
}

function refreshActions() {
  const el = queueEl();
  const playing = !!el && !el.paused;
  const shuffling = queueState().shuffle;
  for (const g of actionGroups) {
    g.playIco.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    g.playLabel.textContent = playing ? 'Pause' : 'Play';
    g.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    g.play.classList.toggle('is-playing', playing);
    g.shuffle.classList.toggle('is-on', shuffling);
    g.shuffle.setAttribute('aria-pressed', String(shuffling));
  }
}

/** Build a Play + Shuffle pair, registered so its icons stay true. Returns the row. */
function makeActions() {
  const row = div('pl-hero-actions');
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'pl-play';
  play.innerHTML = `<span class="pl-ico">${PLAY_ICON}</span><span class="pl-label">Play</span>`;
  play.setAttribute('aria-label', 'Play');
  play.addEventListener('click', togglePlay);
  const shuffle = document.createElement('button');
  shuffle.type = 'button';
  shuffle.className = 'pl-shuffle';
  shuffle.innerHTML = `<span class="pl-ico">${SHUFFLE_ICON}</span><span class="pl-label">Shuffle</span>`;
  shuffle.setAttribute('aria-label', 'Shuffle');
  shuffle.addEventListener('click', shufflePlay);
  row.append(play, shuffle);
  const group = {
    play, shuffle,
    playIco: play.querySelector('.pl-ico'),
    playLabel: play.querySelector('.pl-label'),
  };
  actionGroups.add(group);
  return { row, group };
}

/**
 * Build one track list, with the album header the Mobile lens carries above it.
 *
 * The lens (variant 'lens') gets the full album hero - cover mosaic, name, "N
 * songs", Play / Shuffle - on the paper sheet. The Desktop window (variant
 * 'window') gets no hero here: it carries a real transport instead, built by
 * makeWindowPlayer() and placed above this list. So this only builds the list.
 */
function createView(container, { reorderable, variant }) {
  container.replaceChildren();
  const rows = new Map();   // id -> { el, item }
  const lens = variant === 'lens';

  // The lens sits on the same paper sheet the Feed does; the window drops the
  // list straight into its body, under the player.
  const surface = lens ? div('feed-sheet') : container;

  let hero = null, cover = null, titleEl = null, metaEl = null, group = null;
  if (lens) {
    hero = div('pl-hero');
    cover = div('pl-cover');
    const heroText = div('pl-hero-text');
    titleEl = document.createElement('h2');
    titleEl.className = 'pl-hero-title';
    metaEl = div('pl-hero-meta');
    heroText.append(titleEl, metaEl);
    const made = makeActions();
    group = made.group;
    heroText.append(made.row);
    hero.append(cover, heroText);
    surface.appendChild(hero);
  }

  const listEl = div('pl-list');
  surface.appendChild(listEl);

  const empty = div('feed-empty');
  empty.innerHTML =
    '<p class="feed-empty-title">No music here yet</p>'
    + '<p class="feed-empty-body">The playlist is your board&rsquo;s audio. '
    + 'Add a track, or switch back to the board.</p>';
  surface.appendChild(empty);

  if (lens) container.appendChild(surface);

  const view = {
    listEl, reorderable, group,
    fill(audio) {
      const present = new Set();
      audio.forEach(item => {
        present.add(item.id);
        let r = rows.get(item.id);
        if (!r) { r = createRow(item, view); rows.set(item.id, r); }
        else r.item = item;
        listEl.appendChild(r.el);
      });
      for (const [id, r] of rows) {
        if (!present.has(id)) { r.el.remove(); rows.delete(id); }
      }
      empty.classList.toggle('is-shown', audio.length === 0);
      hero?.classList.toggle('is-empty', audio.length === 0);
      view.updateMeta(audio);
    },
    clear() { for (const r of rows.values()) r.el.remove(); rows.clear(); },
    markPlaying() {
      const np = nowPlaying();
      const id = np && isQueuePlayer(np.el) ? np.item?.id : null;
      for (const [rid, r] of rows) r.el.classList.toggle('is-playing', rid === id);
    },
    /** The lens header: the board's name, the cover mosaic and the "N songs" line. */
    updateMeta(audio) {
      if (!hero) return;
      titleEl.textContent = board.title;
      titleEl.classList.toggle('is-default', isDefaultTitle(board.title));
      metaEl.textContent = metaText(audio);
      paintCover(cover, audio);
    },
    destroy() {
      view.clear();
      if (group) actionGroups.delete(group);
      container.replaceChildren();
    },
  };
  return view;
}

/** "9 songs" or "9 songs, 33 min" once the durations are known. */
function metaText(audio) {
  const n = audio.length;
  const songs = `${n} ${n === 1 ? 'song' : 'songs'}`;
  const total = audio.reduce((s, it) => s + (it.meta?.duration || 0), 0);
  if (!total) return songs;
  const mins = Math.round(total / 60);
  return mins < 1 ? songs : `${songs}, ${mins} min`;
}

/**
 * The header cover: a mosaic of the board's own art. Four covers make a 2x2, one
 * or more fewer than four shows the first as a single sleeve, none falls back to a
 * disc. It fills in as the tags are read (rebuildRow calls updateMetaAll).
 *
 * When no track carries embedded art - most loose MP3s do not - the board's own
 * pictures stand in: a music board's photo is its sleeve. Only a board with
 * neither art nor a picture shows the disc.
 */
function paintCover(el, audio) {
  const covers = [];
  const seen = new Set();
  const add = c => { if (c && !seen.has(c)) { seen.add(c); covers.push(c); } };
  for (const it of audio) {
    add(it.meta?.cover && assetURL(it.meta.cover));
    if (covers.length === 4) break;
  }
  if (!covers.length) {
    for (const it of board.items) {
      if (it.type === 'image' && it.asset?.hash) add(assetURL(it.asset.hash));
      if (covers.length === 4) break;
    }
  }
  el.className = 'pl-cover';
  el.replaceChildren();
  if (covers.length >= 4) {
    el.classList.add('is-mosaic');
    for (const src of covers.slice(0, 4)) el.appendChild(coverImg(src));
  } else if (covers.length >= 1) {
    el.appendChild(coverImg(covers[0]));
  } else {
    el.classList.add('is-placeholder');
    el.innerHTML = DISC_ICON;
  }
}

function coverImg(src) {
  const img = document.createElement('img');
  img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
  img.src = src;
  return img;
}

/**
 * One track row: cover (or a note glyph), the title and artist, the duration,
 * and - in a reorderable list - a grip to drag it by. The row is the play
 * control; the grip, which sits over it, starts a drag instead and swallows its
 * own click so a nudge of the handle does not also start the track.
 */
function createRow(item, view) {
  const el = div('pl-row');
  el.dataset.id = item.id;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const r = { el, item };
  fillRow(r, view);
  el.addEventListener('click', () => playTrack(r.item));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playTrack(r.item); }
  });
  return r;
}

function fillRow(r, view) {
  const item = r.item;
  r.el.replaceChildren();

  const art = div('pl-art');
  const cover = item.meta?.cover && assetURL(item.meta.cover);
  if (cover) {
    art.appendChild(coverImg(cover));
  } else {
    art.classList.add('is-placeholder');
    art.innerHTML = NOTE_ICON;
  }
  // The equalizer, shown by CSS only on the .is-playing row.
  const eq = div('pl-eq');
  eq.innerHTML = '<i></i><i></i><i></i><i></i>';
  art.appendChild(eq);

  const main = div('pl-main');
  const title = div('pl-title');
  title.textContent = trackTitle(item);
  main.appendChild(title);
  const sub = item.meta?.artist || item.meta?.album || '';
  if (sub) {
    const artist = div('pl-artist');
    artist.textContent = sub;
    main.appendChild(artist);
  } else {
    main.classList.add('is-single');
  }

  const time = div('pl-time');
  time.textContent = item.meta?.duration != null ? clock(item.meta.duration) : '';

  r.el.append(art, main, time);

  if (view.reorderable) {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'pl-grip';
    grip.setAttribute('aria-label', 'Drag to reorder');
    grip.innerHTML = GRIP_ICON;
    grip.addEventListener('click', e => e.stopPropagation());
    grip.addEventListener('pointerdown', e => beginDrag(e, view, r));
    r.el.appendChild(grip);
  }

  ensureTrackMeta(item);
}

/** A track's display title: the tag, or the filename without its extension. */
function trackTitle(item) {
  return item.meta?.trackTitle || baseName(item.name) || item.name || 'Untitled';
}

// ---------------------------------------------------------------------------
// Drag to reorder
// ---------------------------------------------------------------------------

/**
 * Reorder by dragging the grip. The row is moved through the DOM live as the
 * pointer passes each neighbour's midpoint - no free-floating transform, which
 * keeps a list of forty tracks from turning into forty transforms a frame - and
 * on release the DOM order is read back and committed with setAudioOrder(), which
 * persists it and re-renders. Capture is on the grip so the pointer stream stays
 * with it wherever the finger goes.
 */
function beginDrag(e, view, r) {
  if (drag) return;
  e.preventDefault();
  drag = { view, rowEl: r.el, pointerId: e.pointerId };
  r.el.classList.add('is-dragging');
  const grip = e.currentTarget;
  grip.setPointerCapture?.(e.pointerId);
  grip.addEventListener('pointermove', onDragMove);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
}

function onDragMove(e) {
  if (!drag) return;
  const list = drag.view.listEl;
  const y = e.clientY;
  let ref = null;
  for (const row of list.querySelectorAll('.pl-row')) {
    if (row === drag.rowEl) continue;
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) { ref = row; break; }
  }
  if (ref) list.insertBefore(drag.rowEl, ref);
  else list.appendChild(drag.rowEl);
}

function endDrag(e) {
  if (!drag) return;
  const grip = e.currentTarget;
  drag.rowEl.classList.remove('is-dragging');
  grip.releasePointerCapture?.(e.pointerId);
  grip.removeEventListener('pointermove', onDragMove);
  grip.removeEventListener('pointerup', endDrag);
  grip.removeEventListener('pointercancel', endDrag);
  const ids = [...drag.view.listEl.querySelectorAll('.pl-row')].map(row => row.dataset.id);
  drag = null;
  setAudioOrder(ids);
}

// ---------------------------------------------------------------------------
// Lazy metadata - tags, cover and duration read off the file on demand
// ---------------------------------------------------------------------------

async function ensureTrackMeta(item) {
  const hash = item.asset?.hash;
  if (!hash || tagged.has(item.id)) return;
  tagged.add(item.id);

  const needTags = !item.meta?.artist && !item.meta?.trackTitle && !item.meta?.album;
  const needArt = !item.meta?.cover;
  if (item.meta?.duration == null) probeDuration(item);

  const asset = getAsset(hash);
  if (!asset || (!needTags && !needArt)) return;
  let changed = false;
  try {
    const [tags, art] = await Promise.all([
      needTags ? audioTags(asset.blob) : Promise.resolve([]),
      needArt ? coverArt(asset.blob) : Promise.resolve(null),
    ]);
    const map = Object.fromEntries(tags || []);
    if (map.TITLE && !item.meta.trackTitle) { item.meta.trackTitle = map.TITLE; changed = true; }
    if (map.ARTIST && !item.meta.artist) { item.meta.artist = map.ARTIST; changed = true; }
    if (map.ALBUM && !item.meta.album) { item.meta.album = map.ALBUM; changed = true; }
    if (art && !item.meta.cover) { item.meta.cover = await addFile(art); changed = true; }
  } catch { /* an unreadable tag leaves the filename standing */ }
  if (changed) { markDirty(); rebuildRow(item.id); }
}

function probeDuration(item) {
  const url = item.asset?.hash && assetURL(item.asset.hash);
  if (!url) return;
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.src = url;
  probe.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(probe.duration)) {
      item.meta.duration = probe.duration;
      markDirty();
      rebuildRow(item.id);
    }
    probe.removeAttribute('src');
  }, { once: true });
  probe.addEventListener('error', () => probe.removeAttribute('src'), { once: true });
}

/** Redraw one track's row in every home it appears in, after metadata arrived. */
function rebuildRow(id) {
  for (const view of [mobileView, windowView]) {
    if (!view) continue;
    const list = view.listEl;
    const el = list.querySelector(`.pl-row[data-id="${cssEscape(id)}"]`);
    if (!el) continue;
    fillRow({ el, item: board.items.find(i => i.id === id) }, view);
  }
  // A cover or a duration just arrived: the header's mosaic and "N min" want it too.
  updateMetaAll();
  markPlaying();
}

const cssEscape = s => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

// ---------------------------------------------------------------------------
// The Desktop floating window
// ---------------------------------------------------------------------------

/** Open the window if closed, close it if open. The sidebar's Playlist button. */
export function togglePlayerWindow() {
  if (windowEl) closePlayerWindow(); else openPlayerWindow();
}

export function openPlayerWindow() {
  if (windowEl) return;
  windowEl = div('player-window');

  const head = div('player-window-head');
  const title = div('player-window-title');
  title.textContent = 'Playlist';
  const spacer = div('player-window-spacer');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'player-window-close';
  close.setAttribute('aria-label', 'Close player');
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', closePlayerWindow);
  head.append(title, spacer, close);

  // The window is a real player, not a list with a play-all button: a now-playing
  // panel (cover, title, seek, transport) over the queue.
  windowPlayer = makeWindowPlayer();
  const body = div('player-window-body');
  windowEl.append(head, windowPlayer.el, body);
  document.body.appendChild(windowEl);

  windowView = createView(body, { reorderable: false, variant: 'window' });
  makeDraggable(windowEl, head, close);
  renderAll();
  windowPlayer.bind();
}

export function closePlayerWindow() {
  if (!windowEl) return;
  // The queue is deliberately left running - closing the player is not stopping
  // the music, any more than leaving the Mobile playlist is.
  windowPlayer?.destroy();
  windowView?.destroy();
  windowEl.remove();
  windowEl = null;
  windowView = null;
  windowPlayer = null;
}

/**
 * The Desktop window's transport: the now-playing track (cover, title, artist), a
 * seek line with times, and the five controls (shuffle, prev, play/pause, next,
 * repeat). It drives the same shared queue the list does, and binds its follow
 * loop and element listeners to whatever the queue is currently playing, rebinding
 * on a track change and tearing down when the window closes.
 */
function makeWindowPlayer() {
  const el = div('pw-player');

  const top = div('pw-top');
  const cover = div('pw-cover is-placeholder');
  cover.innerHTML = DISC_ICON;
  const info = div('pw-info');
  const title = div('pw-title');
  title.textContent = 'Nothing playing';
  const artist = div('pw-artist');
  info.append(title, artist);
  top.append(cover, info);

  const seek = div('pw-seek');
  const elapsed = document.createElement('span');
  elapsed.className = 'pw-time'; elapsed.textContent = '0:00';
  const line = div('pw-line');
  line.setAttribute('role', 'slider');
  line.setAttribute('aria-label', 'Seek');
  line.tabIndex = 0;
  const fill = div('pw-line-fill');
  line.appendChild(fill);
  const total = document.createElement('span');
  total.className = 'pw-time'; total.textContent = '0:00';
  seek.append(elapsed, line, total);

  const controls = div('pw-controls');
  const shuffleBtn = pwBtn('pw-shuffle', SHUFFLE_ICON, 'Shuffle', toggleShuffle);
  const prevBtn = pwBtn('pw-prev', PREV_ICON, 'Previous', queuePrev);
  const playBtn = pwBtn('pw-play', PLAY_ICON, 'Play', () => {
    if (!togglePlayback()) { const a = orderedAudio(); if (a.length) playTrack(a[0]); }
  });
  const nextBtn = pwBtn('pw-next', NEXT_ICON, 'Next', queueNext);
  const repeatBtn = pwBtn('pw-repeat', REPEAT_ICON, 'Repeat', cycleRepeat);
  controls.append(shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn);

  el.append(top, seek, controls);

  bindScrub(line, clientX => {
    const s = queueEl();
    if (!s || !s.duration) return;
    const box = line.getBoundingClientRect();
    if (!box.width) return;
    s.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * s.duration;
    paint();
  });

  let boundEl = null, abort = null, frame = 0;

  function paint() {
    const s = queueEl();
    const dur = s?.duration || 0;
    const cur = s?.currentTime || 0;
    fill.style.transform = `scaleX(${dur ? clamp(cur / dur, 0, 1).toFixed(4) : 0})`;
    elapsed.textContent = clock(cur);
    total.textContent = clock(dur);
  }
  function follow() {
    paint();
    const s = queueEl();
    frame = s && !s.paused ? requestAnimationFrame(follow) : 0;
  }
  function refresh() {
    const s = queueEl();
    const playing = !!s && !s.paused;
    playBtn.querySelector('.pw-ico').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const { shuffle, repeat } = queueState();
    shuffleBtn.classList.toggle('is-on', shuffle);
    repeatBtn.classList.toggle('is-on', repeat !== 'off');
    repeatBtn.querySelector('.pw-ico').innerHTML = repeat === 'one' ? REPEAT_ONE_ICON : REPEAT_ICON;
    repeatBtn.setAttribute('aria-label',
      repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat');
  }
  function bind() {
    const np = nowPlaying();
    const item = np && isQueuePlayer(np.el) ? np.item : null;
    cover.replaceChildren();
    if (item) {
      const c = item.meta?.cover && assetURL(item.meta.cover);
      let src = c;
      if (!src) { const img = board.items.find(it => it.type === 'image' && it.asset?.hash); if (img) src = assetURL(img.asset.hash); }
      if (src) { cover.className = 'pw-cover'; cover.appendChild(coverImg(src)); }
      else { cover.className = 'pw-cover is-placeholder'; cover.innerHTML = DISC_ICON; }
      title.textContent = trackTitle(item);
      artist.textContent = item.meta?.artist || item.meta?.album || '';
      artist.hidden = !artist.textContent;
    } else {
      cover.className = 'pw-cover is-placeholder'; cover.innerHTML = DISC_ICON;
      title.textContent = 'Nothing playing';
      artist.textContent = ''; artist.hidden = true;
    }
    const s = queueEl();
    if (s !== boundEl) {
      abort?.abort();
      boundEl = s;
      if (s) {
        abort = new AbortController();
        const sig = abort.signal;
        s.addEventListener('play', () => { refresh(); if (!frame) frame = requestAnimationFrame(follow); }, { signal: sig });
        s.addEventListener('pause', () => { refresh(); paint(); }, { signal: sig });
        s.addEventListener('timeupdate', paint, { signal: sig });
        s.addEventListener('seeked', paint, { signal: sig });
        s.addEventListener('loadedmetadata', paint, { signal: sig });
      }
    }
    refresh();
    paint();
    if (boundEl && !boundEl.paused && !frame) frame = requestAnimationFrame(follow);
  }
  function destroy() {
    abort?.abort(); abort = null; boundEl = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  return { el, bind, refresh, destroy };
}

/** One round transport button for the window player, its glyph in a swappable span. */
function pwBtn(cls, icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pw-btn ' + cls;
  b.innerHTML = `<span class="pw-ico">${icon}</span>`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.addEventListener('click', onClick);
  return b;
}

export const isPlayerWindowOpen = () => !!windowEl;

/**
 * Drag the window by its header. Fixed positioning, moved by left/top; the first
 * drag switches it off the right/bottom anchor it opened on so it does not fight
 * the new coordinates. The close button is excluded so a press on it closes
 * rather than begins a drag.
 */
function makeDraggable(win, handle, ignore) {
  let start = null;
  handle.addEventListener('pointerdown', e => {
    if (ignore && ignore.contains(e.target)) return;
    const box = win.getBoundingClientRect();
    win.style.left = `${box.left}px`;
    win.style.top = `${box.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    start = { x: e.clientX - box.left, y: e.clientY - box.top, id: e.pointerId };
    handle.setPointerCapture?.(e.pointerId);
    win.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const x = Math.max(4, Math.min(window.innerWidth - win.offsetWidth - 4, e.clientX - start.x));
    const y = Math.max(4, Math.min(window.innerHeight - 48, e.clientY - start.y));
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
  });
  const end = () => {
    if (!start) return;
    handle.releasePointerCapture?.(start.id);
    start = null;
    win.classList.remove('is-dragging');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function div(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
