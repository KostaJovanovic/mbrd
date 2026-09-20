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
/** How long the date runs for. */
const SPIN_MS = 4800;
/** Where in that the line starts to shiver, as a share of it. The blur is not
 *  on this clock: it is per reel and comes off how fast that reel is moving. */
const BLUR_FROM = 0.45;
/** The longest a digit's streak may read as, in pixels. A reel doing decades a
 *  second would otherwise smear the whole line into a grey band. */
const BLUR_MAX = 9;
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

/** The star: a fast pop that coasts a little past the peephole, slowing but
 *  never stopping, then gathers pace and opens all the way. It only ever grows -
 *  a star that stops or shrinks between the two reads as failing and trying
 *  again. */
const POP_MS = 380;
const OPEN_MS = 1000;
const PEEK = 9;
/** How far past the peephole the pop coasts, as a share of it. */
const OVERSHOOT = 0.14;
/** Share of the pop's speed that is still there when it hands over to the open. */
const COAST = 0.15;
/** Where the star starts turned, and how far it turns in all. */
const TURN_FROM = -40;
const TURN = 140;
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
 *
 * `onDark` is called the moment the black is fully up, and is the cue for
 * anything that must happen unseen: the black takes 600ms to arrive and the
 * board is visible through it the whole way, so a mess dealt before this is a
 * mess somebody watched land. `onDone` is the star finished and the mode's.
 */
