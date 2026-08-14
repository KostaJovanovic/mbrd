// The sidebar, built from ui/settings-schema.js.
//
// index.html used to carry every control as markup and ui/sidebar.js wired each
// one by id, which is how a panel ends up with a setting in two files and a
// section order nobody chose. Now the markup is a head, an empty tab strip, an
// empty body and a foot, and everything between them is made here.
//
// Three properties this file exists to hold:
//
//   Built once, never rebuilt. Other modules - ui/appearance.js, canvas/audio.js
//   - look their controls up by id at boot and keep the element. Rebuilding a
//   section would leave them holding a node no longer in the document, with no
//   error to say so. So the panel is constructed in one pass and paint() only
//   ever writes values and toggles `hidden`.
//
//   Absence, not disabling. A control that does not apply to the current layout
//   is hidden, and a section with nothing left to show goes with it - otherwise
//   Mobile grows an empty "Board & grid" heading over a rule. The one exception
//   is the changelog, where the panel is over a document with no board under
//   it: there the rows that would act on a board are shown and greyed, because
//   the whole point of that sidebar is that it is this one and not a likeness
//   of it. `needsBoard` in ui/settings-schema.js says which, and why.
//
//   The ids are the contract. Every id here is the id that was in index.html,
//   because three other modules and a handful of tests reach for them.
//
// Tabs are three panels that are all in the document at once, `hidden` bar one.
// That is what keeps each tab's scroll position while the app is open, and it
// is why the panel can be built once: switching tabs moves no DOM.

// The one thing here that is not a control: which layout the board is in
// decides what is on screen. ui/sidebar.js owns the subscriptions and calls
// paintPanel() - there is one paint, not two racing.
import { board } from '../state.ts';
import { isPatchPage } from '../page.ts';
import { field, fieldStops } from './controls.ts';
import {
  TABS, SECTIONS, controlVisible, controlEnabled, sectionVisible,
} from './settings-schema.ts';
import { openAnchored, justDismissed } from './menu.ts';
import type {
  ButtonsControl, CheckControl, Control, Ctx, HintControl, KeysControl,
  PickerControl, RangeControl, SelectControl, Section, SlotControl, TextControl,
} from './settings-schema.ts';

/**
 * One built control: its spec, the heading it came from, what to hide, and what
 * to write into.
 *
 * `owner` is here for one question and one only - whether the control needs a
 * board, which a section may answer on behalf of everything under it. Nothing
 * else in the painting reads it.
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
 * Which heading is being built, for the length of buildSection() and no longer.
 *
 * The eight builders each call register() at the end and none of them is handed
 * the section - they take the control and nothing else, which is what keeps the
 * table of them honest. Threading a second argument through all eight to answer
 * one question about the *heading* would be paying in every builder for a fact
 * that belongs to the loop above them, so the loop leaves it here instead.
 */
let building: Section | null = null;

const ctx = (): Ctx => ({
  mobile: board.layoutMode === 'mobile',
  patch: isPatchPage(),
});

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
};

