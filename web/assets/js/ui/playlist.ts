// Playlist UI: the board's audio in two homes.
// Mobile lens: album hero + reorderable track list; now-playing bar is the transport.
// Desktop: floating window with compact transport over a plain list.
// Owns no <audio> — drives the shared queue in canvas/playlist-queue.ts.
// No document access at module scope; everything deferred to initPlaylist().

import {
  board, bus, isDefaultTitle, markDirty, setAudioOrder, trackTitle,
} from '../state.ts';
import { clamp, div, actAsButton } from '../util.ts';
import {
  bindScrub, clock, seekInnerHTML, sizeSeekWave, reportPlayError,
  PAUSE_ICON, PLAY_ICON,
} from '../media/transport.ts';
import { mobileOrder, applyAudioOrder } from '../arrange/arrangements.ts';
import { assetURL, getAsset, addFile } from '../storage/assets.ts';
import { nowPlaying, onNowPlaying } from '../canvas/audio.ts';
import {
  clearQueue, cycleRepeat, isQueuePlayer, onQueue, playTrack, queueNext,
  queuePrev, queueState, setQueue, toggleShuffle,
} from '../canvas/playlist-queue.ts';
import { audioTags, coverArt } from '../import/artwork.ts';
import { mediaFacts } from '../import/containers.ts';
import { resetPanels } from './panel-stack.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
// Set before mode switch so entering Mobile lands on the requested lens.
import { setLens } from './board-view.ts';
import type { Item } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** A song, the kind of card the Playlist plays. */
const isTrack = (it: Item) => it.type === 'audio';

// Narrow open `meta` fields to the expected types.
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const urlOf = (hash: unknown): string | null => (typeof hash === 'string' ? assetURL(hash) : null);
const secs = (v: unknown): number => (typeof v === 'number' ? v : 0);

type Row = { el: HTMLElement; item: Item };

type ActionGroup = {
  play: HTMLButtonElement;
  shuffle: HTMLButtonElement;
  playIco: HTMLElement;
  playLabel: HTMLElement;
  // The hero header, if any — refreshActions() toggles its spinning disc.
  hero?: HTMLElement;
};

type View = {
  listEl: HTMLElement;
  reorderable: boolean;
  group: ActionGroup | null;
  // Desktop window's transport; lens uses the now-playing bar instead.
  player: Player | null;
  fill: (audio: Item[]) => void;
  clear: () => void;
  markPlaying: () => void;
  updateMeta: (audio: Item[]) => void;
  destroy: () => void;
};

type Player = {
  el: HTMLElement;
  bind: () => void;
  refresh: () => void;
  destroy: () => void;
};

// `ref`: row before the dragged one, null for end, undefined before first move.
type Drag = {
  view: View;
  rowEl: HTMLElement;
  pointerId: number;
  mids: { row: Element; mid: number }[] | null;
  ref: Element | null | undefined;
};

export interface PlaylistCommands {
  setBoardMode: (mode: string) => void;
}

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
const GRID_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
// Nudged +1 right for optical balance in a round button.
const PW_PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.25 3.5L12.75 8L5.25 12.5Z"/></svg>';

let mobileView: View | null = null;
let windowEl: HTMLElement | null = null;
let windowContent: HTMLElement | null = null;
let windowView: View | null = null;
let windowDetach: (() => void)[] = [];
// makePlayer() adds, destroy() removes — self-maintaining.
const players = new Set<Player>();
const bindPlayers = () => { for (const p of players) p.bind(); };
const refreshPlayers = () => { for (const p of players) p.refresh(); };
let cmds: PlaylistCommands | null = null;

const actionGroups = new Set<ActionGroup>();
let wiredEl: HTMLMediaElement | null = null;
let playbackAbort: AbortController | null = null;
const tagged = new Set<string>();
let drag: Drag | null = null;

