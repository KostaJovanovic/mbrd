// Look tab controls: rows, wiring, sync with the look model.
// All deps arrive via initAppearanceControls() — this imports nothing from
// ui/appearance.ts, keeping the arrow one way. `current` is a getter because
// a board load replaces the whole look object.

import { board, setSetting } from '../state.ts';
import { appearanceControlVisible } from '../layout-settings.ts';
import { clamp } from '../util.ts';
import { customFaces } from './fonts.ts';
import { field, tickSlider } from './controls.ts';
import { pickColor } from './color-picker.ts';

// Deferred to init time so this module imports without a browser.
let ROOT: HTMLElement | null = null;

/** A font-family stack and its display name. */
export type FaceOption = { value: string, label: string };

/** Look-tab row spec. Union because each control shape has distinct fields. */
export type FontControl = { var: string, label: string, host: string, type: 'font', options: readonly FaceOption[] };
export type ColorControl = { var: string, label: string, host: string, type: 'color' };
export type RangeControl = {
  var: string, label: string, host: string, type: 'range',
  min: number, max: number, step: number, unit?: string,
};
export type ControlSpec = FontControl | ColorControl | RangeControl;

/** The look as the panel reads it. Type lives here to keep the import arrow one-way. */
export type Look = {
  whimsy: number,
  palette: string,
  vars: Record<string, string>,
  auto?: boolean,
  derived?: boolean,
};

/** Deps injected by initAppearanceControls(). */
export type LookDeps = {
  CONTROLS: readonly ControlSpec[],
  HOSTS: Record<string, string>,
  WHIMSY: readonly string[],
  ALL_SOURCES_STOP: number,
  ALL_SOURCES_MAX: number,
  current: () => Look,
  setVar: (name: string, value: string) => void,
  setWhimsy: (level: number | string) => void,
  setPalette: (name: string) => void,
  goDynamic: () => void,
  sourceCount: () => number,
  dynamicOn: () => boolean,
};

// Filled by initAppearanceControls() before any use.
let d!: LookDeps;

// Nullable because the tab may not be built yet.
const rangeInput = (id: string) => document.getElementById(id) as HTMLInputElement | null;

/** Wire up the look-model deps. Called once at boot. */
export function initAppearanceControls(deps: LookDeps) {
  d = deps;
  ROOT = document.documentElement;
}

/** Built rows keyed by CSS token name. */
type Row = {
  input: HTMLSelectElement | HTMLButtonElement | HTMLInputElement,
  out: HTMLOutputElement,
  label: HTMLLabelElement,
  spec: ControlSpec,
};
export const inputs = new Map<string, Row>();

// Sentinel for the "colours from photos" palette mode. Not a real palette name.
export const DYNAMIC = 'dynamic';

export function buildControls() {
  const hosts: Record<string, HTMLElement> = {};
  for (const [name, id] of Object.entries(d.HOSTS)) {
    const node = document.getElementById(id);
    if (node) { node.replaceChildren(); hosts[name] = node; }
  }
  if (!Object.keys(hosts).length) return;
  // Hosts were emptied above; stale rows would point at detached nodes.
  inputs.clear();

  for (const c of d.CONTROLS) {
    const host = hosts[c.host];
    if (!host) continue;
    const { label, out } = field(c.label, { out: true });

    // Native <select> kept deliberately: unbounded list needs type-ahead, and
    // a phone gets the platform's own wheel picker.
    let input: HTMLSelectElement | HTMLButtonElement | HTMLInputElement;
    if (c.type === 'font') {
      input = document.createElement('select');
      // Board's own faces first — the one you dropped in is the one you want.
      const faces = [...c.options];
      const own = customFaces();
      if (own.length) faces.splice(1, 0, ...own);
      for (const f of faces) {
        const opt = document.createElement('option');
        opt.value = f.value;
        opt.textContent = f.label;
        // Show each name in its own face so the list is the comparison.
        if (f.value && !f.value.startsWith('var(')) opt.style.fontFamily = f.value;
        input.append(opt);
      }
      input.addEventListener('change', () => d.setVar(c.var, input.value));
    } else if (c.type === 'color') {
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
      input.min = String(c.min); input.max = String(c.max); input.step = String(c.step);
      tickSlider(input);
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
      // Use vars, not computed — computed resolves to a stack matching no option.
      input.value = d.current().vars[name] ?? '';
      out.textContent = '';
    } else if (spec.type === 'color') {
      input.style.background = toHex(raw) || '#000000';
      out.textContent = '';
    } else {
      const n = parseFloat(raw);
      input.value = String(Number.isFinite(n) ? n : spec.min);
      out.textContent = format(input.value, spec);
    }
  }
  const whimsy = rangeInput('opt-whimsy');
  if (whimsy) whimsy.value = String(d.current().whimsy);

  syncPaletteMode();
}

