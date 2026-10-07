// The Feed: Mobile board as a masonry wall of every item. Absolute-positioned
// tiles, shortest-column-first (CSS columns break reading order, Grid masonry
// is not in the browser floor). Videos outside #world manage their own release.
// Injected deps (viewport, commands, masthead) — no document reach at import.

import {
  board, bus, isDefaultTitle, byId, itemAdjust, itemCrop, itemRotate, itemMatte,
  flipTransform, stuckTo, isRider, noteDisplay,
  select, selection, deselect, clearSelection, isMultiSelect, trackTitle, isFence, mobileRuns,
  timelinePlaying,
} from '../state.ts';
import { noteWords } from '../canvas/note-model.ts';
import { bakeDisplayFor } from '../optimize/picture.ts';
import {
  displayURLReady, ensureDisplay, bakedServes, type Crop, type Turn, type Matte,
} from '../canvas/display.ts';
import { baseName, clamp, div, actAsButton, readToken } from '../util.ts';
import { mobileOrder } from '../arrange/arrangements.ts';
// Shortest-column-first, shared with the board's own masonry - see the head of
// that file for why the two walls are one rule and two surfaces.
import { packColumns } from '../arrange/columns.ts';
import { assetURL, readText } from '../storage/assets.ts';
import { linkURL, buildContent, swatchHex, MARKDOWN, enrichEmbedCard, linkGlyph, fitMode } from '../canvas/renderers.ts';
import { openExternal } from './leaving.ts';
import { embedFor, frameFor, offerButton } from '../canvas/embed.ts';
import type { EmbedSpec } from '../canvas/embed.ts';
import { kindName } from '../canvas/item-dom.ts';
import { bindDial, hintKey } from '../canvas/ghosts.ts';
import { noteTint } from '../canvas/note-model.ts';
import {
  registerPlayer, releasePlayers, nowPlaying, onNowPlaying,
} from '../canvas/audio.ts';
import { playTrack } from '../canvas/playlist-queue.ts';
import { clock, PLAY_ICON } from '../media/transport.ts';
import {
  stickerArt, stickerShape, DEFAULT_SHAPE,
} from '../stickers/catalogue.ts';
import { armedSticker, disarm } from './sticker-window.ts';
import { openViewer, canView } from './viewer.ts';
import { openPanel as openHeaderPanel } from './mobile-header.ts';
import { unpackItem } from '../import/unpack.ts';
import { retryPicture } from '../import/drop.ts';
import { dealSong } from './clean/clean.ts';
import { renderMarkdown } from './markdown.ts';
import { shownHash, type Item } from '../board-model.ts';
import type { Point } from '../geometry.ts';
import { baseMs, fastMs, reducedMotion } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * `meta` is open by design (see board-model.ts), so everything read out of it
 * here is narrowed rather than trusted - the same pair ui/viewer.ts and
 * ui/nowplaying.ts keep. A key of the wrong type is treated as missing.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The object URL for a hash out of `meta`, or null for anything that is not one. */
const urlOf = (hash: unknown): string | null => (typeof hash === 'string' ? assetURL(hash) : null);
const bakedHash = (item: Item): string => (typeof item.meta?.display === 'string' ? item.meta.display : '');

/** Which shape a tile is drawn as, and which filler builds it - see kindOf(). */
type TileKind =
  | 'image' | 'video' | 'audio' | 'note' | 'link' | 'swatch' | 'text' | 'hint' | 'file' | 'card'
  | 'fence';

/**
 * One tile on the wall. `video` is the whole of this module's release
 * discipline: the mounted <video> for a playing clip, null for a poster. See
 * mountVideo() and cullWindow().
 */
type Tile = {
  el: HTMLElement;
  item: Item;
  ratio: number;
  kind: TileKind;
  video: HTMLVideoElement | null;
  /**
   * How much of the wall's width this tile takes, as a fraction in (0, 1].
   * One for everything except a hint.
   *
   * A fraction, not a column count - the column count isn't known when a
   * tile is built (it comes from the window width in layout()), and a
   * fraction is what was actually meant: the dial took the whole board, each
   * sentence took half. onboarding.ts writes it into `meta.span`; fillHint()
   * reads it. Carries forward the old mobile board's per-column sizing that
   * a naive "pack every tile into one column" would otherwise lose.
   */
  span: number;
  /**
   * A height in pixels this tile insists on, measured from its own content
   * rather than computed from `ratio`.
   *
   * Only hints have one. Every other tile is a picture/poster/plate, for
   * which a shape is the right thing to lay out by - they crop or letterbox,
   * with no last line that can fall off the bottom. A hint does, so it's
   * measured after building and the packer given the answer - why layout()
   * runs the masonry twice.
   */
  measured: number;
  /**
   * The player a link tile can become, or null for a link that is only a link
   * and every non-link tile. Set once at build (linkEmbed) so spanFor, the
   * embed sizing pass and fillLink all read the same answer without re-parsing
   * the URL. Nothing loads from it until a tap - mountEmbed is the only thing
   * that puts the frame in, and only then (see canvas/embed.ts on the promise).
   */
  embed: EmbedSpec | null;
};

/** A tile's placed box, in the grid's own coordinates. */
type Box = { x: number; y: number; w: number; h: number };

/**
 * One item's place on the wall, computed for *every* item whether or not a tile
 * is mounted for it - the scrollbar and the window both need the whole layout,
 * which is the point of windowing: a size for all, a DOM node for a screenful.
 * A Slot carries the sizing inputs (kind, ratio, span, embed, and a measured
 * height for hints) and the box packSlots() writes back into it.
 */
type Slot = {
  item: Item;
  kind: TileKind;
  embed: EmbedSpec | null;
  ratio: number;
  span: number;
  measured: number;
  box: Box;
};

/** What spanFor() and packSlots() read - satisfied by both Tile and Slot. */
type Sizable = Pick<Slot, 'kind' | 'span' | 'embed'>;

/**
 * What the Feed asks of the command surface, and nothing else. Named here
 * rather than borrowed from commands.ts, same reason FlyoutCommands states
 * in ui/flyout.ts - why `cmds` is handed in by initFeed(), not imported.
 */
export interface FeedCommands {
  addStickerAt: (shape: string, at: Point) => void;
  contextMenu: (x: number, y: number, id: string | null, count: number,
    opts?: { mobile?: boolean, touch?: boolean, selectAll?: () => void }) => void;
  /** Turn the multi-select mode on with this tile added - a hold on a second tile. */
  holdToPick?: (id: string) => void;
}

/**
 * The types the Feed does not draw as tiles: furniture and stickers.
 *
 * Hint cards used to be on this list and shouldn't have been - they're the
 * whole of what a fresh board offers, and hiding them left the board that
 * most needs them showing "Nothing to show yet" instead of what to do about
 * it. Drawn as tiles now, through the same buildContent() the canvas uses.
 *
 * A sticker is here for a different reason: a *pinned* one is drawn on its
 * host's tile at the fraction of the host it holds on the canvas, so the
 * board you made is the board you see - it just gets no tile of its own,
 * since a wall panel holding one star helps nobody. A *loose* sticker has no
 * host tile and is not drawn at all - the one place this view knowingly
 * isn't the board (see research/old/stickers-2026-08-12.md); not drawing it
 * is the safer read than a lone floating panel.
 */
const HIDDEN = new Set(['title', 'fence', 'sticker']);

/**
 * The one hint the Feed leaves out: "A surface for thinking", whose rows are
 * the canvas's gestures - pan, zoom, shift-drag - and none of which a
 * scrolling wall answers to. Resolved through hintKey(), as the renderer
 * does, so a hint with no key, which draws as this one, goes with it.
 */
const canvasOnly = (it: Item) => it.type === 'ghost'
  && hintKey(typeof it.meta?.hint === 'string' ? it.meta.hint : undefined) === 'drop';

// All seven are null until initFeed() has run and stay null on a page with no
// #mobile-feed in it, which is why every reader below tests one rather than
// asserting it - this module is built to be absent.
let root: HTMLElement | null = null;        // #mobile-feed, the scroller
let sheet: HTMLElement | null = null;       // the centred column the wall sits in
let mastheadEl: HTMLElement | null = null;  // the board's title page across the top
let titleEl: HTMLElement | null = null;
let gridEl: HTMLElement | null = null;      // the positioning context for the absolute tiles
let empty: HTMLElement | null = null;       // the "nothing to show" plate
/** styleFeedMasthead, injected from main.ts. */
let styleHeader: ((title: HTMLElement | null, box: Element | null) => void) | null = null;
let cmds: FeedCommands | null = null;       // the command surface, for the armed-sticker tap
/** The pointer that pressed last, so a tile menu a finger opened offers "Select multiple". */
let pressType = '';

/** id -> Tile, but only for the tiles inside the window - see cullWindow(). */
const tiles = new Map<string, Tile>();

/** Every item's place on the wall, in feed order, rebuilt by layout(). The
 *  window is scanned over this, so it holds items with no mounted tile. */
let slots: Slot[] = [];
let slotById = new Map<string, Slot>();

/** Host id -> the notes stuck on it, bottom first. These ride the host's tile
 *  and take no slot of their own - see riderHost(). Rebuilt by layout(). */
let riders = new Map<string, Item[]>();
/** The hosts whose notes are laid open over their tile. Kept across culls, so
 *  a tile scrolled away and back comes back as it was left. */
const notesOpen = new Set<string>();
/** Bumped by layout(), so paintRiders() redraws notes whose words may have changed. */
let riderPass = 0;
const riderDrawn = new WeakMap<HTMLElement, string>();

