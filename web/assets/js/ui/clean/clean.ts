// The cleaning simulator: the mode the konami code opens, and seven taps on the
// wordmark. Freezes the cards, lays a dirt layer over them inside #world so pan
// and zoom still work, and puts one of three tools in your hand. Touches no
// board state but one: a finished board is left one card, added on the way out.
// See ./mess.ts for the arithmetic and ./art.ts for the drawing.

import { bus, board, timelinePlaying, addItems } from '../../state.ts';
import type { Item } from '../../board-model.ts';
import type { Viewport } from '../../canvas/viewport.ts';
import { tiltOf, nodeFor, setCleanPlay } from '../../canvas/items.ts';
import { defaultSize } from '../../canvas/renderers.ts';
import { buildSpotlessCard, SPOTLESS_FRAME } from '../../canvas/spotless.ts';
import { captureStills } from '../../canvas/stills.ts';
import { quality } from '../../quality.ts';
import { cue, sustain } from '../../cuelume/engine.ts';
import type { Sustain } from '../../cuelume/engine.ts';
import { el, div } from '../../util.ts';
import {
  TOOLS, TUNING, SUBS, yieldsTo, planBoard, makeField, stamp, fieldClear, wearShare, wearOf,
  cardClean, tally, fullTank, tankStep, tankPower, jetShape, handRoom,
  toolWork, toolWanted, toolShare, webCards, webHolds, peelFor, thumbLayout,
  printTurn, toPrint, fromPrint, robotEats, robotTurn, robotJob, mopPath, MOP_PATTERNS,
  MOP_INSET,
} from './mess.ts';
import type { ToolId, MessKind, Field, Web, Box, Rng, Tank, DebrisPlan, TrackPlan, CardState } from './mess.ts';
import {
  crust, crustMask, crustPainter, eraseAt, wetAt, sheenAt, gleamAt, runAt,
  washOf, waterInk, fleckColour,
  debrisNode, placeBit, sizeBit, peelAt, BIT_UNIT, webPath, webSag, webCore, webNode,
  bootMask, paintBoot, BOOT_GRID,
  spiderNode, threadNode, SPIDER_SIZE, robotNode, ROBOT_SIZE, ROBOT_BOX,
} from './art.ts';
import type { Crust } from './art.ts';
import { playIntro } from './intro.ts';
import type { Intro } from './intro.ts';

/** The spa loop. The file is the maintainer's to supply and is deliberately not
 *  in sw.js's SHELL - precaching a few megabytes of music for the handful of
 *  people who ever find this would be paid for by everybody who does not. The
 *  mode runs silent if it is missing, which is also what a fresh clone gets. */
const MUSIC = 'assets/audio/clean-loop.opus';
const MUSIC_GAIN = 0.55;
const FADE_MS = 1400;

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
  /** Whether its crust is on the canvas yet, and the painter part of the way
   *  through it - see drainPaint(). No tool works a crust that is not there
   *  to see: the paint would land over a grid already half washed. */
  painted: boolean,
  paint: ((until: number) => boolean) | null,
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
  /** How far a stuck piece has peeled, 0 to 1, and where on screen the glove
   *  took hold of it - null while nothing has. Nothing else ever sets either -
   *  see peelStep(). */
  peel: number,
  grab: { x: number, y: number } | null,
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
   *  touches no DOM. Thirty cards times sixty frames is the hot path here.
   *
   *  `badgeZoom` is the zoom this badge's counter-scale was **written at**, and
   *  it is per card rather than one number for the board on purpose - see
   *  paintBadge(). */
  badgeState: BadgeState,
  badgeShare: number,
  badgeZoom: number,
  /** The tool this badge was last painted for, and whether that tool was last
   *  seen with work here - so a check is earned only by watching the work come
   *  off, never by picking up a tool that had nothing to do or was finished
   *  while something else was in hand. */
  badgeTool: ToolId | null,
  badgeOwed: boolean,
  /** Until when the check stays up, 0 once it has had its moment. */
  checkTill: number,
  /** The presentational lean the card is wearing right now, in CSS degrees.
   *  Not item.rot, which is geometry - see leanOf(). */
  lean: number,
  /** Whether the corner has been taken off the live card yet - see setRadius().
   *  A card that was culled when the mode opened has no node to read. */
  rounded: boolean,
  /** Whether the item under the dirt is a GIF, and the live node last written
   *  to - a remount is a fresh node with none of this mode's classes. See
   *  paintHeld(). */
  gifs: boolean,
  heldNode: HTMLElement | null,
  fields: LiveField[],
  debris: LiveBit[],
  /** The card as the counting sees it: its crusts that are not dissolving,
   *  and its debris - the same array as `debris`, never a copy. Kept rather
   *  than built per ask, because the badge asks for every card every frame.
   *  Only dissolve() changes which crusts are in it. */
  state: CardState,
  /** The crust its debris is lying over, and the frame that was worked out
   *  on - see shieldOf(). */
  shield: ((i: number) => boolean) | null,
  shieldAt: number,
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
type LiveWeb = Web & { node: SVGPathElement, shade: SVGPathElement, legs: WebLeg[] };

/**
 * The one spider, and the only thing in the layer that moves on its own.
 *
 * It is not a mess: `tally()` has never heard of it, no tool touches it, and
 * nothing anywhere is waiting for it to be gone. It sits on the biggest web
 * until somebody takes that web away, and then it leaves - which is the whole
 * of it.
 */
type LiveSpider = {
  node: SVGSVGElement,
  /** The web it is sitting on, and which of its strands. Kept by identity, so
   *  sweeping any *other* web leaves it where it is. */
  web: LiveWeb,
  leg: WebLeg,
  /** Where along that strand it is, and where it is heading - 0..1. A scuttle
   *  is nothing but a new `toU`. */
  u: number,
  toU: number,
  phase: 'idle' | 'drop' | 'walk',
  /** Layer coordinates, which for the two moving phases are the truth and for
   *  the idle one are read back off the strand every frame. */
  x: number, y: number,
  /** Where the drop thread is tied, and when the drop began. */
  anchorX: number, anchorY: number,
  dropAt: number,
  thread: HTMLElement | null,
  /** The walk, in layer pixels a second. Set once, when it lets go. */
  vx: number, vy: number,
};

/** Somewhere a robot is going, in layer coordinates, and the thing it is going
 *  for there - a piece, a web, a card or a print. The thing is the claim: no
 *  two robots ever go for the same one. */
type RobotSpot = { x: number, y: number, of: RobotJobOf };
type RobotJobOf = LiveBit | LiveWeb | LiveCard | LiveTrack;

/**
 * The robot vacuum: what typing the code again, with the mode already up,
 * lets loose. No card waits on it, but it can finish the whole board by itself:
 * it picks up every piece, then takes down the webs, then fits a mop and
 * washes - see robotJob() - and `tally()` sees all of it go.
 */
type LiveRobot = {
  /** The box that stays upright and carries the shadow, and the body inside it
   *  that turns - see robotNode(). */
  node: HTMLElement,
  body: SVGSVGElement,
  /** Layer coordinates, and the heading in the layer's y-down frame. */
  x: number, y: number, heading: number,
  /** Coming on from the edge, at work, fitting its mop, or leaving. */
  phase: 'in' | 'work' | 'fit' | 'park',
  /** Radians of a slow on-the-spot turn still to make, while its mop goes on. */
  spin: number,
  /** Where it is going, in layer coordinates, and when it last looked. Null is
   *  nothing to go to, and it wanders. */
  target: RobotSpot | null,
  seekAt: number,
  /** The card it is mopping, the route across it in layer coordinates, and
   *  how far along the route it is. See planMop(). */
  plan: { card: LiveCard, path: RobotSpot[], at: number } | null,
  /** Whether the mop is on, and when fitting it is done. */
  mop: boolean,
  fitTill: number,
  /** No card edge turns it again before this: one bump, one turn. */
  graceTill: number,
  /** The card under its middle, so crossing an edge can be noticed. */
  over: LiveCard | null,
  hum: Sustain | null,
};

/**
 * One boot print on the floor. Owned by no card - it sits in the dirt layer
 * above every card, because whoever walked through did it after everything
 * else was already there, and a print that went under a card would be a print
 * nobody could wash.
 */
type LiveTrack = {
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  field: Field,
  /** World coordinates of the print's centre, and its turn in radians. */
  x: number, y: number, rot: number,
  w: number, h: number,
  fading: boolean,
};

/** One speck of mist or one fleck of grime, on the overlay canvas. Three
 *  colours rather than one because a speck is painted as a gradient: its middle,
 *  its middle at half, and the same hue at zero. Built once at birth - a speck
 *  is drawn every frame it lives and string-building per speck per frame is the
 *  one thing in this file on a hot path. */
