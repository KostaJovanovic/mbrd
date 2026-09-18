// The cleaning simulator: the mode the konami code opens, and seven taps on the
// wordmark. Freezes the cards, lays a dirt layer over them inside #world so pan
// and zoom still work, and puts one of three tools in your hand. Touches no
// board state, keeps nothing, and leaves the board exactly as it found it.
// See ./mess.ts for the arithmetic and ./art.ts for the drawing.

import { board, timelinePlaying } from '../../state.ts';
import type { Item } from '../../board-model.ts';
import type { Viewport } from '../../canvas/viewport.ts';
import { tiltOf } from '../../canvas/items.ts';
import { quality } from '../../quality.ts';
import { cue, sustain } from '../../cuelume/engine.ts';
import type { Sustain } from '../../cuelume/engine.ts';
import { el, div } from '../../util.ts';
import {
  TOOLS, TUNING, SUBS, yieldsTo, planBoard, makeField, stamp, fieldClear, wearShare, wearOf,
  cardClean, tally, fullTank, tankStep, tankPower, jetShape, handRoom,
  toolWork, toolWanted, toolShare, webCards, webHolds,
} from './mess.ts';
import type { ToolId, MessKind, Field, Web, Box, Rng, Tank, DebrisPlan } from './mess.ts';
import {
  crust, crustMask, paintField, eraseAt, wetAt, sheenAt, gleamAt, runAt,
  washOf, waterInk,
  debrisNode, placeBit, sizeBit, BIT_UNIT, webPath, webSag, webCore, webNode,
} from './art.ts';
import type { Crust } from './art.ts';

/** The spa loop. The file is the maintainer's to supply and is deliberately not
 *  in sw.js's SHELL - precaching a few megabytes of music for the handful of
 *  people who ever find this would be paid for by everybody who does not. The
 *  mode runs silent if it is missing, which is also what a fresh clone gets. */
const MUSIC = 'assets/audio/clean-loop.opus';
const MUSIC_GAIN = 0.55;
const FADE_MS = 1400;

/** What is said when the board is spotless. */
const SPOTLESS = 'Everything is spotless.';

/** The one ease and the four durations the whole mode moves on. Written here
 *  as well as in clean.css because the Web Animations calls below need them as
 *  values; the two are the same numbers on purpose. */
const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
const TRAVEL_MS = 320;
const LEAVE_MS = 450;

/** Above every card. Items carry their own z from board order; the dirt is not
 *  part of that order and sits over all of it. */
const DIRT_Z = 1_000_000;

/** Largest canvas side for one grime field. A card is at most this across
 *  whatever its world size, so a wall-sized card costs the same as a small one. */
const TEX_MAX = 512;
const TEX_MIN = 96;

/** How long the sheen the jet leaves takes to dry off. Cosmetic throughout -
 *  nothing counts it and no tool touches it. */
const SHEEN_MS = 2000;

/** The last stretch of that, over which the whole sheen layer fades out. The
 *  canvas decays patch by patch on its own age; this is what keeps the *end* of
 *  it from being a cut, whatever is left on the canvas when the clock runs out. */
const SHEEN_OUT_MS = 700;

/** The most the wet layer is ever worth. The canvas saturates - a jet held on
 *  one spot lays water down faster than the decay takes it away, and that is
 *  correct, a held jet *does* make a soaking patch - so what stops it being a
 *  white hole is this, one number bounding the whole layer rather than a
 *  per-stamp alpha that has to be guessed against the frame rate. */
const SHEEN_PEAK = 0.5;

/** A frame, near enough. What counts as "the pointer has already touched the
 *  board this frame and does not need the clock to do it". Short enough that a
 *  hand which stops mid-stroke keeps working without a visible gap, long enough
 *  that a hand sending moves at 120Hz is left entirely alone. */
const FRAME_MS = 12;

/** What the badge at a card's corner is saying. Empty while no tool is held,
 *  which is when there is no question to answer and no badge on screen. */
type BadgeState = '' | 'want' | 'done';

/** Where the pointer counts as "at the bin", so a loaded glove gets an answer
 *  before it is over the button. Screen pixels. */
const CAN_NEAR = 90;

/** A piece's footprint on the crust below it, as a share of the card. The jet
 *  cannot reach what is under this, which is the whole of the rule that debris
 *  comes off first. */
const SHADE_R = 0.055;

type LiveField = {
  kind: MessKind,
  field: Field,
  crust: Crust,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  fading: boolean,
};

type LiveBit = {
  node: SVGGElement,
  kind: MessKind,
  /** In the card's own 0..1 box, or - for a loose piece - in layer pixels. */
  x: number,
  y: number,
  size: number,
  /** Presses left. Gum resists; a crumb does not. */
  tough: number,
  /** The little SVG a loose piece carries with it; null while it is on a card. */
  host: SVGSVGElement | null,
};

type LiveCard = {
  item: Item,
  box: HTMLElement,
  bits: SVGSVGElement,
  /** The sheen the jet leaves. Drawn over the crust, counted by nothing. */
  wet: HTMLCanvasElement,
  wetCtx: CanvasRenderingContext2D,
  wetAt: number,
  /** Dirty water running off. Its own canvas under the sheen, so a rivulet
   *  crosses grime it has not cleaned yet. Cosmetic: nothing counts it. */
  run: HTMLCanvasElement,
  runCtx: CanvasRenderingContext2D,
  runs: Rivulet[],
  /** When one was last born here, so a card cannot sprout a dozen at once. */
  runAt: number,
  /** When the canvas may be thrown away: pushed forward every frame a rivulet
   *  is still running, so it is measured from the last one *gone* and not from
   *  the last one born. Those are up to two and a half seconds apart, which is
   *  the whole life of a trail. */
  runTill: number,
  ring: SVGSVGElement,
  ringFg: SVGCircleElement,
  /** Pieces and strands this card was dealt - the badge's denominators, which
   *  a field carries for itself and these two do not. `websDealt` is filled
   *  after buildWebs(), since a card cannot know its own strands while it is
   *  being built. */
  debrisDealt: number,
  websDealt: number,
  /** What was last written to the badge, so a frame that would change nothing
   *  touches no DOM. Thirty cards times sixty frames is the hot path here. */
  badgeState: BadgeState,
  badgeShare: number,
  /** The presentational lean the card is wearing right now, in CSS degrees.
   *  Not item.rot, which is geometry - see leanOf(). */
  lean: number,
  /** Whether the corner has been taken off the live card yet - see setRadius().
   *  A card that was culled when the mode opened has no node to read. */
  rounded: boolean,
  fields: LiveField[],
  debris: LiveBit[],
  clean: boolean,
};

/** One side of the triangle, between two of the web's three cards. */
type WebLeg = {
  ax: number, ay: number, bx: number, by: number,
  /** The drawn sag of this strand's lowest thread. Kept so the hit test follows
   *  the curve that is actually on screen rather than an assumed one. */
  sag: number,
};

/** The three strands are one `<path>` and one thing to sweep: touching any of
 *  them takes the web and frees all three cards at once. */
type LiveWeb = Web & { node: SVGPathElement, legs: WebLeg[] };

/** One speck of mist or one fleck of grime, on the overlay canvas. Three
 *  colours rather than one because a speck is painted as a gradient: its middle,
 *  its middle at half, and the same hue at zero. Built once at birth - a speck
 *  is drawn every frame it lives and string-building per speck per frame is the
 *  one thing in this file on a hot path. */
type Mote = {
  x: number, y: number, vx: number, vy: number,
  at: number, ms: number, r: number,
  fill: string, fade: string, gone: string,
};

/** Dirty water running down a card, in that card's own 0..1 space. It falls
 *  along the *card's* down rather than the world's, so a leaning card runs at
 *  its angle - which is cheaper than the alternative and reads as right. */
type Rivulet = {
  x: number, y: number,
  /** Sideways speed, in card widths a second. A slow random walk rather than a
   *  function of time: water meanders, and anything periodic is a shape the eye
   *  picks out immediately. Two sines were in here for one version and what
   *  they drew was a sine wave. */
  drift: number,
  born: number,
  kind: MessKind,
};

/** The three stops for a speck of a given colour and peak alpha. */
function moteInk(r: number, g: number, b: number, a: number) {
  return {
    fill: `rgba(${r},${g},${b},${a})`,
    fade: `rgba(${r},${g},${b},${(a * 0.45).toFixed(3)})`,
    gone: `rgba(${r},${g},${b},0)`,
  };
}


// ---- module state -------------------------------------------------------

// Set once at boot and outliving every session.
let worldEl: HTMLElement | null = null;
let vp: Viewport | null = null;

// ---- session state ------------------------------------------------------
//
// Everything below belongs to one run of the egg, and **stopClean() must clear
// all of it**. The mode can be entered again straight away, into this same
// module - so anything left set is not stale data, it is a lie the next session
// starts from. Three bugs of exactly this shape got through at once: a held
// button left the pointer count at one and the next run could only pan, a held
// Space left the pan modifier down for the session, and the ending's own timer
// arrived four seconds later and closed a run that had nothing to do with it.
//
// tests/clean.test.js reads this block and holds every name in it against the
// body of stopClean(), because the failure is invisible in the run that causes
// it and only shows up in the next one.

let on = false;
let layer: HTMLElement | null = null;
let catcher: HTMLElement | null = null;
let cards: LiveCard[] = [];
let webs: LiveWeb[] = [];
/** Debris tipped out onto the bare board. Scoopable like any other, and the
 *  board is not done while any of it is lying there. */
let loose: LiveBit[] = [];
/** The tool in hand. The mode opens with none, which is why this is nullable
 *  and why every press asks before it does anything. */
let held: ToolId | null = null;
/** What is in the glove, oldest first. */
let carried: LiveBit[] = [];
let tank: Tank = fullTank();
/** How fast the hand is moving, in **world** units a second, smoothed over
 *  `TUNING.jetSmoothMs`. World and not screen: the jet is a thing in the board,
 *  and a sweep that is slow at one zoom must not be fast at another. */
let handSpeed = 0;
/** Where the hand was at the last frame, in screen pixels. Sampled on the frame
 *  clock rather than per pointer event: a coalesced batch of moves arrives at
 *  one timestamp and the speed read off it is nonsense. */
let speedFrom = { x: 0, y: 0 };
let music: HTMLAudioElement | null = null;
let hiss: Sustain | null = null;
let raf = 0;
let finishing = false;
let rng: Rng = Math.random;
let pending: LiveField[] = [];
let drawing = false;
let panning = false;
let pointers = 0;
let last: { x: number, y: number } | null = null;
let strokeAt: { x: number, y: number } | null = null;
/** Distance still to walk before the next touch of the tool is laid, carried
 *  from one pointer event to the next so the spacing does not restart at every
 *  seam between them. See strokeTo(). */
let strokeLeft = 0;
let spaceHeld = false;
/** Where the hand is, in screen pixels, and how fast it is moving sideways -
 *  which is the whole of the tool's tilt. */
let at = { x: -200, y: -200 };
let tilt = 0;
let skidAt = 0;
let fleckAt = 0;
let gleamAtMs = 0;
/** When the tool last touched the board. The frame clock keeps the jet alive on
 *  a hand that is holding still - see tick(). */
let appliedAt = 0;
let tickAt = 0;
/** `--tilt-max` in degrees, resolved once on the way in. It is a token that only
 *  the whimsy dial moves, and the dial is behind chrome this mode has hidden -
 *  so reading it per card per frame would be a computed-style flush buying an
 *  answer that cannot change while anybody is looking. */
let tiltMax = 0;
let cursor: HTMLElement | null = null;
let cursorUse: SVGUseElement | null = null;
let cursorSpin: SVGGElement | null = null;
let tankFill: HTMLElement | null = null;
let loadG: SVGGElement | null = null;
let mist: HTMLCanvasElement | null = null;
let mistCtx: CanvasRenderingContext2D | null = null;
let motes: Mote[] = [];

// ---- end session state --------------------------------------------------

/**
 * Every pending timeout this session owns, so stopClean() can take them all.
 *
 * A mode that can be left at any instant cannot leave work scheduled behind it:
 * the next run starts a fresh session into the same module state, and a stale
 * callback arriving into it is indistinguishable from a real one. The dissolve
 * timers only touch nodes that are already detached and were harmless, but they
 * are held here too rather than being the one exception somebody has to
 * remember.
 */
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(fn: () => void, ms: number) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}

