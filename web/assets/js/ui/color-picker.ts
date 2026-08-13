// Choosing a colour, without leaving the app to do it.
//
// The dialog this replaces was one `<input type="color">` in ask(), and it had
// the fault ask() itself was written to cure. That header says it plainly: a
// board set in whatever palette and whimsy level you chose should not be
// interrupted by a grey system box. But a colour input answers a click by
// opening the operating system's own picker - so the app drew its dialog, and
// the platform drew a second one on top of it, and the thing you actually chose
// the colour in was the box ask() exists to avoid. Worse than the original,
// because now there were two.
//
// So this is the same move canvas/notes.js made for writing a note, for the same
// reason and with the same shape: when the question is too big for one field,
// the answer is not a bigger field, it is the real control in a dialog of its
// own. ask() keeps its contract - one box, one string - and this keeps the
// picking.
//
// HSV rather than OKLCH, which is the one choice here that goes against the
// grain of the app. ui/pigments.js is perceptual throughout and it is right to
// be: it is *reading* colour off photographs, where the question is which two
// hues a picture is made of and a perceptual space is the only one that answers
// it honestly. This is the opposite job. Every colour in sRGB has to be
// reachable and no square inch of the control may be dead, and the HSV square is
// exactly the sRGB gamut with nothing outside it - an OKLCH plane at fixed hue
// has corners that are not colours, and they would have to be greyed out or
// silently clamped. A picker where part of the picture is a lie is worse than a
// picker in a less uniform space.
//
// Only touches `document` inside a function, so this module is importable
// without a browser like every other one here.

import { clamp } from '../util.ts';
// Only the six-digit parse, which is arithmetic and shared. The space this
// module works in is still HSV, for the reason the header gives.
import { parseHex } from '../color.ts';

/** A colour as this module holds it: hue in degrees, the other two in 0..1. */
type Hsv = { h: number, s: number, v: number };

/** What a caller may say about the question. Everything has a default. */
export type PickOptions = {
  title?: string,
  go?: string,
  cancel?: string,
  value?: string,
};

/** The one open at a time, if any. Two modal dialogs is two focus traps. */
let current: Promise<string | null> | null = null;

// ---------------------------------------------------------------------------
// The colour, as three numbers and as six digits
// ---------------------------------------------------------------------------

/**
 * HSV to `#rrggbb`, lowercase.
 *
 * `h` in degrees, `s` and `v` in 0..1. The form is the one canvas/renderers.js
 * demands of a swatch and the one `<input type="color">` will accept, so it is
 * produced here rather than anywhere the value passes through afterwards.
 */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  const rgb = hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  return '#' + rgb
    .map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * `#rrggbb` or `#rgb` to HSV, or null if it is not a colour.
 *
 * Null rather than a fallback, because the one caller that needs this is the
 * hex box being typed into, and "not yet a colour" is a different answer from
 * "grey". Half a hex is what a box looks like most of the time somebody is
 * using it, and moving the handle to grey on the way past `#f` would fight the
 * typing.
 */