type Mote = {
  x: number, y: number, vx: number, vy: number,
  /** How hard it falls, in screen pixels a second squared. Spray and grime are
   *  wet and heavy; dust off a swept web is neither, and rises. */
  sink: number,
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
/** The board as it was dealt, for the "before" half of the ending's polaroid:
 *  where each card was and the colour of what was on it. Taken on the way in,
 *  because by the ending every one of those colours has been washed off. */
let dealt: { box: Box, colour: string }[] = [];
/** The tenant of the biggest web, or null on a board that was dealt none. */
let spider: LiveSpider | null = null;
/** The robot vacuums that are out: one more every time the code is typed. */
let robots: LiveRobot[] = [];
/** Who did the last piece of work: the hand or the robot. Whoever it is when
 *  the board comes clean finished it, and the card says so. */
let lastBy: 'hand' | 'robot' = 'hand';
/** How far the tool is lifted off the board by the hand's speed, 0..1, and the
 *  value last written to the cursor - see paintLift(). */
let raised = 0;
let raisedShown = -1;
/** The trail across the floor. No card owns these, and the board is not done
 *  while any of them is still there. */
let tracks: LiveTrack[] = [];
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
/**
 * The mess is dealt but nothing of it is on screen yet: the black takes 600ms
 * to come up and the board shows through it all the way, so everything waits
 * behind it. Cleared by showMess() the moment the black is solid - after which
 * the crusts paint, settle and drain their cards' colour with five seconds of
 * intro still to run over the top, and the star opens on a board that has been
 * dirty for some time.
 */
let messHidden = false;
/** Which cards the game is playing with, when it is not playing with all of
 *  them - the rest go out of sight, behind the black. Null when every playable
 *  card is in. See showMess(). */
let cull: Set<string> | null = null;
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
/** Whether anything is drawn on the mist canvas - see drawMist(). */
let mistInk = false;
/** Where the glass is on screen, kept by an observer rather than read per
 *  frame: tick() writes styles every frame, and a layout read after them in
 *  drawMist() was a forced layout on every one, even with the hand still. */
let catchBox = { left: 0, top: 0, w: 0, h: 0 };
let catchWatch: ResizeObserver | null = null;
/** The gauge's last written level, so a still tank writes nothing. */
let gaugeShown = -1;
/** Work was done since the count was last painted - see apply(). */
let countOwed = false;
/** The opening (./intro.ts) while it is on screen. It owns the keys it wants
 *  until the star has opened. */
let intro: Intro | null = null;

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
  // Another board under the dirt: every card points at an item that is gone.
  // Leave, and without the card - it was earned on the board that went.
  bus.on('board:load', () => {
    if (!on) return;
    finishing = false;
    stopClean();
  });
  // Nothing lands on the board while it is being cleaned. import/drop.ts
  // listens on the window in the bubble phase; these run in the capture phase
  // ahead of it and stop the event there. The dragover still has to be
  // prevented, or the browser opens a dropped file in the tab.
  const refuse = (e: Event) => {
    if (!on) return;
    e.stopImmediatePropagation();
    if (e.type !== 'dragenter') e.preventDefault();
    if (e instanceof DragEvent && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  for (const type of ['dragenter', 'dragover', 'drop', 'paste']) addEventListener(type, refuse, true);
  // No right-click menu anywhere while it is up - the board's, the bar's or
  // the browser's. The right button puts the tool down on the glass, and a menu
  // over a board somebody is cleaning is chrome this mode took away. Stopped
  // here, ahead of canvas/input.ts's listener on #viewport, which the glass is
  // inside: a preventDefault on the glass alone left that one opening the
  // board's menu.
  addEventListener('contextmenu', e => {
    if (!on) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
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
  // Nothing of it on screen until the black is solid. See showMess().
  messHidden = true;
  layer.classList.add('is-waiting');
  layer.style.zIndex = String(DIRT_Z);
  worldEl.append(layer);

  const plan = planBoard(picked.map(boxOf), rng);
  const byId = new Map(picked.map(i => [i.id, i]));
  // Every corner read before anything is written. Read card by card while the
  // cards were being built, each read came after the last card's writes and
  // paid for a fresh style pass - twenty-five of them in one keypress.
  const corners = new Map<string, string>();
  for (const i of picked) {
    const node = nodeFor(i.id);
    if (node?.isConnected) corners.set(i.id, getComputedStyle(node).borderRadius);
  }
  cards = plan.cards.map(p => buildCard(byId.get(p.id)!, p, corners.get(p.id))).filter(c => c !== null);
  dealt = cards.map(c => ({ box: boxOf(c.item), colour: dealtColour(c) }));
  // After the cards, so the trail lies over them: whoever walked through did it
  // once everything else was already on the board.
  buildTracks(plan.tracks);
  buildWebs(plan.webs, byId);
  buildSpider();
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
  const glass = catcher;
  const measure = () => {
    const box = glass.getBoundingClientRect();
    catchBox = { left: box.left, top: box.top, w: glass.clientWidth, h: glass.clientHeight };
  };
  measure();
  // The glass for its own size, and the page for a move that does not resize
  // it - chrome opening beside the viewport shifts it along.
  catchWatch = new ResizeObserver(measure);
  catchWatch.observe(glass);
  catchWatch.observe(document.documentElement);
  // On the body rather than inside the glass: the glass opens a stacking
  // context at --z-overlay, and a tool carried over the bar has to be drawn on
  // top of the bar - which is a page-level thing two rungs above it.
  cursor = buildCursor();
  document.body.append(cursor);

  // Before paintCount(), which can reach finish() - and finish() ends in
  // stopClean(), which refuses while the mode is not yet officially up.
  on = true;
  document.documentElement.classList.add('is-cleaning');
  // A board bigger than the game: the cards left out go out of sight, and the
  // connection lines with them, since a line to a hidden card points at nothing.
  // Decided here and done behind the black (showMess()) - cards vanishing is the
  // most visible thing the mode does on its way in, and nobody should see it.
  cull = picked.length < playable().length ? new Set(picked.map(i => i.id)) : null;
  pauseMedia();
  paintCount();
  raf = requestAnimationFrame(tick);
  // The board is dealt and waiting under the black. The bar, the music and the
  // arrival wait for the star to open, so they arrive with the board.
  intro = playIntro(() => {
    intro = null;
    showBar(true);
    // The cue before the music, and that order is load-bearing. An <audio>
    // element starting can take the audio focus and leave the AudioContext
    // suspended, so a cue fired in the same turn as `play()` is the one most
    // likely to meet a context the browser has just taken over. wake() no longer
    // pins itself when that happens (see WAKE_MS), but there is no reason to walk
    // into it: the arrival belongs to the star opening, and the loop fades in
    // over more than a second behind it.
    cue('arrive');
    startMusic();
  }, quality.anim, showMess);
  return true;
}

/** Leave. Answers false when it was not up, so Escape can fall through to the
 *  handlers under it - the shape every other temporary state here uses. */
export function stopClean(): boolean {
  if (!on) return false;
  // A finished board leaves with its card, which falls onto the board as the
  // mode goes. First, while everything it is made from is still standing.
  if (finishing) dealCard();
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
  // The other class this mode writes onto a real card: drained and, for a GIF,
  // held still while its card was dirty. Left behind, it is a grey card or an
  // animation that never comes back on a board that has no idea why. See
  // paintHeld().
  for (const gif of document.querySelectorAll('.item.is-clean-held')) gif.classList.remove('is-clean-held');
  // And off the ones culled right now: canvas/items.ts keeps some nodes off the
  // page to mount again later, and a document query cannot see those.
  for (const card of cards) card.heldNode?.classList.remove('is-clean-held');
  layer = null;
  catcher = null;
  cursor = null;
  cursorUse = null;
  cursorSpin = null;
  tankFill = null;
  loadG = null;
  mist = null;
  mistCtx = null;
  mistInk = false;
  catchWatch?.disconnect();
  catchWatch = null;
  catchBox = { left: 0, top: 0, w: 0, h: 0 };
  gaugeShown = -1;
  countOwed = false;
  intro?.stop();
  intro = null;
  cards = [];
  webs = [];
  // Its node and its thread are both inside the layer that has just gone, so
  // this is the reference and nothing else. See the drop, which is the one thing
  // in the mode that outlives the web it started on.
  spider = null;
  // Its node went with the layer; its hum would not have.
  for (const r of robots) r.hum?.stop();
  robots = [];
  lastBy = 'hand';
  raised = 0;
  raisedShown = -1;
  dealt = [];
  tracks = [];
  pending = [];
  messHidden = false;
  cull = null;
  document.documentElement.classList.remove('is-cleaning', 'is-clean-done', 'is-clean-holding', 'is-clean-culled');
  setCleanPlay(null);
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
  const items = playable();
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

const playable = () => board.items.filter(i => i.type !== 'ghost' && i.w > 0 && i.h > 0);

/** The item as the dealer needs it. `type` rides along so a note can be dealt
 *  coffee and a video a film of dust - see GRIME_FOR in mess.ts. */
const boxOf = (i: Item): Box => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, type: i.type });

const ns = <K extends keyof SVGElementTagNameMap>(tag: K) =>
  document.createElementNS('http://www.w3.org/2000/svg', tag);

// ---- building -----------------------------------------------------------

function buildCard(
  item: Item, plan: { fields: MessKind[], debris: DebrisPlan[] }, corner: string | undefined,
): LiveCard | null {
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

  // Folded away until the jet first gets them wet - see unfold().
  const wet = document.createElement('canvas');
  wet.className = 'clean-wet';
  fold(wet);
  const run = document.createElement('canvas');
  run.className = 'clean-run';
  fold(run);
  const ring = buildRing();

  const live: LiveCard = {
    item, box, bits: bitsSvg(),
    wet, wetCtx: wet.getContext('2d')!, wetAt: 0,
    run, runCtx: run.getContext('2d')!, runs: [], runAt: 0, runTill: 0,
    ring, ringFg: ring.querySelector('.ring-fg')!,
    debrisDealt: plan.debris.length, websDealt: 0,
    badgeState: '', badgeShare: -1, badgeZoom: 0,
    badgeTool: null, badgeOwed: false, checkTill: 0,
    lean: 0, rounded: false,
    gifs: false, heldNode: null,
    fields: [], debris: [], state: { id: item.id, fields: [], debris: [] },
    shield: null, shieldAt: -1, clean: false,
  };
  setLean(live);
  setRadius(live, corner);
  for (const kind of plan.fields) live.fields.push(makeLive(kind, item));
  for (const d of plan.debris) {
    const node = debrisNode(d, rng);
    live.bits.append(node);
    sizeOnCard(node, item);
    live.debris.push({
      node, kind: d.kind, x: d.x, y: d.y, size: d.size,
      tough: d.kind === 'gum' ? TUNING.gumTugs : 1, peel: 0, grab: null, host: null,
    });
  }
  live.state = { id: item.id, fields: live.fields.map(f => f.field), debris: live.debris };
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

/** How long a card's check stays up once the tool in hand has finished it. */
const CHECK_MS = 4000;

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
  const live: LiveField = {
    kind, field, crust: c, canvas, ctx, fading: false, painted: !field.total, paint: null,
  };
  // Counted now, painted over the next few frames. The grid is cheap and the
  // noise is not, and doing every card's noise in the keypress that opened the
  // mode is half a second of frozen window. Queued instead, the cards are dirty
  // in the arithmetic immediately and visibly dirty a moment later, which reads
  // as the mess settling onto them.
  if (field.total) pending.push(live);
  return live;
}

/**
 * Milliseconds of crust painting per frame. A whole crust is 13 to 45 ms, and
 * one a frame - which is what this was - stalled every frame of the intro's
 * rolling date, which is moved by script on this same thread. At six a frame
 * twenty-five cards take about two seconds of frames, all of them under the
 * black, which is the point: the mess is dealt, painted and settled while
 * nobody can see it, and the star opens onto a board that is already dirty.
 * With motion off the intro is gone at once and the board is on show, so it may
 * take a little more and be done sooner.
 */
const PAINT_MS = 6;
const PAINT_MS_STILL = 12;

function drainPaint() {
  const until = performance.now() + (quality.anim ? PAINT_MS : PAINT_MS_STILL);
  while (pending.length) {
    const live = pending[0]!;
    if (live.fading) { pending.shift(); continue; }
    live.paint ??= crustPainter(live.ctx, live.crust, live.canvas.width, live.canvas.height, quality.grain);
    if (!live.paint(until)) return;
    pending.shift();
    live.paint = null;
    live.painted = true;
    live.canvas.classList.add('clean-settled');
    if (performance.now() >= until) return;
  }
}

/**
 * The black is solid: let the mess be seen, which is to say let it happen.
 *
 * No fade and nothing gradual - there is a black sheet over it, so the switch
 * costs nothing to hide. What follows it is the two seconds of crust painting
 * and the cards draining their colour, all of it behind the intro.
 */
function showMess() {
  if (!messHidden) return;
  messHidden = false;
  layer?.classList.remove('is-waiting');
  if (cull) {
    setCleanPlay(cull);
    document.documentElement.classList.add('is-clean-culled');
  }
}

/** A card's debris box is 0..100 stretched over the card, so a piece is sized
 *  against the card's real shape or it comes out squashed. See sizeBit(). */
const sizeOnCard = (node: SVGGElement, item: Item) =>
  sizeBit(node, (BIT_UNIT * 100) / item.w, (BIT_UNIT * 100) / item.h);

const texSide = (world: number) =>
  Math.max(TEX_MIN, Math.min(TEX_MAX, Math.round(world)));

/**
 * The sheen and the runoff have a canvas each on every card, and only the card
 * under the jet ever has anything on them. At full size they were a mebibyte
 * apiece whether used or not - fifty of them idle on a board of twenty-five -
 * and every idle sheen still a blended layer. So they sit at no size and out of
 * the page until the jet reaches the card, and go back the same way once they
 * have faded. A canvas resized is a canvas cleared, which is also the clear.
 */
function unfold(canvas: HTMLCanvasElement, item: Item) {
  if (canvas.width) return;
  canvas.width = texSide(item.w);
  canvas.height = texSide(item.h);
  canvas.hidden = false;
}

function fold(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.hidden = true;
}

/** How big a print is drawn, in world units, and the pixels it is painted at.
 *  Small enough that sixteen of them cost about one card's worth of canvas. */
const BOOT_W = 44;
const BOOT_H = 90;
const BOOT_PX = 3;

function buildTracks(plan: readonly TrackPlan[]) {
  if (!layer || !plan.length) return;
  const made: LiveTrack[] = [];
  for (const p of plan) {
    const canvas = document.createElement('canvas');
    canvas.className = 'clean-track';
    canvas.width = BOOT_W * BOOT_PX;
    canvas.height = BOOT_H * BOOT_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    paintBoot(ctx, Math.floor(rng() * 0x7fffffff), canvas.width, canvas.height, quality.grain);
    // Placed by its centre, and the same world-y-is-up flip every other thing
    // in this layer uses. The rotation is the walk's own heading plus a quarter
    // turn, because a print is drawn toe-up and the path runs along x.
    canvas.style.left = (p.x - BOOT_W / 2).toFixed(2) + 'px';
    canvas.style.top = (-p.y - BOOT_H / 2).toFixed(2) + 'px';
    canvas.style.width = BOOT_W + 'px';
    canvas.style.height = BOOT_H + 'px';
    // One angle for the drawing and for toPrint(), which inverts it.
    const deg = (printTurn(p.rot) * 180) / Math.PI;
    canvas.style.transform = `rotate(${deg.toFixed(2)}deg)`;
    layer.append(canvas);
    made.push({
      canvas, ctx,
      field: makeField('track', bootMask(), BOOT_GRID, 1),
      x: p.x, y: p.y, rot: p.rot, w: BOOT_W, h: BOOT_H, fading: false,
    });
  }
  tracks = made;
}

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
    made.push({ ...w, node: webNode(d), shade: webNode(d, true), legs });
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
  // Every shadow before every strand, so no web's shadow falls across another.
  for (const w of made) svg.append(w.shade);
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
  // Reaching for a tool answers "Leave it dirty?" as plainly as the button does.
  if (asking()) askLeave(false);
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
  // The whole page, not just the catcher: the tool follows the pointer over
  // the bars too, and an arrow drawn on top of it there is two pointers.
  document.documentElement.classList.add('is-clean-holding');
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
  document.documentElement.classList.remove('is-clean-holding');
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
  // The load under the glove, not over it: the hand is palm down and closed
  // on it, so only what sticks out past the fist shows.
  cursorSpin.append(loadG, cursorUse);
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
 *  under the fist with small offsets, so edges poke out past it and a full
 *  glove looks full without a number anywhere near it. */
const LOAD_SPOTS = [
  { x: 22, y: 25, r: -8 }, { x: 18, y: 22, r: 14 }, { x: 27, y: 22, r: -20 },
  { x: 21, y: 19, r: 26 }, { x: 25, y: 28, r: -32 },
];

/** The glove open and closed. Whole literals rather than a name built from
 *  parts, so tests/icons.test.js can see both are asked for. */
const GLOVE_OPEN = 'assets/icons.svg#i-clean-glove';
const GLOVE_SHUT = 'assets/icons.svg#i-clean-glove-held';

function paintLoad() {
  if (!loadG) return;
  loadG.replaceChildren();
  if (held !== 'glove') return;
  // The hand closes on what it is holding and opens when it lets go. Same box,
  // same TIP - see i-clean-glove-held in icons.svg.
  cursorUse?.setAttribute('href', carried.length ? GLOVE_SHUT : GLOVE_OPEN);
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
  // Space goes on with the opening, once a press: a held key repeats.
  if (intro) {
    if (down) intro.advance();
    return;
  }
  catcher?.classList.toggle('can-pan', down);
  cursor?.classList.toggle('is-faded', down);
}

/** How far off a piece or a crust the pointer may be and still be on it, in
 *  screen pixels: a finger's slack. */
const GRAB_SLACK = 10;

/** How far from a piece's middle counts as on it, in world pixels at size 1.
 *  A leaf is about ten units of BIT_UNIT long, so this is half of one. */
const PIECE_HIT = 5 * BIT_UNIT;

/**
 * Whether the pointer is *on* something the tool in hand can work - the one
 * question a press asks before it decides between working and moving the
 * board. Deliberately asks about *this* tool: a cobweb's strand is work for
 * the duster and a pan for the washer.
 *
 * **On it, not near it.** This used to be the tool's whole reach, and a card's
 * whole face plus the reach round it for the glove - so between two dirty cards
 * every press was work and the board could not be grabbed at all. Now: the
 * glove on a piece itself, the jet on a crust or a print itself, the duster
 * within its sweep of a strand. Everywhere else a press moves the board. The
 * reach still decides what a stroke takes once it has started.
 */
function underTool(clientX: number, clientY: number): boolean {
  if (!vp || !held) return false;
  const w = vp.toWorld(clientX, clientY);
  const slack = GRAB_SLACK / vp.zoom;
  // The duster keeps its reach: a strand is a hairline, and the gesture is a
  // sweep *across* it, which starts beside it. Webs are few and short, so the
  // board between cards is still free nearly everywhere.
  if (held === 'duster')
    return webs.some(web => nearCurve(w.x, -w.y, web) <= TUNING.reach.duster.radius);
  if (held === 'glove') {
    // A glove with no room left is not over work, it is over somewhere to put
    // what it is holding - which is rule 4 in intent(). Without it a full hand
    // over a pile of leaves is a press that does nothing at all.
    const room = (kind: MessKind) => handRoom(carried.map(c => c.kind), kind);
    const hit = (b: LiveBit) => PIECE_HIT * b.size + slack;
    if (loose.some(b => room(b.kind) && Math.hypot(b.x - w.x, b.y + w.y) <= hit(b))) return true;
    return cards.some(card => {
      const p = toCard(card, w.x, w.y);
      return card.debris.some(b => room(b.kind)
        && Math.hypot((b.x - p.u) * card.item.w, (b.y - p.v) * card.item.h) <= hit(b));
    });
  }
  // The jet: on a print on the bare floor, or on a card with crust left.
  const inside = (u: number, v: number, sw: number, sh: number) =>
    u >= -slack / sw && u <= 1 + slack / sw && v >= -slack / sh && v <= 1 + slack / sh;
  if (tracks.some(t => {
    if (t.fading || !t.field.left) return false;
    const p = toPrint(t, w.x, w.y);
    return inside(p.u, p.v, t.w, t.h);
  })) return true;
  return cards.some(card => {
    if (!card.fields.some(f => !f.fading && f.field.left && yieldsTo(f.kind, 'washer'))) return false;
    const p = toCard(card, w.x, w.y);
    return inside(p.u, p.v, card.item.w, card.item.h);
  });
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
    //
    // Captured first all the same: `pointers` has been counted, and only a
    // captured pointer is sure to bring its pointerup back here. Released over
    // the bar, it never came, and every press after it counted as a second
    // finger.
    node.setPointerCapture(e.pointerId);
    if (e.button === 2) { putDown(); return; }
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
  // No context menu on the glass: see the capture listener in initClean().
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
  // Only a stroke still in a live session: stopClean() comes through here
  // after its timers are gone, and a dissolve is one of those. Not asked which
  // tool is held: a swap or a put-down mid-stroke has already changed `held`
  // by the time it gets here, and only the hand's jet ever leaves a crust
  // waiting, so settling after any stroke settles exactly those.
  if (drawing && on) settleWashed();
  drawing = false;
  panning = false;
  strokeAt = null;
  strokeLeft = 0;
  catcher?.classList.remove('is-panning');
  hiss?.stop();
  hiss = null;
}

/** The let-go of the jet: every crust and print washed past TUNING.clearAt
 *  lets its last specks go now, and not while the jet was still on it -
 *  a patch vanishing under a nozzle still being played over it reads as the
 *  game taking the work out of the hand. Every card, not just the last one
 *  touched, since one stroke can cross several. */
function settleWashed() {
  for (const card of cards)
    for (const f of card.fields)
      if (!f.fading && f.field.total && fieldClear(f.field)) dissolve(card, f);
  for (const t of tracks) if (!t.fading && fieldClear(t.field)) fadeTrack(t);
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

/**
 * A bed of filtered noise per tool, held while the hand is working. One biquad
 * each - that is all `sustain()` offers - so the filter *type* is the whole of
 * the tone, and the choice that matters is how much of the top of the band it
 * lets through.
 *
 * **All three are bandpass or lowpass, and none is a highpass, because a
 * highpass has no top.** The jet was `highpass 2400`, which on white noise is
 * every frequency from 2.4 kHz to the edge of hearing at full strength - two
 * octaves of sibilance, sitting exactly where the ear is most sensitive and
 * least forgiving. It read as a hiss because it *was* one. A bandpass an octave
 * lower is the same jet with the top taken off it: water, not steam.
 *
 * The gains look large against what they replaced and are not. A single biquad
 * keeps only its own bandwidth out of the whole band, so narrowing a filter
 * throws power away faster than it lowers the pitch - see densityOf() in
 * cuelume/recipes.ts, which is the same arithmetic. These numbers hold the
 * three beds at about the loudness the old two were, and the softening is all
 * spectrum rather than level.
 */
const SOUND: Record<ToolId, { filterType: BiquadFilterType, filterFrequency: number, filterQ: number, gain: number }> = {
  // The jet. Its centre is swept by the tank - see apply().
  washer: { filterType: 'bandpass', filterFrequency: 1200, filterQ: 0.5, gain: 0.3 },
  // Bristles over a strand. Air, and nothing above the air.
  duster: { filterType: 'bandpass', filterFrequency: 1900, filterQ: 0.85, gain: 0.08 },
  // Rubber dragging over card stock: low, dry and dull, with no edge on it at
  // all. It is the one bed that is silent when the tool is over nothing - see
  // apply(). A hand in the air makes no sound; a hand on a thing does.
  glove: { filterType: 'lowpass', filterFrequency: 620, filterQ: 0.9, gain: 0.16 },
};

/** What the jet's bandpass is swept between, empty tank to full. The top of it
 *  used to be 3300, which put the jet's centre in the sibilance it has just been
 *  taken out of; a full tank now reads as pressure rather than as hiss. */
const JET_LOW = 560;
const JET_RANGE = 1350;

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
  if (tool === 'glove') worked += scoopLoose(w.x, -w.y, radius);
  if (tool === 'duster') worked += sweepWebs(w.x, -w.y, radius);
  // The trail belongs to no card, so it is washed here rather than inside the
  // per-card loop above - the jet over bare floor is still the jet working.
  if (tool === 'washer') worked += workTracks(w.x, w.y, radius, bite, false);


  // The hiss follows the work, which is what makes a tool on the wrong mess
  // sound like nothing rather than like cleaning. For the washer it follows the
  // tank as well, so an emptying one is heard softening before it is seen.
  if (drawing) {
    if (!hiss) hiss = sustain(SOUND[tool]);
    if (tool === 'washer') {
      hiss.level(power * (worked > 0 ? 1 : 0.12));
      hiss.tone(JET_LOW + power * JET_RANGE);
    } else {
      // The idle twelfth is the duster's alone. A brush moving through air is a
      // thing you hear whether or not it has found a strand - but a glove off
      // its work is a hand in the air, and the scuff is the rubber *on*
      // something. Nothing, for the glove, is the right sound for nothing.
      hiss.level(worked > 0 ? 1 : tool === 'duster' ? 0.12 : 0);
    }
  }
  if (worked) {
    lastBy = 'hand';
    // Counted once a frame, in tick(): a fast stroke is up to MAX_DABS of these
    // in one pointer event, and the count reads every card on the board.
    countOwed = true;
  }
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
function setRadius(card: LiveCard, known?: string) {
  if (card.rounded) return;
  const node = nodeFor(card.item.id);
  if (!node?.isConnected) return;
  card.box.style.borderRadius = known ?? getComputedStyle(node).borderRadius;
  card.rounded = true;
  // The same node, asked the other question once while it is here: whether
  // there is a GIF under this dirt. Both answers cost a walk to the same
  // element, and a card culled when the mode opened is asked when it comes back.
  card.gifs = !!node.querySelector('img[data-gif]');
  // The frame it is showing right now is the picture the card wears until it is
  // clean, so it is taken while the GIF is on screen and decoded.
  if (card.gifs) captureStills(node);
  card.heldNode = node;
  paintHeld(card);
}

/**
 * **A dirty card is held.** Its colour is drained until the last of its mess
 * is gone, so the board's colour comes back card by card and the moment one
 * comes clean is a moment of colour, not only of dirt leaving. clean.css reads
 * the class.
 *
 * **And a dirty GIF holds still.** A card under an inch of mud playing an
 * animation is the one thing on the board that carries on as if nothing had
 * happened to it, and the moment it comes clean and starts moving is worth more
 * than the loop nobody could see anyway. Done with canvas/stills.ts's own
 * machinery rather than a second one: the twin `<img>` beside every GIF is what
 * the zoom rung and the quality dial already swap to, and clean.css asks for it
 * with the same class. A twin whose frame never arrived has no `is-ready` and
 * every one of those rules ignores it, so the worst this can do is leave a GIF
 * playing.
 *
 * Every card, every frame: a map lookup, and a class write only when the node
 * or the answer has changed.
 */
function paintHeld(card: LiveCard) {
  // The colour drains behind the black too: it is a 1.2s transition, and
  // started before the black was solid it is the one part of the mess arriving
  // that would still be moving when the star opened. See showMess().
  if (messHidden) return;
  const node = nodeFor(card.item.id) ?? null;
  if (!node?.isConnected) return;
  if (node !== card.heldNode) {
    // Remounted: a fresh node, with none of this mode's classes, and a fresh
    // GIF twin that has no frame in it yet.
    card.heldNode = node;
    if (card.gifs) captureStills(node);
  }
  if (node.classList.contains('is-clean-held') === card.clean) node.classList.toggle('is-clean-held', !card.clean);
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
  // Once a frame per card, not once a touch: the jet asks up to a hundred and
  // sixty times per pointer event, and the answer is a walk over every cell
  // near every piece. A piece skidded or picked up mid-frame is a frame late
  // leaving the crust under it, which nobody can see.
  if (card.shieldAt === tickAt) return card.shield;
  card.shieldAt = tickAt;
  card.shield = null;
  if (!card.debris.length) return null;
  const g = TUNING.grid;
  const under = new Uint8Array(g * g);
  for (const b of card.debris) {
    const r = SHADE_R * b.size;
    const x0 = Math.max(0, Math.floor((b.x - r) * g));
    const x1 = Math.min(g - 1, Math.ceil((b.x + r) * g));
    const y0 = Math.max(0, Math.floor((b.y - r) * g));
    const y1 = Math.min(g - 1, Math.ceil((b.y + r) * g));
    for (let iy = y0; iy <= y1; iy++)
      for (let ix = x0; ix <= x1; ix++)
        if (Math.hypot(b.x - (ix + 0.5) / g, b.y - (iy + 0.5) / g) <= r) under[iy * g + ix] = 1;
  }
  card.shield = (i: number) => under[i] === 1;
  return card.shield;
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
    // What is lying over the grime: the debris on the card.
    const shield = shieldOf(card);
    // Not a copy: nothing in here takes a crust off the card - see below.
    for (const f of card.fields) {
      // A crust whose grid is all washed is still painted until the let-go
      // dissolves it, so the jet keeps erasing it - see workTracks().
      if (f.fading || !f.field.total || !f.painted) continue;
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
      // No dissolve here: the last specks go when the jet is let go, in
      // settleWashed(), not while it is still being played over them.
    }
    // A piece the jet cannot lift still gets pushed about by it.
    skid(card, u, v, rx, ry);
  }

  if (held === 'glove') {
    for (const bit of card.debris.slice()) {
      if (Math.hypot((bit.x - u) * card.item.w, (bit.y - v) * card.item.h) > TUNING.reach.glove.radius) continue;
      if (!handRoom(carried.map(c => c.kind), bit.kind)) continue;
      // Tape and a sticky note are stuck down, and a press does not lift them:
      // the glove takes hold, and pulling away is what peels them. Where it took
      // hold is all this records; the peel runs in peelStep().
      if (peelFor(bit.kind)) {
        if (!bit.grab) {
          bit.grab = { x: clientX, y: clientY };
          cue('pick', { volume: 0.2 });
        }
        worked++;
        continue;
      }
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

  if (!card.clean && cleanNow(card)) markClean(card);
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

/** The card as it stands, for the badge: how much is left, cell for cell. */
const liveState = (c: LiveCard): CardState => c.state;

/** The card as the counter and the ending see it. A crust counts gone once it
 *  is dissolving, not the moment it passes TUNING.clearAt: the hand's jet
 *  leaves the last specks until it is let go (settleWashed()), and a card
 *  counted clean under a nozzle still washing it would tick the counter - or
 *  end the board - mid-stroke. Anything with specks left and not yet fading
 *  reads as wholly dirty. Never the badge's input: its arc would stand still. */
const asState = (c: LiveCard) => {
  const s = liveState(c);
  // `total`, not `left`: a crust washed to its very last cell mid-stroke is
  // still waiting for the let-go. Dissolving ones are already gone from `s`.
  return { ...s, fields: s.fields.map(f => (f.total ? { ...f, total: 1, left: 1 } : f)) };
};

/** `cardClean(asState(c), webs)` without building the state: every crust not
 *  yet dissolving reads as wholly dirty, so the card is clean only with none
 *  left and no debris or web. For the two callers that ask at every touch of a
 *  tool - the rest ask once, on an event, and read the rule itself. */
const cleanNow = (c: LiveCard) =>
  !c.debris.length && c.state.fields.every(f => !f.total) && !webs.some(w => webHolds(w, c.item.id));

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
  unfold(card.wet, card.item);
  sheenAt(
    card.wetCtx,
    u * card.wet.width, v * card.wet.height,
    rx * card.wet.width, ry * card.wet.height,
  );
  // The opacity is tick()'s to write, once a frame, from this: a sheen just
  // laid is at its peak there, and writing it here as well was a style write
  // at every touch of the jet.
  card.wetAt = performance.now();
}

/** How often the front of the jet may gleam. Not a nicety: this paints onto the
 *  sheen's canvas, which takes two seconds to fade, so it is the one effect here
 *  that *accumulates*. Called from the washer's pass, and a pass is one
 *  interpolated step of a stroke - up to MAX_DABS of them for a single
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
  unfold(card.run, card.item);
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
    fold(card.run);
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
    vx: 0, vy: (DRIP_FALL * zoom) / 0.6, sink: FALL,
    at: performance.now(), ms: 600,
    r: 2.2 * zoom,
    ...moteInk(wr, wg, wb, 0.5),
  });
}

// ---- the badge ----------------------------------------------------------

/**
 * What the tool in hand still owes this card, at its corner.
 *
 * Every card, every frame a tool is held - which is why nothing below touches
 * the DOM unless the answer has actually moved. With no tool in hand there is
 * no question, and the badges are simply not there.
 *
 * **The zoom it skips a write against is the one it last wrote, per card.** It
 * was one number for the whole board, advanced by tick() every frame whether or
 * not any badge had been painted - so while the badges were hidden it went on
 * tracking the live zoom, and putting a tool back in hand found it already
 * equal and skipped the counter-scale. The badges came back wearing the size
 * they had when they were last on screen, and stayed wrong until the next zoom
 * while they were visible. A cache has to hold what was written, not what was
 * current when nothing was.
 */
function paintBadge(card: LiveCard, zoom: number) {
  const want = held
    ? toolWork(liveState(card), webs, held, { debris: card.debrisDealt, webs: card.websDealt })
    : null;
  if (held !== card.badgeTool) {
    card.badgeTool = held;
    card.badgeOwed = false;
  }
  // The bang is up for as long as there is work. The check is not a standing
  // state: it is the moment the work came off, CHECK_MS of it and then gone for
  // good - a board of finished cards all wearing ticks is noise over the one
  // card that still has a bang.
  const now = performance.now();
  if (want && toolWanted(want)) card.badgeOwed = true;
  else if (want && card.badgeOwed) {
    card.badgeOwed = false;
    card.checkTill = now + CHECK_MS;
  }
  const state: BadgeState = !want ? ''
    : toolWanted(want) ? 'want'
    : now < card.checkTill ? 'done' : '';
  // Two decimal places: the arc is 56.55 units round, so anything finer than
  // this is below half a pixel and is a DOM write nobody can see.
  const share = want ? Math.round(toolShare(want) * 100) / 100 : 0;

  if (state !== card.badgeState) {
    card.badgeState = state;
    card.ring.classList.toggle('is-up', state !== '');
    // Going away, the glyph stays drawn and only the badge fades: a tick
    // un-drawing itself on the way out reads as the work being taken back.
    if (state !== '') {
      card.ring.classList.toggle('is-want', state === 'want');
      card.ring.classList.toggle('is-done', state === 'done');
    }
  }
  if (state === '') return;
  if (share !== card.badgeShare) {
    card.badgeShare = share;
    card.ringFg.setAttribute('stroke-dashoffset', (RING_LEN * (1 - share)).toFixed(2));
  }
  if (zoom !== card.badgeZoom) {
    card.badgeZoom = zoom;
    card.ring.style.transform = `scale(${(1 / zoom).toFixed(3)})`;
  }
}

/** Every badge at once: on a tool changing hands, where waiting for the next
 *  frame reads as the bar lagging behind the press. */
function paintBadges() {
  const zoom = vp?.zoom ?? 1;
  for (const card of cards) paintBadge(card, zoom);
}

function dissolve(card: LiveCard, f: LiveField) {
  if (f.fading) return;
  f.fading = true;
  card.state.fields = card.fields.filter(x => !x.fading).map(x => x.field);
  f.canvas.classList.add('clean-gone');
  later(() => {
    f.canvas.remove();
    const idx = card.fields.indexOf(f);
    if (idx >= 0) card.fields.splice(idx, 1);
    if (!card.clean && cardClean(asState(card), webs)) markClean(card);
    paintCount();
  }, LEAVE_MS);
}

// ---- the trail ----------------------------------------------------------

/**
 * The jet over the bare floor. Prints are washed exactly as a card's crust is,
 * and by the same two calls - what differs is only that nobody owns them.
 * `settle` fades a print the moment it counts clear, which is the robot's way;
 * the hand's jet leaves that to the let-go (settleWashed()).
 */
function workTracks(wx: number, wy: number, radius: number, bite: number, settle: boolean): number {
  if (!tracks.length || bite <= 0) return 0;
  let worked = 0;
  for (const t of tracks.slice()) {
    // Not "while it has cells left": a print whose grid is all washed can still
    // have mud painted on it, and since it waits for the let-go to fade, the jet
    // has to go on taking that paint off. Skipping it froze the smear mid-stroke.
    if (t.fading) continue;
    // In the print's own box, from `rot` (mess.ts) rather than the transform
    // read back, which would be a layout flush on every stamp.
    const p = toPrint(t, wx, wy);
    const rx = radius / t.w;
    const ry = radius / t.h;
    if (p.u < -rx || p.u > 1 + rx || p.v < -ry || p.v > 1 + ry) continue;
    // A print is one pass deep, and every pass over it is its last: the
    // crisp erase always.
    const wear = wearOf(t.field, p.u, p.v, rx, ry, bite, SUBS);
    const took = stamp(t.field, p.u, p.v, rx, ry, bite);
    eraseAt(
      t.ctx, p.u * t.canvas.width, p.v * t.canvas.height,
      rx * t.canvas.width, ry * t.canvas.height,
      Math.min(1, wearShare(wear.before, wear.taken)), rng, true,
    );
    if (took) worked++;
    if (settle && fieldClear(t.field)) fadeTrack(t);
  }
  if (worked) countOwed = true;
  return worked;
}

function fadeTrack(t: LiveTrack) {
  if (t.fading) return;
  t.fading = true;
  t.canvas.classList.add('clean-gone');
  later(() => {
    t.canvas.remove();
    const i = tracks.indexOf(t);
    if (i >= 0) tracks.splice(i, 1);
    paintCount();
  }, LEAVE_MS);
}

/** Prints still holding the board back. A fading one is already spoken for. */
const tracksLeft = () => tracks.filter(t => !t.fading).length;

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

/** How far a stuck piece lifts the moment the glove takes hold, before any
 *  pull, and how quickly the peel follows the hand. */
const PEEL_HINT = 0.14;
const PEEL_EASE_MS = 70;

/** How a piece settles back when the hand lets go: the time it takes to lose
 *  about two thirds of whatever peel it had. */
const PEEL_BACK_MS = 130;

/** How far towards the hand the lifted corner leans at a full peel, as a share
 *  of the way from where the piece lies to where the glove is. */
const PEEL_REACH = 0.2;

/**
 * Peel whatever the glove is holding down on, and lay back whatever it has let
 * go of. Once a frame, on the frame's own clock - see workCard().
 *
 * **A swipe.** Once the glove has hold of a piece it keeps it for as long as
 * the button is down, wherever the hand goes, and the peel is how far the hand
 * has got from where it took hold - the furthest yet, so a hand wobbling back
 * does not stick the piece down again. A click or a hold that does not move
 * lifts it by PEEL_HINT and no further. The strip
 * folds back on itself from its free end toward the end it is still stuck by
 * (peelAt() in art.ts) while it leans after the glove, and at the end of the
 * pull it joins the hand like anything else. Letting go early eases it back
 * flat. Nothing is counted and nothing can go wrong.
 */
function peelStep(dt: number) {
  if (!vp) return;
  const hand = vp.toWorld(at.x, at.y);
  const holding = drawing && held === 'glove';
  for (const card of cards) {
    for (const bit of card.debris.slice()) {
      const swipe = peelFor(bit.kind);
      if (!swipe) continue;
      if (!holding) bit.grab = null;
      if (!bit.grab && !bit.peel) continue;
      if (bit.grab) {
        // Taking hold lifts the free end a little on its own - the piece
        // answering the glove, and the hint that it wants pulling. The pull
        // runs on from there.
        const pulled = Math.min(1, Math.hypot(at.x - bit.grab.x, at.y - bit.grab.y) / swipe);
        const want = PEEL_HINT + (1 - PEEL_HINT) * pulled;
        // Eased toward, so the hint lifts rather than snapping up; the last of
        // the pull is exact, or an ease would never quite arrive at 1.
        bit.peel = want >= 1 ? 1 : Math.max(bit.peel, bit.peel + (want - bit.peel) * (1 - Math.exp(-dt / PEEL_EASE_MS)));
      } else {
        // Eased out rather than at a fixed rate: at a fixed rate a click's hint
        // was gone again in a frame or two, which is a flicker and not a lift.
        bit.peel *= Math.exp(-dt / PEEL_BACK_MS);
        if (bit.peel < 0.01) bit.peel = 0;
      }
      // Room was asked when the glove went on the strip, not now - and two strips
      // under one glove finish on the same frame. The one there is no room for
      // stays at the brink, and eases back once the glove stops holding it.
      if (bit.peel >= 1 && !handRoom(carried.map(c => c.kind), bit.kind)) bit.peel = 0.99;
      if (bit.peel >= 1) {
        lastBy = 'hand';
        scoop(card, bit);
        // workCard() asks this after every touch; a peel finishes off the
        // frame clock instead, so it has to ask for itself.
        if (!card.clean && cardClean(asState(card), webs)) markClean(card);
        continue;
      }
      peelAt(bit.node, bit.peel);
      const p = toCard(card, hand.x, hand.y);
      const lean = bit.peel * PEEL_REACH;
      placeBit(bit.node, (bit.x + (p.u - bit.x) * lean) * 100, (bit.y + (p.v - bit.y) * lean) * 100);
    }
  }
}

/** A piece leaves the card and joins the hand. The same node, re-parented -
 *  so what is in the glove is visibly the thing that was on the card. */
function scoop(card: LiveCard, bit: LiveBit) {
  const idx = card.debris.indexOf(bit);
  if (idx >= 0) card.debris.splice(idx, 1);
  takeIntoHand(bit);
}

function scoopLoose(wx: number, wy: number, radius: number): number {
  let took = 0;
  for (const bit of loose.slice()) {
    if (Math.hypot(bit.x - wx, bit.y - wy) > radius) continue;
    if (!handRoom(carried.map(c => c.kind), bit.kind)) continue;
    // No gum tugs here: gum that has been tipped out is off its card and no
    // longer stuck to anything (dropHandful() lays it down with tough = 1).
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
  // Flat and whole again in the hand: the fold was the peel, not the piece.
  if (bit.peel) peelAt(bit.node, 0);
  bit.peel = 0;
  bit.grab = null;
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
      // The badge's denominator: a card dealt none, or fewer than now lie on
      // it, would read a full arc with a bang on it.
      onto.debrisDealt = Math.max(onto.debrisDealt, onto.debris.length);
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
    for (const path of [w.shade, w.node]) {
      path.style.strokeDasharray = String(len);
      path.animate(
        [{ strokeDashoffset: '0' }, { strokeDashoffset: String(len) }],
        { duration: LEAVE_MS, easing: EASE, fill: 'forwards' },
      );
      later(() => path.remove(), LEAVE_MS);
    }
    // Whoever was living in it has to go somewhere. Only its own web: sweeping
    // another one leaves it exactly where it is.
    if (spider?.web === w) dropSpider();
    webMotes(w);
    cue('pick', { volume: 0.32 });
    took++;
    // Any of the three may have been waiting only on this.
    for (const c of cards) if (!c.clean && cardClean(asState(c), webs)) markClean(c);
  }
  return took;
}

/** A point on one strand, in the layer's coordinates. The strand is the same
 *  quadratic art.ts draws - the sag is carried on the leg for exactly this, so
 *  what is hit and what is walked along are the curve that is on screen. */
function curveAt(g: WebLeg, t: number) {
  const mx = (g.ax + g.bx) / 2;
  const my = (g.ay + g.by) / 2 + g.sag;
  const k = 1 - t;
  return {
    x: k * k * g.ax + 2 * k * t * mx + t * t * g.bx,
    y: k * k * g.ay + 2 * k * t * my + t * t * g.by,
  };
}

/** Distance from a point to the nearest of a web's three strands, by sampling
 *  each. The curves are quadratics and there is a closed form, but twelve
 *  samples across a span nobody can see the ends of at once is cheaper to read
 *  and indistinguishable to use. */
function nearCurve(x: number, y: number, w: LiveWeb): number {
  let best = Infinity;
  for (const g of w.legs) {
    for (let i = 0; i <= 12; i++) {
      const p = curveAt(g, i / 12);
      best = Math.min(best, Math.hypot(p.x - x, p.y - y));
    }
  }
  return best;
}

// ---- the spider ---------------------------------------------------------
//
// One, on the biggest web, and nothing in the mode depends on it. It is not in
// `tally()`, it cannot be hit, picked up or washed, and no card is waiting for
// it to go. What it is for is that a web somebody walks up to should turn out to
// have somebody living in it.

/** Where along its strand it idles, and how far one scare moves it. */
const SPIDER_AT = 0.4;
const SPIDER_SCUTTLE = 0.14;

/** How near the hand has to come to be worth moving for, in **world** pixels -
 *  the hand is a thing on the board, and a distance in screen pixels would make
 *  the spider braver at every zoom out. */
const SPIDER_NEAR = 60;

/** The scuttle, in shares of the strand a second, and the walk, in world pixels
 *  a second. A scuttle is quick and short; the walk is a stroll. */
const SPIDER_SLIP = 0.45;
const SPIDER_WALK = 90;

/** How far it comes down its thread when the web goes, and how long that takes. */
const SPIDER_DROP = 90;
const SPIDER_DROP_MS = 600;

/** How far under the strand it hangs, in layer pixels. Sitting *on* the line
 *  reads as a spider stuck to it; a web is walked from below. */
const SPIDER_UNDER = 3;

/** The triangle's own sides, out of the legs a web keeps. buildWebs() pushes
 *  every fourth radius on after them for the hit test, and a spider walking
 *  along a radius would be walking through the middle of the web. */
const sidesOf = (w: LiveWeb) => w.legs.slice(0, WEB_SIDES.length);

function buildSpider() {
  if (!layer || !webs.length) return;
  // The biggest web by its longest side. Not at random: the one web on the board
  // with a tenant should be the one somebody is most likely to walk up to.
  let best = webs[0]!;
  let span = -1;
  for (const w of webs) {
    for (const g of sidesOf(w)) {
      const len = Math.hypot(g.bx - g.ax, g.by - g.ay);
      if (len > span) { span = len; best = w; }
    }
  }
  // The lowest of its three strands, measured at the middle, which is where a
  // sagging strand is lowest. A spider is under the bottom of its web.
  const leg = sidesOf(best).reduce((low, g) => (curveAt(g, 0.5).y > curveAt(low, 0.5).y ? g : low));
  const node = spiderNode(rng);
  node.style.width = SPIDER_SIZE + 'px';
  node.style.height = SPIDER_SIZE + 'px';
  // Still on the low tier, where nothing else in the mode moves either. It does
  // not scuttle and it does not drop - it goes with its web.
  if (!quality.anim) node.classList.add('is-still');
  layer.append(node);
  spider = {
    node, web: best, leg,
    u: SPIDER_AT, toU: SPIDER_AT,
    phase: 'idle',
    x: 0, y: 0,
    anchorX: 0, anchorY: 0, dropAt: 0, thread: null,
    vx: 0, vy: 0,
  };
  stepSpider(0, performance.now());
}

/** Where it is and which way it is facing. The drawing faces `-y`, so a heading
 *  of zero is up the layer and everything else is that turned. */
function placeSpider(s: LiveSpider, dx: number, dy: number) {
  const half = SPIDER_SIZE / 2;
  s.node.style.left = (s.x - half).toFixed(2) + 'px';
  s.node.style.top = (s.y - half).toFixed(2) + 'px';
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  // The group inside and not the svg, so the shadow stays where the light puts
  // it - see spiderNode().
  s.node.firstElementChild?.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
}

function stepSpider(dt: number, now: number) {
  const s = spider;
  if (!s || !vp) return;

  if (s.phase === 'idle') {
    if (quality.anim) {
      const w = vp.toWorld(at.x, at.y);
      const px = w.x;
      const py = -w.y;
      // Only when it has finished the last one: a hand held still over it must
      // not push it along the strand a fraction at a time for ever.
      if (s.u === s.toU && Math.hypot(px - s.x, py - s.y) < SPIDER_NEAR) {
        const ahead = curveAt(s.leg, Math.min(1, s.u + 0.05));
        const back = curveAt(s.leg, Math.max(0, s.u - 0.05));
        const away = Math.hypot(ahead.x - px, ahead.y - py) > Math.hypot(back.x - px, back.y - py) ? 1 : -1;
        // Never onto the last tenth at either end, where the strand disappears
        // into a card and a spider would be standing on the paper.
        s.toU = Math.min(0.9, Math.max(0.1, s.u + away * SPIDER_SCUTTLE));
      }
      const step = (SPIDER_SLIP * dt) / 1000;
      s.u += Math.min(step, Math.max(-step, s.toU - s.u));
      if (Math.abs(s.toU - s.u) < 1e-4) s.u = s.toU;
    }
    const p = curveAt(s.leg, s.u);
    const ahead = curveAt(s.leg, Math.min(1, s.u + 0.02));
    const back = curveAt(s.leg, Math.max(0, s.u - 0.02));
    s.x = p.x;
    s.y = p.y + SPIDER_UNDER;
    s.node.classList.toggle('is-walking', s.u !== s.toU);
    placeSpider(s, ahead.x - back.x, ahead.y - back.y);
    return;
  }

  if (s.phase === 'drop') {
    const t = Math.min(1, (now - s.dropAt) / SPIDER_DROP_MS);
    // Eased out, so it comes to rest on the thread rather than stopping dead.
    const fall = SPIDER_DROP * (1 - (1 - t) * (1 - t));
    s.x = s.anchorX;
    s.y = s.anchorY + fall;
    if (s.thread) s.thread.style.height = fall.toFixed(1) + 'px';
    // Head down, which is the way a spider goes down its own thread: the silk
    // comes off the far end of it.
    placeSpider(s, 0, 1);
    if (t >= 1) letGo(s, vp);
    return;
  }

  s.x += (s.vx * dt) / 1000;
  s.y += (s.vy * dt) / 1000;
  placeSpider(s, s.vx, s.vy);
  // Gone when it has left the screen, whatever the camera has done in the
  // meantime - visibleRect() is arithmetic off pan and zoom and costs no layout.
  const box = vp.visibleRect(SPIDER_SIZE * 2);
  if (s.x < box.x0 || s.x > box.x1 || s.y < -box.y1 || s.y > -box.y0) takeSpider();
}

/** The web it was on has just been swept. */
function dropSpider() {
  const s = spider;
  if (!s || s.phase !== 'idle' || !layer) return;
  // On the low tier it goes with the web instead. The drop and the walk are the
  // one thing in this mode that is not a transition and cannot be turned into
  // one, so the tier that says "nothing moves on its own" gets nothing.
  if (!quality.anim) { takeSpider(true); return; }
  s.phase = 'drop';
  s.anchorX = s.x;
  s.anchorY = s.y;
  s.dropAt = performance.now();
  const thread = threadNode();
  thread.style.left = s.anchorX.toFixed(2) + 'px';
  thread.style.top = s.anchorY.toFixed(2) + 'px';
  thread.style.height = '0px';
  layer.append(thread);
  s.thread = thread;
}

/** The thread is let go of at the bottom of the drop, and the walk begins:
 *  straight out to whichever edge of the screen is nearest. */
function letGo(s: LiveSpider, view: Viewport) {
  s.thread?.remove();
  s.thread = null;
  s.phase = 'walk';
  s.node.classList.add('is-walking');
  const box = view.visibleRect();
  const ways = [
    { dx: -1, dy: 0, d: s.x - box.x0 },
    { dx: 1, dy: 0, d: box.x1 - s.x },
    { dx: 0, dy: -1, d: s.y + box.y1 },
    { dx: 0, dy: 1, d: -box.y0 - s.y },
  ];
  const out = ways.reduce((a, b) => (b.d < a.d ? b : a));
  s.vx = out.dx * SPIDER_WALK;
  s.vy = out.dy * SPIDER_WALK;
}

/** Off the board, either because it walked off it or because the tier it is on
 *  does not let it walk. */
function takeSpider(fade = false) {
  const s = spider;
  if (!s) return;
  spider = null;
  s.thread?.remove();
  if (!fade) { s.node.remove(); return; }
  s.node.classList.add('clean-gone');
  later(() => s.node.remove(), LEAVE_MS);
}

// ---- the robot ----------------------------------------------------------
//
// The second secret inside the first: the code typed again while the mode is up
// lets a robot vacuum loose on the board. It goes after the nearest job it has -
// every piece first, then the webs, then it fits a mop and washes the grime and
// the prints - and a board it finishes gets a card of its own.

/** How long a full on-the-spot turn takes; fitting the mop is half of one. */
const ROBOT_SPIN_MS = 3000;

/** How long after bumping one card edge another cannot turn it. Long enough to
 *  get clear of the corner it met; short enough not to be noticed. */
const ROBOT_GRACE_MS = 600;

/** How far out of the view it has to be before it is gone. */
const ROBOT_GONE = ROBOT_SIZE;

/** The ground it may roam, in layer coordinates: the dealt cards, and a margin
 *  round them. Worked out from `dealt`, which does not change, so there is
 *  nothing to keep up to date. */
function roamBox() {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const { box: b } of dealt) {
    x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2);
    y0 = Math.min(y0, -b.y - b.h / 2); y1 = Math.max(y1, -b.y + b.h / 2);
  }
  const m = TUNING.robot.margin;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

/** The view, in layer coordinates. visibleRect() is world, and y-up. */
function viewBox(view: Viewport, grow = 0) {
  const r = view.visibleRect(grow);
  return { x0: r.x0, x1: r.x1, y0: -r.y1, y1: -r.y0 };
}

/**
 * Where it may roam **right now**: the dealt cards and their margin, cut to the
 * part of them on screen. Asked every frame, so it follows the camera.
 *
 * Not the dealt area alone. That was the first version, and on a board looked
 * at zoomed in - the ordinary case - the middle of the dealt area was off the
 * screen: the robot came in at the edge nearest it, drove straight back out
 * towards it, and was never seen again. A toy nobody can see is not a toy.
 * With the cards off screen altogether, the screen is the ground.
 */
function roamNow(view: Viewport) {
  const area = roamBox();
  const seen = viewBox(view, -ROBOT_SIZE / 2);
  const box = {
    x0: Math.max(area.x0, seen.x0), y0: Math.max(area.y0, seen.y0),
    x1: Math.min(area.x1, seen.x1), y1: Math.min(area.y1, seen.y1),
  };
  return box.x1 - box.x0 >= ROBOT_SIZE * 2 && box.y1 - box.y0 >= ROBOT_SIZE * 2 ? box : seen;
}

/** Past this many a code typed again does nothing: every one of them is a
 *  frame's worth of work and a hum, and a board is only so big. */
const ROBOT_MOST = 12;

/**
 * Let one loose - another one every time the code is typed, up to ROBOT_MOST,
 * and they share the work out (see claimed()). Answers whether the code was
 * taken, so the keys it was typed with do not also do something else.
 */
export function releaseRobot(): boolean {
  if (!on || finishing || !layer || !vp || !dealt.length) return false;
  if (robots.length >= ROBOT_MOST) return true;
  const area = roamNow(vp);
  const cx = (area.x0 + area.x1) / 2;
  const cy = (area.y0 + area.y1) / 2;
  const view = viewBox(vp);
  const r = ROBOT_SIZE / 2;
  const across = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));
  // In from whichever edge of the screen is nearest the ground it will roam,
  // pointing at it. That ground is on screen - see roamNow() - so every edge
  // is a way in and none of them is a way straight back out.
  const ways = [
    { x: view.x0 - r, y: across(view.y0, view.y1, cy), d: cx - view.x0 },
    { x: view.x1 + r, y: across(view.y0, view.y1, cy), d: view.x1 - cx },
    { x: across(view.x0, view.x1, cx), y: view.y0 - r, d: cy - view.y0 },
    { x: across(view.x0, view.x1, cx), y: view.y1 + r, d: view.y1 - cy },
  ];
  // The first comes in at the nearest edge; the rest at any edge, so a second
  // one is not driven straight in on top of the first.
  const from = robots.length ? ways[Math.floor(rng() * ways.length)]! : ways.reduce((a, b) => (b.d < a.d ? b : a));
  const { host, body } = robotNode();
  host.style.width = ROBOT_BOX + 'px';
  host.style.height = ROBOT_BOX + 'px';
  layer.append(host);
  const s: LiveRobot = {
    node: host, body, x: from.x, y: from.y, heading: Math.atan2(cy - from.y, cx - from.x),
    phase: 'in', spin: 0, target: null, seekAt: 0, plan: null, mop: false, fitTill: 0,
    graceTill: 0, over: null,
    // A low rumble rather than a hiss: filtered noise with the top taken off.
    // Quieter after the first, so a dozen of them is a room and not a roar.
    hum: sustain({ filterType: 'lowpass', filterFrequency: 170, filterQ: 0.8, gain: robots.length ? 0.03 : 0.07 }),
  };
  robots.push(s);
  placeRobot(s);
  return true;
}

function placeRobot(s: LiveRobot) {
  const half = ROBOT_BOX / 2;
  s.node.style.left = (s.x - half).toFixed(2) + 'px';
  s.node.style.top = (s.y - half).toFixed(2) + 'px';
  // The body only, drawn front-up like the spider. The box round it stays
  // upright, and so does the shadow on it.
  s.body.style.transform = `rotate(${((s.heading * 180) / Math.PI + 90).toFixed(1)}deg)`;
}

/** Whether a circle of its size at this point is inside the ground it roams. */
const inRoam = (x: number, y: number, box: ReturnType<typeof roamBox>) => {
  const r = ROBOT_SIZE / 2;
  return x - r >= box.x0 && x + r <= box.x1 && y - r >= box.y0 && y + r <= box.y1;
};

function stepRobots(dt: number, now: number) {
  // A copy: one driving off the screen at the ending takes itself out.
  for (const s of robots.slice()) stepRobot(s, dt, now);
}

function stepRobot(s: LiveRobot, dt: number, now: number) {
  if (!vp) return;
  const step = (TUNING.robot.speed * dt) / 1000;

  if (s.phase === 'work' && now - s.seekAt > TUNING.robot.seekMs) {
    s.seekAt = now;
    seekJob(s, now);
  }
  if (s.phase === 'fit' && now >= s.fitTill) s.phase = 'work';

  if (s.spin > 0) {
    // On the spot: a vacuum turning round does not also drive.
    const turn = Math.min(s.spin, ((Math.PI * 2) / ROBOT_SPIN_MS) * dt);
    s.heading += turn;
    s.spin -= turn;
  } else if (s.phase === 'fit') {
    // Nothing: it has stopped to have its mop put on.
  } else if (s.phase === 'in') {
    // Coming on: straight for the middle of the ground on screen, and to work
    // once it is inside it. Turning at the edge only works from inside the edge.
    const box = roamNow(vp);
    s.heading = Math.atan2((box.y0 + box.y1) / 2 - s.y, (box.x0 + box.x1) / 2 - s.x);
    s.x += Math.cos(s.heading) * step;
    s.y += Math.sin(s.heading) * step;
    s.over = cardAt(s.x, -s.y);
    if (inRoam(s.x, s.y, box)) s.phase = 'work';
  } else if (s.phase === 'work' && s.target) {
    // A job: arc round toward it and drive, and stop on it rather than circling
    // it - a mop has to sit on a patch for a moment to take it off.
    // On a mopping route, a waypoint reached is the next one set at once, so
    // it does not stop at every corner of the pattern.
    if (s.plan && s.plan.at < s.plan.path.length && Math.hypot(s.target.x - s.x, s.target.y - s.y) <= Math.max(3, step)) {
      s.plan.at++;
      const next = s.plan.path[s.plan.at];
      if (next) s.target = next;
      else s.plan = null;
    }
    const dx = s.target.x - s.x;
    const dy = s.target.y - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      const want = Math.atan2(dy, dx);
      let off = want - s.heading;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      const most = (TUNING.robot.steer * dt) / 1000;
      s.heading += Math.max(-most, Math.min(most, off));
      // Slower while it is still turning to face it, so it does not orbit a
      // target closer than its own turning circle.
      const go = Math.min(dist, step * Math.max(0.15, Math.cos(off)));
      s.x += Math.cos(s.heading) * go;
      s.y += Math.sin(s.heading) * go;
    }
  } else if (s.phase === 'work') {
    // Nothing to do: wander the ground on screen, bumping off card edges.
    const box = roamNow(vp);
    let nx = s.x + Math.cos(s.heading) * step;
    let ny = s.y + Math.sin(s.heading) * step;
    if (!inRoam(s.x, s.y, box)) {
      // Left outside it by the camera moving: straight back for the middle.
      s.heading = Math.atan2((box.y0 + box.y1) / 2 - s.y, (box.x0 + box.x1) / 2 - s.x);
      s.x += Math.cos(s.heading) * step;
      s.y += Math.sin(s.heading) * step;
      s.over = cardAt(s.x, -s.y);
    } else if (!inRoam(nx, ny, box)) {
      // Off the edge of the ground: turn until the way ahead is back on it.
      // Bounded, so a box somehow smaller than the robot cannot hang the frame.
      for (let i = 0; i < 12 && !inRoam(nx, ny, box); i++) {
        s.heading += robotTurn(rng);
        nx = s.x + Math.cos(s.heading) * step;
        ny = s.y + Math.sin(s.heading) * step;
      }
    } else {
      const under = cardAt(nx, -ny);
      if (under !== s.over && now > s.graceTill && rng() < TUNING.robot.bumpChance) {
        // A card's edge: bump and turn. Not every time - see bumpChance.
        s.heading += robotTurn(rng);
        s.graceTill = now + ROBOT_GRACE_MS;
      } else {
        s.x = nx;
        s.y = ny;
        if (under !== s.over) s.graceTill = now + ROBOT_GRACE_MS;
        s.over = under;
      }
    }
  } else {
    s.x += Math.cos(s.heading) * step;
    s.y += Math.sin(s.heading) * step;
  }
  placeRobot(s);

  // As loud as it is near the middle of the view, and quiet off at the edges.
  const view = viewBox(vp);
  const reach = Math.hypot(view.x1 - view.x0, view.y1 - view.y0) / 2 || 1;
  const off = Math.hypot(s.x - (view.x0 + view.x1) / 2, s.y - (view.y0 + view.y1) / 2);
  s.hum?.level(Math.max(0, 1 - off / reach));

  if (s.phase === 'park') {
    const out = viewBox(vp, ROBOT_GONE);
    if (s.x < out.x0 || s.x > out.x1 || s.y < out.y0 || s.y > out.y1) takeRobot(s);
    return;
  }
  if (s.phase === 'in' || s.phase === 'fit') return;
  // Whatever it is over, it deals with - but only in its order. Pieces are
  // always fair game; the webs wait until the pieces are gone, and the mop
  // only works once it is on.
  let did = robotEat(s);
  const job = jobNow(s);
  if (job === 'sweep' && sweepWebs(s.x, s.y, TUNING.robot.radius)) did = true;
  if (s.mop && job === 'mop' && robotMop(s, dt)) did = true;
  if (!did) return;
  lastBy = 'robot';
  paintCount();
}

/** How much is left of each thing the robot does, and so what it does next. */
function jobNow(s: LiveRobot) {
  let debris = loose.length;
  let grime = tracksLeft();
  for (const card of cards) {
    debris += card.debris.length;
    for (const f of card.fields) if (!f.fading && f.field.left > 0) grime++;
  }
  return robotJob(debris, webs.length, grime, s.mop);
}

/**
 * Look for the nearest job of the kind it is on, and set off for it. On screen
 * first - it is a toy, and one that drove off after a piece at the far end of
 * the board while there was work in front of it would be a toy nobody saw -
 * and anywhere on the board after that, since it can finish the board alone.
 */
function seekJob(s: LiveRobot, now: number) {
  if (!vp) return;
  const job = jobNow(s);
  if (job === 'fit') {
    s.phase = 'fit';
    s.fitTill = now + TUNING.robot.fitMs;
    s.spin = Math.PI;
    s.target = null;
    s.mop = true;
    s.node.classList.add('has-mop');
    cue('rise', { volume: 0.3 });
    return;
  }
  const spots: RobotSpot[] = [];
  // A handful tipped back out takes it off its route; it starts a new one after.
  if (job !== 'mop') s.plan = null;
  if (job === 'pick') {
    for (const bit of loose) spots.push({ x: bit.x, y: bit.y, of: bit });
    for (const card of cards) {
      for (const bit of card.debris) {
        const w = fromCard(card, bit.x, bit.y);
        spots.push({ x: w.x, y: -w.y, of: bit });
      }
    }
  } else if (job === 'sweep') {
    for (const w of webs) {
      for (const g of sidesOf(w)) {
        for (const t of [0.3, 0.5, 0.7]) spots.push({ ...curveAt(g, t), of: w });
      }
    }
  } else if (job === 'mop') {
    if (planMop(s)) return;
    dirtySpots(spots, s);
  }
  // Never what another one is already going for. With nothing left that is
  // not, it has no job and wanders until something comes free.
  const open = spots.filter(p => !claimed(s, p.of));
  if (!open.length) { s.target = null; return; }
  const seen = viewBox(vp);
  const onScreen = open.filter(p => p.x >= seen.x0 && p.x <= seen.x1 && p.y >= seen.y0 && p.y <= seen.y1);
  const pool = onScreen.length ? onScreen : open;
  let best = pool[0]!;
  let near = Infinity;
  for (const p of pool) {
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < near) { near = d; best = p; }
  }
  s.target = best;
}

