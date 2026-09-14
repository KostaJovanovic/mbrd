// Mobile masthead appearance panel — font, size, weight, axes, wrap, offset.
// Opened from the pen button on the masthead corner. Non-modal, borrows
// sidebar markup classes and slider-focus behaviour.

import {
  board, bus, DEFAULT_MOBILE_HEADER, setSetting, mobileBoardWorldWidth,
} from '../state.ts';
import { clamp, el, readToken } from '../util.ts';
import {
  headerFontAxes, headerFontOptions, headerFontSize, headerFontStack,
  headerFontWeights,
} from './fonts.ts';
import { createMobileSliderFocus } from './sidebar.ts';
import { field, fieldStops, tickSlider } from './controls.ts';
import { paintTitleField, wireTitleField } from './board-title.ts';
import { registerPanel, panelShown, panelHidden } from './panel-stack.ts';
import { open as openSearch } from './search.ts';
import { openAnchored, menuButton } from './menu.ts';
import type { MenuEntry } from './menu.ts';
import type { FontAxis, MobileHeader } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { SliderFocus } from './sidebar.ts';

/** One weight stop, as headerFontWeights() lists them. */
type WeightStop = { value: number; label: string };

/** One axis slider row. `out` is always present — rangeControl() always requests one. */
type AxisControl = {
  label: HTMLLabelElement;
  input: HTMLInputElement;
  out: HTMLOutputElement;
  axis: FontAxis;
};

/** Weight control — continuous slider or named stops. `set` abstracts both. */
type WeightControl = {
  input: HTMLInputElement;
  out: HTMLOutputElement | null;
  set: (weight: number) => void;
};

// Human-readable names for axis tags. Unknown tags fall back to the raw tag.
// wght/ital are excluded — they have dedicated controls.
const AXIS_LABELS = {
  opsz: 'Optical size',
  wdth: 'Width',
  slnt: 'Slant',
  CASL: 'Casual',
  CRSV: 'Cursive',
  MONO: 'Monospace',
  GRAD: 'Grade',
  SOFT: 'Softness',
  WONK: 'Wonky',
  FLAR: 'Flare',
  VOLM: 'Volume',
  ROND: 'Roundness',
  BLED: 'Bleed',
  EDPT: 'Extrusion depth',
  EHLT: 'Highlight',
  ELGR: 'Element grid',
  ELSH: 'Element shape',
  XTRA: 'Counter width',
  XOPQ: 'Thick stroke',
  YOPQ: 'Thin stroke',
  YTAS: 'Ascender height',
  YTDE: 'Descender depth',
  YTFI: 'Figure height',
  YTLC: 'Lowercase height',
  YTUC: 'Uppercase height',
};

// Elements by id from index.html; ids checked by tests/element-ids.test.js.
let viewport: Viewport | null;
let button: HTMLElement;
let findBtn: HTMLElement;
let panel: HTMLElement;
let sliderFocus: SliderFocus;
let section: HTMLElement;
let titleInput: HTMLInputElement;
let fontBtn: HTMLButtonElement;
let sizeInput: HTMLInputElement;
let sizeOut: HTMLElement;
let stretchInput: HTMLInputElement;
let stretchOut: HTMLElement;
let leadingInput: HTMLInputElement;
let leadingOut: HTMLElement;
let leadingRow: HTMLElement;
let offsetInput: HTMLInputElement;
let offsetOut: HTMLElement;
let italicInput: HTMLInputElement;
let wrapInput: HTMLInputElement;
let weightHost: HTMLElement;
let axesHost: HTMLElement;
let weightControl: WeightControl | null = null;
const axisControls = new Map<string, AxisControl>();

// SAFETY: ids and tags match index.html; a missing id throws at boot.
const inputEl = (id: string) => el(id)! as HTMLInputElement;
// SAFETY: its one call names #mobile-header-font, a <button> in index.html.
const buttonEl = (id: string) => el(id)! as HTMLButtonElement;

