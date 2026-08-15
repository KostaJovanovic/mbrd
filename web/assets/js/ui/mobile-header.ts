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
  board, bus, DEFAULT_MOBILE_HEADER, setSetting, mobileBoardWorldWidth,
} from '../state.ts';
import { clamp, el, readToken } from '../util.ts';
import {
  headerFontAxes, headerFontOptions, headerFontSize, headerFontStack,
  headerFontWeights,
} from './fonts.ts';
import { createMobileSliderFocus } from './sidebar.ts';
import { field, fieldStops } from './controls.ts';
import { paintTitleField, wireTitleField } from './board-title.ts';
import { registerPanel, panelShown, panelHidden } from './panel-stack.ts';
import { open as openSearch } from './search.ts';
import type { FontAxis, MobileHeader } from '../board-model.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { SliderFocus } from './sidebar.ts';

/** One weight stop, as headerFontWeights() lists them. */
type WeightStop = { value: number; label: string };

/**
 * One axis slider: the row, the track, the readout and the axis it is set from.
 *
 * `out` is not optional here although field() answers with a nullable one - see
 * rangeControl(), which is the only thing that builds these and always asks for
 * a readout.
 */
type AxisControl = {
  label: HTMLLabelElement;
  input: HTMLInputElement;
  out: HTMLOutputElement;
  axis: FontAxis;
};

/**
 * The weight control in either of its two shapes - see buildWeight().
 *
 * `set` is what the two have in common and the reason this is one type: a
 * variable face's control takes a weight, and a static face's takes the same
 * weight and finds the stop it lands on. Neither caller has to know which.
 */
type WeightControl = {
  input: HTMLInputElement;
  out: HTMLOutputElement | null;
  set: (weight: number) => void;
};

/**
 * A four-letter tag, in words.
 *
 * Not a whitelist - axisLabel() falls back to the tag itself, so an axis nobody
 * here has heard of still gets a slider with "ZZZZ" over it. This only decides
 * whether the label is readable, and every tag a real family has shipped is
 * worth having in it: `wght` and `ital` never appear (the weight control and the
 * italic switch own those), and the rest are what is left.
 */
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

// Every element below is read out of the markup by id and cast to what
// index.html declares it as - the panel's fields are static markup, the ids are
// checked against that file by tests/element-ids.test.js, and an absent or
// differently-shaped one is a broken build rather than a state to paint around.
// It is the reading ui/hud.ts states at length, and the `as` ui/sidebar.ts and
// ui/color-picker.ts make on the same kind of lookup.
let viewport: Viewport | null;
let button: HTMLElement;
let findBtn: HTMLElement;
let panel: HTMLElement;
let sliderFocus: SliderFocus;
let section: HTMLElement;
let titleInput: HTMLInputElement;
let fontSelect: HTMLSelectElement;
let sizeInput: HTMLInputElement;
let sizeOut: HTMLElement;
let stretchInput: HTMLInputElement;
let stretchOut: HTMLElement;
let leadingInput: HTMLInputElement;
let leadingOut: HTMLElement;
let offsetInput: HTMLInputElement;
let offsetOut: HTMLElement;
let italicInput: HTMLInputElement;
let wrapInput: HTMLInputElement;
let weightHost: HTMLElement;
let axesHost: HTMLElement;
let weightControl: WeightControl | null = null;
const axisControls = new Map<string, AxisControl>();

