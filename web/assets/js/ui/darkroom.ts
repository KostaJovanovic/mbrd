// The darkroom: one picture, cropped, turned, mirrored, graded and cut out.
//
// Five edits live here and they are together because they are the same sitting
// - you look at a photograph, take the edge off it, stand it the way up it
// should have been, turn it the way round it should have been, take the wall out
// from behind it and warm it up. Splitting them into five dialogs would mean
// opening the second to see what the first did.
//
// ── Nothing here is destructive, and that is the whole contract ──
//
// A crop is four fractions of the source, a turn is one of three angles, a
// mirror is two flags, a grade is three multipliers and a background removal is
// one flag. All are stored on the item, in `meta`, and none of them touches
// a byte of the asset: the original is what the .mbrd carries, what Export hands
// back and what Optimize re-encodes. So Reset is a real way back rather than a
// best effort, Ctrl+Z works because all five writes go through state.ts like
// every other, and a board edited in this build opens unedited in an older one
// with the pictures intact. See itemCrop(), itemRotate(), itemFlip(),
// itemAdjust() and itemMatte() in board-model.ts, which are the definitions;
// this module only drives them.
//
// ── The order is crop, turn, matte, mirror, and it is visible here ──
//
// The crop and the turn and the matte are baked into the display copy - real
// pixels, one WebP per combination - and the mirror is a compositor transform
// that costs nothing. So the crop cuts the source, the turn turns what is left,
// the model takes the background out of that, and the mirror is applied to the
// result. The dialog shows exactly that: the picture is drawn turned and
// mirrored, the frame is placed over the turned and mirrored picture, and both
// the frame's position and every drag delta are mapped back to `rect`, which
// stays in the source's own coordinates. A reader that carries `meta.rotate` and
// `meta.flip` through without understanding them still cuts the right slice out
// of the right photograph.
//
// **Two mappings and no more.** toDisplay() takes a source rectangle to where it
// is drawn, and toSource() takes a drag delta back. Everything else in this file
// - resized(), moved(), the clamps, `rect` itself - works in source coordinates
// and knows nothing about which way up the picture is. That is the whole reason
// there is no flip-aware or turn-aware branch in the resize arithmetic, and it
// is worth keeping: the arithmetic is the part that is hard to get right, and it
// only has to be right once.
//
// ── Why the crop is in fractions ──
//
// Because the pixels underneath are not stable. Optimize re-encodes a photograph
// to a smaller one and the board goes on holding the same item; a crop in source
// pixels would have silently moved the first time that happened, and there is no
// event this module could listen to that would tell it. Fractions survive it, and
// they survive the display copy being made at whatever the quality dial's
// sharpness ceiling happens to be that session.
//
// ── The frame is in percentages, and never in pixels ──
//
// Every number this module holds about the crop is a fraction of the picture,
// and the frame is positioned with `%`. So a window resize, a rotate, or the
// picture finishing its decode at a size nobody predicted all cost nothing:
// there is no measurement to invalidate because none was taken. The one place
// pixels appear is inside a drag, where a pointer delta has to be divided by the
// plate's drawn size to become a fraction - and that size is read at the moment
// of the press, which is the only moment it is guaranteed to be the size the
// person is looking at.
//
// The one number that is read off the file rather than off the layout is the
// picture's intrinsic ratio, which goes onto the plate as `--dk-ar` so that a
// quarter turn can be laid out in CSS. That is a property of the photograph, not
// of the window, so it cannot go stale - see the .dk-quarter block in
// dialog.css, which is where the turned plate is sized.
//
// ── The background preview is a canvas, and it has to be ──
//
// The grade is a CSS filter and the mirror is a CSS transform, so both are shown
// by setting a property on the <img> the dialog already has. A background
// removal is a neural network over pixels and has no CSS spelling at all, so the
// preview is drawn: a <canvas> inside the crop frame, holding exactly the region
// that will survive, cut out at preview resolution. Inside the frame rather than
// over the whole plate deliberately - the frame is already positioned and sized
// to the crop in display coordinates, so lining the two up is free, and the
// model runs on the same region canvas/display.ts will run it on. A preview that
// asked the model about the *whole* frame would disagree with the card the
// moment a crop was set, because a saliency model answers about what it is shown.
//
// **It is asynchronous, and that is the one thing that makes this file harder
// than it was.** Every other edit here is a property assignment and paint() is
// synchronous throughout; a cut-out is a model that has to be fetched once and
// then run, which is hundreds of milliseconds the first time. So paintCutout()
// is fire-and-forget with a generation counter: paint() starts it and returns,
// and a result that comes back after the crop has moved again is dropped rather
// than drawn. Without the counter a slow run landing after a fast one puts the
// older mask on screen and leaves it there, which looks exactly like the model
// being wrong.
//
// Nothing reaches `document` at import time; initDarkroom() does, and
// tests/imports.test.js holds this file to that.