/** Whether the egg is up. canvas/input.ts asks before it does anything else. */
export const cleanActive = () => on;

/** Handed the camera at boot, the way initItems() is. The dirt goes into the
 *  same #world the cards are in, so pan and zoom carry it for free. */
export function initClean(viewport: Viewport) {
  vp = viewport;
  worldEl = viewport.world;
  wireBar();
}

// ---- entering and leaving ----------------------------------------------

/**
 * Whether there is a board on screen to clean at all.
 *
 * Four refusals, and three of them are about who owns the screen. A tour drives
 * the camera, a replay drives the cards, and a Mobile board is not showing the
 * canvas at all - it is showing the Feed or the Playlist, and a dirt layer laid
 * over #world would be a mess nobody can see, under a bar that works.
 */
function canOpen(): boolean {
  const root = document.documentElement.classList;
  if (root.contains('is-touring') || root.contains('is-tour-edit')) return false;
  if (timelinePlaying()) return false;
  return board.layoutMode !== 'mobile';
}

/**
 * Open the egg. Answers false when there is nothing to clean, which is what an
 * empty board gets: inventing a mess on a board with no cards would be a mode
 * with no way to make progress in it.
 */
export function startClean(): boolean {
  if (on || !worldEl || !vp) return false;
  if (!canOpen()) return false;
  const picked = pickCards();
  if (!picked.length) return false;

  rng = Math.random;
  finishing = false;
  held = null;
  carried = [];
  loose = [];
  tank = fullTank();
  handSpeed = 0;
  speedFrom = { x: -200, y: -200 };
  motes = [];
  tilt = 0;
  skidAt = 0;
  fleckAt = 0;
  gleamAtMs = 0;
  appliedAt = 0;
  tickAt = performance.now();
  at = { x: -200, y: -200 };
  tiltMax = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tilt-max')) || 0;

  layer = div('clean-layer');
  layer.id = 'dirt';
  layer.style.zIndex = String(DIRT_Z);
  worldEl.append(layer);

  const plan = planBoard(picked.map(boxOf), rng);
  const byId = new Map(picked.map(i => [i.id, i]));
  cards = plan.cards.map(p => buildCard(byId.get(p.id)!, p)).filter(c => c !== null);
  buildWebs(plan.webs, byId);
  // The badge's web denominator, once the strands that could actually be drawn
  // are known - buildWebs drops any whose card was culled, and a card must not
  // be asked to sweep a strand that was never hung.
  for (const card of cards) {
    card.websDealt = webs.filter(w => webHolds(w, card.item.id)).length;
  }

  catcher = div('clean-catch');
  catcher.id = 'clean-catch';
  // Inside the viewport element, so a wheel this does not handle still bubbles
  // to canvas/input.ts and zooms. That is the whole of "the camera stays free".
  catcher.append(buildMist());
  vp.el.append(catcher);
  bindPointer(catcher);
  // On the body rather than inside the glass: the glass opens a stacking
  // context at --z-overlay, and a tool carried over the bar has to be drawn on
  // top of the bar - which is a page-level thing two rungs above it.
  cursor = buildCursor();
  document.body.append(cursor);

  // Before paintCount(), which can reach finish() - and finish() ends in
  // stopClean(), which refuses while the mode is not yet officially up.
  on = true;
  document.documentElement.classList.add('is-cleaning');
  pauseMedia();
  showBar(true);
  paintCount();
  startMusic();
  cue('arrive');
  raf = requestAnimationFrame(tick);
  return true;
}

/** Leave. Answers false when it was not up, so Escape can fall through to the
 *  handlers under it - the shape every other temporary state here uses. */
export function stopClean(): boolean {
  if (!on) return false;
  on = false;
  finishing = false;
  cancelAnimationFrame(raf);
  raf = 0;
  // Every timer that would outlive the session. The ending used to schedule its
  // own close four seconds out; leaving during that window and re-entering
  // handed the *new* session the old timer, which shut it immediately.
  for (const t of timers) clearTimeout(t);
  timers.clear();
  // The whole pointer pipeline, not just the parts endStroke() owns. The glass
  // goes away here, so a button still held when it does never sees its pointerup
  // and `pointers` was left at one for ever - after which every press in the
  // next run counted as a second finger, the left button panned, and nothing
  // could be cleaned again until the page was reloaded.
  endStroke();
  pointers = 0;
  last = null;
  spaceHeld = false;
  held = null;
  carried = [];
  loose = [];
  handSpeed = 0;
  speedFrom = { x: -200, y: -200 };
  tilt = 0;
  skidAt = 0;
  fleckAt = 0;
  gleamAtMs = 0;
  appliedAt = 0;
  tickAt = 0;
  // Not a number the next run may inherit: its badges are new nodes wearing no
  // transform at all, and a second run opened at the same zoom as the first
  // would match this and never counter-scale one of them.
  badgeZoom = 0;
  tiltMax = 0;
  at = { x: -200, y: -200 };
  tank = fullTank();
  motes = [];
  hiss?.stop();
  hiss = null;
  stopMusic();
  layer?.remove();
  catcher?.remove();
  cursor?.remove();
  // Anything still in the air. A ghost and a piece on its way to the bin are
  // both on the body rather than inside the glass, and both are taken away by a
  // timer this has just cleared - so leaving during a flight left a tool pinned
  // to the page over the board, for ever, with nothing left running to remove
  // it. The one thing in the mode that outlives its own teardown.
  for (const stray of document.querySelectorAll('.clean-cursor.is-ghost, .clean-fly')) stray.remove();
  // The one class this mode writes onto a *real* card, and its removal is on a
  // timer that has just been cleared. Left behind it is a card stuck a few
  // pixels up and a fraction larger for the rest of the session, on a board
  // that has no idea why.
  for (const woken of document.querySelectorAll('.item.is-woken')) woken.classList.remove('is-woken');
  layer = null;
  catcher = null;
  cursor = null;
  cursorUse = null;
  cursorSpin = null;
  tankFill = null;
  loadG = null;
  mist = null;
  mistCtx = null;
  cards = [];
  webs = [];
  pending = [];
  document.documentElement.classList.remove('is-cleaning', 'is-clean-done');
  showBar(false);
  resumeMedia();
  return true;
}

/**
 * Which cards get dirty: the ones nearest the middle of what is on the board,
 * capped, so the mess is one region somebody can work through rather than a
 * scatter across a board they would have to go looking around.
 */
function pickCards(): Item[] {
  const items = board.items.filter(i => i.type !== 'ghost' && i.w > 0 && i.h > 0);
  if (items.length <= TUNING.maxCards) return items;
  let cx = 0;
  let cy = 0;
  for (const i of items) { cx += i.x; cy += i.y; }
  cx /= items.length;
  cy /= items.length;
  return [...items]
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))
    .slice(0, TUNING.maxCards);
}

const boxOf = (i: Item): Box => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h });

const ns = <K extends keyof SVGElementTagNameMap>(tag: K) =>
  document.createElementNS('http://www.w3.org/2000/svg', tag);

// ---- building -----------------------------------------------------------

function buildCard(item: Item, plan: { fields: MessKind[], debris: DebrisPlan[] }): LiveCard | null {
  if (!layer) return null;
  const box = div('clean-card');
  // The same arithmetic placeBox() uses in canvas/items.ts: world y is up and
  // the layer's y is down, and a card is placed by its centre.
  box.style.left = (item.x - item.w / 2).toFixed(2) + 'px';
  box.style.top = (-item.y - item.h / 2).toFixed(2) + 'px';
  box.style.width = item.w.toFixed(2) + 'px';
  box.style.height = item.h.toFixed(2) + 'px';
  // The cap on a corner, as placeBox() hands it to the selection ring for the
  // same reason: CSS can express min() but cannot read the capped result back.
  // Only the fallback in clean.css uses it - setRadius() overwrites it with the
  // card's real corner as soon as there is a node to read.
  box.style.setProperty('--half-min', (Math.min(item.w, item.h) / 2).toFixed(2) + 'px');
  if (item.rot) box.style.transform = `rotate(${-item.rot}deg)`;

  const wet = document.createElement('canvas');
  wet.className = 'clean-wet';
  wet.width = texSide(item.w);
  wet.height = texSide(item.h);
  const run = document.createElement('canvas');
  run.className = 'clean-run';
  run.width = texSide(item.w);
  run.height = texSide(item.h);
  const ring = buildRing();

  const live: LiveCard = {
    item, box, bits: bitsSvg(),
    wet, wetCtx: wet.getContext('2d')!, wetAt: 0,
    run, runCtx: run.getContext('2d')!, runs: [], runAt: 0, runTill: 0,
    ring, ringFg: ring.querySelector('.ring-fg')!,
    debrisDealt: plan.debris.length, websDealt: 0,
    badgeState: '', badgeShare: -1,
    lean: 0, rounded: false,
    fields: [], debris: [], clean: false,
  };
  setLean(live);
  setRadius(live);
  for (const kind of plan.fields) live.fields.push(makeLive(kind, item));
  for (const d of plan.debris) {
    const node = debrisNode(d, rng);
    live.bits.append(node);
    sizeOnCard(node, item);
    live.debris.push({
      node, kind: d.kind, x: d.x, y: d.y, size: d.size,
      tough: d.kind === 'gum' ? TUNING.gumTugs : 1, host: null,
    });
  }
  for (const f of live.fields) box.append(f.canvas);
  // Runoff over the crust and under the sheen and the debris: a rivulet crosses
  // grime it has not cleaned yet, which is the point of it.
  box.append(run, wet, live.bits, ring);
  layer.append(box);
  return live;
}

function bitsSvg(): SVGSVGElement {
  const s = ns('svg');
  s.setAttribute('class', 'clean-bits');
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('preserveAspectRatio', 'none');
  return s;
}

/**
 * The badge at a card's top-right: what the tool in hand still has to do here.
 * A disc, an arc that closes as the work comes off, and two glyphs of which at
 * most one is ever drawn on - a bang while there is work, a check when there
 * is none. Both are inline paths rather than symbols in icons.svg, because at
 * this size they are two strokes each and a sprite reference would buy nothing.
 *
 * Counter-scaled while it is up, so it is one size on screen however far out
 * the camera is - a badge that shrank with the board would be unreadable at
 * the zoom somebody works a whole board at.
 */
function buildRing(): SVGSVGElement {
  const s = ns('svg');
  s.setAttribute('class', 'clean-ring');
  s.setAttribute('viewBox', '0 0 24 24');
  // Decoration. "3 of 12" in #clean-count is the mode's spoken progress and
  // this must not say it thirty more times.
  s.setAttribute('aria-hidden', 'true');
  const bg = ns('circle');
  bg.setAttribute('class', 'ring-bg');
  const fg = ns('circle');
  fg.setAttribute('class', 'ring-fg');
  for (const c of [bg, fg]) {
    c.setAttribute('cx', '12');
    c.setAttribute('cy', '12');
    c.setAttribute('r', '9');
  }
  // 2*pi*9, so the dash arithmetic below is a share of one turn.
  fg.setAttribute('stroke-dasharray', '56.55');
  fg.setAttribute('stroke-dashoffset', '56.55');
  const tick = ns('path');
  tick.setAttribute('class', 'ring-tick');
  tick.setAttribute('d', 'M7.6 12.3 10.7 15.4 16.6 9.1');
  // The bang as one path, stem and dot, so it draws on from a single
  // dashoffset the way the check does. The gap is what makes it a bang.
  const bang = ns('path');
  bang.setAttribute('class', 'ring-bang');
  bang.setAttribute('d', 'M12 6.9 V13.1 M12 16.4 V16.5');
  s.append(bg, fg, tick, bang);
  return s;
}

const RING_LEN = 56.55;

/** A field and the canvas it is painted on. The crust is used twice - once for
 *  the occupancy grid that counts, once for the paint that is seen - which is
 *  what keeps the two from drifting apart. */
function makeLive(kind: MessKind, item: Item): LiveField {
  const canvas = document.createElement('canvas');
  canvas.className = 'clean-grime';
  canvas.width = texSide(item.w);
  canvas.height = texSide(item.h);
  const ctx = canvas.getContext('2d')!;
  const c = crust(kind, rng);
  const field = makeField(kind, crustMask(c), TUNING.grid, TUNING.depth[kind] ?? 1);
  const live: LiveField = { kind, field, crust: c, canvas, ctx, fading: false };
  // Counted now, painted over the next few frames. The grid is cheap and the
  // noise is not, and doing every card's noise in the keypress that opened the
  // mode is half a second of frozen window. Queued instead, the cards are dirty
  // in the arithmetic immediately and visibly dirty a moment later, which reads
  // as the mess settling onto them.
  if (field.total) pending.push(live);
  return live;
}

