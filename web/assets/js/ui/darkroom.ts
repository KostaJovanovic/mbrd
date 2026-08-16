// The darkroom: one picture, cropped, turned and graded.
//
// Three edits live here and they are together because they are the same sitting
// - you look at a photograph, take the edge off it, turn it the way round it
// should have been, and warm it up. Splitting them into three dialogs would mean
// opening the second to see what the first did.
//
// ── Nothing here is destructive, and that is the whole contract ──
//
// A crop is four fractions of the source, a mirror is two flags and a grade is
// three multipliers. All are stored on the item, in `meta`, and none of them
// touches a byte of the asset: the original is what the .mbrd carries, what
// Export hands back and what Optimize re-encodes. So Reset is a real way back
// rather than a best effort, Ctrl+Z works because all three writes go through
// state.ts like every other, and a board cropped in this build opens uncropped
// in an older one with the pictures intact. See itemCrop(), itemFlip() and
// itemAdjust() in board-model.ts, which are the definitions; this module only
// drives them.
//
// ── The crop cuts, the mirror turns, in that order ──
//
// A crop is baked into the display copy - real pixels, one WebP per rectangle -
// and a mirror is a compositor transform that costs nothing. So the crop is
// applied to the source and the mirror to what is left, and the dialog shows
// exactly that: the picture is drawn turned, the frame is placed over the turned
// picture, and both the frame's position and every drag delta are reflected on
// the way to and from `rect`, which stays in the source's own coordinates. A
// reader that carries `meta.flip` through without understanding it still cuts
// the right slice out of the right photograph.
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
// picture's drawn size to become a fraction - and that size is read at the
// moment of the press, which is the only moment it is guaranteed to be the size
// the person is looking at.
//
// Nothing reaches `document` at import time; initDarkroom() does, and
// tests/imports.test.js holds this file to that.

import {
  byId, itemAdjust, itemCrop, itemFlip, setItemAdjust, setItemCrop, setItemFlip, MIN_CROP,
  isLocked, snapshotGeom, applyGeom, commitGeom,
} from '../state.ts';
import { assetURL } from '../storage/assets.ts';
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

// The dialog and everything in it, taken once in initDarkroom(). Read with `!`
// past that guard, the way ui/viewer.ts reads its own: init returns early
// without the dialog and open() refuses before it touches any of them.
let dlg: HTMLDialogElement | null = null;
let img: HTMLImageElement | null = null;
let frame: HTMLElement | null = null;
const dials: Partial<Record<typeof GRADE[number], HTMLInputElement>> = {};
const mirrors: Partial<Record<keyof Flip, HTMLButtonElement>> = {};

