// The handler of last resort, and the four promises it makes.
//
// Covers errors.ts and the boardSafety() ladder in storage/session.ts,
// joined by "what does the app do when it's already gone wrong".
//
// No DOM: errors.ts speaks through notify.ts, so setOverlays() as a
// recorder makes a test the interface, exercising the real path (unlike
// hud.test.js, which needs a fake document since ui/hud.ts genuinely draws).
//
// The other half is a fake host: errors.ts installs on anything with
// addEventListener/removeEventListener, letting a test assert the listeners
// come off again - impossible if it had assigned window.onerror instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initErrors, setBoardProbe, reportCaught } from '../web/assets/js/errors.ts';
import { setOverlays } from '../web/assets/js/notify.ts';
import { boardSafety } from '../web/assets/js/storage/session.ts';
import { loadBoard, markDirty } from '../web/assets/js/state.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A window, as far as this module is concerned. */
function makeHost() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    count(type) { return (listeners.get(type) || []).length; },
    /**
     * Dispatch as the browser would: every listener, in order, over a copy -
     * so a handler removing itself mid-dispatch can't corrupt the walk.
     */
    fire(type, event) {
      for (const fn of (listeners.get(type) || []).slice()) fn(event);
    },
  };
}

/** An ErrorEvent's shape, with a stack that looks like V8's. */
function errorEvent(message, url = 'https://mbrd.pages.dev/assets/app.js:1:24601') {
  const cause = new Error(message);
  cause.stack = `Error: ${message}\n    at paint (${url})\n    at frame (${url})`;
  const [, file, line, col] = /^(.*):(\d+):(\d+)$/.exec(url) || [];
  return {
    message, error: cause, filename: file || '', lineno: Number(line) || 0, colno: Number(col) || 0,
    preventDefault() { this.prevented = true; },
    prevented: false,
  };
}

/**
 * Run one scenario wired to a recorder, hand back every toast raised. Torn
 * down either way - the teardown also clears the module's memory of what it
 * has said, so tests don't leak through the once-only rule they check.
 */
function withErrors(probe, body) {
  const said = [];
  const host = makeHost();
  setOverlays({ toast: (msg, kind) => said.push({ msg, kind }), busy: () => ({}) });
  setBoardProbe(probe);
  const stop = initErrors(host);
  try {
    body(host, said);
  } finally {
    stop();
    setBoardProbe(null);
    setOverlays(null);
  }
  return said;
}

// ---------------------------------------------------------------------------
// One fault, one toast
// ---------------------------------------------------------------------------

const SAFE = () => ({ state: 'saved' });

test('an uncaught error raises exactly one toast', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('error', errorEvent('cannot read properties of null'));
  });
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'error');
  assert.match(said[0].msg, /^Something went wrong in /);
});

test('the same fault arriving fifty times is still one toast', () => {
  // A bus subscriber throwing on every geom event fires several times a
  // second while dragging - an interface papered in identical toasts.
  const said = withErrors(SAFE, (host) => {
    for (let i = 0; i < 50; i++) host.fire('error', errorEvent('the same thing again'));
  });
  assert.equal(said.length, 1);
});

test('a different fault is a different toast, up to the ceiling', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('error', errorEvent('one'));
    host.fire('error', errorEvent('two'));
    host.fire('error', errorEvent('three'));
    host.fire('error', errorEvent('four'));
    host.fire('error', errorEvent('five'));
  });
  // Three distinct faults are news; by the fourth, the console is enough.
  assert.equal(said.length, 3);
});

test('a rejected promise nobody was waiting on is reported too', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('unhandledrejection', { reason: new Error('the fetch that nobody awaited') });
  });
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'error');
});

test('a caught-but-lost error comes in by the second door', () => {
  // emitter.emit() keeps the bus alive on a throwing subscriber and now says
  // so once. One broken function called repeatedly, since the throw site is
  // half of a fault's identity - two lines throwing are two faults.
  const subscriber = () => { throw new Error('subscriber blew up'); };
  const said = withErrors(SAFE, () => {
    for (let i = 0; i < 20; i++) {
      try { subscriber(); } catch (e) { reportCaught(e, 'handler for "geom"'); }
    }
  });
  assert.equal(said.length, 1);
});

// ---------------------------------------------------------------------------
// Naming the place
// ---------------------------------------------------------------------------

test('the bundle is named with its line and column, not dressed up', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('error', errorEvent('boom', 'https://mbrd.pages.dev/assets/app.js:1:24601'));
  });
  // Exact and resolvable through app.js.map - claiming a module name would
  // be a guess.
  assert.match(said[0].msg, /Something went wrong in app\.js:1:24601 - /);
});