/** Whether another robot is going for this piece, web, card or print, or is
 *  mopping this card. Two of them after one thing is one of them wasted. */
const claimed = (s: LiveRobot, of: RobotJobOf) =>
  robots.some(o => o !== s && (o.target?.of === of || o.plan?.card === of));

/** Whether a card still has grime on it for the mop. */
const grimy = (card: LiveCard) => card.fields.some(f => !f.fading && f.field.left > 0);

/**
 * Mop card by card, each along a pattern picked at random for it - a spiral in
 * from the edge, or back and forth in rows, or in columns - rather than cell by
 * cell, which had it creeping from one speck to the next. Keeps the route it
 * is on; when that runs out on a card that is still dirty, it picks again.
 * Answers false when no card needs it, which leaves the prints.
 */
function planMop(s: LiveRobot): boolean {
  if (s.plan && grimy(s.plan.card) && s.plan.at < s.plan.path.length) {
    s.target = s.plan.path[s.plan.at]!;
    return true;
  }
  s.plan = null;
  const grimed = cards.filter(grimy);
  if (!grimed.length || !vp) return false;
  // A card another one is mopping, or going for, is left to it.
  const dirty = grimed.filter(c => !claimed(s, c));
  if (!dirty.length) return false;
  const seen = viewBox(vp);
  const centre = (c: LiveCard) => ({ x: c.item.x, y: -c.item.y });
  const shown = dirty.filter(c => {
    const p = centre(c);
    return p.x >= seen.x0 && p.x <= seen.x1 && p.y >= seen.y0 && p.y <= seen.y1;
  });
  const pool = shown.length ? shown : dirty;
  let card = pool[0]!;
  let near = Infinity;
  for (const c of pool) {
    const p = centre(c);
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < near) { near = d; card = c; }
  }
  const { w, h } = card.item;
  const pattern = MOP_PATTERNS[Math.floor(rng() * MOP_PATTERNS.length)]!;
  const path = mopPath(pattern, w, h, TUNING.robot.mopLane, TUNING.robot.radius * MOP_INSET).map(p => {
    const at = fromCard(card, p.x / w, p.y / h);
    return { x: at.x, y: -at.y, of: card };
  });
  s.plan = { card, path, at: 0 };
  s.target = path[0]!;
  return true;
}

