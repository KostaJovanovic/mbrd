// Shared control-row builder for the settings panel. Produces the label.field >
// span(head) + optional output structure the CSS expects. Wiring, ids, and
// events stay with the caller — only the box is shared.

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
