// The title bar, where the app has to draw its own.
//
// The desktop shell opens a window with no caption bar (desktop/main.ts says
// why), so this module is what puts one back. Two elements, both of them in
// index.html and both shipped `hidden` -
//
//   **The bar**, #window-drag, a strip of paper across the top edge with a
//   hairline along its foot. It is a `-webkit-app-region: drag` box, which is
//   the whole of how a frameless window is moved: Chromium hands such a box
//   every press that lands on it and the page never hears one. It carries the
//   app's mark at the left and the board's name on the window's axis, with a
//   dot in front of the name while there is unsaved work - the same two facts
//   the shell writes into the OS window title, said again where a person is
//   already looking rather than in the taskbar. Neither is a control, and the
//   mark is dropped on macOS, where the traffic lights are in that corner.
//
//   The controls under the bar stay pressable, and **not because the bar is
//   under them**. A drag region is hit-tested by the window manager before the
//   page hears anything, and a stacking order does not hold it back. What holds
//   it back is `-webkit-app-region: no-drag` on `body`, inherited by every box
//   on the page so that each one subtracts itself from the region. That rule and
//   the paragraph arguing it are in chrome.css, and it is load-bearing: without
//   it every control the bar overlaps is drawn, hovers nothing and presses
//   nothing, on the desktop only, with nothing logged.
//
//   **Three buttons**, squared into the bar's right-hand corner, close in the
//   true corner where a pointer thrown at it lands. They do not fade with the
//   furniture when the app goes idle and they do not go during a tour: they are
//   the window's frame rather than the board's, and no window on any desktop
//   empties its caption because nobody moved the mouse.
//
// An earlier version drew no bar - the band was invisible and the buttons
// floated as a pill in the top-right corner of the glass. chrome.css's frame
// section records why that went and what replaced it.
//
// ── What this module decides, which is nothing ──
//
// Whether there is a frame to draw is `platform.frame.own()`, which is the
// shell's answer and not a guess about the engine. Where the system already
// keeps buttons is `systemLeft()`, which is macOS. What the three buttons *do*
// is three entries in `cmds`. What any of it looks like is chrome.css. This
// file unhides two elements, writes two classes on <html>, and forwards a
// data-cmd - and on the web it does not even do that, because `own()` is false
// and the function returns before touching anything.
//
// `cmds` is handed in rather than imported, for the reason ui/toolbar.ts states:
// commands.ts is above this file and the arrow may only go one way.
//
// ── The two classes ──
//
// `is-framed` is what turns the whole thing on, and every rule in chrome.css
// for this hangs off it, so a browser gets exactly the stylesheet it had before
// this module existed. `is-fullscreen` takes the bar away again, because full
// screen is the system's own affair and it draws its own way out. Both go on
// <html> rather than on the elements, the way `is-connecting` and `data-whimsy`
// do, because what they describe is the shape of the window and not the state of
// one control in it.

import { el } from '../util.ts';
import { board, bus, isDirty } from '../state.ts';
import { platform } from '../platform/platform.ts';
import { runCommand } from '../notify.ts';

/** data-cmd="window-close" -> cmds.windowClose. The toolbar's own mapping. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The command surface as this module sees it: a lookup by name and nothing
 * else, exactly as ui/toolbar.ts takes it. The three names it will ever ask for
 * are the three data-cmds in the markup.
 */
export interface WindowCommands {
  [name: string]: ((...args: never[]) => void) | undefined;
}

/**
 * The board's name in the bar, and the dot in front of it when there is
 * unsaved work.
 *
 * The same two events storage.ts's reportDocument() listens to, read from the
 * same two places - `board` and `isDirty()` - so the strip and the OS window
 * title cannot disagree about what is on screen. Two listeners rather than one:
 * state.ts emits `board` for a rename and for a dirty-flag flip, and
 * `board:load` for a board arriving, and the bar has to answer all three.
 *
 * "Untitled board" is showDocument()'s fallback in desktop/main.ts, written
 * again here for the same reason it is written there: an empty title is a bar
 * with a hole in it, and the two must say the same word.
 */
function watchTitle(title: HTMLElement): void {
  const paint = (): void => {
    title.textContent = board.title || 'Untitled board';
    title.toggleAttribute('data-dirty', isDirty());
  };
  bus.on('board', paint);
  bus.on('board:load', paint);
  paint();
}

export function initWindowChrome(cmds: WindowCommands): void {
  // The gate, and it is first for a reason: in a browser this must be a
  // function that returns, not a function that hides something afterwards. Both
  // elements ship `hidden` in index.html, so a web visitor never has them in
  // the layout even for the frame between boot and this call.
  if (!platform.frame.own()) return;

  const root = document.documentElement;
  root.classList.add('is-framed');

  const band = el('window-drag');
  const controls = el('window-controls');
  // The band goes up everywhere, including macOS: the traffic lights are in the
  // corner and the rest of the top edge is still the app's to be dragged by.
  band!.hidden = false;
  // The buttons do not. macOS already has three in the opposite corner, and a
  // second set would be the app disagreeing with the system about how many ways
  // there are to shut a window.
  controls!.hidden = platform.frame.systemLeft();
  // Neither does the mark, and it is the same question rather than a second
  // one: macOS keeps its traffic lights in the corner this sits in.
  el('window-mark')!.hidden = platform.frame.systemLeft();
  watchTitle(el('window-title')!);

  controls!.addEventListener('click', e => {
    // SAFETY: the listener is on #window-controls, so a click delivered to it
    // landed on an element inside it - closest() is only being asked whether an
    // ancestor carries a data-cmd.
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    // Through runCommand for the reason the toolbar and the panel are: a
    // command that threw would otherwise read as a button that did nothing.
    // None of these three can, today - each is one message down the bridge -
    // and that is not a reason to be the one dispatcher in the app that drops
    // the answer.
    runCommand(fn(), btn.getAttribute('aria-label') || 'That');
  });

  // No cue on these. The cues in this app say something happened *on the
  // board*; a sound for minimising a window would be the app remarking on
  // something the system did, and the system already has its own.


  // What shape the window is in, pushed by the shell. Two writes, both of them
  // the shape rather than a transition - see reportFrame() in desktop/main.ts
  // for why a renderer must not keep its own tally.
  platform.frame.onState(state => {
    controls!.classList.toggle('is-maximized', !!state.maximized);
    // Full screen is the system's own affair: it draws a way out, the window
    // has no edges to drag by, and furniture in the corner of a presentation is
    // the one thing full screen is for getting rid of.
    root.classList.toggle('is-fullscreen', !!state.fullScreen);
  });
}
