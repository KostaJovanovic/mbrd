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
 *   current: () => object, apply: (look: object) => void, persist: () => void,
 *   setVar: (name: string, value: string) => void,
 *   setWhimsy: (level: number|string) => void,
 *   setAutoPalette: (on: boolean) => void,
 *   sourceCount: () => number, autoOn: (look: object) => boolean,
 * }}
 */
let d = /** @type {any} */ (null);

/** Hand the controls what they need from the look model. Called once, first. */
export function initAppearanceControls(deps) {
  d = deps;
  ROOT = document.documentElement;
}

export const inputs = new Map();

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
  const paletteSel = document.getElementById('opt-palette');
  if (paletteSel) paletteSel.value = d.current().palette || '';

  const whimsy = document.getElementById('opt-whimsy');
  if (whimsy) whimsy.value = d.current().whimsy;

  syncAutoBox();
}

/**
 * The switch on its own, because d.setVar() can turn it off and must not run the
 * full sync to say so.
 *
 * syncControls() writes every control's value back from the look, including the
 * colour input that is mid-drag when this fires - and a colour picker being
 * assigned to while the pointer is down is how you get a value that jumps back
 * a frame after each move. The checkbox is the only thing that changed, so the
 * checkbox is the only thing rewritten.
 */
export function syncAutoBox() {
  const box = document.getElementById('opt-auto-palette');
  if (box) box.checked = d.autoOn(d.current());
  // The source-count dial only means anything while the switch is on - with it
  // off the palette is the chosen one and no picture is read - so it comes down
  // with the switch rather than sitting there inert.
  const field = document.getElementById('palette-sources-field');
  if (field) field.hidden = !d.autoOn(d.current());
  syncPaletteSources();
}

export function wireAutoPalette() {
  const input = document.getElementById('opt-auto-palette');
  if (!input) return;
  input.checked = d.autoOn(d.current());
  input.addEventListener('change', () => d.setAutoPalette(input.checked));
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

export function wirePalette() {
  const sel = document.getElementById('opt-palette');
  if (!sel) return;
  sel.value = d.current().palette || '';
  sel.addEventListener('change', () => {
    // A palette switch replaces the pigments wholesale, so per-token colour
    // tweaks are dropped - otherwise the old accent would stick to the new
    // paper and every palette after the first would look muddy.
    //
    // Two of them when they were hand-picked, because those are the two the
    // panel offers and dropping more would throw away something the user cannot
    // see to put back. All thirteen when they were extracted from photographs,
    // because a derived look is not a set of tweaks to keep on top of a chosen
    // palette - it *is* a palette, and leaving eleven of its tokens inline
    // would leave the named one outvoted on its own sheet.
    for (const key of d.current().derived ? Object.keys(d.current().vars) : ['--accent', '--paper']) {
      delete d.current().vars[key];
      ROOT.style.removeProperty(key);
    }
    delete d.current().derived;
    // Choosing a palette by name is a decision about colour, and it takes the
    // switch with it for the same reason picking a pigment by hand does - see
    // d.setVar(). This is also the way back from an extracted palette: it is the
    // one control that drops all fourteen tokens at once.
    d.current().auto = false;
    d.current().palette = sel.value;
    d.apply(d.current());
    d.persist();
    syncControls();   // computed colours changed under us
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