/**
 * Build the whole panel into a sidebar shell.
 *
 * Called from main.js *before* initAppearance() and initAudio(), because both
 * of those look up controls this makes. Everything that needs a command surface
 * - every button - carries `data-cmd` and is answered by the one delegated
 * listener in ui/sidebar.js, so nothing here needs `cmds`.
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
    tab.addEventListener('click', () => showTab(t.id));
    strip.append(tab);

    const panel = make('div', 'side-panel');
    panel.id = `panel-${t.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    body.append(panel);

    tabs.set(t.id, { tab, panel });
  }

  strip.setAttribute('role', 'tablist');
  strip.addEventListener('keydown', onTabKey);

  for (const section of SECTIONS) {
    const panel = tabs.get(section.tab)?.panel;
    if (panel) panel.append(buildSection(section));
  }

  showTab(TABS[0].id);
  paintPanel();
}

/**
 * The tab strip's keyboard, which is the whole of what makes it a tablist
 * rather than three buttons. Arrows move and select in one go - with three tabs
 * and no expensive panel to build, a separate Enter to commit would be a step
 * that buys nothing.
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
export function showTab(id: string) {
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

export const openTab = () => currentTab;

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
  // schema in the order it reads on screen without `advanced` having to be a
  // nesting level in the data.
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
  // A section with no heading is one whose every control is advanced, so the
  // summary is the only thing standing where an h2 would - and it has to be
  // spaced like one rather than like a tail hanging off a list of rows above
  // it. The condition is drawn from the absence of a title rather than from a
  // flag, because that absence *is* the situation.
  if (!spec.title) details.classList.add('is-head');
  if (spec.foldId) details.id = spec.foldId;
  const summary = make('summary');
  summary.textContent = spec.fold || 'Advanced';
  details.append(summary);
  return details;
}

function buildControl(c: Control, _spec: Section) {
  // The table is keyed by the same discriminant that narrows `c`, and each
  // builder below takes the member carrying its own key - but TypeScript cannot
  // carry that correlation through an index, so the pair is asserted here once
  // rather than at each of the eight.
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

/** The board's name. ui/sidebar.js owns what typing in it does. */
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
    input.addEventListener('change', () => set(input.checked));
  }
  register(c, label, input, null);
  return label;
}

function buildRange(c: RangeControl) {
  // `silent` is a dial whose stops are named underneath rather than a value
  // worth printing: whimsy and quality both read as words, not numbers. Those
  // get the plain label and no readout - .field > span is the head, and a span
  // inside a span is a level of nothing.
  const { label, out } = field(c.label, { out: !c.silent });
  if (c.fieldId) label.id = c.fieldId;
  if (out) {
    out.id = `${c.id}-out`;
    if (c.outText) out.textContent = c.outText;
  }

  const input = make('input');
  input.type = 'range';
  if (c.id) input.id = c.id;
  // Numbers in the table, strings on the element - the conversion was the
  // assignment's own before it was written down.
  if (c.min != null) input.min = String(c.min);
  if (c.max != null) input.max = String(c.max);
  if (c.step != null) input.step = String(c.step);
  if (c.value != null) input.value = String(c.value);
  label.append(input);

  if (c.stops?.length) {
    // `stopsId` where a stylesheet reaches for the row by name - the whimsy
    // stops are specimens of the three tiers and are set in three different
    // faces, pinned by that id and by nothing else.
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
    select.addEventListener('change', () => set(select.value));
  }
  register(c, label, select, null);
  return label;
}

/**
 * A select that shows what it is choosing between.
 *
 * A button and ui/menu.ts's anchored panel, not a <select>, and the reason is
 * flat: no browser will paint anything inside a native dropdown list, so the
 * one row in this panel whose options *are* colours could not show them. The
 * schema entry is otherwise identical to a select's - same `options`, same
 * `get`/`set`, same `external` - which is what made this a second builder
 * rather than a second control model.
 *
 * ui/menu.ts renders it because CLAUDE.md says every menu in this app is drawn
 * by that module and a second implementation is the thing that rule forbids.
 * `openAnchored()` is its non-cursor door, and `swatch` rows and the tick on the
 * current value both come free with it.
 *
 * The value lives in `data-value` rather than in a property, so that a sync
 * (syncPaletteMode) and a paint read the same place, and a `pick` CustomEvent
 * carries the choice out - which keeps this builder ignorant of what a palette
 * is, exactly as buildSelect is.
 */
