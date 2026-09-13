// Sidebar panel, built from ui/settings-schema.ts. Built once, never rebuilt.
// paint() writes values and toggles `hidden`. Controls that do not apply are
// hidden (not disabled). Three tab panels all in the DOM, one visible at a time.

// Layout mode decides what is on screen — ui/sidebar.ts owns the subscription.
import { board } from '../state.ts';
import { makeEl as make } from '../util.ts';
import { cue } from '../cuelume/engine.ts';
import { isPatchPage } from '../page.ts';
import { field, fieldStops } from './controls.ts';
import { tickSlider } from './controls.ts';
import { setMarked } from './wordmark.ts';
import {
  TABS, SECTIONS, controlVisible, controlEnabled, sectionVisible,
} from './settings-schema.ts';
import { openAnchored, justDismissed } from './menu.ts';
import type {
  ButtonsControl, CheckControl, Control, Ctx, HintControl, KeysControl,
  PickerControl, RangeControl, SelectControl, Section, SlotControl, TextControl,
} from './settings-schema.ts';

/**
 * One built control: its spec, the heading it came from, what to hide, and
 * what to write into.
 *
 * `owner` exists for one question only - whether the control needs a board,
 * which a section may answer on behalf of everything under it.
 */
type Built = {
  c: Control,
  owner: Section,
  wrap: HTMLElement,
  input: HTMLInputElement | HTMLSelectElement | null,
  out: HTMLOutputElement | null,
  nodes: HTMLElement[] | null,
};

/** Every built control, in build order. */
const built: Built[] = [];
/** section id -> its <section> element. */
const sections = new Map<string, HTMLElement>();
/** tab id -> { tab, panel }. */
const tabs = new Map<string, { tab: HTMLButtonElement, panel: HTMLElement }>();

let currentTab = TABS[0].id;

/**
 * Which heading is being built, for the length of buildSection() and no
 * longer. None of the eight builders is handed the section directly - only
 * the control - so this is where the loop above them leaves the one fact
 * about the *heading* they'd otherwise all need threaded through.
 */
let building: Section | null = null;

const ctx = (): Ctx => ({
  mobile: board.layoutMode === 'mobile',
  patch: isPatchPage(),
});

/**
 * Build the whole panel into a sidebar shell.
 *
 * Called from main.ts *before* initAppearance() and initAudio(), since both
 * look up controls this makes. Every button carries `data-cmd` and is
 * answered by the delegated listener in ui/sidebar.ts, so nothing here needs
 * `cmds`.
 */