let cols = 2;
/** The grid's width at the last layout, so a resize can be told from a reflow. */
let gridWidth = 0;
/** Each tile's running reflow slide, so a second reflow starts from where it is drawn. */
const slides = new WeakMap<HTMLElement, Animation>();
let mastheadRaf = 0;
let layoutRaf = 0;
let cullRaf = 0;
let resizeObs: ResizeObserver | null = null;
let mastheadObs: IntersectionObserver | null = null;

// The hold that opens a tile's menu on touch. See the listeners in initFeed().
const HOLD_MS = 500;
const HOLD_SLOP = 10;
let holdTimer = 0;
let holdFrom: { x: number; y: number; id: string | null } | null = null;
let heldOpen = false;

function cancelHold() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  holdFrom = null;
}

/** The item a press landed on, or null for the sheet between the tiles. */
function tileIdAt(target: EventTarget | null) {
  // SAFETY: the listener is on an element, so a press inside it lands on one
  // too, and closest() is only being asked whether an ancestor matches.
  // A stuck note laid open over its host answers first: its menu is the note's.
  return (target as HTMLElement | null)?.closest?.<HTMLElement>('.feed-rider, .feed-tile')?.dataset.id || null;
}

/** The tile a pick lands on, or null. A hint tile is the board's help and not
 *  one of its cards, so it is never picked. */
function pickableAt(target: EventTarget | null) {
  const tile = target instanceof Element ? target.closest<HTMLElement>('.feed-tile') : null;
  return tile && tile.dataset.kind !== 'hint' ? tile.dataset.id || null : null;
}

/** The ring on each selected tile. Only the mounted tiles: a tile built later
 *  reads the selection in buildTile(). */
function paintSelection() {
  for (const [id, t] of tiles) t.el.classList.toggle('is-selected', selection.has(id));
}

const TILE_TARGET = 210;   // the width a column aims for; more screen, more columns
const MAX_COLS = 5;
const GAP = 10;

export function initFeed(_viewport: Viewport | null, _commands: FeedCommands | null,
  headerStyle: ((title: HTMLElement | null, box: Element | null) => void) | null) {
  styleHeader = typeof headerStyle === 'function' ? headerStyle : null;
  cmds = _commands;
  root = document.getElementById('mobile-feed');
  if (!root) return;

  sheet = div('feed-sheet');
  root.appendChild(sheet);

  mastheadEl = div('feed-masthead');
  titleEl = document.createElement('h2');
  titleEl.className = 'feed-title';
  // A press on the name opens the masthead editor, as the pen button does
  // (research/old/done-2026-09-15.md, R16).
  actAsButton(titleEl, openHeaderPanel);
  titleEl.setAttribute('aria-controls', 'header-panel');
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

  // Tap-to-place. Capture, on the scroller not each tile: tiles rebuild on
  // every board change, so a per-tile listener would rewire forty times for
  // a gesture that fires once. Capture so an armed tap can't also open a
  // link or start a track.
  root.addEventListener('pointerdown', e => {
    if (!armedSticker() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Asserted: the line above returned unless there was one, and nothing
    // between the two can disarm it.
    const shape = armedSticker()!.shape;
    const at = feedPointToWorld(e.clientX, e.clientY);
    disarm();
    // A tap missing every tile disarms instead of placing: a loose sticker
    // has nowhere to go in the feed (see HIDDEN), so placing it would make
    // something nobody could then see.
    if (at) cmds?.addStickerAt(shape, at);
  }, true);

  /**
   * The tile's menu, aimed at the tile.
   *
   * The retarget is the whole of it, and it was missing: every selection-wide
   * row this menu draws (Delete item, Copy, Tags, a tour stop, Anchor) acts on
   * the *canvas* selection, which nothing in the Feed had set - select a card
   * on the canvas, switch to Feed, long-press a different tile, tap Delete
   * item, and the card selected on the canvas died while the one under your
   * thumb stayed.
   *
   * Same call openMenuAt() makes in canvas/input.ts, same rule every file
   * manager follows: opening outside the selection retargets it, opening
   * inside leaves the group. Not a second selection model - the Feed shows
   * the board's items; the board's selection is what "this one" means. In the
   * multi-select mode the tile joins the group instead, as on the canvas.
   */
  function openTileMenu(x: number, y: number, id: string) {
    // Its rows edit, and the board is read-only while the Timeline plays.
    if (timelinePlaying()) return;
    if (!selection.has(id)) select([id], isMultiSelect());
    cmds?.contextMenu(x, y, id, selection.size, { mobile: true, touch: pressType === 'touch' });
  }

  /** Off every tile, the board's own menu, as the canvas opens on bare ground. */
  function openSheetMenu(x: number, y: number) {
    if (timelinePlaying()) return;
    // Select all takes the tiles the wall shows, never the title or a sticker.
    const shown = () => slots.filter(s => s.kind !== 'hint' && s.kind !== 'fence').map(s => s.item.id);
    cmds?.contextMenu(x, y, null, selection.size, { mobile: true, selectAll: () => select(shown()) });
  }

  // The right-click slot, which the Feed did not own.
  //
  // The canvas's one contextmenu listener is bound to #viewport
  // (canvas/input.ts). #mobile-feed is a fixed scroller at z-index 2 that
  // covers it entirely, so a press here never reached it and the browser's
  // own menu opened instead - on the surface that on a phone *is* the board.
  // Same for the long-press timer, which lives in #viewport's pointer
  // pipeline and never sees a tile.
  //
  // Its own pair of listeners, not an extension of that pipeline: input.ts is
  // one pipeline with exactly one active gesture and must not be split
  // (CLAUDE.md). This is a hold timer beside the sticker drag's own slop
  // check, the same shape of decision in the same file.
  root.addEventListener('contextmenu', e => {
    const id = tileIdAt(e.target);
    e.preventDefault();
    cancelHold();
    if (heldOpen) return;
    // The engines whose long press arrives as this event, before the timer.
    if (id && pressType === 'touch' && selection.size && !selection.has(id) && !isMultiSelect() && cmds?.holdToPick) {
      heldOpen = true;
      cmds.holdToPick(id);
    } else if (id) openTileMenu(e.clientX, e.clientY, id);
    else openSheetMenu(e.clientX, e.clientY);
  });
  root.addEventListener('pointerdown', e => {
    // Touch only. A mouse has the button above, and a pen reports its own
    // contextmenu on a barrel press; arming a timer for either would open the
    // menu twice or open it on a drag that was going to scroll.
    if (e.pointerType !== 'touch') return;
    // Spend the suppression here, not only in the click that was supposed to
    // consume it - a long press doesn't always synthesize one (iOS fires
    // none at all), so a flag cleared only by a click could outlive its press
    // and swallow the *next* tap. The click this eats belongs to the press
    // that opened the menu, so clearing it on the following press is bounded.
    heldOpen = false;
    cancelHold();
    holdFrom = { x: e.clientX, y: e.clientY, id: tileIdAt(e.target) };
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      if (!holdFrom) return;
      // Suppress the tap that would otherwise follow: the tile's own click
      // handler opens the viewer, and a hold shouldn't open both a menu and an item.
      heldOpen = true;
      const { x, y, id } = holdFrom;
      // A hold on a second tile while one is picked builds a group, as on the
      // canvas (openMenuAt() in canvas/input.ts): the mode, with this tile in it.
      if (id && selection.size && !selection.has(id) && !isMultiSelect() && cmds?.holdToPick) cmds.holdToPick(id);
      else if (id) openTileMenu(x, y, id);
      else openSheetMenu(x, y);
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
  // Picking a tile rather than opening it: a click with Shift, Ctrl or Cmd
  // held, or any tap while the multi-select mode is on ("Select multiple" in a
  // tile's menu). The tile joins or leaves the board's selection - the one the
  // tile menu and Delete act on - and nothing else the tap would do happens.
  // Capture, and stopImmediatePropagation, so neither the tile nor the Unzip
  // button below sees the press.
  root.addEventListener('click', e => {
    if (e.defaultPrevented) return;
    if (!(e.shiftKey || e.ctrlKey || e.metaKey || isMultiSelect())) return;
    const id = pickableAt(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!deselect(id)) select([id], true);
  }, true);
  // A press on the sheet between the tiles puts the selection down, as a press
  // on bare board does on the canvas. The multi-select mode keeps its group.
  root.addEventListener('click', e => {
    if (e.defaultPrevented || isMultiSelect()) return;
    const at = e.target instanceof Element ? e.target : null;
    if (!at || at.closest('.feed-tile, .feed-masthead, button, a, input')) return;
    clearSelection();
  });
  // Every press, whatever made it. Capture, so the tile menu's hold reads it.
  root.addEventListener('pointerdown', e => { pressType = e.pointerType; },
    { capture: true, passive: true });
  // Unzip and Open on an archive or folder tile, Retry on a picture that came
  // in as a named card, and the song on a Spotless one. Capture too, so the
  // tile's own tap - open the viewer - never sees a press meant for the button.
  root.addEventListener('click', e => {
    const button = e.target instanceof Element ? e.target.closest('.card-unpack, .card-retry, .spotless-song') : null;
    const id = button && tileIdAt(button);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (button.classList.contains('spotless-song')) void dealSong(id);
    else if (button.classList.contains('card-retry')) void retryPicture(id);
    else void unpackItem(id);
  }, true);

  bus.on('board:load', () => { seenRatio.clear(); teardown(); render(); });
  bus.on('layout', () => (board.layoutMode === 'mobile' ? render() : teardown()));
  bus.on('lens', () => { if (board.layoutMode === 'mobile') { render(); scheduleLayout(); } });
  bus.on('items', render);
  bus.on('geom', scheduleLayout);
  bus.on('board', paintMasthead);
  bus.on('fonts', paintMasthead);
  bus.on('selection', paintSelection);
  // A per-item change arrives as 'item', the same as on the canvas
  // (canvas/items.ts). A crop or a turn changes a picture's shape (ratioOf()),
  // so the wall may move as well.
  bus.on('item', id => {
    const t = tiles.get(id);
    if (t) writeTileFit(t);
    // A note's sheet, which its menu can now change after the fact.
    const sheet = t?.kind === 'note' ? t.el.querySelector<HTMLElement>('.feed-note') : null;
    if (sheet) { sheet.style.background = ''; paintNoteSheet(sheet, t!.item); }
    relayoutIfReshaped(id);
  });
  bus.on('settings', key => {
    if (key === 'arrangement' || key === 'profile') render();
    else if (key === 'mobileHeader' || key === 'appearance') paintMasthead();
  });
  onNowPlaying(markPlaying);

  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(scheduleLayout);
    resizeObs.observe(root);
  }

  // Is the title page on screen? The pen top-right edits *that page* and
  // nothing else, so it has no business riding a wall of photographs a
  // thousand pixels below. Used to be gated on the world-space board being at
  // its top stop; the Feed replaced that board and the gate went with it.
  //
  // An observer rather than a line in scroll, the same latch ui/mobile-header.ts
  // uses: the answer changes exactly twice in a scroll, so asking every frame
  // just to re-arrive at the same state is a cost every view listener here
  // avoids.
  //
  // Announced, not acted on - the button belongs to ui/mobile-header.ts, which
  // this module does not import, the same bargain initFeed() makes with the
  // viewport and command set.
  if (typeof IntersectionObserver === 'function') {
    mastheadObs = new IntersectionObserver(
      entries => {
        const last = entries[entries.length - 1];
        if (last) bus.emit('feed:masthead', last.isIntersecting);
      },
      { root },
    );
    mastheadObs.observe(mastheadEl);

    // The near-viewport gate for display-copy generation. Rooted on the
    // scroller, with a margin so the copy is in flight before the tile arrives.
    copyObs = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const job = copyJobs.get(e.target);
        copyJobs.delete(e.target);
        copyObs!.unobserve(e.target);
        job?.();
      }
    }, { root, rootMargin: '600px 0px' });
  }
  addEventListener('resize', paintMasthead);
  // Scroll moves the window, so it re-culls (rAF-throttled) - mounting the tiles
  // that entered and dropping the ones that left. This is also what releases a
  // scrolled-past clip's decoder, since a dropped video tile takes its <video>.
  root.addEventListener('scroll', scheduleCull, { passive: true });
  document.fonts?.ready?.then(paintMasthead).catch(() => {});

  render();
}

