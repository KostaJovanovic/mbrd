// Live theming. Every control here writes a CSS custom property straight onto
// :root, so the change is immediate and nothing needs re-rendering.
//
// A "palette" is a named set of pigments defined in tokens.css and selected via
// data-palette; the sliders below then nudge individual tokens on top of it.
//
// The result is stored in two places on purpose:
//   localStorage  - "my app looks like this", follows the user across boards
//   board.settings.appearance - "this board looks like this", travels in the
//                   .mbrd, so opening someone else's board shows their look.
// Opening a board applies its appearance; editing a control updates both.

import { board, bus, markDirty } from '../state.js';

const STORE_KEY = 'mbrd.appearance';

/** The curated set of tokens worth exposing. Everything else stays internal. */
const CONTROLS = [
  { var: '--accent',      label: 'Pigment',       type: 'color' },
  { var: '--paper',       label: 'Paper',         type: 'color' },
  { var: '--radius',      label: 'Corner radius', type: 'range', min: 0,   max: 28,  step: 1,    unit: 'px' },
  { var: '--grid-alpha',  label: 'Grid strength', type: 'range', min: 0,   max: 0.4, step: 0.01 },
  { var: '--grid-dot',    label: 'Grid weight',   type: 'range', min: 0.5, max: 4,   step: 0.1,  unit: 'px' },
  { var: '--density',     label: 'Panel density', type: 'range', min: 0.8, max: 1.5, step: 0.05 },
  { var: '--sidebar-w',   label: 'Panel width',   type: 'range', min: 260, max: 460, step: 4,    unit: 'px' },
];

const root = document.documentElement;
let current = { palette: '', vars: {} };
let onChange = () => {};

export function initAppearance(handlers = {}) {
  onChange = handlers.onChange || (() => {});

  const stored = readStored();
  // A board's own look wins when it brought one; otherwise fall back to the
  // user's saved preferences.
  const fromBoard = board.settings.appearance;
  current = hasLook(fromBoard) ? clone(fromBoard) : stored;
  apply(current);

  buildControls();
  wirePalette();

  bus.on('board', () => {
    const look = board.settings.appearance;
    if (!hasLook(look)) return;
    current = clone(look);
    apply(current);
    syncControls();
  });
}

export function currentAppearance() { return clone(current); }

export function resetAppearance() {
  for (const key of Object.keys(current.vars)) root.style.removeProperty(key);
  current = { palette: '', vars: {} };
  apply(current);
  persist();
  syncControls();
}

// ---------------------------------------------------------------------------

function apply(look) {
  if (look.palette) root.dataset.palette = look.palette;
  else delete root.dataset.palette;   // no attribute = the default, Papyrus
  for (const [key, value] of Object.entries(look.vars || {})) {
    root.style.setProperty(key, value);
  }
}

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(current)); } catch { /* private mode */ }
  board.settings.appearance = clone(current);
  markDirty();
  onChange();
}

function setVar(name, value) {
  current.vars[name] = value;
  root.style.setProperty(name, value);
  persist();
}

function readStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { palette: raw.palette || '', vars: raw.vars || {} };
  } catch {
    return { palette: '', vars: {} };
  }
}

const hasLook = look => !!look && (look.palette || Object.keys(look.vars || {}).length);
const clone = look => ({ palette: look?.palette || '', vars: { ...(look?.vars || {}) } });

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const inputs = new Map();

function buildControls() {
  const host = document.getElementById('appearance-vars');
  if (!host) return;
  host.replaceChildren();

  for (const c of CONTROLS) {
    const label = document.createElement('label');
    label.className = 'field';

    const head = document.createElement('span');
    const text = document.createElement('span');
    text.textContent = c.label;
    const out = document.createElement('output');
    head.append(text, out);

    const input = document.createElement('input');
    input.type = c.type === 'color' ? 'color' : 'range';
    if (c.type === 'range') {
      input.min = c.min; input.max = c.max; input.step = c.step;
    }
    input.addEventListener('input', () => {
      const value = c.type === 'color' ? input.value : input.value + (c.unit || '');
      out.textContent = c.type === 'color' ? '' : format(input.value, c);
      setVar(c.var, value);
    });

    label.append(head, input);
    host.append(label);
    inputs.set(c.var, { input, out, spec: c });
  }
  syncControls();
}

function syncControls() {
  const computed = getComputedStyle(root);
  for (const [name, { input, out, spec }] of inputs) {
    const raw = (current.vars[name] ?? computed.getPropertyValue(name)).trim();
    if (spec.type === 'color') {
      input.value = toHex(raw) || '#000000';
      out.textContent = '';
    } else {
      const n = parseFloat(raw);
      input.value = Number.isFinite(n) ? n : spec.min;
      out.textContent = format(input.value, spec);
    }
  }
  const paletteSel = document.getElementById('opt-palette');
  if (paletteSel) paletteSel.value = current.palette || '';
}

function format(value, spec) {
  const n = parseFloat(value);
  // Match the readout's precision to the slider's step, so a 0.1px grid weight
  // doesn't display as a flat "2px" through its whole range.
  const decimals = spec.step >= 1 ? 0 : String(spec.step).split('.')[1].length;
  return n.toFixed(decimals) + (spec.unit || '');
}

function wirePalette() {
  const sel = document.getElementById('opt-palette');
  if (!sel) return;
  sel.value = current.palette || '';
  sel.addEventListener('change', () => {
    // A palette switch replaces the pigments wholesale, so per-token colour
    // tweaks are dropped - otherwise the old accent would stick to the new
    // paper and every palette after the first would look muddy.
    for (const key of ['--accent', '--paper']) {
      delete current.vars[key];
      root.style.removeProperty(key);
    }
    current.palette = sel.value;
    apply(current);
    persist();
    syncControls();   // computed colours changed under us
  });
}

/**
 * Normalise whatever the browser reports for a colour token into #rrggbb, which
 * is the only thing <input type="color"> accepts.
 */
function toHex(value) {
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

const clamp255 = n => Math.max(0, Math.min(255, Math.round(n || 0)));
