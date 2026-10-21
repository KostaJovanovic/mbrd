// Coordinate + viewport model. World coords are floats at (0,0) centre,
// +y up (screen y inverted here and in items.ts/place() only). #world is a
// translate+scale, and one GPU layer only while the view moves (see _pin).
// Items lay out at cssY = -worldY, so the vertical translate is +panY*zoom.

import { clamp, cssMs, rafThrottle, emitter, reducedMotion } from '../util.ts';
import { qualityLevel } from '../quality.ts';
import type { Emitter } from '../util.ts';
import { itemBounds } from '../geometry.ts';
import type { Box, Bounds, Point } from '../geometry.ts';
import type { LayoutMode } from '../board-model.ts';

/**
 * The board's sheet as the screen sees it - what mobileScreenRect() answers.
 *
 * Declared here rather than in canvas/mobile-frame.ts (which reads most of it)
 * because that module already imports this one, and a reverse type-only import
 * would be a cycle (tests/layers.test.js counts it as an edge).
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
 * Used to be 0.8 (a rebase so a board at scale 0.8 read "100%"); now 100% is
 * true 1:1, one world unit per CSS pixel, and `zoom` stays the real
 * world-to-screen scale everywhere (transform, toScreen/toWorld, saved `view`).
 * Consequence: a board saved under the old rebase now prints a different
 * percentage for the same scale (0.8 was "100%", now reads 80%) - the drawing
 * is unchanged, only the label is honest now.
 *
 * Kept as a named constant rather than folded into bare 1s, so `vp.fit(items,
 * 80, 0, BASE_ZOOM)` reads as "open at 100%". Things measured in real screen
 * pixels (grid MIN_PX/MAX_PX, paper.ts's page outline, the scale bar) compose
 * with raw zoom instead, deliberately.
 */
export const BASE_ZOOM = 1;

export const MIN_ZOOM = 0.1 * BASE_ZOOM;   // 10% as printed
export const MAX_ZOOM = 5 * BASE_ZOOM;     // 500% as printed

/**
 * How much board is kept mounted beyond the screen edge, to hide pop-in, in
 * *screen* pixels - converted to world units per call. Used to be a flat 400
 * world units, which grew relative to the visible area as you zoomed in (about
 * 2.5 screens at 100%, 5 at 200%); screen pixels is the unit the pop-in it
 * hides actually happens in.
 */
const CULL_MARGIN_PX = 300;

/**
 * Ceiling on the margin above, in world units (the old flat value). Below about
 * three-quarter zoom a constant screen margin would be wider than 400 world
 * units for no benefit, so this caps it there - never worse than before, at any
 * zoom.
 */
const CULL_MARGIN_MAX = 400;

/**
 * That margin in world units at the current zoom. Exported here because
 * canvas/items.ts and canvas/web.ts both cull against it - separate copies had
 * drifted apart before. The null guard matters: `vp` arrives in each module's
 * init(), and this can be reached from a repaint scheduled before that wiring
 * is done.
 */
export const cullMargin = (vp: Viewport | null): number =>
  Math.min(CULL_MARGIN_PX / (vp ? vp.zoom : 1), CULL_MARGIN_MAX);
const MOBILE_SIDE_PAD = 16;
const MOBILE_TOP_PAD = 32;
const MOBILE_BOTTOM_PAD = 32;

/**
 * How far below the chrome buttons a Mobile board comes to rest.
 *
 * MOBILE_TOP_PAD alone put the masthead level with the menu button and pencil,
 * reading as one row; the board now stops below them instead, with the gap
 * above the masthead. Measured off the button rather than hardcoded, because
 * the buttons are pinned at max(12px, env(safe-area-inset-top)) in mobile.css
 * and a notched phone pushes them further down.
 */
const MOBILE_CHROME_GAP = 14;

function mobileTopPad(): number {
  if (typeof document === 'undefined') return MOBILE_TOP_PAD;
  const btn = document.getElementById('menu-btn');
  const bottom = btn ? btn.getBoundingClientRect().bottom : 0;
  // Zero means the button isn't laid out yet (or isn't there); fall back to the plain pad.
  return bottom > 0 ? bottom + MOBILE_CHROME_GAP : MOBILE_TOP_PAD;
}

/**
 * The masthead above a Mobile board, sized from the board itself: a 3:2
 * landscape rectangle measured off the fitted board width, so its shape is
 * identical regardless of phone height. Room for it is made here, in the pan
 * clamp, rather than by moving the board's top edge - the strip still starts
 * where mobileBoardTop() says and state.ts never has to know a header exists.
 */
export const MOBILE_HEADER_ASPECT = 3 / 2;

/** Height in screen px of a 3:2 Mobile masthead `boardWidth` px wide. */
export function mobileHeaderHeight(boardWidth: number): number {
  return Math.max(0, (+boardWidth || 0) / MOBILE_HEADER_ASPECT);
}