// ---------------------------------------------------------------------------
// Building the wall
// ---------------------------------------------------------------------------

/**
 * Everything the Feed shows, in the board's arrangement order, cut into runs:
 * each fence's cards together under its name, between runs of loose cards
 * (research/old/done-2026-09-15.md, R14). The runs are fences.ts's, the
 * same the Mobile layout packs, so one rule says where a fence goes. A fence
 * ranks where its earliest card does, which is why the fences join the order
 * last: their own place in it would otherwise win. A fence with no card to
 * show has no run. Fencing is the canvas's: nothing here writes membership.
 */
function feedRuns(ridden: Set<string>): { band: Item | null, items: Item[] }[] {
  // SAFETY: mobileOrder() hands back the very items it was given, in a new
  // order - ArrangeItem is only the narrower shape it reads them through.
  const shown = mobileOrder(
    board.items.filter(it => !HIDDEN.has(it.type) && !canvasOnly(it) && !ridden.has(it.id)),
    { name: board.arrangement }) as Item[];
  const fences = board.items.filter(isFence);
  if (!fences.length) return [{ band: null, items: shown }];
  return mobileRuns([...shown, ...fences]).filter(run => run.items.length);
}

/**
 * The board changed. Off Mobile this tears down and the CSS shows the canvas;
 * on Mobile it re-lays-out, which is where tiles are built and dropped now -
 * layout() sizes every item and cullWindow() mounts only the screenful near the
 * viewport, so a board of hundreds is a wall of a dozen live nodes.
 */
function render() {
  // The `!` inside follows from the `root` test: initFeed() builds all six
  // nodes together or none, so a live root means a live wall.
  if (!root || board.layoutMode !== 'mobile') { teardown(); return; }
  paintMasthead();
  scheduleLayout();
}

/** Kind buckets, which decide the tile shape and how it is filled. */
function kindOf(item: Item): TileKind {
  if (item.type === 'fence') return 'fence';
  if (item.type === 'image') return 'image';
  if (item.type === 'video') return 'video';
  if (item.type === 'audio') return 'audio';
  if (item.type === 'note') return 'note';
  if (item.type === 'link') return 'link';
  if (item.type === 'swatch') return 'swatch';
  // A text file shows its words here, as on the canvas - used to fall
  // through to the file card below and show a filename over the literal
  // word "text", on the one item type whose whole value is its contents.
  // classify() routes some fifty extensions to this - most notes, code and
  // prose anybody drops on a board.
  if (item.type === 'text') return 'text';
  if (item.type === 'ghost') return 'hint';
  // The canvas card itself, drawn by the canvas's renderer (fillCard()). These
  // used to fall to a picture or to the name-and-kind file card, so a style
  // tile lost its palette and its faces, a font its specimen, and a model or a
  // plain file the card it wears on the board.
  if (CARD_TYPES.has(item.type)) return 'card';
  return pictureURL(item) ? 'image' : 'file';
}

/** The types the Feed draws with the canvas's own renderer. See kindOf(). */
const CARD_TYPES = new Set(['style-tile', 'font', 'model', 'generic', 'gone', 'archive', 'folder', 'card']);

/**
 * The player a link becomes, or null. The same door the canvas card uses
 * (embedFor over the validated URL), so a link is a YouTube or Spotify player
 * on both surfaces or on neither - one place decides what is embeddable.
 */
function linkEmbed(item: Item): EmbedSpec | null {
  if (item.type !== 'link') return null;
  return embedFor(linkURL(item.meta?.url));
}

/** The aspect (w/h) a tile is drawn at, clamped so nothing dominates a column. */
function ratioOf(item: Item) {
  const kind = kindOf(item);
  if (kind === 'link') return 2.6;
  if (kind === 'swatch') return 1;
  if (kind === 'audio') return 1;
  if (kind === 'file') return 1.4;
  // The card's own proportion, so the scaled card fills the tile. Clamped
  // wider than the rest: a card is drawn whole, not cover-cropped.
  if (kind === 'card') return clamp(item.w / Math.max(1, item.h), 0.4, 2.5);
  // A hint keeps the shape it was seeded at - ensureGhostCards() sizes these
  // against the column on Mobile (the dial takes the full width, the three
  // hints half), so the item's own box is already the right proportion and
  // the clamp below would only fight it.
  if (kind === 'hint') return clamp(item.w / Math.max(1, item.h), 0.5, 3);
  // Taller than wide, because a page of words is a page. The canvas card is
  // 300x360 and this is the same proportion; anything squarer shows four lines
  // and a lot of paper.
  if (kind === 'text') return 0.75;
  const r = item.w > 0 && item.h > 0 ? item.w / item.h : 1;
  // A picture takes its own shape once a load has shown it, as its card does
  // on the board (canvas/picture-shape.ts): the Feed has no grid to fit it to.
  // Clamped far wider than the rest: a panorama at 4:1 is still a strip a
  // finger can press.
  if (kind === 'image' || kind === 'video') return clamp(seenRatio.get(item.id) || r, 0.25, 4);
  return clamp(r, 0.5, 2);
}

/**
 * The shape of each item's picture, by id, read off the picture as it loads
 * (research/old/done-2026-09-15.md, R9). The item's own box is only a
 * guess at it: a card resized on the board keeps its new shape, and a Fit
 * tile drawn at that shape letterboxes. Kept for the board, so a tile that
 * comes back into the window is laid out right the first time.
 */
const seenRatio = new Map<string, number>();

/** Note the shape a tile's picture loaded at. */
function learnRatio(t: Tile, img: HTMLImageElement) {
  if (!img.naturalWidth || !img.naturalHeight) return;
  seenRatio.set(t.item.id, img.naturalWidth / img.naturalHeight);
  relayoutIfReshaped(t.item.id);
}

/** Lay the wall out again if an item now wants another shape than its slot has. */
function relayoutIfReshaped(id: string) {
  const s = slotById.get(id);
  if (s && Math.abs(ratioOf(s.item) - s.ratio) > 0.005) scheduleLayout();
}

/**
 * The derived stand-in alone, for a tile whose first choice would not load.
 *
 * Deliberately not pictureURL(): that starts with the preview, which is the
 * thing that has just failed, so it would hand back the source that just
 * refused. These are all pictures made by some other path, so whatever
 * stopped the first is unlikely to have touched them.
 */
function spareURL(item: Item) {
  const m = item.meta || {};
  const hash = str(m.thumb) || str(m.cover) || str(m.poster) || str(m.shot);
  return hash ? assetURL(hash) : null;
}

/**
 * The small preview for the blur-up stage: the 100px thumb first, then an
 * embedded preview, cover, poster or shot - but never the full-size asset. That
 * asset is the original a phone cannot afford to decode for a tile, which is the
 * whole reason a photo shows a soft thumb first and the card-sized copy after.
 */