/** Every cell the mop could work on right now, in layer coordinates: grime
 *  with nothing lying over it, and the prints on the floor. Not on anything
 *  another robot has claimed - the caller would only throw those away, and
 *  late in a busy board that was thirty cards of cells per robot per seek. */
function dirtySpots(out: RobotSpot[], s: LiveRobot) {
  for (const card of cards) {
    if (claimed(s, card)) continue;
    const shield = shieldOf(card);
    for (const f of card.fields) {
      if (f.fading || !f.field.left) continue;
      const cells = f.field.cells;
      const g = Math.round(Math.sqrt(cells.length));
      for (let i = 0; i < cells.length; i++) {
        if (!cells[i] || shield?.(i)) continue;
        const w = fromCard(card, ((i % g) + 0.5) / g, (Math.floor(i / g) + 0.5) / g);
        out.push({ x: w.x, y: -w.y, of: card });
      }
    }
  }
  for (const t of tracks) {
    if (t.fading || !t.field.left || claimed(s, t)) continue;
    const cells = t.field.cells;
    const g = Math.round(Math.sqrt(cells.length));
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      const w = fromPrint(t, ((i % g) + 0.5) / g, (Math.floor(i / g) + 0.5) / g);
      out.push({ x: w.x, y: -w.y, of: t });
    }
  }
}

