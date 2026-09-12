// Slide-in sidebar: open/close, delegated data-cmd dispatch, mobile slider
// isolation, paper orientation, and the board-title wiring. Controls
// themselves live in settings-schema.ts + panel.ts.

import { board, bus, setSetting } from '../state.ts';
import { VERSION } from '../version.js';
import { el } from '../util.ts';
import { readPref, writePref } from '../prefs.ts';
import { runCommand } from '../notify.ts';
import { cue } from '../cuelume/engine.ts';
import { buildPanel, paintPanel } from './panel.ts';
import { paintTitleField, wireTitleField } from './board-title.ts';

/** Command surface: index lookup by name + setBoardMode called directly. */
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

/** Isolate one slider under a finger. Headless-testable; event wiring is in initSidebar. */
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
  // All ids declared in index.html beside #sidebar.
  sidebar = el('sidebar');
  menuBtn = el('menu-btn');
  sliderFocus = createMobileSliderFocus(sidebar!);

  menuBtn!.addEventListener('click', () => (isOpen() ? close() : open()));
  el('side-close')!.addEventListener('click', close);

  sidebar!.addEventListener('pointerdown', e => {
    sliderFocus.begin(e.target as Element | null, e.pointerId);
  });
  const endSliderFocus = (e: PointerEvent) => sliderFocus.end(e.pointerId);
  globalThis.addEventListener('pointerup', endSliderFocus);
  globalThis.addEventListener('pointercancel', endSliderFocus);
  sidebar!.addEventListener('lostpointercapture', endSliderFocus, true);

  sidebar!.addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    cue('pick');
    // Via runCommand so rejects surface instead of looking like dead buttons.
    const result: unknown = fn();
    runCommand(result, (btn.textContent || '').trim() || 'That');
    // On mobile the panel covers the board — close after action.
    // Gated on viewport width, not ctx.mobile (user can set Desktop on a phone).
    // 'if-done' waits for the command to settle before closing.
    const closes = btn.dataset.closesPanel;
    if (closes === undefined || !mobileLayoutDetected()) return;
    if (closes === 'if-done') {
      void Promise.resolve(result).then(done => { if (done) close(); }, () => {});
      return;
    }
    close();
  });

  // Each device remembers its preferred layout independently.
  const detected = mobileLayoutDetected() ? 'mobile' : 'desktop';
  cmds.setBoardMode(readPref(MODE_PREF, detected));

  wirePaperOrientation();
  // May be null if the tab has not been built yet — board-title.ts handles that.
  wireTitleField(el('board-title') as HTMLInputElement | null);

  el('version')!.textContent = 'v' + VERSION;

  bus.on('board', paint);
  bus.on('settings', paint);
  bus.on('layout', (mode: string) => {
    writePref(MODE_PREF, mode);
    paint();
  });
  // Lens switch updates Feed/Playlist button state.
  bus.on('lens', paint);
  paint();
  restoreOpen();
}

/** Wire the two paper-orientation buttons. Choosing one with no sheet also sets paper to a4. */
function wirePaperOrientation(): void {
  const row = document.getElementById('paper-orient');
  if (!row) return;
  for (const btn of row.querySelectorAll<HTMLElement>('[data-orient]')) {
    btn.addEventListener('click', () => {
      if (!board.settings.paper) setSetting('paper', 'a4');
      setSetting('paperLandscape', btn.dataset.orient === 'landscape');
    });
  }
}

/** Push state back into the controls (after opening a board, or an undo). */
function paint(): void {
  // board-title.ts owns the field — may be null (as above).
  paintTitleField(el('board-title') as HTMLInputElement | null);
  paintPanel();
}

// Non-modal: board stays interactive behind the panel. Open state persisted
// per user in localStorage, not per board.
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
  // Suppress the slide-in animation on restore.
  sidebar!.style.transition = 'none';
  setOpen(true, false);
  requestAnimationFrame(() => { sidebar!.style.transition = ''; });
}

/** Build the panel's DOM. Called before the modules that reach into it. */
export { buildPanel };

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