function lowResURL(item: Item) {
  const m = item.meta || {};
  const hash = str(m.thumb) || str(m.preview) || str(m.cover) || str(m.poster) || str(m.shot);
  return hash ? assetURL(hash) : null;
}

/** A raster URL for anything that has one - a preview, a thumb, a poster, a cover, a shot. */
function pictureURL(item: Item) {
  const m = item.meta || {};
  const hash = str(m.preview) || str(m.thumb) || str(m.cover) || str(m.poster) || str(m.shot)
    || (item.type === 'image' || item.type === 'video' ? item.asset?.hash : null);
  return hash ? assetURL(hash) : null;
}

function buildTile(item: Item): Tile {
  const kind = kindOf(item);
  // A fence's band is not a tile: no press, no menu and no sticker lands on
  // it, and every one of those looks for `.feed-tile`.
  const el = div(kind === 'fence' ? 'feed-band' : 'feed-tile');
  el.dataset.kind = kind;
  el.dataset.id = item.id;
  if (selection.has(item.id)) el.classList.add('is-selected');
  const t: Tile = {
    el, item, ratio: ratioOf(item), kind, video: null,
    // Both are hints' business, both settled by fillHint() inside fillTile():
    // span from the item's own seeded fraction, height from measuring what it
    // built. Everything else keeps the defaults, laid out by its shape.
    span: 1, measured: 0,
    embed: linkEmbed(item),
  };
  fillTile(t);
  wireOpen(t);
  return t;
}

/**
 * A tap opens the item, for the kinds that have nothing else to do with one.
 *
 * The Feed already had four tap meanings, left alone: a link goes to its
 * address, audio hands off to the Playlist, video mounts and plays, and
 * everything else did nothing. This is for that last group - a picture,
 * text file, note, named file - where the only reasonable tap is "let me see
 * that properly", which had nowhere to go before the viewer existed.
 *
 * Video is deliberately excluded even though viewable: on the wall a tap
 * plays it in place, the better answer for a clip being scrolled past. The
 * viewer is where the right-click menu sends it.
 */
function wireOpen(t: Tile) {
  if (!OPENS.has(t.kind) || !canView(t.item.id)) return;
  actAsButton(t.el, () => openViewer(t.item.id, { thumb: t.el.getBoundingClientRect() }));
}

/** The tile kinds whose tap means "open this". See wireOpen(). */
const OPENS = new Set(['image', 'text', 'note', 'file', 'card']);

function fillTile(t: Tile) {
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
  if (kind === 'card') return fillCard(t);
  if (kind === 'fence') return fillBand(t);
  return fillFile(t);
}

/** A fence's name across the wall, over the cards it holds. */
function fillBand(t: Tile) {
  const name = div('feed-band-name');
  name.textContent = (t.item.name || '').trim() || 'Fence';
  t.el.appendChild(name);
}

/**
 * A card drawn by the canvas's renderer (buildContent()), at the size it has
 * on the board, then scaled to the tile: the same card, not a second drawing
 * of it that could drift. One observer for the wall writes the scale as each
 * tile's width settles. dropTile() unobserves.
 */
let cardObs: ResizeObserver | null = null;

function fillCard(t: Tile) {
  const host = div('feed-card');
  // Written by canvas/items.ts on #world, which this surface does not have.
  host.style.setProperty('--iz', '1');
  host.style.width = `${Math.max(1, t.item.w)}px`;
  host.style.height = `${Math.max(1, t.item.h)}px`;
  host.append(buildContent(t.item));
  t.el.appendChild(host);
  cardObs ??= new ResizeObserver(entries => {
    for (const entry of entries) {
      const tile = entry.target;
      const card = tile.firstElementChild;
      const w = card instanceof HTMLElement ? parseFloat(card.style.width) : 0;
      if (card instanceof HTMLElement && w) card.style.setProperty('--feed-s', String(tile.clientWidth / w));
    }
  });
  cardObs.observe(t.el);
}

/**
 * A hint card, drawn by the canvas's own renderer (buildContent()), not a
 * second hint card for this surface - one place knows what a hint says and
 * how the whimsy dial is laid on it (canvas/renderers.ts, RENDERERS.ghost).
 *
 * Two things the canvas provides that this surface has to provide itself:
 * `--iz` (inverse zoom, keeping the ghost card's dashed border one screen
 * pixel at every zoom - the Feed has no zoom, so it's exactly 1), and wiring
 * the dial after mounting, the same as canvas/items.ts does.
 */
function fillHint(t: Tile) {
  // .ghost-mount is what the dial's own rules hang off - every one of them
  // used to be scoped to `.item[data-type="ghost"]`, which exists on the
  // canvas and nowhere else, so on the Feed the whimsy card arrived with none
  // of its layout (no sized row, no stop names, no track). See the block
  // above .ghost-dial in ghosts.css.
  const host = div('feed-hint ghost-mount');
  // The value the border width is computed from. Not inherited from anywhere
  // on this surface - #world is where the canvas writes it.
  host.style.setProperty('--iz', '1');
  host.append(buildContent(t.item));
  t.el.appendChild(host);
  const dial = host.querySelector<HTMLInputElement>('input[type="range"]');
  if (dial) bindDial(dial);
  // The fraction of the board this hint was seeded at - 1 for the dial, a
  // half for each of the three sentences - carried through as a column count
  // by layout(). Absent on a board written before this existed, where one
  // column is exactly what it already got.
  const span = Number(t.item.meta?.span);
  t.span = Number.isFinite(span) && span > 0 ? Math.min(1, span) : 1;
  // Re-measured on the next layout() (the whimsy dial moving rewrites the
  // card), so a rebuilt hint stops insisting on its previous wording's height.
  t.measured = 0;
}

function fillImage(t: Tile) {
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.alt = t.item.name || '';
  // The card-sized display copy is the sharp layer, never the full original: a
  // multi-megapixel file decoded for a ~210px tile was the whole of the Feed's
  // scroll lag on a phone (see canvas/display.ts). shownHash() picks the pixels
  // - the asset for a photo, meta.preview for a PDF/RAW/HEIC whose asset is not
  // a picture at all.
  const shown = shownHash(t.item);
  // The three edits baked into the copy, the same route the card and viewer
  // take - an uncropped tile here would be the only view most phone users ever
  // see of a picture that is cropped everywhere else.
  const crop = itemCrop(t.item);
  const rot = itemRotate(t.item);
  const matte = itemMatte(t.item);
  const edited = !!(crop || rot || matte) && !!shown;

  // The baked display copy carried in the .mbrd (meta.display, ~1024px). For an
  // unedited photo it is the sharp layer with no decode and no generation at all;
  // it is not used for an edited tile, since the baked copy is the *uncropped*
  // picture and this tile shows the crop/turn/cut-out.
  // Nor above Soft on the sharpness dial, where it is softer than asked for.
  const baked = edited || !bakedServes() ? null : urlOf(t.item.meta?.display);
  // A runtime copy already in memory (a revisit, an edited re-mount, or a second
  // tile of the same asset) answers synchronously and wins - it is the exact
  // edit state, where the baked copy is only the plain one.
  const ready = shown ? displayURLReady(shown, crop, rot, matte) : null;
  const sharp = ready || baked;
  // The blur-up stage: the 100px thumb (or an embedded preview / poster),
  // upscaled and soft until the sharp layer lands. loading='lazy' holds even
  // this off until the tile nears the screen, so a far tile fetches nothing.
  const preview = lowResURL(t.item);

  // A shimmer until the first pixels paint, dropped on the first load. With a
  // thumb it barely shows; without one it stands in for the blur-up stage.
  t.el.classList.add('is-loading');
  const settle = () => t.el.classList.remove('is-loading');

  if (sharp) img.src = sharp;
  else if (preview) img.src = preview;
  img.addEventListener('load', () => {
    settle();
    // The preview of an edited tile is the uncropped picture, the wrong shape.
    if (!edited || img.src !== preview) learnRatio(t, img);
  });
  // A source that will not load falls back to a spare made by another path,
  // which survives whatever this one hit. No spare - drop the shimmer anyway
  // rather than shimmer forever over an image that is never coming.
  img.addEventListener('error', () => {
    const spare = spareURL(t.item);
    if (spare && img.src !== spare) img.src = spare;
    else settle();
  });

  // Nothing baked and nothing cached (an old board, or an edited tile): generate
  // the copy as the tile approaches the screen, so opening a big board does not
  // queue a hundred main-thread decodes at once.
  if (!sharp && shown) wantCopy(t, img, shown, crop, rot, matte);

  applyGrade(img, t.item);
  writeTileFit(t);
  t.el.appendChild(img);
}

// The display copy is generated lazily, one tile at a time, as it nears the
// viewport. One observer for the whole wall; a WeakMap holds each tile's job so
// the callback stays a lookup. The margin is generous, so the copy is usually
// ready by the time the tile is actually on screen. dropTile() unobserves.
let copyObs: IntersectionObserver | null = null;
const copyJobs = new WeakMap<Element, () => void>();