function buildPicker(c: PickerControl) {
  const { label } = field(c.label);
  if (c.fieldId) label.id = c.fieldId;
  const btn = make('button', 'field-picker');
  btn.type = 'button';
  if (c.id) btn.id = c.id;
  btn.dataset.value = c.get?.() ?? '';
  // Rebuilt on every press rather than once: options() takes the live context,
  // and the tick has to follow a value that anything else may have changed.
  btn.addEventListener('click', () => {
    // A second press closes rather than reopening. The same asking-rather-than-
    // testing that the More button needs, and for the same reason: the menu's
    // outside-press listener has already shut it by the time this click runs.
    if (justDismissed(btn)) return;
    const now = btn.dataset.value ?? '';
    const entries = (c.options?.(ctx()) || []).map(o => ({
      label: o.label,
      // On the trailing edge, because these are specimens of whole palettes
      // rather than icons for them, and the act this menu exists for is
      // comparing them down a column. See MenuEntry.swatchEnd.
      swatchEnd: c.swatches?.(o.value) ?? [],
      check: o.value === now,
      action: () => {
        btn.dataset.value = o.value;
        paintPicker(btn);
        // The event rather than a direct call, so this builder never learns what
        // it is picking. `external` controls have no `set` at all - the palette
        // is one, because choosing Dynamic is a different act from choosing a
        // palette and only ui/appearance-controls.ts knows that.
        btn.dispatchEvent(new CustomEvent('pick', { detail: o.value }));
        c.set?.(o.value);
      },
    }));
    openAnchored(btn.getBoundingClientRect(), entries);
  });
  // The other direction: ui/appearance-controls.ts writes `data-value` when the
  // look changes underneath and asks for the face to follow. An event rather
  // than a call, because a call would be that module importing this one, which
  // imports the schema, which imports the chips - a ring tests/imports.test.js
  // refuses. See syncPaletteMode() there.
  btn.addEventListener('repaint', () => paintPicker(btn));
  paintPicker(btn);
  label.append(btn);
  // `null` for the input slot: that field is typed as the <input>/<select> the
  // painting writes values into, and a picker's value is an attribute this
  // module writes itself. pickerOf() below is how the face finds its spec again.
  register(c, label, null, null);
  return label;
}

/**
 * The schema entry behind a built picker, by id.
 *
 * By id rather than by identity, because paintPicker() is called from outside
 * this module with nothing but the element - syncPaletteMode() writes
 * `data-value` and asks for the face to follow. Every picker has an id; a
 * control without one cannot be reached from outside in the first place.
 */
function pickerOf(el: HTMLElement): PickerControl | null {
  const hit = built.find(b => b.c.type === 'picker' && b.c.id && b.c.id === el.id);
  return (hit?.c as PickerControl) ?? null;
}

/**
 * Write a picker's face from its stored value: the option's own label, and its
 * chips.
 *
 * Module-private, and reached from outside through the `repaint` event the
 * builder listens for. It re-reads the schema entry through the registry rather
 * than being handed one, so the listener only needs the element.
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
 * The panel is built once and never rebuilt, so a list that depends on the
 * layout - Layout itself, whose two catalogues have no ids in common past three
 * of them - has to be refilled rather than rebuilt. Compared before it is
 * written, so the ordinary case (Units, Paper outline, the quality steps: lists
 * that never move) costs one join and no DOM at all, and so that a select the
 * user has open is not emptied under the pointer for no reason.
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
 * A row of buttons. None of them is wired here: every one carries `data-cmd`
 * and is answered by the delegated listener in ui/sidebar.js, which is the one
 * place the command surface is reached from. The paper orientation pair is the
 * exception and carries `data-orient` instead - ui/sidebar.js wires those two
 * directly, because choosing an orientation with no sheet up also puts a sheet
 * up, which is a rule about paper and not a command.
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
    if (b.ariaPressed != null) btn.setAttribute('aria-pressed', b.ariaPressed);
    btn.textContent = b.label;
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
  // `html` is a literal in settings-schema.js and never anything a board or a
  // file carried - it exists so a hint can italicise one word.
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
  // outside one, so the fallback is a shape for the typechecker rather than a
  // case that happens.
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
 * switch, or any setting changed from somewhere else.
 *
 * External controls are read *only* for visibility. Their owning module writes
 * their value, and writing it here as well would fight - the pigment input in
 * particular is animated mid-fade, and assigning to a control somebody is
 * inside is how a value jumps back under the pointer.
 */
