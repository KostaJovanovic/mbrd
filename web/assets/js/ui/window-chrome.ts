// The title bar, where the app has to draw its own.
//
// The desktop shell opens a window with no caption bar (desktop/main.ts says
// why), so this module is what puts one back. It is deliberately not a bar:
// mbrd is an infinite sheet with its furniture floating over it, and a strip
// across the top would be the one rectangle in the window that obeys none of
// the board's palette, corners or whimsy dial. What goes on screen instead is
// two things a person never looks at directly -
//
//   **A drag band** along the top edge, invisible, 32 pixels tall. Chromium
//   hands a `-webkit-app-region: drag` element every press that lands on it and
//   the page never sees one, so this is the whole of what the window costs the
//   board: a strip at the top that a gesture cannot *start* in. A gesture that
//   started lower and travels through it is unaffected - the pointer is
//   captured by then - and the band sits *under* every piece of glass chrome,
//   so the menu button, the toolbar and the buttons below are pressed normally.
//   It is thirty-two rather than the fifty-six the chrome row occupies because
//   that is the trade: enough to grab without looking, little enough that the
//   board keeps almost all of its top edge.
//
//   **Three buttons** in the top-right corner, which is the one corner of the
//   glass this app has never used. They are a pill in the same idiom as the
//   zoom cluster and the toolbar - --paper-card behind a hairline, --leaf at the
//   corners, --shadow-1 under it - and they fade with the rest of the furniture
//   when the app goes idle, because a window control that stayed lit over a
//   board nobody is touching would be the only object on screen still talking.
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
// this module existed. `is-frame-mac` moves the app's top-left button clear of
// the traffic lights. Both go on <html> rather than on the elements, the way
// `is-connecting` and `data-whimsy` do, because what they describe is the shape
// of the window and not the state of one control in it.

import { el } from '../util.ts';
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

export function initWindowChrome(cmds: WindowCommands): void {
  // The gate, and it is first for a reason: in a browser this must be a
  // function that returns, not a function that hides something afterwards. Both
  // elements ship `hidden` in index.html, so a web visitor never has them in
  // the layout even for the frame between boot and this call.
  if (!platform.frame.own()) return;

  const root = document.documentElement;
  root.classList.add('is-framed');
  root.classList.toggle('is-frame-mac', platform.frame.systemLeft());

  const band = el('window-drag');
  const controls = el('window-controls');
  // The band goes up everywhere, including macOS: the traffic lights are in the
  // corner and the rest of the top edge is still the app's to be dragged by.
  band!.hidden = false;
  // The buttons do not. macOS already has three in the opposite corner, and a
  // second set would be the app disagreeing with the system about how many ways
  // there are to shut a window.
  controls!.hidden = platform.frame.systemLeft();

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