/**
 * Wash what is under it: the jet's own work on every card it is over and on the
 * prints, at the mop's slow bite. No flecks and no rivulets - it is a mop, and
 * what it takes up it keeps - but the card is wet behind it all the same.
 */
function robotMop(s: LiveRobot, dt: number): boolean {
  const radius = TUNING.robot.radius;
  const bite = (TUNING.robot.mopBite * dt) / 16.7;
  let worked = 0;
  for (const card of cards) {
    const p = toCard(card, s.x, -s.y);
    const rx = radius / card.item.w;
    const ry = radius / card.item.h;
    if (p.u < -rx || p.u > 1 + rx || p.v < -ry || p.v > 1 + ry) continue;
    sheen(card, p.u, p.v, rx, ry);
    const shield = shieldOf(card);
    for (const f of card.fields.slice()) {
      if (f.fading || !f.field.total || !f.field.left || !f.painted) continue;
      const span = Math.max(1, TUNING.depth[f.kind] ?? 1) * SUBS;
      const lastPass = cellUnder(f.field, p.u, p.v) <= bite * SUBS;
      const wear = wearOf(f.field, p.u, p.v, rx, ry, bite, span, shield);
      const took = stamp(f.field, p.u, p.v, rx, ry, bite, shield);
      eraseAlpha(f, p.u, p.v, rx, ry, wearShare(wear.before, wear.taken), lastPass);
      if (took) {
        wetAlpha(f, p.u, p.v, rx, ry);
        worked++;
      }
      if (fieldClear(f.field)) dissolve(card, f);
    }
    if (!card.clean && cleanNow(card)) markClean(card);
  }
  worked += workTracks(s.x, -s.y, radius, bite, true);
  return worked > 0;
}

