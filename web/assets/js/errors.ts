// Last-resort error handler — toasts uncaught exceptions so the user
// knows the app faulted. No telemetry. Deduplication by identity,
// capped at MAX_TOLD. Must never itself throw.

import { toast } from './notify.ts';

/** What the app can truthfully say about the user's work. Never a fourth. */
export type BoardState = 'saved' | 'unsaved' | 'unknown';

/** The probe's answer. `detail` replaces the standard clause in the toast. */
export interface BoardSafety {
  state: BoardState;
  detail?: string;
}

export type BoardProbe = () => BoardSafety;

/** Minimal window surface. Tests pass a recorder; a worker could pass `self`. */
export interface ErrorHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** How many separate faults are worth interrupting somebody for. */
const MAX_TOLD = 3;

let host: ErrorHost | null = null;
let probe: BoardProbe | null = null;
/** Keys already toasted about. Bounded by MAX_TOLD. */
const seen = new Set<string>();
let told = 0;
/** Re-entry guard: a toast that throws must not be reported through the toast. */
let inside = false;
/** The last few faults, past MAX_TOLD too, for Report a problem to copy. Never sent. */
const RECENT_MAX = 10;
const recent: string[] = [];

/** The faults this session has seen, oldest first, one line each. */
export const recentFaults = (): readonly string[] => recent;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Inject the board-safety probe. Called once from main.ts. Null = unwired (unknown). */
export function setBoardProbe(fn: BoardProbe | null): void {
  probe = fn;
}

/** Install error + unhandledrejection listeners. Returns teardown. No-op if already installed. */
export function initErrors(target: ErrorHost | null = defaultHost()): () => void {
  if (!host && target) {
    host = target;
    host.addEventListener('error', onError);
    host.addEventListener('unhandledrejection', onRejection);
  }
  return teardown;
}

/** Remove handlers and forget what has been said — no session, no memory. */
function teardown(): void {
  if (host) {
    host.removeEventListener('error', onError);
    host.removeEventListener('unhandledrejection', onRejection);
  }
  host = null;
  seen.clear();
  recent.length = 0;
  told = 0;
  inside = false;
}

function defaultHost(): ErrorHost | null {
  return typeof window === 'undefined' ? null : window;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/** Uncaught exception. Bubble phase only — resource errors (img 404) do not bubble. */
function onError(event: Event): void {
  const file = str(prop(event, 'filename'));
  const line = str(prop(event, 'lineno'));
  const col = str(prop(event, 'colno'));
  // Fallback for a missing stack — shaped like a stack frame so tidy() reads both.
  const hint = file && line ? `${file}:${line}${col ? ':' + col : ''}` : file;
  report(prop(event, 'error'), str(prop(event, 'message')), hint, 'uncaught error');
}

/** A rejected promise nobody was waiting on. */
function onRejection(event: Event): void {
  // PromiseRejectionEvent has no filename/line — everything is in the reason's stack.
  report(prop(event, 'reason'), '', '', 'unhandled rejection');
}

/** Central report path. `context` is the dedupe key prefix and the console label. */
function report(cause: unknown, given: string, hint: string, context: string): void {
  let where = '';
  let what = '';
  // Console line runs outside the re-entry guard on purpose — a second fault
  // raised while the first is being toasted still gets its console line.
  try {
    where = placeOf(cause, hint);
    what = messageOf(cause, given);
    console.error(`[mbrd] ${context}${where ? ' in ' + where : ''}:`, cause ?? what);
    recent.push(`${context}${where ? ' in ' + where : ''}: ${what.slice(0, 300)}`);
    if (recent.length > RECENT_MAX) recent.shift();
  } catch {
    // Nowhere left to report it.
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
    // Last catch in the application — emptiness is the point.
  } finally {
    inside = false;
  }
}

/** Report a caught error (e.g. from the emitter) under the same dedupe/ceiling rules. */
export function reportCaught(cause: unknown, context: string): void {
  report(cause, '', '', context);
}

// ---------------------------------------------------------------------------
// Reading an error without trusting it
// ---------------------------------------------------------------------------

/** Safe property read — handles non-objects, Proxies, and throwing getters. */
function prop(obj: unknown, key: string): unknown {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    // SAFETY: non-objects ruled out above; try/catch handles throwing getters.
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
    // A rejection reason can be a Symbol, which throws on String().
    return String(cause);
  } catch {
    return 'no message';
  }
}

/** Where it came from: the stack if there is one, the event's own hint if not. */
function placeOf(cause: unknown, hint: string): string {
  return tidy(firstUrl(str(prop(cause, 'stack')))) || tidy(hint);
}

/** First URL in a stack trace — the throw site. Works for both V8 and SpiderMonkey formats. */
function firstUrl(stack: string): string {
  const found = /[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/i.exec(stack);
  return found ? found[0] : '';
}

/** Strip a stack URL to a readable path: "…/assets/js/ui/viewer.ts:41:9" -> "ui/viewer.ts:41:9". */
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

/** Ask the probe. Missing, throwing, or out-of-enum → 'unknown'. Never a wrong reassurance. */
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
