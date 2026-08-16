// The slide-in sidebar: opening it, closing it, and the four things inside it
// that are not a row in a table.
//
// The controls themselves moved out. ui/settings-schema.js describes them and
// ui/panel.js builds them, which is what took this file from "every setting,
// wired by id" down to the panel as an object: the sheet's open state, the one
// delegated click that reaches the command surface, the gesture that isolates a
// slider under a finger, and the paper orientation pair. The name field is the
// fourth thing here and the one this file no longer implements - it wires and
// paints ui/board-title.js's, because the masthead's panel has the same field
// and one rename must show in both.
//
// Paper orientation stays here rather than in the table because it is not a
// value being set: choosing an orientation with no sheet up also puts a sheet
// up, which is a rule about paper. The table can say what a control *is*; this
// is a thing one control *does*.

import { board, bus, setSetting } from '../state.ts';
import { VERSION } from '../version.js';
import { el } from '../util.ts';
import { readPref, writePref } from '../prefs.ts';
import { runCommand } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { buildPanel, paintPanel } from './panel.ts';
import { paintTitleField, wireTitleField } from './board-title.ts';

/**
 * What this module needs of the command surface.
 *
 * Every action button in the panel is a `data-cmd` reached by name, so the
 * index signature is the real contract here - commands.ts builds one object
 * literal and this file only ever looks into it with a string. `setBoardMode`
 * is spelled out because it is the one command called directly rather than by a
 * button, and it takes what readPref() gives back.
 */
export interface SidebarCommands {
  setBoardMode: (mode: string | null) => void;
  [name: string]: ((...args: never[]) => void) | undefined;
}

/** The pointer lifecycle of one isolated slider, as createMobileSliderFocus() returns it. */
export interface SliderFocus {
  begin: (target: Element | null, id?: number | null) => boolean;
  end: (id?: number | null) => boolean;
  clear: () => void;
}

let sidebar: HTMLElement | null, menuBtn: HTMLElement | null;
let sliderFocus: SliderFocus;
const MODE_PREF = 'mbrd.boardMode';
const MOBILE_LAYOUT_QUERY = '(max-width: 700px)';

/** Match the same narrow-screen breakpoint used by the CSS. */
export function mobileLayoutDetected(
  media: (query: string) => MediaQueryList | undefined =
    query => globalThis.matchMedia?.(query),
): boolean {
  return typeof media === 'function' && !!media(MOBILE_LAYOUT_QUERY)?.matches;
}

/**
 * Temporarily isolate one range control while a finger is moving it.
 *
 * Kept independent of event registration so the pointer lifecycle stays
 * headless-testable. Delegation in initSidebar means controls built at runtime
 * are covered without maintaining a second list of sliders here.
 */
export function createMobileSliderFocus(root: HTMLElement, {
  isMobile = mobileLayoutDetected,
}: { isMobile?: () => boolean } = {}): SliderFocus {
  let active: Element | null = null;
  let pointerId: number | null = null;

  const restore = () => {
    active?.classList.remove('is-slider-active');
    root.classList.remove('is-slider-focus');
    active = null;
    pointerId = null;
  };

  const clear = () => restore();

  const begin = (target: Element | null, id: number | null = null) => {
    if (!isMobile() || !target?.matches?.('input[type="range"]')) return false;
    active?.classList.remove('is-slider-active');
    active = target;
    pointerId = id;
    active.classList.add('is-slider-active');
    root.classList.add('is-slider-focus');
    return true;
  };

  const end = (id: number | null = null) => {
    if (!active) return false;
    if (pointerId !== null && id !== null && pointerId !== id) return false;
    restore();
    return true;
  };

  return { begin, end, clear };
}