/**
 * Fixed zoom that seats a Mobile board in the viewport without enlarging it.
 *
 * Written against a literal 1, not BASE_ZOOM (same for LOD_ZOOM_SMALL below):
 * Mobile has no zoom control or printed percentage, so this 1 means true 1:1,
 * not the display label. They now agree by coincidence, not by being the same
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
 * - `legacyVars` puts back the *cost* of what canvas/mobile-frame.ts replaced:
 *   the five custom properties written on #viewport on every frame. Nothing
 *   reads them any more, so this changes no picture - it re-creates only the
 *   invalidation. #viewport is an ancestor of #world and custom properties are
 *   inherited, so writing one there invalidates the computed style of every
 *   mounted card, once a frame, on a layout that has no zoom - the same cost
 *   --iz carries, for nothing. Turn it on to measure what taking it away
 *   bought, on the device it was taken away for.
 * - `chrome` false hides the Mobile sheet and masthead and skips their writes
 *   entirely: the upper bound on what the chrome can still be costing.
 * - `gridPos` false leaves the lattice in canvas/grid.ts as it was drawn for
 *   the length of a move, which is its per-frame repaint. The name is from
 *   when that repaint was a background-position write.
 */
export const mobilePerfFlags = { legacyVars: false, chrome: true, gridPos: true };

/** How long after the last view change the board counts as still. See _moving(). */
const VIEW_SETTLE_MS = 140;

/**
 * How far the zoom may travel from the scale #world was last rastered at before
 * it is rastered again, mid-gesture - see _pin().
 *
 * Out is the one that matters: a layer pinned at 100% and zoomed out to 25% asks
 * for sixteen screens of texture, past what Chromium on a phone will hold, and
 * the compositor stops drawing cards (`tile memory limits exceeded`) - the blink.
 * Measured on a Galaxy S10: pinned 1 -> 0.25 gave a hundred of those warnings per
 * zoom, re-pinned at every halving about fifteen. In only costs sharpness, which
 * the release restores, so it is allowed to go further before paying a raster.
 *
 * Out is measured from the highest zoom since the last raster, not from the
 * zoom the pin was taken at, because the pin does not hold a zoom-in: Chromium
 * rasters the layer sharper as it grows and keeps that scale on the way back
 * out. A pinch from fit to 3x and back, pinned at fit, ended at fit with the
 * texture of 3x - nine screens of it. On a Nothing Phone (4a) at Balanced,
 * 2026-10-17, that pinch drew 80 to 150 frames with tiles missing; re-pinned
 * from the peak, 5 to 12.
 *
 * Two ways to earn the re-pin, because each one costs a raster, which at 35%
 * on that phone took a 1 Hz pinch-in-and-out from 5% of frames missed to 20-30%
 * when it re-pinned on every swing. A zoom-out that has kept going for
 * PIN_OUT_RUN_MS is a pinch out, and gets one at every PIN_OUT; a swing that
 * turns back sooner gets one only past PIN_OUT_DEEP of the gesture's peak.
 *
 * Each of those rasters is a screen of cards drawn afresh at the phone's
 * density, and the view stands still until it lands: 50-150ms on a Nothing
 * Phone (4a), worst where the most cards are in view, so a pinch out from 100%
 * hitched at 41% and 33%. PIN_OUT was 1.25. At 1.5, measured there at Balanced
 * on a page reloaded before every pinch (a warm page reuses the tiles a
 * previous zoom left, and hides the cost): frames over 50ms, 100% to 30%, 11-18
 * to 6-10, the worst 110-130ms to 75-80; and fewer rasters is less tile churn,
 * so a pinch from 50% to 20% drew tiles missing 33-39 times to 1-5. At 1.8 each
 * raster is a bigger one (worst 160ms), and the missing tiles came back (19-23).
 */
const PIN_OUT = 1.5;
const PIN_OUT_RUN_MS = 600;
const PIN_OUT_DEEP = 1.8;
const PIN_IN = 4;
/** In at Full off a touch screen, which spends a raster per quarter of zoom so
 *  a zoom-in sharpens as it goes rather than on release. Not on touch: a
 *  re-raster mid-pinch is the phone's hitch, and sharpening on release is how
 *  a pinch stays smooth there - at Full too, which is every phone's default. */
const PIN_IN_FULL = 1.25;

/** Whether the view may sharpen while it moves - see PIN_IN_FULL. */
export const sharpensMidGesture = () => qualityLevel() === 'full' && !onTouch();

/**
 * How far below the scale it was rastered at a gesture may zoom before the
 * shadow twins leave - see _shadowsOut(). Enough that a pinch's own wobble
 * does not pull them, well short of where they would cost anything.
 */
const SHADOWS_OUT = 0.9;

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
 * How far the board follows a finger that has gone `over` past its own edge,
 * given a screen `dim` to scale the resistance against.
 *
 * Diminishing, so it never stops following and never keeps up: the first pixels
 * past the edge come at about `k` of the finger, and no amount of pull moves it
 * more than one screen, which is the asymptote of this ratio. Both properties
 * matter and they are the same property said twice - a board that stopped dead
 * would say the gesture had failed, and one that kept up would say there was no
 * edge there at all. What the hand is told is "there is more of this, and it is
 * ending".
 *
 * Pure, and in world units in and out: the caller divides by the zoom once.
 */
const RUBBER_K = 0.55;
const give = (over: number, dim: number, k = RUBBER_K) =>
  (over * dim * k) / (dim + k * Math.abs(over));

