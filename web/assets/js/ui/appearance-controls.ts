// The Look tab's controls: the rows, their wiring, and keeping them in step
// with the look.
//
// Lifted out of ui/appearance.js, which was 1,261 lines of two things - the
// look *model* (what a look is, how it is applied, stored and derived from
// pictures) and the *panel* that drives it. They read as two halves and are
// not: the controls reached upward for thirteen names and the model reached
// back down for eleven, so this could not be a move. It is a seam.
//
// The seam is `d`, below. Everything this module needs from the look model
// arrives through initAppearanceControls() rather than by import, which is what
// keeps the arrow pointing one way - ui/appearance.js imports this, and this
// imports nothing of it. `current` comes through as a *getter* because the
// model reassigns it (a board arriving replaces the whole look), so a captured
// reference would go stale the first time a .mbrd was opened.
//
// Two things not to move back. `toHex()` lives here because the only thing that
// needs #rrggbb is `<input type="color">`, which is a control. And the panel is
// built once and repainted, never rebuilt - ui/appearance.js and ui/sidebar.js
// hold their nodes, so a rebuild would hand them elements nothing is listening
// to.

import { board, setSetting } from '../state.ts';
import { appearanceControlVisible } from '../layout-settings.ts';
import { clamp } from '../util.ts';
import { customFaces } from './fonts.ts';
import { field } from './controls.ts';
import { pickColor } from './color-picker.ts';

// Not `document.documentElement` at module scope: this file must import without
// a browser (tests/imports.test.js), and ui/appearance.js is already one of the
// three modules exempt from that. A fourth would be a regression, so the root
// element is taken when the panel is initialised instead - which is after the
// document exists by definition.
let ROOT: HTMLElement | null = null;

/** One face on the two font menus: the stack to write, and what to call it. */
export type FaceOption = { value: string, label: string };

/**
 * A row of the Look tab, in the three shapes it comes in.
 *
 * A union rather than one object with everything optional, because the three
 * are genuinely different controls: only a range has a step to round its
 * readout to, and only a font row has a list to choose from. The table itself
 * lives in ui/appearance.js - this is the shape it hands over.
 */
export type FontControl = { var: string, label: string, host: string, type: 'font', options: readonly FaceOption[] };
export type ColorControl = { var: string, label: string, host: string, type: 'color' };
export type RangeControl = {
  var: string, label: string, host: string, type: 'range',
  min: number, max: number, step: number, unit?: string,
};
export type ControlSpec = FontControl | ColorControl | RangeControl;

/**
 * The look, as the panel reads it back. See ui/appearance.js, which owns it -
 * the type lives here because the arrow between the two modules only points
 * that way.
 *
 * `auto` and `derived` are provenance rather than appearance: whether the
 * extraction is switched on, and whether what is in `vars` was the machine's
 * work. Both are absent on a look that has never said either - see
 * withProvenance() there - which is why they are optional rather than false.
 */
export type Look = {
  whimsy: number,
  palette: string,
  vars: Record<string, string>,
  auto?: boolean,
  derived?: boolean,
};

/**
 * What this module borrows from the look model. Filled by
 * initAppearanceControls(); every reference below goes through it.
 */
export type LookDeps = {
  CONTROLS: readonly ControlSpec[],
  HOSTS: Record<string, string>,
  WHIMSY: readonly string[],
  ALL_SOURCES_STOP: number,
  current: () => Look,
  setVar: (name: string, value: string) => void,
  setWhimsy: (level: number | string) => void,
  setPalette: (name: string) => void,
  goDynamic: () => void,
  sourceCount: () => number,
  dynamicOn: () => boolean,
};

// Declared rather than initialised: initAppearanceControls() fills it before
// anything here can run, and the assertion says so once so that every use below
// reads `d.x` plainly. Two tests match those reads as source text - the seam is
// the thing they are checking - and a `!` at each of them would be noise in the
// file as well as a break in the assertion.
let d!: LookDeps;

/** Hand the controls what they need from the look model. Called once, first. */
export function initAppearanceControls(deps: LookDeps) {
  d = deps;
  ROOT = document.documentElement;
}