function wantCopy(t: Tile, img: HTMLImageElement,
  shown: string, crop: Crop, rot: Turn, matte: Matte) {
  const edited = !!(crop || rot || matte);
  // A discarded tile is left alone; a live one, or one still blank, takes the
  // result. A copy that could not be made leaves the preview in place.
  const show = (url: string | null) => {
    if (url && (img.isConnected || !img.src)) img.src = url;
  };
  const run = edited || !bakedServes()
    // An edited tile shows the crop/turn/cut-out, which is not the baked plain
    // copy, and a sharper dial wants more than it - so both use the runtime
    // display cache, and nothing is baked. A plain tile hands over its baked
    // copy, shown in place of a sharper one remade every session.
    ? () => ensureDisplay(shown, crop, rot, matte, edited ? '' : bakedHash(t.item))
      .then(show).catch(() => {})
    // A plain tile on a board with nothing baked (an old board). One decode both
    // shows the 1024 copy and stores it as meta.display, so a save persists it.
    // Null means the original already serves - fall back to it.
    : () => bakeDisplayFor(shown).then(dhash => {
        if (dhash) noteDisplay(t.item.id, dhash);
        show(dhash ? assetURL(dhash) : assetURL(shown));
      }).catch(() => {});
  // No observer (a headless test, or an old engine) means generate at once -
  // the near-viewport gate is an optimisation, not the contract.
  if (!copyObs) { run(); return; }
  copyJobs.set(t.el, run);
  copyObs.observe(t.el);
}

/**
 * The object-fit for a photo or video tile, as the data-fit attribute the CSS
 * keys off - fitMode() (canvas/renderers.ts), which on the Feed is fill: the
 * tile is its picture's shape, and fill hides the rounding. Nothing but image
 * and video tiles carries the attribute.
 */
function writeTileFit(t: Tile) {
  if (t.kind === 'image' || t.kind === 'video') t.el.dataset.fit = fitMode(t.item);
}

/**
 * The three picture adjustments, and the mirror, onto one element of a tile.
 *
 * The canvas puts them on .item-body through two custom properties, which
 * cannot be reused here: a tile is not a card and has no such element. Same
 * numbers, same order, written straight onto the node that shows the picture.
 */
function applyGrade(el: HTMLElement, item: Item) {
  const adjust = itemAdjust(item);
  if (adjust) {
    el.style.filter =
      `brightness(${adjust.brightness}) contrast(${adjust.contrast}) saturate(${adjust.saturation})`;
  }
  // And which way round it is hung, for the reason the crop above is
  // honoured - this tile is the picture on a phone. The string is
  // board-model.ts's (flipTransform()), shared with the card and export.
  const flip = flipTransform(item);
  if (flip) el.style.transform = flip;
}

function fillVideo(t: Tile) {
  const url = pictureURL(t.item);
  if (url) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
    img.src = url;
    img.addEventListener('load', () => learnRatio(t, img));
    // The poster carries the clip's grade, so a graded video reads the same on
    // the Feed as it does on the board. There is no crop on a clip - see
    // setItemCrop() in state.ts.
    applyGrade(img, t.item);
    t.el.appendChild(img);
  }
  const badge = div('feed-play');
  badge.innerHTML = PLAY_ICON;
  t.el.appendChild(badge);
  writeTileFit(t);
  // The first tap plays the clip in the tile, and each after it pauses or
  // resumes. No native controls: the now-playing bar at the foot is the
  // transport, as it is for every clip on the board.
  actAsButton(t.el, () => {
    if (!t.video) { mountVideo(t); return; }
    if (t.video.paused) t.video.play().catch(() => {});
    else t.video.pause();
  });
}

/** Swap a video tile's poster for a live, registered <video>. */
function mountVideo(t: Tile) {
  if (t.video) return;
  const url = t.item.asset?.hash ? assetURL(t.item.asset.hash) : null;
  if (!url) return;
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'metadata';
  v.src = url;
  const poster = pictureURL(t.item);
  if (poster) v.poster = poster;
  // The play badge stays, over the clip, and shows while it is paused.
  const badge = t.el.querySelector('.feed-play');
  t.el.replaceChildren(v);
  if (badge) t.el.append(badge);
  const paint = () => t.el.classList.toggle('is-playing', !v.paused);
  v.addEventListener('play', paint);
  v.addEventListener('pause', paint);
  t.video = v;
  registerPlayer(v, t.item);
  v.play().catch(() => {});
}

function fillAudio(t: Tile) {
  const item = t.item;
  const art = div('feed-tile-art');
  const cover = urlOf(item.meta?.cover);
  if (cover) {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false; img.alt = '';
    img.src = cover;
    art.appendChild(img);
  } else {
    // No embedded art (most loose MP3s): a still waveform stands in, same
    // shape as the canvas card and playlist row.
    art.classList.add('is-placeholder');
    art.appendChild(waveBars());
  }
  // A tap plays the track here; the badge says so. Shared queue means it
  // plays into the now-playing bar and the Playlist follows, but the Feed
  // stays put.
  const badge = div('feed-tile-badge');
  badge.innerHTML = PLAY_ICON;

  const cap = div('feed-tile-cap');
  const title = div('feed-cap-title');
  // Same chain the Playlist uses, via trackTitle() (board-model.ts) - used
  // to be written out twice, differing only in the fallback word.
  title.textContent = trackTitle(item) || 'Audio';
  cap.appendChild(title);
  const bits: string[] = [];
  if (str(item.meta?.artist)) bits.push(str(item.meta?.artist));
  // Duration is a number from the importer; anything else reads as absent.
  if (typeof item.meta?.duration === 'number') bits.push(clock(item.meta.duration));
  if (bits.length) {
    const sub = div('feed-cap-sub');
    sub.textContent = bits.join(' · ');
    cap.appendChild(sub);
  }
  t.el.append(art, badge, cap);
  // A tap plays the track in place - Feed doesn't leave.
  //
  // 'board', like a card: the Feed is the board pressed flat, so pressing a
  // track means play *this*, not "start a sequence". See playTrack() and
  // the note on `fromList`.
  actAsButton(t.el, () => playTrack(item, 'board'));
}

/** A still waveform for a coverless audio tile: fixed bars, so it does not cost a
 *  decode and does not dance a wall of tiles. Heights are a fixed pattern. */
const WAVE_PATTERN = [38, 62, 90, 54, 78, 100, 46, 70, 58, 84, 42, 66];
function waveBars() {
  const w = div('feed-bars');
  // Built rather than written as markup - the policy in web/_headers, not
  // safety: the twelve literals above were never foreign. But a `style=`
  // attribute *parsed from markup* is what style-src governs, and this one
  // line was the whole reason 'unsafe-inline' had to be in the policy for
  // the entire site. Assigning .style through the CSSOM isn't parsed from
  // markup and isn't covered by it, so the same bars cost nothing.
  for (const h of WAVE_PATTERN) {
    const bar = document.createElement('i');
    bar.style.height = `${h}%`;
    w.append(bar);
  }
  return w;
}

function fillNote(t: Tile) {
  const body = div('feed-note');
  const text = noteText(t.item);
  body.textContent = text;
  // The sheet the note is actually on, through the same validator the card
  // uses. This used to read `meta.color`, which nothing writes (notes carry
  // `meta.tint`, an integer 1..4), so a yellow note opened white on the Feed
  // while tinted on the canvas - and because normalizeMeta() passes unknown
  // keys through, a hand-edited `meta.color: "url(https://attacker/beacon.png)"`
  // went straight into the CSSOM and made the request.
  const tint = noteTint(t.item.meta?.tint);
  if (tint) body.style.background = `var(--note-${tint})`;
  t.el.appendChild(body);
}

/**
 * The note's words, from the rich model if it has one, else the flat text.
 *
 * The read itself is canvas/note-model.ts's, owner of the bargain between
 * `meta.rich` and `meta.text` (three surfaces were making it independently).
 * What this adds: the name as a last resort, and a trim, since a leading
 * blank line makes a fixed-box tile look empty.
 */
function noteText(item: Item) {
  return (noteWords(item.meta) || item.name || '').trim();
}

function fillLink(t: Tile) {
  // A link stores its URL in meta.url (like the canvas card, renderers.ts); validate
  // it through the same scheme check so a non-http(s) string makes an inert card
  // rather than a live window.open.
  const u = linkURL(t.item.meta?.url);
  const host = u ? u.hostname.replace(/^www\./, '') : '';

  // A YouTube or Spotify link is a player waiting to be asked for. The offer,
  // not the frame: nothing is requested from anyone until the tile is tapped,
  // the same promise the canvas card makes - so the tap is the press, and it
  // mounts the frame in place rather than leaving for the site.
  if (t.embed) {
    const spec = t.embed;
    const card = div('feed-embed');
    const hostEl = div('feed-link-host');
    // The song once its title is stored, the site until then - the same order
    // the canvas card reads (renderers.ts).
    hostEl.textContent = str(t.item.meta?.title) || t.item.name || host;
    card.append(hostEl, offerButton(spec));
    t.el.appendChild(card);
    actAsButton(t.el, () => mountEmbed(t, spec), 'link');
    return;
  }

  const card = div('feed-link');
  // The site's own mark, the same one the canvas card draws (renderers.ts), so a
  // link reads the same on both surfaces. A globe for a site with no bundled mark.
  const nameRow = div('feed-link-title');
  if (u) nameRow.append(linkGlyph(u));
  const name = div('feed-link-name');
  name.textContent = t.item.name || host || str(t.item.meta?.url) || 'Link';
  nameRow.append(name);
  const hostEl = div('feed-link-host');
  hostEl.textContent = host;
  card.append(nameRow, hostEl);
  t.el.appendChild(card);
  if (u) {
    // Through openExternal so a Feed link confirms before leaving, the same as a
    // canvas card - the tile is a div, not an anchor, so the board-wide guard
    // does not see it and it routes the exit itself.
    actAsButton(t.el, () => { void openExternal(u.href); }, 'link');
  }
}

/**
 * Swap a tapped embed offer for its player, in place. The height was already
 * the player's (sizeEmbedSlots), so nothing on the wall moves; only the offer's
 * chrome gives way to the frame. Guarded against a second tap, which on a
 * mounted tile would otherwise tear the running player out and rebuild it.
 */