/** Eat what is under it. Loose pieces on the bare board, and pieces on any card
 *  it is driving across - never what is in the glove, which robotEats() says. */
function robotEat(s: LiveRobot): boolean {
  const reach = TUNING.robot.radius;
  let ate = 0;
  for (const bit of loose.slice()) {
    if (!robotEats(bit.kind, 'loose') || Math.hypot(bit.x - s.x, bit.y - s.y) > reach) continue;
    loose.splice(loose.indexOf(bit), 1);
    const host = bit.host;
    bit.host = null;
    if (host) swallow(host, `translate(${(s.x - bit.x).toFixed(1)}px, ${(s.y - bit.y).toFixed(1)}px) scale(0.2)`);
    ate++;
  }
  for (const card of cards) {
    let took = false;
    for (const bit of card.debris.slice()) {
      if (!robotEats(bit.kind, 'card')) continue;
      const w = fromCard(card, bit.x, bit.y);
      if (Math.hypot(w.x - s.x, -w.y - s.y) > reach) continue;
      card.debris.splice(card.debris.indexOf(bit), 1);
      const p = toCard(card, s.x, -s.y);
      swallow(bit.node, `translate(${(p.u * 100).toFixed(2)}px, ${(p.v * 100).toFixed(2)}px) scale(0.2)`);
      took = true;
      ate++;
    }
    if (took && !card.clean && cardClean(asState(card), webs)) markClean(card);
  }
  if (!ate) return false;
  cue('pick', { volume: 0.22 });
  return true;
}

