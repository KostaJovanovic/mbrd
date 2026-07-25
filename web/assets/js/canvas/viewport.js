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

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
/** Below this, item chrome (labels, grips) is more noise than help. */
export const FAR_ZOOM = 0.35;

// How long a commanded view move takes.
//
// A tapped zoom step glides instead of jumping: a discrete 1.3x cut gives you
// no idea which way the board went, where the same step animated stays
// legible. Short enough that holding the button still feels like a zoom
// control rather than a queue of animations.
export const ZOOM_MS = 190;
// Fit, home and zoom-to-item can cross the whole board, so they get longer -
// the point of animating those is to show you the journey.
export const TRAVEL_MS = 400;

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

  /** Move the view by a screen-space delta (drag). */
  panByScreen(dx, dy) {
    this.stopAnim();
    this.pan.x -= dx / this.zoom;
    this.pan.y += dy / this.zoom;   // screen y is down, world y is up
    this.apply();
  }

  panByWorld(dx, dy) {
    this.stopAnim();
    this.pan.x += dx;
    this.pan.y += dy;
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
    if (!items || !items.length) return this.recenter(ms);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      // Rotation-aware: use the bounding box of the rotated rect.
      const rad = (it.rot || 0) * Math.PI / 180;
      const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
      const hw = (it.w * c + it.h * s) / 2;
      const hh = (it.w * s + it.h * c) / 2;
      x0 = Math.min(x0, it.x - hw); x1 = Math.max(x1, it.x + hw);
      y0 = Math.min(y0, it.y - hh); y1 = Math.max(y1, it.y + hh);
    }
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    const z = clamp(Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h), MIN_ZOOM, MAX_ZOOM);
    this.viewTo({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, z, ms);
  }

  /** Queue a repaint; safe to call many times per frame. */
  apply() { this._flush(); }

  _paint() {
    const z = this.zoom;
    // +panY (not -panY): items are laid out at cssY = -worldY, so the vertical
    // translate has to undo that flip as well as apply the pan.
    this.world.style.transform =
      `translate(${(-this.pan.x * z).toFixed(3)}px, ${(this.pan.y * z).toFixed(3)}px) scale(${z})`;
    // Item chrome multiplies by --iz to stay a constant size on screen.
    this.world.style.setProperty('--iz', 1 / z);
    this.world.classList.toggle('zoom-far', z < FAR_ZOOM);

    // Axis placement, with two things to get right at once.
    //
    // Crispness: a 1px rule at a fractional offset is antialiased across two
    // device columns and reads as a soft grey smudge, so the rules snap to
    // whole pixels. (The world transform stays fractional - panning is smooth.)
    //
    // Alignment: a rule positioned at `top: N` spans N..N+1, so its *visual*
    // centre is N + 0.5, not N. Placing it at the raw origin therefore puts it
    // half a pixel off the very point it is meant to mark. So the top-left
    // corner is offset by half the line width, and the origin mark is then
    // centred on the rules rather than on the raw origin - which makes the
    // crosshair pass exactly through the middle of the ring at every pan.
    const o = this.toScreen(0, 0);
    const lineX = Math.round(o.x - 0.5);
    const lineY = Math.round(o.y - 0.5);
    this.axisX.style.top = lineY + 'px';
    this.axisY.style.left = lineX + 'px';
    if (this.originMark) {
      this.originMark.style.left = (lineX + 0.5) + 'px';
      this.originMark.style.top = (lineY + 0.5) + 'px';
    }

    this.bus.emit('change', this);
  }

  onChange(fn) { return this.bus.on('change', fn); }
}