/** Every row this module built, by the token it writes. */
type Row = {
  input: HTMLSelectElement | HTMLButtonElement | HTMLInputElement,
  out: HTMLOutputElement,
  label: HTMLLabelElement,
  spec: ControlSpec,
};
export const inputs = new Map<string, Row>();

/**
 * The palette menu's entry for "take the colours from the pictures".
 *
 * A mode rather than a colour, and deliberately not a palette name: it is never
 * written to `look.palette`, and no [data-palette] block in tokens.css answers
 * to it. The menu shows it whenever the board is actually wearing extracted
 * pigments - dynamicOn() in ui/appearance.js - so the row reads as the state the
 * board is in rather than as a button somebody once pressed.
 *
 * The same string is the option's value in ui/settings-schema.js, which is data
 * and imports nothing from here; tests/settings-panel.test.js holds the two
 * together, the same bargain as the source dial's top stop.
 */
export const DYNAMIC = 'dynamic';

export function buildControls() {
  const hosts: Record<string, HTMLElement> = {};
  for (const [name, id] of Object.entries(d.HOSTS)) {
    const node = document.getElementById(id);
    if (node) { node.replaceChildren(); hosts[name] = node; }
  }
  if (!Object.keys(hosts).length) return;
  // The map goes with the nodes it names. Every host above was just emptied, so
  // every row this map held is now a detached element - and a rebuild that
  // filed fewer rows than the last one (a host that has gone, a control the
  // table dropped) left the missing ones pointing at nodes no longer in the
  // document, which syncControls() and paintPigment() then paint for nobody.
  inputs.clear();

  for (const c of d.CONTROLS) {
    const host = hosts[c.host];
    if (!host) continue;
    // `out: true` is what makes the output element there to write into.
    const { label, out } = field(c.label, { out: true });

    // A <select> for a face (a choice from a list), a swatch button for a colour
    // (the app's own picker, not the OS one), a range for everything else.
    //
    // **The <select> stays a <select>, and that is a decision rather than an
    // omission.** Every other dropdown-shaped control in this app has been
    // asked whether it should become a button opening ui/menu.ts, and two
    // answered yes - the palette picker, because no browser paints a colour
    // inside a native option, and the note toolbar's face, because a native
    // dropdown took focus out of an editor that must not lose it. Neither
    // argument applies here.
    //
    // What does apply is the other side of the ledger. This list is *unbounded*:
    // the shipped faces plus one entry per font file dropped on the board. A
    // native select gives it type-ahead, Home and End, a real listbox announced
    // as one, and on a phone the platform's own wheel - which is a better way
    // through forty faces than a panel scrolling inside an already-scrolling
    // sheet. ui/menu.ts has the first two now and still announces itself as a
    // menu rather than a listbox, so converting this would cost accessibility
    // to buy consistency. See the same note in ui/settings-schema.ts.
    let input: HTMLSelectElement | HTMLButtonElement | HTMLInputElement;
    if (c.type === 'font') {
      input = document.createElement('select');
      // The board's own faces first, above the shipped list: a face somebody
      // went and dropped in is the one they are looking for, and burying it
      // under six they did not choose is how a feature reads as missing.
      const faces = [...c.options];
      const own = customFaces();
      if (own.length) faces.splice(1, 0, ...own);
      for (const f of faces) {
        const opt = document.createElement('option');
        opt.value = f.value;
        opt.textContent = f.label;
        // Each name set in the face it names, so the list is the comparison
        // rather than a legend for one. Costs nothing: every stack here is
        // already loaded or already on the machine.
        if (f.value && !f.value.startsWith('var(')) opt.style.fontFamily = f.value;
        input.append(opt);
      }
      input.addEventListener('change', () => d.setVar(c.var, input.value));
    } else if (c.type === 'color') {
      // A swatch that opens pickColor() - the same modal every other colour choice
      // in the app uses (commands.js addSwatch), rather than the native
      // <input type="color"> that reads as a different app's control on the glass.
      input = document.createElement('button');
      input.type = 'button';
      input.className = 'pigment-swatch';
      input.addEventListener('click', async () => {
        const raw = (d.current().vars[c.var] ?? getComputedStyle(ROOT!).getPropertyValue(c.var)).trim();
        const picked = await pickColor({ title: 'Pigment', value: toHex(raw) || '#000000' });
        if (picked) d.setVar(c.var, picked);
      });
    } else {
      input = document.createElement('input');
      input.type = 'range';
      // The three are numbers in the table and strings on the element; the
      // conversion was the assignment's own before it was written down.
      input.min = String(c.min); input.max = String(c.max); input.step = String(c.step);
      input.addEventListener('input', () => {
        out!.textContent = format(input.value, c);
        d.setVar(c.var, input.value + (c.unit || ''));
      });
    }

    label.append(input);
    host.append(label);
    inputs.set(c.var, { input, out: out!, label, spec: c });
  }
  syncControls();
}

