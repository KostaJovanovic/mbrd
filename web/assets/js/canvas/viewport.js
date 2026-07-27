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

import { clamp, rafThrottle, emitter } from '../util.js';
import { itemBounds } from '../geometry.js';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
export const MOBILE_SIDE_PAD = 16;
export const MOBILE_TOP_PAD = 32;
export const MOBILE_BOTTOM_PAD = 32;

/**
 * The masthead above a Mobile board, as a share of the window's height.
 *
 * A third, and measured against the *screen* rather than the board: it is a
 * title page, and what makes one work is that it fills the view you open on,
 * whatever that view happens to be. A world-space band would have been a third
 * of the screen on the phone it was sized for and a stripe on anything else.
 *
 * The room is made here, in the pan clamp, rather than by moving the board's
 * top edge - the strip still starts exactly where mobileBoardTop() says, items
 * still pack from its first row, and nothing in state.js has to know that a
 * header exists. What the clamp does is stop the scroll a header lower, so the
 * band above the edge is real space rather than something drawn over the items.
 *
 * The floor is for a short window - a laptop in Mobile mode with the browser
 * chrome taking half of it - where a third of very little is not enough to set
 * a name in and the header may as well be a fixed height instead.
 */
export const MOBILE_HEADER_FRACTION = 1 / 3;
export const MOBILE_HEADER_MIN = 160;

/** Height in screen px of the Mobile masthead, for a viewport `height` tall. */
export function mobileHeaderHeight(height) {
  return Math.max(MOBILE_HEADER_MIN, Math.round((+height || 0) * MOBILE_HEADER_FRACTION));
}

/** Fixed zoom that seats a Mobile board in the viewport without enlarging it. */
export function mobileZoom(viewWidth, worldWidth, pad = MOBILE_SIDE_PAD) {
  const available = Math.max(1, viewWidth - pad * 2);
  return clamp(Math.min(1, available / Math.max(1, worldWidth)), MIN_ZOOM, MAX_ZOOM);
}

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
const izRung = v => Math.exp(Math.round(Math.log(v) / IZ_STEP) * IZ_STEP);

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
const LOD_ZOOM = 0.4;

/**
 * And where it sits under a finger.
 *
 * Higher, because the same zoom factor is a smaller card on a phone: the screen
 * is a third the width and the whole board is habitually further out, so chrome
 * sized in screen pixels crowds an item, and a label crossing three of them
 * reads as clutter well before it would on a desk. Moving the rung up means the
 * phone reaches the clean composition sooner rather than sitting in the band
 * where everything is drawn in full and none of it is legible - which is also
 * the band that costs the most to paint on the device least able to.
 */
const LOD_ZOOM_TOUCH = 0.55;

/**
 * Whether this is being looked at through a finger.
 *
 * The query object is made once and then read live, so the answer follows a
 * tablet that has a keyboard folded onto it rather than being decided at boot -
 * and made lazily, because nothing in this file may touch the browser at import
 * time (see tests/imports.test.js). Absent matchMedia, a mouse is assumed: node
 * runs these modules, and the desktop rung is the one the tests describe.
 */
let coarse = null;
export function onTouch() {
  if (typeof matchMedia !== 'function') return false;
  coarse ??= matchMedia('(pointer: coarse)');
  return coarse.matches;
}

/** The rung in force, as a zoom factor. */
export const lodZoom = () => (onTouch() ? LOD_ZOOM_TOUCH : LOD_ZOOM);

/** Below this, item chrome (labels, grips) is more noise than help. */
export const farZoom = () => lodZoom();
/** At or below this, animated pictures hold still - see canvas/stills.js. */
export const stillZoom = () => lodZoom();
/**
 * And below this a photograph is drawn from its hundred-pixel thumbnail
 * instead of its full-size self, which is the same swap by the same mechanism -
 * see the image renderer and the is-stilled rules in app.css.
 */
