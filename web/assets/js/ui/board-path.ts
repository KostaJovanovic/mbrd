// The way back up out of a board inside another: the trail of boards above
// the one on screen, each a button (#board-path), and a desktop browser's Back
// button. Phones and the apps go back through main.ts's onBack instead, which
// already owns their Back. The level change itself is commands/boards.ts's.

import { el, isRecord } from '../util.ts';
import { bus, boardPath, boardTrail, levelSwap } from '../state.ts';
import { isDesktop } from '../platform/platform.ts';

/** Back out to `level` (0 is the top), one board at a time. */
type LeaveTo = (level: number) => Promise<void>;

let leaveTo: LeaveTo = async () => {};

/** Whether this page keeps a history entry per level: a desktop browser, whose
 *  Back is a navigation. Not a phone or an installed copy, where
 *  platform.ts's guard entry is the Back, and not the apps. */
let tracking = false;

/** Pops this module made itself, to take entries a level change by hand left. */
let quiet = 0;

/** A Back being answered: the leaving it starts must not pop again. */
let popping = false;

const levelOf = (state: unknown) =>
  (isRecord(state) && typeof state.mbrdLevel === 'number' ? state.mbrdLevel : 0);

export function initBoardPath(leave: LeaveTo) {
  leaveTo = leave;
  const nav = el('board-path');
  if (!nav) return;
  nav.addEventListener('click', e => {
    const button = e.target instanceof Element ? e.target.closest<HTMLElement>('button[data-level]') : null;
    if (button) void leaveTo(Number(button.dataset.level));
  });
  tracking = !isDesktop() && typeof matchMedia === 'function'
    && !matchMedia('(pointer: coarse)').matches && !matchMedia('(display-mode: standalone)').matches;
  bus.on('board', paint);
  bus.on('board:load', () => {
    paint();
    // Going in is a place Back can return from.
    if (tracking && levelSwap() === 'in') history.pushState({ mbrdLevel: boardPath().length }, '');
  });
  if (tracking) {
    addEventListener('popstate', e => {
      if (quiet) { quiet--; return; }
      const want = levelOf(e.state);
      if (want >= boardPath().length) return;
      popping = true;
      void leaveTo(want).finally(() => { popping = false; });
    });
  }
  paint();
}

/**
 * After coming out by hand - the trail, the menu, the key: the entries that
 * going in pushed are now behind the board on screen, and a Back would land on
 * them and do nothing. Popped quietly, all at once.
 */
export function settleHistory() {
  if (!tracking || popping) return;
  const extra = levelOf(history.state) - boardPath().length;
  if (extra <= 0) return;
  quiet++;
  history.go(-extra);
}

/** The trail: a button per board above, the one on screen as plain text, and
 *  the phone's single "back to the one above" form. Hidden at the top. */
function paint() {
  const nav = el('board-path');
  if (!nav) return;
  const trail = boardTrail();
  nav.hidden = trail.length < 2;
  if (nav.hidden) { nav.replaceChildren(); return; }
  const parts: Node[] = [];
  const up = button(trail.length - 2, `‹ ${trail[trail.length - 2]}`);
  up.classList.add('path-up');
  parts.push(up);
  trail.slice(0, -1).forEach((name, level) => {
    parts.push(button(level, name));
    const sep = document.createElement('span');
    sep.className = 'path-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '›';
    parts.push(sep);
  });
  const here = document.createElement('span');
  here.className = 'path-here';
  here.setAttribute('aria-current', 'page');
  here.textContent = trail[trail.length - 1];
  parts.push(here);
  nav.replaceChildren(...parts);
}

function button(level: number, label: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.level = String(level);
  b.textContent = label;
  return b;
}