import {
  byId, itemAdjust, itemCrop, itemFlip, itemMatte, itemRotate,
  setItemAdjust, setItemCrop, setItemFlip, setItemMatte, setItemRotate, MIN_CROP,
  isLocked, snapshotGeom, applyGeom, commitGeom,
} from '../state.ts';
import { assetURL } from '../storage/assets.ts';
import { cutout, matteAvailable } from '../canvas/matte.ts';
import { surface } from '../canvas/surface.ts';
import { tickSlider } from './controls.ts';

/** The crop rectangle, as fractions of the source. */
type Rect = { x: number, y: number, w: number, h: number };

/** The whole picture: what an uncropped item is editing when it opens. */
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** The three dials, and the neutral value each starts from. */
const GRADE = ['brightness', 'contrast', 'saturation'] as const;
type Grade = Record<typeof GRADE[number], number>;
const NEUTRAL: Grade = { brightness: 1, contrast: 1, saturation: 1 };

/**
 * The two mirrors, and the button that toggles each.
 *
 * `x` is flip - left to right, the one you want on a portrait facing out of the
 * frame the wrong way - and `y` is flop, top to bottom. The words are
 * ImageMagick's the other way round; the buttons carry both the word and a
 * sentence saying which way it turns, which is the only thing that settles it
 * for somebody who has not read this line.
 */
const FLIPS = [
  { axis: 'x', id: 'dk-flip-x' },
  { axis: 'y', id: 'dk-flip-y' },
] as const;
type Flip = { x: boolean, y: boolean };
const UNFLIPPED: Flip = { x: false, y: false };

/**
 * The two turn buttons, and how far each moves.
 *
 * A pair rather than one button that steps a quarter each press: with one
 * button, going back one turn is three presses and Reset is the only other way
 * out, which makes an ordinary correction feel like a mistake somebody has to
 * work off. Both are verbs and neither is a toggle, so neither carries
 * aria-pressed - the state they change is the picture, which is right there.
 */
const TURNS = [
  { id: 'dk-turn-l', by: 270 },
  { id: 'dk-turn-r', by: 90 },
] as const;
/** Clockwise, in degrees: 0, 90, 180 or 270. */
type Turn = 0 | 90 | 180 | 270;

/**
 * How large the background preview is composited at.
 *
 * Not how hard the model works - it reads a 320x320 square whatever it is given
 * (SIDE in canvas/matte.ts), so this only sets how big the canvas the mask lands
 * on is. 512 on the long edge is comfortably more than the plate can draw, which
 * is at most 560 pixels tall, and keeps the readback cheap. The copy the card
 * actually mounts is made at the quality dial's sharpness by canvas/display.ts
 * and is not this.
 */
const PREVIEW_MAX = 512;

// The dialog and everything in it, taken once in initDarkroom(). Read with `!`
// past that guard, the way ui/viewer.ts reads its own: init returns early
// without the dialog and open() refuses before it touches any of them.
let dlg: HTMLDialogElement | null = null;
let img: HTMLImageElement | null = null;
let plate: HTMLElement | null = null;
let frame: HTMLElement | null = null;
let cutCanvas: HTMLCanvasElement | null = null;
const dials: Partial<Record<typeof GRADE[number], HTMLInputElement>> = {};
const mirrors: Partial<Record<keyof Flip, HTMLButtonElement>> = {};
let cutBtn: HTMLButtonElement | null = null;

/** Which item is open, and the five edits as they stand right now. */
let openId = '';
/** Whether a grip is already being dragged - see onGrab(). */
let grabbing = false;
let rect: Rect = { ...FULL };
let grade: Grade = { ...NEUTRAL };
let flip: Flip = { ...UNFLIPPED };
let turn: Turn = 0;
let matte = false;
/**
 * What the background preview was last drawn from.
 *
 * The model is much the most expensive thing paint() can start, and paint() runs
 * on every pointermove of a drag. Every input the cut depends on is in this
 * string, so an equal one means the pixels on the canvas are already right -
 * which is the common case during a grade, where nothing the model looked at has
 * changed at all.
 */
let cutoutKey = '';
/**
 * Which cut-out run is the current one.
 *
 * Bumped by every call to paintCutout(). A run that finishes and finds the
 * counter has moved drops its mask instead of drawing it - see the header. Also
 * reset on open, so a run started for the previous picture cannot land on this
 * one.
 */
let cutoutRun = 0;

/**
 * The eight handles, by the corner or edge each drives.
 *
 * The same eight names the board's own resize grips use (see resizeHandleAction
 * in canvas/input.ts), and deliberately the same names rather than similar ones:
 * anybody reading both files should not have to work out whether `nw` means the
 * same thing in each.
 */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = typeof HANDLES[number] | 'move';