/** Per frame. Two is about 10ms on a desktop and still finishes thirty cards
 *  inside a second, which is shorter than the camera takes to settle. */
const PAINT_PER_FRAME = 1;

function drainPaint() {
  for (let i = 0; i < PAINT_PER_FRAME; i++) {
    const live = pending.shift();
    if (!live) return;
    if (live.fading) continue;
    paintField(live.ctx, live.crust, live.canvas.width, live.canvas.height, quality.grain);
    live.canvas.classList.add('clean-settled');
  }
}

/** A card's debris box is 0..100 stretched over the card, so a piece is sized
 *  against the card's real shape or it comes out squashed. See sizeBit(). */
const sizeOnCard = (node: SVGGElement, item: Item) =>
  sizeBit(node, (BIT_UNIT * 100) / item.w, (BIT_UNIT * 100) / item.h);

const texSide = (world: number) =>
  Math.max(TEX_MIN, Math.min(TEX_MAX, Math.round(world)));

/** The three sides of the triangle, as pairs into `webCards()`. */
const WEB_SIDES: readonly [number, number][] = [[0, 1], [1, 2], [2, 0]];

function buildWebs(list: readonly Web[], byId: Map<string, Item>) {
  if (!layer || !list.length) return;
  const made: LiveWeb[] = [];
  for (const w of list) {
    const items = webCards(w).map(id => byId.get(id));
    // All three or none: a triangle missing a corner is two strands meeting at
    // nothing, and the card that was culled is not there to be webbed anyway.
    if (items.some(i => !i)) continue;
    const legs: WebLeg[] = [];
    let d = '';
    for (const [i, j] of WEB_SIDES) {
      const a = items[i]!;
      const b = items[j]!;
      const p = anchor(a, b);
      const q = anchor(b, a);
      // Rolled here and kept on the leg, so the hit line below and the drawn
      // line are one line - on a long span an assumed sag sits visibly off the
      // strand and the duster passes through it with nothing happening.
      const sag = webSag(Math.hypot(q.x - p.x, q.y - p.y), rng);
      legs.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y, sag });
      d += (d ? ' ' : '') + webPath(p.x, p.y, q.x, q.y, sag);
    }
    // The middle, spun inside the frame the sides just drew. It is handed the
    // frame's own corners and sags, because the radii land *on* those sagging
    // curves - that is the whole difference between one web and two drawings
    // sharing a box. See webCore().
    const core = webCore(legs);
    d += ' ' + core.d;
    // Every fourth radius joins the hit geometry - fifteen hit lines per web is
    // more than a sweep needs, and the ones in between are never further from a
    // sampled radius than the duster's own reach.
    for (let i = 0; i < core.spokes.length; i += 4) {
      legs.push({
        ax: core.hub.x, ay: core.hub.y,
        bx: core.spokes[i]!.x, by: core.spokes[i]!.y,
        sag: core.drop[i]!,
      });
    }
    // One path for the sides and the middle both: the web is one thing to
    // sweep, and a single node is what lets the leave animation take all of it.
    made.push({ ...w, node: webNode(d), legs });
  }
  if (!made.length) return;
  // One SVG for every strand, its viewBox in the layer's own coordinates so a
  // path can be written in them directly. The cards cannot move, so this box is
  // computed once and never again.
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const w of made) for (const g of w.legs) {
    x0 = Math.min(x0, g.ax, g.bx); x1 = Math.max(x1, g.ax, g.bx);
    y0 = Math.min(y0, g.ay, g.by); y1 = Math.max(y1, g.ay, g.by);
  }
  const pad = 400;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const svg = ns('svg');
  svg.setAttribute('class', 'clean-webs');
  svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  svg.style.left = x0 + 'px';
  svg.style.top = y0 + 'px';
  svg.style.width = (x1 - x0) + 'px';
  svg.style.height = (y1 - y0) + 'px';
  for (const w of made) svg.append(w.node);
  // Removed with the whole dirt layer on the way out, which is why nothing
  // holds a reference to it past here.
  layer.append(svg);
  webs = made;
}

/** Where a strand leaves card `a` on its way to card `b`: the point on a's edge
 *  facing the other, in layer coordinates. */
function anchor(a: Item, b: Item) {
  const ax = a.x;
  const ay = -a.y;
  const dx = b.x - a.x;
  const dy = -b.y - ay;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(
    (a.w / 2) / Math.max(1e-3, Math.abs(dx / len)),
    (a.h / 2) / Math.max(1e-3, Math.abs(dy / len)),
  );
  return { x: ax + (dx / len) * t, y: ay + (dy / len) * t };
}

// ---- holding a tool -----------------------------------------------------

/** Whether the hand is holding something it cannot simply put down. */
const carrying = () => carried.length > 0;

/** The bar slot a tool rests in. */
const slotFor = (id: ToolId) =>
  document.querySelector<HTMLElement>(`#clean-tools [data-clean="${id}"]`);

/**
 * Pick a tool up, or swap to it, or - if it is the one already in hand - put it
 * down. One press, whichever of the three it turns out to be.
 *
 * A hand with something in it will not let go of the tool: no shake and no
 * error sound, just the bin opening its lid, which is the answer to "what do I
 * do with this" said in the only place it can be acted on.
 */
function lift(id: ToolId) {
  if (!on || finishing) return;
  if (held === id) { putDown(); return; }
  if (held && carrying()) { nudgeCan(); return; }
  const slot = slotFor(id);
  if (!slot || slot.hidden) return;
  const going = held;
  held = id;
  slot.classList.add('is-out');
  slot.setAttribute('aria-pressed', 'true');
  if (going) flyHome(going);
  showCursor(id);
  paintCanAfterFlight();
  // On the press rather than on the next frame: a board of badges that answers
  // a beat late reads as the bar lagging behind the hand.
  paintBadges();
  cue('tap', { volume: 0.35 });
}

/** Put it back in its slot. Refused - quietly, with the bin's answer - while
 *  there is anything in the hand. */
function putDown() {
  const going = held;
  if (!going) return;
  if (carrying()) { nudgeCan(); return; }
  held = null;
  hideCursor();
  flyHome(going);
  paintCanAfterFlight();
  paintBadges();
  cue('tap', { volume: 0.22 });
}

/**
 * Where a tool rests when it is not in hand: the glyph inside its slot, not the
 * slot.
 *
 * The button is a column - the drawing, then the tool's name under it - so its
 * centre is a dozen pixels below the drawing and the middle of the word. A
 * flight aimed there lands on the label. And the scale comes from the glyph's
 * own width rather than a number somebody measured once, because the narrow
 * breakpoint makes the glyph smaller and a fixed scale is only right at one
 * window size.
 */
function slotSeat(id: ToolId): { x: number, y: number, scale: number } | null {
  const ico = slotFor(id)?.querySelector('.ico');
  if (!ico) return null;
  const box = ico.getBoundingClientRect();
  if (!box.width) return null;
  return {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    scale: box.width / CURSOR_PX,
  };
}

/**
 * The tool travels back to its slot as its own node, not as the cursor: a swap
 * has two tools in the air at once, and the cursor is already carrying the new
 * one. The slot fills back in when the flight lands.
 */
function flyHome(id: ToolId) {
  const slot = slotFor(id);
  endStroke();
  if (!slot) return;
  const seat = slotSeat(id);
  const ghost = toolSvg(id);
  ghost.className = 'clean-cursor is-ghost';
  ghost.style.setProperty('--clean-x', at.x.toFixed(1) + 'px');
  ghost.style.setProperty('--clean-y', at.y.toFixed(1) + 'px');
  document.body.append(ghost);
  if (seat) ghost.animate(
    [
      { transform: 'translate(0px, 0px) scale(1)' },
      {
        transform: `translate(${(seat.x - at.x).toFixed(1)}px, ${(seat.y - at.y).toFixed(1)}px)`
          + ` scale(${seat.scale.toFixed(3)})`,
      },
    ],
    { duration: TRAVEL_MS, easing: EASE, fill: 'forwards' },
  );
  later(() => {
    ghost.remove();
    slot.classList.remove('is-out');
    slot.setAttribute('aria-pressed', 'false');
  }, TRAVEL_MS);
}

/** Bring the held tool out of its slot and into the hand. On a touchscreen
 *  there is no hover point to fly to, so it arrives in the middle of the
 *  viewport and waits for the finger. */