/** Which item is open, and the three edits as they stand right now. */
let openId = '';
/** Whether a grip is already being dragged - see onGrab(). */
let grabbing = false;
let rect: Rect = { ...FULL };
let grade: Grade = { ...NEUTRAL };
let flip: Flip = { ...UNFLIPPED };

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
  frame = document.getElementById('darkroom-frame');
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
  // Reset puts both edits back to neutral *in the dialog* and does not write:
  // it is a way to see the untouched picture, and Cancel still has to be able
  // to leave the item exactly as it was found. Applying afterwards is what
  // commits the reset, which is one keystroke and no ambiguity.
  document.getElementById('darkroom-reset')?.addEventListener('click', () => {
    rect = { ...FULL };
    grade = { ...NEUTRAL };
    flip = { ...UNFLIPPED };
    writeDials();
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
  // The *original*, not the display copy. The copy is already cropped - it is
  // what the crop is applied to - so editing against it would compose each new
  // rectangle on top of the last and there would be no way back out to the full
  // frame. This is the one surface in the app that has to see the whole picture.
  img!.src = (it.asset?.hash ? assetURL(it.asset.hash) : null) || '';
  img!.alt = it.name || '';
  writeDials();
  paint();
  dlg.showModal();
}

/**
 * The three sliders and the two mirror buttons, set from `grade` and `flip`.
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
}

/**
 * Everything the dialog draws, from `rect` and `grade`.
 *
 * One function for both edits and called after every change to either, because
 * they share a surface: the frame sits over the picture and the picture is the
 * thing being graded, so a paint that did one without the other would show a
 * crop of an ungraded photograph.
 */
function paint() {
  const pc = (n: number) => `${(n * 100).toFixed(4)}%`;
  frame!.hidden = false;
  // The frame is placed over the *displayed* picture, which is mirrored, while
  // `rect` is always in the source's own coordinates - so a mirrored axis is
  // reflected on the way out here and on the way back in onGrab(). Doing it in
  // those two places rather than storing the rectangle as drawn is what keeps
  // the file honest: `meta.crop` means the same thing whether or not the picture
  // is turned, so a reader that ignores `meta.flip` still cuts the right slice.
  frame!.style.left = pc(flip.x ? 1 - rect.x - rect.w : rect.x);
  frame!.style.top = pc(flip.y ? 1 - rect.y - rect.h : rect.y);
  frame!.style.width = pc(rect.w);
  frame!.style.height = pc(rect.h);
  img!.style.filter =
    `brightness(${grade.brightness}) contrast(${grade.contrast}) saturate(${grade.saturation})`;
  // The picture, and only the picture: the frame is a sibling inside the plate,
  // so it does not turn with it and its handles stay where the hand expects
  // them. Same string the card will get - see flipTransform() - but built here,
  // since this one has to exist at neutral too or a flip back would leave the
  // last transform on the node.
  img!.style.transform = `scale(${flip.x ? -1 : 1}, ${flip.y ? -1 : 1})`;
  // The readouts beside the dials, as whole percentages - which is what the
  // numbers mean and is shorter to read than 1.14.
  for (const key of GRADE) {
    const out = dlg!.querySelector<HTMLOutputElement>(`output[for="dk-${key}"]`);
    if (out) out.textContent = `${Math.round(grade[key] * 100)}%`;
  }
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
  // land on mirrorHandle()'s pass-through and move the crop rather than resize
  // it, which is a wrong drag and not a broken one.
  const handle = mirrorHandle((e.target.dataset.h || 'move') as Handle);
  // The drawn size of the picture, read once at the press. Every delta below is
  // divided by it to become a fraction, which is the only pixel measurement in
  // this module and the note at the top of the file says why it is here.
  const box = img!.getBoundingClientRect();
  if (!box.width || !box.height) { grabbing = false; return; }
  const from = { ...rect };
  const x0 = e.clientX;
  const y0 = e.clientY;
  e.preventDefault();
  frame!.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    // Negated on a mirrored axis, for the reason the frame's position is
    // reflected in paint(): the hand is moving over the displayed picture and
    // `rect` is in the source's coordinates, so a drag to the right on a
    // mirrored photograph is a move to the left through the file.
    const dx = ((ev.clientX - x0) / box.width) * (flip.x ? -1 : 1);
    const dy = ((ev.clientY - y0) / box.height) * (flip.y ? -1 : 1);
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

/**
 * A handle, named for the edge of the *source* it drives.
 *
 * The eight are laid out around the frame and the frame sits over the displayed
 * picture, so on a mirrored axis the grip on the visual left is the source's own
 * right edge. resized() below works in source coordinates and nothing else in
 * this module has to know that the picture is turned - which is why the swap is
 * one lookup here rather than a flip-aware branch in the resize arithmetic.
 *
 * Per axis, not per handle: a corner on a picture mirrored one way keeps the
 * letter belonging to the other axis.
 */
function mirrorHandle(handle: Handle): Handle {
  if (handle === 'move' || (!flip.x && !flip.y)) return handle;
  const swap: Record<string, string> = { w: 'e', e: 'w', n: 's', s: 'n' };
  // SAFETY: the map swaps each letter for its opposite and changes nothing
  // else, so a corner stays a corner and an edge stays an edge - 'nw' becomes
  // 'ne' or 'sw' or 'se', all of which are in HANDLES. The set is closed under
  // this operation, which is what the assertion is.
  return [...handle]
    .map(c => ((flip.x && (c === 'w' || c === 'e')) || (flip.y && (c === 'n' || c === 's'))
      ? swap[c] : c))
    .join('') as Handle;
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
 * Write both edits and close.
 *
 * Three calls and therefore three history entries, which is the honest count:
 * they are three independent things about the picture, any may be unchanged, and
 * state.ts drops a write that changes nothing on its own. Folding them into one
 * entry would mean a Ctrl+Z after a session where only the crop moved still
 * announcing that it had put the grade back.
 */
function apply() {
  const id = openId;
  if (!id) return;
  const was = itemCrop(byId(id)) || { ...FULL };
  const full = rect.x <= 0 && rect.y <= 0 && rect.w >= 1 && rect.h >= 1;
  setItemCrop(id, full ? null : rect);
  // The card follows the crop. After the write rather than before it, which is
  // the order the two read in: the picture is cropped, and then the card it
  // sits in is the shape of what is left. A Ctrl+Z takes the size back and a
  // second takes the crop, which is the same "two independent things" the two
  // writes above already are.
  if (was.w !== rect.w || was.h !== rect.h) refitCard(id);
  const neutral = GRADE.every(k => grade[k] === 1);
  setItemAdjust(id, neutral ? null : grade);
  // The third write, and a third history entry by the same argument: which way
  // round a picture is hung is its own decision, and a Ctrl+Z after a sitting
  // where only the mirror moved should not announce that it has put the grade
  // back. Null rather than two falses, so a picture flipped and flipped again
  // leaves no key - the same shape the two writes above take.
  setItemFlip(id, flip.x || flip.y ? flip : null);
  dlg!.close();
}

/**
 * The card, reshaped to the crop, holding the area it already covered.
 *
 * A crop changes the picture's proportions and the card kept the old ones, so a
 * 16:9 slice of a square photograph was drawn letterboxed inside a square card -
 * the crop's whole point, thrown away by the frame around it. This makes the
 * card the shape of what the crop left.
 *
 * **Area, not width.** Holding the width shrinks a card every time somebody
 * crops a tall photograph to a wide one, and holding the longer side grows one
 * every time they do the reverse; either way a crop quietly changes how loud the
 * card is on the board, which is not what was asked for. Area holds that fixed
 * and lets only the proportions move. It also means the reverse crop lands back
 * on the size it started at, which neither of the others does.
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
  const aspect = (rect.w * nw) / (rect.h * nh);
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
