// The handler of last resort, and the four promises it makes.
//
// A new file rather than an addition to an existing one: nothing else in the
// suite is about what the app does when it has already gone wrong, and the two
// modules this covers (errors.js and the boardSafety() ladder in
// storage/session.js) are joined by exactly that question and nothing else.
//
// No DOM anywhere in here, deliberately. errors.js speaks through notify.js, so
// a test can be the interface - setOverlays() takes a recorder and every toast
// the module raises arrives as data. That is the same seam main.js uses in the
// app, which means this exercises the real path rather than a stub of it, and
// it is why these tests need no fake document at all (compare hud.test.js,
// which does, because ui/hud.js genuinely draws).
//
// The other half of the wiring is a fake host. errors.js installs on anything
// with addEventListener/removeEventListener, which is what lets the whole of it
// be driven without a window - and lets a test assert that the listeners come
// off again, which nothing could do if the module had assigned window.onerror.

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
     * Dispatch, exactly as the browser would: every listener, in order, over a
     * copy - so a handler that removes itself mid-dispatch cannot corrupt the
     * walk it is standing in.
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
 * Run one scenario with the module wired to a recorder, and hand back every
 * toast it raised. Torn down either way - the teardown is also what clears the
 * module's memory of what it has already said, so the tests do not leak into
 * each other through the once-only rule they exist to check.
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
  // The audit's own case: a bus subscriber that throws on every geom event,
  // which is several a second for as long as a card is being dragged. An
  // interface papered in identical toasts is worse than no handler at all.
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
  // Three distinct faults are news; by the fourth the person has been told and
  // the console is the right place for the rest.
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
  // What emitter.emit() in util.js does with a subscriber that throws: it keeps
  // the bus alive, and now it also says so once. Written as one broken function
  // called repeatedly rather than as two identical literals, because that is
  // the real shape - and because the place is half of the identity, so two
  // throws from two different lines are two faults and ought to be.
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
  // Exact, repeatable, and resolvable through app.js.map by whoever has the
  // repository. Claiming a module name here would be a guess.
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
  // A cross-origin script gives "Script error." with an empty filename and no
  // stack, on purpose. A place-name that might be wrong is worse than none.
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
  // Not a stub: the actual ladder in storage/session.js over the actual flag in
  // board-store.js, which is the only version of this claim worth making. The
  // whole value of the toast is that this sentence is true.
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
  // suspendCache() is the not-found boot: the visitor has no board here and the
  // writer is off on purpose. "Unsaved changes" would send them looking for
  // work that was never theirs.
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
  // Still reported, because a fault this odd is exactly the one worth naming.
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
  // The one genuinely dangerous shape: the interface failing while reporting a
  // failure. Without the re-entry guard this is a stack overflow on top of a
  // bug the person was about to be told about.
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
  // The other half of the guard above, and the half it used to get wrong. The
  // re-entry test came first in report(), so a second error arriving while the
  // first was still on the stack - a toast host that throws, and a bus
  // subscriber that throws inside the same turn - was swallowed whole: no
  // toast, which is right, and no console line, which contradicts this module's
  // header outright. The console is the record; the ceiling is about the
  // screen.
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args);
  const host = makeHost();
  setOverlays({
    toast() {
      // Reporting from inside the report, which is exactly the shape `inside`
      // exists for. The second fault is the interesting one.
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
  // No overlays and no host: notify.js drops the message and initErrors(null)
  // installs nothing. Silence is not an error - that is notify.js's bargain and
  // this module keeps it.
  setOverlays(null);
  const stop = initErrors(null);
  assert.doesNotThrow(() => reportCaught(new Error('nobody is listening'), 'test'));
  stop();
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

test('the browser is left to make its own report', () => {
  // No preventDefault, on either handler. The browser's own console line is the
  // authority on the stack and is what "pause on uncaught exceptions" hangs
  // off; suppressing it to keep the console tidy would trade the only real
  // diagnosis in the building for cosmetics.
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
  // The rate limit is about the screen, never about the record. Fifty throws
  // are fifty console lines and one toast.
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
