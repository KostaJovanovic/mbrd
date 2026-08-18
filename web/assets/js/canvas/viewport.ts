// Coordinate + viewport model.
//
// World coordinates are floats with (0,0) at the centre of the board, oriented
// like a maths plane rather than like a screen: +x right, **+y up**. Top-right
// is (+,+), bottom-left is (-,-). Screen y points the other way, so the two
// axes differ by a sign, and that sign lives here and in items.js/place() -
// nothing else in the app needs to think about it.
//
//   screenX = (worldX - panX) * zoom + centreX
//   screenY = (panY - worldY) * zoom + centreY
//   worldX  = (screenX - centreX) / zoom + panX
//   worldY  = panY - (screenY - centreY) / zoom
//
// #world is one absolutely-positioned layer pinned to the viewport centre, and
// the whole pan/zoom is a single `translate(...) scale(...)` on it - so the
// browser composites pan/zoom on the GPU and native <img>/<video> keep working.
//
// Transform order matters: `translate(t) scale(z)` puts a child laid out at CSS
// (cssX, cssY) at centre + (t + css*z). Items are laid out at cssY = -worldY
// (see items.js), which makes the vertical translate +panY*zoom, not -panY*zoom.

import { clamp, rafThrottle, emitter, readToken } from '../util.ts';
import type { Emitter } from '../util.ts';
import { itemBounds } from '../geometry.ts';
import type { Box, Bounds, Point } from '../geometry.ts';
import type { LayoutMode } from '../board-model.ts';

/**
 * The board's sheet as the screen sees it - what mobileScreenRect() answers.
 *
 * Declared here rather than in canvas/mobile-frame.ts, which is where it used
 * to live and is still where most of it is read: mobile-frame already imports
 * this module, so the type has to travel in that direction or the graph gains a
 * cycle (tests/layers.test.js counts a type-only import as an edge, and it is
 * right to - the arrow is a fact about the source whatever the runtime does
 * with it). The method that produces the rectangle is the honest owner of its
 * shape anyway.
 */
export type MobileScreenRect = {
  left: number;
  width: number;
  top: number;
  bottom: number;
};

/**
 * What the corner calls 100%, and now also what it is.
 *
 * This was 0.8: the printed percentage and the true scale were two numbers for
 * one thing, so that a board sitting at scale 0.8 read "100%". The rebasing is
 * gone - 100% is 1:1 again, one world unit to one CSS pixel, the same thing
 * mobileZoom() has always meant by 1 - and every rung below that is written as a
 * multiple of this so the percentages the interface prints stay the ones this
 * file reasons in.
 *
 * `zoom` in this file is and stays the true world-to-screen scale: the transform
 * multiplies by it, toScreen/toWorld divide by it, and a `view` saved in a board
 * records it raw. Which is the one thing worth knowing about the change: a board
 * saved before it opens at the scale it was saved at and prints a different
 * number for it - 0.8 was "100%" and reads as 80% now. The board is not drawn
 * any differently; the label under it is honest where it used to be flattering.
 *
 * The name stays, rather than the constant being folded away into 1s. It is the
 * one place that says which scale the corner means by 100%, and `vp.fit(items,
 * 80, 0, BASE_ZOOM)` in main.js reads as what it is - open at 100% - where a
 * bare 1 would read as an argument somebody guessed.
 *
 * Anything measured in real screen pixels is deliberately not written against
 * it: the grid's MIN_PX/MAX_PX, paper.js's page outline and the scale bar all
 * compose with the raw zoom and stay truthful by doing so.
 */
export const BASE_ZOOM = 1;

export const MIN_ZOOM = 0.1 * BASE_ZOOM;   // 10% as printed
export const MAX_ZOOM = 5 * BASE_ZOOM;     // 500% as printed

/**
 * How much board is kept mounted beyond the edge of the screen, to hide pop-in,
 * in *screen* pixels - converted to world units per call, which is the whole
 * point. It was a flat 400 world units, a margin that does not shrink as you
 * zoom in: at 100% it held about two and a half screens of cards, at 200% five,
 * because the visible world rectangle halves with every doubling of zoom while a
 * world-space margin stays the size it was. The pop-in it hides happens in
 * screen pixels, so this is the unit it should always have been in.
 */
const CULL_MARGIN_PX = 300;

/**
 * And a ceiling on it in world units, the number this used to be. Below about
 * three-quarter zoom a constant screen margin is *wider* on the board than the
 * flat 400 was and would buy nothing - the visible slice is already enormous and
 * card chrome has been dropped - so the screen-space rule applies where it helps
 * and the old world-space one caps it beyond that. Never worse than before, at
 * any zoom.
 */
const CULL_MARGIN_MAX = 400;

/**
 * That margin in world units at the current zoom.
 *
 * Exported from here because canvas/items.js and canvas/web.js both cull against
 * it: their own module-level copies had drifted apart, which is the shape of bug
 * a duplicated line exists to produce - change one and you had to remember the
 * other. The null guard is not defensive noise: `vp` arrives in each module's
 * init(), and this is reachable from a repaint a subsystem can schedule before
 * that wiring is done, at which point an unguarded read is a TypeError during
 * boot rather than a margin.
 */
export const cullMargin = (vp: Viewport | null): number =>
  Math.min(CULL_MARGIN_PX / (vp ? vp.zoom : 1), CULL_MARGIN_MAX);
const MOBILE_SIDE_PAD = 16;
const MOBILE_TOP_PAD = 32;
const MOBILE_BOTTOM_PAD = 32;

/**
 * How far below the chrome buttons a Mobile board comes to rest.
 *
 * MOBILE_TOP_PAD alone put the board's masthead level with the menu button and
 * the pencil beside it: a title set across the width of the screen with two
 * controls sitting in the middle of it, reading as part of the same row. The
 * board now stops below them instead - the gap is above the masthead, so
 * nothing inside the band changes size or proportion, and it scrolls away with
 * the board like any other part of its top.
 *
 * Measured off the button rather than written down, because the number is not
 * ours: the buttons are pinned at max(12px, env(safe-area-inset-top)) in
 * mobile.css, and a notched phone pushes them further down than a flat one.
 * Asking the element where its lower edge actually is answers for both, and
 * keeps this true if the corner is ever re-laid.
 */
