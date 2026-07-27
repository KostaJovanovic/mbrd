// The Mobile masthead's own appearance controls, and its own panel.
//
// A sheet of its own rather than a section of the sidebar, because it is opened
// by pointing at the thing it edits - the pen sits on the masthead's corner -
// and a panel reached that way should hold that one thing. In the sidebar it
// arrived with the board actions, the arrangement, the whole look and the
// keyboard legend stacked above it, and the pen had to scroll the panel down to
// its own section to make up for that.
//
// What it does not get is a second way of behaving. It borrows the sidebar's
// markup classes, so it is the same sheet in the same paper; it borrows
// createMobileSliderFocus(), so a finger on a slider dissolves everything
// except the track and the board underneath previews the change in place; and
// it is non-modal for the same reason the sidebar is - the board keeps panning
// and dropping while it is open.

import {
  board, bus, DEFAULT_MOBILE_HEADER, setSetting,
} from '../state.js';
import { clamp, el } from '../util.js';
import {
  headerFontAxes, headerFontOptions, headerFontStack, headerFontWeights,
} from './fonts.js';
import { createMobileSliderFocus } from './sidebar.js';

const AXIS_LABELS = {
  opsz: 'Optical size',
  wdth: 'Width',
  slnt: 'Slant',
  GRAD: 'Grade',
  SOFT: 'Softness',
  WONK: 'Wonky',
  XTRA: 'Counter width',
  XOPQ: 'Thick stroke',
  YOPQ: 'Thin stroke',
  YTAS: 'Ascender height',
  YTDE: 'Descender depth',
  YTFI: 'Figure height',
  YTLC: 'Lowercase height',
  YTUC: 'Uppercase height',
};

let viewport;
let button;
let panel;
let sliderFocus;
let section;
let fontSelect;
let sizeInput;
let sizeOut;
let stretchInput;
let stretchOut;
let leadingInput;
let leadingOut;
let italicInput;
let wrapInput;
let weightHost;
let axesHost;
let weightControl = null;
const axisControls = new Map();

export function initMobileHeaderEditor(vp) {
  viewport = vp;
  button = el('mobile-header-edit-btn');
  panel = el('header-panel');
  section = el('mobile-header-settings');
  fontSelect = el('mobile-header-font');
  sizeInput = el('mobile-header-size');
  sizeOut = el('mobile-header-size-out');
  stretchInput = el('mobile-header-stretch');
  stretchOut = el('mobile-header-stretch-out');
  leadingInput = el('mobile-header-leading');
  leadingOut = el('mobile-header-leading-out');
  italicInput = el('mobile-header-italic');
  wrapInput = el('mobile-header-wrap');
  weightHost = el('mobile-header-weight');
  axesHost = el('mobile-header-axes');

  sliderFocus = createMobileSliderFocus(panel);
  panel.addEventListener('pointerdown', e => sliderFocus.begin(e.target, e.pointerId));
  const endSliderFocus = e => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  panel.addEventListener('lostpointercapture', endSliderFocus, true);

  // Written as a toggle although the panel covers this corner while it is up -
  // the pen fades and stops taking presses, so in practice the close button and
  // Escape are the ways out. It is a toggle anyway because that is what the
  // button *means*, and because a fade that is interrupted mid-way leaves a
  // pressable pen in front of an open panel for a fraction of a second.
  button.addEventListener('click', () => (isPanelOpen() ? closePanel() : openPanel()));
  el('header-close').addEventListener('click', closePanel);
  fontSelect.addEventListener('change', changeFont);
  sizeInput.addEventListener('input', () => {
    update({ size: +sizeInput.value });
    sizeOut.textContent = `${sizeInput.value}%`;
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
  italicInput.addEventListener('change', () => update({ italic: italicInput.checked }));
  wrapInput.addEventListener('change', () => update({ wrap: wrapInput.checked }));
  el('mobile-header-reset').addEventListener('click', resetHeader);

  // The three ways the fit can go stale that are not a change to these
  // controls: the name itself, letter by letter while it is being renamed and
  // once more when the rename lands, and the width of the strip it is set
  // across. A ResizeObserver rather than the viewport's own onChange, which
  // fires on every frame of a pan and would put a layout read in each of them -
  // the band only ever changes width when the window does.
  const title = el('mobile-board-title');
  title.addEventListener('input', scheduleFit);
  bus.on('board', scheduleFit);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleFit).observe(el('mobile-board-header'));
  }

  viewport?.onChange?.(paintButton);
  bus.on('layout', () => {
    buildControls();
    paint();
  });
  bus.on('board:load', () => {
    buildControls();
    paint();
  });
  bus.on('fonts', () => {
    buildControls();
    paint();
  });
  bus.on('settings', key => {
    if (key === 'mobileHeader') paint();
    // Default follows --font-display, which the whimsy axis may replace.
    else if (key === 'appearance' && !header().font) {
      buildAxisControls();
      paint();
    }
  });

  buildControls();
  paint();
}