export function initPlaylist(_viewport: Viewport | null, _commands: PlaylistCommands | null,
  _headerStyle: unknown) {
  cmds = _commands;
  const host = document.getElementById('mobile-playlist');
  if (host) mobileView = createView(host, { reorderable: true, variant: 'lens' });

  bus.on('board:load', () => {
    clearQueue(); tagged.clear(); wiredEl = null; resetPanels(); closePlayerWindow(); renderAll();
    // A board saved before the flag existed, with music on it, gets it quietly:
    // the Playlist button shows, and no window opens for music already there.
    if (!board.hadMusic && board.items.some(isTrack)) { board.hadMusic = true; bus.emit('board'); }
  });
  // The first song on a board opens the player, once. Only on the canvas: on
  // the Feed a window would cover the column somebody is scrolling, and a song
  // imported there has set the flag, so none opens later either.
  bus.on('items', delta => {
    if (board.hadMusic || !delta?.added?.length) return;
    const added = new Set(delta.added);
    if (!board.items.some(it => added.has(it.id) && isTrack(it))) return;
    board.hadMusic = true;
    markDirty();
    bus.emit('board');
    if (board.layoutMode !== 'mobile') openPlayerWindow();
  });
  bus.on('layout', () => {
    // Desktop only — leaving for Mobile closes it.
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
  onNowPlaying(() => { wirePlayback(); markPlaying(); refreshActions(); bindPlayers(); });
  onQueue(() => { refreshActions(); refreshPlayers(); });

  renderAll();
}

// ---------------------------------------------------------------------------
// The list, in both homes
// ---------------------------------------------------------------------------

function orderedAudio(): Item[] {
  const audio = board.items.filter(it => it.type === 'audio');
  // SAFETY: every order in mobileOrder() returns the same objects it was given, so these are still Items.
  return applyAudioOrder(
    mobileOrder(audio, { name: board.arrangement }) as Item[], board.audioOrder);
}

function renderAll() {
  const audio = orderedAudio();
  setQueue(audio);
  if (board.layoutMode === 'mobile') {
    windowView && windowView.clear();
    mobileView && mobileView.fill(audio);
  } else {
    mobileView && mobileView.clear();
    windowView && windowView.fill(audio);
  }
  markPlaying();
  refreshActions();
  bindPlayers();
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

function queueEl() {
  const np = nowPlaying();
  return np && isQueuePlayer(np.el) ? np.el : null;
}

function togglePlay() {
  const el = queueEl();
  if (el) { el.paused ? el.play().catch(reportPlayError) : el.pause(); return; }
  const audio = orderedAudio();
  if (audio.length) playTrack(audio[0]);
}

function shufflePlay() {
  if (!queueState().shuffle) toggleShuffle();
  const audio = orderedAudio();
  if (audio.length) playTrack(audio[Math.floor(Math.random() * audio.length)]);
}

// Pause/resume does not fire onNowPlaying; wire play/pause directly.
function wirePlayback() {
  const el = queueEl();
  if (!el || el === wiredEl) return;
  playbackAbort?.abort();
  playbackAbort = new AbortController();
  wiredEl = el;
  const onState = () => { refreshActions(); refreshPlayers(); };
  const opts = { signal: playbackAbort.signal };
  el.addEventListener('play', onState, opts);
  el.addEventListener('pause', onState, opts);
  el.addEventListener('ended', onState, opts);
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
    g.hero?.classList.toggle('is-spinning', playing);
    g.shuffle.classList.toggle('is-on', shuffling);
    g.shuffle.setAttribute('aria-pressed', String(shuffling));
  }
}

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
  const group: ActionGroup = {
    play, shuffle,
    playIco: play.querySelector<HTMLElement>('.pl-ico')!,
    playLabel: play.querySelector<HTMLElement>('.pl-label')!,
  };
  actionGroups.add(group);
  return { row, group };
}

// Lens variant: album hero + reorderable list. Window variant: transport + plain list.
function createView(container: HTMLElement,
  { reorderable, variant }: { reorderable: boolean, variant: 'lens' | 'window' }): View {
  container.replaceChildren();
  const rows = new Map<string, Row>();
  const lens = variant === 'lens';
  const surface = lens ? div('feed-sheet') : container;
  let hero: HTMLElement | null = null;
  let cover: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let metaEl: HTMLElement | null = null;
  let group: ActionGroup | null = null;
  if (lens) {
    hero = div('pl-hero');
    const sleeve = div('pl-sleeve');
    const disc = div('pl-disc');
    disc.setAttribute('aria-hidden', 'true');
    cover = div('pl-cover');
    sleeve.append(disc, cover);
    const heroText = div('pl-hero-text');
    titleEl = document.createElement('h2');
    titleEl.className = 'pl-hero-title';
    metaEl = div('pl-hero-meta');
    heroText.append(titleEl, metaEl);
    const made = makeActions();
    group = made.group;
    group.hero = hero;
    heroText.append(made.row);
    hero.append(sleeve, heroText);
    surface.appendChild(hero);
  }

  const player = lens ? null : makePlayer();

  const listEl = div('pl-list');
  surface.appendChild(listEl);

  const empty = div('feed-empty');
  empty.innerHTML =
    '<p class="feed-empty-title">No music here yet</p>'
    + '<p class="feed-empty-body">The playlist is your board&rsquo;s audio. '
    + 'Add a track, or switch back to the board.</p>';
  surface.appendChild(empty);

  if (lens) container.appendChild(surface);

  const view: View = {
    listEl, reorderable, group, player,
    fill(audio) {
      const present = new Set<string>();
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
      if (player) player.el.hidden = audio.length === 0;
      view.updateMeta(audio);
    },
    clear() { for (const r of rows.values()) r.el.remove(); rows.clear(); },
    markPlaying() {
      const np = nowPlaying();
      const id = np && isQueuePlayer(np.el) ? np.item?.id : null;
      for (const [rid, r] of rows) r.el.classList.toggle('is-playing', rid === id);
    },
    updateMeta(audio) {
      if (!hero) return;
      titleEl!.textContent = board.title;
      titleEl!.classList.toggle('is-default', isDefaultTitle(board.title));
      metaEl!.textContent = metaText(audio);
      paintCover(cover!, audio);
    },
    destroy() {
      view.clear();
      if (group) actionGroups.delete(group);
      // Destroy before emptying — transport holds rAF + listeners on a long-lived element.
      if (player) { player.destroy(); players.delete(player); }
      container.replaceChildren();
    },
  };
  return view;
}

function metaText(audio: Item[]) {
  const n = audio.length;
  const songs = `${n} ${n === 1 ? 'song' : 'songs'}`;
  const total = audio.reduce((s, it) => s + secs(it.meta?.duration), 0);
  if (!total) return songs;
  const mins = Math.round(total / 60);
  return mins < 1 ? songs : `${songs} · ${mins} min`;
}

// Cover mosaic: 4+ → 2x2, 1-3 → single, 0 → disc. Falls back to board images.
function paintCover(el: HTMLElement, audio: Item[]) {
  const covers: string[] = [];
  const seen = new Set<string>();
  const add = (c: string | null) => { if (c && !seen.has(c)) { seen.add(c); covers.push(c); } };
  for (const it of audio) {
    add(urlOf(it.meta?.cover));
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

function coverImg(src: string) {
  const img = document.createElement('img');
  img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
  img.src = src;
  return img;
}

function createRow(item: Item, view: View): Row {
  const el = div('pl-row');
  el.dataset.id = item.id;
  const r: Row = { el, item };
  fillRow(r, view);
  actAsButton(el, () => playTrack(r.item));
  return r;
}

function fillRow(r: Row, view: View) {
  const item = r.item;
  r.el.replaceChildren();

  const art = div('pl-art');
  const cover = urlOf(item.meta?.cover);
  if (cover) {
    art.appendChild(coverImg(cover));
  } else {
    // Track number via CSS counter (mobile.css); auto-renumbers on drag.
    art.classList.add('is-placeholder');
  }
  const eq = div('pl-eq');
  eq.innerHTML = '<i></i><i></i><i></i><i></i>';
  art.appendChild(eq);

  const main = div('pl-main');
  const title = div('pl-title');
  title.textContent = trackName(item);
  main.appendChild(title);
  const sub = str(item.meta?.artist) || str(item.meta?.album) || '';
  if (sub) {
    const artist = div('pl-artist');
    artist.textContent = sub;
    main.appendChild(artist);
  }

  const time = div('pl-time');
  time.textContent = typeof item.meta?.duration === 'number' ? clock(item.meta.duration) : '';

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

function trackName(item: Item) {
  return trackTitle(item) || 'Untitled';
}

// ---------------------------------------------------------------------------
// Drag to reorder
// ---------------------------------------------------------------------------

// Moves the row through the DOM live (no transforms); commits order on release.
function beginDrag(e: PointerEvent, view: View, r: Row) {
  if (drag) return;
  e.preventDefault();
  drag = { view, rowEl: r.el, pointerId: e.pointerId, mids: null, ref: undefined };
  r.el.classList.add('is-dragging');
  // SAFETY: beginDrag is only called from the grip's pointerdown listener, a <button> built above.
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture?.(e.pointerId);
  grip.addEventListener('pointermove', onDragMove);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
}

// Cached until the row lands in a new gap (invalidates on DOM move).
function rowMids() {
  if (drag!.mids) return drag!.mids;
  const mids: { row: Element; mid: number }[] = [];
  for (const row of drag!.view.listEl.querySelectorAll('.pl-row')) {
    if (row === drag!.rowEl) continue;
    const box = row.getBoundingClientRect();
    mids.push({ row, mid: box.top + box.height / 2 });
  }
  return (drag!.mids = mids);
}

function onDragMove(e: PointerEvent) {
  if (!drag) return;
  const list = drag.view.listEl;
  const y = e.clientY;
  let ref = null;
  for (const { row, mid } of rowMids()) {
    if (y < mid) { ref = row; break; }
  }
  if (ref === drag.ref) return;
  drag.ref = ref;
  if (ref) list.insertBefore(drag.rowEl, ref);
  else list.appendChild(drag.rowEl);
  drag.mids = null;
}

function endDrag(e: PointerEvent) {
  if (!drag) return;
  // SAFETY: endDrag is only added as a listener on the grip, in beginDrag().
  const grip = e.currentTarget as HTMLElement;
  drag.rowEl.classList.remove('is-dragging');
  grip.releasePointerCapture?.(e.pointerId);
  grip.removeEventListener('pointermove', onDragMove);
  grip.removeEventListener('pointerup', endDrag);
  grip.removeEventListener('pointercancel', endDrag);
  const ids = [...drag.view.listEl.querySelectorAll<HTMLElement>('.pl-row')]
    .map(row => row.dataset.id);
  drag = null;
  setAudioOrder(ids);
}

// ---------------------------------------------------------------------------
// Lazy metadata - tags, cover and duration read off the file on demand
// ---------------------------------------------------------------------------

async function ensureTrackMeta(item: Item) {
  const hash = item.asset?.hash;
  if (!hash || tagged.has(item.id)) return;
  tagged.add(item.id);

  const needTags = !item.meta?.artist && !item.meta?.trackTitle && !item.meta?.album;
  const needArt = !item.meta?.cover;
  const asset = getAsset(hash);
  // Raw AAC: engine-guessed duration can be off by a factor; recount from frames.
  if (item.meta?.duration == null) probeDuration(item);
  else if (asset?.ext === 'aac') probeDuration(item, true);

  if (!asset || (!needTags && !needArt)) return;
  let changed = false;
  try {
    const [tags, art] = await Promise.all([
      needTags ? audioTags(asset.blob) : Promise.resolve([]),
      // Own catch: a cover past the ceiling must not swallow the tags.
      needArt ? coverArt(asset.blob).catch(() => null) : Promise.resolve(null),
    ]);
    const map = Object.fromEntries(tags || []);
    if (map.TITLE && !item.meta.trackTitle) { item.meta.trackTitle = map.TITLE; changed = true; }
    if (map.ARTIST && !item.meta.artist) { item.meta.artist = map.ARTIST; changed = true; }
    if (map.ALBUM && !item.meta.album) { item.meta.album = map.ALBUM; changed = true; }
    if (art && !item.meta.cover) { item.meta.cover = await addFile(art); changed = true; }
  } catch { /* an unreadable tag leaves the filename standing */ }
  if (changed) { markDirty(); rebuildRow(item.id); }
}

const PROBE_LIMIT = 4;
const PROBE_MS = 15_000;
const probeQueue: { item: Item, countOnly: boolean }[] = [];
let probesRunning = 0;

function probeDuration(item: Item, countOnly = false) {
  probeQueue.push({ item, countOnly });
  pumpProbes();
}

function pumpProbes() {
  while (probesRunning < PROBE_LIMIT && probeQueue.length) {
    const { item, countOnly } = probeQueue.shift()!;
    const hash = item.asset?.hash;
    if (!hash) continue;
    const url = assetURL(hash);
    if (!url) continue;
    probesRunning += 1;
    void runProbe(item, hash, url, countOnly)
      .catch(() => { probesRunning -= 1; pumpProbes(); });
  }
}

// Skips write if the value has not meaningfully changed (<0.5s).
function takeDuration(item: Item, secs: number) {
  if (!Number.isFinite(secs) || secs <= 0) return;
  const had = item.meta.duration;
  if (typeof had === 'number' && Math.abs(had - secs) < 0.5) return;
  item.meta.duration = secs;
  markDirty();
  rebuildRow(item.id);
}

// File-level duration first (exact sample count); falls back to engine probe.
// `countOnly`: recount only, no engine fallback (already has engine's answer).
async function runProbe(item: Item, hash: string, url: string, countOnly: boolean) {
  const blob = getAsset(hash)?.blob;
  const facts = blob ? await mediaFacts(blob, String(item.meta?.ext || '')).catch(() => null) : null;
  const stated = facts?.estimated ? 0 : facts?.duration || 0;
  if (stated || countOnly) {
    if (stated) takeDuration(item, stated);
    probesRunning -= 1;
    pumpProbes();
    return;
  }
  elementProbe(item, url, facts?.duration || 0);
}

// Engine probe via <audio preload="metadata">; uses `estimate` if engine fails.
function elementProbe(item: Item, url: string, estimate = 0) {
  const probe = new Audio();
  let timer = 0;
  // Single exit; clear src + load() to release buffered data.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    probe.removeAttribute('src');
    probe.load();
    probesRunning -= 1;
    pumpProbes();
  };
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => {
    takeDuration(item, probe.duration);
    finish();
  }, { once: true });
  const giveUp = () => { if (!done && estimate) takeDuration(item, estimate); finish(); };
  probe.addEventListener('error', giveUp, { once: true });
  timer = setTimeout(giveUp, PROBE_MS);
  probe.src = url;
}

function rebuildRow(id: string) {
  for (const view of [mobileView, windowView]) {
    if (!view) continue;
    const list = view.listEl;
    const el = list.querySelector<HTMLElement>(`.pl-row[data-id="${cssEscape(id)}"]`);
    if (!el) continue;
    fillRow({ el, item: board.items.find(i => i.id === id)! }, view);
  }
  updateMetaAll();
  markPlaying();
}

const cssEscape = (s: string) =>
  (typeof window.CSS?.escape === 'function' ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

// ---------------------------------------------------------------------------
// The Desktop floating window
// ---------------------------------------------------------------------------

export function togglePlayerWindow() {
  if (windowEl) closePlayerWindow(); else openPlayerWindow();
}

function openPlayerWindow() {
  if (windowEl) return;
  windowEl = div('player-window');
  markTransport();

  const head = div('player-window-head');
  const title = div('player-window-title');
  title.textContent = 'Playlist';
  const spacer = div('player-window-spacer');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'player-window-toggle';
  toggle.innerHTML = GRID_ICON;
  toggle.setAttribute('aria-label', 'Album view');
  toggle.title = 'Album view';
  toggle.addEventListener('click', showAlbumView);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'player-window-close';
  close.setAttribute('aria-label', 'Close player');
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', closePlayerWindow);
  head.append(title, spacer, toggle, close);
  windowDetach.push(makeWindowDrag(windowEl, head));
  windowContent = div('player-window-content');
  windowEl.append(head, windowContent);
  document.body.appendChild(windowEl);

  const resize = div('player-window-resize');
  resize.setAttribute('aria-hidden', 'true');
  windowEl.appendChild(resize);
  windowDetach.push(makeWindowResize(windowEl, resize));

  renderWindowBody();

  // Next frame so the transition from scaled-down actually runs.
  requestAnimationFrame(() => windowEl?.classList.add('is-open'));
}

function renderWindowBody() {
  if (!windowEl) return;
  windowView?.destroy();
  windowView = null;
  windowContent!.replaceChildren();

  const body = div('player-window-body');
  windowView = createView(body, { reorderable: false, variant: 'window' });
  windowContent!.append(windowView.player!.el, body);

  markTransport();
  renderAll();
}

function showAlbumView() {
  setLens('playlist');
  cmds?.setBoardMode('mobile');
}

// Per-element backstop: a shared timer lost the first element's backstop on rapid close/reopen.
const windowExits = new WeakMap<Element, number>();

function closePlayerWindow() {
  if (!windowEl) { markTransport(); return; }
  const el = windowEl;
  windowView?.destroy();
  windowDetach.forEach(fn => fn());
  windowDetach = [];
  windowEl = null;
  windowContent = null;
  windowView = null;
  el.classList.remove('is-open');
  clearTimeout(windowExits.get(el));
  const done = () => { clearTimeout(windowExits.get(el)); windowExits.delete(el); el.remove(); };
  el.addEventListener('transitionend', e => { if (e.propertyName === 'transform') done(); }, { once: true });
  windowExits.set(el, setTimeout(done, 500));
  markTransport();
}

// Tells chrome.css whether a transport is visible, so the now-playing bar can hide.
function markTransport() {
  document.documentElement.classList.toggle('playlist-transport', !!windowEl);
}

// Compact transport: cover, seek, shuffle/prev/play/next/repeat.
function makePlayer(): Player {
  const el = div('pw-player');

  const top = div('pw-top');
  const cover = div('pw-cover is-placeholder');
  cover.innerHTML = DISC_ICON;
  const info = div('pw-info');
  const title = div('pw-title');
  title.textContent = 'Nothing playing';
  const artist = div('pw-artist');
  const pos = div('pw-pos');
  pos.hidden = true;
  info.append(title, artist, pos);
  top.append(cover, info);

  const seek = div('pw-seek');
  const elapsed = document.createElement('span');
  elapsed.className = 'pw-time'; elapsed.textContent = '0:00';
  const line = div('pw-line');
  line.setAttribute('role', 'slider');
  line.setAttribute('aria-label', 'Seek');
  line.tabIndex = 0;
  line.innerHTML = seekInnerHTML('pw-line');
  const waveSvg = line.querySelector('.pw-line-wave-svg');
  const wavePathEl = line.querySelector('.pw-line-fill-wave');
  const sizeWave = () => sizeSeekWave(line, waveSvg, wavePathEl);
  sizeWave();
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(line);
  const total = document.createElement('span');
  total.className = 'pw-time'; total.textContent = '0:00';
  seek.append(elapsed, line, total);

  const controls = div('pw-controls');
  const shuffleBtn = pwBtn('pw-shuffle', SHUFFLE_ICON, 'Shuffle', toggleShuffle);
  const prevBtn = pwBtn('pw-prev', PREV_ICON, 'Previous', queuePrev);
  const playBtn = pwBtn('pw-play', PW_PLAY_ICON, 'Play', togglePlay);
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

  let boundEl: HTMLMediaElement | null = null;
  let abort: AbortController | null = null;
  let frame = 0;

  function paint() {
    const s = queueEl();
    const dur = s?.duration || 0;
    const cur = s?.currentTime || 0;
    line.style.setProperty('--pw-progress', (dur ? clamp(cur / dur, 0, 1) : 0).toFixed(4));
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
    // Wave flattens to a straight line when paused (chrome.css).
    el.classList.toggle('is-paused', !playing);
    playBtn.querySelector('.pw-ico')!.innerHTML = playing ? PAUSE_ICON : PW_PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const { shuffle, repeat, index, length } = queueState();
    shuffleBtn.classList.toggle('is-on', shuffle);
    repeatBtn.classList.toggle('is-on', repeat !== 'off');
    repeatBtn.querySelector('.pw-ico')!.innerHTML = repeat === 'one' ? REPEAT_ONE_ICON : REPEAT_ICON;
    repeatBtn.setAttribute('aria-label',
      repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat');
    // Disable prev/next at list ends only when not shuffling or repeating.
    const straight = !shuffle && repeat === 'off';
    const loaded = index >= 0 && length > 0;
    pos.hidden = !loaded;
    if (loaded) pos.textContent = `${index + 1} of ${length}`;
    prevBtn.disabled = !length || (straight && loaded && index <= 0);
    nextBtn.disabled = !length || (straight && loaded && index >= length - 1);
  }
  function bind() {
    const np = nowPlaying();
    const item = np && isQueuePlayer(np.el) ? np.item : null;
    cover.replaceChildren();
    if (item) {
      const c = urlOf(item.meta?.cover);
      let src = c;
      if (!src) {
        const hash = board.items.find(it => it.type === 'image' && it.asset?.hash)?.asset?.hash;
        if (hash) src = assetURL(hash);
      }
      if (src) { cover.className = 'pw-cover'; cover.appendChild(coverImg(src)); }
      else { cover.className = 'pw-cover is-placeholder'; cover.innerHTML = DISC_ICON; }
      title.textContent = trackName(item);
      artist.textContent = str(item.meta?.artist) || str(item.meta?.album) || '';
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
        s.addEventListener('durationchange', paint, { signal: sig });
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
  const player: Player = { el, bind, refresh, destroy };
  players.add(player);
  return player;
}

function pwBtn(cls: string, icon: string, label: string, onClick: () => void) {
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