const MOBILE_CHROME_GAP = 14;

function mobileTopPad(): number {
  if (typeof document === 'undefined') return MOBILE_TOP_PAD;
  const btn = document.getElementById('menu-btn');
  const bottom = btn ? btn.getBoundingClientRect().bottom : 0;
  // A button that has not been laid out yet (or is not there at all) measures
  // zero; the plain pad is the honest answer until it has.
  return bottom > 0 ? bottom + MOBILE_CHROME_GAP : MOBILE_TOP_PAD;
}

/**
 * The masthead above a Mobile board, sized from the board itself.
 *
 * Its width and height form a 3:2 landscape rectangle. Measuring the masthead
 * from the fitted board width keeps that shape identical on a short phone, a
 * tall phone, and a desktop window in Mobile mode; viewport height has no say
 * in where the board starts.
 *
 * The room is made here, in the pan clamp, rather than by moving the board's
 * top edge - the strip still starts exactly where mobileBoardTop() says, items
 * still pack from its first row, and nothing in state.js has to know that a
 * header exists. What the clamp does is stop the scroll a header lower, so the
 * band above the edge is real space rather than something drawn over the items.
 *
 */
export const MOBILE_HEADER_ASPECT = 3 / 2;

/** Height in screen px of a 3:2 Mobile masthead `boardWidth` px wide. */
export function mobileHeaderHeight(boardWidth: number): number {
  return Math.max(0, (+boardWidth || 0) / MOBILE_HEADER_ASPECT);
}

/**
 * Fixed zoom that seats a Mobile board in the viewport without enlarging it.
 *
 * Written against a literal 1 rather than against BASE_ZOOM, and so is
 * LOD_ZOOM_SMALL below. Mobile has no zoom control and prints no percentage, so
 * nothing here is a label: this zoom is fit-derived, and the 1 is the 1:1 the
 * name means - one world unit to one CSS pixel. That the two now agree is a
 * coincidence worth keeping separate, since only one of them is a display
 * decision.
 */
export function mobileZoom(viewWidth: number, worldWidth: number, pad = MOBILE_SIDE_PAD): number {
  const available = Math.max(1, viewWidth - pad * 2);
  return clamp(Math.min(1, available / Math.max(1, worldWidth)), MIN_ZOOM, MAX_ZOOM);
}

/**
 * Dev-only kill switches for the per-frame cost of a Mobile scroll, read by
 * mbrd.perf and by the two modules below. All three default to the shipped
 * behaviour, so a board that never opens the console pays one boolean read.
 *
 * They exist because the expensive parts of a Mobile scroll frame are *browser*
 * work - style invalidation, layout, raster - and no JS timer can see them: the
 * view listener has long returned by the time the frame is paid for. That is
 * how they went unnoticed through two rounds of profiling. Switching one off
 * and reading the HUD is the only honest measurement, so the switches stay in
 * the tree as the regression check rather than being deleted once they have
 * been used. See research/old/2026-07-30-mobile-scroll-perf.md.
 *
 * - `legacyVars` puts back the *cost* of what canvas/mobile-frame.js replaced:
 *   the five custom properties written on #viewport on every frame. Nothing
 *   reads them any more, so this changes no picture - it re-creates only the
 *   invalidation. #viewport is an ancestor of #world and custom properties are
 *   inherited, so writing one there invalidates the computed style of every
 *   mounted card, once a frame, on a layout that has no zoom - the same cost
 *   --iz carries, for nothing. Turn it on to measure what taking it away
 *   bought, on the device it was taken away for.
 * - `chrome` false hides the Mobile sheet and masthead and skips their writes
 *   entirely: the upper bound on what the chrome can still be costing.
 * - `gridPos` false skips the background-position write in canvas/grid.js,
 *   which is the lattice layer's per-frame re-raster.
 */
export const mobilePerfFlags = { legacyVars: false, chrome: true, gridPos: true };

/** How long after the last view change the board counts as still. See _moving(). */
const VIEW_SETTLE_MS = 140;

/**
 * How coarsely --iz is allowed to move while the board is in motion.
 *
 * --iz is 1/zoom, published to #world so that item chrome can multiply by it and
 * stay a constant size on screen. It is inherited, which is what makes it
 * convenient and also what makes it expensive: changing it means the browser has
 * to reconsider every card on the board and everything inside it, and re-lay out
 * every part whose size is written in terms of it. On a zoom that is the whole
 * screen's worth of cards, sixty times a second - and it is the single largest
 * reason zooming a full board feels heavy.
 *
 * So during a gesture it moves in steps rather than continuously: 8% of itself,
 * geometric like the zoom it comes from. A grip drawn four per cent off its
 * proper size in the middle of a pinch is not something anyone can see - and the
 * exact value is written the moment the board comes to rest (see _moving), which
 * is when chrome is being aimed at rather than watched going past.
 *
 * Roughly two thirds of the recalculations go, and the ones that remain are
 * spread evenly through the gesture instead of one per frame.
 */
const IZ_STEP = 0.08;

/** `v` snapped to the nearest rung of a ladder that steps by IZ_STEP. */
const izRung = (v: number) => Math.exp(Math.round(Math.log(v) / IZ_STEP) * IZ_STEP);

// How a thrown board comes to rest - see glide().
//
// The time constant is the whole feel of it. A flick travels its speed times
// this many seconds, so a hard throw off a phone - somewhere around 3000px a
// second - carries about a thousand pixels, which is most of a screen. Short
// enough that the board answers the throw and settles rather than sailing on,
// which is what a board you are picking things out of wants: the glide is there
// to carry the movement past the end of the finger, not to travel for you.
const GLIDE_TAU = 0.34;
/** Below this a lift is a lift, not a throw. Screen px per second. */
const GLIDE_MIN = 120;
/** ...and below this the board has stopped, whatever the arithmetic says. */
const GLIDE_STOP = 8;