export function initMobileHeaderEditor(vp: Viewport | null) {
  viewport = vp;
  button = el('mobile-header-edit-btn')!;
  panel = el('header-panel')!;
  section = el('mobile-header-settings')!;
  titleInput = el('header-title') as HTMLInputElement;
  fontSelect = el('mobile-header-font') as HTMLSelectElement;
  sizeInput = el('mobile-header-size') as HTMLInputElement;
  sizeOut = el('mobile-header-size-out')!;
  stretchInput = el('mobile-header-stretch') as HTMLInputElement;
  stretchOut = el('mobile-header-stretch-out')!;
  leadingInput = el('mobile-header-leading') as HTMLInputElement;
  leadingOut = el('mobile-header-leading-out')!;
  offsetInput = el('mobile-header-offset') as HTMLInputElement;
  offsetOut = el('mobile-header-offset-out')!;
  italicInput = el('mobile-header-italic') as HTMLInputElement;
  wrapInput = el('mobile-header-wrap') as HTMLInputElement;
  weightHost = el('mobile-header-weight')!;
  axesHost = el('mobile-header-axes')!;

  sliderFocus = createMobileSliderFocus(panel);
  panel.addEventListener('pointerdown', e => sliderFocus.begin(e.target as Element | null, e.pointerId));
  const endSliderFocus = (e: PointerEvent) => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  panel.addEventListener('lostpointercapture', endSliderFocus, true);

  // Written as a toggle although the panel covers this corner while it is up -
  // the pen fades and stops taking presses, so in practice the close button and
  // Escape are the ways out. It is a toggle anyway because that is what the
  // button *means*, and because a fade that is interrupted mid-way leaves a
  // pressable pen in front of an open panel for a fraction of a second.
  button.addEventListener('click', () => (isPanelOpen() ? closePanel() : openPanel()));
  el('header-close')!.addEventListener('click', closePanel);
  // Find, the phone's only way into the palette (the desktop toolbar button is
  // data-desktop and there is no Ctrl+K or right-click on touch). It rides the
  // Mobile board whichever lens is up, so unlike the pen it is not lens-gated.
  findBtn = el('mobile-find-btn')!;
  // The button, so a second tap closes rather than discarding the query and
  // rebuilding an empty palette - see open() in ui/search.ts.
  findBtn.addEventListener('click', () => openSearch(findBtn));
  // The name at the top of the panel, on ui/board-title.js's wiring rather than
  // on its own. It is the same field the sidebar's Board section has, and a
  // rename typed into either shows in the other because both are painted from
  // `board.title` on the same 'board' event - which is also how it stays in step
  // with the inline caret on the masthead and on the title card.
  wireTitleField(titleInput);
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
  offsetInput.addEventListener('input', () => {
    const value = Math.round(+offsetInput.value);
    update({ offset: value });
    offsetOut.textContent = offsetText(value);
  });
  italicInput.addEventListener('change', () => update({ italic: italicInput.checked }));
  wrapInput.addEventListener('change', () => update({ wrap: wrapInput.checked }));
  el('mobile-header-reset')!.addEventListener('click', resetHeader);

  // The three ways the fit can go stale that are not a change to these
  // controls: the name itself, letter by letter while it is being renamed and
  // once more when the rename lands, and the width of the strip it is set
  // across. A ResizeObserver rather than the viewport's own onChange, which
  // fires on every frame of a pan and would put a layout read in each of them -
  // the band only ever changes width when the window does.
  const title = el('mobile-board-title')!;
  title.addEventListener('input', scheduleFit);
  // 'board' is also how a rename made anywhere else - the sidebar's copy of this
  // field, the tap on the masthead, the title card - reaches the field above.
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
  // Feed <-> Playlist: the pen shows over the Feed and hides on the Playlist, so it
  // repaints when the lens changes (which does not emit 'layout').
  bus.on('lens', paintButton);
  // The Feed says when its title page scrolls in and out of view; the pen goes
  // with it. See paintButton() and the observer in ui/feed.js.
  bus.on('feed:masthead', on => { mastheadOnScreen = !!on; paintButton(); });
  // The edit bar is one of the exclusive right-side panels: it and the player hide
  // and restore each other through the stack.
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
    // Default follows --font-display, which the whimsy axis may replace.
    else if (key === 'appearance' && !header().font) {
      buildAxisControls();
      paint();
    }
  });
  // The title card mounts, unmounts and remounts through the delete/restore
  // button and layout switches; each time, its freshly-built node needs the
  // style written onto it. Deferred a microtask because canvas/items.js mounts
  // the node in its own 'items' handler, which runs after this one - so the node
  // exists by the time this fires. Cheap: a querySelector and a few writes.
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
const snapStretch = (value: number) =>
  (Math.abs(value - 100) <= STRETCH_DETENT ? 100 : value);

