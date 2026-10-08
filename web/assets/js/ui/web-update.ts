// The web app picking up a new version on its own. sw.js activates a new
// worker the moment it holds the whole shell; this reloads the page at the
// first moment nobody is in the middle of anything - nothing open, typed into
// or playing, and the board left alone a while, or the tab put away - storing
// the board first, as Restart does. A board that cannot be stored is never
// reloaded under: the toast's Reload button is the way then. An open tab also
// asks for a new version every quarter hour, and on coming back into view,
// rather than only when it loads. The desktop and phone apps update otherwise.

import { toast } from '../notify.ts';

export type WebUpdateDeps = {
  /** Store the board and reload; false, and nothing done, when it could not be stored. */
  restart: (opts: { quiet: boolean }) => Promise<boolean>,
  /** A tour, its editor, a replay or the cleaning game: the screen is somebody's. */
  busy: () => boolean,
};

/** How long the board must be left alone before a reload is not an interruption. */
const IDLE_MS = 20_000;
/** How often a waiting update asks whether now is the moment. */
const POLL_MS = 5_000;
/** How often an open tab asks the host for a new worker. */
const CHECK_MS = 15 * 60_000;

let deps: WebUpdateDeps | null = null;
let lastUse = 0;
let waiting = 0;
let going = false;

export function initWebUpdate(d: WebUpdateDeps) {
  if (!('serviceWorker' in navigator)) return;
  deps = d;
  lastUse = performance.now();
  // Any hand on the page puts the reload off.
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(type, () => { lastUse = performance.now(); }, { capture: true, passive: true });
  }
  // Defer to 'load' so registration does not compete with first paint.
  if (document.readyState === 'complete') register();
  else addEventListener('load', register);
}

function register() {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => watch(reg.installing));
    // An update already under way, which 'updatefound' fired for before this listened.
    watch(reg.installing ?? reg.waiting);
    const check = () => { reg.update().catch(() => {}); };
    setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void apply();
      else check();
    });
  }).catch(err => console.warn('[mbrd] sw:', err));
}

/** A worker that may become a new version. Silent on the first install, which replaces nothing. */
function watch(fresh: ServiceWorker | null) {
  if (!fresh) return;
  const ready = () => {
    if (waiting || !navigator.serviceWorker.controller) return;
    if (fresh.state !== 'installed' && fresh.state !== 'activated') return;
    toast('New version ready. It loads when you pause', '', { label: 'Reload now', run: () => { void deps!.restart({ quiet: false }); } });
    waiting = setInterval(() => { void apply(); }, POLL_MS);
  };
  // Both: a worker already past `installing` fires no more statechanges.
  ready();
  fresh.addEventListener('statechange', ready);
}

/** Reload now, if this is a moment it interrupts nothing. */
async function apply() {
  if (!waiting || going || !deps || !calm()) return;
  if (!document.hidden && performance.now() - lastUse < IDLE_MS) return;
  going = true;
  if (await deps.restart({ quiet: true })) return;
  // Not stored, so not reloaded - and not tried again every five seconds.
  clearInterval(waiting);
  going = false;
}

/** Nothing open, typed into, playing or running that a reload would take away. */
function calm(): boolean {
  if (deps!.busy()) return false;
  if (document.querySelector('dialog[open], #ctx-menu, #search')) return false;
  const at = document.activeElement;
  if (at instanceof HTMLElement && (at.isContentEditable || at.matches('input, textarea, select'))) return false;
  return ![...document.querySelectorAll('audio, video')].some(m => m instanceof HTMLMediaElement && !m.paused);
}
