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
//   Mobile grows an empty "Board & grid" heading over a rule.
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
import { board } from '../state.js';
import {
  TABS, SECTIONS, sectionsFor, controlVisible, sectionVisible,
} from './settings-schema.js';

/** Every built control, in build order: { c, wrap, input, out, section }. */
const built = [];
/** section id -> its <section> element. */
const sections = new Map();
/** tab id -> { tab, panel }. */
const tabs = new Map();

let currentTab = TABS[0].id;

const ctx = () => ({ mobile: board.layoutMode === 'mobile' });

const make = (tag, className) => {
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
  const strip = root?.querySelector('.side-tabs');
  const body = root?.querySelector('.side-body');
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
function onTabKey(e) {
  const order = TABS.map(t => t.id);
  const i = order.indexOf(currentTab);
  let next = null;
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
export function showTab(id) {
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

function buildSection(spec) {
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
  let fold = null;
  for (const c of spec.controls) {
    const node = buildControl(c, spec);
    if (!node) continue;
    if (!c.advanced) { el.append(node); continue; }
    if (!fold) fold = buildFold(spec);
    fold.append(node);
  }
  if (fold) el.append(fold);
  sections.set(spec.id, el);
  return el;
}

function buildFold(spec) {
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

function buildControl(c, spec) {
  const node = BUILDERS[c.type]?.(c);
  if (!node) return null;
  return node;
}

const BUILDERS = {
  text: buildText,
  check: buildCheck,
  range: buildRange,
  select: buildSelect,
  buttons: buildButtons,
  slot: buildSlot,
  hint: buildHint,
  keys: buildKeys,
};

/** The board's name. ui/sidebar.js owns what typing in it does. */
function buildText(c) {
  const input = make('input', c.className);
  input.type = 'text';
  input.id = c.id;
  if (c.maxlength) input.maxLength = c.maxlength;
  if (c.placeholder) input.placeholder = c.placeholder;
  if (c.ariaLabel) input.setAttribute('aria-label', c.ariaLabel);
  input.autocomplete = 'off';
  input.spellcheck = false;
  register(c, input, input, null);
  return input;
}

function buildCheck(c) {
  const label = make('label', 'check');
  const input = make('input');
  input.type = 'checkbox';
  input.id = c.id;
  label.append(input, document.createTextNode(' ' + c.label));
  if (!c.external && c.set) {
    input.addEventListener('change', () => c.set(input.checked));
  }
  register(c, label, input, null);
  return label;
}

function buildRange(c) {
  const label = make('label', 'field');
  if (c.fieldId) label.id = c.fieldId;
  const head = make('span');
  // `silent` is a dial whose stops are named underneath rather than a value
  // worth printing: whimsy and quality both read as words, not numbers. Those
  // get the plain label and no wrapper - .field > span is the head, and a span
  // inside a span is a level of nothing.
  let out = null;
  if (c.silent) {
    head.textContent = c.label;
  } else {
    const text = make('span');
    text.textContent = c.label;
    out = make('output');
    out.id = `${c.id}-out`;
    if (c.outText) out.textContent = c.outText;
    head.append(text, document.createTextNode(' '), out);
  }

  const input = make('input');
  input.type = 'range';
  input.id = c.id;
  input.min = c.min;
  input.max = c.max;
  input.step = c.step;
  if (c.value != null) input.value = c.value;
  label.append(head, input);

  if (c.stops?.length) {
    // No <datalist>: Chromium ignores it on a custom-painted track, and Firefox
    // draws ticks whose two ends vanish into the rounded track. Names are
    // legible in a way ticks are not.
    const stops = make('span', 'field-stops');
    // `stopsId` where a stylesheet reaches for the row by name - the whimsy
    // stops are specimens of the three tiers and are set in three different
    // faces, pinned by that id and by nothing else.
    stops.id = c.stopsId || `${c.id}-stops`;
    stops.setAttribute('aria-hidden', 'true');
    for (const s of c.stops) {
      const span = make('span');
      span.textContent = s;
      stops.append(span);
    }
    input.setAttribute('aria-describedby', stops.id);
    label.append(stops);
  }

  if (!c.external && c.set) {
    input.addEventListener('input', () => {
      writeOut(c, input, out);
      c.set(+input.value);
    });
  }
  register(c, label, input, out);
  return label;
}

function buildSelect(c) {
  const label = make('label', 'field');
  if (c.fieldId) label.id = c.fieldId;
  const head = make('span');
  head.textContent = c.label;
  const select = make('select');
  select.id = c.id;
  fillSelect(c, select, ctx());
  label.append(head, select);
  if (!c.external && c.set) {
    select.addEventListener('change', () => c.set(select.value));
  }
  register(c, label, select, null);
  return label;
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
function fillSelect(c, select, ctxValue) {
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
function buildButtons(c) {
  const row = make('div', 'btn-row');
  if (c.id) row.id = c.id;
  if (c.group) row.setAttribute('role', 'group');
  if (c.ariaLabel) row.setAttribute('aria-label', c.ariaLabel);
  const nodes = [];
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
function buildSlot(c) {
  const el = make('div', c.className);
  el.id = c.id;
  register(c, el, null, null);
  return el;
}

function buildHint(c) {
  const p = make('p', 'hint');
  if (c.id) p.id = c.id;
  // `html` is a literal in settings-schema.js and never anything a board or a
  // file carried - it exists so a hint can italicise one word.
  if (c.html) p.innerHTML = c.html;
  register(c, p, null, null);
  return p;
}

function buildKeys(c) {
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

function register(c, wrap, input, out, nodes = null) {
  built.push({ c, wrap, input, out, nodes });
}

function writeOut(c, input, out) {
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
    const el = sections.get(spec.id);
    if (el) el.hidden = !sectionVisible(spec, c);
  }
  paintRules();
}

function paintControl({ c: spec, wrap, input, out, nodes }, c) {
  // `ownVisibility` is a control whose owner decides when it is on screen for a
  // reason this table does not know - see the palette source count, which comes
  // down with the switch above it.
  if (!spec.ownVisibility) wrap.hidden = !controlVisible(spec, c);
  if (nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const b = spec.buttons[i];
      if (typeof b.pressed === 'function') nodes[i].setAttribute('aria-pressed', String(b.pressed(c)));
      if (typeof b.title === 'function') nodes[i].title = b.title(c);
    }
    return;
  }
  if (spec.type === 'hint') {
    if (typeof spec.text === 'function') wrap.textContent = spec.text(c);
    return;
  }
  if (spec.external || typeof spec.get !== 'function' || !input) return;
  // Never into a control that is being used: a select being reassigned while
  // its list is open, or a range mid-drag, both fight the hand on them.
  if (document.activeElement === input) return;
  // The list before the value, so that a select whose options depend on the
  // layout has somewhere to put the value it is about to be given. Refilling
  // clears the selection, which is why this cannot happen the other way round.
  if (spec.type === 'select') fillSelect(spec, input, c);
  const value = spec.get();
  if (spec.type === 'check') input.checked = !!value;
  else if (spec.type === 'range') { input.value = value; writeOut(spec, input, out); }
  else input.value = value ?? '';
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
    for (const el of panel.children) {
      if (el.hidden) continue;
      el.classList.toggle('is-first', first);
      first = false;
    }
  }
}