export function initMobileHeaderEditor(vp: Viewport | null) {
  viewport = vp;
  button = el('mobile-header-edit-btn')!;
  panel = el('header-panel')!;
  section = el('mobile-header-settings')!;
  titleInput = inputEl('header-title');
  fontBtn = buttonEl('mobile-header-font');
  sizeInput = inputEl('mobile-header-size');
  sizeOut = el('mobile-header-size-out')!;
  stretchInput = inputEl('mobile-header-stretch');
  stretchOut = el('mobile-header-stretch-out')!;
  leadingInput = inputEl('mobile-header-leading');
  leadingOut = el('mobile-header-leading-out')!;
  // SAFETY: the slider sits in its own <label class="field"> in index.html.
  leadingRow = leadingInput.closest('label')!;
  offsetInput = inputEl('mobile-header-offset');
  offsetOut = el('mobile-header-offset-out')!;
  italicInput = inputEl('mobile-header-italic');
  wrapInput = inputEl('mobile-header-wrap');
  weightHost = el('mobile-header-weight')!;
  axesHost = el('mobile-header-axes')!;

  sliderFocus = createMobileSliderFocus(panel);
  // SAFETY: target is always a child element of #header-panel.
  panel.addEventListener('pointerdown', e => sliderFocus.begin(e.target as Element | null, e.pointerId));
  const endSliderFocus = (e: PointerEvent) => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  panel.addEventListener('lostpointercapture', endSliderFocus, true);

  // Toggle — a mid-fade interrupt can leave the pen pressable over an open panel.
  button.addEventListener('click', () => (isPanelOpen() ? closePanel() : openPanel()));
  el('header-close')!.addEventListener('click', closePanel);
  // Find — phone's only way into the palette (no Ctrl+K or right-click on touch).
  findBtn = el('mobile-find-btn')!;
  // Toggle — second tap closes rather than rebuilding an empty palette.
  findBtn.addEventListener('click', () => openSearch(findBtn));
  // Same title field as the sidebar's — both paint from board.title on 'board'.
  wireTitleField(titleInput);
  menuButton(fontBtn, () => openAnchored(fontBtn.getBoundingClientRect(), fontEntries(),
    { label: 'Font', owner: fontBtn, focus: true }));
  for (const dial of [sizeInput, stretchInput, leadingInput, offsetInput]) tickSlider(dial);
  sizeInput.addEventListener('input', () => {
    update({ size: +sizeInput.value * 100 / boardWidth() });
    sizeOut.textContent = sizeInput.value;
  });
  stretchInput.addEventListener('input', () => {
    const value = snapStretch(+stretchInput.value);
    update({ stretch: value });
    stretchOut.textContent = `${value}%`;
  });
  leadingInput.addEventListener('input', () => {
    const value = +leadingInput.value;
    update({ leading: value });
    leadingOut.textContent = leadingText(value);
  });
  offsetInput.addEventListener('input', () => {
    const value = Math.round(+offsetInput.value);
    update({ offset: value });
    offsetOut.textContent = offsetText(value);
  });
  italicInput.addEventListener('change', () => update({ italic: italicInput.checked }));
  wrapInput.addEventListener('change', () => {
    update({ wrap: wrapInput.checked });
    leadingRow.hidden = !wrapInput.checked;
  });
  el('mobile-header-reset')!.addEventListener('click', resetHeader);

  // Refit on name change and window resize (not viewport pan — too frequent).
  const title = el('mobile-board-title')!;
  title.addEventListener('input', scheduleFit);
  bus.on('board', () => {
    paintTitleField(titleInput);
    scheduleFit();
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleFit).observe(el('mobile-board-header')!);
  }

  viewport?.onChange?.(paintButton);
  paintFind();
  bus.on('layout', () => {
    buildControls();
    paint();
    paintFind();
  });
  // Pen visibility depends on lens (Feed vs Playlist), not just layout.
  bus.on('lens', paintButton);
  // Pen hides when the Feed's title page scrolls out of view.
  bus.on('feed:masthead', on => { mastheadOnScreen = !!on; paintButton(); });
  registerPanel('header', openPanel, closePanel);
  bus.on('board:load', () => {
    buildControls();
    paint();
    paintFind();
  });
  bus.on('fonts', () => {
    buildControls();
    paint();
  });
  bus.on('settings', key => {
    if (key === 'mobileHeader') paint();
    // Default font follows --font-display, which whimsy may replace.
    else if (key === 'appearance' && !header().font) {
      buildAxisControls();
      paint();
    }
  });
  // Microtask: items.ts mounts the node in its own handler, which runs first.
  bus.on('items', () => queueMicrotask(() => styleTitleCard()));

  buildControls();
  paint();
}