function showCursor(id: ToolId) {
  if (!cursor || !cursorUse || !vp) return;
  cursorUse.setAttribute('href', `assets/icons.svg#i-clean-${id}`);
  // Which tool is out, for the stylesheet: the gauge is the washer's alone and
  // a dark slot drawn across the back of the glove is the kind of thing nobody
  // reports because it just looks like the drawing is wrong.
  cursor.dataset.tool = id;
  // The drawing is shifted so its working end, not its middle, is under the
  // pointer - the reach ring stays where it is, because that is the pointer.
  const tip = TIP[id];
  cursor.style.setProperty('--clean-tip-x', (((24 - tip.x) * CURSOR_PX) / 48).toFixed(1) + 'px');
  cursor.style.setProperty('--clean-tip-y', (((24 - tip.y) * CURSOR_PX) / 48).toFixed(1) + 'px');
  cursor.hidden = false;
  cursor.classList.remove('is-idle');
  catcher?.classList.add('has-tool');
  paintLoad();
  if (at.x < 0) {
    const box = vp.el.getBoundingClientRect();
    at = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  const seat = slotSeat(id);
  moveCursor(at.x, at.y);
  if (!seat) return;
  cursor.animate(
    [
      {
        transform: `translate(${(seat.x - at.x).toFixed(1)}px, ${(seat.y - at.y).toFixed(1)}px)`
          + ` scale(${seat.scale.toFixed(3)})`,
      },
      { transform: 'translate(0px, 0px) scale(1)' },
    ],
    { duration: TRAVEL_MS, easing: EASE },
  );
}

function hideCursor() {
  catcher?.classList.remove('has-tool');
  if (!cursor) return;
  cursor.hidden = true;
  cursor.classList.remove('is-idle');
  delete cursor.dataset.tool;
}

/** Where each tool's working end is, in its symbol's 48 box: the glove's palm,
 *  the washer's nozzle, the middle of the duster's plume. That point is what
 *  sits under the pointer and what the tilt turns about, so the tool is held by
 *  its handle and never covers what it is cleaning. The numbers are the
 *  symbols', in icons.svg. */
const TIP: Record<ToolId, { x: number, y: number }> = {
  glove: { x: 22, y: 22 },
  washer: { x: 11.3, y: 5.6 },
  duster: { x: 17.5, y: 16 },
};

/** The side of .clean-cursor in clean.css. */
const CURSOR_PX = 64;

/** The host both the cursor and a homeward ghost are built from. */
function toolSvg(id: ToolId): HTMLElement {
  const host = div('clean-cursor');
  // The stylesheet picks the tool's pigment off this.
  host.dataset.tool = id;
  const svg = ns('svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 48 48');
  const use = ns('use');
  use.setAttribute('href', `assets/icons.svg#i-clean-${id}`);
  svg.append(use);
  host.append(svg);
  return host;
}

/**
 * The pointer is hidden and this is drawn in its place, so the hand is holding
 * the tool rather than pointing at a picture of one in a bar. Large, and its
 * own illustration rather than a 16px glyph blown up - see icons.svg.
 *
 * The ring around it is the tool's *actual* reach, in world units scaled by the
 * zoom - so the washer is visibly a narrow jet and the duster visibly a wide
 * sweep, and a stroke that missed is a stroke you can see missed.
 */
function buildCursor(): HTMLElement {
  const host = div('clean-cursor');
  host.hidden = true;
  const svg = ns('svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 48 48');
  cursorSpin = ns('g');
  cursorSpin.setAttribute('class', 'clean-spin');
  cursorUse = ns('use');
  loadG = ns('g');
  loadG.setAttribute('class', 'clean-load');
  cursorSpin.append(cursorUse, loadG);
  svg.append(cursorSpin);
  host.append(svg);
  // The tank, as a bar standing beside the tool rather than a slot drawn into
  // it. Outside the SVG on purpose, and so outside .clean-spin: it is a reading,
  // not part of the gun, and a gauge that leans over with the tilt is a gauge
  // you have to read at an angle. Only the washer ever shows it (clean.css).
  const bar = div('clean-tank');
  tankFill = div('clean-tank-fill');
  bar.append(tankFill);
  host.append(bar);
  return host;
}

/** Where a carried piece sits in the glove, in the symbol's own 48 box. Piled
 *  above the cuff with small offsets, so a full glove looks full without a
 *  number anywhere near it. */
const LOAD_SPOTS = [
  { x: 22, y: 25, r: -8 }, { x: 18, y: 22, r: 14 }, { x: 27, y: 22, r: -20 },
  { x: 21, y: 19, r: 26 }, { x: 25, y: 28, r: -32 },
];

function paintLoad() {
  if (!loadG) return;
  loadG.replaceChildren();
  if (held !== 'glove') return;
  carried.forEach((bit, i) => {
    const spot = LOAD_SPOTS[Math.min(i, LOAD_SPOTS.length - 1)]!;
    const seat = ns('g');
    seat.setAttribute('transform', `translate(${spot.x} ${spot.y}) rotate(${spot.r}) scale(0.62)`);
    seat.append(bit.node);
    sizeBit(bit.node, 1, 1);
    loadG!.append(seat);
  });
}

// ---- the pointer --------------------------------------------------------

/**
 * What a press means, decided at pointerdown and never changed mid-gesture.
 *
 * The rule the last pass got wrong was making the left button mean one thing
 * for ever. With nothing in the hand there is nothing for it to mean but the
 * camera, and with a tool in the hand over work there is nothing for it to mean
 * but the work - so the answer is a question about what is being held and what
 * is under it, asked once, at the moment of the press.
 */
function intent(e: PointerEvent, x: number, y: number): 'pan' | 'work' | 'drop' {
  if (e.button === 1 || spaceHeld) return 'pan';
  if (e.button !== 0) return 'pan';
  if (!held) return 'pan';
  if (underTool(x, y)) return 'work';
  if (held === 'glove' && carried.length && !nearCan(x, y)) return 'drop';
  return 'pan';
}

/** Space is hold-to-pan on the board, and it stays hold-to-pan in here. Fed
 *  from canvas/input.ts, which owns the only keyboard listener in the app. */
export function cleanSpace(down: boolean) {
  if (!on || spaceHeld === down) return;
  spaceHeld = down;
  catcher?.classList.toggle('can-pan', down);
  cursor?.classList.toggle('is-hidden', down);
}

/** Whether the tool in hand has anything to bite at this point. Deliberately
 *  asks about *this* tool: the duster over one of a cobweb's strands is work,
 *  and the same press with the washer is a pan. */
function underTool(clientX: number, clientY: number): boolean {
  if (!vp || !held) return false;
  const w = vp.toWorld(clientX, clientY);
  const radius = TUNING.reach[held].radius;
  if (held === 'duster')
    return webs.some(web => nearCurve(w.x, -w.y, web) <= radius);
  // A glove with no room left is not over work, it is over somewhere to put
  // what it is holding - which is rule 4 in intent(), and is why this asks
  // whether the piece would fit rather than only whether it is there. Without
  // it a full hand over a pile of leaves is a press that does nothing at all.
  const room = (kind: MessKind) => handRoom(carried.map(c => c.kind), kind);
  if (held === 'glove'
    && loose.some(b => room(b.kind) && Math.hypot(b.x - w.x, b.y + w.y) <= radius)) return true;
  for (const card of cards) {
    const p = toCard(card, w.x, w.y);
    const rx = radius / card.item.w;
    const ry = radius / card.item.h;
    if (p.u < -rx || p.u > 1 + rx || p.v < -ry || p.v > 1 + ry) continue;
    if (held === 'glove' && card.debris.some(b => room(b.kind))) return true;
    if (held === 'washer'
      && card.fields.some(f => !f.fading && f.field.left && yieldsTo(f.kind, 'washer'))) return true;
  }
  return false;
}

function bindPointer(node: HTMLElement) {
  node.addEventListener('pointerdown', e => {
    pointers++;
    // Two fingers are the camera, not the tool. The stroke is abandoned and
    // both are steered here rather than handed down, because canvas/input.ts
    // never saw the first one and cannot start a gesture from half of one.
    if (pointers > 1) { endStroke(); last = null; return; }
    e.stopPropagation();
    e.preventDefault();
    byTouch(e);
    // The right button is the way out of the tool, not a second pan. Nothing
    // else in the app opens a menu here, so there is nothing to lose.
    if (e.button === 2) { putDown(); return; }
    node.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY };
    moveCursor(e.clientX, e.clientY);
    const want = intent(e, e.clientX, e.clientY);
    if (want === 'pan') { panning = true; node.classList.add('is-panning'); return; }
    if (want === 'drop') { dropHandful(e.clientX, e.clientY); return; }
    drawing = true;
    strokeAt = null;
    apply(e.clientX, e.clientY, true);
    strokeAt = { x: e.clientX, y: e.clientY };
  });

  node.addEventListener('pointermove', e => {
    byTouch(e);
    moveCursor(e.clientX, e.clientY);
    if (pointers > 1 || panning) { dragPan(e); return; }
    e.stopPropagation();
    // With nothing held down the cursor still says whether this tool has
    // anything to do here.
    if (!drawing) { cursor?.classList.toggle('is-idle', !!held && !underTool(e.clientX, e.clientY)); return; }
    // Every point the pointer passed through, not just where it ended up, and
    // the line between them as well. A fast sweep is one event across half a
    // card; stamping only where the events landed leaves a dotted trail with
    // grime surviving in the gaps, which reads as a tool that half works.
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const p of events) strokeTo(p.clientX, p.clientY);
  });

  const up = (e: PointerEvent) => {
    pointers = Math.max(0, pointers - 1);
    if (pointers === 0) { last = null; endStroke(); }
    if (node.hasPointerCapture?.(e.pointerId)) node.releasePointerCapture(e.pointerId);
  };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  // No context menu on the glass: the right button puts the tool down here, and
  // a menu over a board somebody is cleaning is chrome this mode took away.
  node.addEventListener('contextmenu', e => e.preventDefault());
}

/**
 * A finger covers the thing it is working on, so on touch the drawing is moved
 * up and left of the point while the *reach ring stays on it* - the ring is
 * where the tool bites and moving that would be a lie. Set from the event
 * rather than from a media query: a touchscreen laptop is both.
 */
function byTouch(e: PointerEvent) {
  cursor?.classList.toggle('is-touch', e.pointerType === 'touch');
}

/**
 * How far apart consecutive touches of the tool are laid, as a share of its
 * radius. A painting program calls this the brush spacing and puts it near a
 * tenth of the brush. A third of a radius, which is what this was, leaves a
 * scalloped edge you can count the dabs in.
 */
const SPACING = 0.15;

/**
 * Most touches one pointer event may lay. A pointer that jumped across the
 * window - a tab switch, a breakpoint, a dropped frame under load - must not
 * grind out hundreds of them.
 *
 * **Reaching it leaves a gap rather than spreading the touches out.** Spreading
 * them is what this used to do, by dividing the span into a fixed number of
 * equal parts, and it is why a fast sweep came out spotty: the cap can only ever
 * bite when the span is long, so the spacing quietly grew exactly when the hand
 * was moving fast enough for it to show.
 */
const MAX_DABS = 160;

/**
 * Lay the tool along the line from the last point to this one, at a constant
 * spacing measured in the tool's own radius - the way a brush is laid down.
 *
 * The leftover distance is carried in `strokeLeft` from one event to the next,
 * so the spacing is the same across an event boundary as within one. Without
 * that, every event restarts the walk and the dabs bunch and gap at the seams
 * between them, which is the other half of what "spotty" was.
 */
function strokeTo(x: number, y: number) {
  const from = strokeAt;
  const tool = held;
  strokeAt = { x, y };
  if (!from || !tool) { strokeLeft = 0; apply(x, y, false); return; }
  const dx = x - from.x;
  const dy = y - from.y;
  const span = Math.hypot(dx, dy);
  if (span <= 0) return;
  // The radius the jet is *actually* at, not its resting one: a fast sweep is
  // half again as wide, and spacing measured against the wrong width is the
  // thing this constant exists to avoid.
  const reach = TUNING.reach[tool].radius
    * (tool === 'washer' ? jetShape(handSpeed).radius : 1);
  const step = Math.max(1.5, reach * (vp?.zoom ?? 1) * SPACING);
  const ux = dx / span;
  const uy = dy / span;
  let walk = strokeLeft;
  let laid = 0;
  while (walk <= span && laid < MAX_DABS) {
    apply(from.x + ux * walk, from.y + uy * walk, false);
    walk += step;
    laid++;
  }
  strokeLeft = Math.max(0, walk - span);
}

function endStroke() {
  drawing = false;
  panning = false;
  strokeAt = null;
  strokeLeft = 0;
  catcher?.classList.remove('is-panning');
  hiss?.stop();
  hiss = null;
}

/**
 * Move the board under the hand - an empty hand, a tool with nothing under it,
 * the middle button, a held Space, or two fingers. Not pinch-to-zoom:
 * Viewport.zoomAt() refuses on a mobile board, so a pinch would work on a
 * touchscreen laptop and silently do nothing on a phone. The wheel zooms.
 */
function dragPan(e: PointerEvent) {
  if (!vp || !e.isPrimary) return;
  if (last) {
    vp.pan.x -= (e.clientX - last.x) / vp.zoom;
    vp.pan.y += (e.clientY - last.y) / vp.zoom;
    vp.apply();
  }
  last = { x: e.clientX, y: e.clientY };
}

/** The jet's hiss and the duster's brush. The glove is silent while it works -
 *  a hand is. */
const SOUND: Partial<Record<ToolId, { filterType: BiquadFilterType, filterFrequency: number, filterQ: number, gain: number }>> = {
  washer: { filterType: 'highpass', filterFrequency: 2400, filterQ: 0.5, gain: 0.16 },
  duster: { filterType: 'bandpass', filterFrequency: 3400, filterQ: 0.7, gain: 0.06 },
};

/** What every tool but the washer answers to: its own reach, its own bite. */
const ONE_SHAPE = { radius: 1, bite: 1 };

/** One touch of the tool at a screen point. */
function apply(clientX: number, clientY: number, press: boolean) {
  const tool = held;
  if (!vp || !tool || finishing) return;
  appliedAt = performance.now();
  const w = vp.toWorld(clientX, clientY);
  // Distance is pressure: a slow hand is a tight, hard jet and a sweep is a
  // wide, light one. Only the washer answers to it - a glove reaches as far as
  // a glove reaches however fast it is waved.
  const shape = tool === 'washer' ? jetShape(handSpeed) : ONE_SHAPE;
  const radius = TUNING.reach[tool].radius * shape.radius;
  let worked = 0;

  // The jet's bite, in passes, and a fraction of one is the ordinary case: the
  // grid counts sub-units of a pass so a weaker jet is *weaker* rather than
  // intermittent. It used to be banked in an accumulator and spent whole, which
  // at five hundredths of a pass was one stamp in eighteen doing all the work
  // and the rest doing nothing - a lowered fire rate wearing a jet's clothes.
  const power = tool === 'washer' ? tankPower(tank) : 0;
  const bite = tool === 'washer' ? power * shape.bite : 0;

  for (const card of cards) {
    const p = toCard(card, w.x, w.y);
    // A margin, so a stroke along the very edge still bites. The radius is in
    // world units and the card is measured in them, which is why this compares
    // in card space rather than in pixels.
    const rx = radius / card.item.w;
    const ry = radius / card.item.h;
    if (p.u < -rx || p.u > 1 + rx || p.v < -ry || p.v > 1 + ry) continue;
    worked += workCard(card, p.u, p.v, rx, ry, press, bite, clientX, clientY);
  }
  if (tool === 'glove') worked += scoopLoose(w.x, -w.y, radius, press);
  if (tool === 'duster') worked += sweepWebs(w.x, -w.y, radius);


  // The hiss follows the work, which is what makes a tool on the wrong mess
  // sound like nothing rather than like cleaning. For the washer it follows the
  // tank as well, so an emptying one is heard softening before it is seen.
  const spec = SOUND[tool];
  if (spec && drawing) {
    if (!hiss) hiss = sustain(spec);
    if (tool === 'washer') {
      hiss.level(power * (worked > 0 ? 1 : 0.12));
      hiss.tone(700 + power * 2600);
    } else {
      hiss.level(worked > 0 ? 1 : 0.12);
    }
  }
  if (worked) paintCount();
}

