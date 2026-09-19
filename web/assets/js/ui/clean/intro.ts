// The cleaning game's opening: the screen goes black, today's date runs forward
// faster and faster until it is lost, somebody says a few lines, and a star
// opens onto the dirty board. Played over a board already dealt, so the reveal
// is the real thing. Owns nothing but its own overlay; clean.ts routes the keys.

import { cue } from '../../cuelume/engine.ts';

/** What was said, in order, one bubble each. A bubble in parts stops after
 *  each part and waits for a click, then carries on in the same bubble - "Wait."
 *  is a beat on its own. The last bubble is the one the star opens on. */
const LINES: readonly (readonly string[])[] = [
  ['Wait.', ' You came back?'],
  ["It's been such a long time..."],
  ['We should have never lost hope...'],
  ["Alright, let's get this place cleaned up!"],
];

/** The black coming up, and the date after it. */
const DARK_MS = 700;
const DATE_IN_MS = 1300;
/** How long the date runs for, and the point where it starts to smear. */
const SPIN_MS = 4800;
const BLUR_FROM = 0.45;
const BLUR_MAX = 7;
/** Days a second at the start, and how fast that grows: a couple of days at
 *  first, the months turning by two seconds in, the years by three, and
 *  decades a second at the end. */
const RATE_START = 1.4;
const RATE_GROW = 2.1;
/** The lost date on screen before anybody speaks. */
const LOST_MS = 1100;

/** A letter, and the extra beat after a stop or a comma. */
const CHAR_MS = 32;
const STOP_MS = 220;
const COMMA_MS = 130;

/** The star: a quick pop to a peephole, a held breath, then all the way. */
const POP_MS = 300;
const PEEK_MS = 280;
const OPEN_MS = 900;
const PEEK = 9;
/** Wide enough that the star's inner corners clear the corners of any window
 *  (see the viewBox below: 70.7 units, over an inner radius of 0.45). */
const COVER = 170;

export type Intro = {
  /** Enter, Space or a click: finish the line being typed, or go on. */
  advance(): void,
  /** Escape: straight to the star. */
  skip(): void,
  /** The mode closing under it: everything gone, and nobody told. */
  stop(): void,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** The square every layer of the sheet is, reaching past the viewBox on all
 *  sides so no window shape finds its edge. */
const SQUARE = { x: '-50', y: '-50', width: '200', height: '200' };

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const stamp = (d: Date) =>
  `${pad(d.getFullYear(), 4)}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)}`;

/** A five-pointed star round the origin, outer radius 1. */
function starPath(): string {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.45 : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    d += `${i ? 'L' : 'M'}${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`;
  }
  return d + 'Z';
}

/**
 * Play it. `motion` false - the quality dial's animation off - keeps the words
 * and drops the movement: the date goes straight to lost, a line arrives
 * whole, and the black fades rather than opening.
 */
