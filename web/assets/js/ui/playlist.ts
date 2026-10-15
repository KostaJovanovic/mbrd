// Playlist UI: the board's audio in two homes.
// Mobile lens: album hero + reorderable track list; now-playing bar is the transport.
// Desktop: a panel flying in from the right, compact transport over a plain list.
// Owns no <audio> — drives the shared queue in canvas/playlist-queue.ts.
// No document access at module scope; everything deferred to initPlaylist().

import {
  board, bus, clearSelection, deselect, isDefaultTitle, isMultiSelect, markDirty, renameItem,
  select, selection, setAudioOrder, trackTitle,
} from '../state.ts';
import {
  animMs, clamp, div, actAsButton, makeEditable, markClosed, readToken, reducedMotion, selectContents,
} from '../util.ts';
import {
  bindScrub, clock, seekInnerHTML, sizeSeekWave, reportPlayError, trackLength,
  PAUSE_ICON, PLAY_ICON,
} from '../media/transport.ts';
import { mobileOrder, applyAudioOrder } from '../arrange/arrangements.ts';
import { cue } from '../cuelume/engine.ts';
import { assetURL, getAsset, addFile } from '../storage/assets.ts';
import { nowPlaying, onNowPlaying } from '../canvas/audio.ts';
import { edgeSpeed, EDGE_MAX } from '../canvas/edge-pan.ts';
import {
  clearQueue, cycleRepeat, isQueuePlayer, onQueue, playTrack, queueNext,
  queuePrev, queueState, setQueue, toggleShuffle,
} from '../canvas/playlist-queue.ts';
import { audioTags, coverArt } from '../import/artwork.ts';
import { mediaFacts } from '../import/containers.ts';
import { registerPanel, panelShown, panelHidden, resetPanels } from './panel-stack.ts';
import { showSheet, hideSheet } from './sheet.ts';
import { openContextMenu } from './menu.ts';
import type { MenuEntry } from './menu.ts';
// Set before mode switch so entering Mobile lands on the requested lens.
import { setLens } from './board-view.ts';
import type { Item } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** A song, the kind of card the Playlist plays. */
const isTrack = (it: Item) => it.type === 'audio';

/**
 * Hidden from the Playlist (the row's menu): greyed at the foot of the list and
 * never stepped to. A property of the track, so it holds in both homes.
 */
const isHidden = (it: Item) => it.meta?.playlistHidden === true;

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
  // What a drag held at its edge scrolls; null where the list does not scroll.
  scroller: HTMLElement | null;
  group: ActionGroup | null;
  // Desktop window's transport; lens uses the now-playing bar instead.
  player: Player | null;
  fill: (audio: Item[]) => void;
  clear: () => void;
  markPlaying: () => void;
  markSelected: () => void;
  updateMeta: (audio: Item[]) => void;
  destroy: () => void;
};

type Player = {
  el: HTMLElement;
  bind: () => void;
  refresh: () => void;
  destroy: () => void;
};