export function paintPanel() {
  if (!built.length) return;
  const c = ctx();
  for (const entry of built) paintControl(entry, c);
  for (const spec of SECTIONS) {
    const el = spec.id ? sections.get(spec.id) : null;
    if (!el) continue;
    el.hidden = !sectionVisible(spec, c);
    // The heading greys with its rows, so a whole inert section reads as one
    // thing switched off rather than as a live title over dead controls.
    el.classList.toggle('is-inert', !!(c.patch && spec.needsBoard));
  }
  paintRules();
}

function paintControl({ c: spec, owner, wrap, input, out, nodes }: Built, c: Ctx) {
  // `ownVisibility` is a control whose owner decides when it is on screen for a
  // reason this table does not know - see the palette source count, which comes
  // down with the switch above it.
  if (!spec.ownVisibility) wrap.hidden = !controlVisible(spec, c);
  // Whether it may be touched, which off the changelog is always yes and writes
  // nothing. `disabled` is what actually stops the click - the class only makes
  // it look stopped - and it goes on the control rather than `pointer-events`
  // on the row, so the reason travels to a screen reader with it.
  const live = controlEnabled(spec, owner, c);
  wrap.classList.toggle('is-inert', !live);
  if (input) input.disabled = !live;
  // `nodes` is only ever filled for a buttons row - see register() - so the two
  // tests are one question asked from both ends.
  if (spec.type === 'buttons' && nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const b = spec.buttons[i];
      if (nodes[i] instanceof HTMLButtonElement) (nodes[i] as HTMLButtonElement).disabled = !live;
      if (typeof b.pressed === 'function') nodes[i].setAttribute('aria-pressed', String(b.pressed(c)));
      if (typeof b.title === 'function') nodes[i].title = b.title(c);
    }
    return;
  }
  if (spec.type === 'hint') {
    if (typeof spec.text === 'function') wrap.textContent = spec.text(c);
    return;
  }
  // The three kinds that carry a value to write back. The others were already
  // returned above or have no `get` at all, which is what this test says now
  // that the table declares which keys each kind may have.
  if (spec.type !== 'check' && spec.type !== 'range' && spec.type !== 'select') return;
  if (spec.external || typeof spec.get !== 'function' || !input) return;
  // Never into a control that is being used: a select being reassigned while
  // its list is open, or a range mid-drag, both fight the hand on them.
  if (document.activeElement === input) return;
  // The list before the value, so that a select whose options depend on the
  // layout has somewhere to put the value it is about to be given. Refilling
  // clears the selection, which is why this cannot happen the other way round.
  // The element is the one buildSelect() made for this same spec, which is what
  // the two assertions here and below say.
  if (spec.type === 'select') fillSelect(spec, input as HTMLSelectElement, c);
  const value = spec.get();
  if (spec.type === 'check') (input as HTMLInputElement).checked = !!value;
  else if (spec.type === 'range') { input.value = String(value); writeOut(spec, input, out); }
  // The String() is the coercion the assignment did on its own; what reaches
  // here is a select's value, which is text already.
  else input.value = String(value ?? '');
}

/**
 * The first *visible* section in a tab draws no rule above it.
 *
 * `.side-sec:first-child` cannot answer this: on Mobile the first section of a
 * tab may be hidden, and a hidden element is still the first child - so the
 * panel drew a rule across the top of its first heading.
 */
function paintRules() {
  for (const { panel } of tabs.values()) {
    let first = true;
    // Every child of a tab panel is a <section> this file built.
    for (const el of panel.children as HTMLCollectionOf<HTMLElement>) {
      if (el.hidden) continue;
      el.classList.toggle('is-first', first);
      first = false;
    }
  }
}