export function initSidebar(cmds: SidebarCommands): void {
  // Every id below is declared in index.html beside #sidebar itself; this
  // module has always read them straight through, and an absent one is a broken
  // build rather than a state to recover from.
  sidebar = el('sidebar');
  menuBtn = el('menu-btn');
  sliderFocus = createMobileSliderFocus(sidebar!);

  menuBtn!.addEventListener('click', () => (isOpen() ? close() : open()));
  el('side-close')!.addEventListener('click', close);

  sidebar!.addEventListener('pointerdown', e => {
    // SAFETY: a pointerdown delivered to #sidebar landed on an element inside
    // it - the panel is markup, and `target` is only typed EventTarget because
    // an event can come off something that is not a node at all.
    sliderFocus.begin(e.target as Element | null, e.pointerId);
  });
  const endSliderFocus = (e: PointerEvent) => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  sidebar!.addEventListener('lostpointercapture', endSliderFocus, true);

  // Every action button in the panel is a data-cmd; the map is the whole API.
  sidebar!.addEventListener('click', e => {
    // SAFETY: as above - a click on #sidebar landed on an element inside it.
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    // Every button in the panel says so, from the one place that knows a button
    // was pressed. Here rather than in each command, for exactly the reason this
    // listener is delegated at all: there are thirty of them and they arrive by
    // name. A command that goes on to change something says that too, on top -
    // pressing Grid is a press and a toggle, and it sounds like both.
    //
    // After the lookup: a data-cmd naming nothing did nothing, and an interface
    // that answers a press it did not act on is worse than one that is quiet.
    cue('pick');
    // Through runCommand(), so an async command that rejects says so instead of
    // reading as a press that did nothing - see notify.ts. The button's own
    // words are what gets reported, because they are what was pressed.
    runCommand(fn(), (btn.textContent || '').trim() || 'That');
    // And on a phone, get out of the way of what was just done.
    //
    // The panel is the whole screen at this width - mobile.css insets #sidebar
    // to all four edges - so a button whose result is on the board fires into
    // something nobody can see: press Rearrange and the panel sits there looking
    // exactly as it did, over a board that has been rebuilt. Which rows those
    // are is `closesPanel` in ui/settings-schema.ts, stated beside each label.
    //
    // Gated on the *width* and not on ctx.mobile, and the two are different
    // things worth keeping apart. ctx.mobile is the board's own Mobile/Desktop
    // presentation, which is a preference and can be set to Desktop on a phone;
    // what makes the panel cover the screen is the media query, and that is the
    // whole of the problem here. On a wide window the board is visible beside
    // the panel and taking it away would be the bug.
    //
    // After the command rather than before, the same order ui/toolbar.js runs
    // in: a command that throws on its way in should leave the panel where the
    // press was, so there is something on screen to have another go at.
    if (btn.dataset.closesPanel !== undefined && mobileLayoutDetected()) close();
  });

  // The file carries both arrangements, while each device remembers which one
  // it wants to work in. This lets the same board open Mobile on a phone and
  // Desktop on a laptop without either save changing the other's preference.
  const detected = mobileLayoutDetected() ? 'mobile' : 'desktop';
  cmds.setBoardMode(readPref(MODE_PREF, detected));

  wirePaperOrientation();
  // SAFETY: #board-title is the Board tab's `type: 'text'` control, so the
  // schema renders it as an <input> - which is the element this call and
  // paintTitleField() below both want. The null is kept: the tab may not have
  // been built yet, and ui/board-title.ts takes the absence.
  wireTitleField(el('board-title') as HTMLInputElement | null);

  el('version')!.textContent = 'v' + VERSION;

  bus.on('board', paint);
  bus.on('settings', paint);
  bus.on('layout', (mode: string) => {
    writePref(MODE_PREF, mode);
    paint();
  });
  // The Feed and Playlist buttons show which lens is up, and a lens switch is the
  // one change that moves that without a layout or a setting behind it.
  bus.on('lens', paint);
  paint();
  restoreOpen();
}

/**
 * The two orientation buttons.
 *
 * A radio group in behaviour, drawn with aria-pressed so the pressed one reads
 * as the current state to a screen reader as well as to the eye - the panel
 * paints that; this is only what a press means.
 */
function wirePaperOrientation(): void {
  const row = document.getElementById('paper-orient');
  if (!row) return;
  for (const btn of row.querySelectorAll<HTMLElement>('[data-orient]')) {
    btn.addEventListener('click', () => {
      // Choosing an orientation with no sheet chosen would be setting a state
      // nothing can show, so it puts a sheet up as well. A4 because it is the
      // one everybody means by "a page", and because the alternative - a dead
      // button until a dropdown two rows up has been touched - is worse.
      if (!board.settings.paper) setSetting('paper', 'a4');
      setSetting('paperLandscape', btn.dataset.orient === 'landscape');
    });
  }
}

/** Push state back into the controls (after opening a board, or an undo). */
function paint(): void {
  // The name field's behaviour lives in ui/board-title.js now - the masthead's
  // panel grew a second one, and one rename showing up in both is only true
  // while there is one implementation of it.
  // SAFETY: as at wireTitleField() above.
  paintTitleField(el('board-title') as HTMLInputElement | null);
  paintPanel();
}

// Deliberately non-modal: no scrim, nothing disabled behind it. The board keeps
// panning, zooming, accepting drops and responding to keys while the panel is
// open, so you can leave it open and keep working - which is also why the open
// state is worth remembering across reloads. It follows the user rather than
// the board, so it lives in localStorage and not in the .mbrd: how you like to
// work is not a property of someone else's moodboard.
const OPEN_KEY = 'mbrd.sidebar';

const isOpen = () => sidebar?.classList.contains('is-open');

export function open(): void {
  setOpen(true);
}

export function close(): void {
  if (!sidebar) return;
  sliderFocus?.clear();
  setOpen(false);
}

function setOpen(want: boolean, remember = true): void {
  sidebar!.classList.toggle('is-open', want);
  sidebar!.setAttribute('aria-hidden', String(!want));
  menuBtn!.setAttribute('aria-expanded', String(want));
  if (!remember) return;
  writePref(OPEN_KEY, want ? '1' : '0');
}

/** Reopen the panel on load, without playing the slide-in for it. */
function restoreOpen(): void {
  if (readPref(OPEN_KEY) !== '1') return;
  // Already-open is a fact about the page, not a thing that just happened, so
  // it should not animate. One frame with the transition off is enough.
  sidebar!.style.transition = 'none';
  setOpen(true, false);
  requestAnimationFrame(() => { sidebar!.style.transition = ''; });
}

/** Build the panel's DOM. Called before the modules that reach into it. */
export { buildPanel };

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