/**
 * How fast the board comes back after being let go past its edge.
 *
 * Critically damped rather than eased over a duration, because the settle has to
 * start from a *speed* as well as a position - it is what a flick into the
 * boundary hands over to, and _animate() takes a duration and no velocity. A
 * critically damped return is the one curve that accepts both and never
 * overshoots, which is the whole requirement: a board that bounced back past its
 * own edge would have to be caught twice.
 */
const SETTLE_TAU = 0.15;
/** Close enough to the edge to write the edge itself and stop. World px. */
const SETTLE_EPS = 0.25;

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
// thresholds five hundredths apart that nobody could perceive as two, and that
// made "zoomed out" mean something slightly different depending on which module
// was asking. Kept as separate names because separate modules import them for
// separate purposes; they are one number and should move together, and the day
// one of them genuinely wants to differ it can, without the other two
// silently coming with it.

/** Where the rung sits with a mouse in hand. */
const LOD_ZOOM = 0.4 * BASE_ZOOM;

/**
 * The swatch rung: below it a card is picture, tint or paper and nothing else -
 * no head, no tour mark (the zoom-tiny rules in the CSS).
 */
const SWATCH_ZOOM = 0.1 * BASE_ZOOM;

/**
 * How far out a selected card can still be resized.
 *
 * Well below the chrome rung (LOD_ZOOM), since a card with no room for a label
 * still has corners worth reaching for. But at 15% the whole board is in view
 * and the card is being carried across it, not sized, and a grip there covers
 * more of the card than the card shows. So the grips go, and the ring says so -
 * see the zoom-no-resize rules in the CSS. 0.155 because the corner prints a
 * rounded percentage: everything that reads "15%" is past the rung.
 */
const RESIZE_MIN_ZOOM = 0.155 * BASE_ZOOM;

/**
 * And under a finger, twice as far in. A fingertip covers a grip and much of
 * the card at once, so from 30% down a press on a picked card means carry it,
 * and a corner caught by accident does not resize what was meant to move.
 * 0.295 by the same rounding as above: "30%" still resizes, "29%" does not.
 */
const RESIZE_MIN_ZOOM_TOUCH = 0.295 * BASE_ZOOM;

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
 * decoders at once, which is why canvas/renderers.ts parks a clip's source
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
 * 640px is the app's existing narrow breakpoint (canvas/notes.ts). Width alone,
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
/** At or below this, animated pictures hold still - see canvas/stills.ts. */
export const stillZoom = () => lodZoom();
/**
 * And below this a photograph is drawn from its hundred-pixel thumbnail
 * instead of its full-size self - the is-thumbs rules in the CSS, set by
 * canvas/stills.ts. The rung everywhere but Full, which keeps the picture down
 * to FULL_THUMB_ZOOM: the stop that asked for fidelity over speed.
 */
const FULL_THUMB_ZOOM = 0.2 * BASE_ZOOM;
export const thumbZoom = (full = false) => (full ? FULL_THUMB_ZOOM : lodZoom());
// There is no webZoom. The connections used to leave on this rung with the
// labels and the grips, and they no longer leave at all - the far view is the
// one that shows the whole graph at once, which is where a drawn line earns the
// most rather than least. See the note where the fade band used to be in
// canvas/web.ts.

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
//
// Both answer 0 under prefers-reduced-motion: the CSS flatten (status.css)
// cannot reach a duration read here, so the reading itself has to.
export { reducedMotion };
export const zoomMs = () => (reducedMotion() ? 0 : cssMs('--dur-zoom', 190));
export const travelMs = () => (reducedMotion() ? 0 : cssMs('--dur-travel', 400));
/** --dur-fast in ms: a fade standing in for a flight. Not zeroed for reduced
 *  motion - a fade is what reduced motion keeps - but Quality's flatten reaches it. */
export const fastMs = () => cssMs('--dur-fast', 130);
/** --dur-base in ms, for a JS-timed fade that should keep the interface's pace. */
export const baseMs = () => cssMs('--dur-base', 240);

