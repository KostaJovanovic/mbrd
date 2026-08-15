// The one thing the app says when it has stopped making sense.
//
// Every other message in mbrd is written by somebody who knew what had
// happened. This one is written by nobody: it is the handler of last resort for
// an exception that reached the top of the stack, or a promise nothing was
// waiting on. Until it existed there was no window.onerror and no
// unhandledrejection listener anywhere in web/, so the whole of that class went
// to a console nobody has open - see Finding 6 of
// research/old/build-and-framework-audit-2026-08-12.md.
//
// The failure mode that finding names is specific and worth restating, because
// it is the one this module is shaped around: an app with no account, no
// telemetry and no server, and a person watching a board stop responding with
// nothing to read and nothing to send. There is nowhere to phone. So the entire
// value on offer is *telling them what they cannot see*, which is two facts:
// that this was a fault and not something they did, and - the part that
// matters - whether their work is safe.
//
// ── What it must never become ──
//
// Telemetry. Not a beacon, not a fetch, not a "report this" link to anything
// off this origin, not a queue of errors held for a later upload. mbrd having
// no server is not a gap in this module's design, it is the product; a crash
// reporter is exactly the feature that would quietly turn a local tool into a
// service with a back end. If a future maintainer wants stack traces, the
// answer is the console the browser already writes them to and a person willing
// to paste one.
//
// It also never swallows. console.error runs on every occurrence, including the
// ones this module decides not to toast about, and neither handler calls
// preventDefault(): the browser's own report is the authority on the stack, it
// is what DevTools' "pause on uncaught exceptions" hangs off, and suppressing
// it to keep the console tidy would trade the only real diagnosis in the
// building for cosmetics. This module is strictly additive to what the browser
// already does.
//
// ── What it can honestly name, and what it cannot ──
//
// index.html loads assets/app.js - a single esbuild bundle, minified for
// release. So the file in an error's stack is almost always the artifact and
// not the module: `app.js:1:24601`, not `ui/viewer.ts:41`. tidy() below prefers
// a real module path when it can see one (which is what a source-tree boot
// gives it, and what the dev build's readable bundle gives it for anything
// still carrying a path) and falls back to the artifact plus its line and
// column otherwise.
//
// That fallback is deliberately not dressed up. `app.js:1:24601` is not a
// module name, but it is *stable, exact and repeatable* - two people hitting
// the same bug quote the same number, and web/assets/app.js.map turns it back
// into a module for whoever has the repository. Rejected: fetching that map at
// runtime and walking its VLQ segments to print a real name. It is a mapping
// decoder, several hundred lines of it, loaded into a page that has just proved
// it cannot be trusted to run - and `npm run build` ships no map at all, so the
// effort would buy nothing on the deploy it was written for.
//
// A cross-origin script gives even less: the browser hands over "Script error."
// with an empty filename and no stack, on purpose. When nothing is recoverable
// the message simply omits the clause rather than printing a guess or the word
// "unknown", because a place-name that might be wrong is worse than none.
//
// ── Whether the board is safe ──
//
// This module does not know and must not guess. setBoardProbe() takes the
// answer from whoever holds the latches - storage/session.ts, through
// boardSafety() - and main.ts introduces the two, the same injection shape as
// setOverlays(), setPrompt() and setAssetNameLookup(). That is what keeps this
// module in the base layer beside notify.ts: an unwired probe reports 'unknown'
// and says so out loud, which is the honest answer and also the one a test
// gets for free.
//
// Three states and no fourth. 'saved' means every change is in this browser's
// working cache and a reload brings it back; 'unsaved' means something is not,
// and the message says to export; 'unknown' means the app could not tell - the
// probe is unwired, it threw, or a write was still in flight when the error
// landed. 'unknown' is a real answer and is never dressed as either of the
// others. Telling somebody their board is safe when it is not is the single
// worst thing this module could do, so the ladder in boardSafety() is written
// to fall towards 'unknown' rather than towards reassurance.
//
// ── Repetition ──
//
// An error handler that toasts on every frame of a repeating fault is worse
// than none: it is a fault plus an interface that cannot be used. The audit's
// own example is a bus subscriber that throws on *every* geom event, which is
// several a second for as long as somebody is dragging a card.
//
// So: identity first. The key is the context, the message and the place, and a
// key already spoken about is never spoken about again. That alone handles the
// repeating-subscriber case, which is one error arriving many times rather than
// many errors. On top of it a ceiling of MAX_TOLD toasts for the whole session,
// because the other shape of the same problem is a cascade of *different*
// errors falling out of one broken thing - and after three, the person has been
// told; the fourth is decoration on an app they should be exporting from.
//
// Rejected: a wall-clock rate limit. It would need Date.now() to be right
// inside a handler whose entire job is to work when nothing else does, it makes
// this module's behaviour untestable without faking a clock, and it answers a
// question - "how fast is this arriving" - that the identity check has already
// answered better. The ceiling also bounds `seen` by construction: keys are
// only ever added on the path that toasts, so the set can never hold more than
// MAX_TOLD entries, and an error handler that leaks memory during a fault
// storm would be its own second bug.
//
// ── Two doors ──
//
// window.onerror is not enough on its own, and this is the subtle part.
// emitter.emit() in util.ts wraps each subscriber in try/catch so one broken
// listener cannot take the other twenty down - which is right, and which means
// a throwing subscriber never reaches the global handler at all. The audit's
// motivating example is precisely that case, so a module that only listened on
// window would have missed the very failure it was written for. reportCaught()
// is the second door: the emitter still catches, still logs, and now also says
// so once. Anything else that deliberately catches to keep running can use the
// same door.
//
// ── It cannot itself throw ──
//
// Everything here runs inside one try/catch with an empty tail, which is the
// only empty catch in this codebase that is not a smell: if reporting a failure
// fails there is, by definition, nowhere left to report it, and an exception
// escaping a handler for window's error event is how a broken app becomes a
// broken app that also cannot be reasoned about. Every read off the event and
// off the probe goes through prop(), so a hostile or half-built object with a
// throwing getter is contained at the read rather than at the top. `inside`
// guards the one genuinely dangerous shape: toast() raising an error that comes
// straight back here - and it guards only the toast, never the console line,
// so the promise above survives the one case that would otherwise break it.
//
// Installed with addEventListener rather than by assigning window.onerror.
// Assignment is a single slot - a later `window.onerror = ...` from anywhere,
// including an extension, replaces this silently - and a listener can be taken
// off again, which is what lets initErrors() hand back a teardown.