/** CSS low-level settings for every available axis except weight. */
export function variationSettings(style: MobileHeader, axes: FontAxis[] | null | undefined) {
  const values: string[] = [];
  for (const axis of axes || []) {
    if (axis.tag === 'wght') continue;
    const raw = axis.tag === 'ital'
      ? (style.italic ? 1 : 0)
      : style.axes?.[axis.tag] ?? axis.default;
    const value = clamp(+raw || 0, axis.min, axis.max);
    values.push(`"${axis.tag}" ${formatAxis(value)}`);
  }
  return values.join(', ');
}

/** Snap zone around 100% — the most common value is easy to miss on a wide range. */
const STRETCH_DETENT = 4;
const snapStretch = (value: number) =>
  (Math.abs(value - 100) <= STRETCH_DETENT ? 100 : value);

/** 100 = face's own line height → show "Auto". */
const leadingText = (value: number) => (+value === 100 ? 'Auto' : `${formatAxis(value)}%`);

/** 0 = centered → show "Center", otherwise direction + distance. */
const offsetText = (value: number) =>
  (+value === 0 ? 'Center' : `${+value < 0 ? 'Up' : 'Down'} ${Math.abs(+value)}%`);

/** Slider step scaled to the axis range. */
export function axisStep(axis: FontAxis) {
  if (axis.tag === 'ital' || axis.tag === 'WONK') return 1;
  const span = axis.max - axis.min;
  if (span >= 100) return 1;
  if (span >= 10) return 0.1;
  return 0.01;
}

/** Whether the masthead's panel is on screen. */
export const isPanelOpen = () => !!panel?.classList.contains('is-open');

export function openPanel() {
  if (!panel) return;
  panelShown('header');
  setPanelOpen(true);
  // Focus once so Tab walks controls in order.
  requestAnimationFrame(() => section.focus({ preventScroll: true }));
}

/** Close the panel. Exported for app-wide Escape and layout-mode changes. */
export function closePanel() {
  if (!panel) return;
  sliderFocus?.clear();
  setPanelOpen(false);
  panelHidden('header');
}

function setPanelOpen(want: boolean) {
  panel.classList.toggle('is-open', want);
  panel.setAttribute('aria-hidden', String(!want));
  button.setAttribute('aria-expanded', String(want));
}

// Rebuild required: face goes back to Default, so the axis sliders must match.
function resetHeader() {
  update({ ...DEFAULT_MOBILE_HEADER, axes: {} });
  buildControls();
  paint();
}

/**
 * The face menu, as the sidebar's face pickers draw it (ui/appearance-controls.ts):
 * Default on top, then every face A to Z, the board's dropped faces sorted in
 * with the rest, each row set in its own face.
 */
function fontEntries(): MenuEntry[] {
  const [first, ...rest] = headerFontOptions();
  const now = header().font;
  return [first, ...rest.sort((a, b) => a.label.localeCompare(b.label))].map(face => ({
    label: face.label,
    font: face.stack || undefined,
    check: face.value === now,
    action: () => changeFont(face.value),
  }));
}

/** The picker's name, in its own face. An unknown face from a newer version
 *  shows as Default, and the board keeps it. */
function paintFont(value: string) {
  const face = headerFontOptions().find(f => f.value === value);
  const name = fontBtn.querySelector<HTMLElement>('.field-picker-name');
  if (!name) return;
  name.textContent = face?.label ?? 'Default';
  name.style.fontFamily = face?.stack ?? '';
}

function changeFont(font: string) {
  const axes = availableAxes(font);
  const values: Record<string, number> = {};
  for (const axis of axes) {
    if (axis.tag !== 'wght' && axis.tag !== 'ital') values[axis.tag] = axis.default;
  }
  const weight = axes.find(axis => axis.tag === 'wght')?.default ?? header().weight;
  // Face-specific default size (Playfair); fall back to current, not global default.
  const size = headerFontSize(font) ?? header().size;
  update({ font, weight, size, axes: values });
  buildAxisControls();
  paint();
}