export function syncControlVisibility() {
  for (const [name, { label }] of inputs) {
    label.hidden = !appearanceControlVisible(name, board.layoutMode);
  }
}

export function syncControls() {
  syncControlVisibility();
  const computed = getComputedStyle(ROOT!);
  for (const [name, { input, out, spec }] of inputs) {
    const raw = (d.current().vars[name] ?? computed.getPropertyValue(name)).trim();
    if (spec.type === 'font') {
      // Read off `d.current().vars` alone, never off the computed value. The
      // computed one is whatever the whimsy level resolved to, which is a stack
      // that matches no option here and would select nothing - where '' is a
      // real state with a real entry: the level still has the type.
      input.value = d.current().vars[name] ?? '';
      out.textContent = '';
    } else if (spec.type === 'color') {
      // The swatch shows the current pigment as its fill; the picker is a modal, so
      // there is no mid-drag value to guard against the way the native input had.
      input.style.background = toHex(raw) || '#000000';
      out.textContent = '';
    } else {
      const n = parseFloat(raw);
      input.value = String(Number.isFinite(n) ? n : spec.min);
      out.textContent = format(input.value, spec);
    }
  }
  // #opt-whimsy is the Look tab's `type: 'range'` control in
  // ui/settings-schema.js, so the schema renders it as an <input> - the same
  // element wireWhimsy() below writes a max onto.
  const whimsy = document.getElementById('opt-whimsy') as HTMLInputElement | null;
  if (whimsy) whimsy.value = String(d.current().whimsy);

  syncPaletteMode();
}

/**
 * The palette menu and the dial under it, without touching anything else.
 *
 * Its own function because d.setVar() can knock the board out of Dynamic - a
 * hand-picked pigment is a decision about the same thing - and must not run the
 * full sync to say so. syncControls() writes every control's value back from the
 * look, including the colour input that is mid-drag when this fires, and a
 * colour picker being assigned to while the pointer is down is how you get a
 * value that jumps back a frame after each move.
 */
export function syncPaletteMode() {
  const dynamic = d.dynamicOn();
  // #opt-palette is the schema's `type: 'picker'` control - a button that opens
  // ui/menu.ts, not a <select>. Its value is an attribute rather than a property
  // and ui/panel.ts's paintPicker() is what reads it back onto the face.
  const el = document.getElementById('opt-palette');
  // The value is an attribute rather than a property, and the face is repainted
  // by dispatching to the builder that owns it. A direct paintPicker() call from
  // here would be this module importing ui/panel.ts, which imports
  // ui/settings-schema.ts, which imports the palette chips - a ring. The event
  // keeps the arrow pointing one way; ui/panel.ts listens for it.
  if (el) {
    el.dataset.value = dynamic ? DYNAMIC : (d.current().palette || '');
    el.dispatchEvent(new CustomEvent('repaint'));
  }
  // The source-count dial only means anything while the pictures are what the
  // board is painted from - anywhere else it is a dial over a palette that reads
  // no picture at all - so it comes down with the mode rather than sitting there
  // inert.
  const field = document.getElementById('palette-sources-field');
  if (field) field.hidden = !dynamic;
  syncPaletteSources();
}