/** CSS low-level settings for every available axis except weight. */
export function variationSettings(style, axes) {
  const values = [];
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

/**
 * A detent at 100% on the way past it.
 *
 * The dial runs to five times now, so one step of the track is several percent
 * of height and the face as its designer drew it - the one value on this
 * slider anybody returns to - had become a number you could aim at and miss.
 * Four either side is wide enough to catch a thumb on a phone and narrow enough
 * that nothing else on the track is unreachable.
 */
const STRETCH_DETENT = 4;
const snapStretch = value =>
  (Math.abs(value - 100) <= STRETCH_DETENT ? 100 : value);

/** 100 is the face's own line height, and says so rather than showing "100%". */
const leadingText = value => (+value === 100 ? 'Auto' : `${formatAxis(value)}%`);

/** A useful slider step across small fractions and very broad design spaces. */
export function axisStep(axis) {
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
  setPanelOpen(true);
  // The panel is not modal and takes no focus by force; the section is given it
  // once, so a keyboard arrives inside the controls rather than back at the top
  // of the document, and tabbing from there walks the fields in order.
  requestAnimationFrame(() => section.focus({ preventScroll: true }));
}

/**
 * Put it away.
 *
 * Exported because Escape closes panels app-wide - see cmds.closeSidebar in
 * main.js - and because leaving Mobile takes the masthead with it, which would
 * otherwise leave a panel of controls open over a board that no longer has the
 * thing they style.
 */
export function closePanel() {
  if (!panel) return;
  sliderFocus?.clear();
  setPanelOpen(false);
}

function setPanelOpen(want) {
  panel.classList.toggle('is-open', want);
  panel.setAttribute('aria-hidden', String(!want));
  button.setAttribute('aria-expanded', String(want));
}

/**
 * Every dial in this panel back to where it started.
 *
 * setSetting() rather than a reach into `board.settings`, so it is one undoable
 * step like any other change to the masthead, and it is skipped entirely on a
 * masthead already at its defaults - the comparison is inside setSetting().
 *
 * The rebuild is not optional: the face goes back to Default, and the axis
 * sliders below it belong to whichever face was chosen. paint() alone would
 * leave the outgoing face's axes standing there, holding values the board no
 * longer carries.
 */
function resetHeader() {
  update({ ...DEFAULT_MOBILE_HEADER, axes: {} });
  buildControls();
  paint();
}

function changeFont() {
  const font = fontSelect.value;
  const axes = availableAxes(font);
  const values = {};
  for (const axis of axes) {
    if (axis.tag !== 'wght' && axis.tag !== 'ital') values[axis.tag] = axis.default;
  }
  const weight = axes.find(axis => axis.tag === 'wght')?.default ?? header().weight;
  update({ font, weight, axes: values });
  buildAxisControls();
  paint();
}

function buildControls() {
  const selected = header().font;
  fontSelect.replaceChildren();
  for (const face of headerFontOptions()) {
    const option = document.createElement('option');
    option.value = face.value;
    option.textContent = face.label;
    option.style.fontFamily = face.stack || 'inherit';
    fontSelect.append(option);
  }
  fontSelect.value = selected;
  // A face from a newer board version may no longer be registered. Falling
  // back visually must not rewrite the board merely because its bytes failed.
  if (fontSelect.value !== selected) fontSelect.value = '';
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

/**
 * The weight control, in whichever of its three states this face calls for.
 *
 * A variable face gets the axis itself: a continuous slider from its own
 * minimum to its own maximum, reading out the number, because on a face with a
 * weight axis every value between those two is a real drawing.
 *
 * A face without one gets a slider all the same - the same instrument as the
 * whimsy dial, an index across named stops with the names printed under the
 * track. It was a dropdown, and a dropdown was the wrong shape twice: it hid
 * the choice behind a tap when there are only two of them, and it sat beside a
 * row of sliders looking like a different kind of decision than the one it is.
 *
 * And a face that has no weights to offer gets nothing. See
 * headerFontWeights() - a static file dropped onto the board is one instance
 * of a family, and every stop but its own would be the browser inventing a
 * bold. The host comes down rather than showing a dial with one stop on it.
 */
function buildWeight(axis) {
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
      set: weight => {
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

  const label = document.createElement('label');
  label.className = 'field';
  const head = document.createElement('span');
  head.textContent = 'Weight';
  // The value is a position in the list, not a weight: the stops are 400 and
  // 700 today and a range that stepped in hundreds between them would offer
  // three settings that do not exist. Same reason the whimsy dial is 0 to 2.
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = String(stops.length - 1);
  input.step = '1';
  const names = document.createElement('span');
  names.className = 'field-stops';
  names.setAttribute('aria-hidden', 'true');
  for (const stop of stops) {
    const name = document.createElement('span');
    name.textContent = stop.label;
    // Each name set in the weight it names, the way the whimsy stops are each
    // set in their own tier: the label is the specimen as well as the word.
    name.style.fontWeight = String(stop.value);
    names.append(name);
  }
  // The printed stops are what a sighted user reads; a screen reader gets the
  // same names off the thumb rather than "3 of 5".
  const describe = index => {
    input.setAttribute('aria-valuetext', stops[index]?.label || '');
  };
  input.addEventListener('input', () => {
    const index = clamp(Math.round(+input.value), 0, stops.length - 1);
    describe(index);
    update({ weight: stops[index].value });
  });
  label.append(head, input, names);
  weightHost.append(label);
  weightControl = {
    input,
    out: null,
    set: weight => {
      const index = nearestStop(stops, weight);
      input.value = String(index);
      describe(index);
    },
  };
}

/** The stop a stored weight lands on - the nearest, never nothing. */
function nearestStop(stops, weight) {
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i].value - weight) < Math.abs(stops[best].value - weight)) best = i;
  }
  return best;
}