/** 100 is the face's own line height, and says so rather than showing "100%". */
const leadingText = (value: number) => (+value === 100 ? 'Auto' : `${formatAxis(value)}%`);

/** 0 sits the name in the middle of the band; either way of it reads as a way. */
const offsetText = (value: number) =>
  (+value === 0 ? 'Center' : `${+value < 0 ? 'Up' : 'Down'} ${Math.abs(+value)}%`);

/** A useful slider step across small fractions and very broad design spaces. */
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
  // The sticker drawer shares this right edge: opening the edit bar hides it
  // (and remembers it, to bring back when this closes) through the stack.
  panelShown('header');
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
  // If the drawer was hidden to make room for this bar, closing it brings the
  // drawer back (ignored when the coordinator is the one closing us).
  panelHidden('header');
}

function setPanelOpen(want: boolean) {
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
  const values: Record<string, number> = {};
  for (const axis of axes) {
    if (axis.tag !== 'wght' && axis.tag !== 'ital') values[axis.tag] = axis.default;
  }
  const weight = axes.find(axis => axis.tag === 'wght')?.default ?? header().weight;
  // A face may ask to open at a size of its own; only Playfair does. Falling
  // back to the size already set, rather than to the default, is what keeps
  // this from undoing a size somebody chose merely because they went looking
  // through the face menu.
  const size = headerFontSize(font) ?? header().size;
  update({ font, weight, size, axes: values });
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

  // No readout: the stops printed under the track are the value, the way the
  // whimsy and quality dials read as words rather than numbers.
  const { label } = field('Weight');
  // The value is a position in the list, not a weight: the stops are 400 and
  // 700 today and a range that stepped in hundreds between them would offer
  // three settings that do not exist. Same reason the whimsy dial is 0 to 2.
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = String(stops.length - 1);
  input.step = '1';
  // Each name set in the weight it names, the way the whimsy stops are each set
  // in their own tier: the label is the specimen as well as the word.
  const names = fieldStops(stops, { specimen: s => ({ fontWeight: String(s.value) }) });
  // The printed stops are what a sighted user reads; a screen reader gets the
  // same names off the thumb rather than "3 of 5".
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

/** The stop a stored weight lands on - the nearest, never nothing. */
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
  // `out` is asserted because it was asked for on the line above, which is the
  // only thing that makes field() build one.
  return { label, input, out: out!, axis };
}