/**
 * World point to a card's own 0..1 box, undoing everything the card is turned
 * by - which is its rotation *and* its lean. Taking the LiveCard rather than the
 * Item is the whole of the fix: the lean is not on the item, it is on the node,
 * and a hit test that only knew about item.rot was testing a card that is not
 * the one on screen.
 */
function toCard(card: LiveCard, wx: number, wy: number) {
  const item = card.item;
  const dx = wx - item.x;
  const dy = -wy - -item.y;
  const deg = item.rot - card.lean;
  if (!deg) return { u: dx / item.w + 0.5, v: dy / item.h + 0.5 };
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    u: (dx * cos - dy * sin) / item.w + 0.5,
    v: (dx * sin + dy * cos) / item.h + 0.5,
  };
}

/** The other way: a point in the card's own 0..1 box back out to the world.
 *  Exactly toCard() inverted, and the rivulets' drop is the only caller - it
 *  leaves at the bottom edge, which is a place on the card that has to be found
 *  on the board. */
function fromCard(card: LiveCard, u: number, v: number): { x: number, y: number } {
  const item = card.item;
  const px = (u - 0.5) * item.w;
  const py = (v - 0.5) * item.h;
  const deg = item.rot - card.lean;
  const a = (-deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = deg ? px * cos - py * sin : px;
  const dy = deg ? px * sin + py * cos : py;
  return { x: item.x + dx, y: item.y - dy };
}

/**
 * How far the card is leaning, in the degrees CSS would write.
 *
 * A card's lean is presentational and lives nowhere but the node: items.css
 * turns every card by `--item-tilt * --tilt-max`, the factor is dealt from a bag
 * when the card is built, and it is dealt *again* when a card that was culled
 * comes back. So this is read rather than remembered, and re-read every frame in
 * tick() for exactly that reason - a card panned off the screen and back is
 * wearing a new lean, and its dirt has to follow it.
 *
 * The two switches that straighten the board are mirrored here rather than in
 * clean.css, so there is one place that answers "how far over is this card"
 * instead of a stylesheet and a hit test that have to agree.
 */
function leanOf(item: Item): number {
  const root = document.documentElement;
  if (root.dataset.snap !== undefined || root.dataset.noTilt !== undefined) return 0;
  return tiltOf(item.id) * tiltMax;
}

/**
 * Round the dirt's corners to the card's own, read off the live node.
 *
 * Not computed here and not a token. A card's corner is
 * `min(--shape-radius, half the shorter side)`, `--shape-radius` is overridden
 * per item type - a note is not a card is not a sticker - and the cap depends on
 * the card's size. Copying the token the generic card happens to use rounded the
 * crust to something the card underneath it was not, and the mismatch shows at
 * every corner of every card at once.
 *
 * `getComputedStyle` is a style flush, so it is read **once** per card and only
 * while it has a node: a card culled when the mode opened keeps square corners
 * until it comes back, which is fine, since a card nobody can see does not have
 * a corner anybody can see either.
 */
function setRadius(card: LiveCard) {
  if (card.rounded) return;
  const node = document.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(card.item.id)}"]`);
  if (!node) return;
  card.box.style.borderRadius = getComputedStyle(node).borderRadius;
  card.rounded = true;
}

/** Put the card's lean on its dirt, if it has changed. Written as `rotate`, the
 *  individual property, exactly as items.css writes it - the box's `transform`
 *  is already carrying item.rot and the two must not fight over one slot. */
function setLean(card: LiveCard) {
  const want = leanOf(card.item);
  if (Math.abs(want - card.lean) < 0.001) return;
  card.lean = want;
  card.box.style.rotate = want.toFixed(3) + 'deg';
}

/**
 * The shield a piece of debris casts over the crust under it.
 *
 * Handed to stamp() as a predicate rather than read from inside it, so mess.ts
 * still knows nothing about what a leaf is. This is the one bit of order the
 * game has: a leaf on rust has to be gloved off before the jet can reach what
 * it is lying on.
 */
function shieldOf(card: LiveCard): ((i: number) => boolean) | null {
  if (!card.debris.length) return null;
  const g = TUNING.grid;
  const bits = card.debris.map(b => ({ x: b.x, y: b.y, r: SHADE_R * b.size }));
  return (i: number) => {
    const u = ((i % g) + 0.5) / g;
    const v = (Math.floor(i / g) + 0.5) / g;
    return bits.some(b => Math.hypot(b.x - u, b.y - v) <= b.r);
  };
}

function workCard(
  card: LiveCard, u: number, v: number, rx: number, ry: number,
  press: boolean, bite: number, clientX: number, clientY: number,
): number {
  let worked = 0;

  if (held === 'washer') {
    // Water lands where you point it, dirt or no dirt. This used to sit inside
    // the branch below that runs only where a stamp *finished* cells, so the
    // wet patch went out the instant the crust under the nozzle was gone, and a
    // card with nothing on it never got wet however long the jet was held on
    // it. What comes off the card is the flecks' business and the runoff's;
    // being wet is the jet's.
    if (bite > 0) sheen(card, u, v, rx, ry);
    const shield = shieldOf(card);
    for (const f of card.fields.slice()) {
      if (f.fading || !f.field.total || !f.field.left) continue;
      const depth = Math.max(1, TUNING.depth[f.kind] ?? 1);
      if (bite > 0) {
        // Whether the cell under the nozzle is on its last pass. One lookup
        // rather than a scan of the grid: the crisp edge is wanted where the
        // jet is pointing, and that cell is where it is pointing. The grid
        // counts sub-units and the bite is in passes, hence the SUBS.
        const span = depth * SUBS;
        const lastPass = cellUnder(f.field, u, v) <= bite * SUBS;
        // What the erase is allowed to take, read off the disc it will cover
        // rather than off the cell under the nozzle - see wearOf(). Measured
        // before the stamp, because it is asking what is about to be removed.
        const wear = wearOf(f.field, u, v, rx, ry, bite, span, shield);
        const took = stamp(f.field, u, v, rx, ry, bite, shield);
        eraseAlpha(f, u, v, rx, ry, wearShare(wear.before, wear.taken), lastPass);
        if (took) {
          fleck(clientX, clientY, f.kind, took);
          // Both only where a pass finished cells: a stroke that merely thinned
          // the crust has freed nothing to run off and bared nothing to shine.
          gleam(card, u, v, rx, ry);
          startRun(card, u, v, f.kind, took);
          // Darkened where the crust has been worked down, so a half-washed
          // patch looks thinned and wet rather than merely fainter.
          //
          // **Only where a pass finished cells.** It used to run on every touch
          // of the jet, and a touch is one interpolated step of a stroke - forty
          // eight of them in a single pointer event. At six percent a step that
          // is ninety-five percent black after one sweep, painted onto the crust
          // where nothing ever takes it off again: a permanent black streak down
          // everywhere the jet had been. Tied to the work, it can happen at most
          // once per pass per cell, which is two times for mud and five for tar.
          wetAlpha(f, u, v, rx, ry);
        }
        worked++;
      }
      if (fieldClear(f.field)) dissolve(card, f);
    }
    // A piece the jet cannot lift still gets pushed about by it.
    skid(card, u, v, rx, ry);
  }

  if (held === 'glove') {
    for (const bit of card.debris.slice()) {
      if (Math.hypot((bit.x - u) * card.item.w, (bit.y - v) * card.item.h) > TUNING.reach.glove.radius) continue;
      if (!handRoom(carried.map(c => c.kind), bit.kind)) continue;
      // Gum takes three presses, each of which stretches it toward the glove
      // and lets it go again. A sweep does not count: it is a thing to pull at.
      if (bit.tough > 1) {
        if (!press) continue;
        bit.tough--;
        tug(bit, u, v);
        cue('pick', { volume: 0.25 });
        worked++;
        continue;
      }
      scoop(card, bit);
      worked++;
    }
  }

  if (!card.clean && cardClean(asState(card), webs)) markClean(card);
  return worked;
}

/** How many passes the cell under this point still wants. Zero off the grid,
 *  which reads as "nothing left here" and is what a stroke over the edge is. */
function cellUnder(f: Field, u: number, v: number): number {
  const g = Math.round(Math.sqrt(f.cells.length));
  const ix = Math.floor(u * g);
  const iy = Math.floor(v * g);
  if (ix < 0 || iy < 0 || ix >= g || iy >= g) return 0;
  return f.cells[iy * g + ix]!;
}

const asState = (c: LiveCard) => ({
  id: c.item.id,
  fields: c.fields.filter(f => !f.fading).map(f => f.field),
  debris: c.debris,
});

function eraseAlpha(f: LiveField, u: number, v: number, rx: number, ry: number, share: number, crisp: boolean) {
  eraseAt(
    f.ctx,
    u * f.canvas.width, v * f.canvas.height,
    rx * f.canvas.width, ry * f.canvas.height,
    Math.min(1, share), rng, crisp,
  );
}

function wetAlpha(f: LiveField, u: number, v: number, rx: number, ry: number) {
  wetAt(
    f.ctx,
    u * f.canvas.width, v * f.canvas.height,
    rx * f.canvas.width, ry * f.canvas.height,
    0.06,
  );
}

/** The sheen left behind on the card itself. Its own canvas above the crust, so
 *  it fades on its own clock and is never in the way of the erase below it. */
function sheen(card: LiveCard, u: number, v: number, rx: number, ry: number) {
  sheenAt(
    card.wetCtx,
    u * card.wet.width, v * card.wet.height,
    rx * card.wet.width, ry * card.wet.height,
  );
  card.wetAt = performance.now();
  card.wet.style.opacity = String(SHEEN_PEAK);
}

/** How often the front of the jet may gleam. Not a nicety: this paints onto the
 *  sheen's canvas, which takes two seconds to fade, so it is the one effect here
 *  that *accumulates*. Called from the washer's pass, and a pass is one
 *  interpolated step of a stroke - up to forty-eight of them for a single
 *  pointer event, and again for every coalesced one. */
const GLEAM_MS = 60;

/** The wet gleam at the front of the jet, on the sheen's own canvas so it dies
 *  with the sheen's fade and costs no canvas of its own. The drawing is
 *  art.ts's; what is decided here is when. */
function gleam(card: LiveCard, u: number, v: number, rx: number, ry: number) {
  const now = performance.now();
  if (now - gleamAtMs < GLEAM_MS) return;
  gleamAtMs = now;
  const w = card.wet.width;
  const h = card.wet.height;
  const dx = at.x - speedFrom.x;
  const dy = at.y - speedFrom.y;
  const len = Math.hypot(dx, dy) || 1;
  gleamAt(
    card.wetCtx, u * w, v * h, Math.max(rx * w, ry * h),
    dx / len, dy / len,
  );
}

// ---- water running off --------------------------------------------------

/** Cells a stamp has to finish before any water runs off it. A stroke that only
 *  thins the crust has not freed anything to run. */
const RUN_CELLS = 3;
/** Fastest one card may sprout rivulets, so a jet held on one spot does not
 *  turn the card into a waterfall. Doubled from 110 after watching it: at one
 *  every tenth of a second a sweep left a row of runs marching down the card
 *  together, and a handful of them is water where a crowd of them is a pattern. */
const RUN_GAP_MS = 220;
/** Card heights a second. Slow: this is water on a nearly flat surface. */
const RUN_FALL = 0.3;
/** How far below the card the parting drop falls, in world units. */
const DRIP_FALL = 22;
/** How long the canvas is kept after the last rivulet has gone, and the stretch
 *  at the end of that over which the whole layer fades. The per-frame decay has
 *  taken a trail down to a thousandth by then; the fade is what makes sure the
 *  clear can never be seen even so. */
const RUN_TAIL_MS = 2200;
const RUN_OUT_MS = 600;

/**
 * Water leaves where the jet finished cells, and takes the dirt with it.
 *
 * Cosmetic throughout: never counted, no tool touches it, gone on its own in
 * about two seconds. The trail is **painted, not drawn** - runAt() lays a soft
 * round wash at the head every frame and the trail is the overlap of a hundred
 * of them, so it has no edge anywhere and no line in it. The fade is one
 * `destination-out` fill over the whole canvas per frame rather than a life per
 * trail, so a card carrying six rivulets costs what a card carrying one does.
 */