function rangeControl(labelText, axis) {
  const label = document.createElement('label');
  label.className = 'field';
  const head = document.createElement('span');
  const text = document.createElement('span');
  text.textContent = labelText;
  const out = document.createElement('output');
  head.append(text, out);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(axis.min);
  input.max = String(axis.max);
  input.step = String(axisStep(axis));
  label.append(head, input);
  return { label, input, out, axis };
}

function paint() {
  const style = header();
  const axes = availableAxes();
  applyTitleStyle(style, axes);
  paintButton();

  // Desktop has no masthead, so it has no panel either. Closed rather than
  // emptied: the controls stay wired and keep their values, and the sheet that
  // styles a thing which is not on the board goes away with it.
  if (board.layoutMode !== 'mobile') closePanel();
  fontSelect.value = style.font;
  sizeInput.value = String(style.size);
  sizeOut.textContent = `${formatAxis(style.size)}%`;
  stretchInput.value = String(style.stretch);
  stretchOut.textContent = `${formatAxis(style.stretch)}%`;
  leadingInput.value = String(style.leading);
  leadingOut.textContent = leadingText(style.leading);
  italicInput.checked = style.italic;
  wrapInput.checked = style.wrap;

  const weightAxis = axes.find(axis => axis.tag === 'wght');
  // set() rather than a value written straight onto the input: on a face with
  // no axis the control is an index across named stops, and 700 is a weight,
  // not a position. The two kinds of control each know how to show one.
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

function applyTitleStyle(style, axes) {
  const title = el('mobile-board-title');
  const stack = headerFontStack(style.font);
  if (stack) title.style.fontFamily = stack;
  else title.style.removeProperty('font-family');
  title.style.setProperty('--mobile-title-scale', formatAxis(style.size / 100));
  title.style.setProperty('--mobile-title-stretch', formatAxis(style.stretch / 100));
  // Cleared rather than set to a number at the default, so the stylesheet's
  // `line-height: normal` comes back and the masthead is spaced by the face's
  // own metrics again - which is the one value no number here can express.
  if (style.leading === 100) title.style.removeProperty('line-height');
  else title.style.lineHeight = formatAxis(style.leading / 100);
  title.style.fontWeight = String(style.weight);
  title.style.fontStyle = axes.some(axis => axis.tag === 'ital')
    ? 'normal'
    : style.italic ? 'italic' : 'normal';
  title.style.fontVariationSettings = variationSettings(style, axes) || 'normal';
  // An attribute rather than an inline white-space, because not wrapping is
  // three declarations and not one - see #mobile-board-title[data-nowrap] in
  // app.css, where the other two are what keeps an over-long name centred on
  // the board instead of starting at its left edge.
  title.toggleAttribute('data-nowrap', !style.wrap);
  // Last, and after the attribute: every line above changes how wide the name
  // is set, and the measurement is only worth taking once they have all landed.
  scheduleFit();
}

/**
 * Shrink an unwrapped name until it is inside the board.
 *
 * The wrap is how CSS fits text to a width, and the wrap switch takes it away:
 * with `white-space: pre` a name longer than the strip simply carries on past
 * both edges and the band clips it. There is no CSS for "make this line fit" -
 * no container query on your own overflow, no font-size that responds to the
 * text it is setting - so the width is measured here and the shortfall written
 * back as --mobile-title-fit, which app.css multiplies into the font size.
 *
 * Measured with the fit at 1, because the number being computed is the ratio
 * between the *unfitted* line and the room, and measuring the shrunk line would
 * hand back 1 every time and leave the name at whatever size it happened to
 * reach. Two reads of layout, both in a frame callback, and only when something
 * that could change the answer has happened.
 *
 * The floor is a floor and not a fit: past it the name is a hairline nobody can
 * read, and a name clipped at the board's edge is the better failure. Nothing
 * here runs while the name wraps - that case fits itself.
 */
const FIT_FLOOR = 0.25;
let fitFrame = 0;

function scheduleFit() {
  if (fitFrame || typeof requestAnimationFrame !== 'function') return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitTitle();
  });
}

