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

import { board, setSetting } from '../state.js';
import { appearanceControlVisible } from '../layout-settings.js';
import { clamp } from '../util.js';
import { customFaces } from './fonts.js';
import { field } from './controls.js';

// Not `document.documentElement` at module scope: this file must import without
// a browser (tests/imports.test.js), and ui/appearance.js is already one of the
// three modules exempt from that. A fourth would be a regression, so the root
// element is taken when the panel is initialised instead - which is after the
// document exists by definition.
let ROOT = null;

/**
 * What this module borrows from the look model. Filled by
 * initAppearanceControls(); every reference below goes through it.
 *
 * @type {{
 *   CONTROLS: Array<object>, HOSTS: Record<string, string>,
 *   WHIMSY: string[], ALL_SOURCES_STOP: number,
 *   current: () => object,
 *   setVar: (name: string, value: string) => void,
 *   setWhimsy: (level: number|string) => void,
 *   setPalette: (name: string) => void, goDynamic: () => void,
 *   sourceCount: () => number, dynamicOn: () => boolean,
 * }}
 */
let d = /** @type {any} */ (null);

/** Hand the controls what they need from the look model. Called once, first. */
export function initAppearanceControls(deps) {
  d = deps;
  ROOT = document.documentElement;
}

export const inputs = new Map();

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
  const hosts = {};
  for (const [name, id] of Object.entries(d.HOSTS)) {
    const node = document.getElementById(id);
    if (node) { node.replaceChildren(); hosts[name] = node; }
  }
  if (!Object.keys(hosts).length) return;

  for (const c of d.CONTROLS) {
    const host = hosts[c.host];
    if (!host) continue;
    const { label, out } = field(c.label, { out: true });

    // A <select> rather than an <input>, and 'change' rather than 'input',
    // because a face is a choice from a list and not a value on a scale.
    const input = c.type === 'font' ? document.createElement('select')
                                    : document.createElement('input');
    if (c.type === 'font') {
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
    } else {
      input.type = c.type === 'color' ? 'color' : 'range';
      if (c.type === 'range') {
        input.min = c.min; input.max = c.max; input.step = c.step;
      }
      input.addEventListener('input', () => {
        const value = c.type === 'color' ? input.value : input.value + (c.unit || '');
        out.textContent = c.type === 'color' ? '' : format(input.value, c);
        d.setVar(c.var, value);
      });
    }

    label.append(input);
    host.append(label);
    inputs.set(c.var, { input, out, label, spec: c });
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
  const computed = getComputedStyle(ROOT);
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
      input.value = toHex(raw) || '#000000';
      out.textContent = '';
    } else {
      const n = parseFloat(raw);
      input.value = Number.isFinite(n) ? n : spec.min;
      out.textContent = format(input.value, spec);
    }
  }
  const whimsy = document.getElementById('opt-whimsy');
  if (whimsy) whimsy.value = d.current().whimsy;

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
  const sel = document.getElementById('opt-palette');
  if (sel) sel.value = dynamic ? DYNAMIC : (d.current().palette || '');
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
  const input = document.getElementById('opt-palette-sources');
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
  const input = document.getElementById('opt-palette-sources');
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
  const input = document.getElementById('opt-whimsy');
  if (!input) return;
  input.max = d.WHIMSY.length - 1;
  input.value = d.current().whimsy;
  input.addEventListener('input', () => d.setWhimsy(input.value));
}

function format(value, spec) {
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
  const sel = document.getElementById('opt-palette');
  if (!sel) return;
  sel.value = d.dynamicOn() ? DYNAMIC : (d.current().palette || '');
  sel.addEventListener('change', () => {
    if (sel.value === DYNAMIC) d.goDynamic();
    else d.setPalette(sel.value);
  });
}

/**
 * Normalise whatever the browser reports for a colour token into #rrggbb, which
 * is the only thing <input type="color"> accepts.
 */
export function toHex(value) {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    return '#' + [r, g, b].map(n => clamp255(n).toString(16).padStart(2, '0')).join('');
  }
  // color(), oklch(), a named colour: round-trip it through a canvas.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    const out = ctx.fillStyle;
    return /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

const clamp255 = n => clamp(Math.round(n || 0), 0, 255);