/** Into the robot and gone, over 200ms. Taken out of the counting at once -
 *  this is only the picture catching up. */
function swallow(node: Element, to: string) {
  node.animate([{ opacity: 1 }, { transform: to, opacity: 0 }], { duration: 200, easing: EASE, fill: 'forwards' });
  later(() => node.remove(), 200);
}

/** Off to the nearest edge of the screen and away, at the ending. */
function parkRobots() {
  if (!vp) return;
  const view = viewBox(vp);
  for (const s of robots) {
    if (s.phase === 'park') continue;
    s.phase = 'park';
    s.spin = 0;
    const ways = [
      { a: Math.PI, d: s.x - view.x0 },
      { a: 0, d: view.x1 - s.x },
      { a: -Math.PI / 2, d: s.y - view.y0 },
      { a: Math.PI / 2, d: view.y1 - s.y },
    ];
    s.heading = ways.reduce((a, b) => (b.d < a.d ? b : a)).a;
  }
}

function takeRobot(s: LiveRobot) {
  const i = robots.indexOf(s);
  if (i >= 0) robots.splice(i, 1);
  s.hum?.stop();
  s.node.remove();
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
  const want = on && !finishing && held === 'glove';
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
  // Binning the last handful is finishing the board, and it is the hand's.
  lastBy = 'hand';
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

/** Screen speed at which the tool is lifted all the way, and how long it takes
 *  to follow the hand up or settle back. */
const LIFT_FULL = 900;
const LIFT_MS = 200;

/**
 * **Height from speed.** A tool swept fast is lifted off the board, and a
 * lifted thing throws its shadow further and softer: the cursor's far shadow
 * goes from 8px to 16px as the hand goes from still to 900 screen pixels a
 * second. One custom property, which clean.css turns into both numbers.
 *
 * Screen speed and not world speed, unlike the jet: this is about the tool
 * under the hand on the glass, and at any zoom a fast hand is a fast hand.
 * Eased every frame, written only when the hundredths change, so a still hand
 * writes nothing.
 */
function paintLift(dt: number) {
  if (!cursor) return;
  const want = Math.min(1, (handSpeed * (vp?.zoom ?? 1)) / LIFT_FULL);
  raised += (want - raised) * (1 - Math.exp(-dt / LIFT_MS));
  const shown = Math.round(raised * 100) / 100;
  if (shown === raisedShown) return;
  raisedShown = shown;
  cursor.style.setProperty('--clean-lift', shown.toFixed(2));
}

function tick() {
  if (!on) return;
  raf = requestAnimationFrame(tick);
  const now = performance.now();
  const dt = tickAt ? Math.min(100, now - tickAt) : 16;
  tickAt = now;
  // Not while the board is still showing through the black: a crust that lands
  // there is one somebody watched land. The wait is 600ms of an intro that runs
  // for six seconds, so the queue still empties long before the star.
  if (!messHidden && pending.length) drainPaint();
  sampleSpeed(dt);
  paintLift(dt);

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
  // After that touch, so a hand held still on a strip of tape has put the glove
  // on it this frame before the peel asks whether it is there.
  peelStep(dt);

  // The tank drains while the trigger is down and fills the moment it is not,
  // and the mist comes off the nozzle for as long as there is pressure behind
  // it - both of them on this clock and not on the stroke's. See puff().
  if (held === 'washer') {
    tank = tankStep(tank, dt, drawing);
    const power = tankPower(tank);
    if (drawing && power > 0) puff(power, jetShape(handSpeed).radius);
  }
  paintGauge();
  if (countOwed) {
    countOwed = false;
    paintCount();
  }

  // At most one corner taken per frame. Every card whose node existed when the
  // mode opened was done there; this is for the ones that were culled, and it
  // is a style flush apiece - thirty of them in one frame is the stall the
  // painting is already queued to avoid.
  // Only among the ones mounted now: the first unrounded card may never come on
  // screen, and asking it again every frame starved every card behind it.
  const square = cards.find(c => !c.rounded && nodeFor(c.item.id)?.isConnected);
  if (square) setRadius(square);

  // Read once for the badges: they all counter-scale against the same number,
  // and reading vp.zoom per card is the kind of thing that turns into a layout
  // read later on.
  const zoom = vp?.zoom ?? 1;
  for (const card of cards) {
    // A card that was culled and has come back is wearing a lean it was dealt
    // afresh, so this is re-read rather than remembered. leanOf() reads the
    // item and the root's data- flags, which is attribute lookups and not a
    // style flush.
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
        fold(card.wet);
        card.wet.style.opacity = '0';
        card.wetAt = 0;
      }
    }
    paintBadge(card, zoom);
    // Every card: drained until clean, and a GIF held still - see paintHeld().
    paintHeld(card);
  }
  stepSpider(dt, now);
  stepRobots(dt, now);
  drawMist(now);
}

/** The bar beside the washer, every frame. A scale rather than a height, so it
 *  is the compositor's to do and not the layout's - this runs sixty times a
 *  second for as long as the tool is out. */