function mountEmbed(t: Tile, spec: EmbedSpec) {
  if (t.el.querySelector('.embed-frame')) return;
  const frame = frameFor(spec);
  frame.classList.add('feed-embed-frame');
  t.el.replaceChildren(frame);
  // On play if missing, the same hook the canvas card uses - so a title
  // fetched on either surface shows on both.
  enrichEmbedCard(t.item);
}

function fillSwatch(t: Tile) {
  const block = div('feed-swatch');
  // Through swatchHex(), the only thing that decides what a swatch is.
  //
  // This used to read `meta.color`, a key no swatch carries (they store
  // `meta.hex`), falling through to `item.name` straight into the CSSOM -
  // every swatch was coloured by its own *name* (renaming one dropped it to
  // #888), and a .mbrd carrying a `name` like `url(https://attacker/x.png)`
  // put that value into a background, exactly what swatchHex()'s
  // /^#[0-9a-f]{6}$/ exists to prevent.
  const color = swatchHex(t.item.meta?.hex);
  block.style.background = color;
  const label = div('feed-swatch-label');
  label.textContent = color;
  t.el.append(block, label);
}

/**
 * How much of a text file a tile shows.
 *
 * Well under the canvas card's 20 000 - a tile is a few hundred pixels of a
 * scrolling wall and draws perhaps forty lines. Reading a hundred kilobytes
 * to lay out forty is work paid on every text file the board holds, right
 * when the feed is trying to draw everything at once. The rest is one tap
 * away, in the viewer.
 */
const TILE_TEXT = 2000;

/**
 * A text file, showing its words.
 *
 * The read is asynchronous, the tile built synchronously - the card goes up
 * with its name, the body arrives when it arrives, the same bargain
 * fillImage() makes with a lazily-decoded picture.
 *
 * <pre> and textContent, never innerHTML: much of what classify() routes here
 * is markup, and rendering an HTML file's own tags would execute a file the
 * app did not write.
 */
function fillText(t: Tile) {
  const md = MARKDOWN.has(str(t.item.meta?.ext));
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
    // The tile may have been dropped or rebuilt while the read was out -
    // writing into a detached node is harmless, into a rebuilt one is not.
    if (!body.isConnected) return;
    if (md) body.append(renderMarkdown(text));
    else body.textContent = text;
  }).catch(() => { /* an unreadable file keeps its name and nothing else */ });
}

function fillFile(t: Tile) {
  const card = div('feed-file');
  const name = div('feed-file-name');
  // Both lines through kindName(): this is the tile every unrenderable file
  // lands on, so it is where the word `generic` used to be printed the most.
  name.textContent = baseName(t.item.name) || t.item.name || kindName(t.item);
  const kind = div('feed-file-kind');
  kind.textContent = kindName(t.item);
  card.append(name, kind);
  t.el.appendChild(card);
}

// ---------------------------------------------------------------------------
// The masonry
// ---------------------------------------------------------------------------

/**
 * Shortest-column packing over every slot. Each lands in whichever column is
 * shortest so far, leftmost on a tie, and the box it gets is written back onto
 * the slot. Returns the tallest column's height (the wall's height).
 *
 * The packing itself is arrange/columns.ts's - the same call
 * arrange/arrangements.ts's masonry() makes, not the same rule written out
 * again. They were two loops written from each other that had come apart in
 * three places; two are arguments now (`span`, `tolerance`), and the third -
 * one column width here, a width per column on the board - stays in each
 * surface, why packColumns() answers in columns and tops rather than x and y.
 *
 * Over slots rather than tiles, because the wall's shape is known for every
 * item whether or not a tile is mounted for it - that split is the windowing.
 * `top` is where the run starts on the wall - see packRuns(). Pure but for
 * reading `cols`.
 */
function packSlots(list: Slot[], width: number, top = 0): number {
  const colW = (width - (cols - 1) * GAP) / cols;
  // Every slot's span and height, knowable up front - packColumns() only needs
  // the heights. A measured height wins over the shape (hints and embeds have
  // one); otherwise the ratio decides.
  const sized = list.map(s => {
    const span = spanFor(s, colW);
    const w = span * colW + (span - 1) * GAP;
    return { span, w, h: s.measured > 0 ? s.measured : w / s.ratio };
  });

  // Half a pixel of tolerance: two columns apart in the eighth decimal place
  // look level to anybody. Without it a full-width tile wanders off x = 0.
  const { spots, height } = packColumns(sized, { cols, gap: GAP, tolerance: 0.5 });

  list.forEach((s, i) => {
    s.box.x = spots[i].col * (colW + GAP);
    s.box.y = top + spots[i].top;
    s.box.w = sized[i].w;
    s.box.h = sized[i].h;
  });
  return height;
}

/**
 * Pack each run on its own, each one starting below the whole of the one
 * before. Packed as one wall, a loose card after a fence's run drops into the
 * shortest column, beside the fence's cards and above its last ones, and the
 * fence stops reading as one group. The Mobile layout levels its runs the same
 * way (packRuns() in layout.ts). Returns the wall's height.
 */
function packRuns(runs: Slot[][], width: number): number {
  let top = 0;
  for (const run of runs) top += packSlots(run, width, top) + GAP;
  return Math.max(0, top - GAP);
}

/** How tall a fence's band stands on the wall, in pixels. */
const BAND_H = 34;

/**
 * How many columns a tile takes.
 *
 * **One, unless it is a hint**, and that guard is the whole function - every
 * other tile (photograph, clip, track, note, file card) is one column wide;
 * spanning is a thing hints do because they are sentences rather than pictures.
 *
 * Said as a `kind` test rather than read off `Tile.span`, which the first
 * version did and got wrong: `span` defaults to 1 for every tile, 1 means
 * "the whole width" for a hint, and together that silently made every track
 * and photograph full width. The type is asked first, `span` consulted only
 * for the type it describes.
 */
function spanFor(t: Sizable, colW: number): number {
  // A fence's band heads its run across the whole wall.
  if (t.kind === 'fence') return cols;
  // A player spans as many columns as its frame's floor needs - a one-column
  // Spotify tile would start the same sideways scrollbar a too-narrow card does
  // on the canvas. A fully fluid player (YouTube, minWidth 0) stays one column.
  if (t.embed && t.embed.minWidth > colW) {
    const need = Math.ceil((t.embed.minWidth + GAP) / (colW + GAP));
    return clamp(need, 1, cols);
  }
  if (t.kind !== 'hint') return 1;
  // Its seeded fraction of the wall, and at least enough width to set a line of
  // prose in. On a two-column phone the floor does not bind and a half-width
  // hint stays half-width, which is what the old mobile board did.
  const want = t.span >= 1 ? cols : Math.round(cols * t.span);
  const need = Math.ceil((HINT_MIN_W + GAP) / (colW + GAP));
  return clamp(Math.max(want, need), 1, cols);
}

/**
 * The narrowest a hint may be drawn, in pixels.
 *
 * A floor, not the intended width - a hint asks for the fraction of the board
 * it was seeded at, and this only stops that fraction becoming absurd. Set
 * deliberately low so a half-width hint on a two-column phone stays
 * half-width, matching the old mobile board's pairing of the three hints.
 * Above that it binds only on a wide wall, where a half of five columns would
 * round down to a strip too narrow for a sentence.
 *
 * Height is not this function's problem - every hint is measured before
 * packing (measureHintSlots), so a narrow hint is a tall one, not a clipped one.
 */
const HINT_MIN_W = 170;

/** A hint's seeded fraction of the wall, read straight off the item so a slot
 *  can be sized without a tile. Mirrors fillHint(); one for every other kind. */
function hintSpan(item: Item): number {
  if (kindOf(item) !== 'hint') return 1;
  const span = Number(item.meta?.span);
  return Number.isFinite(span) && span > 0 ? Math.min(1, span) : 1;
}

/**
 * Give every hint slot the height its own words need, before the wall is packed.
 *
 * The Feed lays out by *shape*: a tile is a fraction of a column wide, its
 * height falls out of an aspect ratio. Right for a picture, which crops;
 * wrong for a hint, whose last line either fits or doesn't - on a narrow wall
 * it didn't, cutting off the three sentences and the whimsy dial with no sign
 * they'd been cut.
 *
 * So each hint's tile is mounted, laid out once at the width it is about to get,
 * height released, and asked how tall it came out. The answer goes on the slot;
 * packSlots() uses it instead of the ratio.
 *
 * **This forces a layout flush**, which the rest of this module is careful
 * never to do per tile. A hint is the one kind mounted before the window scan,
 * which is affordable because hints exist only on an otherwise-empty board, at
 * most four of them, gone the moment they stop being the whole board. A wall of
 * two hundred photographs measures nothing.
 */
function measureHintSlots(list: Slot[], width: number) {
  const colW = (width - (cols - 1) * GAP) / cols;
  for (const s of list) {
    if (s.kind !== 'hint') continue;
    const t = ensureTile(s);
    // Same width the packer is about to give it, from the same function.
    const span = spanFor(s, colW);
    const w = span * colW + (span - 1) * GAP;
    // Width first, height auto: reads back the height this card needs at its new
    // width, not its previous layout's. scrollHeight, not getBoundingClientRect;
    // floored so a card whose fonts have not landed cannot collapse to nothing.
    t.el.style.width = `${w}px`;
    t.el.style.height = 'auto';
    s.measured = Math.max(72, Math.ceil(t.el.scrollHeight));
    t.el.style.height = `${s.measured}px`;
  }
}