function startRun(card: LiveCard, u: number, v: number, kind: MessKind, took: number) {
  if (!quality.anim || took < RUN_CELLS) return;
  const now = performance.now();
  if (now - card.runAt < RUN_GAP_MS) return;
  // Halved on the low tier by letting every other one through, rather than by a
  // second set of numbers to keep in step with these.
  if (!richly() && rng() < 0.5) return;
  card.runAt = now;
  card.runTill = now + RUN_TAIL_MS;
  card.run.style.opacity = '1';
  card.runs.push({ x: u, y: v, drift: (rng() - 0.5) * 0.02, born: now, kind });
}

function drawRuns(card: LiveCard, dt: number, now: number) {
  if (!card.runs.length && !card.runTill) return;
  const ctx = card.runCtx;
  const w = card.run.width;
  const h = card.run.height;

  // One decay for the whole canvas. A trail thins from its oldest end for free,
  // because the oldest end has been faded the most times.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${(1 - Math.exp((-2.6 * dt) / 1000)).toFixed(4)})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const alive: Rivulet[] = [];
  for (const r of card.runs) {
    const t = (now - r.born) / 1000;
    // A run of water is fattest at its head, thins behind it, and runs out of
    // itself as it goes.
    const spent = Math.min(1, t / 2.4);
    const rad = (w / 300) * (3.2 - spent * 1.5);
    const fx = r.x;
    const fy = r.y;
    // The drift wanders rather than oscillating: a slow random walk, nudged and
    // damped every frame, which never repeats and has no frequency to see.
    r.drift = r.drift * 0.94 + (rng() - 0.5) * 0.012;
    r.x += (r.drift * dt) / 1000;
    r.y += (RUN_FALL * dt) / 1000;

    // Laid along the step, not once at the end of it. One wash a frame is a
    // chain of separate dots the moment a frame runs long - which is most of
    // them over Remote Desktop - and a chain of dots is what a rivulet must
    // never be. Sub-stepped by the radius, the way strokeTo() does for the jet.
    const span = Math.hypot((r.x - fx) * w, (r.y - fy) * h);
    const steps = Math.max(1, Math.min(12, Math.ceil(span / (rad * 0.4))));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      runAt(
        ctx, (fx + (r.x - fx) * k) * w, (fy + (r.y - fy) * k) * h,
        rad, r.kind, i === steps, 1 - spent * 0.7,
        // It leaves the card dirty and runs cleaner, which is the whole of what
        // washing something is.
        1 - spent * 0.55,
      );
    }
    if (r.y >= 1) { drip(card, r); continue; }
    if (spent < 1) alive.push(r);
  }
  card.runs = alive;
  // Measured from the last rivulet *gone*, not the last one born - a trail
  // lives two and a half seconds, so a canvas thrown away on the birth clock
  // took the newest trail away when it was a fifth of a second old and still
  // at full strength. And the layer fades over the last stretch, so whatever
  // the decay has not finished is gone before the clear rather than by it.
  if (alive.length) card.runTill = now + RUN_TAIL_MS;
  const left = card.runTill - now;
  card.run.style.opacity = Math.min(1, Math.max(0, left / RUN_OUT_MS)).toFixed(3);
  if (left <= 0) {
    ctx.clearRect(0, 0, w, h);
    card.run.style.opacity = '0';
    card.runTill = 0;
  }
}

/**
 * The drop that leaves the card at the end of a rivulet.
 *
 * A speck on the mist canvas rather than a node of its own: the card's box is
 * clipped to its corner radius so this cannot be drawn on the card, and the
 * mist canvas is already a soft-gradient particle system covering the whole
 * viewport. It was a flat `<div>` with a background colour for one version,
 * which is a coloured rectangle and reads as one.
 */
function drip(card: LiveCard, r: Rivulet) {
  if (!vp || !quality.anim) return;
  const world = fromCard(card, r.x, 1);
  const seat = vp.toScreen(world.x, world.y);
  // It has run the length of a card by now, so it is mostly water.
  const [wr, wg, wb] = washOf(r.kind, 0.45);
  const zoom = vp.zoom;
  motes.push({
    x: seat.x, y: seat.y,
    vx: 0, vy: (DRIP_FALL * zoom) / 0.6,
    at: performance.now(), ms: 600,
    r: 2.2 * zoom,
    ...moteInk(wr, wg, wb, 0.5),
  });
}

// ---- the badge ----------------------------------------------------------

/** The zoom the badges were last counter-scaled against. One number for the
 *  whole board: they all sit at the same scale, so a frame at an unchanged
 *  zoom writes no transforms at all. */
let badgeZoom = 0;

/**
 * What the tool in hand still owes this card, at its corner.
 *
 * Every card, every frame a tool is held - which is why nothing below touches
 * the DOM unless the answer has actually moved. With no tool in hand there is
 * no question, and the badges are simply not there.
 */
function paintBadge(card: LiveCard, zoom: number) {
  const want = held
    ? toolWork(asState(card), webs, held, { debris: card.debrisDealt, webs: card.websDealt })
    : null;
  const state: BadgeState = !want ? '' : toolWanted(want) ? 'want' : 'done';
  // Two decimal places: the arc is 56.55 units round, so anything finer than
  // this is below half a pixel and is a DOM write nobody can see.
  const share = want ? Math.round(toolShare(want) * 100) / 100 : 0;

  if (state !== card.badgeState) {
    card.badgeState = state;
    card.ring.classList.toggle('is-up', state !== '');
    card.ring.classList.toggle('is-want', state === 'want');
    card.ring.classList.toggle('is-done', state === 'done');
  }
  if (state === '') return;
  if (share !== card.badgeShare) {
    card.badgeShare = share;
    card.ringFg.setAttribute('stroke-dashoffset', (RING_LEN * (1 - share)).toFixed(2));
  }
  if (zoom !== badgeZoom) card.ring.style.transform = `scale(${(1 / zoom).toFixed(3)})`;
}

/** Every badge at once: on a tool changing hands, where waiting for the next
 *  frame reads as the bar lagging behind the press. */
function paintBadges() {
  const zoom = vp?.zoom ?? 1;
  for (const card of cards) paintBadge(card, zoom);
  badgeZoom = zoom;
}

function dissolve(card: LiveCard, f: LiveField) {
  if (f.fading) return;
  f.fading = true;
  f.canvas.classList.add('clean-gone');
  later(() => {
    f.canvas.remove();
    const idx = card.fields.indexOf(f);
    if (idx >= 0) card.fields.splice(idx, 1);
    if (!card.clean && cardClean(asState(card), webs)) markClean(card);
    paintCount();
  }, LEAVE_MS);
}

// ---- the glove ----------------------------------------------------------

/** Pull the gum toward the hand and let it snap back. Both ends of the motion
 *  are the same CSS transition, which is why nothing here has a duration. */
function tug(bit: LiveBit, u: number, v: number) {
  const dx = (u - bit.x) * 100;
  const dy = (v - bit.y) * 100;
  const len = Math.hypot(dx, dy) || 1;
  bit.node.classList.add('clean-resist');
  placeBit(bit.node, bit.x * 100 + (dx / len) * 4, bit.y * 100 + (dy / len) * 4);
  later(() => {
    placeBit(bit.node, bit.x * 100, bit.y * 100);
    later(() => bit.node.classList.remove('clean-resist'), 320);
  }, 260);
}

/** A piece leaves the card and joins the hand. The same node, re-parented -
 *  so what is in the glove is visibly the thing that was on the card. */
function scoop(card: LiveCard, bit: LiveBit) {
  const idx = card.debris.indexOf(bit);
  if (idx >= 0) card.debris.splice(idx, 1);
  takeIntoHand(bit);
}

function scoopLoose(wx: number, wy: number, radius: number, press: boolean): number {
  let took = 0;
  for (const bit of loose.slice()) {
    if (Math.hypot(bit.x - wx, bit.y - wy) > radius) continue;
    if (!handRoom(carried.map(c => c.kind), bit.kind)) continue;
    if (bit.tough > 1) {
      if (!press) continue;
      bit.tough--;
      took++;
      continue;
    }
    loose.splice(loose.indexOf(bit), 1);
    bit.host?.remove();
    bit.host = null;
    takeIntoHand(bit);
    took++;
  }
  return took;
}

function takeIntoHand(bit: LiveBit) {
  bit.node.classList.remove('clean-resist');
  bit.node.style.transform = '';
  carried.push(bit);
  paintLoad();
  cue('pick', { volume: 0.4 });
}

/**
 * Tip the handful out where the click was.
 *
 * Over a card the pieces become that card's debris again, and the card
 * un-cleans if it had been clean - silently, because nothing here is a mistake
 * and the count simply reads what is true. Over bare board they lie on the
 * board, and the board is not finished while they do.
 */
function dropHandful(clientX: number, clientY: number) {
  if (!vp || !carried.length) return;
  const w = vp.toWorld(clientX, clientY);
  const onto = cardAt(w.x, w.y);
  for (const bit of carried) {
    if (onto) {
      const p = toCard(onto, w.x, w.y);
      bit.x = Math.min(0.95, Math.max(0.05, p.u + (rng() - 0.5) * 0.12));
      bit.y = Math.min(0.95, Math.max(0.05, p.v + (rng() - 0.5) * 0.12));
      bit.tough = bit.kind === 'gum' ? TUNING.gumTugs : 1;
      onto.bits.append(bit.node);
      sizeOnCard(bit.node, onto.item);
      placeBit(bit.node, bit.x * 100, bit.y * 100);
      onto.debris.push(bit);
      if (onto.clean) {
        onto.clean = false;
        onto.box.classList.remove('is-clean');
      }
    } else {
      bit.x = w.x + (rng() - 0.5) * 24;
      bit.y = -w.y + (rng() - 0.5) * 24;
      bit.tough = 1;
      layer?.append(looseHost(bit));
      loose.push(bit);
    }
  }
  carried = [];
  paintLoad();
  canGlow();
  cue('pick', { volume: 0.28 });
  paintCount();
}

/** A loose piece carries its own little SVG, placed in layer coordinates. One
 *  per piece rather than one big sheet, because a handful can be tipped out
 *  anywhere and a sheet would have to be as big as the board. */
function looseHost(bit: LiveBit): SVGSVGElement {
  const host = ns('svg');
  host.setAttribute('class', 'clean-loose');
  host.setAttribute('viewBox', '0 0 100 100');
  host.setAttribute('preserveAspectRatio', 'none');
  host.style.left = (bit.x - 50) + 'px';
  host.style.top = (bit.y - 50) + 'px';
  host.append(bit.node);
  sizeBit(bit.node, BIT_UNIT, BIT_UNIT);
  placeBit(bit.node, 50, 50);
  bit.host = host;
  return host;
}

const cardAt = (wx: number, wy: number): LiveCard | null => {
  for (const card of cards) {
    const p = toCard(card, wx, wy);
    if (p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1) return card;
  }
  return null;
};

/** The jet cannot lift a leaf, but it can shove it. Clamped to the card, and
 *  throttled, because a blast held on one piece would otherwise walk it across
 *  the board in half a second. */
function skid(card: LiveCard, u: number, v: number, rx: number, ry: number) {
  const now = performance.now();
  if (now - skidAt < 90) return;
  let moved = false;
  for (const bit of card.debris) {
    const dx = (bit.x - u) / rx;
    const dy = (bit.y - v) / ry;
    const d = Math.hypot(dx, dy);
    if (d > 1) continue;
    const len = Math.hypot(bit.x - u, bit.y - v) || 1e-4;
    bit.x = Math.min(0.95, Math.max(0.05, bit.x + ((bit.x - u) / len) * 0.035));
    bit.y = Math.min(0.95, Math.max(0.05, bit.y + ((bit.y - v) / len) * 0.035));
    placeBit(bit.node, bit.x * 100, bit.y * 100);
    moved = true;
  }
  if (moved) skidAt = now;
}

/** How long the card is up for. Long enough to read as the card doing it and
 *  not as a flicker; short enough that a board finishing in a run of three does
 *  not become a wave. */
const WAKE_MS = 500;

/**
 * A card that has just come clean wakes up: the real item does what it does
 * under the pointer, and the dirt layer's box goes with it.
 *
 * The class rather than a transform of our own, so the whimsy dial decides how
 * much a card moves - at Harsh `--lift-hover` is 0 and `--grow-hover` is 1 and
 * the card holds perfectly still, which is that tier working rather than this
 * failing. The cards are frozen with `pointer-events: none` for the mode, which
 * stops hover but has never stopped a class.
 *
 * The dirt box has to move too: it is carrying the pass of light, and a light
 * sliding across a card that is lifting away from it is two things happening to
 * one card. `--lift-hover` unmultiplied is the exact number items.css arrives
 * at - its `--lift` is divided by `--iz` and then multiplied by it again.
 */