export function buildPanel(root = document.getElementById('sidebar')) {
  const strip = root?.querySelector<HTMLElement>('.side-tabs');
  const body = root?.querySelector<HTMLElement>('.side-body');
  if (!strip || !body) return;
  built.length = 0;
  sections.clear();
  tabs.clear();
  strip.replaceChildren();
  body.replaceChildren();

  for (const t of TABS) {
    const tab = make('button', 'side-tab');
    tab.type = 'button';
    tab.id = `tab-${t.id}`;
    tab.textContent = t.label;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${t.id}`);
    tab.addEventListener('click', () => { cue('pick'); showTab(t.id); });
    strip.append(tab);

    const panel = make('div', 'side-panel');
    panel.id = `panel-${t.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    body.append(panel);

    tabs.set(t.id, { tab, panel });
  }

  strip.setAttribute('role', 'tablist');
  // Removed first, so a second build does not leave two listeners on one
  // strip. `strip` itself survives every rebuild, unlike its children.
  strip.removeEventListener('keydown', onTabKey);
  strip.addEventListener('keydown', onTabKey);

  for (const section of SECTIONS) {
    const panel = tabs.get(section.tab)?.panel;
    if (panel) panel.append(buildSection(section));
  }

  showTab(TABS[0].id);
  paintPanel();
}

/**
 * The tab strip's keyboard, which is what makes it a tablist rather than
 * three buttons. Arrows move and select in one go - with three tabs and no
 * expensive panel to build, a separate Enter to commit buys nothing.
 */
function onTabKey(e: KeyboardEvent) {
  const order = TABS.map(t => t.id);
  const i = order.indexOf(currentTab);
  let next: string | undefined;
  if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
  else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
  else if (e.key === 'Home') next = order[0];
  else if (e.key === 'End') next = order[order.length - 1];
  if (!next) return;
  e.preventDefault();
  showTab(next);
  tabs.get(next)?.tab.focus();
}

/** Show one tab. Roving tabindex, so the strip is one stop in the tab order. */
function showTab(id: string) {
  if (!tabs.has(id)) return;
  currentTab = id;
  for (const [key, { tab, panel }] of tabs) {
    const on = key === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle('is-on', on);
    panel.hidden = !on;
  }
}

// ---------------------------------------------------------------------------
// Sections and controls
// ---------------------------------------------------------------------------

function buildSection(spec: Section) {
  const el = make('section', 'side-sec');
  el.id = `sec-${spec.id}`;
  if (spec.title) {
    const h2 = make('h2');
    h2.textContent = spec.title;
    el.append(h2);
  }

  // The fold is assembled first and appended last, so a section reads in the
  // schema's order without `advanced` needing to be a nesting level in the data.
  let fold: HTMLDetailsElement | null = null;
  building = spec;
  for (const c of spec.controls) {
    const node = buildControl(c, spec);
    if (!node) continue;
    if (!c.advanced) { el.append(node); continue; }
    if (!fold) fold = buildFold(spec);
    fold.append(node);
  }
  building = null;
  if (fold) el.append(fold);
  if (spec.id) sections.set(spec.id, el);
  return el;
}

function buildFold(spec: Section) {
  const details = make('details', 'advanced');
  // A section with no heading has every control advanced, so the summary
  // stands where an h2 would and needs that spacing, not a tail hanging off
  // a list of rows.
  if (!spec.title) details.classList.add('is-head');
  if (spec.foldId) details.id = spec.foldId;
  const summary = make('summary');
  summary.textContent = spec.fold || 'Advanced';
  details.append(summary);
  return details;
}

function buildControl(c: Control, _spec: Section) {
  // SAFETY: BUILDERS is a mapped type over Control['type'], so the value
  // under `c.type` is by construction the builder for that member -
  // TypeScript can't carry that correlation through an index lookup, so the
  // pair is asserted here once rather than at each of the eight. The
  // `| undefined` is kept and the call is optional, so an unhandled type
  // draws nothing rather than throwing.
  const build = BUILDERS[c.type] as ((spec: Control) => HTMLElement) | undefined;
  const node = build?.(c);
  if (!node) return null;
  return node;
}

const BUILDERS: { [K in Control['type']]: (c: Extract<Control, { type: K }>) => HTMLElement } = {
  text: buildText,
  check: buildCheck,
  range: buildRange,
  select: buildSelect,
  picker: buildPicker,
  buttons: buildButtons,
  slot: buildSlot,
  hint: buildHint,
  keys: buildKeys,
};

/** The board's name. ui/sidebar.ts owns what typing in it does. */
function buildText(c: TextControl) {
  const input = make('input', c.className);
  input.type = 'text';
  if (c.id) input.id = c.id;
  if (c.maxlength) input.maxLength = c.maxlength;
  if (c.placeholder) input.placeholder = c.placeholder;
  if (c.ariaLabel) input.setAttribute('aria-label', c.ariaLabel);
  input.autocomplete = 'off';
  input.spellcheck = false;
  register(c, input, input, null);
  return input;
}

function buildCheck(c: CheckControl) {
  const label = make('label', 'check');
  const input = make('input');
  input.type = 'checkbox';
  if (c.id) input.id = c.id;
  label.append(input, document.createTextNode(' ' + c.label));
  const set = c.set;
  if (!c.external && set) {
    // `pick`, not `on`/`off`: every control says `pick` when pressed, and
    // whatever it changed speaks on top of that from setSetting() - saying
    // `on` here too would be the same cue twice at a zero gap, not two
    // events but one louder one. Quality overrides have no second voice, so
    // they say only that they were pressed.
    input.addEventListener('change', () => { cue('pick'); set(input.checked); });
  }
  register(c, label, input, null);
  return label;
}

function buildRange(c: RangeControl) {
  // `silent` is a dial whose stops are named underneath rather than a value
  // worth printing (whimsy, quality) - plain label, no readout.
  const { label, out } = field(c.label, { out: !c.silent });
  if (c.fieldId) label.id = c.fieldId;
  if (out) {
    out.id = `${c.id}-out`;
    if (c.outText) out.textContent = c.outText;
  }

  const input = make('input');
  input.type = 'range';
  if (c.id) input.id = c.id;
  // Numbers in the table, strings on the element.
  if (c.min != null) input.min = String(c.min);
  if (c.max != null) input.max = String(c.max);
  if (c.step != null) input.step = String(c.step);
  if (c.value != null) input.value = String(c.value);
  label.append(input);

  if (c.stops?.length) {
    // `stopsId` where a stylesheet reaches for the row by name - the whimsy
    // stops are specimens of the three tiers, pinned by that id alone.
    const stops = fieldStops(c.stops, { id: c.stopsId || `${c.id}-stops` });
    input.setAttribute('aria-describedby', stops.id);
    label.append(stops);
  }

  const set = c.set;
  if (!c.external && set) {
    input.addEventListener('input', () => {
      writeOut(c, input, out);
      set(+input.value);
    });
    // The tick is tickSlider()'s, not this builder's - written inline once,
    // that silently missed every slider wired by its own module (Whimsy,
    // palette count, masthead, volume, hint card).
    //
    // **After the setter, load-bearing for exactly one control.** Listeners
    // fire in add order, and the Sounds dial's setter is the volume the tick
    // is about to play at - ticking first meant every stop was heard at the
    // level you'd just left. Every other dial is indifferent to the order.
    tickSlider(input);
  }
  register(c, label, input, out);
  return label;
}

function buildSelect(c: SelectControl) {
  const { label } = field(c.label);
  if (c.fieldId) label.id = c.fieldId;
  const select = make('select');
  if (c.id) select.id = c.id;
  fillSelect(c, select, ctx());
  label.append(select);
  const set = c.set;
  if (!c.external && set) {
    select.addEventListener('change', () => { cue('pick'); set(select.value); });
  }
  register(c, label, select, null);
  return label;
}

/**
 * A select that shows what it is choosing between.
 *
 * A button and ui/menu.ts's anchored panel, not a <select>: no browser
 * paints anything inside a native dropdown, so the one row whose options
 * *are* colours could not show them. Otherwise identical to a select's
 * schema entry (`options`, `get`/`set`, `external`).
 *
 * ui/menu.ts renders it, since CLAUDE.md reserves every menu to that module.
 * The value lives in `data-value` rather than a property, so a sync
 * (syncPaletteMode) and a paint read the same place, and a `pick`
 * CustomEvent carries the choice out - keeping this builder ignorant of what
 * a palette is, exactly as buildSelect is.
 */
function buildPicker(c: PickerControl) {
  const { label } = field(c.label);
  if (c.fieldId) label.id = c.fieldId;
  const btn = make('button', 'field-picker');
  btn.type = 'button';
  if (c.id) btn.id = c.id;
  btn.dataset.value = c.get?.() ?? '';
  // Rebuilt on every press rather than once: options() takes live context and
  // the tick has to follow a value anything else may have changed.
  btn.addEventListener('click', () => {
    // A second press closes rather than reopening - the menu's outside-press
    // listener has already shut it by the time this click runs.
    if (justDismissed(btn)) return;
    const now = btn.dataset.value ?? '';
    const entries = (c.options?.(ctx()) || []).map(o => ({
      label: o.label,
      // Trailing edge: these are specimens of whole palettes, not icons for
      // them, and the point is comparing them down a column.
      swatchEnd: c.swatches?.(o.value) ?? [],
      check: o.value === now,
      action: () => {
        btn.dataset.value = o.value;
        paintPicker(btn);
        // The event, not a direct call, so this builder never learns what it
        // is picking. `external` controls have no `set` at all.
        btn.dispatchEvent(new CustomEvent('pick', { detail: o.value }));
        c.set?.(o.value);
      },
    }));
    // focus: true, since this was opened by a press, not a hover flyout -
    // openAnchored() defaults it off there so a drifting pointer can't steal
    // the caret out of a text field.
    openAnchored(btn.getBoundingClientRect(), entries, { owner: btn, focus: true });
  });
  // The other direction: ui/appearance-controls.ts writes `data-value` and
  // fires this event rather than calling in, since a call would import this
  // module's chain into a cycle tests/imports.test.js refuses.
  btn.addEventListener('repaint', () => paintPicker(btn));
  paintPicker(btn);
  label.append(btn);
  // `null` for the input slot: a picker's value is an attribute this module
  // writes itself, not the <input>/<select> painting writes into.
  register(c, label, null, null);
  return label;
}

/**
 * The schema entry behind a built picker, by id - paintPicker() is called
 * from outside with nothing but the element (syncPaletteMode()), so lookup
 * has to be by id rather than identity.
 */
function pickerOf(el: HTMLElement): PickerControl | null {
  const hit = built.find(b => b.c.type === 'picker' && b.c.id && b.c.id === el.id);
  // SAFETY: the find() tested `type === 'picker'`, the discriminant, so
  // anything it answered is a PickerControl.
  return (hit?.c as PickerControl) ?? null;
}

/**
 * Write a picker's face from its stored value: the option's own label, and
 * its chips. Module-private, reached from outside through the `repaint`
 * event the builder listens for.
 */
function paintPicker(el: HTMLElement) {
  const c = pickerOf(el);
  if (!c) return;
  const value = el.dataset.value ?? '';
  const chosen = (c.options?.(ctx()) || []).find(o => o.value === value);
  el.replaceChildren();
  const name = make('span', 'field-picker-name');
  name.textContent = chosen?.label ?? '';
  el.append(name);
  const chips = c.swatches?.(value) ?? [];
  if (!chips.length) return;
  const strip = make('span', 'field-picker-chips');
  for (const colour of chips) {
    const chip = make('i');
    chip.style.background = colour;
    strip.append(chip);
  }
  el.append(strip);
}

/**
 * Fill a select from the table, and answer whether anything changed.
 *
 * The panel is built once, so a list that depends on layout has to be
 * refilled rather than rebuilt. Compared before writing, so the ordinary
 * case costs one join and no DOM, and a select the user has open is not
 * emptied under the pointer.
 */
function fillSelect(c: SelectControl, select: HTMLSelectElement, ctxValue: Ctx) {
  const want = c.options?.(ctxValue) || [];
  const key = JSON.stringify(want.map(o => [o.value, o.label]));
  if (select.dataset.opts === key) return false;
  select.dataset.opts = key;
  select.replaceChildren();
  for (const o of want) {
    const opt = make('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
  return true;
}

/**
 * A row of buttons. None wired here - every one carries `data-cmd` and is
 * answered by ui/sidebar.ts's delegated listener. The paper orientation pair
 * is the exception, carrying `data-orient` instead, since choosing an
 * orientation with no sheet up also raises a sheet - a rule about paper, not
 * a command.
 */
function buildButtons(c: ButtonsControl) {
  const row = make('div', 'btn-row');
  if (c.id) row.id = c.id;
  if (c.group) row.setAttribute('role', 'group');
  if (c.ariaLabel) row.setAttribute('aria-label', c.ariaLabel);
  const nodes: HTMLElement[] = [];
  for (const b of c.buttons) {
    const btn = make('button', b.className);
    btn.type = 'button';
    if (b.id) btn.id = b.id;
    if (b.cmd) btn.dataset.cmd = b.cmd;
    if (b.orient) btn.dataset.orient = b.orient;
    // Stamped rather than looked up: the listener already has the element
    // and would otherwise need a second index by command name.
    if (b.closesPanel) btn.dataset.closesPanel = b.closesPanel === true ? '' : b.closesPanel;
    if (b.ariaPressed != null) btn.setAttribute('aria-pressed', b.ariaPressed);
    // The app's name in the app's face, if this label says it. See
    // ui/wordmark.ts.
    setMarked(btn, b.label);
    row.append(btn);
    nodes.push(btn);
  }
  register(c, row, null, null, nodes);
  return row;
}

/** An empty host another module fills - the face menus, the token sliders. */
function buildSlot(c: SlotControl) {
  const el = make('div', c.className);
  if (c.id) el.id = c.id;
  register(c, el, null, null);
  return el;
}

function buildHint(c: HintControl) {
  const p = make('p', 'hint');
  if (c.id) p.id = c.id;
  // `html` is a literal in settings-schema.ts, never file or board content -
  // it exists so a hint can italicise one word.
  if (c.html) p.innerHTML = c.html;
  register(c, p, null, null);
  return p;
}

function buildKeys(c: KeysControl) {
  const ul = make('ul', 'keys');
  for (const [keys, text] of c.keys) {
    const li = make('li');
    let joined = true;   // no leading space before the first key
    for (const k of keys) {
      if (k === '+') { li.append(document.createTextNode('+')); joined = true; continue; }
      if (!joined) li.append(document.createTextNode(' '));
      const kbd = make('kbd');
      kbd.textContent = k;
      li.append(kbd);
      joined = false;
    }
    li.append(document.createTextNode(' '));
    const span = make('span');
    span.textContent = text;
    li.append(span);
    ul.append(li);
  }
  register(c, ul, null, null);
  return ul;
}

function register(
  c: Control, wrap: HTMLElement,
  input: HTMLInputElement | HTMLSelectElement | null,
  out: HTMLOutputElement | null,
  nodes: HTMLElement[] | null = null,
) {
  // `building` is set for the whole of buildSection() and nothing registers
  // outside one, so the fallback is a shape for the typechecker, not a case
  // that happens.
  built.push({ c, owner: building ?? { tab: '', controls: [] }, wrap, input, out, nodes });
}

function writeOut(c: RangeControl, input: HTMLInputElement | HTMLSelectElement, out: HTMLOutputElement | null) {
  if (!out) return;
  out.textContent = typeof c.format === 'function'
    ? c.format(+input.value)
    : input.value + (c.unit || '');
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * Push state back into the controls: after an undo, a board load, a layout
 * switch, or any setting changed elsewhere.
 *
 * External controls are read *only* for visibility - their owning module
 * writes their value, and writing it here too would fight it (the pigment
 * input is animated mid-fade; assigning here would jump it under the pointer).
 */
export function paintPanel() {
  if (!built.length) return;
  const c = ctx();
  for (const entry of built) paintControl(entry, c);
  for (const spec of SECTIONS) {
    const el = spec.id ? sections.get(spec.id) : null;
    if (!el) continue;
    el.hidden = !sectionVisible(spec, c);
    // The heading greys with its rows, so an inert section reads as one
    // thing switched off, not a live title over dead controls.
    el.classList.toggle('is-inert', !!(c.patch && spec.needsBoard));
    paintFold(el);
  }
  paintRules();
}

/**
 * A fold whose every row is hidden comes down with them.
 *
 * The same rule sectionVisible() states for a heading, one level in - missed
 * until a fold got a conditional row, which rendered as an **empty Advanced
 * dropdown** whenever the condition was false (the Sync section's "Stop
 * syncing" row found it). Run after controls are painted, since it reads the
 * `hidden` they were just given.
 */
function paintFold(section: HTMLElement) {
  for (const fold of section.children) {
    if (!(fold instanceof HTMLDetailsElement)) continue;
    let any = false;
    for (const row of fold.children) {
      // The summary is the fold's own label, not one of its rows, so it
      // never keeps one open.
      if (row instanceof HTMLElement && row.tagName !== 'SUMMARY' && !row.hidden) any = true;
    }
    fold.hidden = !any;
  }
}

function paintControl({ c: spec, owner, wrap, input, out, nodes }: Built, c: Ctx) {
  // `ownVisibility` is a control whose owner decides when it's on screen for
  // a reason this table doesn't know - see the palette source count.
  if (!spec.ownVisibility) wrap.hidden = !controlVisible(spec, c);
  // Whether it may be touched (always yes, writing nothing, off the
  // changelog). `disabled` on the control itself, not `pointer-events` on
  // the row, so a screen reader gets the reason too.
  const live = controlEnabled(spec, owner, c);
  wrap.classList.toggle('is-inert', !live);
  if (input) input.disabled = !live;
  // `nodes` is only ever filled for a buttons row - see register().
  if (spec.type === 'buttons' && nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const b = spec.buttons[i];
      const node = nodes[i];
      if (node instanceof HTMLButtonElement) node.disabled = !live;
      if (typeof b.pressed === 'function') node.setAttribute('aria-pressed', String(b.pressed(c)));
      if (typeof b.title === 'function') node.title = b.title(c);
    }
    return;
  }
  if (spec.type === 'hint') {
    if (typeof spec.text === 'function') wrap.textContent = spec.text(c);
    return;
  }
  // The three kinds that carry a value to write back.
  if (spec.type !== 'check' && spec.type !== 'range' && spec.type !== 'select') return;
  if (spec.external || typeof spec.get !== 'function' || !input) return;
  // Never into a control being used: a select with its list open, or a
  // range mid-drag, both fight the hand on them.
  if (document.activeElement === input) return;
  // The list before the value, so a select whose options depend on layout
  // has somewhere to put the value it's about to get - refilling clears the
  // selection, so this can't happen the other way round.
  if (spec.type === 'select') {
    // SAFETY: `input` and `spec` were paired when the row was built, and buildSelect()
    // gave a 'select' spec its <select>. The discriminant test above picks the branch.
    fillSelect(spec, input as HTMLSelectElement, c);
  }
  const value = spec.get();
  if (spec.type === 'check') {
    // SAFETY: as above - buildCheck() gave a 'check' spec its <input>.
    (input as HTMLInputElement).checked = !!value;
  } else if (spec.type === 'range') { input.value = String(value); writeOut(spec, input, out); }
  else input.value = String(value ?? '');
}

/**
 * The first *visible* section in a tab draws no rule above it.
 *
 * `.side-sec:first-child` can't answer this: on Mobile the first section of
 * a tab may be hidden, and a hidden element is still the first child.
 */
function paintRules() {
  for (const { panel } of tabs.values()) {
    let first = true;
    // SAFETY: every child of a tab panel is a <section> this file built.
    for (const el of panel.children as HTMLCollectionOf<HTMLElement>) {
      if (el.hidden) continue;
      el.classList.toggle('is-first', first);
      first = false;
    }
  }
}