/** Decelerating: fast off the mark, settling at the end. */
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export class Viewport {
  el: HTMLElement;
  world: HTMLElement;
  originMark: HTMLElement | null;
  /** #web-plane: the connection lines, moved with #world but never pinned with it - see _paint(). */
  plane: HTMLElement | null;
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
  // does not open at it - openingView() in main.ts frames the whole thing
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
  _winH: number;                    // the window's height at the last measure()
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
  _zoomTo: number | null;           // where a running zoom step is heading - see zoomAnimAt()
  // Where the finger has dragged to, before the edges take anything off it, and
  // null whenever no finger is down - which is what `dragging` reads. See
  // _constrainMobile() for why the raw value has to be the one kept.
  _rawY: number | null;
  _still: number;                   // timer that ends the cheap mode - see _moving()
  _changes: number;                 // view changes counted, so a late timer can tell - see _moving()
  _pinned: number;                  // the zoom #world's layer was rastered at, 0 unpinned - see _pin()
  _repin: number;                   // rAF id of a re-pin in flight - see _pin()
  _peak: number;                    // highest zoom since the last raster - see _pin()
  _top: number;                     // highest zoom this gesture - see _pin()
  _outAt: number;                   // when the zoom-out in progress began, 0 none - see _pin()
  _outLow: number;                  // and the lowest zoom it has reached
  _shadowsHidden: boolean;          // #item-shadows taken off for a far gesture - see _shadowsOut()
  _iz: number;                     // what --iz was last written as
  _dpr: number;                     // what --dpr was last written as - see _setDpr()
  moving: boolean;                  // is the view mid-gesture? - see _moving()
  holding: boolean;                 // is this paint the box resizing under a board held still? - see the ResizeObserver
  // How far an open panel reaches in from the window's left edge, in client px.
  // ui/sidebar.ts injects it. Fit, recenter and the zoom buttons centre in the
  // room that leaves - see _shift(). Unwired it is 0, and the room is the window.
  _cover: () => number;

  constructor(viewportEl: HTMLElement, worldEl: HTMLElement, originMark?: HTMLElement | null, plane?: HTMLElement | null) {
    this.el = viewportEl;
    this.world = worldEl;
    this.originMark = originMark || null;
    this.plane = plane || null;
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
    this._winH = 0;
    this._topPad = MOBILE_TOP_PAD;
    this._rawY = null;
    this.bus = emitter();
    this._flush = rafThrottle(() => this._paint());
    this._anim = null;
    this._zoomTo = null;
    this._still = 0;
    this._changes = 0;
    this._pinned = 0;
    this._repin = 0;
    this._peak = 0;
    this._top = 0;
    this._outAt = 0;
    this._outLow = 0;
    this._shadowsHidden = false;
    this._iz = 0;
    this._dpr = 0;
    this.moving = false;
    this.holding = false;
    this._cover = () => 0;

    this.measure();
    const ro = new ResizeObserver(() => {
      if (!this.measure()) { this.apply(); return; }
      // The board held where it was as its box changed height. Painted here,
      // not queued: this runs after the new box is laid out and before it is
      // drawn, and a paint queued for the next frame drew one frame of the
      // board in the new box at the old pan - half the Timeline's band out of
      // place, and back the frame after. Every fifteen seconds of rest, since
      // that is when the band is given (ui/idle.ts). Nothing moved, so not the
      // gesture mode (_moving()), and not activity to anybody listening.
      this.holding = true;
      try { this._paint(); } finally { this.holding = false; }
    });
    ro.observe(this.el);
    addEventListener('scroll', () => this.measure(), { passive: true });
  }

  /** Read the box. Whether it held the board still through a change of height. */
  measure() {
    let held = false;
    const r = this.el.getBoundingClientRect();
    // The box changed height under a window that did not: the Timeline's band
    // given to the board or taken back (canvas.css). Its top is where it was,
    // so hold what is on screen there rather than re-centring, which slid the
    // whole board half a band every time the bar faded or came back. Through
    // globalThis because the tests build a Viewport with no window.
    const winH = globalThis.innerHeight ?? 0;
    if (!this.isMobile && this.height > 0 && r.height !== this.height
        && r.top === this.top && r.width === this.width && winH === this._winH) {
      this.pan.y -= (r.height - this.height) / 2 / this.zoom;
      held = true;
    }
    this._winH = winH;
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
    return held;
  }

  get cx() { return this.width / 2; }
  get cy() { return this.height / 2; }
  get isMobile() { return this.boardMode === 'mobile'; }

  /** Say how far an open panel covers the viewport's left edge - see _cover. */
  setCover(cover: () => number) { this._cover = cover; }

  /**
   * How far the middle of the room a panel leaves sits right of the middle of
   * the viewport, in CSS px. Asked when a view is framed rather than tracked,
   * so it is right however the panel came to be open. 0 on a Mobile board,
   * which is framed by its own rules.
   */
  _shift() {
    if (this.isMobile) return 0;
    return clamp(this._cover() - this.left, 0, this.width) / 2;
  }

  /**
   * The part of the viewport the board can be seen in, in client px: its box
   * less an open panel's reach on the left, as _shift() reads it. What a drag
   * held at an edge pans against (canvas/edge-pan.ts).
   */
  room() {
    const cover = this.isMobile ? 0 : clamp(this._cover() - this.left, 0, this.width);
    return {
      left: this.left + cover, top: this.top,
      right: this.left + this.width, bottom: this.top + this.height,
    };
  }

  /**
   * viewTo(), with `point` landing in the middle of that room rather than of
   * the viewport. The offset is in world units at the zoom the journey ends
   * on, which the zoom lock can overrule, so that is decided here the way
   * viewTo() decides it.
   */
  _frame(point: Point, zoom: number, ms: number) {
    const z = this.zoomLocked ? this.zoom : clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.viewTo({ x: point.x - this._shift() / z, y: point.y }, zoom, ms);
  }

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

  /**
   * The Mobile board's two travel limits.
   *
   * If the whole board fits vertically, `bottom` is pinned to `top` instead of
   * giving it a small, meaningless travel range between two competing edges -
   * which is also what makes a short board resist in both directions rather
   * than in neither.
   */
  _mobileBounds() {
    const top = this._mobileTopPan();
    return { top, bottom: Math.min(this._mobileBottomPan(), top) };
  }

  /**
   * Hold the Mobile board inside its own edges - hard when nothing is touching
   * it, softly while a finger is.
   *
   * The soft half is the whole of what a boundary should say. Clamping while the
   * finger is still moving is the board announcing that the gesture stopped
   * working, and the finger is the only thing on screen that did not stop; the
   * eye reads that as the app having dropped the touch. So past an edge the
   * board keeps following at a diminishing fraction - see give() - and comes
   * back when it is let go.
   *
   * The overshoot is measured from `_rawY`, which is where the finger has
   * actually dragged to, not from `pan.y`, which is where the resistance last
   * put it. Damping an already damped value compounds: the board would resist
   * more the longer you held it at the same place, and the two would converge on
   * a point the finger was nowhere near.
   */
  _constrainMobile() {
    if (!this.isMobile) return;
    this.pan.x = 0;
    const { top, bottom } = this._mobileBounds();
    if (this._rawY === null) {
      this.pan.y = clamp(this.pan.y, bottom, top);
      return;
    }
    // A screen's worth of world, which is what the resistance is scaled against:
    // the same drag past the edge should feel the same on a tall screen and a
    // short one, and it is the *screen* the finger is crossing.
    const dim = this.height / this.zoom;
    const y = this._rawY;
    if (y > top) this.pan.y = top + give(y - top, dim);
    else if (y < bottom) this.pan.y = bottom - give(bottom - y, dim);
    else this.pan.y = y;
  }

  /**
   * Whether a finger is on the board this moment.
   *
   * Written by canvas/input.ts at the two ends of a gesture and nowhere else -
   * it is one line in enter(), which is the pipeline's single door between
   * modes, so there is no path that can set it and forget to clear it.
   *
   * A setter rather than a field because turning it on has to remember where the
   * board was: `_rawY` is the undamped pan the resistance is measured from, and
   * it exists only for as long as the finger does. Turning it off is a release,
   * so it asks the board to come home - which does nothing at all unless the
   * board is actually being held past an edge, and is overruled a moment later
   * by glide() if the lift turned out to be a throw.
   */
  get dragging() { return this._rawY !== null; }

  set dragging(on: boolean) {
    if (on === (this._rawY !== null)) return;
    // A settle that onPress() let run must not keep moving pan.y under a finger
    // whose `_rawY` is read from the frame it took hold.
    if (on) this.stopAnim();
    this._rawY = on ? this.pan.y : null;
    if (!on) this._settleMobile();
  }

  /**
   * Bring the board back inside its edges from wherever it is, at whatever speed
   * it is already moving.
   *
   * `v0` is world units per second, in pan.y's own sense, and is what makes this
   * a hand-over rather than a new animation: a flick that runs into the boundary
   * stops being a flick at the frame it crosses and becomes this, from the same
   * position and the same speed. Starting a fresh eased move to the edge would
   * put a corner in a motion the hand is still watching, which is the jump this
   * whole thing exists to remove.
   *
   * Critically damped: x(t) = (A + Bt)e^(-t/tau), with A the overshoot and B the
   * speed corrected for the decay's own contribution. It approaches the edge
   * without crossing it for any starting speed, including one still travelling
   * *away* from the board.
   *
   * Reduced motion snaps instead, which is the distinction tokens.css already
   * draws by collapsing durations and leaving --btn-press alone: the answer to
   * "less motion" is not "no correction". A board left hanging past its own edge
   * because somebody asked for less movement is a board that has to be dragged
   * back by hand.
   */
  _settleMobile(v0 = 0) {
    if (!this.isMobile || this._rawY !== null) return;
    const { top, bottom } = this._mobileBounds();
    const edge = this.pan.y > top ? top : this.pan.y < bottom ? bottom : null;
    if (edge === null) return;
    this.stopAnim();
    const over = this.pan.y - edge;
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
      this.pan.y = edge;
      this.apply();
      return;
    }
    const b = v0 + over / SETTLE_TAU;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const offset = (over + b * t) * Math.exp(-t / SETTLE_TAU);
      const done = Math.abs(offset) < SETTLE_EPS;
      this.pan.y = done ? edge : edge + offset;
      this.apply();
      this._anim = done ? null : requestAnimationFrame(tick);
    };
    this._anim = requestAnimationFrame(tick);
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

  /** The board point at the middle of the room the panels leave, where a
   *  thing added with no pointer to place it lands. toWorld() of that middle. */
  centreWorld(): Point {
    return { x: this.pan.x, y: this.pan.y };
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
      // The frame the throw runs out of board is where the throw ends and the
      // settle begins, from this position and at this speed - not a new eased
      // move to the edge, which would put a corner in a motion the hand is
      // still watching. The flick's speed right now is its initial speed times
      // the decay, in world units because that is what pan.y is in.
      if (this.isMobile) {
        const { top, bottom } = this._mobileBounds();
        if (nextY > top || nextY < bottom) {
          this.apply();
          this._anim = null;
          this._settleMobile(vy * decay / z);
          return;
        }
      }
      this._constrainMobile();
      this.apply();
      this._anim = speed * decay > GLIDE_STOP ? requestAnimationFrame(tick) : null;
    };
    this._anim = requestAnimationFrame(tick);
  }

  /** Move the view by a screen-space delta (drag). */
  panByScreen(dx: number, dy: number) {
    this.stopAnim();
    this.pan.x = this.isMobile ? 0 : this.pan.x - dx / this.zoom;
    const step = dy / this.zoom;    // screen y is down, world y is up
    // The finger's own total goes on `_rawY` while there is a finger, and
    // _constrainMobile() decides what of it the board is allowed to show. Every
    // other caller of this - the wheel, a trackpad, a keyboard nudge - leaves
    // `_rawY` null and takes the hard clamp, which is right: none of them is a
    // continuous gesture that a rubber band would be telling anything.
    if (this._rawY !== null) this._rawY += step;
    this.pan.y += step;
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

  /**
   * Zoom to a pinch's `raw` total about (clientX, clientY). Inside the limits it
   * is that zoom; past one the board gives on a diminishing band (give(), in
   * log space, so at most twice past the limit) rather than stopping dead under
   * fingers that are still spreading. settleZoom() takes it back on release.
   */
  pinchTo(clientX: number, clientY: number, raw: number) {
    if (this.zoomLocked || this.isMobile) return;
    this.stopAnim();
    const limit = raw > MAX_ZOOM ? MAX_ZOOM : raw < MIN_ZOOM ? MIN_ZOOM : 0;
    const z = limit ? limit * Math.exp(give(Math.log(raw / limit), Math.LN2)) : raw;
    if (!(z > 0) || z === this.zoom) return;
    const w = this.toWorld(clientX, clientY);
    const sx = clientX - this.left - this.cx;
    const sy = clientY - this.top - this.cy;
    this.pan.x = w.x - sx / z;
    this.pan.y = w.y + sy / z;
    this.zoom = z;
    this.apply();
  }

  /** Bring a zoom pinchTo() left past a limit back to it, about the given
   *  point, over zoomMs() (a snap under reduced motion). Nothing otherwise. */
  settleZoom(clientX: number, clientY: number) {
    const z = clamp(this.zoom, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom || this.isMobile) return;
    this.zoomAnimAt(clientX, clientY, z / this.zoom, zoomMs());
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
    this._frame({ x: 0, y: 0 }, BASE_ZOOM, ms);
  }

  /** A board point to the middle of the room the panels leave, at the zoom already set. */
  centreOn(point: Point, ms = 0) {
    this._frame(point, this.zoom, ms);
  }

  // -------------------------------------------------------------------------
  // Animated moves
  //
  // Driven by a deliberate step - a button, a keyboard shortcut, "zoom to this
  // item". Direct manipulation (wheel, drag, pinch, a pad's two-finger stream) stays
  // instantaneous, because a hand on the board should never feel like it is
  // dragging the view through syrup; every one of those paths calls stopAnim()
  // so grabbing the canvas mid-flight takes over immediately.
  // -------------------------------------------------------------------------

  /** Halt any running view animation, leaving the view where it got to. */
  stopAnim() {
    this._zoomTo = null;
    if (this._anim == null) return;
    cancelAnimationFrame(this._anim);
    this._anim = null;
  }

  /**
   * What a press does to the view: it stops whatever is moving it, but a Mobile
   * board past its edge still comes home. A press that became no pan (a widget,
   * a selected card) used to leave it hanging there, since only the end of a pan
   * asks for the settle.
   */
  onPress() {
    this.stopAnim();
    this._settleMobile();
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
    // A step pressed while one is still flying builds on where that one was
    // going, not where it had got to - so a held key or fast clicks zoom by the
    // same amount whatever the repeat rate. _animate() below calls stopAnim(),
    // which clears it.
    const from = this._anim != null && this._zoomTo != null ? this._zoomTo : z0;
    const z1 = clamp(from * factor, MIN_ZOOM, MAX_ZOOM);
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
      if (e === 1) this._zoomTo = null;
    });
    // Only while a flight is actually running: a snap has already landed.
    this._zoomTo = this._anim != null ? z1 : null;
  }

  /** Zoom about the middle of the room an open panel leaves - see _shift(). */
  zoomBy(factor: number, ms = 0) {
    this.zoomAnimAt(this.left + this.cx + this._shift(), this.top + this.cy, factor, ms);
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
    // Zoom and pan together as one zoom about the point that stays put on
    // screen from start to end: (f - p0) z0 = (f - p1) z1. Walking the pan
    // linearly while the zoom went geometrically swung the destination out
    // from the centre before bringing it in, so the eye lost the very thing it
    // was being taken to. Barely any zoom change puts f far away, so that case
    // keeps the plain pan.
    const pivot = !this.isMobile && Math.abs(Math.log(z1 / z0)) > 1e-3;
    const fx = pivot ? (x1 * z1 - x0 * z0) / (z1 - z0) : 0;
    const fy = pivot ? (y1 * z1 - y0 * z0) / (z1 - z0) : 0;
    this._animate(ms, e => {
      this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
      if (e === 1) {
        this.pan.x = this.isMobile ? 0 : x1;
        this.pan.y = y1;
      } else if (pivot) {
        this.pan.x = fx - (fx - x0) * z0 / this.zoom;
        this.pan.y = fy - (fy - y0) * z0 / this.zoom;
      } else {
        this.pan.x = this.isMobile ? 0 : x0 + (x1 - x0) * e;
        this.pan.y = y0 + (y1 - y0) * e;
      }
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
  *
  * Framed in the room an open panel leaves, not the whole viewport - see
  * _shift().
  */
  fit(items: readonly Box[] | null | undefined, pad = 80, ms = 0, maxZoom = MAX_ZOOM) {
    if (this.isMobile) {
      return this.viewTo({ x: 0, y: this._mobileTopPan() }, this._mobileZoom(), ms);
    }
    const box = items && items.length ? itemBounds(items) : null;
    if (!box) return this.recenter(ms);
    const { x0, y0, x1, y1 } = box;
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    const room = this.width - this._shift() * 2;
    const z = clamp(
      Math.min((room - pad * 2) / w, (this.height - pad * 2) / h),
      MIN_ZOOM,
      Math.min(MAX_ZOOM, maxZoom),
    );
    this._frame({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, z, ms);
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
    // DOM. canvas/grid.ts is the caller, and it runs inside the frame - a
    // classList test there would be a style read per frame to learn something
    // this object already knows.
    this.moving = true;
    this._pin();
    clearTimeout(this._still);
    const seen = ++this._changes;
    // The gap can be a stall rather than a stop. A frame that takes longer than
    // the gap - a raster, a decode - lets this timer fire before the gesture's
    // next move has been read, and the board settled mid-pinch: unpinned,
    // re-rastered whole at the new zoom, the rungs flipped and the display
    // copies landed, which made the next frames long too, and so on down the
    // gesture. So the timer asks one frame more: a move read in that frame was
    // a gesture still going, and it has restarted this timer already. Measured
    // on a Nothing Phone (4a) at Balanced, 2026-10-16: the zoom sweep went from
    // 25% of frames missed to 6%, a pinch from 14% to 7%.
    this._still = setTimeout(() => {
      if (typeof requestAnimationFrame !== 'function') { this._settle(); return; }
      requestAnimationFrame(() => { if (this._changes === seen) this._settle(); });
    }, VIEW_SETTLE_MS);
  }

  /** The view has stopped - see _moving(). */
  _settle() {
    this._still = 0;
    this.moving = false;
    this.world.classList.remove('is-viewing');
    this._unpin();
    // And the board is still, so what was held for the gesture lands: the
    // chrome goes back to exactly the size it claims to be, and the zoom
    // rungs catch up with where the zoom ended - see _setIz() and _rungs().
    this._setIz(1 / this.zoom);
    this._rungs(this.zoom);
    this._shadowsOut(false);
    // One more pass over everything that draws the view, now that it has
    // stopped: this is the frame where the cheap versions are exchanged for
    // the proper ones. Announced directly rather than through apply(), which
    // would call this method again and restart the timer it is ending.
    this.bus.emit('change', this);
  }

  /**
   * Make #world one GPU layer for the length of a gesture, rastered once and then
   * only moved and scaled by the compositor.
   *
   * `will-change: transform` is the one promotion that keeps the board a single
   * layer. `translateZ(0)`, which used to be written into the transform for good,
   * promotes too, but Chromium will not merge cards that far apart into it: a
   * board of ninety photographs came out as a hundred and thirty layers, every
   * card and every shadow twin its own, and on a phone that alone held a pinch
   * near twenty frames a second. The hint also pins the raster scale, which is
   * the point while fingers are down - nothing is re-rastered per frame - and the
   * danger if it is left on: a zoom-out asks for texture at the old scale. So it
   * is set only while the view moves, and re-set whenever the zoom has travelled
   * out of PIN_OUT / PIN_IN of the scale it was rastered at: swapped for an
   * opacity hint for a frame, which makes the next pin raster at the scale the
   * zoom has reached. Swapped, not dropped: with no hint #world leaves the
   * compositor for that frame, everything stacked over it is re-layered with it
   * (36 layers to 16 and back, on a phone), and every one of them is drawn again
   * from nothing, the interface included. The opacity hint keeps the layer, so
   * the old raster shows until the new one is ready.
   */
  _pin() {
    const z = this.zoom;
    const now = performance.now();
    if (!this._pinned) {
      this._pinned = this._peak = this._top = z;
      this._outAt = 0;
      this.world.style.willChange = 'transform';
      return;
    }
    this._peak = Math.max(this._peak, z);
    this._top = Math.max(this._top, z);
    // A zoom-out runs until the zoom climbs back past a hair above its low, so
    // a finger's tremble does not restart it.
    if (!this._outAt || z > this._outLow * 1.02) { this._outAt = now; this._outLow = z; }
    else this._outLow = Math.min(this._outLow, z);
    const out = z <= this._peak / PIN_OUT
      && (now - this._outAt >= PIN_OUT_RUN_MS || z <= this._top / PIN_OUT_DEEP);
    const pinIn = sharpensMidGesture() ? PIN_IN_FULL : PIN_IN;
    if (this._repin || (!out && z < this._pinned * pinIn)) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this.world.style.willChange = 'opacity';
    this._repin = requestAnimationFrame(() => {
      this._repin = 0;
      if (!this.moving) return;
      this._pinned = this._peak = this.zoom;
      this.world.style.willChange = 'transform';
    });
  }

  /** The view has stopped: back into the page, rastered sharp at the zoom it ended on. */
  _unpin() {
    if (this._repin) cancelAnimationFrame(this._repin);
    this._repin = 0;
    this._pinned = 0;
    this.world.style.willChange = '';
  }

  /**
   * The zoom rungs, as classes on #world. Each one restyles every card on the
   * board when it flips, so a gesture never flips one - they are written on a
   * frame that is not moving, and again when the view settles.
   */
  _rungs(z: number) {
    this.world.classList.toggle('zoom-far', z < farZoom());
    // A second, lower rung just for the resize grips. Labels and the item bar
    // become noise once a card is a swatch (zoom-far, 40%), but the corners stay
    // worth grabbing further out. From 15% down a card moves and does not
    // resize - from 30% under a finger (RESIZE_MIN_ZOOM_TOUCH).
    this.world.classList.toggle('zoom-no-resize', z < (onTouch() ? RESIZE_MIN_ZOOM_TOUCH : RESIZE_MIN_ZOOM));
    this.world.classList.toggle('zoom-tiny', z < SWATCH_ZOOM);
    // Below this a corner grip clips to its outside half and the whole card face
    // becomes a move target - see the zoom-grab rules in the CSS. Its own rung
    // (25%), lower than the chrome one, because it is about the card being too
    // small to grab, not too small to read.
    this.world.classList.toggle('zoom-grab', z < GRAB_ZOOM);
  }

  /**
   * The shadow twins, off the page for a gesture that zooms out.
   *
   * Pinned, the board keeps the raster scale the gesture started at, so a
   * zoom-out asks for more texture with every frame, and the shadow twins are
   * most of it: their blur spreads every card's paint well past its edges. On a
   * Galaxy S10 they are what runs out of tile memory. From 100% to 25% that was
   * a hundred `tile memory limits exceeded` per zoom-out, the blink. From 500% it
   * was a board with no room left to re-pin into (_pin), so the frame after each
   * re-pin drew with most of its tiles missing: every card gone for a moment,
   * around 90%. Without the twins there are none of either.
   *
   * So their whole container goes, which restyles the twins and not the cards,
   * where flipping zoom-far would do both. They come back on the settling
   * frame, where zoom-far (item-chrome.css) decides as it always has.
   */
  _shadowsOut(out: boolean) {
    if (out === this._shadowsHidden) return;
    this._shadowsHidden = out;
    const layer = this.world.querySelector<HTMLElement>('#item-shadows');
    if (layer) layer.style.display = out ? 'none' : '';
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

  /**
   * Publish 1/zoom to the world layer, if it is not already what is there.
   *
   * Item chrome multiplies by --iz to stay one size on screen. It is inherited,
   * which is what makes it convenient and also what makes it expensive: a new
   * value restyles every card on the board and everything inside it - 30 to 70ms
   * on a Galaxy S10. So it is written once per view change, on the settling
   * frame (_moving), and never while the board moves: the chrome scales with the
   * board until the gesture ends. A rounded copy used to be written on a
   * gesture's first frame as well, and since it never matched the exact value
   * the last settle wrote, every pinch opened on a whole-board restyle.
   */
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
   * inside the board and nowhere else (see inkBox() in canvas/grid.ts), and it
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
    // canvas/mobile-frame.ts's business now, off a change listener like every
    // other piece of screen-space chrome, and nothing writes to #viewport on a
    // view frame any more.
    //
    // +panY (not -panY): items are laid out at cssY = -worldY, so the vertical
    // translate has to undo that flip as well as apply the pan.
    // No promotion written here: #world is a layer only while the view moves,
    // and _pin() is what makes it one - see there for why not translateZ(0).
    const t = `translate(${(-this.pan.x * z).toFixed(3)}px, ${(this.pan.y * z).toFixed(3)}px) scale(${z})`;
    this.world.style.transform = t;
    // The lines take the same transform from outside #world. Inside it they
    // were one paint stretching across the board, and Chromium merged every
    // card they crossed into a single layer with them; held at the pinned
    // scale below 30%, that layer outgrew the WebView's tile memory and the
    // board blanked in strips (Galaxy S22+: 80-95 out-of-memory passes on a
    // sweep through 20-45%, to 3-7). Unpinned, they repaint into the layer
    // under the board that the grid already redraws every frame.
    if (this.plane) this.plane.style.transform = t;
    // The rungs restyle every card, so they are held while the board moves and
    // caught up when it stops (_moving). `moving` is still last frame's answer
    // here, since _moving() runs below; that is right, because the frame that
    // starts a gesture is the one whose value is already on the page, and a zoom
    // button's single step lands at once. --iz waits for the settle either way
    // (see _setIz), except the very first paint, which has none on the page yet.
    if (!this.moving) {
      if (!this._iz) this._setIz(1 / z);
      this._rungs(z);
    } else {
      // Out once the gesture zooms out, and out until it ends: bringing them
      // back mid-gesture would be one more raster of the board for a pinch that
      // is about to settle anyway.
      this._shadowsOut(this._shadowsHidden || z < farZoom() || z < this._pinned * SHADOWS_OUT);
    }
    if (!this.holding) this._moving();

    // The origin mark, centred on the point the axes cross.
    //
    // The rules themselves are not placed here any more. They are drawn, in
    // whole device pixels, by canvas/grid.ts - see paintAxes() there for the
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