function markClean(card: LiveCard) {
  card.clean = true;
  card.box.classList.add('is-clean');
  wake(card);
  cue('rise', { volume: 0.4 });
  paintCount();
}

function wake(card: LiveCard) {
  const node = document.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(card.item.id)}"]`);
  node?.classList.add('is-woken');
  card.box.classList.add('is-woken');
  later(() => {
    node?.classList.remove('is-woken');
    card.box.classList.remove('is-woken');
  }, WAKE_MS);
}

// ---- the duster ---------------------------------------------------------

/**
 * A sweep across any one of a web's three strands takes the whole web - and
 * with it, all three cards it was holding back. One touch, not three: the
 * triangle is one thing that grew there, and asking for it to be taken down
 * side by side would make the duster a chore rather than the tool that clears.
 *
 * **The duster carries nothing.** It wound the webs onto its head for a while,
 * with a capacity and a shake-out into the bin, and that was one mechanic too
 * many: the glove is the tool you carry things with, and giving the same job to
 * a second tool made the duster a second glove rather than the thing that just
 * clears the strands. A web swept is a web gone.
 */
function sweepWebs(lx: number, ly: number, radius: number): number {
  if (!webs.length) return 0;
  let took = 0;
  for (const w of webs.slice()) {
    if (nearCurve(lx, ly, w) > radius) continue;
    webs.splice(webs.indexOf(w), 1);
    // The strand comes away from the middle out, which is where the duster met
    // it, rather than fading where it hangs.
    const len = w.node.getTotalLength?.() ?? 400;
    w.node.style.strokeDasharray = String(len);
    w.node.animate(
      [{ strokeDashoffset: '0' }, { strokeDashoffset: String(len) }],
      { duration: LEAVE_MS, easing: EASE, fill: 'forwards' },
    );
    later(() => w.node.remove(), LEAVE_MS);
    cue('pick', { volume: 0.32 });
    took++;
    // Any of the three may have been waiting only on this.
    for (const c of cards) if (!c.clean && cardClean(asState(c), webs)) markClean(c);
  }
  return took;
}

/** Distance from a point to the nearest of a web's three strands, by sampling
 *  each. The curves are quadratics and there is a closed form, but twelve
 *  samples across a span nobody can see the ends of at once is cheaper to read
 *  and indistinguishable to use. */
function nearCurve(x: number, y: number, w: LiveWeb): number {
  let best = Infinity;
  for (const g of w.legs) {
    const mx = (g.ax + g.bx) / 2;
    const my = (g.ay + g.by) / 2 + g.sag;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const k = 1 - t;
      const px = k * k * g.ax + 2 * k * t * mx + t * t * g.bx;
      const py = k * k * g.ay + 2 * k * t * my + t * t * g.by;
      best = Math.min(best, Math.hypot(px - x, py - y));
    }
  }
  return best;
}

// ---- the bin ------------------------------------------------------------

/**
 * Whether the bin is on screen at all.
 *
 * Only while the glove is in hand. The jet and the duster put nothing in your
 * hand - the one clears a crust and the other clears a strand - so a bin beside
 * them is a target for a throw that cannot happen, standing there for the whole
 * of the session saying otherwise. It belongs to the glove and it comes out with
 * it. The one place this is decided, called from everywhere that changes what
 * is held or what the bar is showing.
 */
function paintCan() {
  const can = el('clean-can');
  if (!can) return;
  const want = on && !finishing && held === 'glove' && !asking();
  if (can.classList.contains('is-shown') === want) return;
  // Not `hidden`: the bar grows sideways to take it over 200ms and display:none
  // has nothing to animate from. `inert` is what keeps a button at zero width
  // out of the tab order and off the pointer, which `hidden` was doing for free.
  can.classList.toggle('is-shown', want);
  can.toggleAttribute('inert', !want);
  if (!want) can.classList.remove('is-open', 'is-asking', 'is-hit');
}

/**
 * The bin comes and goes with the glove, but never *while* a tool is in the air.
 *
 * It is in the bar's row, so the row changes width when it arrives or leaves -
 * and a flight measures the slot it is aiming at before it sets off. Growing the
 * bin under a tool already travelling lands the tool beside its slot, and puts
 * a half-revealed bin on screen at the one moment somebody is watching that part
 * of the bar. One travel later, everything the flight measured is still there.
 */
function paintCanAfterFlight() {
  later(paintCan, TRAVEL_MS);
}

/** Whether the pointer is at the bin, near enough for it to answer. */
function nearCan(x: number, y: number): boolean {
  const can = el('clean-can');
  if (!can || !can.classList.contains('is-shown')) return false;
  const box = can.getBoundingClientRect();
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy) <= CAN_NEAR;
}

/** The lid eases open while a loaded hand is anywhere near the bin. That is the
 *  whole of the answer to "what do I do with this": no message, no refusal
 *  sound, just the one thing in the bar that can take it, opening. */
function canGlow() {
  const can = el('clean-can');
  if (!can || can.classList.contains('is-asking')) return;
  can.classList.toggle('is-open', carrying() && nearCan(at.x, at.y));
}

/** Said when a full hand tries to put the tool down or swap it. */
function nudgeCan() {
  const can = el('clean-can');
  if (!can) return;
  can.classList.add('is-open', 'is-asking');
  later(() => {
    can.classList.remove('is-asking');
    canGlow();
  }, 1000);
}

/** Empty the glove into the bin, one piece after another. The glove is the only
 *  tool that ever has anything in it - the duster clears a strand outright. */
function emptyHand() {
  const can = el('clean-can');
  if (!can) return;
  if (!carrying()) { nudgeCan(); return; }
  can.classList.add('is-open');
  const box = can.getBoundingClientRect();
  const to = { x: box.left + box.width / 2, y: box.top + box.height * 0.42 };

  const going = carried;
  carried = [];
  paintLoad();
  going.forEach((bit, i) => {
    later(() => {
      tossIn(bit.node, to);
      can.classList.add('is-hit');
      later(() => can.classList.remove('is-hit'), 160);
      // A few percent apart per piece, so five of them are five sounds and not
      // one sound five times.
      cue('pick', { volume: 0.3 - i * 0.02 });
    }, i * 70);
  });

  later(() => {
    can.classList.remove('is-open');
    paintCount();
  }, going.length * 70 + LEAVE_MS);
}

/** One piece on its way into the bin: out of the glove, into a node of its own
 *  in screen coordinates, over an arc with a tumble in it. */
function tossIn(node: SVGGElement, to: { x: number, y: number }) {
  const host = ns('svg');
  host.setAttribute('class', 'clean-fly');
  host.setAttribute('viewBox', '0 0 48 48');
  const seat = ns('g');
  seat.setAttribute('transform', 'translate(24 24) scale(0.62)');
  seat.append(node);
  host.append(seat);
  tossNode(host, to);
}

function tossNode(host: SVGSVGElement, to: { x: number, y: number }) {
  host.style.left = at.x.toFixed(1) + 'px';
  host.style.top = at.y.toFixed(1) + 'px';
  document.body.append(host);
  const dx = to.x - at.x;
  const dy = to.y - at.y;
  host.animate(
    [
      { transform: 'translate(-50%, -50%) rotate(0deg)' },
      {
        transform: `translate(${(dx * 0.5).toFixed(1)}px, ${(dy * 0.5 - 46).toFixed(1)}px)`
          + ' translate(-50%, -50%) rotate(140deg)',
        offset: 0.55,
      },
      {
        transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`
          + ' translate(-50%, -50%) rotate(300deg) scale(0.5)',
        opacity: 0.2,
      },
    ],
    { duration: LEAVE_MS, easing: EASE, fill: 'forwards' },
  );
  later(() => host.remove(), LEAVE_MS);
}

// ---- the clock ----------------------------------------------------------

/**
 * How fast the hand is moving, for the jet to answer to.
 *
 * On the frame clock rather than on pointer events: a browser coalesces a batch
 * of moves and delivers them at one timestamp, so the speed read between two of
 * them is either zero or enormous. One sample a frame, smoothed exponentially
 * over `jetSmoothMs`, is a number that settles when the hand settles.
 *
 * Divided by the zoom, so it is world units a second. A sweep across a card is
 * the same sweep whether the board is at 40% or at 300%, and the jet must not
 * be wide at one and narrow at the other.
 */
function sampleSpeed(dt: number) {
  const dx = at.x - speedFrom.x;
  const dy = at.y - speedFrom.y;
  speedFrom = { x: at.x, y: at.y };
  const raw = dt > 0 ? (Math.hypot(dx, dy) / (vp?.zoom ?? 1)) / (dt / 1000) : 0;
  handSpeed += (raw - handSpeed) * (1 - Math.exp(-dt / TUNING.jetSmoothMs));
}

function tick() {
  if (!on) return;
  raf = requestAnimationFrame(tick);
  const now = performance.now();
  const dt = tickAt ? Math.min(100, now - tickAt) : 16;
  tickAt = now;
  if (pending.length) drainPaint();
  sampleSpeed(dt);

  // **A held tool goes on working when the hand stops.**
  //
  // Everything the tool does used to hang off pointermove, and a pointer that
  // is not moving sends none - so pressing the trigger and holding it on one
  // spot did nothing whatever. No stamp, no sheen, no water: the jet was on and
  // the card was dry. Only the mist gave any sign of it, and only because it
  // comes off this clock rather than off the stroke.
  //
  // One touch a frame, and only when the pointer has not just sent one of its
  // own, so a moving hand is unchanged. It is also the shape the pressure curve
  // already assumed: a still hand is the tightest, hardest the jet gets, which
  // is no use at all if a still hand is not touching anything.
  if (drawing && held && now - appliedAt > FRAME_MS) apply(at.x, at.y, false);

  // The tank drains while the trigger is down and fills the moment it is not,
  // and the mist comes off the nozzle for as long as there is pressure behind
  // it - both of them on this clock and not on the stroke's. See puff().
  if (held === 'washer') {
    tank = tankStep(tank, dt, drawing);
    const power = tankPower(tank);
    if (drawing && power > 0) puff(power, jetShape(handSpeed).radius);
  }
  paintGauge();

  // At most one corner taken per frame. Every card whose node existed when the
  // mode opened was done there; this is for the ones that were culled, and it
  // is a style flush apiece - thirty of them in one frame is the stall the
  // painting is already queued to avoid.
  const square = cards.find(c => !c.rounded);
  if (square) setRadius(square);

  // Read once for the badges: they all counter-scale against the same number,
  // and reading vp.zoom per card is the kind of thing that turns into a layout
  // read later on.
  const zoom = vp?.zoom ?? 1;
  for (const card of cards) {
    // A card that was culled and has come back is wearing a lean it was dealt
    // afresh, so this is re-read rather than remembered. Two inline-style reads
    // per card per frame, which is a string lookup and not a style flush.
    setLean(card);
    drawRuns(card, dt, now);
    if (card.wetAt) {
      // The sheen is decayed a little every frame, so each patch of it fades on
      // its own age.
      //
      // It used to be one opacity on the whole canvas, on a clock that restarted
      // every time the jet touched the card - which meant that while somebody
      // kept washing, nothing faded at all, and every patch cleaned in the last
      // however-long stayed at full brightness. The trail was not two seconds
      // long, it was as long as the stroke.
      const ctx = card.wetCtx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${(1 - Math.exp((-3.9 * dt) / SHEEN_MS)).toFixed(4)})`;
      ctx.fillRect(0, 0, card.wet.width, card.wet.height);
      ctx.restore();
      // The decay is asymptotic, so something has to call it finished and stop
      // paying for the canvas every frame - but it must not *cut*. The whole
      // element fades over the last stretch and the clear below lands on a
      // canvas that is already invisible. It used to clear outright at the two
      // second mark, which took whatever was still there away in one frame:
      // water that dried for two seconds and then disappeared.
      const age = now - card.wetAt;
      const out = Math.min(1, Math.max(0, (SHEEN_MS - age) / SHEEN_OUT_MS));
      card.wet.style.opacity = (out * SHEEN_PEAK).toFixed(3);
      if (age > SHEEN_MS) {
        ctx.clearRect(0, 0, card.wet.width, card.wet.height);
        card.wet.style.opacity = '0';
        card.wetAt = 0;
      }
    }
    paintBadge(card, zoom);
  }
  badgeZoom = zoom;
  drawMist(now);
}

/** The bar beside the washer, every frame. A scale rather than a height, so it
 *  is the compositor's to do and not the layout's - this runs sixty times a
 *  second for as long as the tool is out. */
function paintGauge() {
  if (!tankFill) return;
  tankFill.style.transform = `scaleY(${(held === 'washer' ? tank.level : 1).toFixed(3)})`;
}

// ---- mist and flecks ----------------------------------------------------

function buildMist(): HTMLCanvasElement {
  mist = document.createElement('canvas');
  mist.className = 'clean-mist';
  mistCtx = mist.getContext('2d');
  return mist;
}

/**
 * Halved at Light. `motion` rather than `grain`, which the crust uses: grain is
 * the paper texture's dial and answers "how expensive may a static picture be",
 * where these are moving things and belong to the dial that turns moving things
 * down. The two happen to agree in all three presets and can be overridden
 * apart, which is the case this distinction is for.
 */
const richly = () => quality.motion;

/**
 * The mist, and the one thing about it that is easy to get wrong.
 *
 * It is emitted **per frame, at the nozzle**, and not from apply(). apply() runs
 * once per interpolated step of a stroke - up to forty-eight times for a single
 * pointer event, and again for every coalesced one - so puffing from there laid
 * a few motes at every point the jet had passed through and the mist came out as
 * a solid ribbon down the whole sweep. A jet is at one place at a time. Mist
 * comes off it at a rate in *seconds*, not a rate in pixels.
 *
 * Two a frame living a third of a second is some forty on screen at once, which
 * is the "few dozen particles" this was meant to be - and short enough that a
 * fast sweep leaves a puff behind the nozzle rather than a streak across the
 * board.
 */
const PUFF_MS = 320;

function puff(power: number, spread = 1) {
  const n = richly() ? 2 : 1;
  for (let i = 0; i < n; i++) {
    // Sideways and up out of the impact, not in a full circle: a jet meeting a
    // surface throws its mist back off it.
    const a = rng() * Math.PI * 2;
    const s = (18 + rng() * 34) * (0.5 + power * 0.5) * spread;
    motes.push({
      // The cone is the ring's job, now that there is no ring: a tight jet
      // throws a small hard puff and a sweep throws a wide soft one, which is
      // the only place the pressure curve is visible. `spread` is the same
      // radius multiplier the stamp is using, so the two cannot disagree.
      x: at.x + (rng() - 0.5) * 8 * spread, y: at.y + (rng() - 0.5) * 8 * spread,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 26,
      at: performance.now(), ms: PUFF_MS * (0.7 + rng() * 0.6),
      r: (1.6 + rng() * 2.4) * spread,
      // Water, and water is cold. It came out of the tank and has touched
      // nothing yet - the flecks below are the ones that carry the card's own
      // colour away.
      ...moteInk(...waterInk(), 0.34),
    });
  }
}

/** How often a burst of grime may be thrown off. Flecks are tied to the work
 *  rather than to the clock, and the work is also counted per stroke step - so
 *  this is the same throttle for the same reason. */
const FLECK_MS = 70;

function fleck(x: number, y: number, kind: MessKind, took: number) {
  const now = performance.now();
  if (now - fleckAt < FLECK_MS) return;
  fleckAt = now;
  const n = Math.min(richly() ? 4 : 2, took);
  // A fleck of grime came off *in* the water, so it is mostly the stuff and a
  // little of what carried it: the wash at nearly full dirt, which is where the
  // card's own colour is thrown about by the jet.
  const [fr, fg, fb] = washOf(kind, 0.85);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const s = 50 + rng() * 120;
    motes.push({
      x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
      at: now, ms: 320 + rng() * 240,
      r: 1.1 + rng() * 1.8,
      ...moteInk(fr, fg, fb, 0.8),
    });
  }
}