// Sync palette menu + source dial only. Separate from syncControls() to avoid
// overwriting a colour input mid-drag.
export function syncPaletteMode() {
  const dynamic = d.dynamicOn();
  const el = document.getElementById('opt-palette');
  // Dispatch repaint rather than calling paintPicker() to avoid a circular import.
  if (el) {
    el.dataset.value = dynamic ? DYNAMIC : (d.current().palette || '');
    el.dispatchEvent(new CustomEvent('repaint'));
  }
  // Source-count dial only applies in dynamic mode.
  const field = document.getElementById('palette-sources-field');
  if (field) field.hidden = !dynamic;
  syncPaletteSources();
}

export function syncPaletteSources() {
  const input = rangeInput('opt-palette-sources');
  const out = document.getElementById('opt-palette-sources-out');
  const n = d.sourceCount();
  const all = n >= d.ALL_SOURCES_MAX;
  if (input && document.activeElement !== input) {
    input.value = String(all ? d.ALL_SOURCES_STOP : n);
  }
  if (!out) return;
  // "Every photo" at the top stop; no live count since it shifts as photos arrive.
  out.textContent = all ? 'Every photo' : `${n} photo${n === 1 ? '' : 's'}`;
}

export function wirePaletteSources() {
  const input = rangeInput('opt-palette-sources');
  if (!input) return;
  input.max = String(d.ALL_SOURCES_STOP);
  input.value = String(d.sourceCount() >= d.ALL_SOURCES_MAX ? d.ALL_SOURCES_STOP : d.sourceCount());
  tickSlider(input);
  input.addEventListener('input', () => {
    const n = +input.value;
    setSetting('paletteSources', n >= d.ALL_SOURCES_STOP ? 0 : n);
  });
  syncPaletteSources();
}

export function wireWhimsy() {
  const input = rangeInput('opt-whimsy');
  if (!input) return;
  input.max = String(d.WHIMSY.length - 1);
  input.value = String(d.current().whimsy);
  tickSlider(input);
  input.addEventListener('input', () => d.setWhimsy(input.value));
}

function format(value: string, spec: RangeControl) {
  const n = parseFloat(value);
  const decimals = spec.step >= 1 ? 0 : String(spec.step).split('.')[1].length;
  return n.toFixed(decimals) + (spec.unit || '');
}

export function wirePalette() {
  const el = document.getElementById('opt-palette');
  if (!el) return;
  el.addEventListener('pick', e => {
    const value = (e as CustomEvent<string>).detail;
    if (value === DYNAMIC) d.goDynamic();
    else d.setPalette(value);
  });
}

/** Normalise any CSS colour to #rrggbb for pickColor(). */
export function toHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  // Percentages would NaN under .map(Number) — fall through to canvas instead.
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m && !m[1].includes('%')) {
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    if ([r, g, b].every(Number.isFinite)) {
      return '#' + [r, g, b].map(n => clamp255(n).toString(16).padStart(2, '0')).join('');
    }
  }
  // Everything else: round-trip through a canvas.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    const out = ctx.fillStyle;
    return typeof out === 'string' && /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

const clamp255 = (n: number) => clamp(Math.round(n || 0), 0, 255);