/**
 * Device pixels per CSS pixel.
 *
 * One definition, because two things snap to this grid and they have to agree
 * about where it is: the axis rules here, and the lattice of marks the grid
 * paints along them. Clamped at three because the grid's backing canvas is
 * allocated at this ratio and a phone claiming four would be four times the
 * memory for a difference nobody can see - so the ceiling has to be shared too,
 * or the two would part company on exactly the devices that have it.
 *
 * Read per paint rather than cached: it changes when a window is dragged to
 * another monitor and when the page is zoomed, neither of which fires anything
 * this module already listens to.
 */
export const deviceRatio = () =>
  Math.max(1, Math.min(3, (typeof window === 'object' && window.devicePixelRatio) || 1));

// One detail ladder with one rung on it: below it the board is a composition
// rather than a set of things you are reading, so item chrome (labels, grips)
// becomes noise and an animation is movement with nothing to see in it. These
// were 0.35 and 0.3, which put chrome and motion on separate rungs - two
// thresholds four hundredths apart that nobody could perceive as two, and that
// made "zoomed out" mean something slightly different depending on which module
// was asking. Kept as separate names because separate modules import them for
// separate purposes; they are one number and should move together, and the day
// one of them genuinely wants to differ it can, without the other three
// silently coming with it.

/** Where the rung sits with a mouse in hand. */
const LOD_ZOOM = 0.4 * BASE_ZOOM;

/**
 * How far out a selected card still shows its resize grips.
 *
 * Well below the chrome rung (LOD_ZOOM): a card at a tenth of its size is a
 * swatch with no room for a label, but its corners are still a thing you reach
 * for to resize it - so the grips outlast the labels by two rungs and go only
 * when the card is too small to aim at.
 */
const GRIP_MIN_ZOOM = 0.1 * BASE_ZOOM;

/**
 * Where a corner grip stops lapping onto the card and clips to its outside half.
 *
 * Below this the card is small enough that a straddling corner would cover too
 * much of its face to pick it up by, so the whole face becomes a move target and
 * the corner resizes only from the part of its hitbox past the card's edge (see
 * the zoom-grab rules in the CSS). A rung of its own, between the chrome rung and
 * the grips' own floor, because it is about size on screen, not legibility.
 */
const GRAB_ZOOM = 0.25 * BASE_ZOOM;

/**
 * And where it sits on a phone.
 *
 * Higher, because the same zoom factor is a smaller card on a phone: the screen
 * is a third the width and the whole board is habitually further out, so chrome
 * sized in screen pixels crowds an item, and a label crossing three of them
 * reads as clutter well before it would on a desk. Moving the rung up means the
 * phone reaches the clean composition sooner rather than sitting in the band
 * where everything is drawn in full and none of it is legible - which is also
 * the band that costs the most to paint on the device least able to.
 */
const LOD_ZOOM_SMALL = 0.55;

/**
 * Whether this is being looked at through a finger.
 *
 * The query object is made once and then read live, so the answer follows a
 * tablet that has a keyboard folded onto it rather than being decided at boot -
 * and made lazily, because nothing in this file may touch the browser at import
 * time (see tests/imports.test.js). Absent matchMedia, a mouse is assumed: node
 * runs these modules, and the desktop rung is the one the tests describe.
 *
 * This answers "can this be poked", and that is all it should ever be asked.
 * What the detail rung wants is a different question - see onSmallScreen().
 */
let coarse: MediaQueryList | null = null;
export function onTouch(): boolean {
  if (typeof matchMedia !== 'function') return false;
  coarse ??= matchMedia('(pointer: coarse)');
  return coarse.matches;
}

/**
 * Whether this engine rations simultaneous media decoders.
 *
 * A third question, and it exists because the media guards were asking the one
 * above and it is not the same question. iOS allows very few live video
 * decoders at once, which is why canvas/renderers.js parks a clip's source
 * until it is played - a board of parked clips mounted by a zoom-out is
 * otherwise a dead tab. That is a fact about **the engine**, not about fingers,
 * and the two come apart on exactly one device: an iPad with a Magic Keyboard
 * or a trackpad attached, which is iPadOS with iPadOS's decoder ration and a
 * primary pointer that is no longer coarse. `pointer: coarse` turns the guard
 * off there; `any-pointer: coarse` does not, because the touchscreen is still
 * attached and still the reason the ration exists.
 *
 * Erring towards true is free and erring towards false is a crash, which is
 * what makes `any-pointer` the right side to be wrong on: a desktop with a
 * touchscreen gets a clip whose source attaches on the first play, one frame
 * later than it would have.
 *
 * Deliberately not a user-agent test. Everything else in this codebase asks the
 * browser what it can do rather than what it is called, and Chrome on iOS is
 * WebKit underneath and would fail a Safari sniff while sharing every ration.
 */
let anyCoarse: MediaQueryList | null = null;
export function rationsDecoders(): boolean {
  if (typeof matchMedia !== 'function') return false;
  anyCoarse ??= matchMedia('(any-pointer: coarse)');
  return anyCoarse.matches;
}

/**
 * Whether the board is being looked at on a screen the size of a hand.
 *
 * The detail rung used to ask onTouch(), and that was the wrong question asked
 * for the right reason. Read the note on LOD_ZOOM_SMALL above: every word of it
 * is about the *screen* - a third the width, the board habitually further out,
 * chrome in screen pixels crowding a card. None of it is about fingers. Touch
 * was standing in for "phone", and it stopped being a good stand-in the moment
 * ordinary laptops shipped with touchscreens: Windows reports `pointer: coarse`
 * on a 15-inch 2-in-1 whenever it decides the keyboard is folded away or no
 * mouse is attached, so a desk machine silently ran the phone rung and dropped
 * every card's detail at 55% instead of 40%.
 *
 * So the rung asks about size, and takes touch as a *second* condition rather
 * than the only one - a small window on a desktop is still a desktop, and the
 * person who dragged it narrow did not ask for a different level of detail. Both
 * together are a phone and very little else.
 *
 * 640px is the app's existing narrow breakpoint (canvas/notes.js). Width alone,
 * not height: a laptop with devtools docked along the bottom is short and is not
 * a phone, and it is a machine this app is developed on every day. A phone held
 * in landscape falls back to the desk rung, which is the cheap side of the trade
 * - it is drawn in more detail than it strictly wants, rather than a desk being
 * stripped of detail it needs.
 */