function paintGauge() {
  if (!tankFill) return;
  const level = Math.round((held === 'washer' ? tank.level : 1) * 1000) / 1000;
  if (level === gaugeShown) return;
  gaugeShown = level;
  tankFill.style.transform = `scaleY(${level.toFixed(3)})`;
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
 * once per interpolated step of a stroke - up to MAX_DABS times for a single
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

/** What spray and grime fall at, in screen pixels a second squared. */
const FALL = 180;

/**
 * Dust shaken out of a strand as the duster takes it: a few pale specks that
 * rise off the web and drift, on the same canvas as the spray.
 *
 * Six to ten, halved on the low tier like everything else on this canvas. Each
 * rises from a point *on* one of the triangle's strands, not from the duster -
 * it is the web the dust was in, and the web is the thing that has just gone.
 */
function webMotes(w: LiveWeb) {
  if (!vp) return;
  const now = performance.now();
  const n = Math.round((6 + rng() * 4) * (richly() ? 1 : 0.5));
  const sides = sidesOf(w);
  for (let i = 0; i < n; i++) {
    const p = curveAt(sides[Math.floor(rng() * sides.length)]!, rng());
    // Layer to world is a flip of y; world to client is the camera, plus where
    // the viewport sits on the page, which is what drawMist() takes back off.
    const s = vp.toScreen(p.x, -p.y);
    motes.push({
      x: s.x + vp.left, y: s.y + vp.top,
      vx: (rng() - 0.5) * 36, vy: -10 - rng() * 22, sink: -4,
      at: now, ms: 1400 * (0.8 + rng() * 0.4),
      r: 1 + rng() * 0.5,
      ...moteInk(250, 246, 235, 0.6),
    });
  }
}

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
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 26, sink: FALL,
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
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, sink: FALL,
      at: now, ms: 320 + rng() * 240,
      r: 1.1 + rng() * 1.8,
      ...moteInk(fr, fg, fb, 0.8),
    });
  }
}

function drawMist(now: number) {
  if (!mist || !mistCtx || !catcher) return;
  // The observed box, never a layout read - see catchBox.
  const { w, h } = catchBox;
  const box = catchBox;
  if (!w || !h) return;
  // Resizing clears it.
  if (mist.width !== w || mist.height !== h) { mist.width = w; mist.height = h; mistInk = false; }
  // Cleared only when there is something on it. A cleared canvas is a changed
  // canvas, and clearing an empty one every frame had the compositor upload a
  // whole viewport of nothing sixty times a second while the hand was still.
  if (mistInk) mistCtx.clearRect(0, 0, w, h);
  mistInk = motes.length > 0;
  if (!motes.length) return;
  const alive: Mote[] = [];
  for (const m of motes) {
    const t = (now - m.at) / m.ms;
    if (t >= 1) continue;
    alive.push(m);
    const age = (now - m.at) / 1000;
    const x = m.x - box.left + m.vx * age;
    const y = m.y - box.top + m.vy * age + m.sink * age * age;
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
  // At the ending there is nothing left to leave dirty: the ✕ is Done, as
  // Escape is. Asking there offered a "Keep cleaning" onto a bar whose tools
  // refuse to lift once the board is finishing.
  if (what === 'close') { if (finishing) stopClean(); else askLeave(true); return; }
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
  // And the row of tools back on. finish() hides it to put Done in its place,
  // and nothing else ever unhid it - so a second run of the mode, after any
  // board had been finished, opened an empty tray: the bar there, the three
  // tools gone, and no way to clean anything. The pair of lines belongs
  // together, which is why it is here rather than in startClean().
  el('clean-tools')?.toggleAttribute('hidden', false);
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

/** The ✕ asks rather than acts: leaving halfway through is a thing to mean.
 *  The question takes the ✕'s own place in the corner, and the tray is left
 *  alone - picking a tool up is an answer too (see lift()). */
function askLeave(want: boolean) {
  const x = topBar?.querySelector<HTMLElement>('.clean-x');
  const ask = el('clean-confirm');
  // Focus follows the swap, but only focus that was already there: a button
  // that has just been hidden drops it on the body. Never taken from the board
  // otherwise - Space is the pan key here, and a focused button eats it.
  const focused = document.activeElement;
  const fromX = !!x && focused === x;
  const fromAsk = !!ask && !!focused && ask.contains(focused);
  ask?.toggleAttribute('hidden', !want);
  x?.toggleAttribute('hidden', want);
  if (want && fromX) ask?.querySelector<HTMLElement>('[data-clean="stay"]')?.focus();
  if (!want && fromAsk) x?.focus();
}

const asking = () => el('clean-confirm')?.hidden === false;

/**
 * Escape, as one chain rather than one meaning.
 *
 * Asked already → leave, whatever is in the hand: the question is on screen
 * and Escape is its second press, as it would be with nothing held. Holding
 * something → put it down. Holding something with a hand full → the bin says
 * what to do, and nothing else happens. Empty-handed → ask. It answers true
 * whenever the mode is up, so canvas/input.ts marks the key as taken either way.
 */
export function cleanEscape(): boolean {
  if (!on) return false;
  // Past the opening, not out of the mode: a second Escape asks to leave.
  if (intro) { intro.skip(); return true; }
  if (finishing) { stopClean(); return true; }
  if (asking()) { stopClean(); return true; }
  if (held) {
    if (carrying()) nudgeCan();
    else putDown();
    return true;
  }
  askLeave(true);
  return true;
}

/** Digits pick a tool while the mode is up. Called from canvas/input.ts, which
 *  owns the one keydown listener in the app. */
export function cleanKey(key: string): boolean {
  if (!on) return false;
  // Enter goes on with the opening; nothing else reaches a board still dark.
  if (intro) {
    if (key === 'Enter') intro.advance();
    return true;
  }
  const n = Number(key);
  if (!Number.isInteger(n) || n < 1 || n > TOOLS.length) return false;
  lift(TOOLS[n - 1]!.id);
  return true;
}

/** Cards finished out of cards dealt. A card counts when everything on it is
 *  gone - its grime, its debris, and any web still touching it - so the number
 *  is the goal and not the effort. */
function paintCount() {
  const score = tally(cards.map(asState), webs, loose.length, carrying(), tracksLeft());
  const out = el('clean-count');
  // Three spans so the numbers and the word can be set apart (clean.css), and
  // only when the reading changes: the node is aria-live, and rebuilding it
  // with the same words would have them read out again for nothing.
  const said = `${score.clean} of ${score.total}`;
  if (out && out.textContent !== said) {
    const part = (cls: string, text: string) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    out.replaceChildren(part('count-n', String(score.clean)), ' ', part('count-of', 'of'), ' ', part('count-n', String(score.total)));
  }
  if (score.done && !finishing) finish();
}

// ---- the ending ---------------------------------------------------------

/**
 * Nothing closes. The light goes across, a polaroid is dealt onto the board, the
 * music keeps playing, and the board is there to be looked at for as long as
 * anybody wants to look at it - which is the point of having cleaned it. Done
 * and Escape are the way out, and they are the only ones.
 */
function finish() {
  finishing = true;
  endStroke();
  if (held) { flyHome(held); held = null; hideCursor(); }
  // Its work is done too.
  parkRobots();
  cue('done');
  document.documentElement.classList.add('is-clean-done');
  // No card yet: it is dealt onto the board on the way out, by Done - see the
  // top of the teardown, and dealCard().
  paintCanAfterFlight();
  el('clean-tools')?.toggleAttribute('hidden', true);
  // Through askLeave(), which puts the ✕ back: a board finished while the
  // question was up - the robot can do that - would otherwise end with no way
  // out in the corner.
  askLeave(false);
  el('clean-end')?.toggleAttribute('hidden', false);
  later(() => cue('sweep', { volume: 0.6 }), 700);
}

/**
 * The colour a card was when it was dealt: its top grime's, since that is the
 * one anybody saw. A card dealt only debris gets the dust film's warm grey
 * instead of its pieces' - there is no one colour for a scatter of leaves and a
 * bottle cap, and "dirty, but not caked" is what that card looked like from the
 * size of a thumbnail.
 */
function dealtColour(card: LiveCard): string {
  const top = card.fields[card.fields.length - 1];
  return fleckColour(top ? top.kind : 'film');
}

/** How long the card takes to appear over the board, and then to fall onto
 *  it. Short: this is what happens after somebody pressed Done, and they are
 *  waiting on nothing but it. */
const CARD_IN_MS = 220;
const CARD_FALL_MS = 420;

/**
 * **The card is kept.** On the way out - Done, or Escape at the ending - it
 * appears over the middle of the screen, held a little above the board, and
 * falls onto it, where it is an ordinary card named Spotless (type `card`,
 * canvas/spotless.ts): saved with the board, undoable like any addition, in the
 * board's palette, and there after the mode has gone. A before-and-after of a
 * board somebody has just cleaned is a thing worth keeping on it.
 *
 * What it is made from is written into it now - where each card sat and the
 * colour of what was on it, and who finished the job - because by the time it
 * is drawn again the mode and every colour it dealt are gone.
 *
 * The fall is a copy of the card on the body, built by the card's own
 * renderer, landing at exactly the size the real one has at this zoom; the
 * real one is hidden under it until then, so the swap is one card for the same
 * card.
 *
 * Called at the top of the teardown, while everything it is made from is still
 * standing. Only Done and Escape get there, so it is always the board the cards
 * were cleaned on.
 */
function dealCard() {
  if (!vp || !dealt.length) return;
  const f = SPOTLESS_FRAME;
  const two = (n: number) => Math.round(n * 100) / 100;
  const before = thumbLayout(dealt.map(d => d.box), f.w, f.h, f.pad)
    .map((t, i) => [two(t.x), two(t.y), two(t.w), two(t.h), dealt[i]!.colour]);
  const size = defaultSize('card');
  const meta: Record<string, unknown> = { before, cards: dealt.length };
  // Written only when it was the robot: absent is the ordinary card.
  if (lastBy === 'robot') meta.by = 'robot';
  const [item] = addItems([{
    type: 'card',
    name: 'Spotless',
    x: vp.pan.x, y: vp.pan.y, w: size.w, h: size.h,
    meta,
  }], 'Add spotless card');
  if (!item) return;

  const real = document.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(item.id)}"]`);
  const copy = div('clean-drop');
  copy.append(buildSpotlessCard(item));
  copy.style.left = (vp.left + vp.cx).toFixed(1) + 'px';
  copy.style.top = (vp.top + vp.cy).toFixed(1) + 'px';
  copy.style.width = size.w + 'px';
  copy.style.height = size.h + 'px';
  document.body.append(copy);
  real?.classList.add('is-clean-arriving');
  // Held above the board: bigger than it will be, never smaller than itself,
  // and with a long soft shadow; then down, the shadow drawing in under it.
  const land = vp.zoom;
  const aloft = Math.max(1.1, land * 1.3);
  const place = (s: number, lift: number) =>
    `translate(-50%, -50%) translateY(${(-lift).toFixed(1)}px) scale(${s.toFixed(3)})`;
  const high = 'drop-shadow(0 22px 26px rgb(30 26 20 / 0.34))';
  const low = 'drop-shadow(0 1px 2px rgb(30 26 20 / 0.3))';
  const fall = copy.animate([
    { transform: place(aloft, 26), opacity: 0, filter: high, easing: EASE },
    { transform: place(aloft, 26), opacity: 1, filter: high, easing: 'cubic-bezier(0.5, 0, 0.75, 0)',
      offset: CARD_IN_MS / (CARD_IN_MS + CARD_FALL_MS) },
    { transform: place(land, 0), opacity: 1, filter: low },
  ], { duration: CARD_IN_MS + CARD_FALL_MS, fill: 'forwards' });
  // A promise rather than a timer: the session's timers were cleared the moment
  // the mode closed, and this outlives it by design.
  void fall.finished.catch(() => null).then(() => {
    real?.classList.remove('is-clean-arriving');
    copy.remove();
  });
}

// ---- music and media ----------------------------------------------------

function startMusic() {
  const track = new Audio(MUSIC);
  music = track;
  track.loop = true;
  track.volume = 0;
  // A missing file is the ordinary case in a fresh clone - the loop is not in
  // the repository. Silence is the right failure, and not a console full of it.
  //
  // Both let go of *this* element only. stopMusic() empties a finished track's
  // src, which fires `error` on it and rejects a play() still pending - and if
  // a new session has started by then, a bare `music = null` dropped the new
  // session's loop, which stopClean() could then never stop.
  const drop = () => { if (music === track) music = null; };
  track.addEventListener('error', drop, { once: true });
  void track.play().then(() => fadeMusic(MUSIC_GAIN)).catch(drop);
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
