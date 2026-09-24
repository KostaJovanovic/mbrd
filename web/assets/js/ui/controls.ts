// Shared control-row builder for the settings panel. Produces the label.field >
// span(head) + optional output structure the CSS expects. Wiring, ids, and
// events stay with the caller — only the box is shared, with the two slider
// behaviours every panel wants: the detent tick, and a touch that scrolls.

/** Build a control row. `out: true` adds a readout; returns pieces for the
 * caller to wire. */
import { cue } from '../cuelume/engine.ts';

/** The three pieces of a row, handed back for the caller to finish. */
export interface Field {
  label: HTMLLabelElement;
  head: HTMLSpanElement;
  /** Only when `out` was asked for; see the note above. */
  out: HTMLOutputElement | null;
}

export function field(labelText: string, { out: wantOut = false }: { out?: boolean } = {}): Field {
  const label = document.createElement('label');
  label.className = 'field';
  const head = document.createElement('span');
  let out: HTMLOutputElement | null = null;
  if (wantOut) {
    const text = document.createElement('span');
    text.textContent = labelText;
    out = document.createElement('output');
    // A space between the two, which the flex head does not render - a
    // whitespace-only anonymous flex item is dropped rather than laid out - but
    // which does come along when somebody selects the row and copies it.
    head.append(text, document.createTextNode(' '), out);
  } else {
    head.textContent = labelText;
  }
  label.append(head);
  return { label, head, out };
}

/** Named stops under a range track (not <datalist> — broken on custom tracks).
 * aria-hidden; screen reader gets names via aria-valuetext. `specimen` styles
 * each stop label (e.g. whimsy tiers set in their own tier). */
export function fieldStops<T extends string | { label: string }>(
  labels: readonly T[],
  { id = '', specimen = null }: {
    id?: string;
    /** Given a stop, the CSS it should wear - or nothing for a plain one. */
    specimen?: ((stop: T) => Partial<CSSStyleDeclaration> | null) | null;
  } = {},
): HTMLSpanElement {
  const stops = document.createElement('span');
  stops.className = 'field-stops';
  if (id) stops.id = id;
  stops.setAttribute('aria-hidden', 'true');
  for (const stop of labels) {
    const span = document.createElement('span');
    span.textContent = typeof stop === 'string' ? stop : stop.label;
    const style = specimen?.(stop);
    if (style) Object.assign(span.style, style);
    stops.append(span);
  }
  return stops;
}

/** Wire a 'pick' tick on each stop crossing. Self-limits: sliders with more
 * than DETENT_MAX stops stay silent (continuous sliders would buzz). */
const DETENT_MAX = 40;

/** The thumb's width in sidebar.css: the track it travels is the input less this. */
const THUMB = 15;
/** How far a finger goes sideways before a slider takes it. */
const SLOP = 8;

/**
 * Drive a scrolling panel's sliders where the pointer is coarse. Chrome's range
 * input moves its thumb to wherever a touch lands, the first touch of a scroll
 * included, so there sidebar.css takes the input out of hit testing and this
 * moves it instead. Nothing changes until the finger goes sideways, and then
 * the value moves as far as the finger does, from where it was. A vertical
 * start is the panel's, and scrolls. A mouse still sets what it points at.
 * `onDrag` hears when a drag takes a slider.
 */
export function touchSliders(root: HTMLElement, onDrag: (input: HTMLInputElement, pointerId: number) => void): void {
  root.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    // SAFETY: the listener is on root, so the target is an element under it.
    const row = (e.target as Element).closest?.('.field');
    const input = row?.querySelector<HTMLInputElement>(':scope > input[type="range"]');
    if (!input || input.disabled || getComputedStyle(input).pointerEvents !== 'none') return;
    const min = parseFloat(input.min || '0');
    const max = parseFloat(input.max || '100');
    const box = input.getBoundingClientRect();
    const travel = box.width - THUMB;
    if (!(max > min) || travel <= 0) return;

    const id = e.pointerId;
    const before = input.value;
    const startY = e.clientY;
    let fromX = e.clientX;
    let from = +input.value;
    let dragging = false;

    const set = (value: number) => {
      const was = input.value;
      // The element clamps and snaps to its step.
      input.value = String(value);
      if (input.value !== was) input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const take = (x: number) => {
      dragging = true;
      fromX = x;
      from = +input.value;
      root.setPointerCapture?.(id);
      onDrag(input, id);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - fromX;
      if (!dragging) {
        if (Math.abs(dx) >= SLOP && Math.abs(dx) > Math.abs(ev.clientY - startY)) take(ev.clientX);
        return;
      }
      set(from + (dx / travel) * (max - min));
    };
    const stop = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', stop);
      globalThis.removeEventListener('pointercancel', stop);
      if (input.value !== before) input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', stop);
    globalThis.addEventListener('pointercancel', stop);

    if (e.pointerType === 'mouse') {
      e.preventDefault();
      const at = Math.min(1, Math.max(0, (e.clientX - box.left - THUMB / 2) / travel));
      set(min + at * (max - min));
      take(e.clientX);
    }
  });
}

export function tickSlider(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  const min = parseFloat(input.min || '0');
  const max = parseFloat(input.max || '100');
  const step = parseFloat(input.step || '1');
  const stops = step > 0 ? (max - min) / step : Infinity;
  if (!Number.isFinite(stops) || stops > DETENT_MAX) return;
  // Start at current value — don't tick when painted from a stored pref.
  let ticked = input.value;
  input.addEventListener('input', () => {
    if (input.value === ticked) return;
    ticked = input.value;
    cue('pick');
  });
}