export function initDarkroom() {
  // SAFETY: four assertions in this function and one fact behind all of them.
  // Each id names an element written out in index.html with the tag asserted,
  // and every one is kept `| null` and tested on the next line - so a page that
  // does not have it (the patch page, a stripped build) leaves the darkroom
  // uninitialised instead of throwing. The assertion is about the tag only.
  dlg = document.getElementById('darkroom') as HTMLDialogElement | null;
  if (!dlg) return;
  // SAFETY: as above - #darkroom-image is the <img> the crop is drawn over, and
  // every read of it in this module goes through `img!` only after this
  // assignment and the dialog test that guards it.
  img = document.getElementById('darkroom-image') as HTMLImageElement | null;
  plate = document.getElementById('darkroom-plate');
  frame = document.getElementById('darkroom-frame');
  // SAFETY: as above - #darkroom-cutout is the <canvas> the background preview
  // is drawn on, and the null survives to every use below.
  cutCanvas = document.getElementById('darkroom-cutout') as HTMLCanvasElement | null;
  // The intrinsic ratio, which is what lets a quarter turn be laid out without
  // measuring anything - see the header, and .dk-quarter in dialog.css. Read on
  // load rather than at open(), because at open() the src has just been set and
  // naturalWidth is still zero; the same event is what the preview waits for.
  img?.addEventListener('load', () => { writeRatio(); paint(); });
  for (const key of GRADE) {
    // SAFETY: as above - `dk-brightness` and its two siblings are <input> in
    // index.html, and the null is kept and tested rather than asserted away.
    const el = document.getElementById(`dk-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    dials[key] = el;
    // 'input' and not 'change': the picture behind the dial is the readout, and
    // a grade that only arrived when the slider was let go would make the dial
    // feel like a form field rather than like a control on a photograph.
    // 120 stops each, so tickSlider() declines all three. Wired for the reason
    // the volume is: the helper judges, not the call site.
    tickSlider(el);
    el.addEventListener('input', () => {
      // `Number.isFinite`, and emphatically not `Number(el.value) || 1`. Zero
      // is a real position on this control - saturation runs 0..2, and 0 is
      // greyscale, which is the single most-wanted grade there is. `|| 1` read
      // it as absent and put the dial back to neutral, so the slider sprang
      // back to 100% at the far left and the picture could not be desaturated
      // at all. Brightness and contrast start at 0.4 and never reached the trap,
      // which is why only one of the three ever looked broken. The guard is the
      // one itemAdjust() already applies on the way back out of the file.
      const n = Number(el.value);
      grade = { ...grade, [key]: Number.isFinite(n) ? n : 1 };
      paint();
    });
  }
  // SAFETY: as above - `dk-cutout` is a <button> in index.html.
  cutBtn = document.getElementById('dk-cutout') as HTMLButtonElement | null;
  if (cutBtn) {
    // Hidden rather than disabled where the model could never run - no workers,
    // or an engine that will not read a canvas back. A disabled control is a
    // promise that something would happen if only you were allowed; there is
    // nothing here that the person could do about it, so the honest interface
    // does not mention it. Asked once at init: neither answer changes while the
    // page is open.
    if (!matteAvailable()) cutBtn.hidden = true;
    cutBtn.addEventListener('click', () => {
      matte = !matte;
      writeDials();
      paint();
    });
  }
  for (const { axis, id } of FLIPS) {
    // SAFETY: as above - FLIPS names two <button> ids from index.html, and the
    // null survives to the next line.
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) continue;
    mirrors[axis] = el;
    // A toggle, not a verb: pressing it twice puts the picture back, and
    // aria-pressed is what says which state it is in. Written by writeDials()
    // rather than here, so the button and `flip` cannot disagree on the way in.
    el.addEventListener('click', () => {
      flip = { ...flip, [axis]: !flip[axis] };
      writeDials();
      paint();
    });
  }
  for (const { id, by } of TURNS) {
    document.getElementById(id)?.addEventListener('click', () => {
      // SAFETY: `turn` is one of the four quarters and `by` is 90 or 270, both
      // of which TURNS above states outright, so the sum is a multiple of 90 -
      // and modulo 360 it is one of the same four. Neither operand can be
      // negative, so this needs none of the wrapping itemRotate() does over a
      // number that came out of somebody's file. The set is closed under this
      // operation, which is what the assertion is.
      turn = ((turn + by) % 360) as Turn;
      writeRatio();
      paint();
    });
  }
  for (const name of HANDLES) {
    const h = document.createElement('div');
    h.className = 'dk-handle';
    h.dataset.h = name;
    frame?.append(h);
  }
  frame?.addEventListener('pointerdown', onGrab);
  document.getElementById('darkroom-close')?.addEventListener('click', () => dlg!.close());
  document.getElementById('darkroom-cancel')?.addEventListener('click', () => dlg!.close());
  document.getElementById('darkroom-apply')?.addEventListener('click', apply);
  // Reset puts every edit back to neutral *in the dialog* and does not write:
  // it is a way to see the untouched picture, and Cancel still has to be able
  // to leave the item exactly as it was found. Applying afterwards is what
  // commits the reset, which is one keystroke and no ambiguity.
  document.getElementById('darkroom-reset')?.addEventListener('click', () => {
    rect = { ...FULL };
    grade = { ...NEUTRAL };
    flip = { ...UNFLIPPED };
    turn = 0;
    matte = false;
    writeDials();
    writeRatio();
    paint();
  });
  // `img?.`, not `img!`. Only `dlg` was null-checked on the way into this
  // function, so a page carrying the dialog without the picture inside it threw
  // here on close - taking the openId reset with it, which is the one line that
  // has to run whatever else does not.
  dlg.addEventListener('close', () => { openId = ''; grabbing = false; img?.removeAttribute('src'); });
}

/**
 * Can this item be taken into the darkroom?
 *
 * Photographs only, and only ones with bytes on this board. An animated picture
 * is excluded for the reason the display copy excludes it: a cropped GIF made
 * through a canvas is a still, so the crop would silently stop the animation.
 * An SVG is excluded because it has no pixels to crop - it is resolution-free,
 * and the sensible crop of a vector is a viewBox edit this app does not do.
 */
export function canEditPicture(id: string): boolean {
  const it = byId(id);
  if (!it || it.type !== 'image' || !it.asset?.hash) return false;
  if (it.meta?.gif || String(it.meta?.ext || '').toLowerCase() === 'gif') return false;
  return !!assetURL(it.asset.hash);
}

/** Open the darkroom on one picture. */
export function openDarkroom(id: string) {
  const it = byId(id);
  if (!dlg || typeof dlg.showModal !== 'function' || !it || !canEditPicture(id)) return;
  openId = id;
  rect = itemCrop(it) || { ...FULL };
  grade = itemAdjust(it) || { ...NEUTRAL };
  flip = itemFlip(it) || { ...UNFLIPPED };
  turn = itemRotate(it) || 0;
  matte = itemMatte(it);
  // Nothing has been drawn for this picture yet, whatever the last one left on
  // the canvas, and any run still in flight belongs to the last picture. Without
  // the first a second opening showed the previous cut-out until something
  // moved; without the second, a slow run from the previous picture could land
  // on this one - which is the same staleness the counter guards during a drag,
  // arriving by a different door.
  cutoutKey = '';
  cutoutRun++;
  // The *original*, not the display copy. The copy is already cropped, turned
  // and cut out - it is what those are applied to - so editing against it would
  // compose each new rectangle on top of the last and there would be no way back
  // out to the full frame. This is the one surface in the app that has to see
  // the whole picture.
  img!.src = (it.asset?.hash ? assetURL(it.asset.hash) : null) || '';
  img!.alt = it.name || '';
  writeDials();
  writeRatio();
  paint();
  dlg.showModal();
}

/**
 * The three sliders and the three toggles, set from `grade`, `flip` and `matte`.
 * The other direction is their listeners.
 */
function writeDials() {
  for (const key of GRADE) {
    const el = dials[key];
    if (el) el.value = String(grade[key]);
  }
  for (const { axis } of FLIPS) {
    mirrors[axis]?.setAttribute('aria-pressed', flip[axis] ? 'true' : 'false');
  }
  // The cut-out reads as a toggle for the reason the two mirrors do: it is a
  // state the picture is in rather than an action, and aria-pressed is the one
  // place that state is written, so the button and `matte` cannot disagree.
  cutBtn?.setAttribute('aria-pressed', matte ? 'true' : 'false');
}

/**
 * The plate's shape, for a quarter turn.
 *
 * `.dk-quarter` is what swaps the layout, and `--dk-ar` is the ratio it swaps
 * to: the picture's own height over its own width, which is the width-over-
 * height of the turned picture. Both are set here and read only by dialog.css.
 *
 * A 180 turn is not a quarter and needs neither - it lands on the same box,
 * which is exactly why `quarter` in this file is never spelled `!!turn`.
 *
 * Removed rather than left at a stale value when the picture is not turned, so
 * the ordinary case is the shrink-wrapped plate this dialog has always had and
 * there is one layout to be wrong rather than two.
 */
function writeRatio() {
  if (!plate) return;
  const quarter = turn === 90 || turn === 270;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  plate.classList.toggle('dk-quarter', quarter && nw > 0 && nh > 0);
  if (quarter && nw > 0 && nh > 0) plate.style.setProperty('--dk-ar', String(nh / nw));
  else plate.style.removeProperty('--dk-ar');
}

/**
 * A source rectangle as it is drawn: turned, then mirrored.
 *
 * One of the two mappings this file has, and the reason `rect` can stay in the
 * source's own coordinates while the frame sits over a picture that may be
 * standing on its head. The turn is clockwise, so a source point (u, v) lands at
 * (1-v, u) for a quarter right - which is where each of these four lines comes
 * from, read as "the new left edge is the old bottom edge".
 *
 * The mirror is applied to the *turned* rectangle and not to the source one,
 * because that is the order the picture is drawn in - see the header, and the
 * transform written in paint().
 */
function toDisplay(r: Rect): Rect {
  const d = turn === 90 ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : turn === 180 ? { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h }
      : turn === 270 ? { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w }
        : r;
  return {
    x: flip.x ? 1 - d.x - d.w : d.x,
    y: flip.y ? 1 - d.y - d.h : d.y,
    w: d.w,
    h: d.h,
  };
}

/**
 * A drag, in fractions of the drawn picture, as a movement through the source.
 *
 * The other mapping, and the inverse of toDisplay() with the translations
 * dropped: a delta has no position, so only the reflections and the axis swap
 * survive. Undone in the opposite order to the way they were applied - mirror
 * first, then turn - which is what makes the pair actually inverse rather than
 * merely symmetrical-looking.
 */
function toSource(dx: number, dy: number): [number, number] {
  const ux = flip.x ? -dx : dx;
  const uy = flip.y ? -dy : dy;
  if (turn === 90) return [uy, -ux];
  if (turn === 180) return [-ux, -uy];
  if (turn === 270) return [-uy, ux];
  return [ux, uy];
}

/**
 * Everything the dialog draws, from `rect`, `turn`, `flip`, `grade` and `matte`.
 *
 * One function for every edit and called after any change to any of them,
 * because they share a surface: the frame sits over the picture, the picture is
 * the thing being turned and graded, and the background preview is the region
 * inside the frame. A paint that did one without the others would show a crop of
 * an ungraded photograph, or a cut-out of a rectangle that has since moved.
 */
function paint() {
  const pc = (n: number) => `${(n * 100).toFixed(4)}%`;
  frame!.hidden = false;
  // The frame is placed over the *displayed* picture, which is turned and
  // mirrored, while `rect` is always in the source's own coordinates - so it
  // goes through toDisplay() here and every drag delta comes back through
  // toSource() in onGrab(). Doing it in those two places rather than storing the
  // rectangle as drawn is what keeps the file honest: `meta.crop` means the same
  // thing whichever way up the picture is, so a reader that ignores
  // `meta.rotate` and `meta.flip` still cuts the right slice.
  const shown = toDisplay(rect);
  frame!.style.left = pc(shown.x);
  frame!.style.top = pc(shown.y);
  frame!.style.width = pc(shown.w);
  frame!.style.height = pc(shown.h);
  img!.style.filter =
    `brightness(${grade.brightness}) contrast(${grade.contrast}) saturate(${grade.saturation})`;
  // The picture, and only the picture: the frame is a sibling inside the plate,
  // so it does not turn with it and its handles stay where the hand expects
  // them. Read right to left, which is how a transform list composes - the turn
  // happens first and the mirror is applied to the turned picture, matching the
  // order toDisplay() maps in and the order canvas/display.ts bakes in. Built
  // here rather than taken from flipTransform(), since this one has to exist at
  // neutral too or a flip back would leave the last transform on the node.
  //
  // The translate is first in the list and last in effect, and it is there only
  // for a quarter turn: .dk-quarter takes the picture out of flow and centres it
  // on the plate, because a turned picture's layout box is still the box of the
  // picture it was before it turned. See dialog.css.
  //
  // Read off the class rather than off `turn`, and the difference is one frame
  // that would be visibly wrong. writeRatio() declines the class until the
  // picture has decoded, because a turned plate needs the picture's ratio and
  // there is not one yet - so a cached picture opened at 90 got the centring
  // translate while it was still laid out in flow, and jumped into place on
  // load. The class is the single fact about which layout is in effect; asking
  // it is what makes the two agree by construction.
  const centre = plate?.classList.contains('dk-quarter') ? 'translate(-50%, -50%) ' : '';
  img!.style.transform =
    `${centre}scale(${flip.x ? -1 : 1}, ${flip.y ? -1 : 1}) rotate(${turn}deg)`;
  paintCutout();
  // The readouts beside the dials, as whole percentages - which is what the
  // numbers mean and is shorter to read than 1.14.
  for (const key of GRADE) {
    const out = dlg!.querySelector<HTMLOutputElement>(`output[for="dk-${key}"]`);
    if (out) out.textContent = `${Math.round(grade[key] * 100)}%`;
  }
}

/**
 * The background preview: the crop region, turned, cut out, drawn inside the
 * frame.
 *
 * The same steps canvas/display.ts takes when it bakes the copy, at preview
 * resolution and in the same order, which is the point - a preview computed a
 * different way is a preview that can be wrong. The mirror is the one step that
 * happens here rather than there, because on the card it is a CSS transform and
 * on this canvas there is no CSS to carry it.
 *
 * Started rather than awaited, and every early exit hides the canvas: no cut
 * asked for, no picture decoded yet, no surface. What shows through is the
 * ordinary <img> underneath, which is the picture with its background still on
 * it - an honest "this did not happen" rather than a hole.
 *
 * `cutoutKey` is what stops the model being asked the same question twice, and
 * `cutoutRun` is what stops an old answer being drawn. They are two guards
 * because they catch different things: the key is an optimisation and the
 * counter is a correctness fix, and a key alone would still let a slow run
 * started three crops ago land last.
 */
function paintCutout() {
  const cv = cutCanvas;
  if (!cv) return;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!matte || !nw || !nh) {
    cv.hidden = true;
    cutoutKey = '';
    // Bumped on the way out too, so a run in flight when the button is switched
    // off cannot un-hide the canvas when it lands.
    cutoutRun++;
    return;
  }
  // Everything the cut depends on. The grade is deliberately not in it: a
  // brightness is applied by the compositor over the top of this canvas as it is
  // over the <img>, so moving that dial cannot change a pixel the model saw.
  const key = `${rect.x},${rect.y},${rect.w},${rect.h}|${turn}|${flip.x}${flip.y}`;
  if (key === cutoutKey && !cv.hidden) return;
  const sx = Math.round(rect.x * nw);
  const sy = Math.round(rect.y * nh);
  const sw = Math.max(1, Math.round(rect.w * nw));
  const sh = Math.max(1, Math.round(rect.h * nh));
  const scale = Math.min(1, PREVIEW_MAX / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const quarter = turn === 90 || turn === 270;
  const dw = quarter ? h : w;
  const dh = quarter ? w : h;
  const face = surface(dw, dh);
  if (!face) { cv.hidden = true; cutoutKey = ''; return; }
  if (turn) {
    face.ctx.translate(dw / 2, dh / 2);
    face.ctx.rotate(turn * Math.PI / 180);
    face.ctx.drawImage(img!, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    face.ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    face.ctx.drawImage(img!, sx, sy, sw, sh, 0, 0, w, h);
  }
  // Claimed before the await, so a run started after this one wins whatever
  // order the two finish in. The key is claimed here too rather than on success,
  // because a second identical request while this one is still running should
  // wait for it rather than start a rival.
  const mine = ++cutoutRun;
  cutoutKey = key;
  // The busy mark goes on the dialog rather than on the button, because what is
  // waiting is the picture. dialog.css turns it into a pulse on the plate; the
  // button keeps its pressed state throughout, since the state is what was asked
  // for and not what has arrived.
  dlg?.classList.add('dk-busy');
  cutout(face, dw, dh).then(ok => {
    if (mine !== cutoutRun) return;
    dlg?.classList.remove('dk-busy');
    if (!ok) { cv.hidden = true; cutoutKey = ''; return; }
    cv.width = dw;
    cv.height = dh;
    const ctx = cv.getContext('2d');
    if (!ctx) { cv.hidden = true; cutoutKey = ''; return; }
    ctx.clearRect(0, 0, dw, dh);
    // The mirror, as a transform on the way in rather than on the element: a CSS
    // transform on this canvas would turn its checkerboard with it, and the
    // checkerboard is furniture rather than picture.
    ctx.setTransform(flip.x ? -1 : 1, 0, 0, flip.y ? -1 : 1, flip.x ? dw : 0, flip.y ? dh : 0);
    ctx.drawImage(face.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    cv.hidden = false;
  });
}

/**
 * A press on the frame or one of its handles.
 *
 * One listener on the frame rather than nine, and the target's own `data-h`
 * says which of the nine it was - the same delegation the board's grips use.
 * Pointer capture on the frame means the drag survives the pointer leaving the
 * picture, which is exactly what a drag to the very edge does.
 */
function onGrab(e: PointerEvent) {
  if (!(e.target instanceof HTMLElement)) return;
  // One grab at a time. Every press bound its own three listeners and the
  // matching `up` removed only its own, so a second finger on the frame left
  // the first press's onMove bound for good: after both lifted, merely moving
  // a pointer across the frame recomputed the rectangle from a stale `from`
  // and the crop jumped with no button pressed.
  if (grabbing) return;
  grabbing = true;
  // SAFETY: `data-h` is written by this module and nowhere else - the eight
  // grips carry one of HANDLES, and anything without the attribute falls to
  // 'move', which is the other member of Handle. A hand-edited attribute would
  // land on sourceHandle()'s pass-through and move the crop rather than resize
  // it, which is a wrong drag and not a broken one.
  const handle = sourceHandle((e.target.dataset.h || 'move') as Handle);
  // The drawn size of the *plate*, read once at the press. The plate rather than
  // the picture, and that is not interchangeable: on a quarter turn the <img>'s
  // own box is still the shape it had before it turned and the plate is the
  // turned one, so dividing by the picture would make every delta wrong by the
  // aspect ratio. Every delta
  // below is divided by it to become a fraction, which is the only pixel
  // measurement in this module and the note at the top of the file says why it
  // is here.
  const box = (plate || img!).getBoundingClientRect();
  if (!box.width || !box.height) { grabbing = false; return; }
  const from = { ...rect };
  const x0 = e.clientX;
  const y0 = e.clientY;
  e.preventDefault();
  frame!.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    // Mapped back through toSource(), for the reason the frame's position is
    // mapped forward in paint(): the hand is moving over the displayed picture
    // and `rect` is in the source's coordinates, so a drag to the right on a
    // picture standing on its side is a move down through the file.
    const [dx, dy] = toSource((ev.clientX - x0) / box.width, (ev.clientY - y0) / box.height);
    rect = handle === 'move' ? moved(from, dx, dy) : resized(from, handle, dx, dy);
    paint();
  };
  const onUp = () => {
    frame!.removeEventListener('pointermove', onMove);
    frame!.removeEventListener('pointerup', onUp);
    frame!.removeEventListener('pointercancel', onUp);
    grabbing = false;
  };
  frame!.addEventListener('pointermove', onMove);
  frame!.addEventListener('pointerup', onUp);
  frame!.addEventListener('pointercancel', onUp);
}

/** Which source letter each displayed letter is, per quarter turn. */
const TURNED: Record<number, Record<string, string>> = {
  90: { n: 'w', e: 'n', s: 'e', w: 's' },
  180: { n: 's', s: 'n', e: 'w', w: 'e' },
  270: { n: 'e', e: 's', s: 'w', w: 'n' },
};

/** n and s before e and w, which is the order HANDLES names a corner in. */
const RANK = (c: string) => (c === 'n' || c === 's' ? 0 : 1);

/**
 * A handle, named for the edge of the *source* it drives.
 *
 * The eight are laid out around the frame and the frame sits over the displayed
 * picture, so on a mirrored axis the grip on the visual left is the source's own
 * right edge, and on a quarter turn it is the source's own bottom. resized()
 * below works in source coordinates and nothing else in this module has to know
 * which way up the picture is - which is why the swap is two lookups here rather
 * than a turn-aware branch in the resize arithmetic.
 *
 * Mirror first and then turn, the same order toSource() undoes a delta in and
 * for the same reason: the picture is turned and *then* mirrored, so coming back
 * the other way the mirror is the one to take off first.
 *
 * The mirror swap is per axis and not per handle: a corner on a picture mirrored
 * one way keeps the letter belonging to the other axis.
 */
function sourceHandle(handle: Handle): Handle {
  if (handle === 'move') return handle;
  const swap: Record<string, string> = { w: 'e', e: 'w', n: 's', s: 'n' };
  const mirrored = [...handle].map(c =>
    ((flip.x && (c === 'w' || c === 'e')) || (flip.y && (c === 'n' || c === 's'))
      ? swap[c] : c));
  const spun = TURNED[turn] ? mirrored.map(c => TURNED[turn][c] || c) : mirrored;
  // SAFETY: both maps send each of the four letters to one of the four, so a
  // corner stays a corner and an edge stays an edge and the set is closed under
  // both. The sort is what makes a corner a *member* of HANDLES rather than
  // merely a pair of the right letters: a quarter turn takes 'nw' to 'ws', which
  // resized() would read correctly either way and which is still spelled 'sw'.
  return spun.sort((a, b) => RANK(a) - RANK(b)).join('') as Handle;
}

/**
 * The frame slid, and held inside the picture.
 *
 * Clamped rather than stopped: dragging past the edge parks the frame against
 * it and a drag back comes straight off again, where refusing the move outright
 * would make the frame stick at wherever the pointer crossed the line.
 */
function moved(from: Rect, dx: number, dy: number): Rect {
  return {
    x: clamp01(from.x + dx, from.w),
    y: clamp01(from.y + dy, from.h),
    w: from.w,
    h: from.h,
  };
}

/** One edge or corner dragged. The opposite side stays exactly where it is. */
function resized(from: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x, y, w, h } = from;
  if (handle.includes('w')) { const nx = Math.min(from.x + dx, from.x + from.w - MIN_CROP); x = Math.max(0, nx); w = from.x + from.w - x; }
  if (handle.includes('e')) { const nr = Math.max(from.x + from.w + dx, from.x + MIN_CROP); w = Math.min(1, nr) - x; }
  if (handle.includes('n')) { const ny = Math.min(from.y + dy, from.y + from.h - MIN_CROP); y = Math.max(0, ny); h = from.y + from.h - y; }
  if (handle.includes('s')) { const nb = Math.max(from.y + from.h + dy, from.y + MIN_CROP); h = Math.min(1, nb) - y; }
  return { x, y, w, h };
}

/** A position held so that a box of size `size` stays inside 0..1. */
const clamp01 = (v: number, size: number) => Math.min(Math.max(0, v), 1 - size);

/**
 * Write every edit and close.
 *
 * Five calls and therefore up to five history entries, which is the honest
 * count: they are five independent things about the picture, any may be
 * unchanged, and state.ts drops a write that changes nothing on its own. Folding
 * them into one entry would mean a Ctrl+Z after a session where only the crop
 * moved still announcing that it had put the grade back.
 */
function apply() {
  const id = openId;
  if (!id) return;
  const was = itemCrop(byId(id)) || { ...FULL };
  const wasTurn = itemRotate(byId(id)) || 0;
  const full = rect.x <= 0 && rect.y <= 0 && rect.w >= 1 && rect.h >= 1;
  setItemCrop(id, full ? null : rect);
  setItemRotate(id, turn || null);
  // The card follows the crop and the turn. After both writes rather than
  // before, which is the order the three read in: the picture is cropped, then
  // stood the right way up, and then the card it sits in is the shape of what is
  // left. A Ctrl+Z takes the size back and the next takes the edit, which is the
  // same "independent things" the writes above already are.
  //
  // The turn is in the test because a quarter turn changes the card's shape
  // without touching a single number in `rect` - which is exactly the case a
  // crop-only test missed, leaving a portrait photograph turned upright inside a
  // landscape card.
  if (was.w !== rect.w || was.h !== rect.h || wasTurn !== turn) refitCard(id);
  const neutral = GRADE.every(k => grade[k] === 1);
  setItemAdjust(id, neutral ? null : grade);
  // The mirror, and a history entry of its own by the same argument: which way
  // round a picture is hung is its own decision, and a Ctrl+Z after a sitting
  // where only the mirror moved should not announce that it has put the grade
  // back. Null rather than two falses, so a picture flipped and flipped again
  // leaves no key - the same shape every write here takes.
  setItemFlip(id, flip.x || flip.y ? flip : null);
  setItemMatte(id, matte);
  dlg!.close();
}

/**
 * The card, reshaped to the crop and the turn, holding the area it already
 * covered.
 *
 * A crop changes the picture's proportions and the card kept the old ones, so a
 * 16:9 slice of a square photograph was drawn letterboxed inside a square card -
 * the crop's whole point, thrown away by the frame around it. This makes the
 * card the shape of what the crop left, standing the way the turn stands it.
 *
 * **Area, not width.** Holding the width shrinks a card every time somebody
 * crops a tall photograph to a wide one, and holding the longer side grows one
 * every time they do the reverse; either way a crop quietly changes how loud the
 * card is on the board, which is not what was asked for. Area holds that fixed
 * and lets only the proportions move. It also means the reverse crop lands back
 * on the size it started at, which neither of the others does - and it is what
 * makes a quarter turn and a quarter turn back a round trip rather than a slow
 * drift in the card's size.
 *
 * Grown about the centre, because that is where the eye is: the picture under
 * the pointer stays under the pointer instead of the card growing away to the
 * right and down from a corner nobody was looking at.
 *
 * Through the geometry writers rather than by assigning w and h, so the board
 * mode, the snap lattice and the undo entry are all somebody else's problem -
 * see fitOnto() in layout.ts, which is what applyGeom runs each patch through.
 *
 * A locked card is left alone. Its contract is that its geometry does not move
 * (isLocked in board-model.ts), and "except when you crop it" is not a lock.
 */
function refitCard(id: string) {
  const it = byId(id);
  if (!it || isLocked(it)) return;
  const nw = img!.naturalWidth;
  const nh = img!.naturalHeight;
  if (!nw || !nh || !it.w || !it.h) return;
  // The crop's own proportions, in source pixels: the fractions are of a
  // picture that is not square, so the fractions alone do not say the shape.
  // Inverted for a quarter turn, which is the whole of what a turn does to a
  // card - 180 leaves the shape alone, which is why this is not `!!turn`.
  const cropped = (rect.w * nw) / (rect.h * nh);
  const aspect = turn === 90 || turn === 270 ? 1 / cropped : cropped;
  if (!Number.isFinite(aspect) || aspect <= 0) return;
  const area = it.w * it.h;
  const h = Math.max(1, Math.round(Math.sqrt(area / aspect)));
  const w = Math.max(1, Math.round(h * aspect));
  if (w === it.w && h === it.h) return;
  const before = snapshotGeom([id]);
  applyGeom([{
    id,
    x: it.x + (it.w - w) / 2,
    y: it.y + (it.h - h) / 2,
    w, h, rot: it.rot, z: it.z,
  }]);
  commitGeom('Crop', before);
}