function buildControls() {
  // The face menu is built on each open, so a dropped face is in the next one.
  paintFont(header().font);
  buildAxisControls();
}

function buildAxisControls() {
  const axes = availableAxes();
  buildWeight(axes.find(axis => axis.tag === 'wght'));
  axesHost.replaceChildren();
  axisControls.clear();
  for (const axis of axes) {
    if (axis.tag === 'wght' || axis.tag === 'ital') continue;
    const control = rangeControl(axisLabel(axis.tag), axis);
    control.input.addEventListener('input', () => {
      const value = +control.input.value;
      control.out.textContent = formatAxis(value);
      update({ axes: { ...header().axes, [axis.tag]: value } });
    });
    axesHost.append(control.label);
    axisControls.set(axis.tag, control);
  }
  axesHost.hidden = axisControls.size === 0;
}

// Three shapes: variable face → continuous slider, static face → named stops,
// no weights → hidden. Static face uses index positions, not weight values.
function buildWeight(axis: FontAxis | undefined) {
  weightHost.replaceChildren();
  weightHost.hidden = false;
  weightControl = null;

  if (axis) {
    const control = rangeControl('Weight', axis);
    control.input.addEventListener('input', () => {
      const value = Math.round(+control.input.value);
      control.out.textContent = String(value);
      update({ weight: value });
    });
    weightHost.append(control.label);
    weightControl = {
      ...control,
      set: (weight: number) => {
        control.input.value = String(weight);
        control.out.textContent = formatAxis(weight);
      },
    };
    return;
  }

  const stops = headerFontWeights(header().font, displayStack());
  if (!stops.length) {
    weightHost.hidden = true;
    return;
  }

  const { label } = field('Weight');
  // Value is a list index, not a weight — stops may be non-contiguous.
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = String(stops.length - 1);
  input.step = '1';
  tickSlider(input);
  // Each stop label is set in its own weight as a specimen.
  const names = fieldStops(stops, { specimen: s => ({ fontWeight: String(s.value) }) });
  const describe = (index: number) => {
    input.setAttribute('aria-valuetext', stops[index]?.label || '');
  };
  input.addEventListener('input', () => {
    const index = clamp(Math.round(+input.value), 0, stops.length - 1);
    describe(index);
    update({ weight: stops[index].value });
  });
  label.append(input, names);
  weightHost.append(label);
  weightControl = {
    input,
    out: null,
    set: (weight: number) => {
      const index = nearestStop(stops, weight);
      input.value = String(index);
      describe(index);
    },
  };
}

/** Nearest weight stop to a stored value. */
function nearestStop(stops: readonly WeightStop[], weight: number) {
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i].value - weight) < Math.abs(stops[best].value - weight)) best = i;
  }
  return best;
}

function rangeControl(labelText: string, axis: FontAxis): AxisControl {
  const { label, out } = field(labelText, { out: true });
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(axis.min);
  input.max = String(axis.max);
  input.step = String(axisStep(axis));
  label.append(input);
  return { label, input, out: out!, axis };
}

function paint() {
  paintTitleField(titleInput);
  const style = header();
  const axes = availableAxes();
  const masthead = el('mobile-board-title');
  if (masthead) applyTitleStyle(masthead, style, axes);
  scheduleFit();
  styleTitleCard(style, axes);
  paintButton();

  paintFont(style.font);
  paintSize(style.size);
  stretchInput.value = String(style.stretch);
  stretchOut.textContent = `${formatAxis(style.stretch)}%`;
  leadingInput.value = String(style.leading);
  leadingOut.textContent = leadingText(style.leading);
  offsetInput.value = String(style.offset ?? 0);
  offsetOut.textContent = offsetText(style.offset ?? 0);
  italicInput.checked = style.italic;
  wrapInput.checked = style.wrap;
  // Line height only spaces the lines of a wrapped name.
  leadingRow.hidden = !style.wrap;

  const weightAxis = axes.find(axis => axis.tag === 'wght');
  // set() abstracts continuous vs. named-stop controls.
  weightControl?.set(weightAxis
    ? clamp(style.weight, weightAxis.min, weightAxis.max)
    : style.weight);
  for (const [tag, control] of axisControls) {
    const value = clamp(style.axes[tag] ?? control.axis.default,
      control.axis.min, control.axis.max);
    control.input.value = String(value);
    control.out.textContent = formatAxis(value);
  }
}