import { toast } from './notify.ts';

/** What the app can truthfully say about the user's work. Never a fourth. */
export type BoardState = 'saved' | 'unsaved' | 'unknown';

/**
 * The probe's answer. `detail` replaces the standard clause when the holder of
 * the latches has something more exact to say - a not-found address that was
 * never being saved, a browser refusing to store anything - and is written to
 * read as the tail of "Something went wrong - ...".
 */
export interface BoardSafety {
  state: BoardState;
  detail?: string;
}

export type BoardProbe = () => BoardSafety;

/**
 * The narrowest view of `window` this module needs, so that it can be installed
 * on something else. Tests pass a recorder; a worker could pass `self`.
 */
export interface ErrorHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** How many separate faults are worth interrupting somebody for. */
const MAX_TOLD = 3;

let host: ErrorHost | null = null;
let probe: BoardProbe | null = null;
/** Keys already toasted about. Bounded by MAX_TOLD - see the header. */
const seen = new Set<string>();
let told = 0;
/** Re-entry guard: a toast that throws must not be reported through the toast. */
let inside = false;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Hand over the question "is their work safe". Called once, from main.ts, with
 * boardSafety() out of storage/session.ts.
 *
 * Passing null puts it back to not knowing, which is what a teardown wants and
 * what keeps this from reporting on a session that has gone away.
 */
