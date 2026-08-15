// The Playlist: the board's audio as a proper player, in two homes.
//
// One is the Mobile board's second lens - Feed | Playlist - where it fills the
// screen as the board pressed to a record: a sleeve (a mosaic of the board's own
// covers) with the disc sliding out from behind it, the board's name, a "N songs
// · M min" ledger line, a big Play / Shuffle pair, and a ruled track list you can
// drag to reorder. The other is a floating window on the Desktop board, opened
// from the sidebar - draggable and resizable, and one body only: a compact
// transport over a plain list.
//
// **The lens has no transport of its own, and that is the arrangement rather
// than an omission.** It carried one for a while - seek, prev/next, repeat and a
// volume, in a panel between the header and the list - and the panel was the
// thing on the surface that had to be scrolled past to reach the music. The bar
// at the foot of the window is already a transport, it is already up whenever
// there is anything playing, and it does not move when the list under it does.
// So the bar is the transport on the phone, the header is how a board is
// *started* (Play and Shuffle are the two things a bar cannot be), and a row is
// how a track is chosen. Three surfaces, one job each. chrome.css no longer
// hides #nowplaying under data-feed-lens for this reason.
//
// What is left on the lens is laid out on one gutter (--pl-gutter) rather than
// the three left edges it grew, and each part has a form rather than a rule
// between it and the next: the header is paper, the list is ruled. The record
// behind the sleeve is the one flourish, it is drawn only at the soft end of the
// whimsy axis, and it earns its place by saying something true - it turns while
// the board is playing.
//
// The window used to be able to wear the album view too, in miniature, which made
// the same view reachable two ways and made the window's title-bar button a switch
// between two things it held itself. It is one thing each now: the album view is
// the lens, the transport is the window, and that button switches *homes* - it
// hands the board over to the lens, which is the album view at the size it was
// drawn for. Nothing is lost but the miniature.
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
  board, bus, isDefaultTitle, markDirty, setAudioOrder, trackTitle,
} from '../state.ts';
import { clamp } from '../util.ts';
import { seekInnerHTML, sizeSeekWave } from '../media/transport.ts';
import { mobileOrder, applyAudioOrder } from '../arrange/arrangements.ts';
import { assetURL, getAsset, addFile } from '../storage/assets.ts';
import { nowPlaying, onNowPlaying, togglePlayback } from '../canvas/audio.ts';
import {
  clearQueue, cycleRepeat, isQueuePlayer, onQueue, playTrack, queueNext,
  queuePrev, queueState, setQueue, toggleShuffle,
} from '../canvas/playlist-queue.ts';
import { bindScrub, clock, PAUSE_ICON, PLAY_ICON } from '../media/transport.ts';
import { audioTags, coverArt } from '../import/artwork.ts';
import { resetPanels } from './panel-stack.ts';
import { makeWindowDrag, makeWindowResize } from './float-window.ts';
// Which Mobile lens comes up, for the title-bar button's one job. Set before the
// mode switch, the same order cmds.feed / cmds.playlist use, so entering the
// Mobile view lands on the lens that was asked for rather than on the last one.
import { setLens } from './board-view.ts';
// Nothing from the sprite: every glyph this file draws is a string constant
// below, owned here because no other surface has one. The exception used to be
// the speaker on the lens's volume row, which came through icon() so it could
// not drift from the copy the now-playing bar uses - and the row went with the
// lens's transport when the bar became the lens's transport.
import type { Item } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * `meta` is open by design (see board-model.ts), so the tags this file reads out
 * of it are narrowed here rather than trusted - the same pair ui/viewer.ts and
 * ui/feed.ts keep. A key that is not the type it should be is treated exactly as
 * a missing one, which is what every one of these reads already did by falling
 * through a `||`.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The object URL for a hash out of `meta`, or null for anything that is not one. */
const urlOf = (hash: unknown): string | null => (typeof hash === 'string' ? assetURL(hash) : null);
/** A duration out of `meta`, which the probe writes as seconds, or 0. */
const secs = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** One track's row: the element, and the item it is currently standing for. */
type Row = { el: HTMLElement; item: Item };