export function hexToHsv(raw: unknown): Hsv | null {
  const s = String(raw ?? '').trim().toLowerCase();
  const full = /^#[0-9a-f]{6}$/.test(s) ? s
    : /^#[0-9a-f]{3}$/.test(s) ? '#' + s.slice(1).replace(/./g, c => c + c)
      : null;
  if (!full) return null;

  const [r, g, b] = parseHex(full).map(n => n / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    h = 60 * (max === r ? (((g - b) / d) % 6) : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

/**
 * Ask for a colour, and resolve to `#rrggbb` or to null.
 *
 * Null for every way out - Cancel, Escape, the backdrop - on the same reasoning
 * ask() gives for the same choice: whatever the accident was, it should not
 * leave something on the board.
 *
 * Without a document, or without the markup, this resolves to null rather than
 * throwing. A caller in a test asking for a colour and getting "none" is a
 * caller that adds nothing, which is the harmless half of every branch here.
 */
export async function pickColor(opts: PickOptions = {}): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  // #pick is the <dialog> in index.html. A cast rather than an instanceof
  // because the showModal test on the next line is the real guard and covers
  // one more case than an instanceof could: an engine with no HTMLDialogElement
  // at all, where the instanceof would be the thing that threw.
  const el = document.getElementById('pick') as HTMLDialogElement | null;
  if (!el || typeof el.showModal !== 'function') return null;

  while (current) await current;
  const done = openWith(el, {
    title: 'Add a colour', go: 'Add', cancel: 'Cancel', value: '#8a8a8a', ...opts,
  });
  current = done;
  try {
    return await done;
  } finally {
    current = null;
  }
}

function openWith(el: HTMLDialogElement, o: Required<PickOptions>) {
  // Every id here is inside the #pick dialog in index.html, and the two ranges
  // are <input>s there - the markup is what makes the assertions below true,
  // and a missing one is a broken build rather than a state to draw around.
  const title = document.getElementById('pick-title')!;
  const area = document.getElementById('pick-area')!;
  const dot = document.getElementById('pick-dot')!;
  const hue = document.getElementById('pick-hue') as HTMLInputElement;
  const hex = document.getElementById('pick-hex') as HTMLInputElement;
  const go = document.getElementById('pick-go')!;
  const cancel = document.getElementById('pick-cancel')!;

  title.textContent = o.title;
  go.textContent = o.go;
  cancel.textContent = o.cancel;

  // The three numbers are what this dialog holds, and the hex is a view of
  // them. That way round on purpose: hue and saturation do not survive a round
  // trip through a colour. Black is one point in sRGB and a whole face of the
  // HSV solid, so a picker that re-read its state from the hex would lose the
  // hue the moment you dragged to the bottom of the square, and dragging back
  // up would come out red however you got there.
  let { h, s, v } = hexToHsv(o.value) ?? { h: 0, s: 0, v: 0.54 };

  const paint = () => {
    const value = hsvToHex(h, s, v);
    // The hue at full strength is the square's own background; the two
    // gradients over it in the stylesheet do the rest.
    area.style.setProperty('--hue', String(Math.round(h)));
    area.style.setProperty('--picked', value);
    dot.style.left = s * 100 + '%';
    dot.style.top = (1 - v) * 100 + '%';
    area.setAttribute('aria-valuenow', String(Math.round(s * 100)));
    area.setAttribute('aria-valuetext',
      `${value}, saturation ${Math.round(s * 100)} percent, brightness ${Math.round(v * 100)} percent`);
    el.style.setProperty('--picked', value);
    return value;
  };

  const paintAll = () => {
    hue.value = String(Math.round(h));
    hex.value = paint().toUpperCase();
  };
  paintAll();

  return new Promise<string | null>(resolve => {
    let answer: string | null = null;
    // A drag that leaves the square still ends somewhere, and where it ends is
    // usually the dialog itself - which is the backdrop test below. Without
    // this, choosing a colour near the edge of the square and releasing past it
    // closes the dialog and throws the colour away.
    let dragged = false;

    const close = (choice: string | null) => { answer = choice; el.close(); };

    const atPointer = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      if (!r.width || !r.height) return;
      s = clamp((e.clientX - r.left) / r.width, 0, 1);
      v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
      hex.value = paint().toUpperCase();
    };

    const onDown = (e: PointerEvent) => {
      // The primary button only: a right-click inside the square is a context
      // menu, not a colour.
      if (e.button !== 0) return;
      dragged = true;
      area.setPointerCapture(e.pointerId);
      area.focus();
      atPointer(e);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => { if (area.hasPointerCapture(e.pointerId)) atPointer(e); };
    const onUp = (e: PointerEvent) => {
      if (area.hasPointerCapture(e.pointerId)) area.releasePointerCapture(e.pointerId);
      // Cleared after the click this release will generate, not before it.
      setTimeout(() => { dragged = false; }, 0);
    };

    // The square is one control holding two numbers, so the keyboard gets the
    // two axes it looks like: across for saturation, up for brightness. A
    // percent a press, ten with shift held - the same coarse/fine pair the
    // arrow keys move an item on the board by.
    const onAreaKey = (e: KeyboardEvent) => {
      const step = (e.shiftKey ? 0.1 : 0.01);
      const moves: Record<string, [number, number] | undefined> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
      };
      const d = moves[e.key];
      if (!d) return;
      s = clamp(s + d[0], 0, 1);
      v = clamp(v + d[1], 0, 1);
      hex.value = paint().toUpperCase();
      e.preventDefault();
    };

    const onHue = () => { h = Number(hue.value); hex.value = paint().toUpperCase(); };

    // Typed rather than pointed at, which is how a colour arrives when it came
    // from somewhere else - a brand sheet, a screenshot, a message. Anything
    // that is not yet a colour is left alone rather than corrected, so a half
    // typed value is not fought; what is in the box is put back in step on the
    // way out of it.
    const onHexInput = () => {
      const got = hexToHsv(hex.value);
      if (!got) return;
      ({ h, s, v } = got);
      hue.value = String(Math.round(h));
      paint();
    };
    const onHexBlur = () => { hex.value = hsvToHex(h, s, v).toUpperCase(); };

    const onGo = () => close(hsvToHex(h, s, v));
    const onCancel = () => close(null);
    const onClick = (e: MouseEvent) => { if (e.target === el && !dragged) close(null); };
    const onCancelEvent = () => { answer = null; };

    // Enter is the go button from anywhere in the panel except a button, which
    // already answers Enter by being pressed.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      close(hsvToHex(h, s, v));
    };

    const onClose = () => {
      area.removeEventListener('pointerdown', onDown);
      area.removeEventListener('pointermove', onMove);
      area.removeEventListener('pointerup', onUp);
      area.removeEventListener('pointercancel', onUp);
      area.removeEventListener('keydown', onAreaKey);
      hue.removeEventListener('input', onHue);
      hex.removeEventListener('input', onHexInput);
      hex.removeEventListener('blur', onHexBlur);
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('cancel', onCancelEvent);
      el.removeEventListener('close', onClose);
      resolve(answer);
    };

    area.addEventListener('pointerdown', onDown);
    area.addEventListener('pointermove', onMove);
    area.addEventListener('pointerup', onUp);
    area.addEventListener('pointercancel', onUp);
    area.addEventListener('keydown', onAreaKey);
    hue.addEventListener('input', onHue);
    hex.addEventListener('input', onHexInput);
    hex.addEventListener('blur', onHexBlur);
    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('cancel', onCancelEvent);
    el.addEventListener('close', onClose);

    el.showModal();
    // Focus lands on the square, because that is the whole of what this dialog
    // is for. Nothing here is destructive - ask() lands on Cancel for questions
    // where the difference between two buttons is a board, and this is not one.
    area.focus();
  });
}
