// Up up down down left right left right B A.
//
// The whole of this file is the switch; the skin itself is assets/css/skin90.css
// and it is not fetched until the sequence lands. That is the point of doing it
// this way rather than shipping the rules inside app.css behind an attribute:
// four typefaces and a wallpaper is about 450KB, and a board that never finds
// the egg should not carry it.
//
// Not persisted, deliberately. An easter egg that survives a reload stops being
// one and becomes a setting somebody has to find the way back out of - and it
// would have to go in the board file or in local storage, which means either
// every copy of that board arrives in fancy dress or the machine remembers a
// joke longer than the person who made it. Entering the code again turns it
// off; so does Escape.

import { toast } from '../util.js';

const SEQUENCE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a',
];

const HREF = 'assets/css/skin90.css';

const MARQUEE =
  '✦ WELCOME TO MBRD ✦ BEST VIEWED IN 800x600 ✦ ' +
  'THIS BOARD IS UNDER CONSTRUCTION ✦ SIGN THE GUESTBOOK ✦ ' +
  'NO FRAMES NO JAVA NO PROBLEM ✦ ';

let at = 0;
let sheet = null;
let marquee = null;

export function initKonami() {
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.documentElement.dataset.skin) {
      off();
      return;
    }
    // Typing "a" into a note is not a Konami code. Anything with a caret in it
    // owns its own keystrokes, the same rule the rest of the shortcuts follow.
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) {
      at = 0;
      return;
    }

    const want = SEQUENCE[at];
    // Case-insensitive on the letters only: the arrow keys are named exactly.
    const hit = want.length === 1
      ? e.key.toLowerCase() === want
      : e.key === want;

    if (!hit) {
      // A wrong key does not simply reset to zero - it may itself be the start
      // of a fresh attempt, which is what makes "up up up down down..." work
      // rather than needing a clean run from a standing start.
      at = e.key === SEQUENCE[0] ? 1 : 0;
      return;
    }

    at++;
    if (at < SEQUENCE.length) return;
    at = 0;
    document.documentElement.dataset.skin ? off() : on();
  });
}

function on() {
  document.documentElement.dataset.skin = '90s';

  if (!sheet) {
    sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = HREF;
    // If the sheet cannot be had - a shell cached before this file existed,
    // say - the attribute is taken back off rather than leaving the app in a
    // half-dressed state where the marquee is up and nothing else changed.
    sheet.addEventListener('error', () => {
      off();
      toast('The skin could not be loaded');
    });
    document.head.append(sheet);
  }

  marquee = document.createElement('div');
  marquee.id = 'skin90-marquee';
  marquee.setAttribute('aria-hidden', 'true');
  const run = document.createElement('span');
  // Twice, so the tail of one pass is still on screen as the head of the next
  // arrives - a single copy leaves a gap the width of the window.
  run.textContent = MARQUEE + MARQUEE;
  marquee.append(run);
  document.body.append(marquee);

  toast('✦ 1997 ✦');
}

function off() {
  delete document.documentElement.dataset.skin;
  marquee?.remove();
  marquee = null;
  // The <link> stays. Removing it would drop the parsed sheet and the four
  // faces with it, and turning the skin back on - which is the whole gesture
  // this supports - would refetch the lot.
}