export const thumbZoom = () => lodZoom();
/** Below this the web is a scribble rather than a set of threads - web.js. */
export const webZoom = () => lodZoom();

// How long a commanded view move takes.
//
// Read from CSS rather than fixed here, so the board's own movement sits on
// the same whimsy axis as the interface's: sliding towards "plain" shortens
// these along with every transition in app.css, instead of leaving the canvas
// animating at scrapbook speed inside a spec-sheet UI.
//
// A tapped zoom step glides instead of jumping: a discrete 1.3x cut gives you
// no idea which way the board went, where the same step animated stays
// legible. Fit, home and zoom-to-item can cross the whole board, so they get
// longer - the point of animating those is to show you the journey.
export const zoomMs = () => cssMs('--dur-zoom', 190);
export const travelMs = () => cssMs('--dur-travel', 400);

function cssMs(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith('ms') ? n : n * 1000;   // CSS times are ms or s
}

/** Decelerating: fast off the mark, settling at the end. */
const ease = t => 1 - Math.pow(1 - t, 3);
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Viewport {
  constructor(viewportEl, worldEl, originMark) {
    this.el = viewportEl;
    this.world = worldEl;
    this.originMark = originMark || null;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
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
    this.zoomLocked = false;
    this.boardMode = 'desktop';
    this.mobileWorldWidth = 0;
    this.mobileWorldTop = 0;
    this.mobileWorldBottom = 0;
    this.width = 0;
    this.height = 0;
    this.left = 0;
    this.top = 0;
    this.bus = emitter();
    this._flush = rafThrottle(() => this._paint());
    this._anim = null;              // rAF id of a view animation in flight
    this._still = 0;                // timer that ends the cheap mode - see _moving()
    this._iz = 0;                   // what --iz was last written as
    this.moving = false;            // is the view mid-gesture? - see _moving()

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
    return this.isMobile ? mobileHeaderHeight(this.height) : 0;
  }

  /**
   * Highest pan that keeps the finite top edge just inside the viewport.
   *
   * A header lower than the edge itself: the top of a Mobile board is the
   * masthead, and the strip begins under it.
   */
  _mobileTopPan() {
    return this.mobileWorldTop
      + (MOBILE_TOP_PAD + this.mobileHeaderPx() - this.cy) / this.zoom;
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

  _setMobileBounds(worldWidth, worldTop, worldBottom) {
    this.mobileWorldWidth = Math.max(1, +worldWidth || 1);
    this.mobileWorldTop = Number.isFinite(+worldTop) ? +worldTop : 0;
    const bottom = Number.isFinite(+worldBottom) ? +worldBottom : this.mobileWorldTop;
    this.mobileWorldBottom = Math.min(bottom, this.mobileWorldTop);
  }

  /** Constrain the viewport to the content-sized Mobile board. */
  setBoardMode(
    mode,
    worldWidth = this.mobileWorldWidth,
    worldTop = this.mobileWorldTop,
    worldBottom = this.mobileWorldBottom,
  ) {
    this.stopAnim();
    this.boardMode = mode === 'mobile' ? 'mobile' : 'desktop';
    this._setMobileBounds(worldWidth, worldTop, worldBottom);
    if (this.isMobile) {
      this.zoom = this._mobileZoom();
      this._constrainMobile();
    }
    this.apply();
  }

  /** Refresh a Mobile board whose content has changed its lower edge. */
  setMobileBounds(worldWidth, worldTop, worldBottom) {
    this._setMobileBounds(worldWidth, worldTop, worldBottom);
    if (!this.isMobile) return;
    this.zoom = this._mobileZoom();
    this._constrainMobile();
    this.apply();
  }

  /** World point -> position within the viewport element, in CSS px. */
  toScreen(wx, wy) {
    return { x: (wx - this.pan.x) * this.zoom + this.cx, y: (this.pan.y - wy) * this.zoom + this.cy };
  }

  /** Client (event) coords -> world point. */
  toWorld(clientX, clientY) {
    const sx = clientX - this.left - this.cx;
    const sy = clientY - this.top - this.cy;
    return { x: sx / this.zoom + this.pan.x, y: this.pan.y - sy / this.zoom };
  }

  /** The world-space rectangle currently visible, grown by `margin` world px. */
  visibleRect(margin = 0) {
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
  glide(vx, vy) {
    if (this.isMobile) vx = 0;
    const speed = Math.hypot(vx, vy);
    if (speed < GLIDE_MIN || reducedMotion()) return;
    this.stopAnim();
    const x0 = this.pan.x, y0 = this.pan.y, z = this.zoom;
    const t0 = performance.now();
    const tick = now => {
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
  panByScreen(dx, dy) {
    this.stopAnim();
    this.pan.x = this.isMobile ? 0 : this.pan.x - dx / this.zoom;
    this.pan.y += dy / this.zoom;   // screen y is down, world y is up
    this._constrainMobile();
    this.apply();
  }

  /** Zoom by `factor`, keeping the world point under (clientX, clientY) fixed. */
  zoomAt(clientX, clientY, factor) {
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

  setView(pan, zoom) {
    this.stopAnim();
    this.pan.x = this.isMobile ? 0 : +pan?.x || 0;
    this.pan.y = +pan?.y || 0;
    this.zoom = this.isMobile ? this._mobileZoom() : clamp(+zoom || 1, MIN_ZOOM, MAX_ZOOM);
    this._constrainMobile();
    this.apply();
  }

  recenter(ms = 0) {
    this.viewTo({ x: 0, y: 0 }, 1, ms);
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
  _animate(ms, step) {
    this.stopAnim();
    if (!(ms > 0) || reducedMotion()) { step(1); return; }
    const t0 = performance.now();
    const tick = now => {
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
  zoomAnimAt(clientX, clientY, factor, ms = 200) {
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
  zoomBy(factor, ms = 0) {
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
  viewTo(pan, zoom, ms = 0) {
    const x1 = this.isMobile ? 0 : +pan?.x || 0;
    const z1 = this.isMobile
      ? this._mobileZoom()
      : this.zoomLocked ? this.zoom : clamp(+zoom || 1, MIN_ZOOM, MAX_ZOOM);
    const requestedY = +pan?.y || 0;
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
  * With nothing to fit, falls back to the origin at 1:1.
  */
  fit(items, pad = 80, ms = 0) {
    if (this.isMobile) {
      return this.viewTo({ x: 0, y: this._mobileTopPan() }, this._mobileZoom(), ms);
    }
    const box = items && items.length ? itemBounds(items) : null;
    if (!box) return this.recenter(ms);
    const { x0, y0, x1, y1 } = box;
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    const z = clamp(Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h), MIN_ZOOM, MAX_ZOOM);
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
  axisOrigin() {
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
   * The class is what app.css hangs its cheap mode off. What it turns off is
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

  /** Publish 1/zoom to the world layer, if it is not already what is there. */
  _setIz(iz) {
    if (iz === this._iz) return;
    this._iz = iz;
    this.world.style.setProperty('--iz', iz);
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
  mobileScreenRect() {
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
    const { left: mobileLeft, width: mobileWidth, top: mobileTop, bottom: mobileBottom }
      = this.mobileScreenRect();
    this.el.style.setProperty('--mobile-board-left', `${mobileLeft}px`);
    this.el.style.setProperty('--mobile-board-width', `${mobileWidth}px`);
    this.el.style.setProperty('--mobile-board-top', `${mobileTop}px`);
    this.el.style.setProperty('--mobile-board-bottom', `${mobileBottom}px`);
    // The masthead hangs off the top edge, so it needs no position of its own -
    // app.css subtracts this from --mobile-board-top and the band travels with
    // the board as it scrolls away.
    this.el.style.setProperty('--mobile-header-height', `${this.mobileHeaderPx()}px`);
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

  onChange(fn) { return this.bus.on('change', fn); }
}