function drawMist(now: number) {
  if (!mist || !mistCtx || !catcher) return;
  const w = catcher.clientWidth;
  const h = catcher.clientHeight;
  if (!w || !h) return;
  if (mist.width !== w || mist.height !== h) { mist.width = w; mist.height = h; }
  mistCtx.clearRect(0, 0, w, h);
  if (!motes.length) return;
  const box = catcher.getBoundingClientRect();
  const alive: Mote[] = [];
  for (const m of motes) {
    const t = (now - m.at) / m.ms;
    if (t >= 1) continue;
    alive.push(m);
    const age = (now - m.at) / 1000;
    const x = m.x - box.left + m.vx * age;
    const y = m.y - box.top + m.vy * age + 180 * age * age;
    const r = m.r * (1 + t);
    mistCtx.globalAlpha = (1 - t) * 0.9;
    // A soft-edged speck, not a disc. A flat fill has a hard rim at every size,
    // and forty of them over a card read as soap bubbles rather than as spray -
    // the edge is what gives it away, not the diameter.
    const grad = mistCtx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, m.fill);
    grad.addColorStop(0.45, m.fade);
    grad.addColorStop(1, m.gone);
    mistCtx.fillStyle = grad;
    mistCtx.beginPath();
    mistCtx.arc(x, y, r, 0, Math.PI * 2);
    mistCtx.fill();
  }
  mistCtx.globalAlpha = 1;
  motes = alive;
}

// ---- the cursor ---------------------------------------------------------

function moveCursor(x: number, y: number) {
  const dx = x - at.x;
  at = { x, y };
  if (!cursor) return;
  cursor.style.setProperty('--clean-x', x.toFixed(1) + 'px');
  cursor.style.setProperty('--clean-y', y.toFixed(1) + 'px');
  // A few degrees with the hand's sideways speed, settling back. Eased by the
  // stylesheet, so a fast flick reads as weight rather than as a jump.
  tilt = Math.max(-11, Math.min(11, tilt * 0.6 + dx * 0.22));
  const pivot = held ? TIP[held] : { x: 24, y: 24 };
  cursorSpin?.setAttribute('transform', `rotate(${tilt.toFixed(1)} ${pivot.x} ${pivot.y})`);
  // Only while there is something to throw away: the bin's rectangle costs a
  // layout read, and a pointer move is the worst place in the mode to buy one.
  if (carrying()) canGlow();
}

// ---- the bar ------------------------------------------------------------

let bar: HTMLElement | null = null;
/** The count and the ✕, in the opposite corner. Same handler, same data-clean. */
let topBar: HTMLElement | null = null;

function onBarClick(e: MouseEvent) {
  // Element, not HTMLElement: the press usually lands on the <svg> or the
  // <use> inside the button, and those are SVGElements. Narrowing to
  // HTMLElement dropped every click that hit a glyph rather than the padding
  // around it - which, on the widest glyph in the bar, was almost all of them.
  const target = e.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest<HTMLElement>('[data-clean]');
  const what = btn?.dataset.clean;
  if (!what) return;
  if (what === 'close') { askLeave(true); return; }
  if (what === 'stay') { askLeave(false); return; }
  if (what === 'leave') { stopClean(); return; }
  if (what === 'can') { emptyHand(); return; }
  const tool = TOOLS.find(t => t.id === what);
  if (tool) lift(tool.id);
}

function wireBar() {
  bar = el('clean-bar');
  topBar = el('clean-top');
  topBar?.addEventListener('click', onBarClick);
  if (!bar) return;
  bar.addEventListener('click', onBarClick);
  // The tool follows the hand onto the bar, which is the only way to see it
  // over the bin it is being emptied into.
  bar.addEventListener('pointermove', e => { if (on && held) moveCursor(e.clientX, e.clientY); });
}

function showBar(want: boolean) {
  if (topBar) topBar.hidden = !want;
  if (!bar) return;
  bar.hidden = !want;
  askLeave(false);
  el('clean-end')?.toggleAttribute('hidden', true);
  for (const { id } of TOOLS) {
    const slot = slotFor(id);
    if (!slot) continue;
    slot.classList.remove('is-out');
    slot.setAttribute('aria-pressed', 'false');
    // A board whose cards are all spread out has no cobwebs on it, and a tool
    // with nothing to do is worse than an absent one.
    slot.hidden = want && id === 'duster' && !webs.length;
  }
  paintCan();
}

/** The ✕ asks rather than acts: leaving halfway through is a thing to mean. */
function askLeave(want: boolean) {
  el('clean-confirm')?.toggleAttribute('hidden', !want);
  el('clean-tools')?.toggleAttribute('hidden', want);
  paintCan();
}

const asking = () => el('clean-confirm')?.hidden === false;

/**
 * Escape, as one chain rather than one meaning.
 *
 * Holding something → put it down. Holding something with a hand full → the
 * bin says what to do, and nothing else happens. Empty-handed → ask. Asked
 * already → leave. It answers true whenever the mode is up, so canvas/input.ts
 * marks the key as taken either way.
 */
export function cleanEscape(): boolean {
  if (!on) return false;
  if (finishing) { stopClean(); return true; }
  if (held) {
    if (carrying()) nudgeCan();
    else putDown();
    return true;
  }
  if (asking()) { stopClean(); return true; }
  askLeave(true);
  return true;
}

/** Digits pick a tool while the mode is up. Called from canvas/input.ts, which
 *  owns the one keydown listener in the app. */
export function cleanKey(key: string): boolean {
  if (!on) return false;
  const n = Number(key);
  if (!Number.isInteger(n) || n < 1 || n > TOOLS.length) return false;
  lift(TOOLS[n - 1]!.id);
  return true;
}

/** Cards finished out of cards dealt. A card counts when everything on it is
 *  gone - its grime, its debris, and any web still touching it - so the number
 *  is the goal and not the effort. */
function paintCount() {
  const score = tally(cards.map(asState), webs, loose.length, carrying());
  const out = el('clean-count');
  if (out) out.textContent = `${score.clean} of ${score.total}`;
  if (score.done && !finishing) finish();
}

// ---- the ending ---------------------------------------------------------

/**
 * Nothing closes. The line arrives, the light goes across, the music keeps
 * playing, and the board is there to be looked at for as long as anybody wants
 * to look at it - which is the point of having cleaned it. Done and Escape are
 * the way out, and they are the only ones.
 */
function finish() {
  finishing = true;
  endStroke();
  if (held) { flyHome(held); held = null; hideCursor(); }
  cue('done');
  document.documentElement.classList.add('is-clean-done');
  const line = div('clean-line');
  line.textContent = SPOTLESS;
  catcher?.append(line);
  paintCanAfterFlight();
  el('clean-tools')?.toggleAttribute('hidden', true);
  el('clean-confirm')?.toggleAttribute('hidden', true);
  el('clean-end')?.toggleAttribute('hidden', false);
  later(() => cue('sweep', { volume: 0.6 }), 700);
}

// ---- music and media ----------------------------------------------------

function startMusic() {
  music = new Audio(MUSIC);
  music.loop = true;
  music.volume = 0;
  // A missing file is the ordinary case in a fresh clone - the loop is not in
  // the repository. Silence is the right failure, and not a console full of it.
  music.addEventListener('error', () => { music = null; }, { once: true });
  void music.play().then(() => fadeMusic(MUSIC_GAIN)).catch(() => { music = null; });
}

function stopMusic() {
  const going = music;
  music = null;
  if (!going) return;
  const from = going.volume;
  const when = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - when) / FADE_MS);
    going.volume = Math.max(0, from * (1 - t));
    if (t < 1) requestAnimationFrame(step);
    else { going.pause(); going.src = ''; }
  };
  step();
}

function fadeMusic(to: number) {
  const going = music;
  if (!going) return;
  const from = going.volume;
  const when = performance.now();
  const step = () => {
    if (music !== going) return;
    const t = Math.min(1, (performance.now() - when) / FADE_MS);
    going.volume = Math.max(0, Math.min(1, from + (to - from) * t));
    if (t < 1) requestAnimationFrame(step);
  };
  step();
}

/** Everything that was making a noise stops, and starts again on the way out.
 *  It is a spa. */
let paused: HTMLMediaElement[] = [];

function pauseMedia() {
  paused = [...document.querySelectorAll<HTMLMediaElement>('video, audio')]
    .filter(m => !m.paused && m !== music);
  for (const m of paused) m.pause();
}

function resumeMedia() {
  for (const m of paused) void m.play().catch(() => {});
  paused = [];
}
