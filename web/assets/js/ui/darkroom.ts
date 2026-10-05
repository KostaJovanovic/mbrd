// The darkroom: crop, turn, mirror, grade and cut out one picture, together
// because they are one sitting. All five live in the item's meta and never
// touch the asset bytes, so Reset is exact and Ctrl+Z works like any other
// edit through state.ts. `rect` stays in source coordinates; toDisplay()/
// toSource() map to and from the turned, mirrored display.

import {
  byId, itemAdjust, itemCrop, itemFlip, itemMatte, itemRotate,
  setItemAdjust, setItemCrop, setItemFlip, setItemMatte, setItemRotate, MIN_CROP,
  isLocked, snapshotGeom, applyGeom, commitGeom, commit, lastCommand, takeBack,
} from '../state.ts';
import type { Command } from '../state.ts';
import { assetURL } from '../storage/assets.ts';
import { shownHash } from '../board-model.ts';
import { cutout, matteAvailable } from '../canvas/matte.ts';
import { surface } from '../canvas/surface.ts';
import { tickSlider } from './controls.ts';
import { ask } from './dialog.ts';

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
 * `x` is flip (left-right), `y` is flop (top-bottom) - ImageMagick's words,
 * reversed. Buttons spell out which way each turns, not just the term.
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
 * Two buttons rather than one that always steps forward, so undoing a turn is
 * one press and not three. Both are verbs, not toggles - no aria-pressed.
 */
const TURNS = [
  { id: 'dk-turn-l', by: 270 },
  { id: 'dk-turn-r', by: 90 },
] as const;
/** Clockwise, in degrees: 0, 90, 180 or 270. */
type Turn = 0 | 90 | 180 | 270;

/**
 * Long-edge size of the background-preview canvas, not the model's input
 * (that's a fixed 320x320, SIDE in canvas/matte.ts). Comfortably more than
 * the plate can draw; the card's real copy is made separately by
 * canvas/display.ts.
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
 * The pressed crop shape, as `data-ratio` spells it ('original', '4:5'), or
 * null for a free crop. Held through every grip drag until pressed again.
 */
let shape: string | null = null;
const shapeBtns: HTMLButtonElement[] = [];
/** The five edits as the picture had them when the dialog opened. */
let start: { rect: Rect, grade: Grade, flip: Flip, turn: Turn, matte: boolean } =
  { rect: { ...FULL }, grade: { ...NEUTRAL }, flip: { ...UNFLIPPED }, turn: 0, matte: false };
/** The discard question is up - a second Escape must not ask it twice. */
let leaving = false;
/**
 * What the background preview was last drawn from - every input the cut
 * depends on, joined into one string. paint() runs on every pointermove, so
 * an unchanged key skips re-running the model.
 */
let cutoutKey = '';
/**
 * Which cut-out run is current. Bumped by every paintCutout() call; a run
 * that finishes after the counter moved drops its mask instead of drawing it.
 */
let cutoutRun = 0;

/**
 * The eight handles, named the same as the board's own resize grips
 * (resizeHandleAction in canvas/input.ts) so `nw` means the same thing in both.
 */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = typeof HANDLES[number] | 'move';