export function setBoardProbe(fn: BoardProbe | null): void {
  probe = fn;
}

/**
 * Install the two handlers. Returns the function that takes them off again.
 *
 * Called from main.ts as early as it sensibly can be - an error during boot is
 * exactly the case with no other way to be seen. A second call while installed
 * is a no-op rather than a second pair of listeners, and a host of null (no
 * window: a test, a worker, a bare import) installs nothing at all, on the same
 * bargain notify.ts makes: there being nobody to tell is not a failure.
 */
export function initErrors(target: ErrorHost | null = defaultHost()): () => void {
  if (!host && target) {
    host = target;
    host.addEventListener('error', onError);
    host.addEventListener('unhandledrejection', onRejection);
  }
  return teardown;
}

/**
 * Take the handlers off, and forget what has been said.
 *
 * The memory goes with the listeners on purpose: what this module remembers is
 * "the person has already been told about that", and once nothing is listening
 * there is no person and no session it could be true of.
 */
function teardown(): void {
  if (host) {
    host.removeEventListener('error', onError);
    host.removeEventListener('unhandledrejection', onRejection);
  }
  host = null;
  seen.clear();
  told = 0;
  inside = false;
}

function defaultHost(): ErrorHost | null {
  return typeof window === 'undefined' ? null : window;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/**
 * An exception nothing caught.
 *
 * Bubble phase deliberately, not capture: a failed <img> or <script> fires an
 * error event too, it does not bubble, and it is not an exception - a toast
 * saying something went wrong because a decorative image 404'd would be a lie
 * with a scary face on it. The bubble-phase listener sees uncaught exceptions,
 * which are fired at the global object itself, and nothing else.
 */
function onError(event: Event): void {
  const file = str(prop(event, 'filename'));
  const line = str(prop(event, 'lineno'));
  const col = str(prop(event, 'colno'));
  // Only ever a fallback for a missing stack, so the shape is the one a stack
  // frame has and tidy() can read either without knowing which it got.
  const hint = file && line ? `${file}:${line}${col ? ':' + col : ''}` : file;
  report(prop(event, 'error'), str(prop(event, 'message')), hint, 'uncaught error');
}

/** A rejected promise nobody was waiting on. */
function onRejection(event: Event): void {
  // No filename, no line, no column: PromiseRejectionEvent carries the reason
  // and nothing else, so everything knowable is in the reason's own stack - and
  // a reason is not required to be an Error, or an object, or anything at all.
  report(prop(event, 'reason'), '', '', 'unhandled rejection');
}

/**
 * The one door. `given` is a message the event supplied directly, `hint` a
 * place to fall back on, `context` what to call this in the console and the
 * half of the dedupe key that separates two identical messages arriving by
 * different routes.
 */
function report(cause: unknown, given: string, hint: string, context: string): void {
  let where = '';
  let what = '';
  // Always, and before any decision about whether to interrupt anybody - and
  // outside the re-entry guard, which is the point of this half standing on its
  // own. The header says this module never swallows; a guard that covers the
  // console line makes it swallow exactly when the app is worst off, because
  // the shape `inside` exists for is a *second* fault raised while the first is
  // still being told about, and that second one is the interesting one. It gets
  // its console line; what it does not get is a toast on top of a toast that is
  // already failing. The browser logs uncaught errors itself and this
  // duplicates that line; the duplicate earns its place by carrying the
  // place-name the toast used, so a console and a screenshot of a toast
  // describe the same fault.
  try {
    where = placeOf(cause, hint);
    what = messageOf(cause, given);
    console.error(`[mbrd] ${context}${where ? ' in ' + where : ''}:`, cause ?? what);
  } catch {
    // See the tail below: nowhere left to report it.
  }
  if (inside) return;
  inside = true;
  try {
    if (told >= MAX_TOLD) return;
    const key = `${context}|${what}@${where}`;
    if (seen.has(key)) return;
    seen.add(key);
    told++;
    toast(`Something went wrong${where ? ' in ' + where : ''} - ${boardClause()}`, 'error');
  } catch {
    // Nowhere left to report it. See the header: this is the last catch in the
    // application and its emptiness is the point.
  } finally {
    inside = false;
  }
}

/**
 * Say that something was caught and handled, but should still be known about.
 *
 * The emitter's per-subscriber catch is the caller this exists for - see the
 * header. The caller keeps its own behaviour entirely; this only decides
 * whether the person hears about it, under the same identity rule and the same
 * ceiling as an uncaught one.
 */
export function reportCaught(cause: unknown, context: string): void {
  report(cause, '', '', context);
}

// ---------------------------------------------------------------------------
// Reading an error without trusting it
// ---------------------------------------------------------------------------

/**
 * One property off something that may not be an object, may be a Proxy, and may
 * have a getter that throws. Every read in this module goes through here.
 */
function prop(obj: unknown, key: string): unknown {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A value as a string, or '' for anything that is not plainly one. */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** What went wrong, in whatever words are available. */
function messageOf(cause: unknown, given: string): string {
  if (given) return given;
  const message = str(prop(cause, 'message'));
  if (message) return message;
  try {
    // A rejection reason can be anything at all, including a Symbol - which
    // throws on String() rather than converting.
    return String(cause);
  } catch {
    return 'no message';
  }
}

/** Where it came from: the stack if there is one, the event's own hint if not. */
function placeOf(cause: unknown, hint: string): string {
  return tidy(firstUrl(str(prop(cause, 'stack')))) || tidy(hint);
}

/**
 * The first file reference in a stack, whatever engine wrote it. V8 writes
 * "    at fn (https://host/assets/app.js:1:9)", SpiderMonkey writes
 * "fn@https://host/assets/app.js:1:9"; the URL is the part both agree on, and
 * the first one is the throw site.
 */
function firstUrl(stack: string): string {
  const found = /[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/i.exec(stack);
  return found ? found[0] : '';
}

/**
 * A URL from a stack, as something a person can read back over a phone.
 *
 * "https://mbrd.pages.dev/assets/app.js:1:24601" -> "app.js:1:24601"
 * "http://localhost:6273/assets/js/ui/viewer.ts:41:9" -> "ui/viewer.ts:41:9"
 *
 * The line and column come off first and go back on last, because a cache-buster
 * query would otherwise take them with it.
 */
function tidy(raw: string): string {
  if (!raw) return '';
  let path = raw;
  let tail = '';
  const at = /:\d+(?::\d+)?$/.exec(path);
  if (at) {
    tail = path.slice(at.index);
    path = path.slice(0, at.index);
  }
  path = path.replace(/[?#].*$/, '');
  const marker = '/assets/js/';
  const from = path.indexOf(marker);
  if (from >= 0) return path.slice(from + marker.length) + tail;
  const slash = path.lastIndexOf('/');
  return (slash >= 0 ? path.slice(slash + 1) : path) + tail;
}

// ---------------------------------------------------------------------------
// Whether their work is safe
// ---------------------------------------------------------------------------

/** The tail of the message: what is true of the board right now. */
function boardClause(): string {
  const safety = ask();
  if (safety.detail) return safety.detail;
  if (safety.state === 'saved') return 'your board is saved in this browser';
  if (safety.state === 'unsaved') return 'your board has changes that are not saved, export it to a file';
  return 'whether your board is saved could not be checked, export it to a file';
}

/**
 * Ask the probe, and believe none of it.
 *
 * A probe that is missing, that throws, or that answers with something outside
 * the three states all mean the same thing here: this module does not know, and
 * says so. The alternative - trusting the shape - is a wrong reassurance about
 * somebody's work at the exact moment they need a true one.
 */
function ask(): BoardSafety {
  if (!probe) return { state: 'unknown' };
  try {
    const answer = probe();
    const state = str(prop(answer, 'state'));
    const detail = str(prop(answer, 'detail'));
    if (state === 'saved' || state === 'unsaved' || state === 'unknown') return { state, detail };
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}
