// Look tab controls: rows, wiring, sync with the look model.
// All deps arrive via initAppearanceControls() — this imports nothing from
// ui/appearance.ts, keeping the arrow one way. `current` is a getter because
// a board load replaces the whole look object.

import { board, setSetting } from '../state.ts';
import { appearanceControlVisible } from '../layout-settings.ts';
import { toHex } from '../util.ts';
import { customFaces } from './fonts.ts';
import { field, tickSlider } from './controls.ts';
import { pickColor } from './color-picker.ts';
import { openAnchored, menuButton } from './menu.ts';
import type { MenuEntry } from './menu.ts';

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
  dark?: boolean,
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
  previewWhimsy: (level: number | string) => void,
  settleWhimsy: () => void,
  setPalette: (name: string) => void,
  goDynamic: () => void,
  sourceCount: () => number,
  dynamicOn: () => boolean,
  /** A pigment written by hand rather than by a palette or by the pictures. */
  handPicked: () => boolean,
};

// Filled by initAppearanceControls() before any use.
let d!: LookDeps;

// Nullable because the tab may not be built yet.
// SAFETY: only ever given #opt-whimsy and #opt-palette-sources, 'range' rows that panel.ts buildRange() makes <input>s.
const rangeInput = (id: string) => document.getElementById(id) as HTMLInputElement | null;

/** Wire up the look-model deps. Called once at boot. */
export function initAppearanceControls(deps: LookDeps) {
  d = deps;
  ROOT = document.documentElement;
}

/** Built rows keyed by CSS token name. */
type Row = {
  input: HTMLButtonElement | HTMLInputElement,
  out: HTMLOutputElement,
  label: HTMLLabelElement,
  spec: ControlSpec,
};
export const inputs = new Map<string, Row>();

// Sentinel for the "colours from photos" palette mode. Not a real palette name.
export const DYNAMIC = 'dynamic';

/**
 * Sentinel for a pigment chosen by hand. Not a real palette name either, and
 * unlike Dynamic it is not a row in the menu: it is a state the control is
 * *put into* from the Pigment row below it, and picking any palette drops
 * every pigment token (setPalette in ui/appearance.ts), so the next choice
 * from the menu forgets it. The word it reads as is in settings-schema.ts.
 */
export const CUSTOM = 'custom';

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

    let input: HTMLButtonElement | HTMLInputElement;
    if (c.type === 'font') {
      // The panel's picker (buildPicker() in ui/panel.ts), built here because
      // its rows are this module's: every face in its own face.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'field-picker';
      const name = document.createElement('span');
      name.className = 'field-picker-name';
      btn.append(name);
      menuButton(btn, () => openAnchored(btn.getBoundingClientRect(),
        faceEntries(c, btn), { label: c.label, owner: btn, focus: true }));
      input = btn;
    } else if (c.type === 'color') {
      input = document.createElement('button');
      input.type = 'button';
      input.className = 'pigment-swatch';
      const swatch = input;
      input.addEventListener('click', async () => {
        const raw = (d.current().vars[c.var] ?? getComputedStyle(ROOT!).getPropertyValue(c.var)).trim();
        const picked = await pickColor({ title: 'Pigment', value: toHex(raw) || '#000000' });
        if (!picked) return;
        d.setVar(c.var, picked);
        // setVar() deliberately repaints nothing - a slider calls it on every
        // input - and this is the one control whose own face is the value
        // it just wrote. Without this the swatch kept the old colour until
        // something else called syncControls(), which on a quiet board is the
        // next reload.
        swatch.style.background = picked;
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

/** A face as a label's font-family: '' is "let whimsy decide", which has no face to show. */
const faceOf = (value: string) => value || undefined;

/**
 * A face menu: Default on top, then every face A to Z - the board's own
 * dropped faces sorted in with the rest - each row set in its own face so the
 * list is the comparison. Typing jumps to a name (ui/menu.ts's type-ahead).
 */
function faceEntries(c: FontControl, btn: HTMLButtonElement): MenuEntry[] {
  const now = btn.dataset.value ?? '';
  const [first, ...rest] = c.options;
  const faces = [...rest, ...customFaces()].sort((a, b) => a.label.localeCompare(b.label));
  return [first, ...faces].map(f => ({
    label: f.label,
    font: faceOf(f.value),
    check: f.value === now,
    action: () => {
      d.setVar(c.var, f.value);
      // setVar() repaints no control, so the button and the next menu's tick would keep the old face.
      paintFace(btn, c, f.value);
    },
  }));
}

/**
 * Write a face picker's value and its face. A value no option names - a board
 * from elsewhere - shows the first family in its stack rather than nothing.
 */
function paintFace(btn: HTMLElement, c: FontControl, value: string) {
  btn.dataset.value = value;
  const name = btn.querySelector<HTMLElement>('.field-picker-name');
  if (!name) return;
  const known = [...c.options, ...customFaces()].find(f => f.value === value);
  name.textContent = known?.label ?? value.split(',')[0].replace(/["']/g, '').trim();
  name.style.fontFamily = faceOf(value) ?? '';
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
      paintFace(input, spec, d.current().vars[name] ?? '');
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
    // Dynamic first: it is also a look with pigment tokens written into it,
    // and the machine having chosen them is the more useful of the two facts.
    el.dataset.value = dynamic ? DYNAMIC
      : d.handPicked() ? CUSTOM
      : (d.current().palette || '');
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
  // Live while dragged, one Timeline step on release.
  input.addEventListener('input', () => d.previewWhimsy(input.value));
  input.addEventListener('change', () => d.settleWhimsy());
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
    // SAFETY: panel.ts buildPicker() dispatches 'pick' on #opt-palette with an Option value, a string.
    const value = (e as CustomEvent<string>).detail;
    if (value === DYNAMIC) d.goDynamic();
    else d.setPalette(value);
  });
}