/** A Play + Shuffle pair, registered so its icons stay true - see makeActions(). */
type ActionGroup = {
  play: HTMLButtonElement;
  shuffle: HTMLButtonElement;
  playIco: HTMLElement;
  playLabel: HTMLElement;
  /**
   * The header these two sit in, when there is one, so the record drawn behind
   * its sleeve turns while the board is playing and stands still when it is not.
   *
   * On the group rather than on a handle of its own because refreshActions() is
   * already the one pass that knows whether anything is playing, and a second
   * fan-out over the headers would be a second thing to keep in step. The window
   * has no header, hence optional.
   */
  hero?: HTMLElement;
};

/** One track list, in either home - see createView(), which is the only builder. */
type View = {
  listEl: HTMLElement;
  reorderable: boolean;
  group: ActionGroup | null;
  /**
   * The transport above this list - the Desktop window's, and only its. The lens
   * has none and uses the now-playing bar; see the head of this file.
   */
  player: Player | null;
  fill: (audio: Item[]) => void;
  clear: () => void;
  markPlaying: () => void;
  updateMeta: (audio: Item[]) => void;
  destroy: () => void;
};

/**
 * A transport - see makePlayer(), which is the only builder and builds the one
 * there is: the Desktop window's.
 *
 * It is not `WindowPlayer` even so. Nothing in it knows about a floating window,
 * the class prefix it writes is `pw-`, and the phone reached for exactly this
 * shape once already - so a name that says where the only instance happens to
 * live is the name that would have to be undone the next time something needs a
 * transport. `players` is a set for the same reason.
 *
 * It carries no sleep switch. It had one, for a lens transport that was built
 * with the lens and never taken down and would otherwise have run a rAF a frame
 * behind the Feed; the window's is built when the window opens and dropped when
 * it closes, so it is awake for its whole life and the switch had nothing left
 * to turn off.
 */
type Player = {
  el: HTMLElement;
  bind: () => void;
  refresh: () => void;
  destroy: () => void;
};

/**
 * The reorder drag in flight. `ref` is the row the dragged one currently sits
 * before, or null for the end of the list - and `undefined` before the first
 * move, which is why the three states are spelled out.
 */
type Drag = {
  view: View;
  rowEl: HTMLElement;
  pointerId: number;
  mids: { row: Element; mid: number }[] | null;
  ref: Element | null | undefined;
};

/**
 * What this module asks of the command surface: one thing, and it is not about
 * the window. Named here rather than borrowed from commands.ts for the reason
 * FlyoutCommands states in ui/flyout.ts.
 */