/** The Desktop title card's text node, or null when it is not on the board. */
function titleCardEl() {
  return document.querySelector<HTMLElement>('.item[data-type="title"] .title-name');
}

/** Apply shared masthead typography to either the Mobile masthead or Desktop title card. */
function applyTitleStyle(title: HTMLElement, style: MobileHeader, axes: FontAxis[]) {
  const stack = headerFontStack(style.font);
  if (stack) title.style.fontFamily = stack;
  else title.style.removeProperty('font-family');
  // Unrounded: a slider step is a pixel on the board, about 0.2% of its width,
  // and formatAxis()'s two places dropped four steps in five.
  title.style.setProperty('--mobile-title-scale', String(style.size / 100));
  title.style.setProperty('--mobile-title-cap', String(TITLE_CAP));
  title.style.setProperty('--mobile-title-stretch', formatAxis(style.stretch / 100));
  title.style.setProperty('--mobile-title-offset', String(style.offset ?? 0));
  // At default, clear so stylesheet's `line-height: normal` applies.
  if (style.leading === 100) title.style.removeProperty('line-height');
  else title.style.lineHeight = formatAxis(style.leading / 100);
  // Always inline — clearing would let --display-weight leak through from whimsy.
  title.style.fontWeight = String(style.weight);
  title.style.fontStyle = axes.some(axis => axis.tag === 'ital')
    ? 'normal'
    : style.italic ? 'italic' : 'normal';
  title.style.fontVariationSettings = variationSettings(style, axes) || 'normal';
  // Attribute — no-wrap needs three CSS declarations, not just white-space.
  title.toggleAttribute('data-nowrap', !style.wrap);
}

/** Style and fit the Feed's masthead. Caller sets --mobile-board-width first. */
export function styleFeedMasthead(title: HTMLElement | null, box: Element | null) {
  if (!title) return;
  applyTitleStyle(title, header(), availableAxes());
  if (box) fitOne(title, box, header().wrap, false);
}

/** Style the Desktop title card if it is on the board right now. */
function styleTitleCard(style: MobileHeader = header(), axes: FontAxis[] = availableAxes()) {
  const card = titleCardEl();
  if (!card) return;
  applyTitleStyle(card, style, axes);
  // Compute --mobile-title-ratio so the card wraps identically to the masthead.
  // Uses mobileBoardWorldWidth() (always Mobile's width), not the active viewport.
  const ref = boardWidth();
  const px = Math.min(ref * TITLE_CAP, Math.max(20, ref * (style.size / 100)));
  card.style.setProperty('--mobile-title-ratio', String(px / ref));
  scheduleFit();
}

// No CSS for "make this line fit" — measured here, written as --mobile-title-fit.
// Floored at 0.25; below that, clipping is the better failure.
const FIT_FLOOR = 0.25;
let fitFrame = 0;

/** Both masthead and title card fit to the same line count for consistency. */
const TITLE_LINES = 2;

/** Max name size as fraction of board width (= 96/512). Ratio, not px, so both layouts agree. */
const TITLE_CAP = 0.1875;

/** The Mobile board's width, which the name's size is a share of. */
const boardWidth = () => mobileBoardWorldWidth() || 512;

/** The size slider counts pixels on the Mobile board, and the style keeps a
 *  share of its width, so the name still scales with the screen. It runs from
 *  board-schema.ts's floor, 7%, to TITLE_CAP, where the stylesheets stop the
 *  name: every step past the cap changed nothing. Both ends rounded inwards. */
function paintSize(size: number) {
  const ref = boardWidth();
  sizeInput.min = String(Math.ceil(ref * 0.07));
  sizeInput.max = String(Math.floor(ref * TITLE_CAP));
  sizeInput.value = String(Math.round(ref * size / 100));
  sizeOut.textContent = sizeInput.value;
}

// Counted via Range rects, not box/line-height — line-height is `normal` by default.
function lineCount(title: Element) {
  if (typeof document === 'undefined' || typeof document.createRange !== 'function') return 1;
  const range = document.createRange();
  range.selectNodeContents(title);
  const tops = new Set();
  for (const r of range.getClientRects()) {
    if (r.width > 0.5) tops.add(Math.round(r.top * 2));
  }
  return tops.size || 1;
}