/**
 * Give every embed slot the exact height its player needs, before packing.
 *
 * Like measureHintSlots, but computed rather than measured: a player's height
 * is a known function of its frame width (canvas/embed.ts, playerHeight), so
 * this needs no tile and forces no layout flush. The same height whether the
 * tile still shows the offer or already holds the frame - so mounting the player
 * on a tap grows nothing and the wall does not jump under the thumb.
 */
function sizeEmbedSlots(list: Slot[], width: number) {
  const colW = (width - (cols - 1) * GAP) / cols;
  for (const s of list) {
    if (!s.embed) continue;
    // The Feed mounts the bare frame full-bleed, so the tile width is the frame
    // width - no card padding to subtract, unlike the canvas.
    const span = spanFor(s, colW);
    const w = span * colW + (span - 1) * GAP;
    s.measured = Math.max(72, Math.round(s.embed.playerHeight(w)));
  }
}

/**
 * The mounted tile for a slot, built and appended if absent - or rebuilt when
 * the item's kind has changed under it. The one door that puts a tile in the
 * DOM; cullWindow() and measureHintSlots() are its two callers.
 */
function ensureTile(s: Slot): Tile {
  let t = tiles.get(s.item.id);
  if (t && t.kind !== s.kind) { dropTile(t); tiles.delete(s.item.id); t = undefined; }
  if (!t) {
    t = buildTile(s.item);
    tiles.set(s.item.id, t);
    // The tile Find flew to can be built mid-scroll, after revealInFeed() ran.
    if (s.item.id === foundId) t.el.classList.add('is-found');
    gridEl!.appendChild(t.el);
  } else {
    // Keep the tile pointed at the live item; a reused tile predates this pass.
    t.item = s.item;
    t.ratio = s.ratio;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Stickers on the wall
//
// The one mechanism in the Feed with no equivalent on the canvas. Elsewhere in
// the app a screen point becomes a world point through vp.toWorld(), a pan and
// a zoom; the Feed is a different arrangement of the same items with no
// transform between the two. So the way back is through the *item*: which
// tile the tap landed on, where in that tile, then the same place in the
// item's own box.
// ---------------------------------------------------------------------------

/**
 * A tap on the wall, as a world point on the item it landed on - or null if it
 * landed on no tile at all.
 *
 * The tap becomes a fraction of the tile it hit, then a point in the item's
 * current-layout box - the arithmetic stuckPlacement() already does for a
 * rider crossing between layouts. Item coordinates are centres and world y
 * points up, hence the halves and the minus.
 *
 * The fraction is *approximate*: a tile's aspect is clamped to 1:2..2:1
 * (ratioOf) so no one picture can own a column, so a very tall photograph is
 * drawn shorter here than on the board, and a star pressed near its bottom
 * lands a little higher up the photograph than the thumb did. The
 * alternative - refusing to place on clamped tiles at all - is a worse
 * answer to a smaller problem.
 */
function feedPointToWorld(clientX: number, clientY: number): Point | null {
  const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.feed-tile');
  const item = el && byId(str(el.dataset.id));
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
 * Positioned as a percentage of the tile, not pixels, which is what lets this
 * run once per render and survive every relayout underneath: columns are
 * re-measured on every resize, but the sticker's *fraction* of its host does
 * not change when the tile does.
 *
 * A sticker on a note on a photograph is drawn on the note's tile - the note
 * is what it's stuck to, the same walk stuckTo() gives everywhere, taken one
 * step rather than to the root.
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

function stickerOverlay(it: Item, host: Item) {
  const shape = stickerShape(it.meta?.shape) ? str(it.meta.shape) : DEFAULT_SHAPE;
  const svg = stickerArt(shape, 'feed-sticker');
  // A tint is a number (see stickerTint), and dataset takes strings - the
  // String() is the coercion the assignment was already making on its own.
  const tint = it.meta?.tint;
  if (tint) svg.dataset.tint = String(tint);
  // Centre-relative fractions turned into the top-left percentages CSS wants,
  // with the shape's own centre pulled back over the point by a translate.
  svg.style.left = `${((it.x - host.x) / host.w + 0.5) * 100}%`;
  svg.style.top = `${(0.5 - (it.y - host.y) / host.h) * 100}%`;
  svg.style.width = `${(it.w / host.w) * 100}%`;
  svg.style.height = `${(it.h / host.h) * 100}%`;
  // Negated, like canvas/items.ts: world angles run the other way from screen.
  svg.style.rotate = `${-(it.rot || 0)}deg`;
  return svg;
}

// ---------------------------------------------------------------------------
// Notes stuck on a card
//
// On the canvas a stuck note sits on its host. On the wall it had a tile of its
// own, somewhere else in the order, which cut it from the card it is about. So
// it takes no slot: it rides the host's tile, counted by a small sticky in the
// tile's top-right corner, and a press on that lays the notes open over the
// tile. Top right, clear of the pick circle top left and the play badge in the
// middle.
// ---------------------------------------------------------------------------

/**
 * The tile a stuck note rides: its host, or for a note on a note, the first
 * host up the chain that has a tile. Null when the chain ends at something the
 * wall does not draw (see HIDDEN) or goes round, and then the note keeps a tile
 * of its own rather than vanishing.
 */
function riderHost(note: Item): Item | null {
  const seen = new Set([note.id]);
  let host = stuckTo(note);
  while (host?.type === 'note' && isRider(host)) {
    if (seen.has(host.id)) return null;
    seen.add(host.id);
    host = stuckTo(host);
  }
  return host && !HIDDEN.has(host.type) ? host : null;
}

/** Every stuck note, under the tile it rides, in board order: bottom first. */
function ridersByHost() {
  const out = new Map<string, Item[]>();
  for (const it of board.items) {
    if (it.type !== 'note' || !isRider(it)) continue;
    const host = riderHost(it);
    if (!host) continue;
    const list = out.get(host.id);
    if (list) list.push(it);
    else out.set(host.id, [it]);
  }
  return out;
}

/**
 * Put the notes button, and the notes when open, on every mounted tile. Only a
 * tile whose notes changed is redrawn, so a scroll that mounts one tile leaves
 * an open one where its reader left it.
 */
function paintRiders() {
  for (const [id, t] of tiles) {
    const notes = riders.get(id) || [];
    const key = notes.length ? `${riderPass}|${notes.map(n => n.id).join()}` : '';
    if ((riderDrawn.get(t.el) || '') === key) continue;
    riderDrawn.set(t.el, key);
    t.el.querySelector(':scope > .feed-notes-btn')?.remove();
    t.el.querySelector(':scope > .feed-notes')?.remove();
    if (!notes.length) { notesOpen.delete(id); continue; }
    t.el.append(notesButton(id, notes));
    if (notesOpen.has(id)) t.el.append(notesLayer(id, notes));
  }
}

/** Lay a tile's notes open, or fold them away. Only the layer changes, so the
 *  button keeps its focus. */
function toggleNotes(id: string) {
  const t = tiles.get(id);
  const notes = riders.get(id);
  if (!t || !notes) return;
  const open = !notesOpen.delete(id);
  if (open) notesOpen.add(id);
  t.el.querySelector(':scope > .feed-notes')?.remove();
  if (open) t.el.append(notesLayer(id, notes));
  t.el.querySelector('.feed-notes-btn')?.setAttribute('aria-expanded', String(open));
}

/** The note's own sheet colour, as fillNote() reads it. */
function paintNoteSheet(el: HTMLElement, note: Item) {
  const tint = noteTint(note.meta?.tint);
  if (tint) el.style.background = `var(--note-${tint})`;
}

/**
 * Keep a press inside the notes off the tile under them. The tile is itself a
 * button (wireOpen()), and without this a press here would open the card too.
 */
function ownPresses(el: HTMLElement) {
  el.addEventListener('click', e => e.stopPropagation());
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
}

function notesButton(id: string, notes: Item[]) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'feed-notes-btn';
  b.textContent = String(notes.length);
  const label = notes.length === 1 ? 'The note stuck on this' : `The ${notes.length} notes stuck on this`;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-expanded', String(notesOpen.has(id)));
  // The top note's colour, as the stack reads on the canvas.
  paintNoteSheet(b, notes[notes.length - 1]!);
  b.addEventListener('click', () => toggleNotes(id));
  ownPresses(b);
  return b;
}

/** The notes over the tile, top note first. A press on a note opens it in the
 *  viewer, and a press between them folds them away. */
function notesLayer(id: string, notes: Item[]) {
  const layer = div('feed-notes');
  for (const note of [...notes].reverse()) {
    const sheet = div('feed-rider');
    sheet.dataset.id = note.id;
    sheet.textContent = noteText(note);
    paintNoteSheet(sheet, note);
    if (canView(note.id)) actAsButton(sheet, () => openViewer(note.id));
    layer.append(sheet);
  }
  layer.addEventListener('click', e => { if (e.target === layer) toggleNotes(id); });
  ownPresses(layer);
  return layer;
}

function scheduleLayout() {
  if (layoutRaf || typeof requestAnimationFrame !== 'function') return;
  layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
}

/**
 * Recompute the column count and the whole wall's shape, then mount the window.
 *
 * This sizes every item into a slot - a size for all, which is what keeps the
 * scrollbar honest - and then cullWindow() puts a DOM tile only under the
 * screenful near the viewport. The empty plate rides here because this is where
 * the item count is read; a frame's delay showing it is invisible.
 */
function layout() {
  if (!gridEl || board.layoutMode !== 'mobile') return;
  const width = gridEl.clientWidth;
  if (width < 1) return;
  const wasCols = cols;
  cols = clamp(Math.round(width / TILE_TARGET), 2, MAX_COLS);
  // A new width or column count is a window resize, which stays instant.
  const resized = cols !== wasCols || Math.abs(width - gridWidth) >= 1;
  gridWidth = width;
  const was = new Map<string, Box>();
  if (!resized) {
    for (const id of tiles.keys()) {
      const box = slotById.get(id)?.box;
      if (box) was.set(id, { ...box });
    }
  }

  const slotOf = (it: Item): Slot => ({
    item: it, kind: kindOf(it), embed: linkEmbed(it),
    ratio: ratioOf(it), span: hintSpan(it), measured: isFence(it) ? BAND_H : 0,
    box: { x: 0, y: 0, w: 0, h: 0 },
  });
  riders = ridersByHost();
  riderPass++;
  const ridden = new Set([...riders.values()].flat().map(n => n.id));
  const runs = feedRuns(ridden).map(run => (run.band ? [run.band, ...run.items] : run.items).map(slotOf));
  slots = runs.flat();
  empty!.classList.toggle('is-shown', slots.length === 0);
  slotById = new Map(slots.map((s): [string, Slot] => [s.item.id, s]));

  measureHintSlots(slots, width);   // the one kind that must be mounted to size
  sizeEmbedSlots(slots, width);     // computed height, no DOM
  const height = packRuns(runs, width);
  gridEl.style.height = `${Math.max(0, height)}px`;

  // Every box just moved, so every mounted tile is repositioned.
  cullWindow(true);
  if (was.size) slideTiles(was);
}

/**
 * A reflow seen moving: each tile that was already mounted slides from its old
 * box to its new one, on the individual `translate`, which composes with the
 * placement `transform` and stays on the compositor. A size change still jumps.
 */
function slideTiles(was: Map<string, Box>) {
  let ms = -1;
  let easing = '';
  for (const [id, t] of tiles) {
    const from = was.get(id);
    const to = slotById.get(id)?.box;
    if (!from || !to) continue;
    // First, and cheap: the items bus fires often and most reflows move nothing.
    let dx = from.x - to.x;
    let dy = from.y - to.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (ms < 0) {
      ms = reducedMotion() || typeof t.el.animate !== 'function' ? 0 : baseMs();
      easing = readToken('--ease') || 'ease';
    }
    if (!(ms > 0)) return;
    // Caught mid-slide: start from where the tile is drawn, not its old slot.
    const running = slides.get(t.el);
    if (running && running.playState === 'running') {
      const [x = '0', y = '0'] = getComputedStyle(t.el).translate.split(' ');
      dx += Number.parseFloat(x) || 0;
      dy += Number.parseFloat(y) || 0;
      running.cancel();
    }
    slides.set(t.el, t.el.animate(
      [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: ms, easing }));
  }
}

// ---------------------------------------------------------------------------
// The window: DOM for a screenful, not the whole wall
// ---------------------------------------------------------------------------

/** How far past the viewport a tile is still mounted, in screens. One screen of
 *  headroom above and below absorbs a fast flick without a blank band. */
const WINDOW_SCREENS = 1;

function scheduleCull() {
  if (cullRaf || typeof requestAnimationFrame !== 'function') { cullWindow(); return; }
  cullRaf = requestAnimationFrame(() => { cullRaf = 0; cullWindow(); });
}

/**
 * Mount the tiles whose slot falls inside the window, drop the rest. This is the
 * heart of the windowing: a board of hundreds keeps a wall of a dozen live
 * nodes, the same trade canvas/items.ts makes with its cull.
 *
 * The now-playing clip is the one exemption, exactly as on the canvas: removing
 * a <video> from the document pauses it, so the tile that is sounding is kept
 * mounted wherever it has scrolled to.
 *
 * Stickers ride here too - a pinned sticker's host tile only exists while in the
 * window, so paintStickers() is re-run on every cull rather than once per layout.
 */
function cullWindow(reposition = false) {
  if (!root || !gridEl) return;
  const view = root.clientHeight;
  const scrollTop = root.scrollTop;
  const margin = view * WINDOW_SCREENS;
  const viewTop = scrollTop - margin;
  const viewBottom = scrollTop + view + margin;
  // gridEl's top in the scroller's own content coordinates - one rect read,
  // hoisted out of the loop so the whole pass forces at most one layout flush.
  const gridTop = gridEl.getBoundingClientRect().top - root.getBoundingClientRect().top + scrollTop;

  const npEl = nowPlaying()?.el || null;
  const wanted = new Set<string>();
  // Did the mounted set change this pass? A scroll that stays within the margin
  // mounts and drops nothing, so the sticker repaint and the play mark below are
  // skipped - the two O(n) tails that would otherwise run every scroll frame.
  let changed = false;
  for (const s of slots) {
    const top = gridTop + s.box.y;
    if (top + s.box.h < viewTop || top > viewBottom) continue;
    wanted.add(s.item.id);
    // On a plain scroll only the tiles that just entered are placed - an already
    // mounted tile has not moved, so re-writing its width/height would be a
    // layout flush per tile per frame, the very cost windowing exists to avoid.
    const had = tiles.has(s.item.id);
    const t = ensureTile(s);
    if (!had) changed = true;
    if (reposition || !had) placeTile(t, s.box);
  }
  // Everything mounted but outside the window goes - unless it is the clip that
  // is playing, which is kept and simply repositioned from its slot.
  for (const [id, t] of tiles) {
    if (wanted.has(id)) continue;
    const s = slotById.get(id);
    if (s && t.video && t.video === npEl) { placeTile(t, s.box); continue; }
    // No slot at all is a card gone from the wall (a delete), not a cull.
    dropTile(t, !s);
    tiles.delete(id);
    changed = true;
  }
  if (changed || reposition) { paintStickers(); paintRiders(); markPlaying(); }
}

/** Size and position one tile from its slot's box. */
function placeTile(t: Tile, box: Box) {
  t.el.style.width = `${box.w}px`;
  t.el.style.height = `${box.h}px`;
  t.el.style.transform = `translate(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px)`;
}

// The tile Find picked, lit for FOUND_MS. A module value and not only a class,
// because the tile is usually outside the window when the scroll starts.
const FOUND_MS = 1600;
let foundId: string | null = null;
let foundTimer = 0;

/**
 * Scroll the wall to an item's tile and light it - what Find does on the Feed
 * in place of the canvas's flight (research/old/done-2026-09-15.md, R26).
 * False when the wall is not on screen or the item has no tile on it, so the
 * caller can fly the canvas instead.
 */
export function revealInFeed(id: string): boolean {
  if (!root || !gridEl || !root.getClientRects().length) return false;
  // A stuck note has no tile: its host's tile is shown, with the notes laid open.
  const note = slotById.has(id) ? null : byId(id);
  const host = note?.type === 'note' ? riderHost(note) : null;
  if (host) id = host.id;
  const s = slotById.get(id);
  if (!s) return false;
  // A tile not yet mounted is built open by paintRiders() when it arrives.
  if (host && !notesOpen.has(id)) {
    if (tiles.has(id)) toggleNotes(id);
    else notesOpen.add(id);
  }
  const gridTop = gridEl.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  const top = gridTop + s.box.y - (root.clientHeight - s.box.h) / 2;
  const still = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  root.scrollTo({ top: Math.max(0, top), behavior: still ? 'auto' : 'smooth' });
  if (foundId) tiles.get(foundId)?.el.classList.remove('is-found');
  foundId = id;
  tiles.get(id)?.el.classList.add('is-found');
  clearTimeout(foundTimer);
  foundTimer = window.setTimeout(() => {
    if (foundId) tiles.get(foundId)?.el.classList.remove('is-found');
    foundId = null;
  }, FOUND_MS);
  return true;
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
    // Both `!` follow the two tests this frame was scheduled behind: a
    // title must exist, and both are built together in initFeed().
    if (w > 0) {
      titleEl!.style.setProperty('--mobile-board-width', w + 'px');
      titleEl!.style.setProperty('--mobile-header-height',
        (mastheadEl!.clientHeight || w / 1.5) + 'px');
    }
    if (styleHeader) styleHeader(titleEl, mastheadEl);
  });
}

