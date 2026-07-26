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
  constructor(viewportEl, worldEl, axisX, axisY, originMark) {
    this.el = viewportEl;
    this.world = worldEl;
    this.axisX = axisX;
    this.axisY = axisY;
    this.originMark = originMark || null;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.width = 0;
    this.height = 0;
    this.left = 0;
    this.top = 0;
    this.bus = emitter();
    this._flush = rafThrottle(() => this._paint());
    this._anim = null;              // rAF id of a view animation in flight
    this._still = 0;                // timer that ends the cheap mode - see _moving()
    this._iz = 0;                   // what --iz was last written as
    this._hair = 0;                 // ...and the axis thickness, likewise

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
  }

  get cx() { return this.width / 2; }
  get cy() { return this.height / 2; }

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
      this.pan.x = x0 - vx * travelled / z;
      this.pan.y = y0 + vy * travelled / z;   // screen y is down, world y is up
      this.apply();
      this._anim = speed * decay > GLIDE_STOP ? requestAnimationFrame(tick) : null;
    };
    this._anim = requestAnimationFrame(tick);
  }

  /** Move the view by a screen-space delta (drag). */
  panByScreen(dx, dy) {
    this.stopAnim();
    this.pan.x -= dx / this.zoom;
    this.pan.y += dy / this.zoom;   // screen y is down, world y is up
    this.apply();
  }

  /** Zoom by `factor`, keeping the world point under (clientX, clientY) fixed. */
  zoomAt(clientX, clientY, factor) {
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
    this.pan.x = +pan?.x || 0;
    this.pan.y = +pan?.y || 0;
    this.zoom = clamp(+zoom || 1, MIN_ZOOM, MAX_ZOOM);
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

  /** Travel to an absolute view. `ms = 0` is setView(). */
  viewTo(pan, zoom, ms = 0) {
    const x1 = +pan?.x || 0, y1 = +pan?.y || 0;
    const z1 = clamp(+zoom || 1, MIN_ZOOM, MAX_ZOOM);
    if (!(ms > 0)) return this.setView({ x: x1, y: y1 }, z1);
    const x0 = this.pan.x, y0 = this.pan.y, z0 = this.zoom;
    if (x1 === x0 && y1 === y0 && z1 === z0) return;
    this._animate(ms, e => {
      this.zoom = e === 1 ? z1 : z0 * Math.pow(z1 / z0, e);
      this.pan.x = x0 + (x1 - x0) * e;
      this.pan.y = y0 + (y1 - y0) * e;
      this.apply();
    });
  }

  /**
   * Fit `items` (anything with x/y/w/h at its centre) in view with a margin.
   * With nothing to fit, falls back to the origin at 1:1.
   */
  fit(items, pad = 80, ms = 0) {
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
    clearTimeout(this._still);
    this._still = setTimeout(() => {
      this._still = 0;
      this.world.classList.remove('is-viewing');
      // And the board is still, so chrome goes back to being exactly the size
      // it claims to be rather than within a rung of it - see IZ_STEP.
      this._setIz(1 / this.zoom);
    }, VIEW_SETTLE_MS);
  }

  /** Publish 1/zoom to the world layer, if it is not already what is there. */
  _setIz(iz) {
    if (iz === this._iz) return;
    this._iz = iz;
    this.world.style.setProperty('--iz', iz);
  }

  _paint() {
    const z = this.zoom;
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

    // Axis placement, with two things to get right at once.
    //
    // Crispness: a rule at a fractional offset is antialiased across two device
    // columns and reads as a soft grey smudge, so the rules snap - to device
    // pixels, and they are one device pixel thick. (The world transform stays
    // fractional - panning is smooth.)
    //
    // One device pixel, not one CSS pixel, and that is the fix for a rule whose
    // weight flickered between hairline and heavy as the board moved: at 125%
    // scaling a 1px rule is 1.25 device rows, which the screen has to render as
    // one row or two depending on where the fractional quarter falls. There is
    // no way to draw 1.25 rows, so the honest answer is to ask for one.
    //
    // Alignment: a rule positioned at `top: N` spans N..N+its height, so its
    // *visual* centre is half a thickness lower. Placing it at the raw origin
    // therefore puts it off the very point it is meant to mark. axisOrigin()
    // returns the centre, the rules are backed off by half, and the origin mark
    // is centred on it - which makes the crosshair pass exactly through the
    // middle of the ring at every pan.
    const a = this.axisOrigin();
    const hair = 1 / deviceRatio();
    // The offsets move on every pan; the thickness only changes when the window
    // is dragged to a screen of a different density, which is to say almost
    // never. Writing it anyway is a style invalidation per frame for a value
    // that is already there.
    if (hair !== this._hair) {
      this._hair = hair;
      this.axisX.style.height = hair + 'px';
      this.axisY.style.width = hair + 'px';
    }
    this.axisX.style.top = (a.y - hair / 2) + 'px';
    this.axisY.style.left = (a.x - hair / 2) + 'px';
    if (this.originMark) {
      this.originMark.style.left = a.x + 'px';
      this.originMark.style.top = a.y + 'px';
    }

    this.bus.emit('change', this);
  }

  onChange(fn) { return this.bus.on('change', fn); }
}