export function playIntro(onDone: () => void, motion: boolean, onDark: () => void = () => {}): Intro {
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
  // Each reel gets a blur of its own, and it blurs *along the roll* and not
  // sideways: a spinning digit is a vertical streak. A CSS blur() is round, so
  // this is an SVG feGaussianBlur with an x deviation of zero, one filter per
  // reel because each reel moves at its own speed. The filters live in a sheet
  // of their own - a filter referenced from HTML is measured in the referring
  // element's pixels, so the mask sheet's viewBox must not be in the way.
  const fx = svgNode('svg', { class: 'clean-intro-fx', 'aria-hidden': 'true' });
  const fxDefs = svgNode('defs', {});
  fx.append(fxDefs);
  const reels: (HTMLElement | null)[] = [];
  const smears: (SVGFEGaussianBlurElement | null)[] = [];
  /** The blur each reel is wearing, so an unchanged one is not written again. */
  const smeared: number[] = [];
  for (const ch of stamp(today)) {
    if (ch === '.') {
      date.append('.');
      reels.push(null);
      smears.push(null);
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
    // Room above and below for the streak: the default filter region is the
    // element's box plus a tenth, and a smear runs further than that.
    // The default filter region - the strip's box and a tenth over - is two
    // digits' worth of room at either end, which is more than a streak needs.
    const id = `clean-intro-smear-${reels.length}`;
    const filter = svgNode('filter', { id });
    const blur = svgNode('feGaussianBlur', { stdDeviation: '0 0' });
    filter.append(blur);
    fxDefs.append(filter);
    cell.append(reel);
    date.append(cell);
    reels.push(reel);
    smears.push(blur);
  }
  // `at` is the digit showing, 0-19 and fractional between two: 3.5 is half
  // way from 3 to 4. Strip item k shows (19 - k) % 10, so `at` sits at 19 - at.
  const roll = (i: number, at: number) => { reels[i]!.style.transform = `translateY(${(at - 19).toFixed(3)}em)`; };
  [...stamp(today)].forEach((ch, i) => { if (reels[i]) roll(i, Number(ch)); });

  /**
   * How far this reel moved this frame, as a vertical blur.
   *
   * A real camera's smear is the distance the thing travelled while the shutter
   * was open, so this is exactly that: digits moved times the height of one,
   * halved (a Gaussian's deviation is about half the streak it reads as). A
   * digit standing still gets nothing, which is the whole point - the year's
   * first two figures never move and never blur, while the day's last is a
   * streak long before the month has turned.
   */
  const smearBy = (i: number, digits: number, em: number) => {
    const blur = smears[i];
    const reel = reels[i];
    if (!blur || !reel) return;
    const px = Math.min(BLUR_MAX, Math.abs(digits) * em * 0.5);
    // Quantised, and compared before it is written: this runs per reel per
    // frame, a tenth of a pixel of blur is not a thing anybody can see, and a
    // reel standing still carries no filter at all rather than a zero one.
    const want = Math.round(px * 5) / 5;
    if (want === smeared[i]) return;
    smeared[i] = want;
    if (want < 0.2) { reel.style.filter = ''; return; }
    blur.setAttribute('stdDeviation', `0 ${want.toFixed(1)}`);
    reel.style.filter = `url(#clean-intro-smear-${i})`;
  };
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
  root.append(sheet, fx, stage);
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

  // The black is up. Whoever is waiting to do something out of sight is told
  // once, on the transition's own end where there is one, and on a timer a
  // little past it either way - a fade that never fires transitionend (a
  // background tab, a display with the animation cut) must not leave the mode
  // waiting for ever with nothing dealt.
  let dark = false;
  const covered = () => {
    if (dark) return;
    dark = true;
    onDark();
  };
  root.addEventListener('transitionend', e => {
    if (e.target === root && e.propertyName === 'opacity') covered();
  });
  later(covered, DARK_MS);

  // ---- the date ----
  let spinFrom = 0;
  let offset = 0;
  let last = 0;
  /** Where each reel stood last frame, so this frame's move can be measured -
   *  which is what the smear is. Filled on the first frame of the spin. */
  let stood: number[] = [];
  /** One digit's height in pixels, read once: the date's font-size is a clamp()
   *  and reading it per frame would be a style flush per frame. */
  let emPx = 0;

  function spin(now: number): boolean {
    if (phase !== 'date') return false;
    if (!spinFrom) {
      spinFrom = now;
      last = now;
      emPx = parseFloat(getComputedStyle(date).fontSize) || 64;
      stood = [...stamp(today)].map(ch => (ch === '.' ? 0 : Number(ch)));
    }
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
      const at = a + ((b >= a ? b : b + 10) - a) * k;
      roll(i, at);
      // Distance travelled since the last frame, in digits. A reel that has
      // just turned over reads as a jump backwards (9.8 to 0.1) and is really
      // the shortest way forward, which is what the wrap below makes of it.
      let moved = at - (stood[i] ?? at);
      if (moved < -5) moved += 10;
      else if (moved > 5) moved -= 10;
      smearBy(i, moved, emPx);
      stood[i] = at;
    }
    // A shiver that grows as it loses the thread: it is not keeping up. Not the
    // blur any more - that is each reel's own, and this is the whole line.
    const lost = Math.max(0, (now - spinFrom) / SPIN_MS - BLUR_FROM) / (1 - BLUR_FROM);
    date.style.translate = lost > 0 ? `${((Math.random() - 0.5) * lost * 6).toFixed(1)}px 0` : '';
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
      let opened = false;
      cue('pick', { volume: 0.3 });
      const total = POP_MS + OPEN_MS;
      const coasted = PEEK * (1 + OVERSHOOT);
      // The open's ease starts at the speed the pop ends on, in its own terms:
      // growth in scale is exponential there, so the pop's last speed is divided
      // by the log of how far the open has to go.
      const lead = Math.min(1, (COAST * OPEN_MS) / (POP_MS * Math.log(COVER / coasted)));
      frames(now => {
        if (!from) from = now;
        const t = now - from;
        let s: number;
        if (t < POP_MS) {
          // Fast out, slowing towards the peephole and a little past it.
          const k = t / POP_MS;
          s = coasted * ((1 - COAST) * (1 - (1 - k) ** 3) + COAST * k);
        } else {
          const k = Math.min(1, (t - POP_MS) / OPEN_MS);
          if (!opened) { opened = true; cue('rise', { volume: 0.3 }); }
          // Exponential in scale reads as an even rush; eased on top, it gathers pace.
          s = coasted * (COVER / coasted) ** (lead * k + (1 - lead) * k * k);
        }
        // One turn under the whole thing, gathering pace with the open.
        const turn = TURN_FROM + TURN * Math.min(1, t / total) ** 1.6;
        star.setAttribute('transform', `translate(50 50) rotate(${turn.toFixed(1)}) scale(${s.toFixed(2)})`);
        if (t >= total) { finish(); return false; }
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