test('a source-tree boot is named by its module path', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('error', errorEvent('boom', 'http://localhost:6273/assets/js/ui/viewer.ts:41:9'));
  });
  assert.match(said[0].msg, /Something went wrong in ui\/viewer\.ts:41:9 - /);
});

test('a cache-busting query does not eat the line number', () => {
  const said = withErrors(SAFE, (host) => {
    host.fire('error', errorEvent('boom', 'https://mbrd.pages.dev/assets/app.js?v=156:1:24601'));
  });
  assert.match(said[0].msg, /in app\.js:1:24601 - /);
});

test('the event filename is the fallback when there is no stack', () => {
  const said = withErrors(SAFE, (host) => {
    const event = errorEvent('boom', 'https://mbrd.pages.dev/assets/app.js:1:9');
    event.error = null;
    host.fire('error', event);
  });
  assert.match(said[0].msg, /in app\.js:1:9 - /);
});

test('nothing recoverable means no place at all, not the word unknown', () => {
  // A cross-origin script gives "Script error." with no filename or stack,
  // on purpose - a place-name that might be wrong is worse than none.
  const said = withErrors(SAFE, (host) => {
    host.fire('error', { message: 'Script error.', error: null, filename: '', lineno: 0, colno: 0 });
  });
  assert.equal(said.length, 1);
  assert.match(said[0].msg, /^Something went wrong - /);
  assert.doesNotMatch(said[0].msg, /unknown/);
});

// ---------------------------------------------------------------------------
// Whether the board is safe
// ---------------------------------------------------------------------------

test('each of the three states has its own sentence', () => {
  const of = probe => withErrors(probe, (host) => {
    host.fire('error', errorEvent('boom'));
  })[0].msg;

  assert.match(of(() => ({ state: 'saved' })), /your board is saved in this browser$/);
  assert.match(of(() => ({ state: 'unsaved' })), /not saved, export it to a file$/);
  assert.match(of(() => ({ state: 'unknown' })), /could not be checked, export it to a file$/);
});

test('a detail from the probe replaces the standard clause', () => {
  const said = withErrors(
    () => ({ state: 'unknown', detail: 'this address has no board of its own' }),
    (host) => { host.fire('error', errorEvent('boom')); },
  );
  assert.match(said[0].msg, / - this address has no board of its own$/);
});

test('an unwired probe says it does not know, and never says saved', () => {
  const said = withErrors(null, (host) => { host.fire('error', errorEvent('boom')); });
  assert.match(said[0].msg, /could not be checked/);
});

test('the message follows the real dirty flag in both directions', () => {
  // Not a stub: the actual ladder over the actual dirty flag - the toast's
  // whole value is that this sentence is true.
  loadBoard({ title: 'Safety', items: [] });

  markDirty(true);
  assert.equal(boardSafety().state, 'unsaved');
  let said = withErrors(boardSafety, (host) => { host.fire('error', errorEvent('while dirty')); });
  assert.match(said[0].msg, /changes that are not saved/);

  markDirty(false);
  assert.equal(boardSafety().state, 'saved');
  said = withErrors(boardSafety, (host) => { host.fire('error', errorEvent('while clean')); });
  assert.match(said[0].msg, /saved in this browser/);
});

test('a board the app is deliberately not writing is not called unsaved', () => {
  // suspendCache() is the not-found boot: no board here, writer off on
  // purpose. "Unsaved changes" would send them looking for work never theirs.
  const session = { state: 'unknown', detail: 'this address has no board of its own, so nothing here was being saved' };
  const said = withErrors(() => session, (host) => { host.fire('error', errorEvent('boom')); });
  assert.doesNotMatch(said[0].msg, /not saved/);
  assert.match(said[0].msg, /nothing here was being saved$/);
});

// ---------------------------------------------------------------------------
// It cannot itself throw
// ---------------------------------------------------------------------------

test('an event whose every property throws is survived', () => {
  const hostile = {};
  for (const key of ['message', 'error', 'filename', 'lineno', 'colno', 'reason']) {
    Object.defineProperty(hostile, key, { get() { throw new Error('no'); }, enumerable: true });
  }
  const said = withErrors(SAFE, (host) => {
    assert.doesNotThrow(() => host.fire('error', hostile));
    assert.doesNotThrow(() => host.fire('unhandledrejection', hostile));
  });
  // Still reported - a fault this odd is exactly the one worth naming.
  assert.ok(said.length >= 1);
});