/** The slider showing its own value, and the count it reflects. */
export function syncPaletteSources() {
  // Another `type: 'range'` from the schema, and its readout beside it.
  const input = document.getElementById('opt-palette-sources') as HTMLInputElement | null;
  const out = document.getElementById('opt-palette-sources-out');
  const n = d.sourceCount();
  const all = n === Infinity;
  if (input && document.activeElement !== input) {
    input.value = String(all ? d.ALL_SOURCES_STOP : n);
  }
  if (!out) return;
  // Named rather than counted at the top stop, and the count of what is on the
  // board is deliberately not printed: it would change under you every time a
  // picture arrived, in a readout nobody is watching for that.
  out.textContent = all ? 'Every photo' : `${n} photo${n === 1 ? '' : 's'}`;
}

export function wirePaletteSources() {
  const input = document.getElementById('opt-palette-sources') as HTMLInputElement | null;
  if (!input) return;
  input.max = String(d.ALL_SOURCES_STOP);
  input.value = String(d.sourceCount() === Infinity ? d.ALL_SOURCES_STOP : d.sourceCount());
  input.addEventListener('input', () => {
    const n = +input.value;
    setSetting('paletteSources', n >= d.ALL_SOURCES_STOP ? 0 : n);
  });
  syncPaletteSources();
}

export function wireWhimsy() {
  const input = document.getElementById('opt-whimsy') as HTMLInputElement | null;
  if (!input) return;
  input.max = String(d.WHIMSY.length - 1);
  input.value = String(d.current().whimsy);
  input.addEventListener('input', () => d.setWhimsy(input.value));
}

function format(value: string, spec: RangeControl) {
  const n = parseFloat(value);
  // Match the readout's precision to the slider's step, so a 0.1px grid weight
  // doesn't display as a flat "2px" through its whole range.
  const decimals = spec.step >= 1 ? 0 : String(spec.step).split('.')[1].length;
  return n.toFixed(decimals) + (spec.unit || '');
}

/**
 * The one control that answers "what colour is this board?".
 *
 * Four named palettes and Dynamic, which is the pictures on the board. They were
 * a menu and a checkbox below it in the fold, and that was one decision written
 * down twice - a board is set in Papyrus or in Absinthe or in its own
 * photographs, and being asked to name a palette and then to say whether it
 * counts is a question with a wrong answer in it.
 *
 * Both branches drop every pigment the look is carrying and both mark the look
 * accordingly, which is why neither happens here: they are the look model's, in
 * ui/appearance.js, and each runs its own sync on the way out.
 */
export function wirePalette() {
  // The picker is a button, not a <select>: an <option> cannot paint a swatch
  // in any browser, and this row's whole job is to show what each palette looks
  // like. ui/panel.ts's buildPicker draws it and gives it this listener's event.
  const el = document.getElementById('opt-palette');
  if (!el) return;
  el.addEventListener('pick', e => {
    const value = (e as CustomEvent<string>).detail;
    if (value === DYNAMIC) d.goDynamic();
    else d.setPalette(value);
  });
}

/**
 * Normalise whatever the browser reports for a colour token into #rrggbb, which
 * is the only thing <input type="color"> accepts.
 */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  // Plain numeric channels only. `rgb(100%, 0%, 0%)` is legal CSS and passes
  // SAFE_VALUE, and `.map(Number)` turned every one of those into NaN, which
  // clamp255() then turned into 0 - so a percentage form silently painted the
  // swatch black and opened the picker on black instead of on red. A form this
  // branch cannot read falls through to the canvas below, which reads all of
  // them.
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m && !m[1].includes('%')) {
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    if ([r, g, b].every(Number.isFinite)) {
      return '#' + [r, g, b].map(n => clamp255(n).toString(16).padStart(2, '0')).join('');
    }
  }
  // color(), oklch(), a named colour: round-trip it through a canvas.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    // No 2d context is the same answer as an unparseable colour, and it was
    // already reached the same way: the throw on the next line landed in the
    // catch below and returned null.
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    // A gradient or a pattern can come back out of fillStyle, but only if one
    // went in; what went in is the string above.
    const out = ctx.fillStyle;
    return typeof out === 'string' && /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

const clamp255 = (n: number) => clamp(Math.round(n || 0), 0, 255);