export function initDarkroom() {
  // SAFETY: each id below is asserted only for its tag; each ref stays `| null`
  // and is tested, so a page without it (patch page, stripped build) leaves the
  // darkroom uninitialised instead of throwing.
  dlg = document.getElementById('darkroom') as HTMLDialogElement | null;
  if (!dlg) return;
  // SAFETY: as above - #darkroom-image is the <img> the crop is drawn over;
  // read via `img!` only after this assignment and the dialog guard.
  img = document.getElementById('darkroom-image') as HTMLImageElement | null;
  plate = document.getElementById('darkroom-plate');
  frame = document.getElementById('darkroom-frame');
  // SAFETY: as above - #darkroom-cutout is the <canvas> the background preview
  // is drawn on, and the null survives to every use below.
  cutCanvas = document.getElementById('darkroom-cutout') as HTMLCanvasElement | null;
  // Intrinsic ratio lets a quarter turn lay out without measuring (.dk-quarter
  // in dialog.css). Read on load, not open(): naturalWidth is still 0 right
  // after src is set.
  img?.addEventListener('load', () => { writeRatio(); paint(); });
  for (const key of GRADE) {
    // SAFETY: as above - `dk-brightness` and its two siblings are <input> in
    // index.html, null kept and tested rather than asserted away.
    const el = document.getElementById(`dk-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    dials[key] = el;
    // 'input', not 'change': the picture is the readout, not a form field.
    // 120 stops each, so tickSlider() declines all three (it judges, not us).
    tickSlider(el);
    el.addEventListener('input', () => {
      // `Number.isFinite`, not `Number(el.value) || 1`: 0 is a real value here
      // (saturation 0 = greyscale, the most-wanted grade), and `|| 1` treated
      // it as absent and snapped the dial back to neutral.
      const n = Number(el.value);
      grade = { ...grade, [key]: Number.isFinite(n) ? n : 1 };
      paint();
    });
  }
  // SAFETY: as above - `dk-cutout` is a <button> in index.html.
  cutBtn = document.getElementById('dk-cutout') as HTMLButtonElement | null;
  if (cutBtn) {
    // Hidden, not disabled, when the model can never run (no workers, no canvas
    // readback) - nothing the person could do about it, so don't mention it.
    // Checked once; the answer can't change while the page is open.
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
    // A toggle, not a verb: pressing twice puts it back. writeDials() writes
    // aria-pressed, so the button and `flip` can't disagree.
    el.addEventListener('click', () => {
      flip = { ...flip, [axis]: !flip[axis] };
      writeDials();
      paint();
    });
  }
  for (const { id, by } of TURNS) {
    document.getElementById(id)?.addEventListener('click', () => {
      // SAFETY: `turn` is 0/90/180/270 and `by` is 90 or 270 (TURNS above), so
      // the sum mod 360 is one of the same four - no negative wrap needed here
      // the way itemRotate() needs for a value read from a file.
      turn = ((turn + by) % 360) as Turn;
      // A held shape is a shape on screen, so a quarter turn fits it again.
      fitShape();
      writeRatio();
      paint();
    });
  }
  for (const el of dlg.querySelectorAll<HTMLButtonElement>('.dk-ratios [data-ratio]')) {
    shapeBtns.push(el);
    el.addEventListener('click', () => {
      shape = shape === el.dataset.ratio ? null : el.dataset.ratio || null;
      fitShape();
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
  document.getElementById('darkroom-close')?.addEventListener('click', () => void leave());
  document.getElementById('darkroom-cancel')?.addEventListener('click', () => void leave());
  // Escape: the browser's cancel, held back while there is something to lose.
  dlg.addEventListener('cancel', e => {
    if (!edited()) return;
    e.preventDefault();
    void leave();
  });
  document.getElementById('darkroom-apply')?.addEventListener('click', apply);
  // Reset puts every edit back to neutral in the dialog only, without writing -
  // Cancel still has to be able to leave the item untouched.
  document.getElementById('darkroom-reset')?.addEventListener('click', () => {
    rect = { ...FULL };
    grade = { ...NEUTRAL };
    flip = { ...UNFLIPPED };
    turn = 0;
    matte = false;
    shape = null;
    writeDials();
    writeRatio();
    paint();
  });
  // `img?.`, not `img!`: only `dlg` was null-checked above, so a page with the
  // dialog but no picture must still run the openId reset on close.
  dlg.addEventListener('close', () => { openId = ''; grabbing = false; img?.removeAttribute('src'); });
}

/**
 * Can this item be taken into the darkroom? Photographs only, with bytes on
 * this board. GIFs are excluded - cropping through a canvas would freeze the
 * animation. SVGs are excluded - they have no pixels to crop.
 */
export function canEditPicture(id: string): boolean {
  const it = byId(id);
  if (!it || it.type !== 'image' || !it.asset?.hash) return false;
  if (it.meta?.gif || String(it.meta?.ext || '').toLowerCase() === 'gif') return false;
  // shownHash(), not asset.hash: on a board written before the decoders, a
  // .heic or a .dng sits at asset.hash with the picture at meta.preview, and
  // reaching past that mounted the undecodable file itself - the darkroom
  // opened on a photograph and showed nothing at all.
  const shown = shownHash(it);
  return !!shown && !!assetURL(shown);
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
  shape = null;
  start = { rect: { ...rect }, grade: { ...grade }, flip: { ...flip }, turn, matte };
  // Clear both: any run in flight belongs to the last picture. Without the
  // key reset, a second opening shows the previous cut-out until something
  // moves; without the counter bump, a slow run from that picture could land
  // on this one.
  cutoutKey = '';
  cutoutRun++;
  // The *original*, not the display copy - the copy already has the crop/turn/
  // cutout applied, so editing against it would compose each new rectangle on
  // top of the last with no way back to the full frame. Original still means
  // the full-size picture and not the file: on an older board the file may be
  // a .heic or a .dng no engine here will draw. See canEditPicture().
  const shown = shownHash(it);
  img!.src = (shown ? assetURL(shown) : null) || '';
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
  // Same reasoning as the mirrors: a state, not an action, written once here.
  cutBtn?.setAttribute('aria-pressed', matte ? 'true' : 'false');
  for (const el of shapeBtns) {
    el.setAttribute('aria-pressed', el.dataset.ratio === shape ? 'true' : 'false');
  }
}

/** Whether anything differs from what the picture had when it opened. */
function edited(): boolean {
  if (!openId) return false;
  const r = start.rect;
  return rect.x !== r.x || rect.y !== r.y || rect.w !== r.w || rect.h !== r.h
    || GRADE.some(k => grade[k] !== start.grade[k])
    || flip.x !== start.flip.x || flip.y !== start.flip.y
    || turn !== start.turn || matte !== start.matte;
}

/**
 * Close, asking first when that would throw edits away. Apply is offered as
 * well, since a close that meant "done" is the likelier slip.
 */
async function leave() {
  if (!dlg?.open || leaving) return;
  if (!edited()) { dlg.close(); return; }
  leaving = true;
  const answer = await ask({
    title: 'Throw away these edits?',
    body: 'The picture goes back to how it was when you opened it.',
    go: 'Throw away',
    keep: 'Apply',
    cancel: 'Keep editing',
  });
  leaving = false;
  if (!dlg.open) return;
  if (answer === 'go') dlg.close();
  else if (answer === 'keep') apply();
}

/**
 * The frame, reshaped to the pressed shape: as large as the picture allows,
 * about the centre it had. In shown pixels, so 4:5 is 4:5 on screen after a
 * quarter turn. Original is the whole picture. Before the picture has decoded
 * there is no shape to measure, and the frame is left as it is.
 */
function fitShape() {
  if (!shape) return;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!nw || !nh) return;
  if (shape === 'original') { rect = { ...FULL }; return; }
  const [a, b] = shape.split(':').map(Number);
  if (!(a > 0) || !(b > 0)) return;
  const quarter = turn === 90 || turn === 270;
  const dw = quarter ? nh : nw;
  const dh = quarter ? nw : nh;
  // The shape in fractions of the shown picture: w/h there is (a/b) * dh/dw.
  const k = (a / b) * (dh / dw);
  const w = k >= 1 ? 1 : k;
  const h = k >= 1 ? 1 / k : 1;
  const d = toDisplay(rect);
  const cx = d.x + d.w / 2;
  const cy = d.y + d.h / 2;
  rect = fromDisplay({ x: clamp01(cx - w / 2, w), y: clamp01(cy - h / 2, h), w, h });
}

/**
 * The plate's shape, for a quarter turn. `.dk-quarter` swaps the layout and
 * `--dk-ar` is the turned ratio, both read only by dialog.css. A 180 is not a
 * quarter (same box), which is why `quarter` is never `!!turn`. The property
 * is removed rather than left stale when untouched.
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
 * A source rectangle as it is drawn: turned, then mirrored. Lets `rect` stay
 * in source coordinates while the frame sits over a picture standing on its
 * head. Clockwise turn: source (u, v) lands at (1-v, u) for a quarter right.
 * Mirror applies to the *turned* rectangle, matching paint()'s draw order.
 */
function toDisplay(r: Rect): Rect {
  return flipped(turned(r, turn));
}

/** toDisplay() undone: mirror first (it is its own inverse), then the turn back. */
function fromDisplay(d: Rect): Rect {
  // SAFETY: `turn` is one of the four quarters, so 360 - turn mod 360 is too.
  return turned(flipped(d), ((360 - turn) % 360) as Turn);
}

/** A rectangle turned clockwise by `by`. */
function turned(r: Rect, by: Turn): Rect {
  return by === 90 ? { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : by === 180 ? { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h }
      : by === 270 ? { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w }
        : r;
}

/** A rectangle mirrored on whichever axes `flip` names. */
function flipped(d: Rect): Rect {
  return {
    x: flip.x ? 1 - d.x - d.w : d.x,
    y: flip.y ? 1 - d.y - d.h : d.y,
    w: d.w,
    h: d.h,
  };
}

/**
 * A drag delta, mapped back through toSource(): the inverse of toDisplay()
 * with translation dropped. Undone mirror-first-then-turn, the opposite order
 * from how they're applied, which is what makes the pair truly inverse.
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
 * One function called after any change to any of them, since they share a
 * surface - a partial paint would show a crop of an ungraded photo.
 */
function paint() {
  const pc = (n: number) => `${(n * 100).toFixed(4)}%`;
  frame!.hidden = false;
  // Frame sits over the *displayed* (turned/mirrored) picture; `rect` stays in
  // source coordinates and goes through toDisplay() here, toSource() in
  // onGrab(). Keeps `meta.crop` meaning the same thing regardless of rotate/flip.
  const shown = toDisplay(rect);
  frame!.style.left = pc(shown.x);
  frame!.style.top = pc(shown.y);
  frame!.style.width = pc(shown.w);
  frame!.style.height = pc(shown.h);
  img!.style.filter =
    `brightness(${grade.brightness}) contrast(${grade.contrast}) saturate(${grade.saturation})`;
  // Only the picture transforms - the frame is a sibling, so its handles stay
  // put. Read right-to-left: turn happens first, mirror applied to the turned
  // picture, matching toDisplay()'s order. Built inline (not flipTransform())
  // so it exists at neutral too, or a flip-back would leave a stale transform.
  //
  // The centring translate applies only for a quarter turn (.dk-quarter takes
  // the picture out of flow - see dialog.css). Read off the class, not `turn`:
  // writeRatio() withholds the class until the picture has decoded, so a
  // cached picture opened at 90 doesn't get the translate before it's out of
  // flow and jump on load.
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
 * frame - same steps and order canvas/display.ts uses for the real copy, so
 * the preview can't disagree with it. The mirror happens here (not there)
 * because there's no CSS transform to carry it on a canvas.
 *
 * Fire-and-forget; every early exit hides the canvas so the plain <img> shows
 * through instead. `cutoutKey` skips re-asking the model the same question;
 * `cutoutRun` drops a stale answer - two different guards, one optimisation
 * and one correctness fix.
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
  // Everything the cut depends on. Grade is deliberately excluded: it's a
  // compositor filter over the canvas, same as over the <img>, so it can't
  // change a pixel the model saw.
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
  // Claimed before the await so a later run always wins on finish order. Key
  // claimed here too, so an identical request while this runs waits for it.
  const mine = ++cutoutRun;
  cutoutKey = key;
  // Busy mark goes on the dialog, not the button: the picture is what's
  // waiting. Button keeps its pressed state - that reflects the request, not
  // the result.
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
    // Mirror applied on the way in, not as a CSS transform on the element -
    // that would flip the checkerboard too, and the checkerboard is furniture.
    ctx.setTransform(flip.x ? -1 : 1, 0, 0, flip.y ? -1 : 1, flip.x ? dw : 0, flip.y ? dh : 0);
    ctx.drawImage(face.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    cv.hidden = false;
  });
}

/**
 * A press on the frame or one of its handles. One listener on the frame,
 * delegated by `data-h` - same pattern the board's own grips use. Pointer
 * capture lets the drag survive the pointer leaving the picture.
 */
function onGrab(e: PointerEvent) {
  if (!(e.target instanceof HTMLElement)) return;
  // One grab at a time: a second finger on the frame used to leave the first
  // press's onMove bound after both lifted, so the crop jumped on a later
  // pointermove with no button pressed.
  if (grabbing) return;
  grabbing = true;
  // SAFETY: `data-h` is written only by this module, one of HANDLES; missing
  // falls to 'move'. A bad value would just move rather than resize - wrong,
  // not broken.
  const handle = sourceHandle((e.target.dataset.h || 'move') as Handle);
  // Drawn size of the *plate*, not the picture: on a quarter turn the <img>'s
  // own box keeps its pre-turn shape while the plate is turned, so dividing by
  // the picture would be wrong by the aspect ratio. The one pixel measurement
  // in this module (see header for why).
  const box = (plate || img!).getBoundingClientRect();
  if (!box.width || !box.height) { grabbing = false; return; }
  const from = { ...rect };
  const x0 = e.clientX;
  const y0 = e.clientY;
  e.preventDefault();
  frame!.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    // Mapped through toSource(): the hand moves over the displayed picture but
    // `rect` is in source coordinates, so a drag right on a sideways picture
    // is a move down through the file.
    const [dx, dy] = toSource((ev.clientX - x0) / box.width, (ev.clientY - y0) / box.height);
    // Shift, or a pressed shape, holds the frame's proportions. Read per move,
    // so Shift can be pressed or let go partway through a drag.
    rect = handle === 'move' ? moved(from, dx, dy)
      : shape || ev.shiftKey ? kept(from, handle, dx, dy)
        : resized(from, handle, dx, dy);
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
 * A handle, named for the edge of the *source* it drives. On a mirrored axis
 * the visual-left grip is the source's right edge; on a quarter turn it's the
 * source's bottom. Two lookups here keep resized() itself turn-unaware.
 *
 * Undone mirror-first-then-turn, same order and reason as toSource(). The
 * mirror swap is per axis, not per handle.
 */
function sourceHandle(handle: Handle): Handle {
  if (handle === 'move') return handle;
  const swap: Record<string, string> = { w: 'e', e: 'w', n: 's', s: 'n' };
  const mirrored = [...handle].map(c =>
    ((flip.x && (c === 'w' || c === 'e')) || (flip.y && (c === 'n' || c === 's'))
      ? swap[c] : c));
  const spun = TURNED[turn] ? mirrored.map(c => TURNED[turn][c] || c) : mirrored;
  // SAFETY: both maps are closed over the four letters, so corners stay
  // corners. The sort normalizes order - a quarter turn takes 'nw' to 'ws',
  // which must still be spelled 'sw'.
  return spun.sort((a, b) => RANK(a) - RANK(b)).join('') as Handle;
}

/**
 * The frame slid, held inside the picture. Clamped, not stopped: dragging
 * past the edge parks it there, and a drag back comes straight off again.
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

/**
 * resized(), holding `from`'s proportions. Its fractions keep their ratio,
 * which keeps the shown one too, since a turn only swaps the two sides. A
 * corner follows whichever axis the hand moved further; an edge grip grows
 * the other side about its centre. Held inside the picture by scale, so the
 * frame stops at an edge rather than bending its shape against it.
 */
function kept(from: Rect, handle: Handle, dx: number, dy: number): Rect {
  const free = resized(from, handle, dx, dy);
  const across = handle.includes('e') || handle.includes('w');
  const along = handle.includes('n') || handle.includes('s');
  const sx = free.w / from.w;
  const sy = free.h / from.h;
  let s = across && along ? (Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy) : across ? sx : sy;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  // Room from the side that stays put, or about the centre for the free axis.
  const roomW = handle.includes('w') ? from.x + from.w
    : handle.includes('e') ? 1 - from.x : 2 * Math.min(cx, 1 - cx);
  const roomH = handle.includes('n') ? from.y + from.h
    : handle.includes('s') ? 1 - from.y : 2 * Math.min(cy, 1 - cy);
  s = Math.min(s, roomW / from.w, roomH / from.h);
  s = Math.max(s, MIN_CROP / from.w, MIN_CROP / from.h);
  const w = from.w * s;
  const h = from.h * s;
  return {
    x: handle.includes('w') ? from.x + from.w - w : handle.includes('e') ? from.x : cx - w / 2,
    y: handle.includes('n') ? from.y + from.h - h : handle.includes('s') ? from.y : cy - h / 2,
    w, h,
  };
}

/** A position held so that a box of size `size` stays inside 0..1. */
const clamp01 = (v: number, size: number) => Math.min(Math.max(0, v), 1 - size);

/**
 * Write every edit and close. Five separate calls, each its own entry as it
 * lands - state.ts drops writes that change nothing, so a crop-only session
 * doesn't claim it also touched the grade - and then folded into one, so a
 * sitting is one Ctrl+Z however many of the five it changed.
 */
function apply() {
  const id = openId;
  if (!id) return;
  const was = itemCrop(byId(id)) || { ...FULL };
  const wasTurn = itemRotate(byId(id)) || 0;
  const full = rect.x <= 0 && rect.y <= 0 && rect.w >= 1 && rect.h >= 1;
  asOneStep('Edit picture', [
    () => setItemCrop(id, full ? null : rect),
    () => setItemRotate(id, turn || null),
    // Card follows crop and turn, checked after both writes. Turn is in the
    // test because a quarter turn changes the card's shape without touching
    // `rect` at all - a crop-only check missed exactly that case.
    () => { if (was.w !== rect.w || was.h !== rect.h || wasTurn !== turn) refitCard(id); },
    () => setItemAdjust(id, GRADE.every(k => grade[k] === 1) ? null : grade),
    // Null rather than two falses, so flip-and-flip-again leaves no key.
    () => setItemFlip(id, flip.x || flip.y ? flip : null),
    () => setItemMatte(id, matte),
  ]);
  dlg!.close();
}

/**
 * Run each write, then put whatever entries they made back as one. A single
 * entry keeps its own label ("Crop" says more than "Edit picture"); two or
 * more are withdrawn top first and committed again together, the way an
 * Alt+drag folds its copy and its move (canvas/input.ts foldCopy()).
 */
function asOneStep(label: string, writes: (() => void)[]) {
  const made: Command[] = [];
  for (const write of writes) {
    const was = lastCommand();
    write();
    const now = lastCommand();
    if (now && now !== was) made.push(now);
  }
  if (made.length < 2) return;
  for (const cmd of [...made].reverse()) {
    // Something else on top: leave the entries as they are rather than fold
    // around it.
    if (!takeBack(cmd)) return;
  }
  commit(label,
    () => { for (const cmd of made) cmd.redo(); },
    () => { for (const cmd of [...made].reverse()) cmd.undo(); },
    made.reduce((sum, cmd) => sum + cmd.weight, 0));
}

/**
 * The card, reshaped to the crop and turn, holding the area it already
 * covered - without this a 16:9 slice of a square photo stayed letterboxed
 * inside a square card, throwing away the crop's whole point.
 *
 * **Area, not width or longer-side**: those quietly grow or shrink the card
 * on every crop, and only area makes a crop-and-reverse a round trip. Grown
 * about the centre, where the eye is. Written through applyGeom/fitOnto (see
 * layout.ts) so snap and undo are handled there. A locked card is left alone.
 */
function refitCard(id: string) {
  const it = byId(id);
  if (!it || isLocked(it)) return;
  const nw = img!.naturalWidth;
  const nh = img!.naturalHeight;
  if (!nw || !nh || !it.w || !it.h) return;
  // Crop proportions in source pixels - fractions alone don't say the shape
  // when the picture isn't square. Inverted for a quarter turn only (180
  // leaves shape alone, hence not `!!turn`).
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
