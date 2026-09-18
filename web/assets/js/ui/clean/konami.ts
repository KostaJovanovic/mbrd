// The two ways in, as pure matchers: the konami code fed one key at a time by
// the single keydown listener in canvas/input.ts, and seven taps on the
// wordmark for a phone, which has no keyboard to type a code on. Each answers
// true on the press that completes the run. No DOM, no module state - the
// position lives in the closure, so a test can hold two independent matchers
// and nothing leaks between boards.

/** Up up down down left right left right B A. `e.key`, not `e.code`. */
export const KONAMI = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'b', 'a',
] as const;

/**
 * A matcher over `e.key`. No timeout between presses: the code has never had
 * one anywhere it appears, and a half-finished run costs nothing to carry.
 */
export function konamiMatcher() {
  // The last ten keys, rather than a position and a rule for rewinding it.
  // A rewind has to answer what a *third* ArrowUp means - it fails the third
  // press and passes the first two all at once - and every cheap version of
  // that rule is subtly wrong. Ten strings compared outright cannot be.
  const seen: string[] = [];
  return function feed(key: string): boolean {
    // Only the two letters have a case, and Shift or caps lock must not throw
    // away nine correct presses. Arrow names arrive exactly as they are.
    seen.push(key.length === 1 ? key.toLowerCase() : key);
    if (seen.length > KONAMI.length) seen.shift();
    if (seen.length < KONAMI.length) return false;
    if (!KONAMI.every((want, i) => seen[i] === want)) return false;
    seen.length = 0;
    return true;
  };
}

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

/** Taps that open it. */
export const TAPS = 7;

/** The whole run has to fit in this, so a tap a minute for seven minutes is
 *  not a code somebody typed by accident over a morning. */
export const TAP_SPAN_MS = 3000;

/** And no two taps may be further apart than this. Both rules, rather than one:
 *  the span alone lets a slow drum of six taps carry across from the last run,
 *  and the gap alone lets a patient tapper get there eventually. */
export const TAP_GAP_MS = 600;

/**
 * Seven quick taps, the touch way in. Fed `performance.now()` by the one click
 * listener on the wordmark; pure, so the timing is a test and not a thing to
 * sit and count out by hand.
 */
export function tapMatcher() {
  // When this run started, and when the last tap landed. Two numbers rather
  // than the whole list: nothing here asks about the taps in between.
  let first = 0;
  let last = 0;
  let n = 0;
  return function tap(now: number): boolean {
    if (!n || now - last > TAP_GAP_MS || now - first > TAP_SPAN_MS) {
      first = now;
      n = 0;
    }
    last = now;
    n++;
    if (n < TAPS) return false;
    n = 0;
    return true;
  };
}