function fitTitle() {
  const title = el('mobile-board-title');
  const band = el('mobile-board-header');
  if (!title || !band) return;
  if (board.layoutMode !== 'mobile' || header().wrap) {
    title.style.removeProperty('--mobile-title-fit');
    return;
  }
  title.style.setProperty('--mobile-title-fit', '1');
  const room = band.clientWidth;
  const line = title.offsetWidth;
  if (!room || !line || line <= room) {
    title.style.removeProperty('--mobile-title-fit');
    return;
  }
  // Floored rather than rounded, at three places: a ratio rounded up is a line
  // a fraction of a pixel too wide, which is a name that still touches the edge
  // it was measured to clear.
  const fit = Math.max(FIT_FLOOR, Math.floor((room / line) * 1000) / 1000);
  title.style.setProperty('--mobile-title-fit', String(fit));
}

function paintButton() {
  const visible = board.layoutMode === 'mobile' && !!viewport?.atMobileTop?.();
  button.hidden = !visible;
  button.setAttribute('aria-hidden', String(!visible));
}

/** What "Default" resolves to right now: the display face the look is set in. */
function displayStack() {
  return typeof getComputedStyle === 'function'
    ? getComputedStyle(document.documentElement).getPropertyValue('--font-display')
    : '';
}

function availableAxes(font = header().font) {
  return headerFontAxes(font, displayStack());
}

function update(patch) {
  const current = header();
  setSetting('mobileHeader', {
    ...current,
    ...patch,
    axes: patch.axes ? { ...patch.axes } : { ...current.axes },
  });
}

function header() {
  return board.settings.mobileHeader || DEFAULT_MOBILE_HEADER;
}

function axisLabel(tag) {
  if (AXIS_LABELS[tag]) return AXIS_LABELS[tag];
  return tag.trim() || 'Axis';
}

function formatAxis(value) {
  return String(Math.round(+value * 100) / 100);
}
