// The darkroom: one picture, cropped and graded.
//
// Two edits live here and they are together because they are the same sitting -
// you look at a photograph, take the edge off it, and warm it up. Splitting them
// into two dialogs would mean opening the second to see what the first did.
//
// ── Nothing here is destructive, and that is the whole contract ──
//
// A crop is four fractions of the source and a grade is three multipliers. Both
// are stored on the item, in `meta`, and neither touches a byte of the asset:
// the original is what the .mbrd carries, what Export hands back and what
// Optimize re-encodes. So Reset is a real way back rather than a best effort,
// Ctrl+Z works because both writes go through state.ts like every other, and a
// board cropped in this build opens uncropped in an older one with the pictures
// intact. See itemCrop() and itemAdjust() in board-model.ts, which are the
// definitions; this module only drives them.
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

import { byId, itemAdjust, itemCrop, setItemAdjust, setItemCrop, MIN_CROP } from '../state.ts';
import { assetURL } from '../storage/assets.ts';

/** The crop rectangle, as fractions of the source. */
type Rect = { x: number, y: number, w: number, h: number };

/** The whole picture: what an uncropped item is editing when it opens. */
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** The three dials, and the neutral value each starts from. */
const GRADE = ['brightness', 'contrast', 'saturation'] as const;
type Grade = Record<typeof GRADE[number], number>;
const NEUTRAL: Grade = { brightness: 1, contrast: 1, saturation: 1 };

// The dialog and everything in it, taken once in initDarkroom(). Read with `!`
// past that guard, the way ui/viewer.ts reads its own: init returns early
// without the dialog and open() refuses before it touches any of them.
let dlg: HTMLDialogElement | null = null;
let img: HTMLImageElement | null = null;
let frame: HTMLElement | null = null;
const dials: Partial<Record<typeof GRADE[number], HTMLInputElement>> = {};

/** Which item is open, and the two edits as they stand right now. */
let openId = '';
let rect: Rect = { ...FULL };
let grade: Grade = { ...NEUTRAL };

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
  dlg = document.getElementById('darkroom') as HTMLDialogElement | null;
  if (!dlg) return;
  img = document.getElementById('darkroom-image') as HTMLImageElement | null;
  frame = document.getElementById('darkroom-frame');
  for (const key of GRADE) {
    const el = document.getElementById(`dk-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    dials[key] = el;
    // 'input' and not 'change': the picture behind the dial is the readout, and
    // a grade that only arrived when the slider was let go would make the dial
    // feel like a form field rather than like a control on a photograph.
    el.addEventListener('input', () => {
      grade = { ...grade, [key]: Number(el.value) || 1 };
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
    writeDials();
    paint();
  });
  dlg.addEventListener('close', () => { openId = ''; img!.removeAttribute('src'); });
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
  // The *original*, not the display copy. The copy is already cropped - it is
  // what the crop is applied to - so editing against it would compose each new
  // rectangle on top of the last and there would be no way back out to the full
  // frame. This is the one surface in the app that has to see the whole picture.
  img!.src = assetURL(it.asset!.hash) || '';
  img!.alt = it.name || '';
  writeDials();
  paint();
  dlg.showModal();
}

/** The three sliders, set from `grade`. The other direction is their listener. */
function writeDials() {
  for (const key of GRADE) {
    const el = dials[key];
    if (el) el.value = String(grade[key]);
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
  frame!.style.left = pc(rect.x);
  frame!.style.top = pc(rect.y);
  frame!.style.width = pc(rect.w);
  frame!.style.height = pc(rect.h);
  img!.style.filter =
    `brightness(${grade.brightness}) contrast(${grade.contrast}) saturate(${grade.saturation})`;
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
  const handle = (e.target.dataset.h || 'move') as Handle;
  // The drawn size of the picture, read once at the press. Every delta below is
  // divided by it to become a fraction, which is the only pixel measurement in
  // this module and the note at the top of the file says why it is here.
  const box = img!.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const from = { ...rect };
  const x0 = e.clientX;
  const y0 = e.clientY;
  e.preventDefault();
  frame!.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    const dx = (ev.clientX - x0) / box.width;
    const dy = (ev.clientY - y0) / box.height;
    rect = handle === 'move' ? moved(from, dx, dy) : resized(from, handle, dx, dy);
    paint();
  };
  const onUp = () => {
    frame!.removeEventListener('pointermove', onMove);
    frame!.removeEventListener('pointerup', onUp);
    frame!.removeEventListener('pointercancel', onUp);
  };
  frame!.addEventListener('pointermove', onMove);
  frame!.addEventListener('pointerup', onUp);
  frame!.addEventListener('pointercancel', onUp);
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
 * Two calls and therefore two history entries, which is the honest count: they
 * are two independent things about the picture, either may be unchanged, and
 * state.ts drops a write that changes nothing on its own. Folding them into one
 * entry would mean a Ctrl+Z after a session where only the crop moved still
 * announcing that it had put the grade back.
 */
function apply() {
  const id = openId;
  if (!id) return;
  const full = rect.x <= 0 && rect.y <= 0 && rect.w >= 1 && rect.h >= 1;
  setItemCrop(id, full ? null : rect);
  const neutral = GRADE.every(k => grade[k] === 1);
  setItemAdjust(id, neutral ? null : grade);
  dlg!.close();
}
