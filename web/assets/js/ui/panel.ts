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
import { openAnchored, menuButton } from './menu.ts';
import type {
  ButtonsControl, CheckControl, Control, Ctx, HintControl, KeysControl,
  PickerControl, RangeControl, Section, SlotControl, TextControl,
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
  input: HTMLInputElement | null,
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
  reveals.length = 0;
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

/**
 * Show one fold, open, on its tab: how a command points somebody at a part of
 * the panel. The sidebar's opening is the caller's - this only arranges what
 * the open panel shows.
 *
 * Straight to `open`, past openAndShut()'s animation: the panel is sliding in
 * as this runs, and a fold growing inside a moving sheet is two motions where
 * one says it.
 */
export function revealFold(tabId: string, foldId: string) {
  showTab(tabId);
  const fold = document.getElementById(foldId);
  if (!(fold instanceof HTMLDetailsElement)) return;
  fold.open = true;
  fold.scrollIntoView({ block: 'start' });
}

/**
 * Show one control, on its tab with its fold open, and give it the keyboard:
 * the S box's row for a setting it cannot change in place (ui/palette.ts).
 * The sidebar's opening is the caller's, as for revealFold().
 */
export function revealControl(el: HTMLElement) {
  const tab = el.closest('.side-panel')?.id.replace(/^panel-/, '');
  if (tab) showTab(tab);
  const fold = el.closest('details');
  if (fold) fold.open = true;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
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
  // The box the current run of `reveal` rows is going into, and null between
  // runs - so two runs in one section get a box each rather than sharing one
  // that would animate rows the second run never asked about.
  let run: Reveal | null = null;
  building = spec;
  for (const c of spec.controls) {
    const node = buildControl(c, spec);
    if (!node) continue;
    if (!c.reveal) run = null;
    else if (!run) {
      const box = make('div', 'reveal-body');
      box.hidden = true;
      el.append(box);
      run = { box, specs: [], shown: null, running: null };
      reveals.push(run);
    }
    if (run) run.specs.push(c);
    const host = c.advanced ? foldBody(fold ??= buildFold(spec)) : (run?.box ?? el);
    // A tip comes back as an empty box wanting the row it explains. Moving the
    // last-built row into it is what puts the (?) at the end of that row
    // instead of on a line of its own - see buildHint().
    //
    // Never the summary: a tip first in a fold has nothing above it but the
    // fold's own label, and swallowing that would leave the section with no
    // way to open.
    const prev = host.lastElementChild;
    if (c.type === 'hint' && c.tip && prev && prev.tagName !== 'SUMMARY') {
      node.prepend(prev);
    }
    host.append(node);
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
  summary.textContent = spec.fold || spec.foldLabel || 'Advanced';
  // The rows go in a box of their own rather than straight into the <details>.
  // It is what opening animates: the drawer is one grid row growing from
  // nothing, and a row can only grow if there is exactly one thing in it. See
  // .fold-body in sidebar.css.
  details.append(summary, make('div', 'fold-body'));
  openAndShut(details, summary);
  return details;
}

/** A CSS time token as milliseconds. Both `0.24s` and `150ms` arrive here. */
function tokenMs(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * How a fold moves, read off the sheet rather than written here - so the
 * whimsy tier owns the pace, and quality.css's flattened durations are obeyed
 * by an animation its `!important` cannot reach.
 *
 * The tier moves the *speed*, and only the speed: 0.4s at Softish, 0.24s at
 * Middle, 0.15s at Harsh. No tier overshoots. `--ease-back` was the obvious
 * curve for opening and is the wrong one here - a drawer of settings that goes
 * past its height and comes back is a row of controls that arrives twice, and
 * the taller the fold the further it travels to say nothing. What a fold has
 * instead is `--ease`, which is the same curve the panel it lives in slides on.
 *
 * Shutting asks for `--ease-in` and gets the opposite, on purpose: the close
 * plays the same keyframes in reverse, and a reversed animation reverses its
 * easing with them. So the curve that would gather speed on the way out
 * arrives gently instead, which is what a fold settling shut wants. Measured
 * rather than reasoned, because it is easy to get backwards - the per-frame
 * step of a close runs 12px down to 5px.
 */
function foldMotion(opening: boolean) {
  const still = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return {
    duration: still ? 0 : tokenMs('--dur-base'),
    easing: token(opening ? '--ease' : '--ease-in'),
  };
}

/**
 * Open and shut a fold on a measured height, so what is under it travels with
 * it in both directions instead of jumping.
 *
 * Both halves are script's, not because opening needs it - `open` arrives and
 * the rows are there - but because closing does: the moment `open` comes off,
 * a <details> stops rendering its body and there is nothing left to animate.
 * So the attribute is this function's to write, at the start of an open and at
 * the end of a shut, and the press never reaches the UA's own toggle.
 *
 * `target` is what the fold is moving *towards*, which is not what `open`
 * says while a close is in flight - press it again there and the answer must
 * be "open", not "close it a second time".
 */
function openAndShut(details: HTMLDetailsElement, summary: HTMLElement) {
  let running: Animation | null = null;
  let target: boolean | null = null;

  summary.addEventListener('click', e => {
    const body = foldBody(details);
    // No body to measure - a shape this function does not know. Leave the
    // press to the UA rather than half-animating it.
    if (body === details) return;
    e.preventDefault();

    const opening = !(target ?? details.open);
    target = opening;
    details.classList.toggle('is-closing', !opening);
    // A press mid-flight turns the movement round from where it has got to.
    // Cancelling it snapped the box to its natural height and the new one then
    // started from an end, so the fold jumped before it moved. `open` is still
    // set during a close, so a close turned into an open needs nothing else.
    if (running) { running.reverse(); return; }
    if (opening) details.open = true;

    const anim = slideBox(body, opening);
    running = anim;

    anim.finished.then(() => {
      if (running !== anim) return;
      running = null;
      // Where it ended up, which a reverse may have changed since it started.
      const opened = target;
      target = null;
      settleBox(body, anim);
      details.classList.remove('is-closing');
      if (!opened) details.open = false;
    }, () => {});
  });
}

/**
 * The movement itself: one box growing from nothing to its own height, or the
 * same keyframes in reverse.
 *
 * A fold makes it, and so does a run of rows marked `reveal` in the table -
 * one implementation for both, because a second would drift from this one in
 * pace, in curve, or in the argument written into the keyframes below.
 *
 * What the box *means* stays with the caller: a <details> owns its attribute, a
 * reveal run owns its `hidden`, and both call settleBox() when it lands.
 */
function slideBox(body: HTMLElement, opening: boolean): Animation {
  // Read while the box is rendered, or it measures zero.
  const full = body.scrollHeight;
  // The gap between the rows and whatever labels them travels with them. It is
  // the body's margin (sidebar.css) rather than its neighbour's for exactly
  // this reason: anything that exists only while the box is open is still
  // there on the last frame of a close and gone the instant it shuts, which is
  // a few pixels snapping after the movement has already finished.
  const { marginTop, marginBottom } = getComputedStyle(body);
  const { duration, easing } = foldMotion(opening);
  // Only while it moves. Left on, it would clip every focus ring in the box
  // for the rest of the panel's life.
  //
  // Clipped at the growing edge only. A row hovered mid-slide lifts and grows
  // past the box (--btn-lift, --btn-grow), and a plain `hidden` sheared it off
  // at the top and both sides. `clip` with a margin lets it stand out that far
  // without the overflow counting towards the panel's scroll height, and the
  // clip-path takes the margin back off the bottom, which is where the reveal
  // is. An engine without `clip` keeps `hidden`, the old look.
  body.style.overflow = 'hidden';
  body.style.overflow = 'clip';
  body.style.setProperty('overflow-clip-margin', `${SLIDE_BLEED}px`);
  body.style.clipPath = `inset(-${SLIDE_BLEED}px -${SLIDE_BLEED}px 0 -${SLIDE_BLEED}px)`;
  // And for the same length: the rows inside stop animating their own hover.
  // See .is-sliding in sidebar.css - a row that arrives under a pointer that
  // never moved is hovered on the frame it appears, and its own transition is
  // what makes it look unfinished.
  body.classList.add('is-sliding');
  // Height and the gap, and deliberately nothing else. A slide and a fade were
  // in here too, and both are paid for by the rows: a 1px border on a box
  // offset by a fraction of a pixel antialiases across two rows and washes
  // out, and a border part way through a fade is a faint one - so a button that
  // appeared under the pointer arrived hovered and apparently unoutlined for as
  // long as the movement lasted. The clip does the reveal and the rows stay
  // crisp from the first frame, which is what a drawer does anyway.
  return body.animate([
    { height: '0px', marginTop: '0px', marginBottom: '0px' },
    { height: `${full}px`, marginTop, marginBottom },
  ], { duration, easing, direction: opening ? 'normal' : 'reverse', fill: 'both' });
}

/** Hand the box back its own sizing once the movement has landed. */
function settleBox(body: HTMLElement, anim: Animation) {
  // Cancel rather than leave the fill: the box sizes itself again, and where
  // it ended up is the caller's state to hold, not a held keyframe's.
  anim.cancel();
  body.style.overflow = '';
  body.style.removeProperty('overflow-clip-margin');
  body.style.clipPath = '';
  body.classList.remove('is-sliding');
}

/** How far a hovered row may stand out of a moving box: Softish's 3px lift and
 *  its 1.04 grow on a full-width button, with room to spare. */
const SLIDE_BLEED = 12;

/** Where a fold's rows live. Falls back to the fold for a shape with no body. */
function foldBody(details: HTMLDetailsElement): HTMLElement {
  return details.querySelector<HTMLElement>('.fold-body') ?? details;
}

// ---------------------------------------------------------------------------
// Reveal runs
// ---------------------------------------------------------------------------

/**
 * A run of consecutive `reveal` rows and the box they share.
 *
 * `shown` is what the box is holding now, and `null` until the first paint -
 * which is what keeps a panel built with the rows already up from playing an
 * opening animation nobody asked for.
 */
type Reveal = {
  box: HTMLElement, specs: Control[], shown: boolean | null, running: Animation | null,
};
const reveals: Reveal[] = [];

/**
 * Open or shut one reveal box, on the same movement a fold makes.
 *
 * The box carries `hidden`, so the rows inside it keep their own `hidden`
 * untouched (see paintControl) - otherwise every row in a box about to open
 * would be hidden, the box would measure zero, and the animation would run
 * from nothing to nothing.
 */
function paintReveal(r: Reveal, shown: boolean) {
  if (r.shown === shown) return;
  const first = r.shown === null;
  r.shown = shown;
  // Turned round mid-flight from where it has got to, as a fold is - see
  // openAndShut(). The box is still unhidden during a close.
  if (r.running && r.box.isConnected) { r.running.reverse(); return; }
  r.running?.cancel();
  r.running = null;
  // The first paint is the panel arriving, not a change to watch.
  if (first || !r.box.isConnected) { r.box.hidden = !shown; return; }
  if (shown) r.box.hidden = false;
  const anim = slideBox(r.box, shown);
  r.running = anim;
  if (shown) followEdge(r.box, () => r.running === anim);
  anim.finished.then(() => {
    if (r.running !== anim) return;   // a newer turn owns the box now
    r.running = null;
    settleBox(r.box, anim);
    // r.shown, not `shown`: a reverse may have changed where it was going.
    if (!r.shown) r.box.hidden = true;
  }, () => {});   // cancelled mid-flight by the change that replaced it
}

/**
 * Keep the growing edge of an opening box on screen, one frame at a time - the
 * Paper rows open under the button that asked for them, which is often the
 * bottom of the panel. The scroll rides the box's own height, so it moves on
 * the fold's curve and finishes when the box does; a smooth scroll started at
 * the end was a second movement after the first had stopped.
 *
 * Never past the top of the section, so the button that opened the rows stays
 * on screen. The rect is read in a frame callback, after the animation has
 * been stepped for that frame, so the edge is where it is about to be drawn.
 */
function followEdge(box: HTMLElement, live: () => boolean) {
  const scroller = box.closest<HTMLElement>('.side-body');
  if (!scroller) return;
  const pad = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
  const head = box.closest('.side-sec') ?? box;
  const step = () => {
    const view = scroller.getBoundingClientRect();
    const below = box.getBoundingClientRect().bottom + pad - view.bottom;
    const room = head.getBoundingClientRect().top - view.top;
    const by = Math.min(below, room);
    if (by > 0) scroller.scrollTop += by;
    if (live()) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

/**
 * A dropdown: a button and ui/menu.ts's anchored panel, not a <select> - see
 * PickerControl in ui/settings-schema.ts for why the panel has no native one.
 *
 * ui/menu.ts renders it, since CLAUDE.md reserves every menu to that module.
 * The value lives in `data-value` rather than a property, so a sync
 * (syncPaletteMode) and a paint read the same place, and a `pick`
 * CustomEvent carries the choice out - keeping this builder ignorant of what
 * a palette is.
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
  // menuButton() is the toggle: a second press closes rather than reopening.
  menuButton(btn, () => {
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
  // A value the menu does not offer still has to read as something - see
  // `unlisted` in settings-schema.ts, and the palette's Custom.
  name.textContent = chosen?.label ?? c.unlisted?.(value) ?? '';
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
 * A row of buttons. None wired here - every one carries `data-cmd` and is
 * answered by ui/sidebar.ts's delegated listener. The paper orientation pair
 * is the exception, carrying `data-orient` instead: it writes one setting to
 * one of two values rather than running an action, and ui/sidebar.ts wires it
 * directly.
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
  if (!c.tip) { register(c, p, null, null); return p; }

  // A tip is the same paragraph, closed, with a (?) to open it. The row it
  // explains is moved in by buildSection - this only makes the box for it.
  //
  // A button and `hidden`, not <details>: the paragraph has to sit *under* the
  // whole row while the marker sits at its end, which is two grid cells apart,
  // and a <details> can only open where it stands.
  const row = make('div', 'tip-row');
  const btn = make('button', 'tip-btn');
  btn.type = 'button';
  btn.textContent = '?';
  btn.title = c.tip;
  btn.setAttribute('aria-label', c.tip);
  btn.setAttribute('aria-expanded', 'false');
  if (c.id) btn.setAttribute('aria-controls', c.id);
  p.hidden = true;
  btn.addEventListener('click', () => {
    const open = p.hidden;
    p.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    cue('pick');
  });
  row.append(btn, p);
  // The paragraph is registered as a node rather than as the wrap: paint()
  // writes `hidden` on a wrap from `when`, which would reopen the tip on every
  // repaint. What paint has to reach here is the text.
  register(c, btn, null, null, [p]);
  return row;
}

function buildKeys(c: KeysControl) {
  const ul = make('ul', 'keys');
  // Asked once, at build: which app this is does not change while it runs.
  const now = ctx();
  for (const [keys, text, when] of c.keys) {
    if (when && !when(now)) continue;
    const li = make('li');
    // One box for the keys, so the row spreads the keys from their text and
    // not each key from the next.
    const combo = make('span', 'key-combo');
    let joined = true;   // no leading space before the first key
    for (const [i, k] of keys.entries()) {
      // A joiner only between two keys; anywhere else '+' is the plus key.
      if (k === '+' && !joined && i < keys.length - 1) {
        combo.append(document.createTextNode('+'));
        joined = true;
        continue;
      }
      if (!joined) combo.append(document.createTextNode(' '));
      const kbd = make('kbd');
      kbd.textContent = k;
      combo.append(kbd);
      joined = false;
    }
    li.append(combo, document.createTextNode(' '));
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
  input: HTMLInputElement | null,
  out: HTMLOutputElement | null,
  nodes: HTMLElement[] | null = null,
) {
  // `building` is set for the whole of buildSection() and nothing registers
  // outside one, so the fallback is a shape for the typechecker, not a case
  // that happens.
  built.push({ c, owner: building ?? { tab: '', controls: [] }, wrap, input, out, nodes });
}

function writeOut(c: RangeControl, input: HTMLInputElement, out: HTMLOutputElement | null) {
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
  // After the rows are painted, so a box about to open measures the text and
  // values it is opening with rather than last turn's. A run is open when any
  // row in it is - they share a `when` by construction, so that is all of them
  // or none.
  for (const r of reveals) paintReveal(r, r.specs.some(s => controlVisible(s, c)));
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
    for (const row of foldBody(fold).children) {
      // The summary is the fold's own label, not one of its rows, so it
      // never keeps one open.
      if (row instanceof HTMLElement && row.tagName !== 'SUMMARY' && !row.hidden) any = true;
    }
    fold.hidden = !any;
  }
}

function paintControl({ c: spec, owner, wrap, input, out, nodes }: Built, c: Ctx) {
  // `ownVisibility` is a control whose owner decides when it's on screen for
  // a reason this table doesn't know - see the palette source count. `reveal`
  // is the same thing said by the table: the box the row sits in carries the
  // `hidden`, because a row that hid itself would leave that box measuring
  // zero on the frame it is about to grow from. See paintReveal().
  if (!spec.ownVisibility && !spec.reveal) wrap.hidden = !controlVisible(spec, c);
  // Whether it may be touched (always yes, writing nothing, off the
  // changelog). `disabled` on the control itself, not `pointer-events` on
  // the row, so a screen reader gets the reason too.
  const live = controlEnabled(spec, owner, c);
  wrap.classList.toggle('is-inert', !live);
  if (input) input.disabled = !live;
  // `nodes` is filled for a buttons row and for a tip - see register().
  if (spec.type === 'buttons' && nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const b = spec.buttons[i];
      const node = nodes[i];
      if (node instanceof HTMLButtonElement) node.disabled = !live || !!b.idle?.(c);
      if (typeof b.when === 'function') node.hidden = !b.when(c);
      if (typeof b.says === 'function') setMarked(node, b.says(c));
      if (typeof b.pressed === 'function') node.setAttribute('aria-pressed', String(b.pressed(c)));
      if (typeof b.title === 'function') node.title = b.title(c);
    }
    return;
  }
  if (spec.type === 'hint') {
    // A tip's wrap is its (?) button; the words go in the paragraph beside it.
    const into = nodes?.[0] ?? wrap;
    if (typeof spec.text === 'function') into.textContent = spec.text(c);
    return;
  }
  if (spec.type === 'picker') {
    const btn = wrap.querySelector<HTMLButtonElement>('.field-picker');
    if (!btn) return;
    btn.disabled = !live;
    // An external picker's owner writes its value (syncPaletteMode()).
    if (spec.external || typeof spec.get !== 'function') return;
    btn.dataset.value = spec.get();
    // The face follows the options as well as the value: Layout's list
    // changes with the layout.
    paintPicker(btn);
    return;
  }
  // The two kinds that carry a value to write back.
  if (spec.type !== 'check' && spec.type !== 'range') return;
  if (spec.external || typeof spec.get !== 'function' || !input) return;
  // Never into a range mid-drag: it fights the hand on it.
  if (document.activeElement === input) return;
  const value = spec.get();
  if (spec.type === 'check') input.checked = !!value;
  else { input.value = String(value); writeOut(spec, input, out); }
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
