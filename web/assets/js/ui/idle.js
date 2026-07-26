// Getting out of the way.
//
// The chrome is four small things pinned to the corners of the glass, and none
// of them is what anybody came here to look at. After five seconds of nothing
// happening they fade out and the board is the whole window; the first sign of
// life brings them back.
//
// What counts as life is deliberately broad - a pointer moving, a tap, a wheel,
// a key, the view changing under an animation. The failure mode to avoid is not
// "it woke up when it did not need to", which costs nothing; it is a control
// that is invisible at the moment somebody reaches for it. Moving the mouse
// towards the zoom bar is therefore enough on its own, and it is the reason
// pointermove is in the list even though it is the noisiest event there is.
//
// Nothing here touches the sidebar. A panel left open is a decision somebody
// made and is still working inside; the corners are furniture.

const IDLE_MS = 15000;

let root = null;
let last = 0, timer = 0, idle = false;

export function initIdle(vp) {
  root = document.documentElement;

  // Capture, so a control that stops an event on its way up cannot also stop
  // the app noticing that somebody is there. Passive, because not one of these
  // is ever cancelled here.
  const opts = { capture: true, passive: true };
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
    addEventListener(type, poke, opts);
  }
  // The board moving on its own - a fit, a travel, the momentum of a fling -
  // is the app doing something, so the controls that steer it stay up for it.
  vp?.onChange?.(poke);
  // A page that comes back from a background tab has been "still" for however
  // long it was away, which is not the same as somebody sitting in front of it
  // doing nothing. Start the five seconds again rather than fading instantly.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poke();
  });

  poke();
}

/** Something happened. */
function poke() {
  last = now();
  if (idle) {
    idle = false;
    root.classList.remove('is-idle');
  }
  // One timer for the life of the page, not one per event. pointermove arrives
  // a hundred times a second while the mouse is moving, and clearing and
  // setting a timeout at that rate is a lot of work to do in order to find out
  // that nothing has changed. The timer instead checks how long it has actually
  // been when it fires, and puts itself back if the answer is "not long".
  if (!timer) timer = setTimeout(check, IDLE_MS);
}

function check() {
  const left = IDLE_MS - (now() - last);
  // A frame's slack: rearming for the last few milliseconds of a wait buys
  // nothing anybody can see and costs another trip through the timer queue.
  if (left > 16) {
    timer = setTimeout(check, left);
    return;
  }
  timer = 0;
  idle = true;
  root.classList.add('is-idle');
}

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());