// Positions are in list coordinates, measured once at pickup: `rows` are the
// listed rows then, `from` the held one's place and `to` where it would land.
type Drag = {
  view: View;
  rowEl: HTMLElement;
  pointerId: number;
  rows: HTMLElement[];
  tops: number[];
  heights: number[];
  from: number;
  to: number;
  grab: number;
  dy: number;
  lastY: number;
  frame: number;
  // The last frame's time, for the edge scroll's step, and the part of a pixel
  // it has still to scroll: a slow edge moves less than a pixel a frame.
  at: number;
  spill: number;
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
// A finger held on a row opens its menu, as a right click does. The Feed's
// numbers, for the reason it gives: the same question of how still a thumb is.
const HOLD_MS = 500;
const HOLD_SLOP = 10;
let hold: { x: number, y: number, timer: number } | null = null;
// Set when a hold opened the menu, so the tap that ends it does not also play.
let heldOpen = false;

export function initPlaylist(_viewport: Viewport | null, _commands: PlaylistCommands | null,
  _headerStyle: unknown) {
  cmds = _commands;
  const host = document.getElementById('mobile-playlist');
  if (host) mobileView = createView(host, { reorderable: true, variant: 'lens' });

  // The player and the sticker pad stand on the same corner. Opening one puts
  // the other away and remembers it; closing brings it back. Nothing is
  // written down, so a reload starts with both shut.
  registerPanel('playlist', openPlayerWindow, closePlayerWindow);

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
  bus.on('selection', () => { mobileView?.markSelected(); windowView?.markSelected(); });
  // One card changed - renamed, or given a picture from the row's menu.
  bus.on('item', id => {
    if (board.items.some(it => it.id === id && isTrack(it))) rebuildRow(String(id));
  });
  onNowPlaying(() => {
    wirePlayback(); markPlaying(); refreshActions(); bindPlayers(); markTransport();
  });
  onQueue(() => { refreshActions(); refreshPlayers(); });

  renderAll();
}

// ---------------------------------------------------------------------------
// The list, in both homes
// ---------------------------------------------------------------------------

/** The board's audio in playing order, hidden tracks still in their places. */
function boardOrder(): Item[] {
  const audio = board.items.filter(it => it.type === 'audio');
  return applyAudioOrder(mobileOrder(audio, { name: board.arrangement }), board.audioOrder);
}

/** As the list shows it: the hidden tracks sunk to the foot. */
function orderedAudio(): Item[] {
  const all = boardOrder();
  return [...all.filter(it => !isHidden(it)), ...all.filter(isHidden)];
}

/** What the Playlist offers to play: the ordered audio less what is hidden. */
const listedAudio = () => boardOrder().filter(it => !isHidden(it));

/**
 * A new order for the listed tracks. A hidden track keeps the slot it holds in
 * `audioOrder`, so showing it again puts it back where it was.
 */
function setListedOrder(ids: string[]) {
  const rest = ids.slice();
  setAudioOrder(boardOrder().map(it => (isHidden(it) ? it.id : rest.shift() ?? it.id)));
}

function renderAll() {
  const audio = orderedAudio();
  setQueue(audio, audio.filter(isHidden));
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

/** The queue player's length, the counted one where there is one — trackLength(). */
function queueLength() {
  const el = queueEl();
  return el ? trackLength(el, nowPlaying()?.item?.meta?.duration) : 0;
}

function togglePlay() {
  const el = queueEl();
  if (el) { el.paused ? el.play().catch(reportPlayError) : el.pause(); return; }
  const audio = listedAudio();
  if (audio.length) playTrack(audio[0]);
}

function shufflePlay() {
  if (!queueState().shuffle) toggleShuffle();
  const audio = listedAudio();
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
  // The row's equalizer freezes with the sound: pause and ended never reach
  // markPlaying(), which follows only onNowPlaying.
  for (const v of [mobileView, windowView]) {
    v?.listEl.querySelector('.pl-row.is-playing')?.classList.toggle('is-paused', !playing);
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
  wireSheet(container);
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
  // The lens takes the whole screen, so its empty state carries the way back
  // it names. The window floats over the board, which is already there.
  if (lens) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'feed-empty-back';
    back.textContent = 'Back to the board';
    back.addEventListener('click', () => setLens('feed'));
    empty.append(back);
  }
  surface.appendChild(empty);

  if (lens) container.appendChild(surface);

  const view: View = {
    listEl, reorderable, group, player,
    // The lens scrolls as a whole; the window scrolls its body, which is this.
    scroller: container,
    fill(audio) {
      const shown = [...listEl.querySelectorAll<HTMLElement>('.pl-row')].map(el => el.dataset.id);
      const moved = audio.length !== shown.length || audio.some((it, i) => it.id !== shown[i]);
      if (moved && drag?.view === view) finishDrag(false);
      // Where each row stood, so a reorder slides instead of jumping. Only when
      // something moved: fill() runs on every board change.
      const before = moved ? rowTops(listEl) : null;
      const present = new Set<string>();
      audio.forEach(item => {
        present.add(item.id);
        let r = rows.get(item.id);
        if (!r) { r = createRow(item, view); rows.set(item.id, r); }
        else r.item = item;
        r.el.classList.toggle('is-hidden', isHidden(item));
        r.el.classList.toggle('is-selected', selection.has(item.id));
        if (moved) listEl.appendChild(r.el);
      });
      for (const [id, r] of rows) {
        if (!present.has(id)) { r.el.remove(); rows.delete(id); }
      }
      if (before) slideFrom(before);
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
    markSelected() {
      for (const [rid, r] of rows) r.el.classList.toggle('is-selected', selection.has(rid));
    },
    updateMeta(audio) {
      if (!hero) return;
      const listed = audio.filter(it => !isHidden(it));
      titleEl!.textContent = board.title;
      titleEl!.classList.toggle('is-default', isDefaultTitle(board.title));
      metaEl!.textContent = metaText(listed);
      paintCover(cover!, listed);
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
  actAsButton(el, () => {
    if (heldOpen) { heldOpen = false; return; }
    // The keyboard's press in the pick mode. A click never gets here: see wireSheet().
    if (isMultiSelect()) { pick(r.item.id); return; }
    playTrack(r.item);
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    // A hold already opened it: Android reports its own long press as well.
    if (heldOpen) return;
    cancelHold();
    // The keyboard's menu key reports no point, so hang the menu off the row.
    const box = el.getBoundingClientRect();
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 16, y: box.bottom };
    openRowMenu(at.x, at.y, r);
  });
  el.addEventListener('pointerdown', e => armHold(e, (x, y) => openRowMenu(x, y, r, true)),
    { passive: true });
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
    grip.addEventListener('pointerdown', e => beginDrag(e, view, r, grip));
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

// The held row lifts and follows the pointer on `translate`, and the rows it
// passes slide aside to open its gap. The DOM is left alone until release: the
// old drag moved the row live, which released the grip's pointer capture after
// the first swap, so the drag stopped following and never ended.
function beginDrag(e: PointerEvent, view: View, r: Row, grip: HTMLElement) {
  if (drag || e.button !== 0 || isHidden(r.item)) return;
  const list = view.listEl;
  const rows = [...list.querySelectorAll<HTMLElement>('.pl-row:not(.is-hidden)')];
  const from = rows.indexOf(r.el);
  if (from < 0) return;
  e.preventDefault();
  cancelHold();
  // Grabbed mid-settle, the row stays where it is drawn: its live offset goes
  // into the grab, so cancelling the settle below moves nothing under the finger.
  const drawn = Number.parseFloat(getComputedStyle(r.el).translate.split(' ')[1] ?? '') || 0;
  // Measured at rest: a row still sliding from the last drop would be read
  // where it is drawn instead of where it stands.
  for (const row of rows) {
    for (const run of row.getAnimations()) run.cancel();
    row.style.translate = '';
  }
  const top = list.getBoundingClientRect().top;
  const boxes = rows.map(row => row.getBoundingClientRect());
  drag = {
    view, rowEl: r.el, pointerId: e.pointerId, rows,
    tops: boxes.map(b => b.top - top),
    heights: boxes.map(b => b.height),
    from, to: from, grab: e.clientY - top - drawn, dy: drawn, lastY: e.clientY, frame: 0, at: 0, spill: 0,
  };
  r.el.style.translate = drawn ? `0 ${drawn}px` : '';
  list.classList.add('is-sorting');
  r.el.classList.add('is-dragging');
  grip.setPointerCapture?.(e.pointerId);
  // On the window: a row rebuilt under the pointer takes its grip, and with it
  // the capture, out of the document.
  addEventListener('pointermove', onDragMove);
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  addEventListener('keydown', onDragKey, true);
  drag.frame = requestAnimationFrame(dragFrame);
  cue('pick');
}

// Escape puts the row back; the settle flies it home from the live offset.
function onDragKey(e: KeyboardEvent) {
  if (!drag || e.key !== 'Escape') return;
  e.stopPropagation();
  markClosed(e);
  finishDrag(false);
}

function onDragMove(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) drag.lastY = e.clientY;
}

function endDrag(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) finishDrag(e.type === 'pointerup');
}

// Per frame rather than per move, so a list scrolled under a still pointer - by
// the edge below, or a wheel - carries the held row with it.
function dragFrame(now: number) {
  if (!drag) return;
  const sc = drag.view.scroller;
  // Timed by the frame's own interval, so the list scrolls as fast at 120 Hz
  // as at 60, and on the board's curve (canvas/edge-pan.ts).
  const dt = drag.at ? Math.min(now - drag.at, 50) / 1000 : 0;
  drag.at = now;
  if (sc) {
    const box = sc.getBoundingClientRect();
    // Deep enough to reach past the header and the now-playing bar over the lens.
    const band = box.height * 0.18;
    const want = drag.spill + edgeSpeed(drag.lastY, box.top, box.bottom, band, EDGE_MAX) * dt;
    // Whole pixels, the rest carried: a fraction added to scrollTop can be
    // rounded away, and a slow edge would never move.
    const whole = Math.trunc(want);
    drag.spill = want - whole;
    if (whole) sc.scrollTop += whole;
  }
  placeHeld();
  drag.frame = requestAnimationFrame(dragFrame);
}

/** Draw the held row under the pointer and open the gap where it would land. */
function placeHeld() {
  const d = drag!;
  const { rows, tops, heights, from } = d;
  const last = rows.length - 1;
  // Held inside the listed rows: past the last one are the hidden ones.
  d.dy = clamp(d.lastY - d.view.listEl.getBoundingClientRect().top - d.grab,
    tops[0] - tops[from], tops[last] + heights[last] - tops[from] - heights[from]);
  d.rowEl.style.translate = `0 ${d.dy}px`;
  const centre = tops[from] + heights[from] / 2 + d.dy;
  let to = 0;
  for (let i = 0; i <= last; i += 1) {
    if (i !== from && tops[i] + heights[i] / 2 < centre) to += 1;
  }
  if (to === d.to) return;
  d.to = to;
  const gap = heights[from];
  rows.forEach((row, i) => {
    if (i === from) return;
    const shift = i > from && i <= to ? -gap : i < from && i >= to ? gap : 0;
    row.style.translate = shift ? `0 ${shift}px` : '';
  });
}

/** Put the held row down in its gap, or back where it was, and let it settle. */
function finishDrag(commit: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  cancelAnimationFrame(d.frame);
  removeEventListener('pointermove', onDragMove);
  removeEventListener('pointerup', endDrag);
  removeEventListener('pointercancel', endDrag);
  removeEventListener('keydown', onDragKey, true);
  const { rowEl, rows, from } = d;
  const to = commit ? d.to : from;
  const list = d.view.listEl;
  // Where the row is drawn, and the lift it is drawn with, before any of it goes.
  const was = list.getBoundingClientRect().top + d.tops[from] + d.dy;
  const lifted = getComputedStyle(rowEl);
  const lift = { scale: lifted.scale, rotate: lifted.rotate };
  // The other rows' offsets already drew them in their new places, so the
  // offsets and the move cancel out, in one frame, with the slide switched off.
  list.classList.remove('is-sorting');
  rowEl.classList.remove('is-dragging');
  for (const row of rows) row.style.translate = '';
  const order = rows.filter(row => row !== rowEl);
  order.splice(to, 0, rowEl);
  if (to !== from) {
    if (to < order.length - 1) list.insertBefore(rowEl, order[to + 1]);
    else order[order.length - 2].after(rowEl);
  }
  settle(rowEl, was - rowEl.getBoundingClientRect().top, lift);
  if (to !== from) {
    cue('tap');
    setListedOrder(order.map(row => row.dataset.id ?? ''));
  }
}

// ---------------------------------------------------------------------------
// Motion: the drop, and a reorder made from the menu
// ---------------------------------------------------------------------------

/** --dur-base in ms, or 0 where motion is off. */
const motionMs = () => (reducedMotion() ? 0 : animMs());

/** The dropped row eases into its slot from where it was let go. */
function settle(el: HTMLElement, dy: number, lift: { scale: string, rotate: string }) {
  const ms = motionMs();
  if (!ms) return;
  // Above its neighbours until it lands, and its shadow fades as it does (mobile.css).
  el.classList.add('is-settling');
  const run = el.animate([
    { translate: `0 ${dy}px`, scale: lift.scale, rotate: lift.rotate },
    { translate: '0 0', scale: '1', rotate: '0deg' },
  ], { duration: ms, easing: readToken('--ease-back') || 'ease' });
  const done = () => el.classList.remove('is-settling');
  run.addEventListener('finish', done);
  run.addEventListener('cancel', done);
}

/** Each row's top on screen, or null where the list is not drawn. */
function rowTops(list: HTMLElement): Map<HTMLElement, number> | null {
  if (!list.getClientRects().length || !motionMs()) return null;
  const tops = new Map<HTMLElement, number>();
  for (const row of list.querySelectorAll<HTMLElement>('.pl-row')) {
    tops.set(row, row.getBoundingClientRect().top);
  }
  return tops;
}

/** Slide every row that moved from where it stood to where it stands. */
function slideFrom(before: Map<HTMLElement, number>) {
  const ms = motionMs();
  const easing = readToken('--ease') || 'ease';
  for (const [row, top] of before) {
    if (!row.isConnected) continue;
    const dy = top - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    row.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: ms, easing });
  }
}

// ---------------------------------------------------------------------------
// The row's menu: right click, or a finger held on the row
// ---------------------------------------------------------------------------

function armHold(e: PointerEvent, open: (x: number, y: number) => void) {
  // Spent here and not only by the click it guards: iOS sends no click after
  // a long press, and a flag left set would swallow the next tap.
  heldOpen = false;
  // Touch only: a mouse has its right button, a pen its barrel press.
  if (e.pointerType !== 'touch' || drag) return;
  if (e.target instanceof Element && e.target.closest('.pl-grip')) return;
  cancelHold();
  const x = e.clientX;
  const y = e.clientY;
  hold = {
    x, y,
    timer: setTimeout(() => { hold = null; heldOpen = true; open(x, y); }, HOLD_MS),
  };
}

/** A track in or out of the board's selection, the one the row menu acts on. */
function pick(id: string) {
  if (!deselect(id)) select([id], true);
}

/**
 * The list's own menu, for a press off every row: a right click, or a finger
 * held there. The move, the release and the tap after a hold are the rows'
 * too, so all of them are caught here once and not on each row. And picking,
 * as the Feed picks its tiles (ui/feed.ts).
 */
function wireSheet(container: HTMLElement) {
  const onRow = (e: Event) => e.target instanceof Element && !!e.target.closest('.pl-row');
  container.addEventListener('contextmenu', e => {
    if (onRow(e)) return;
    e.preventDefault();
    if (heldOpen) return;
    cancelHold();
    openSheetMenu(e.clientX, e.clientY);
  });
  container.addEventListener('pointerdown', e => {
    if (!onRow(e)) armHold(e, openSheetMenu);
  }, { passive: true });
  container.addEventListener('pointermove', e => {
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancelHold();
  }, { passive: true });
  container.addEventListener('pointerup', cancelHold, { passive: true });
  container.addEventListener('pointercancel', cancelHold, { passive: true });
  // Capture, so a hold on the hero's Play does not also press it.
  container.addEventListener('click', e => {
    if (!heldOpen || onRow(e)) return;
    heldOpen = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // Picking a row rather than playing it: a click with Shift, Ctrl or Cmd, or
  // any tap in the multi-select mode. Capture, so the row's play never sees it.
  // Not on the grip, whose press is a drag, nor in a row being renamed.
  container.addEventListener('click', e => {
    if (e.defaultPrevented || !(e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect())) return;
    const at = e.target instanceof Element ? e.target : null;
    const row = at?.closest<HTMLElement>('.pl-row');
    if (!row?.dataset.id || at?.closest('.pl-grip') || row.classList.contains('is-renaming')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pick(row.dataset.id);
  }, true);
  // A press between the rows puts the selection down, as on the Feed. Only on
  // the lens, which is the board: the window floats over the canvas, whose
  // selection is the canvas's to put down. The pick mode keeps its group.
  container.addEventListener('click', e => {
    if (e.defaultPrevented || isMultiSelect() || board.layoutMode !== 'mobile') return;
    const at = e.target instanceof Element ? e.target : null;
    if (!at || at.closest('.pl-row, button, a, input')) return;
    clearSelection();
  });
}

function cancelHold() {
  if (hold) clearTimeout(hold.timer);
  hold = null;
}

/**
 * The Playlist's own rows - playing, order, hiding - over the card's menu, the
 * one the Feed opens. The card's rows act on the selection, so the track is
 * selected first, exactly as the Feed does for a tile.
 */
function openRowMenu(x: number, y: number, r: Row, touch = false) {
  if (drag) return;
  const item = r.item;
  const hidden = isHidden(item);
  const listed = listedAudio();
  const at = listed.indexOf(item);
  const last = listed.length - 1;
  const el = queueEl();
  const current = el && nowPlaying()?.item === item ? el : null;
  const playing = !!current && !current.paused;
  // Greyed rather than hidden at either end, so the menu keeps its shape from
  // one row to the next. None for a hidden track: it has no place to move from.
  const moves: MenuEntry[] = hidden || at < 0 || last < 1 ? [] : [
    { sep: true },
    { label: 'Move up', icon: 'i-arrow-up', disabled: at === 0, action: () => moveTrack(item, at - 1) },
    { label: 'Move down', icon: 'i-arrow-down', disabled: at === last, action: () => moveTrack(item, at + 1) },
  ];
  const lead: MenuEntry[] = [
    { label: 'Pause', icon: 'i-tl-pause', hidden: !playing, action: () => current?.pause() },
    {
      label: 'Play', icon: 'i-tl-play', hidden: playing,
      action: () => { if (current) current.play().catch(reportPlayError); else playTrack(item); },
    },
    ...moves,
    { sep: true },
    { label: 'Hide from playlist', icon: 'i-close', hidden, action: () => setHidden(item, true) },
    { label: 'Show in playlist', icon: 'i-restore', hidden: !hidden, action: () => setHidden(item, false) },
  ];
  // In the pick mode the track joins the group instead, as a Feed tile does.
  if (!selection.has(item.id)) select([item.id], isMultiSelect());
  openContextMenu(x, y, item.id, selection.size,
    { mobile: true, touch, lead, rename: () => renameRow(r), track: true });
}

/** Playing and the hidden tracks over the board's menu, the one the Feed opens off a tile. */
function openSheetMenu(x: number, y: number) {
  if (drag) return;
  const listed = listedAudio();
  const el = queueEl();
  const playing = !!el && !el.paused;
  const hidden = orderedAudio().filter(isHidden);
  const lead: MenuEntry[] = [
    { label: 'Pause', icon: 'i-tl-pause', hidden: !playing, action: () => el?.pause() },
    {
      label: 'Play', icon: 'i-tl-play', hidden: playing || !listed.length,
      action: () => { if (el) el.play().catch(reportPlayError); else playTrack(listed[0]); },
    },
    {
      label: hidden.length === 1 ? 'Show the hidden track' : 'Show hidden tracks',
      icon: 'i-restore', hidden: !hidden.length, action: () => showHidden(hidden),
    },
  ];
  openContextMenu(x, y, null, selection.size,
    { mobile: true, lead: lead.filter(row => !row.hidden), track: true,
      selectAll: () => select(orderedAudio().map(it => it.id)) });
}

/** Every hidden track back in the list, in the place it keeps. */
function showHidden(items: Item[]) {
  for (const item of items) delete item.meta.playlistHidden;
  markDirty();
  renderAll();
}

/**
 * Rename, in the row. The card's own rename edits the card where it stands on
 * the canvas, which is not on screen behind a list. A track with a title tag
 * shows the tag, so the tag is what changes and the file keeps its name.
 */
function renameRow(r: Row) {
  const title = r.el.querySelector<HTMLElement>('.pl-title');
  if (!title) return;
  const item = r.item;
  const tagged = typeof item.meta?.trackTitle === 'string' && item.meta.trackTitle !== '';
  const before = title.textContent ?? '';
  const off = new AbortController();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    off.abort();
    title.contentEditable = 'false';
    r.el.classList.remove('is-renaming');
    const next = (title.textContent ?? '').trim();
    title.textContent = before;
    if (!keep || !next || next === before) return;
    if (tagged) { item.meta.trackTitle = next; markDirty(); rebuildRow(item.id); return; }
    // The row shows the name without its extension; the card keeps it.
    const ext = /\.[a-z0-9]{1,5}$/i.exec(item.name)?.[0] ?? '';
    renameItem(item.id, ext && !next.toLowerCase().endsWith(ext.toLowerCase()) ? next + ext : next);
  };
  const opts = { signal: off.signal };
  title.addEventListener('keydown', e => {
    // Enter and Space belong to the field here, not to the row's play.
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      // Android's Back arrives as Escape and asks whether anything closed.
      if (e.key === 'Escape') markClosed(e);
      finish(e.key === 'Enter');
      r.el.focus({ preventScroll: true });
    }
  }, opts);
  title.addEventListener('blur', () => finish(true), opts);
  // A press inside the field places the caret; it must not play or start a hold.
  title.addEventListener('click', e => e.stopPropagation(), opts);
  title.addEventListener('pointerdown', e => e.stopPropagation(), opts);
  r.el.classList.add('is-renaming');
  makeEditable(title);
  title.focus();
  selectContents(title);
}

function moveTrack(item: Item, to: number) {
  const ids = listedAudio().map(it => it.id).filter(id => id !== item.id);
  ids.splice(to, 0, item.id);
  setListedOrder(ids);
}

/**
 * Off the undo stack, like the order it changes (see setAudioOrder): it is how
 * the list reads, not what is on the board. Written into the track's meta, as
 * its tags are, so it travels with the card.
 */
function setHidden(item: Item, on: boolean) {
  if (on) item.meta.playlistHidden = true;
  else delete item.meta.playlistHidden;
  markDirty();
  renderAll();
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
// The Desktop panel
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
  windowContent = div('player-window-content');
  windowEl.append(head, windowContent);
  document.body.appendChild(windowEl);

  renderWindowBody();
  panelShown('playlist');
  showSheet(windowEl);
}

function renderWindowBody() {
  if (!windowEl) return;
  windowView?.destroy();
  windowView = null;
  windowContent!.replaceChildren();

  const body = div('player-window-body');
  windowView = createView(body, { reorderable: true, variant: 'window' });
  windowContent!.append(windowView.player!.el, body);

  markTransport();
  renderAll();
}

function showAlbumView() {
  setLens('playlist');
  cmds?.setBoardMode('mobile');
}

function closePlayerWindow() {
  if (!windowEl) { markTransport(); return; }
  const el = windowEl;
  windowView?.destroy();
  windowEl = null;
  windowContent = null;
  windowView = null;
  hideSheet(el);
  markTransport();
  panelHidden('playlist');
}

// Tells chrome.css the window's transport drives what is sounding, so the
// now-playing bar can step down. Not merely that the window is open: a video
// card played beside it is nothing the window can pause, and needs the bar.
function markTransport() {
  const np = nowPlaying();
  document.documentElement.classList.toggle('playlist-transport',
    !!windowEl && (!np || isQueuePlayer(np.el)));
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
    const dur = queueLength();
    if (!s || !dur) return;
    const box = line.getBoundingClientRect();
    if (!box.width) return;
    s.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * dur;
    paint();
  });

  let boundEl: HTMLMediaElement | null = null;
  let abort: AbortController | null = null;
  let frame = 0;

  function paint() {
    const s = queueEl();
    const dur = queueLength();
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
    // Paused, the wave cross-fades into a straight line (mobile.css).
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