export interface PlaylistCommands {
  setBoardMode: (mode: string) => unknown;
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
// The window's title-bar button wears the face of where it sends you: a grid of
// tiles for the album view. It never wears a second face, because it only ever
// goes one way - the window is not there to come back to.
const GRID_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
// The big play button's own triangle. Bounding box centred on the viewBox, then
// nudged a touch right (+1 unit) for the optical balance a right-pointing triangle
// wants in a round button. Vertices (5.25,3.5) (12.75,8) (5.25,12.5); y centres on
// 8. Pause stays the shared symmetric bars.
const PW_PLAY_ICON =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.25 3.5L12.75 8L5.25 12.5Z"/></svg>';

let mobileView: View | null = null;    // the Mobile lens
let windowEl: HTMLElement | null = null;      // the Desktop floating window, or null when closed
let windowContent: HTMLElement | null = null; // the swappable region under the window's title bar
let windowView: View | null = null;    // the list inside it
/**
 * Every transport currently built, so the events that move one move all of them.
 *
 * A set rather than the single `windowPlayer` handle it replaces, because there
 * are two homes now and both carry a real player: the Desktop window's, which
 * comes and goes with the window, and the Mobile lens's, which is built once
 * with the lens. makePlayer() adds itself and destroy() takes itself out, so
 * nothing has to remember to keep this in step - which is exactly the bookkeeping
 * that would have gone wrong first.
 *
 * onNowPlaying and onQueue already fan out to whoever is listening; this is the
 * same fan-out one level down, for the two calls those handlers make.
 */
const players = new Set<Player>();
/** Rebind every transport to whatever the queue is playing now. */
const bindPlayers = () => { for (const p of players) p.bind(); };
/** Repaint every transport's buttons, which is cheaper than a rebind. */
const refreshPlayers = () => { for (const p of players) p.refresh(); };
// The command set, for the one thing the window's title-bar button does that is
// not about the window: hand the board over to the Mobile view.
let cmds: PlaylistCommands | null = null;

/** Every visible header's Play / Shuffle pair, so play state paints in both. */
const actionGroups = new Set<ActionGroup>();
/** The shared queue element, once we have wired play/pause listeners to it. */
let wiredEl: HTMLMediaElement | null = null;
/** Aborts the previous wirePlayback() listeners so board loads do not stack them. */
let playbackAbort: AbortController | null = null;

/** Tracks whose tags/duration have been read this session, so it happens once. */
const tagged = new Set<string>();

/** The reorder drag in flight, or null. */
let drag: Drag | null = null;

export function initPlaylist(_viewport: Viewport | null, _commands: PlaylistCommands | null,
  _headerStyle: unknown) {
  cmds = _commands;
  const host = document.getElementById('mobile-playlist');
  if (host) mobileView = createView(host, { reorderable: true, variant: 'lens' });

  bus.on('board:load', () => { clearQueue(); tagged.clear(); wiredEl = null; resetPanels(); closePlayerWindow(); renderAll(); });
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
  onNowPlaying(() => { wirePlayback(); markPlaying(); refreshActions(); bindPlayers(); });
  // Every transport, not just the hero pair: a player's shuffle and repeat
  // buttons are the only readout of a mode that lives in canvas/playlist-queue.js,
  // and a press that changes nothing on screen reads as a dead button.
  onQueue(() => { refreshActions(); refreshPlayers(); });

  renderAll();
}

// ---------------------------------------------------------------------------
// The list, in both homes
// ---------------------------------------------------------------------------

/** The board's audio, in the hand-arranged order over the board arrangement. */
function orderedAudio(): Item[] {
  const audio = board.items.filter(it => it.type === 'audio');
  // The cast holds for the reason board-actions.ts states at its own call:
  // mobileOrder() hands back the very items it was given, in a new order, and
  // ArrangeItem is only the narrower shape it reads them through.
  return applyAudioOrder(
    mobileOrder(audio, { name: board.arrangement }) as Item[], board.audioOrder);
}

/**
 * Render whichever home is live and point the shared queue at the board's audio.
 *
 * Mobile: the lens, with the now-playing bar as its transport. Desktop: the
 * window, when it is open. They are never both live, so only one setQueue runs
 * and there is no fight over it. The idle home is cleared so it holds no stale
 * rows.
 */
function renderAll() {
  const audio = orderedAudio();
  // The queue is always the board's audio, whether or not a playlist home is on
  // screen: a board card plays into this same queue (canvas/audio.js), so the track
  // has to be in it to be reached, advanced past, or shuffled.
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
  // The shared <audio> outlives every board, but board:load resets wiredEl to
  // re-wire it. Drop the previous board's listeners first, or each load that
  // plays leaves another onState stacked on the one long-lived element.
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
  // Both spans are asserted because the markup they are found in was written
  // three lines up - they are this function's own, not the document's.
  const group: ActionGroup = {
    play, shuffle,
    playIco: play.querySelector<HTMLElement>('.pl-ico')!,
    playLabel: play.querySelector<HTMLElement>('.pl-label')!,
  };
  actionGroups.add(group);
  return { row, group };
}

/**
 * Build one track list, and - on the lens - the album header above it.
 *
 * The lens (variant 'lens') gets the full album hero: sleeve, name, "N songs",
 * and the big Play / Shuffle pair, and nothing else above the list. The Desktop
 * window (variant 'window') gets no hero and a transport instead - its title bar
 * and that transport are its head, and the caller mounts it, because it sits
 * above the window's body rather than inside it.
 *
 * One player between the two homes, not one each. The lens had one for a while
 * and it is the piece that came back out: on Desktop the window is a thing you
 * open *over* the board and it has to carry its own controls, while on the phone
 * the now-playing bar is already at the foot of the screen and already the
 * transport for every other surface. A second one on the lens was a panel to
 * scroll past on the way to the music.
 *
 * Which leaves the hero's Play / Shuffle pair as the only controls here, and
 * they are the right two: they are what a bar cannot be, the way to start a
 * board that is not playing anything yet.
 */
function createView(container: HTMLElement,
  { reorderable, variant }: { reorderable: boolean, variant: 'lens' | 'window' }): View {
  container.replaceChildren();
  const rows = new Map<string, Row>();   // id -> { el, item }
  const lens = variant === 'lens';

  // The lens sits on the same paper sheet the Feed does; the window drops the
  // list straight into its body, under the player.
  const surface = lens ? div('feed-sheet') : container;

  // The five the hero is made of, and they arrive together or not at all: the
  // window has no hero, so `hero` being there is what says the other four are.
  let hero: HTMLElement | null = null;
  let cover: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let metaEl: HTMLElement | null = null;
  let group: ActionGroup | null = null;
  if (lens) {
    hero = div('pl-hero');
    // The sleeve, and the record sliding out from behind it. The disc is drawn
    // entirely in the stylesheet - three radial gradients, no asset and no
    // sprite - so it takes the board's own accent, and it is drawn at the soft
    // end of the whimsy axis only, without this file knowing either fact. It
    // carries no information a screen reader wants, hence aria-hidden.
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

  // The window's transport, and only the window's - the lens plays through the
  // now-playing bar. It is mounted by the caller rather than here, because it
  // sits above the window's body and not inside it.
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
      // A transport over an empty list is five buttons that cannot do anything
      // and a scrubber for nothing. The "No music here yet" panel is the whole
      // of what the window should be saying at that point.
      if (player) player.el.hidden = audio.length === 0;
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
      // The three `!` are the test on the line above: the hero and its parts are
      // built in one run, and only the lens variant builds any of them.
      if (!hero) return;
      titleEl!.textContent = board.title;
      titleEl!.classList.toggle('is-default', isDefaultTitle(board.title));
      metaEl!.textContent = metaText(audio);
      paintCover(cover!, audio);
    },
    destroy() {
      view.clear();
      if (group) actionGroups.delete(group);
      // Before the container is emptied, and it is the load-bearing half of this:
      // a transport holds a rAF and a set of listeners on a media element that
      // outlives it, so dropping its node is not the same as taking it down.
      if (player) { player.destroy(); players.delete(player); }
      container.replaceChildren();
    },
  };
  return view;
}