// Binary search (6 passes) — arithmetic overshoot because text-wrap: balance moves breaks.
function fitLines(title: HTMLElement, max = TITLE_LINES) {
  title.style.setProperty('--mobile-title-fit', '1');
  if (lineCount(title) <= max) {
    title.style.removeProperty('--mobile-title-fit');
    return;
  }
  let low = FIT_FLOOR;
  let high = 1;
  let best = FIT_FLOOR;
  for (let pass = 0; pass < 6; pass++) {
    const mid = (low + high) / 2;
    title.style.setProperty('--mobile-title-fit', String(mid));
    if (lineCount(title) <= max) { best = mid; low = mid; } else high = mid;
  }
  title.style.setProperty('--mobile-title-fit', String(Math.floor(best * 1000) / 1000));
}

function scheduleFit() {
  if (fitFrame || typeof requestAnimationFrame !== 'function') return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitTitle();
  });
}

function fitTitle() {
  const wrap = header().wrap;
  fitOne(el('mobile-board-title'), el('mobile-board-header'),
    wrap, board.layoutMode !== 'mobile');
  const cardName = titleCardEl();
  fitOne(cardName, cardName?.closest('.title-card') ?? null, wrap, false);
}

/** Fit one name: unwrapped → single line, wrapped → TITLE_LINES. `off` clears the shrink. */
function fitOne(title: HTMLElement | null, box: Element | null, wrap: boolean, off: boolean) {
  if (!title || !box) return;
  if (off) { title.style.removeProperty('--mobile-title-fit'); return; }
  if (wrap) { fitLines(title); return; }
  title.style.setProperty('--mobile-title-fit', '1');
  const room = box.clientWidth;
  const line = title.offsetWidth;
  if (!room || !line || line <= room) {
    title.style.removeProperty('--mobile-title-fit');
    return;
  }
  const fit = Math.max(FIT_FLOOR, Math.floor((room / line) * 1000) / 1000);
  title.style.setProperty('--mobile-title-fit', String(fit));
}

/** Guard — avoids writing the same visibility on every scroll frame. */
let buttonShown: boolean | null = null;

// Default true — an unscrolled board is at the top, pen should be reachable.
let mastheadOnScreen = true;

function paintButton() {
  // Pen visible on Mobile Feed while the title page is on screen.
  const lens = document.documentElement.dataset.feedLens;
  const visible = board.layoutMode === 'mobile' && lens !== 'playlist' && mastheadOnScreen;
  if (visible === buttonShown) return;
  buttonShown = visible;
  button.hidden = !visible;
  button.setAttribute('aria-hidden', String(!visible));
}

/** Find rides the whole Mobile board, not gated on Feed lens like the pen. */
function paintFind() {
  if (!findBtn) return;
  findBtn.hidden = board.layoutMode !== 'mobile';
}

/** Current display face stack. Guarded for tests without a document. */
function displayStack() {
  return typeof getComputedStyle === 'function' ? readToken('--font-display') : '';
}

function availableAxes(font: string = header().font) {
  return headerFontAxes(font, displayStack());
}

function update(patch: Partial<MobileHeader>) {
  const current = header();
  setSetting('mobileHeader', {
    ...current,
    ...patch,
    axes: patch.axes ? { ...patch.axes } : { ...current.axes },
  });
}

function header(): MobileHeader {
  // Board-level now, not per-layout: the Mobile masthead and the Desktop title
  // card are one style set in one place. See state.ts.
  return board.mobileHeader || DEFAULT_MOBILE_HEADER;
}

function axisLabel(tag: string) {
  // SAFETY: the widening is the lookup, not a claim about the table. AXIS_LABELS
  // is keyed by the four tags it happens to know, and `tag` comes off a font's
  // fvar - so the read has to be allowed to miss. It does, and the two lines
  // below are what a miss becomes. Nothing is written through this view.
  const known = (AXIS_LABELS as Record<string, string>)[tag];
  if (known) return known;
  return tag.trim() || 'Axis';
}

function formatAxis(value: number) {
  return String(Math.round(+value * 100) / 100);
}
