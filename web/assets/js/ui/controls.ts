// The panel's control shapes, built in one place.
//
// Every settings row in this app is the same three elements - a `label.field`,
// a head, and the control - and that shape was hand-built in four files that
// could not see each other: ui/panel.js for the sidebar, ui/appearance.js for
// the token dials it owns, ui/mobile-header.js twice for the masthead's axis
// sliders and its weight dial. Four copies of six lines is not expensive; four
// copies that can *drift* is, because the CSS pins the structure precisely
// (`.field > span` is the flex head, `.field output` is the readout, and
// `.field:has(select)` draws its own chevron), so a fifth site guessing the
// shape gets a row that is very nearly right.
//
// This is deliberately a builder and not a component. It makes the elements and
// hands them back; wiring, ids, values and events stay with the caller, because
// those are the parts that genuinely differ - the panel registers against a
// schema, appearance.js writes CSS custom properties, the masthead drives a
// variable font's axes. Only the box is shared.

/**
 * A control row: `label.field > span(head)`, with the control appended by the
 * caller.
 *
 * `out` asks for the readout on the right of the head, which is the ordinary
 * shape - a name at one end and its current value at the other, held apart by
 * the head's `justify-content: space-between`. Without it the head is the plain
 * label, which is what a dial whose stops are named underneath wants: whimsy
 * and quality read as words, and a number over them would be a second answer to
 * the same question.
 *
 * Returns the three pieces rather than one node, because every caller needs at
 * least two of them afterwards - the label to place or hide, the head to hang a
 * class on, the output to write into on every input event.
 */
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

/**
 * The names printed under a range's track.
 *
 * Not a `<datalist>`: Chromium ignores one on a custom-painted track, and
 * Firefox draws ticks whose two ends vanish into the rounded track. Names are
 * legible in a way ticks are not.
 *
 * `aria-hidden`, because a screen reader gets the same names off the thumb as
 * `aria-valuetext` - "Softish" rather than "1 of 3" - and hearing the whole
 * scale read out after every nudge is not the same information twice, it is
 * noise. The caller sets that; this marks the printed copy as decoration.
 *
 * `specimen` is for the scales whose names are examples of themselves: the
 * whimsy stops are set in the three tiers they name, the weight stops in the
 * weights. Given a stop it returns the CSS to wear, or nothing for a plain one.
 */
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

/**
 * Tick once per stop a slider crosses, for the sliders that have stops.
 *
 * The one place a range input is given a voice, and it exists because the
 * alternative was found the hard way: the panel's own builder grew this
 * behaviour inline, which covered the six controls that builder makes and
 * silently missed every slider wired by the module that owns it - Whimsy, the
 * palette count, the masthead's four, the volume, the hint card's dial. Six of
 * about fifteen. So it is a function, and every range input in the app is
 * handed to it.
 *
 * **It decides for itself whether a slider is the kind that ticks**, and that is
 * what makes "all of them" safe to say. A range fires `input` about sixty times
 * a second while a thumb is moving; on Whimsy that is three stops and three
 * ticks, and on the hue wheel it would be three hundred and sixty and a buzz.
 * The distinction a person is making when they say a slider feels *steppy* is
 * exactly the stop count, so that is what is measured - `(max - min) / step`,
 * over DETENT_MAX and it stays silent.
 *
 * Forty is the cut, which puts "Pictures used" (25 stops) and the masthead's
 * size dial (34) in, and the colour and darkroom sliders (100+) out. It is a
 * judgement about how fast a thumb crosses a stop rather than a fact about
 * anything, and the bench cannot help with it - a slider is dragged, not
 * pressed.
 */
const DETENT_MAX = 40;

export function tickSlider(input: HTMLInputElement | null | undefined): void {
  if (!input) return;
  const min = parseFloat(input.min || '0');
  const max = parseFloat(input.max || '100');
  const step = parseFloat(input.step || '1');
  const stops = step > 0 ? (max - min) / step : Infinity;
  if (!Number.isFinite(stops) || stops > DETENT_MAX) return;
  // The value it last spoke for, not the value it started at: a slider painted
  // from a stored preference must not tick on the way up.
  let ticked = input.value;
  input.addEventListener('input', () => {
    if (input.value === ticked) return;
    ticked = input.value;
    cue('pick');
  });
}