let handheld: MediaQueryList | null = null;
export function onSmallScreen(): boolean {
  if (typeof matchMedia !== 'function') return false;
  handheld ??= matchMedia('(pointer: coarse) and (max-width: 640px)');
  return handheld.matches;
}

/**
 * Whether there is a phone's width to work with, whatever is pointing at it.
 *
 * The third of these three questions and the narrowest in scope: onTouch() asks
 * what is doing the poking, onSmallScreen() asks for both together to pick a
 * level of detail, and this asks only how wide the window is.
 *
 * Width alone is the right test for *which surface a control opens*. The
 * playlist has two homes - a floating window over the canvas, and a lens that
 * fills the screen - and a floating window is a thing that needs room around it.
 * A 380px window has no room whether it is a phone or a browser dragged narrow
 * on a desk, and the person who dragged it narrow gets the same answer as the
 * person holding a phone, which is the one they want in both cases. Touch has
 * nothing to say about it: a touchscreen laptop at full width has all the room
 * there is, and it was getting the phone's answer for no reason.
 *
 * Same 640px as the two rules above, for the reason given there.
 */
let narrow: MediaQueryList | null = null;
export function onNarrowScreen(): boolean {
  if (typeof matchMedia !== 'function') return false;
  narrow ??= matchMedia('(max-width: 640px)');
  return narrow.matches;
}

/** The rung in force, as a zoom factor. */
const lodZoom = () => (onSmallScreen() ? LOD_ZOOM_SMALL : LOD_ZOOM);

/** Below this, item chrome (labels, grips) is more noise than help. */
export const farZoom = () => lodZoom();
/** At or below this, animated pictures hold still - see canvas/stills.js. */
export const stillZoom = () => lodZoom();
/**
 * And below this a photograph is drawn from its hundred-pixel thumbnail
 * instead of its full-size self, which is the same swap by the same mechanism -
 * see the image renderer and the is-stilled rules in the CSS.
 */
export const thumbZoom = () => lodZoom();
// There is no webZoom. The connections used to leave on this rung with the
// labels and the grips, and they no longer leave at all - the far view is the
// one that shows the whole graph at once, which is where a drawn line earns the
// most rather than least. See the note where the fade band used to be in
// canvas/web.js.

// How long a commanded view move takes.
//
// Read from CSS rather than fixed here, so the board's own movement sits on
// the same whimsy axis as the interface's: sliding towards "plain" shortens
// these along with every transition in the CSS, instead of leaving the canvas
// animating at scrapbook speed inside a spec-sheet UI.
//
// A tapped zoom step glides instead of jumping: a discrete 1.3x cut gives you
// no idea which way the board went, where the same step animated stays
// legible. Fit, home and zoom-to-item can cross the whole board, so they get
// longer - the point of animating those is to show you the journey.
export const zoomMs = () => cssMs('--dur-zoom', 190);
export const travelMs = () => cssMs('--dur-travel', 400);

function cssMs(name: string, fallback: number): number {
  const raw = readToken(name);
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith('ms') ? n : n * 1000;   // CSS times are ms or s
}