// ---------------------------------------------------------------------------

function dropTile(t: Tile, leave = false) {
  if (t.video) { releasePlayers(t.el); t.video = null; }
  copyObs?.unobserve(t.el);
  cardObs?.unobserve(t.el);
  copyJobs.delete(t.el);
  if (!leave || !exitTile(t.el)) t.el.remove();
}

/**
 * A deleted tile on screen fades and shrinks out rather than vanishing, as the
 * canvas plays an exit for the same delete. False when there is nothing to see:
 * off screen, or motion flattened by the Quality dial. Reduced motion keeps
 * the fade and drops the shrink.
 */
function exitTile(el: HTMLElement): boolean {
  const ms = fastMs();
  if (!root || !(ms > 0) || typeof el.animate !== 'function') return false;
  const box = el.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  if (box.bottom < view.top || box.top > view.bottom) return false;
  // Inert at once: a press on a leaving tile must not open what was deleted.
  el.inert = true;
  const frames = reducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.96' }];
  const run = el.animate(frames, { duration: ms, easing: readToken('--ease') || 'ease', fill: 'forwards' });
  const gone = () => el.remove();
  run.addEventListener('finish', gone);
  run.addEventListener('cancel', gone);
  return true;
}

/** Leave the Feed: release every clip and clear the wall. */
function teardown() {
  for (const t of tiles.values()) dropTile(t);
  tiles.clear();
  slots = [];
  slotById = new Map();
}