function paint() {
  paintTitleField(titleInput);
  const style = header();
  const axes = availableAxes();
  const masthead = el('mobile-board-title');
  if (masthead) applyTitleStyle(masthead, style, axes);
  // The name-fit shrink for both the masthead and the card (fitTitle does each),
  // so an unwrapped name never runs off either box.
  scheduleFit();
  styleTitleCard(style, axes);
  paintButton();

  // The panel styles the board name, which now lives in both layouts - the
  // masthead on Mobile, the title card on Desktop - so it is valid open in
  // either. It is closed only by its own controls (Escape, the close button) and
  // by leaving a mode that has neither, which never happens now.
  fontSelect.value = style.font;
  sizeInput.value = String(style.size);
  sizeOut.textContent = `${formatAxis(style.size)}%`;
  stretchInput.value = String(style.stretch);
  stretchOut.textContent = `${formatAxis(style.stretch)}%`;
  leadingInput.value = String(style.leading);
  leadingOut.textContent = leadingText(style.leading);
  offsetInput.value = String(style.offset ?? 0);
  offsetOut.textContent = offsetText(style.offset ?? 0);
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

/** The Desktop title card's text node, or null when it is not on the board. */
function titleCardEl() {
  return document.querySelector<HTMLElement>('.item[data-type="title"] .title-name');
}

/**
 * Write the shared masthead style onto whichever element is passed - the Mobile
 * masthead or the Desktop title card's name. Both read the same custom
 * properties; the CSS turns them into a font size against each element's own
 * context (the strip width for one, the card's own width for the other), which
 * is the only part that differs. The name-fit shrink (fitTitle) applies to both
 * now, and is scheduled by the caller, not written here.
 */
function applyTitleStyle(title: HTMLElement, style: MobileHeader, axes: FontAxis[]) {
  const stack = headerFontStack(style.font);
  if (stack) title.style.fontFamily = stack;
  else title.style.removeProperty('font-family');
  title.style.setProperty('--mobile-title-scale', formatAxis(style.size / 100));
  // The cap, handed to CSS rather than written there, so the masthead's clamp
  // and the card's own arithmetic (styleTitleCard) read one number. See
  // TITLE_CAP for why it is a ratio and not the 96px it replaced.
  title.style.setProperty('--mobile-title-cap', String(TITLE_CAP));
  title.style.setProperty('--mobile-title-stretch', formatAxis(style.stretch / 100));
  // A plain number; the CSS turns it into a fraction of the band height so the
  // nudge holds its proportion at any font size. See the transform there.
  title.style.setProperty('--mobile-title-offset', String(style.offset ?? 0));
  // Cleared rather than set to a number at the default, so the stylesheet's
  // `line-height: normal` comes back and the masthead is spaced by the face's
  // own metrics again - which is the one value no number here can express.
  if (style.leading === 100) title.style.removeProperty('line-height');
  else title.style.lineHeight = formatAxis(style.leading / 100);
  // Always written, never cleared - unlike `leading` above, which hands its
  // default back to the stylesheet. The board's name is deliberately the one
  // piece of display type the whimsy axis does not set: it is board state, the
  // same number on every tier, and it renders the same at whimsy 0 and 1. That
  // is a choice and not an oversight, so an inline weight is the honest way to
  // write it - clearing it at the default would let --display-weight through
  // and make the middle a step lighter.
  title.style.fontWeight = String(style.weight);
  title.style.fontStyle = axes.some(axis => axis.tag === 'ital')
    ? 'normal'
    : style.italic ? 'italic' : 'normal';
  title.style.fontVariationSettings = variationSettings(style, axes) || 'normal';
  // An attribute rather than an inline white-space, because not wrapping is
  // three declarations and not one - see #mobile-board-title[data-nowrap] in
  // canvas.css, where the other two are what keeps an over-long name centred on
  // the board instead of starting at its left edge.
  title.toggleAttribute('data-nowrap', !style.wrap);
}

/**
 * Style and fit the Mobile feed's masthead - the same title page the world-space
 * masthead is, on the same two rules.
 *
 * The style is the shared header typography (face, size, stretch, weight, italic,
 * axes, leading, offset, wrap), so an edit from this panel reaches it on the next
 * 'settings' emit. The fit is the other half the first version dropped: fitOne()
 * shrinks the name to TITLE_LINES lines when wrapping and to one line when not,
 * measured against the band `box` - which is what keeps the name inside the 3:2
 * title page rather than overflowing or clamping it. Synchronous, since the feed
 * calls this off its own paints rather than the pan frame; each read forces the
 * layout it needs. The caller sets --mobile-board-width (the strip the size is a
 * fraction of) on the title before calling.
 */
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
  // Match the masthead's *effective* size, clamp and all. The masthead caps its
  // font at 96px (and floors it at 20px) against the mobile board's width, so a
  // wide board's name is smaller relative to its box than the raw size dial says
  // - the 512-wide board caps, the 256-wide card would not, so the same dial ran
  // the card's text larger and it wrapped where the masthead did not (measured:
  // card ratio 0.20 vs masthead 0.1875). The card has no screen width of its own
  // to clamp against, so the ratio is computed here against the mobile board's
  // width and handed over as --mobile-title-ratio, which the card multiplies by
  // its own width (100cqw) in the CSS. The two then wrap identically.
  //
  // From mobileBoardWorldWidth(), not viewport.mobileWorldWidth: the viewport
  // holds the *active* layout's figure, and on Desktop that is the Desktop grid
  // and its mobileColumns default (6, so 6x64=384) - which skips the 96px cap
  // the real 8x64=512 masthead hits and made the card wrap sooner. This reads
  // the Mobile layout's own width whatever layout is showing.
  const ref = mobileBoardWorldWidth() || 512;
  const px = Math.min(ref * TITLE_CAP, Math.max(20, ref * (style.size / 100)));
  card.style.setProperty('--mobile-title-ratio', String(px / ref));
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
 * back as --mobile-title-fit, which the CSS multiplies into the font size.
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

/**
 * How many lines a board's name is set on before it is shrunk to fit them.
 *
 * Two, and it is a rule rather than a preference: the masthead and the Desktop
 * title card are one name in two places, and a name that breaks after "New" in
 * one and after "board" in the other reads as two different boards. Two lines is
 * what the default name wants, and holding both to the same number is what makes
 * the two agree at every size.
 *
 * The wrap is still what does the breaking - this only decides how much room it
 * is given to do it in. A name too long to reach two lines by the floor below is
 * left at the floor and clipped by the -webkit-line-clamp in the CSS, which is
 * the same failure it had before.
 */
const TITLE_LINES = 2;

/**
 * The largest a name may be set relative to the board it is set across.
 *
 * 0.1875 is 96/512 - the absolute 96px cap this replaces, over the 512-unit
 * Mobile board it was chosen against. The absolute cap was the bug: the size
 * dial asks for a *fraction* of the board (width x size/100), so once that
 * fraction crossed 96px the name stopped growing while the board kept going,
 * and the same setting gave a different name-to-box ratio on a 416-wide phone
 * than on the 512 the Desktop card normalises against. The two then wrapped
 * differently, which is exactly what a shared style must not do. As a ratio it
 * caps the same way at every width, and the card (which computes its own cap in
 * styleTitleCard below) and the masthead (which reads it through CSS) cannot
 * drift apart.
 */
const TITLE_CAP = 0.1875;

/**
 * How many lines the name is currently set on.
 *
 * A Range's client rects come one per line fragment, which is the only honest
 * count: dividing the box height by the line height assumes a numeric
 * line-height, and this one is `normal` by default - the face's own metrics,
 * which no number here knows. Rects are grouped by their top edge because a line
 * holding more than one inline box reports one rect each.
 */
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

/**
 * Shrink a wrapped name until it is set on TITLE_LINES lines or fewer.
 *
 * Searched rather than solved. A line's worth of text scales with the font, so
 * the arithmetic answer is lines-wanted over lines-got - but the wrap only
 * breaks at words, and `text-wrap: balance` moves the breaks as the size
 * changes, so that answer overshoots and leaves the name smaller than it needs
 * to be. Six halvings between the floor and no shrink at all find the largest
 * size that still fits, to about a percent, for six reads of layout in one frame
 * callback. It runs only when something that could change the answer has
 * happened - see scheduleFit.
 */
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
    // Bigger means more lines, so a size that fits is a new lower bound to beat.
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
  // The masthead fits only on Mobile; the card is Desktop-only. Each is measured
  // against its own box - the strip for the masthead, the card for the card -
  // and against the same rule, which is what keeps one name from breaking in two
  // different places on the two boards.
  fitOne(el('mobile-board-title'), el('mobile-board-header'),
    wrap, board.layoutMode !== 'mobile');
  const cardName = titleCardEl();
  fitOne(cardName, cardName?.closest('.title-card') ?? null, wrap, false);
}