/** Decelerating: fast off the mark, settling at the end. */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Viewport {
  el: HTMLElement;
  world: HTMLElement;
  originMark: HTMLElement | null;
  pan: Point;
  zoom: number;
  // Where the pointer last was, in client coordinates - written by
  // canvas/input.ts on every hover and read by import/drop.ts, which has no
  // view into that module's own `hover` and has to land a paste under the
  // cursor too. Null on a device with no cursor, and null until one moves.
  //
  // Declared here rather than left as a property input.ts bolts on, because
  // two modules already share it: one writes it and the other reads it, and
  // the object they share it through is this one.
  cursor: Point | null;
  // The padlock in the corner controls. Not a board setting and not saved
  // with one. A board does record the view it was left at, but deliberately
  // does not open at it - openingView() in main.js frames the whole thing
  // instead, for the reasons written there - so a lock restored from a file
  // would be holding a magnification the board had already declined to
  // reopen at. It lasts as long as the sitting does, which is also what it is
  // for: you lock the zoom because of what you are doing this afternoon.
  //
  // What it stops is the *zoom*, never the pan: the board still moves under
  // the hand, and travelling to an item or fitting the whole board still
  // works - they arrive at the locked magnification instead of choosing their
  // own. See the gates in zoomAt/zoomAnimAt/viewTo.
  zoomLocked: boolean;
  boardMode: LayoutMode;
  mobileWorldWidth: number;
  mobileWorldTop: number;
  mobileWorldBottom: number;
  width: number;
  height: number;
  left: number;
  top: number;
  // Where the Mobile board comes to rest under the chrome buttons. Cached
  // rather than asked for on every clamp: _mobileTopPan() runs on each frame
  // of a pan, and reading a rect there would measure layout mid-gesture.
  // Refreshed where it can actually change - a resize, a rotation, a switch
  // into Mobile - which is also where the buttons themselves move.
  _topPad: number;
  // One event, and its payload is the viewport that moved - see _paint().
  bus: Emitter<{ change: Viewport }>;
  _flush: () => void;
  _anim: number | null;             // rAF id of a view animation in flight
  _still: number;                   // timer that ends the cheap mode - see _moving()
  _iz: number;                      // what --iz was last written as
  _dpr: number;                     // what --dpr was last written as - see _setDpr()
  moving: boolean;                  // is the view mid-gesture? - see _moving()

  constructor(viewportEl: HTMLElement, worldEl: HTMLElement, originMark?: HTMLElement | null) {
    this.el = viewportEl;
    this.world = worldEl;
    this.originMark = originMark || null;
    this.pan = { x: 0, y: 0 };
    this.zoom = BASE_ZOOM;
    this.cursor = null;
    this.zoomLocked = false;
    this.boardMode = 'desktop';
    this.mobileWorldWidth = 0;
    this.mobileWorldTop = 0;
    this.mobileWorldBottom = 0;
    this.width = 0;
    this.height = 0;
    this.left = 0;
    this.top = 0;
    this._topPad = MOBILE_TOP_PAD;
    this.bus = emitter();
    this._flush = rafThrottle(() => this._paint());
    this._anim = null;
    this._still = 0;
    this._iz = 0;
    this._dpr = 0;
    this.moving = false;

    this.measure();
    const ro = new ResizeObserver(() => { this.measure(); this.apply(); });
    ro.observe(this.el);
    addEventListener('scroll', () => this.measure(), { passive: true });
  }

  measure() {
    const r = this.el.getBoundingClientRect();
    this.left = r.left;
    this.top = r.top;
    this.width = r.width;
    this.height = r.height;
    this._topPad = mobileTopPad();
    this._setDpr();
    if (this.boardMode === 'mobile') {
      this.zoom = this._mobileZoom();
      this._constrainMobile();
    }
  }

  get cx() { return this.width / 2; }
  get cy() { return this.height / 2; }
  get isMobile() { return this.boardMode === 'mobile'; }

  _mobileZoom() {
    return mobileZoom(this.width, this.mobileWorldWidth);
  }

  /** Screen-space height of the masthead standing above the board's top edge. */
  mobileHeaderPx() {
    return this.isMobile
      ? mobileHeaderHeight(this.mobileWorldWidth * this._mobileZoom())
      : 0;
  }

  /** Whether the Mobile strip is resting at its upper travel limit. */
  atMobileTop(tolerance = 0.5) {
    if (!this.isMobile) return false;
    return Math.abs((this.pan.y - this._mobileTopPan()) * this.zoom) <= tolerance;
  }

  /**
   * Highest pan that keeps the finite top edge just inside the viewport.
   *
   * A header lower than the edge itself: the top of a Mobile board is the
   * masthead, and the strip begins under it.
   */
  _mobileTopPan() {
    return this.mobileWorldTop
      + (this._topPad + this.mobileHeaderPx() - this.cy) / this.zoom;
  }

  /** Lowest pan that keeps the finite bottom edge just inside the viewport. */
  _mobileBottomPan() {
    return this.mobileWorldBottom + (this.cy - MOBILE_BOTTOM_PAD) / this.zoom;
  }

  _constrainMobile() {
    if (!this.isMobile) return;
    this.pan.x = 0;
    const top = this._mobileTopPan();
    // If the whole board fits vertically, pin it to the top instead of giving
    // it a small, meaningless travel range between two competing edges.
    const bottom = Math.min(this._mobileBottomPan(), top);
    this.pan.y = clamp(this.pan.y, bottom, top);
  }

  _setMobileBounds(worldWidth: number, worldTop: number, worldBottom: number) {
    this.mobileWorldWidth = Math.max(1, +worldWidth || 1);
    this.mobileWorldTop = Number.isFinite(+worldTop) ? +worldTop : 0;
    const bottom = Number.isFinite(+worldBottom) ? +worldBottom : this.mobileWorldTop;
    this.mobileWorldBottom = Math.min(bottom, this.mobileWorldTop);
  }

  /** Constrain the viewport to the content-sized Mobile board. */
  setBoardMode(
    // A string rather than a LayoutMode: the line below normalises anything
    // that is not 'mobile' to 'desktop', and the callers hand in a mode read
    // back out of a board.
    mode: string,
    worldWidth = this.mobileWorldWidth,
    worldTop = this.mobileWorldTop,
    worldBottom = this.mobileWorldBottom,
  ) {
    this.stopAnim();
    this.boardMode = mode === 'mobile' ? 'mobile' : 'desktop';
    this._setMobileBounds(worldWidth, worldTop, worldBottom);
    // The corner is laid out differently at the two modes - the menu button
    // comes back to the top on a phone - so the clearance is re-read here as
    // well as on a resize.
    this._topPad = mobileTopPad();
    if (this.isMobile) {
      this.zoom = this._mobileZoom();
      this._constrainMobile();
    }
    this.apply();
  }

  /** Refresh a Mobile board whose content has changed its lower edge. */
  setMobileBounds(worldWidth: number, worldTop: number, worldBottom: number) {
    this._setMobileBounds(worldWidth, worldTop, worldBottom);
    if (!this.isMobile) return;
    this.zoom = this._mobileZoom();
    this._constrainMobile();
    this.apply();
  }

  /** World point -> position within the viewport element, in CSS px. */
  toScreen(wx: number, wy: number): Point {
    return { x: (wx - this.pan.x) * this.zoom + this.cx, y: (this.pan.y - wy) * this.zoom + this.cy };
  }

  /** Client (event) coords -> world point. */
  toWorld(clientX: number, clientY: number): Point {
    const sx = clientX - this.left - this.cx;
    const sy = clientY - this.top - this.cy;
    return { x: sx / this.zoom + this.pan.x, y: this.pan.y - sy / this.zoom };
  }

  /** The world-space rectangle currently visible, grown by `margin` world px. */
  visibleRect(margin = 0): Bounds {
    const hw = this.cx / this.zoom + margin;
    const hh = this.cy / this.zoom + margin;
    return { x0: this.pan.x - hw, y0: this.pan.y - hh, x1: this.pan.x + hw, y1: this.pan.y + hh };
  }

  /**
   * Let go of the board while it is still moving, and it keeps going.
   *
   * `vx`/`vy` are the finger's speed at the moment it left the glass, in screen
   * pixels per second and in the same sense as panByScreen's deltas. Anything
   * slower than a deliberate flick is ignored, so putting a finger down, moving
   * the board somewhere and lifting still parks it exactly where it was left -
   * inertia is for throwing, not for every touch.
   *
   * The speed decays exponentially, which is what a board sliding against
   * friction actually does and, more to the point, is the only curve with no
   * end: it approaches a stop rather than arriving at one, so there is no frame
   * where the movement visibly stops being movement. The distance a flick buys
   * works out to its speed times GLIDE_TAU, so a hard one carries a screen or
   * two and a gentle one carries a hand's width, without either being a special
   * case.
   *
   * Integrated from the elapsed time rather than accumulated frame by frame.
   * Adding a step per frame would make the distance depend on the frame rate and
   * on how many frames the browser happened to drop, so the same flick would go
   * further on a good machine. This way the position at any instant is a
   * function of the clock, and a dropped frame costs smoothness rather than
   * distance.
   *
   * Held in this._anim like every other view animation, which is what makes it
   * interruptible for free: every path that touches the view directly - a new
   * finger, the wheel, a keyboard nudge - already calls stopAnim() first, so
   * catching a gliding board simply stops it where the hand landed.
   */
  glide(vx: number, vy: number) {
    if (this.isMobile) vx = 0;
    const speed = Math.hypot(vx, vy);
    if (speed < GLIDE_MIN || reducedMotion()) return;
    this.stopAnim();
    const x0 = this.pan.x, y0 = this.pan.y, z = this.zoom;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const decay = Math.exp(-t / GLIDE_TAU);
      // How far the finger's speed has carried the board by now, in screen px:
      // the integral of v0 * e^(-t/tau), which is v0 * tau * (1 - e^(-t/tau)).
      const travelled = GLIDE_TAU * (1 - decay);
      this.pan.x = this.isMobile ? 0 : x0 - vx * travelled / z;
      const nextY = y0 + vy * travelled / z;
      this.pan.y = nextY;
      this._constrainMobile();
      this.apply();
      const hitEdge = this.isMobile && nextY !== this.pan.y;
      this._anim = !hitEdge && speed * decay > GLIDE_STOP ? requestAnimationFrame(tick) : null;
    };
    this._anim = requestAnimationFrame(tick);
  }

  /** Move the view by a screen-space delta (drag). */
  panByScreen(dx: number, dy: number) {
    this.stopAnim();
    this.pan.x = this.isMobile ? 0 : this.pan.x - dx / this.zoom;
    this.pan.y += dy / this.zoom;   // screen y is down, world y is up
    this._constrainMobile();
    this.apply();
  }

  /** Zoom by `factor`, keeping the world point under (clientX, clientY) fixed. */
  zoomAt(clientX: number, clientY: number, factor: number) {
    if (this.zoomLocked || this.isMobile) return;
    this.stopAnim();
    const z = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom) return;
    const w = this.toWorld(clientX, clientY);
    const sx = clientX - this.left - this.cx;
    const sy = clientY - this.top - this.cy;
    this.pan.x = w.x - sx / z;
    this.pan.y = w.y + sy / z;
    this.zoom = z;
    this.apply();
  }

  setView(pan: Partial<Point> | null | undefined, zoom?: number) {
    this.stopAnim();
    // Number() rather than a unary plus, which is the same conversion written
    // in a form that admits a missing pan: a view arriving from a board file
    // may be half a view, and NaN || 0 is the fallback either way.
    this.pan.x = this.isMobile ? 0 : Number(pan?.x) || 0;
    this.pan.y = Number(pan?.y) || 0;
    this.zoom = this.isMobile
      ? this._mobileZoom()
      : clamp(Number(zoom) || BASE_ZOOM, MIN_ZOOM, MAX_ZOOM);
    this._constrainMobile();
    this.apply();
  }

  recenter(ms = 0) {
    this.viewTo({ x: 0, y: 0 }, BASE_ZOOM, ms);
  }

  // -------------------------------------------------------------------------
  // Animated moves
  //
  // Only ever driven by a deliberate command - a button, a keyboard shortcut,
  // "zoom to this item". Direct manipulation (drag, wheel, pinch) stays
  // instantaneous, because a hand on the board should never feel like it is
  // dragging the view through syrup; every one of those paths calls stopAnim()
  // so grabbing the canvas mid-flight takes over immediately.
  // -------------------------------------------------------------------------

  /** Halt any running view animation, leaving the view where it got to. */
  stopAnim() {
    if (this._anim == null) return;
    cancelAnimationFrame(this._anim);
    this._anim = null;
  }

  /** Drive `step(progress)` from 0 to 1 over `ms`, eased. */
  _animate(ms: number, step: (progress: number) => void) {
    this.stopAnim();
    if (!(ms > 0) || reducedMotion()) { step(1); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t === 1 ? 1 : ease(t));
      this._anim = t < 1 ? requestAnimationFrame(tick) : null;
    };
    this._anim = requestAnimationFrame(tick);
  }

  /**
   * Zoom about a screen point over `ms`, keeping that point pinned throughout -
   * so the thing you aimed at stays put for the whole flight, not just at the
   * ends. `ms = 0` snaps.
   */
  zoomAnimAt(clientX: number, clientY: number, factor: number, ms = 200) {
    if (this.zoomLocked || this.isMobile) return;
    const z0 = this.zoom;
    const z1 = clamp(z0 * factor, MIN_ZOOM, MAX_ZOOM);
    if (z1 === z0) return;
    const w = this.toWorld(clientX, clientY);
    const sx = clientX - this.left - this.cx;
    const sy = clientY - this.top - this.cy;
    this._animate(ms, e => {
      // Zoom is geometric, so the *exponent* is what gets interpolated. Walking
      // the zoom linearly instead makes a 2x step lurch at the start and crawl
      // at the end - the magnification rate has to be constant, not the number.
      this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
      this.pan.x = w.x - sx / this.zoom;
      this.pan.y = w.y + sy / this.zoom;
      this.apply();
    });
  }

  /** Zoom about the screen centre. */
  zoomBy(factor: number, ms = 0) {
    this.zoomAnimAt(this.left + this.cx, this.top + this.cy, factor, ms);
  }

  /**
   * Travel to an absolute view. `ms = 0` is setView().
   *
   * With the zoom locked this becomes a pure journey: the destination keeps its
   * pan and takes the magnification we are already at. That is what makes Fit,
   * Back to 0,0 and "go to this item" stay useful under the lock rather than
   * turning into dead buttons - you can still be taken somewhere, you just are
   * not resized on arrival. setView() below is left ungated on purpose: it is
   * the raw primitive, and the only thing that should be able to seat a view
   * wholesale is a board being opened.
   */
  viewTo(pan: Partial<Point> | null | undefined, zoom?: number, ms = 0) {
    // Number() for the reason setView() gives: the same conversion, written so
    // that a half a view is a case rather than an error.
    const x1 = this.isMobile ? 0 : Number(pan?.x) || 0;
    const z1 = this.isMobile
      ? this._mobileZoom()
      : this.zoomLocked ? this.zoom : clamp(Number(zoom) || BASE_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const requestedY = Number(pan?.y) || 0;
    let y1 = requestedY;
    if (this.isMobile) {
      const top = this._mobileTopPan();
      y1 = clamp(requestedY, Math.min(this._mobileBottomPan(), top), top);
    }
    if (!(ms > 0)) return this.setView({ x: x1, y: y1 }, z1);
    const x0 = this.pan.x, y0 = this.pan.y, z0 = this.zoom;
    if (x1 === x0 && y1 === y0 && z1 === z0) return;
    this._animate(ms, e => {
      this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
      this.pan.x = this.isMobile ? 0 : x0 + (x1 - x0) * e;
      this.pan.y = y0 + (y1 - y0) * e;
      this.apply();
    });
  }

  /**
   * Fit `items` (anything with x/y/w/h at its centre) in view with a margin.
  * With nothing to fit, falls back to the origin at BASE_ZOOM - 100% as printed.
  *
  * `maxZoom` caps how far in the fit is allowed to zoom. Left at MAX_ZOOM the
  * fit works as before, blowing a small board up to fill the screen. The
  * opening view passes BASE_ZOOM instead: a board smaller than the window opens
  * at 100% rather than magnified, so a couple of cards do not arrive as
  * wall-sized posters - while a board larger than the window still zooms out to
  * frame the whole of it, which is the case the cap never touches.
  */
  fit(items: readonly Box[] | null | undefined, pad = 80, ms = 0, maxZoom = MAX_ZOOM) {
    if (this.isMobile) {
      return this.viewTo({ x: 0, y: this._mobileTopPan() }, this._mobileZoom(), ms);
    }
    const box = items && items.length ? itemBounds(items) : null;
    if (!box) return this.recenter(ms);
    const { x0, y0, x1, y1 } = box;
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    const z = clamp(
      Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h),
      MIN_ZOOM,
      Math.min(MAX_ZOOM, maxZoom),
    );
    this.viewTo({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, z, ms);
  }

  /**
   * The origin as the chrome draws it, in CSS pixels: the visual centre of the
   * two axis rules.
   *
   * A method rather than two locals inside _paint(), because the grid has to
   * land on the same point and used to work it out separately - from the raw
   * `toScreen(0, 0)`. The two rounded differently and so they disagreed: the
   * rule snaps with `round(o - 0.5)` and the lattice snapped with `round(o)`,
   * which are the same integer only when the origin's fraction is under a half.
   * The other half of the time the axis was drawn a whole pixel to the side of
   * the column of marks it is supposed to run through, and on a still board
   * that is plainly visible - it is the one line on screen with something to be
   * compared against.
   *
   * Returns the centre, not the corner. A 1px rule at `top: N` covers N..N+1,
   * so the point it marks is N + 0.5, and every caller wants the point.
   */
  axisOrigin(): Point {
    const o = this.toScreen(0, 0);
    const d = deviceRatio();
    // Snapped in *device* pixels, then handed back in CSS ones. A CSS pixel is
    // not the grid the screen is made of once Windows is at 125% or a phone is
    // at 2.6, and rounding to it leaves the rule landing on a fractional device
    // row - where the rasteriser spreads one CSS pixel of ink over two rows and
    // the line goes from hairline to smudge and back as the board is panned.
    return { x: (Math.round(o.x * d - 0.5) + 0.5) / d, y: (Math.round(o.y * d - 0.5) + 0.5) / d };
  }

  /** Queue a repaint; safe to call many times per frame. */
  apply() { this._flush(); }

  /**
   * Say that the view is moving, and say when it has stopped.
   *
   * The class is what the CSS hangs its cheap mode off. What it turns off is
   * the caption plate's `backdrop-filter`, which is the single most expensive
   * thing on the board: a backdrop blur is not one effect for the page but one
   * per element, each of which makes the compositor sample and blur the pixels
   * behind that box - and on a board of photographs, every card has one. Still,
   * that costs nothing; the layer is composited once and reused. Under a zoom
   * it is recomputed for every card on screen on every frame, which is where a
   * few hundred items stop being smooth.
   *
   * A trailing timer rather than an end-of-gesture hook, because there is no
   * such hook: a wheel is a stream of unrelated events with no end, a pinch has
   * one but a momentum scroll does not, and the keyboard's zoom is neither.
   * What all of them have in common is a gap - so the gap is what is watched.
   *
   * Short enough that the blur is back before anybody has finished looking at
   * where they landed, long enough to bridge the pause between two wheel
   * notches. 140ms is both.
   */
  _moving() {
    if (!this._still) this.world.classList.add('is-viewing');
    // The same fact as the class, in a form a module can read without asking the
    // DOM. canvas/grid.js is the caller, and it runs inside the frame - a
    // classList test there would be a style read per frame to learn something
    // this object already knows.
    this.moving = true;
    clearTimeout(this._still);
    this._still = setTimeout(() => {
      this._still = 0;
      this.moving = false;
      this.world.classList.remove('is-viewing');
      // And the board is still, so chrome goes back to being exactly the size
      // it claims to be rather than within a rung of it - see IZ_STEP.
      this._setIz(1 / this.zoom);
      // One more pass over everything that draws the view, now that it has
      // stopped: this is the frame where the cheap versions are exchanged for
      // the proper ones. Announced directly rather than through apply(), which
      // would call this method again and restart the timer it is ending.
      this.bus.emit('change', this);
    }, VIEW_SETTLE_MS);
  }

  /**
   * Publish devicePixelRatio to the world layer.
   *
   * The stylesheet needs it for one thing only: rounding a hairline down to a
   * whole number of device pixels (--device-px in canvas.css). CSS can express
   * "one pixel" and cannot ask how many real ones that is, and on the fractional
   * display scalings Windows hands out - 125%, 150% - the answer is not a whole
   * number, so every one-pixel line on the board carries a quarter-pixel of grey
   * down one side of it however carefully the card underneath is positioned.
   *
   * Written from measure() rather than per frame: it is a property of the
   * screen, not of the view, and a display change - a drag to a second monitor,
   * a scaling change, a browser zoom - fires a resize, which is what calls this.
   * Guarded like --iz, so the ordinary resize writes nothing.
   */
  _setDpr() {
    // deviceRatio(), not the raw reading. Its own header says it is "one
    // definition, because two things snap to this grid and they have to agree
    // about where it is: the axis rules here, and the lattice of marks the grid
    // paints along them" - and this line, the one that publishes the ratio to
    // the stylesheet that draws those marks, was the one place not asking it. On
    // a display reporting 4, or a page zoomed to 50% and reporting 0.5,
    // axisOrigin() snapped against the clamped value while --device-px rounded
    // hairlines against the raw one, and the axis rule landed off the column of
    // marks it is meant to run down. Exactly the failure that header describes.
    const dpr = deviceRatio();
    if (dpr === this._dpr) return;
    this._dpr = dpr;
    // Stringified here rather than left to the DOM's own coercion, which is
    // what setProperty does with a number and is the only thing it can do.
    this.world.style.setProperty('--dpr', String(dpr));
  }

  /** Publish 1/zoom to the world layer, if it is not already what is there. */
  _setIz(iz: number) {
    if (iz === this._iz) return;
    this._iz = iz;
    this.world.style.setProperty('--iz', String(iz));
  }

  /**
   * Where the finite Mobile board falls on the screen right now, in CSS px.
   *
   * `top` and `bottom` are the two horizontal edges as screen rows, which is
   * why they are not a height: either can be off the screen, above it or below
   * it, and the chrome that reads them cares which.
   *
   * Public because the grid needs the same rectangle - a lattice is drawn
   * inside the board and nowhere else (see inkBox() in canvas/grid.js), and it
   * used to arrive at these four numbers by repeating the arithmetic below.
   */
  mobileScreenRect(): MobileScreenRect {
    const z = this.zoom;
    const width = this.mobileWorldWidth * z;
    return {
      left: this.cx - width / 2,
      width,
      top: (this.pan.y - this.mobileWorldTop) * z + this.cy,
      bottom: (this.pan.y - this.mobileWorldBottom) * z + this.cy,
    };
  }

  _paint() {
    const z = this.zoom;
    // The Mobile sheet and masthead used to be positioned from here, by five
    // custom properties written onto this.el - which is #viewport, an ancestor
    // of #world. Custom properties are inherited, so that was a computed-style
    // invalidation of every mounted card and everything inside it, on every
    // frame of every scroll, on the layout least able to afford one. They are
    // canvas/mobile-frame.js's business now, off a change listener like every
    // other piece of screen-space chrome, and nothing writes to #viewport on a
    // view frame any more.
    //
    // +panY (not -panY): items are laid out at cssY = -worldY, so the vertical
    // translate has to undo that flip as well as apply the pan.
    this.world.style.transform =
      `translate(${(-this.pan.x * z).toFixed(3)}px, ${(this.pan.y * z).toFixed(3)}px) scale(${z})`;
    // Item chrome multiplies by --iz to stay a constant size on screen. On a
    // rung of its own ladder while the board is moving, and exact again as soon
    // as it stops - see IZ_STEP, and _moving() below, which is what puts it
    // back.
    this._setIz(izRung(1 / z));
    this.world.classList.toggle('zoom-far', z < farZoom());
    // A second, lower rung just for the resize grips. Labels and the item bar
    // become noise once a card is a swatch (zoom-far, 40%), but the corners stay
    // worth grabbing much further out - a card at 15% is still a thing you resize.
    // So the grips ride their own threshold down to GRIP_MIN_ZOOM and vanish only
    // below it.
    this.world.classList.toggle('zoom-tiny', z < GRIP_MIN_ZOOM);
    // Below this a corner grip clips to its outside half and the whole card face
    // becomes a move target - see the zoom-grab rules in the CSS. Its own rung
    // (25%), lower than the chrome one, because it is about the card being too
    // small to grab, not too small to read.
    this.world.classList.toggle('zoom-grab', z < GRAB_ZOOM);
    this._moving();

    // The origin mark, centred on the point the axes cross.
    //
    // The rules themselves are not placed here any more. They are drawn, in
    // whole device pixels, by canvas/grid.js - see paintAxes() there for the
    // rounding problem that made an element the wrong tool for a hairline. What
    // is left is this: axisOrigin() hands back the *centre* of the device pixel
    // the crossing falls in, and the mark is centred on the same point, so the
    // crosshair passes exactly through the middle of the ring at every pan.
    const a = this.axisOrigin();
    if (this.originMark) {
      // Moved with a transform, not with left/top, and that is the whole fix
      // for a mark that sat visibly off its own crosshair.
      //
      // axisOrigin() lands on the *centre* of a device pixel, so the mark's box
      // - 36 wide, centred by a -18px margin - starts on a half pixel. A
      // browser does not paint a box on a half pixel: it snaps the border box
      // to the device grid, rounding half away from zero, so the ring and the
      // pip both moved half a pixel right and down of the crossing while the
      // rule stayed put. Half a pixel does not sound like much until you count
      // the clear space either side of the rule inside a 20px ring: eight
      // pixels on one side and nine on the other, at every zoom and every pan,
      // which is exactly the sort of thing the eye reads as "not centred"
      // without being able to say why.
      //
      // A transform is not snapped - it is applied to the paint context rather
      // than to a layout position - so the fractional part survives, and the
      // box itself sits at a whole pixel where the browser has nothing to
      // round.
      //
      // The centring rides along in the transform rather than staying behind
      // as the -18px margin it used to be, and that is not tidiness: a margin
      // is layout, so it is snapped too, and eighteen CSS pixels is twenty-two
      // and a half device ones at the 125% that half of Windows runs at. Half
      // a pixel back, by a different door. As a percentage of the element's own
      // box it is the same eighteen pixels without the size being restated
      // here, and it is spent inside the transform where nothing rounds it.
      this.originMark.style.transform =
        `translate(${a.x}px, ${a.y}px) translate(-50%, -50%)`;
    }

    this.bus.emit('change', this);
  }

  onChange(fn: (vp: Viewport) => void) { return this.bus.on('change', fn); }
}