export function playIntro(onDone: () => void, motion: boolean): Intro {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let raf = 0;
  let phase: 'dark' | 'date' | 'lost' | 'talk' | 'reveal' | 'gone' = 'dark';
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const frames = (step: (now: number) => boolean) => {
    const loop = (now: number) => { raf = step(now) ? requestAnimationFrame(loop) : 0; };
    raf = requestAnimationFrame(loop);
  };

  // ---- the overlay ----
  const root = document.createElement('div');
  root.className = 'clean-intro';
  // Sliced, so the square covers the window whatever its shape and the star
  // stays a star; its middle is the window's.
  const sheet = svgNode('svg', {
    class: 'clean-intro-sheet', viewBox: '0 0 100 100',
    preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true',
  });
  const mask = svgNode('mask', { id: 'clean-intro-hole', maskUnits: 'userSpaceOnUse', ...SQUARE });
  // Round on the points a little, the way a drawn star is.
  const star = svgNode('path', {
    d: starPath(), fill: 'black', stroke: 'black', 'stroke-width': '0.12', 'stroke-linejoin': 'round',
    transform: 'translate(50 50) scale(0)',
  });
  mask.append(svgNode('rect', { ...SQUARE, fill: 'white' }), star);
  const defs = svgNode('defs', {});
  defs.append(mask);
  sheet.append(defs, svgNode('rect', { ...SQUARE, class: 'clean-intro-dark', mask: 'url(#clean-intro-hole)' }));

  const stage = document.createElement('div');
  stage.className = 'clean-intro-stage';
  const date = document.createElement('div');
  date.className = 'clean-intro-date';
  // Decoration: a screen reader would hear a column of rolling digits.
  date.setAttribute('aria-hidden', 'true');
  const today = new Date();
  const dayAt = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  // One reel per digit, each a window onto a strip of 0-9 twice over, so a
  // digit can always roll *forward* to the next one, 9 to 0 included. The
  // strip runs high to low from the top, so rolling forward moves it down and
  // the next digit drops in from above. The dots are fixed between them.
  const reels: (HTMLElement | null)[] = [];
  for (const ch of stamp(today)) {
    if (ch === '.') {
      date.append('.');
      reels.push(null);
      continue;
    }
    const cell = document.createElement('span');
    cell.className = 'clean-intro-cell';
    const reel = document.createElement('span');
    reel.className = 'clean-intro-reel';
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('span');
      d.textContent = String((19 - i) % 10);
      reel.append(d);
    }
    cell.append(reel);
    date.append(cell);
    reels.push(reel);
  }
  // `at` is the digit showing, 0-19 and fractional between two: 3.5 is half
  // way from 3 to 4. Strip item k shows (19 - k) % 10, so `at` sits at 19 - at.
  const roll = (i: number, at: number) => { reels[i]!.style.transform = `translateY(${(at - 19).toFixed(3)}em)`; };
  [...stamp(today)].forEach((ch, i) => { if (reels[i]) roll(i, Number(ch)); });
  // The bubble: what has been typed so far, and the whole line for a screen
  // reader, which should hear it once rather than a letter at a time.
  const bubble = document.createElement('div');
  bubble.className = 'clean-intro-say';
  const typed = document.createElement('p');
  typed.setAttribute('aria-hidden', 'true');
  const heard = document.createElement('p');
  heard.className = 'clean-intro-heard';
  heard.setAttribute('aria-live', 'polite');
  const next = document.createElement('span');
  next.className = 'clean-intro-next';
  next.setAttribute('aria-hidden', 'true');
  bubble.append(typed, heard, next);
  stage.append(date, bubble);
  root.append(sheet, stage);
  root.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 0) advance();
  });
  document.body.append(root);
  // Read once, so the transparent start is committed before the fade is asked
  // for; a class added a frame later was sometimes styled in the same pass as
  // the append, and the black arrived at once.
  void root.offsetWidth;
  root.classList.add('is-in');

  // ---- the date ----
  let spinFrom = 0;
  let offset = 0;
  let last = 0;

  function spin(now: number): boolean {
    if (phase !== 'date') return false;
    if (!spinFrom) { spinFrom = now; last = now; }
    const s = (now - spinFrom) / 1000;
    offset += RATE_START * Math.exp(RATE_GROW * s) * ((now - last) / 1000);
    last = now;
    if (now - spinFrom >= SPIN_MS) { lose(); return false; }
    // Every digit that changes between this day and the next scrolls down to it
    // over the day, together, the way an odometer turns over. A little hold at
    // the start of each day, so the first slow days read as steps.
    const whole = Math.floor(offset);
    const from = stamp(dayAt(whole));
    const to = stamp(dayAt(whole + 1));
    const f = offset - whole;
    const e = f < 0.3 ? 0 : (f - 0.3) / 0.7;
    const k = e * e * (3 - 2 * e);
    for (let i = 0; i < from.length; i++) {
      if (!reels[i]) continue;
      const a = Number(from[i]);
      const b = Number(to[i]);
      roll(i, a + ((b >= a ? b : b + 10) - a) * k);
    }
    const smear = Math.max(0, (now - spinFrom) / SPIN_MS - BLUR_FROM) / (1 - BLUR_FROM);
    date.style.filter = smear > 0 ? `blur(${(smear * smear * BLUR_MAX).toFixed(2)}px)` : '';
    // A shiver, growing with the blur: it is not keeping up.
    date.style.translate = smear > 0 ? `${((Math.random() - 0.5) * smear * 6).toFixed(1)}px 0` : '';
    return true;
  }

  function lose() {
    if (phase !== 'date' && phase !== 'dark') return;
    phase = 'lost';
    date.textContent = '????.??.??';
    date.style.filter = '';
    date.style.translate = '';
    date.classList.add('is-shown', 'is-lost');
    later(talk, LOST_MS);
  }

  later(() => {
    if (phase !== 'dark') return;
    phase = 'date';
    date.classList.add('is-shown');
    later(() => {
      if (phase !== 'date') return;
      if (motion) frames(spin);
      else lose();
    }, DATE_IN_MS);
  }, DARK_MS);

  // ---- the talking ----
  let line = -1;
  let part = 0;
  let shown = 0;
  let typing = false;
  const whole = () => LINES[line]!.join('');
  /** Where the part being typed ends, in the whole bubble's letters. */
  const partEnd = () => LINES[line]!.slice(0, part + 1).join('').length;

  function talk() {
    if (phase !== 'lost') return;
    phase = 'talk';
    bubble.classList.add('is-shown');
    say(0);
  }

  function say(i: number) {
    line = i;
    part = 0;
    shown = 0;
    typed.textContent = '';
    heard.textContent = whole();
    speak();
  }

  /** Type the current part, on from what is already in the bubble. */
  function speak() {
    bubble.classList.remove('is-ready');
    if (!motion) { done(); return; }
    typing = true;
    type();
  }

  function type() {
    if (!typing || phase !== 'talk') return;
    const text = whole();
    shown++;
    typed.textContent = text.slice(0, shown);
    if (shown >= partEnd()) { done(); return; }
    const ch = text[shown - 1]!;
    // Every other letter, quietly: a voice, not a typewriter.
    if (shown % 2 && ch !== ' ') cue('tap');
    later(type, ch === '.' || ch === '?' || ch === '!' ? STOP_MS : ch === ',' ? COMMA_MS : CHAR_MS);
  }

  function done() {
    typing = false;
    shown = partEnd();
    typed.textContent = whole().slice(0, shown);
    bubble.classList.add('is-ready');
  }

  // ---- the star ----
  function reveal() {
    if (phase === 'reveal' || phase === 'gone') return;
    phase = 'reveal';
    typing = false;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    cancelAnimationFrame(raf);
    root.classList.add('is-leaving');
    if (!motion) {
      root.classList.add('is-fading');
      later(finish, 450);
      return;
    }
    later(() => {
      let from = 0;
      frames(now => {
        if (!from) from = now;
        const t = now - from;
        let s: number;
        if (t < POP_MS) {
          const k = t / POP_MS;
          s = PEEK * (1 - (1 - k) ** 3);
        } else if (t < POP_MS + PEEK_MS) {
          s = PEEK;
        } else {
          const k = Math.min(1, (t - POP_MS - PEEK_MS) / OPEN_MS);
          s = PEEK + (COVER - PEEK) * k * k * k;
        }
        const turn = -24 + 36 * Math.min(1, t / (POP_MS + PEEK_MS + OPEN_MS));
        star.setAttribute('transform', `translate(50 50) rotate(${turn.toFixed(1)}) scale(${s.toFixed(2)})`);
        if (t >= POP_MS + PEEK_MS + OPEN_MS) { finish(); return false; }
        return true;
      });
    }, 260);
  }

  function finish() {
    if (phase === 'gone') return;
    phase = 'gone';
    root.remove();
    onDone();
  }

  // ---- what clean.ts calls ----
  function advance() {
    if (phase === 'dark' || phase === 'date') {
      // Past the running date - the lines are the part worth waiting for.
      cancelAnimationFrame(raf);
      raf = 0;
      phase = 'date';
      lose();
      return;
    }
    if (phase !== 'talk') return;
    if (typing) { done(); return; }
    if (part < LINES[line]!.length - 1) { part++; speak(); return; }
    if (line < LINES.length - 1) say(line + 1);
    else reveal();
  }

  return {
    advance,
    skip: reveal,
    stop() {
      phase = 'gone';
      for (const t of timers) clearTimeout(t);
      timers.clear();
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
}