/**
 * Fit one name to its box: to a line when the wrap is off, to TITLE_LINES lines
 * when it is on. `off` is the "not on this layout" case, which clears the shrink
 * rather than computing one for a box nobody is looking at.
 *
 * The wrapped half used to do nothing at all, on the reasoning that a wrapped
 * name fits itself. It does - into however many lines it takes, which is not the
 * same promise. The unwrapped half is unchanged: measured with the fit at 1, so
 * the ratio is between the *unfitted* line and the room rather than between the
 * shrunk line and the room, and floored rather than rounded so a line a fraction
 * of a pixel too wide is not called a fit.
 */
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

/** What the button was last set to, so a scroll writes nothing - see below. */
let buttonShown: boolean | null = null;

/**
 * Whether the Feed's title page is on screen, as the Feed last reported it.
 *
 * True to start, and that is the safe default rather than an optimistic one: a
 * board that has not scrolled yet is at the top, and any path where the observer
 * never runs - an engine without IntersectionObserver, a lens that was never
 * built - should leave the pen reachable rather than permanently hidden.
 */
let mastheadOnScreen = true;

function paintButton() {
  // In the lens era the world-space canvas is dormant behind the Feed, so its
  // scroll stop (atMobileTop) no longer tracks the masthead - the masthead is the
  // Feed's, at the top of its own sheet. The pen shows over the Feed and comes down
  // on the Playlist (album hero, not the editable title page) and on Desktop (the
  // title card carries its own edit there).
  //
  // And on the Feed it comes down again once that title page has scrolled away.
  // The pen edits the page and only the page: the panel it opens is the board
  // name, its face, size, stretch and weight, every one of which paints onto the
  // masthead. Left riding the whole wall it is a control for something that is
  // not on the screen, sitting over the photographs that are. The Feed announces
  // the crossing on 'feed:masthead' (see the observer in ui/feed.js), which is
  // also why this stays a plain boolean here - the module that can see the
  // scroller is the one that decides, and this one only wears the answer.
  const lens = document.documentElement.dataset.feedLens;
  const visible = board.layoutMode === 'mobile' && lens !== 'playlist' && mastheadOnScreen;
  // This runs on every view change, and the answer changes exactly twice in a
  // scroll - on leaving the top stop and on returning to it. Writing it on
  // every frame in between is two attribute sets a frame to arrive at the state
  // already there, which is the one thing every other view listener in this app
  // guards against (see paintZoom() in main.js and draw() in ui/scalebar.js).
  if (visible === buttonShown) return;
  buttonShown = visible;
  button.hidden = !visible;
  button.setAttribute('aria-hidden', String(!visible));
}

/** The Find button rides the whole Mobile board, on either lens - so it is gated on
 *  the layout alone, not on the feed lens the way the pen is. */
function paintFind() {
  if (!findBtn) return;
  findBtn.hidden = board.layoutMode !== 'mobile';
}

/** What "Default" resolves to right now: the display face the look is set in. */
function displayStack() {
  // The guard stays: this is reached from availableAxes(), which the panel calls
  // while deciding what to draw, and there is no document behind that call in a
  // test. readToken() would throw rather than answer '' - which is a real
  // answer here, since "no computed stack" and "the empty stack" mean the same
  // thing to headerFontAxes().
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
  // card are one style set in one place. See state.js.
  return board.mobileHeader || DEFAULT_MOBILE_HEADER;
}

function axisLabel(tag: string) {
  // The table is keyed by the tags it happens to know; a tag it does not is the
  // fallback below, which is what the note over AXIS_LABELS says it is for.
  const known = (AXIS_LABELS as Record<string, string>)[tag];
  if (known) return known;
  return tag.trim() || 'Axis';
}

function formatAxis(value: number) {
  return String(Math.round(+value * 100) / 100);
}