test('a probe that throws is survived, and reported as not knowing', () => {
  const said = withErrors(() => { throw new Error('the latches are gone'); }, (host) => {
    assert.doesNotThrow(() => host.fire('error', errorEvent('boom')));
  });
  assert.match(said[0].msg, /could not be checked/);
});

test('a probe answering nonsense is not believed', () => {
  const of = probe => withErrors(probe, (host) => { host.fire('error', errorEvent('boom')); })[0].msg;
  assert.match(of(() => null), /could not be checked/);
  assert.match(of(() => ({ state: 'probably fine' })), /could not be checked/);
  assert.match(of(() => 'saved'), /could not be checked/);
});

test('a toast that throws does not come back round as a second fault', () => {
  // The interface failing while reporting a failure - without the re-entry
  // guard, a stack overflow on top of the bug being reported.
  const host = makeHost();
  let calls = 0;
  setOverlays({
    toast() { calls++; throw new Error('the toast host is gone'); },
    busy: () => ({}),
  });
  setBoardProbe(SAFE);
  const stop = initErrors(host);
  try {
    assert.doesNotThrow(() => host.fire('error', errorEvent('boom')));
    assert.equal(calls, 1);
  } finally {
    stop();
    setBoardProbe(null);
    setOverlays(null);
  }
});

test('a fault raised while reporting one still reaches the console', () => {
  // The half the guard used to get wrong: the re-entry test ran first in
  // report(), so a second error arriving mid-stack was swallowed whole - no
  // toast (right) and no console line (wrong). The console is the record;
  // the ceiling is about the screen.
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args);
  const host = makeHost();
  setOverlays({
    toast() {
      // Reporting from inside the report - the shape `inside` exists for.
      reportCaught(new Error('the second thing'), 'a subscriber');
      throw new Error('the toast host is gone');
    },
    busy: () => ({}),
  });
  setBoardProbe(SAFE);
  const stop = initErrors(host);
  try {
    assert.doesNotThrow(() => host.fire('error', errorEvent('the first thing')));
    assert.equal(lines.length, 2);
    assert.match(String(lines[1][0]), /a subscriber/);
  } finally {
    stop();
    setBoardProbe(null);
    setOverlays(null);
    console.error = real;
  }
});

test('a rejection reason that is not an object at all is survived', () => {
  const said = withErrors(SAFE, (host) => {
    assert.doesNotThrow(() => host.fire('unhandledrejection', { reason: undefined }));
    assert.doesNotThrow(() => host.fire('unhandledrejection', { reason: 'just a string' }));
    assert.doesNotThrow(() => host.fire('unhandledrejection', { reason: Symbol('nope') }));
  });
  assert.equal(said.length, 3);
});

test('an unwired app is silent rather than broken', () => {
  // No overlays and no host: notify.ts drops the message, initErrors(null)
  // installs nothing. Silence is not an error - notify.ts's bargain, kept here.
  setOverlays(null);
  const stop = initErrors(null);
  assert.doesNotThrow(() => reportCaught(new Error('nobody is listening'), 'test'));
  stop();
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

test('the browser is left to make its own report', () => {
  // No preventDefault on either handler - the browser's console line is the
  // authority "pause on uncaught exceptions" hangs off; suppressing it for
  // tidiness would trade the only real diagnosis for cosmetics.
  const event = errorEvent('boom');
  withErrors(SAFE, (host) => { host.fire('error', event); });
  assert.equal(event.prevented, false);
});

test('installing twice does not double up the listeners', () => {
  const host = makeHost();
  setOverlays({ toast: () => {}, busy: () => ({}) });
  const stop = initErrors(host);
  initErrors(host);
  try {
    assert.equal(host.count('error'), 1);
    assert.equal(host.count('unhandledrejection'), 1);
  } finally {
    stop();
    setOverlays(null);
  }
});

test('the teardown takes both listeners off again', () => {
  const host = makeHost();
  const stop = initErrors(host);
  stop();
  assert.equal(host.count('error'), 0);
  assert.equal(host.count('unhandledrejection'), 0);
});

test('the console is written to on every occurrence, told about or not', () => {
  // The rate limit is about the screen, never the record.
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args);
  try {
    const said = withErrors(SAFE, (host) => {
      for (let i = 0; i < 5; i++) host.fire('error', errorEvent('over and over'));
    });
    assert.equal(said.length, 1);
    assert.equal(lines.length, 5);
    assert.match(String(lines[0][0]), /^\[mbrd\] uncaught error in app\.js:1:24601:/);
  } finally {
    console.error = real;
  }
});