/**
 * "9 songs", or "9 songs · 33 min" once the durations are known.
 *
 * A middot rather than a comma: the line is set in small caps in the header, and
 * a comma between two counts reads as one clause there where a dot reads as two
 * facts - which is what they are.
 */
function metaText(audio: Item[]) {
  const n = audio.length;
  const songs = `${n} ${n === 1 ? 'song' : 'songs'}`;
  const total = audio.reduce((s, it) => s + secs(it.meta?.duration), 0);
  if (!total) return songs;
  const mins = Math.round(total / 60);
  return mins < 1 ? songs : `${songs} · ${mins} min`;
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

/**
 * One track row: cover (or a note glyph), the title and artist, the duration,
 * and - in a reorderable list - a grip to drag it by. The row is the play
 * control; the grip, which sits over it, starts a drag instead and swallows its
 * own click so a nudge of the handle does not also start the track.
 */
function createRow(item: Item, view: View): Row {
  const el = div('pl-row');
  el.dataset.id = item.id;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const r: Row = { el, item };
  fillRow(r, view);
  el.addEventListener('click', () => playTrack(r.item));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playTrack(r.item); }
  });
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
    // No embedded art, which is the common case for a loose MP3: the tile
    // carries the track's number instead of the note glyph it used to, because
    // nine copies of one glyph down a list is a column that says nothing nine
    // times. The number is a CSS counter over .pl-row (mobile.css), so a drag
    // renumbers the list without anything here walking it.
    art.classList.add('is-placeholder');
  }
  // The equalizer, shown by CSS only on the .is-playing row.
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
  } else {
    main.classList.add('is-single');
  }

  const time = div('pl-time');
  // A duration is written as seconds by probeDuration(); anything else is read
  // as no duration at all, which is what the `!= null` test stood in for.
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

/**
 * A track's display title, and the word for one that has no title at all.
 *
 * The chain is board-model.ts's - the Feed lists the same tracks and had the
 * same four terms written out beside it, differing only in this last word. See
 * trackTitle() there for why the placeholder stayed with the surface.
 */
function trackName(item: Item) {
  return trackTitle(item) || 'Untitled';
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
function beginDrag(e: PointerEvent, view: View, r: Row) {
  if (drag) return;
  e.preventDefault();
  drag = { view, rowEl: r.el, pointerId: e.pointerId, mids: null, ref: undefined };
  r.el.classList.add('is-dragging');
  // currentTarget is the grip this listener was put on - the same reading
  // ui/hud.ts states about a target inside the element a listener is bound to.
  const grip = e.currentTarget as HTMLElement;
  grip.setPointerCapture?.(e.pointerId);
  grip.addEventListener('pointermove', onDragMove);
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
}

/**
 * Midpoints of the non-dragged rows, measured once and held until a reorder
 * reflows the list. Without the cache every pointermove read getBoundingClientRect
 * on every row; the list only actually changes shape when the dragged row lands in
 * a new gap, so that is the only thing that invalidates it.
 */
function rowMids() {
  // Asserted throughout: this is only ever reached from onDragMove(), which has
  // just tested that a drag is in flight, and nothing here can end one.
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
  // No change of gap, no DOM work - and the cached midpoints stay valid.
  if (ref === drag.ref) return;
  drag.ref = ref;
  if (ref) list.insertBefore(drag.rowEl, ref);
  else list.appendChild(drag.rowEl);
  drag.mids = null;
}

function endDrag(e: PointerEvent) {
  if (!drag) return;
  // The grip, for the reason beginDrag() gives about the same read.
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

function probeDuration(item: Item) {
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
function rebuildRow(id: string) {
  for (const view of [mobileView, windowView]) {
    if (!view) continue;
    const list = view.listEl;
    const el = list.querySelector<HTMLElement>(`.pl-row[data-id="${cssEscape(id)}"]`);
    if (!el) continue;
    // Asserted: the row is on screen because the item is in the list this pass
    // was built from, and fillRow() would read off nothing a line later if it
    // were not - so a fallback here would only move the same failure along.
    fillRow({ el, item: board.items.find(i => i.id === id)! }, view);
  }
  // A cover or a duration just arrived: the header's mosaic and "N min" want it too.
  updateMetaAll();
  markPlaying();
}

// `typeof` rather than the bare read this had: the DOM types say CSS.escape is
// always there, so testing it as a value is an error tsc will not let past -
// and asking whether it is a function is what the guard meant all along. Same
// spelling as the `typeof getComputedStyle === 'function'` guards elsewhere.
const cssEscape = (s: string) =>
  (typeof window.CSS?.escape === 'function' ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

// ---------------------------------------------------------------------------
// The Desktop floating window
// ---------------------------------------------------------------------------

/** Open the window if closed, close it if open. The sidebar's Playlist button. */
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
  // The title bar is the grab handle: drag it to move the window around the board.
  makeWindowDrag(windowEl, head);

  // One body, built once. It used to be swapped whole by a view toggle.
  windowContent = div('player-window-content');
  windowEl.append(head, windowContent);
  document.body.appendChild(windowEl);

  // A grip in the bottom-right corner to resize the window by.
  const resize = div('player-window-resize');
  resize.setAttribute('aria-hidden', 'true');
  windowEl.appendChild(resize);
  makeWindowResize(windowEl, resize);

  renderWindowBody();

  // Out of the scaled-down state and up into place, next frame - it needs two
  // computed styles to run between for the transition to take (see ui/nowplaying.js
  // raise()).
  requestAnimationFrame(() => windowEl?.classList.add('is-open'));
}

/**
 * Build the window's body: the compact transport (cover, seek, five controls) over
 * a plain list. The only body there is - see the note at the top of this file.
 *
 * Still its own function rather than a run of lines inside openPlayerWindow,
 * because it tears down what it replaces first: it is the one place that owns the
 * pair of things the window holds, and a rebuild that leaked a windowPlayer would
 * leave a dead transport bound to the shared queue.
 */
function renderWindowBody() {
  // The two `!` are the test on this line: openPlayerWindow() builds the window
  // and its content in one run, and closePlayerWindow() drops both together.
  if (!windowEl) return;
  windowView?.destroy();
  windowView = null;
  windowContent!.replaceChildren();

  const body = div('player-window-body');
  // The window's own player, held only long enough to mount it: it takes itself
  // out of `players` when the view that owns it is destroyed, so there is no
  // second handle to keep in step. That handle is what used to leak a dead
  // transport bound to the shared queue across a rebuild.
  windowView = createView(body, { reorderable: false, variant: 'window' });
  windowContent!.append(windowView.player!.el, body);

  markTransport();
  renderAll();
}

/**
 * Leave for the album view - the Mobile lens, full size, which is the album view
 * this window used to carry a miniature of.
 *
 * Nothing here closes the window: the mode switch lands on bus 'layout', and the
 * handler at the top of this file already takes it away on the way into Mobile.
 * Two roads to the same close would be two chances to disagree about it.
 */
function showAlbumView() {
  setLens('playlist');
  cmds?.setBoardMode('mobile');
}

/** The slide-out backstop, so a close that never sees transitionend still finishes. */
let windowExit = 0;

function closePlayerWindow() {
  // Before the early return, not after: if the window ever goes away by some
  // other road the flag has to be able to come off, and this is the one call
  // every road ends at.
  if (!windowEl) { markTransport(); return; }
  const el = windowEl;
  // The queue is deliberately left running - closing the player is not stopping
  // the music, any more than leaving the Mobile playlist is. The view's destroy
  // takes its transport with it, which is what puts it out of `players`.
  windowView?.destroy();
  windowEl = null;
  windowContent = null;
  windowView = null;
  // Scale it back down, then take it away once the transform has run.
  el.classList.remove('is-open');
  clearTimeout(windowExit);
  const done = () => { clearTimeout(windowExit); el.remove(); };
  el.addEventListener('transitionend', e => { if (e.propertyName === 'transform') done(); }, { once: true });
  windowExit = setTimeout(done, 500);
  markTransport();
}

/**
 * Say on <html> whether a transport is already on screen, so the now-playing bar
 * can stand down while one is.
 *
 * The bar is the transport for when you cannot see the thing making the noise.
 * With this window open in *player* mode you can see it: its play button and seek
 * line are right there, and the bar is then a second copy of a control already on
 * screen, laid over the bottom of the window showing the first.
 *
 * The window has one body now and it is that transport, so "open" and "a transport
 * is on screen" have come back into step. The name stays as it is anyway: it is
 * what chrome.css keys off, and it is still the true statement of the two. The
 * window once had a second body - the album view - which had no transport in it
 * and used the bar as one, and a flag meaning "the window is open" took the bar
 * away there and left that view with nothing to play or seek with. The lesson
 * outlived the mode: a flag that says what the stylesheet depends on survives the
 * next body being added, and a flag that says what happens to correlate with it
 * does not.
 *
 * A class on the root and nothing else, the same shape `is-connecting` and
 * `data-snap` use. It is written here rather than read from ui/nowplaying.js
 * because that module imports *this* one, and the arrow may only go one way. The
 * Mobile half needs nothing - the lens carries its own controls, and
 * `data-feed-lens` is already on the root from ui/board-view.js/syncLens().
 *
 * Written straight off the two facts it is made of, so there is no third truth to
 * keep in step.
 */
function markTransport() {
  document.documentElement.classList.toggle('playlist-transport', !!windowEl);
}

// Moving and resizing the window are in ui/float-window.js. They were written
// here and lifted out when the sticker pad turned out to want exactly the same
// two gestures - which is the argument for the move: dragging a window by its
// title bar and pulling it bigger by its corner is not a fact about music.

/**
 * A transport: the now-playing track (cover, title, artist, where it is in the
 * list), a seek line with times, and the five controls - shuffle, prev,
 * play/pause, next, repeat.
 *
 * It drives the same shared queue the list does, and binds its follow loop and
 * element listeners to whatever the queue is currently playing, rebinding on a
 * track change and letting go when the surface holding it goes away.
 *
 * No volume, and the argument is the one that has always been here: the
 * now-playing bar is up whenever there is anything to turn down, and a level is
 * a property of the room rather than of this list - so a slider in the window
 * would mean opening a window to quiet a noise. The lens was the one case that
 * argument did not cover, because the bar was hidden there; the bar is not
 * hidden there any more, and the row went with the lens's transport.
 */
function makePlayer(): Player {
  const el = div('pw-player');

  const top = div('pw-top');
  const cover = div('pw-cover is-placeholder');
  cover.innerHTML = DISC_ICON;
  const info = div('pw-info');
  const title = div('pw-title');
  title.textContent = 'Nothing playing';
  const artist = div('pw-artist');
  // "4 of 12", counted down the list you can see rather than along the play
  // order - see QueueSnapshot.index, which does the mapping. Deliberately not an
  // "up next": under shuffle the next track is not the row below, and printing
  // it only raises the question of why.
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
  // The same shape the now-playing bar and the video card draw - a base line, a
  // clipped fill, and the fill carrying both a straight line and a wave, of which
  // the stylesheet shows one per whimsy tier. It was a div scaled on X, which is
  // the one thing a wave cannot be: scaling a wave horizontally changes its
  // frequency as the track plays. See the note in media/transport.js.
  line.innerHTML = seekInnerHTML('pw-line');
  const waveSvg = line.querySelector('.pw-line-wave-svg');
  const wavePathEl = line.querySelector('.pw-line-fill-wave');
  const sizeWave = () => sizeSeekWave(line, waveSvg, wavePathEl);
  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWave).observe(line);
  const total = document.createElement('span');
  total.className = 'pw-time'; total.textContent = '0:00';
  seek.append(elapsed, line, total);

  const controls = div('pw-controls');
  const shuffleBtn = pwBtn('pw-shuffle', SHUFFLE_ICON, 'Shuffle', toggleShuffle);
  const prevBtn = pwBtn('pw-prev', PREV_ICON, 'Previous', queuePrev);
  const playBtn = pwBtn('pw-play', PW_PLAY_ICON, 'Play', () => {
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
    // Paused, which the scrubber needs and nothing else here does: at the soft
    // end of the whimsy axis the seek line is a travelling wave, and it flattens
    // to a straight line when the sound stops. The now-playing bar has said this
    // with the same class since it was drawn (see chrome.css) - this transport
    // was given the same three-svg line and never the flag, so its wave stood
    // there rippling over a paused track. On the player rather than on the line
    // because what is paused is the player.
    el.classList.toggle('is-paused', !playing);
    // Both `.pw-ico` spans are asserted: pwBtn() is what built the button, and
    // the glyph span is the whole of what it put inside one.
    playBtn.querySelector('.pw-ico')!.innerHTML = playing ? PAUSE_ICON : PW_PLAY_ICON;
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const { shuffle, repeat, index, length } = queueState();
    shuffleBtn.classList.toggle('is-on', shuffle);
    repeatBtn.classList.toggle('is-on', repeat !== 'off');
    repeatBtn.querySelector('.pw-ico')!.innerHTML = repeat === 'one' ? REPEAT_ONE_ICON : REPEAT_ICON;
    repeatBtn.setAttribute('aria-label',
      repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat');
    // Where in the list, and the two ends.
    //
    // The ends are only ends when the list is being read straight through:
    // shuffling has no last track to speak of, and repeat 'all' means the list
    // has no end at all. So the greying is gated on both, and in either of those
    // modes both buttons stay live and wrap - which is what queuePrev/queueNext
    // do when they are pressed rather than reached by a track finishing.
    //
    // With repeat off and no shuffle, disabling is not a lie about the button,
    // it *is* the behaviour: pressing Next at the end of a list you asked not to
    // repeat should do nothing, rather than quietly starting it again.
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
      // `img.asset` is asserted because the find() that answered it tested the
      // hash - a picture with no asset is not one of the items it looked for.
      if (!src) { const img = board.items.find(it => it.type === 'image' && it.asset?.hash); if (img) src = assetURL(img.asset!.hash); }
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

/** One round transport button for the window player, its glyph in a swappable span. */
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

function div(className: string) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
