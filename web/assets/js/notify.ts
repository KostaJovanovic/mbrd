// Saying something to the person, from a layer that has no screen.
//
// Two things every layer of this app needs to be able to say and no layer
// should have to own: "that happened" (a toast) and "this is taking a moment"
// (the waiting strip). The importer, the optimiser, the packer, the model
// loader, the mutation door and the clipboard all say one or the other, and
// every one of them sits *below* the interface. So they cannot import the
// implementation, and until this split they did not have to - both functions
// lived in util.ts, which is to say that forty-four modules depended on a file
// containing a toast renderer and a progress bar because they wanted clamp().
//
// This is the door instead. It knows the two *messages* and nothing about how
// either is drawn; ui/overlays.ts knows how they are drawn and nothing about
// who is saying them. main.ts introduces the two with setOverlays(), the same
// injection shape as setAssetNameLookup() and setPrompt() - and for exactly the
// same reason those exist, which tests/layers.test.js keeps honest: a base or
// storage module reaching up into ui/ is a layering inversion, and the DEBT map
// there is empty and stays empty.
//
// ── Silence is not an error ──
//
// Unwired - in a test, in a worker, before main.ts has run - every call here is
// a no-op and busy() hands back a job whose three methods do nothing. That is
// the same bargain toast() made before this module existed, where it returned
// early if `document` was undefined: saying something to a user who is not
// there is not a failure, it is a no-op, so state.ts can leave a receipt
// without every caller first having to establish that there is a screen to
// leave it on. It is also why the fallback busy job is a real object rather
// than null: `job.end()` in a `finally` must be safe to call on the path where
// nothing was ever shown, or the failure path throws over the reporting of a
// failure.
//
// ── What must not move in here ──
//
// Any DOM. Not one id, not one class name, not the fade duration that pairs
// with a `transition` in overlays.css - all of that is in ui/overlays.ts, and
// the moment one of it appears here this module stops being importable by the
// layers it exists to serve, which is the whole point of it.
//
// Nor a queue. This does not buffer messages said before the interface is up
// and replay them afterwards, and that is deliberate: the messages are receipts
// about things that just happened, and a receipt delivered a second late is
// noise arriving on a screen that has moved on. If something genuinely must
// survive boot, it is state and belongs somewhere that keeps state.
//
// Nor errors. A thrown error is not a toast; whatever catches it decides
// whether the person needs to be told, and says so through here if the answer
// is yes.

import { cue } from './cuelume/engine.ts';

/** A toast is either a receipt or a complaint. Nothing else has a spelling. */
export type ToastKind = '' | 'error';

/** What busy() hands back. Every method is safe on an unwired app. */
export interface BusyJob {
  /** The same wait, a different phase. */
  label(text: string): void;
  /** Switch the bar from "something is happening" to "this much of it". */
  step(done: number, total: number): void;
  /** Idempotent, so a `finally` that runs twice cannot strand the strip open. */
  end(): void;
}

export interface BusyOptions {
  onCancel?: (() => void) | null;
}

/** The half ui/overlays.ts supplies. */
export interface Overlays {
  toast(msg: string, kind?: ToastKind): void;
  busy(label?: string, opts?: BusyOptions): BusyJob;
}

/**
 * The job returned when there is nobody to show one to. A frozen singleton
 * rather than a fresh object per call: it carries no state, and a caller that
 * held on to it and called end() twice must be as harmless as one that did not.
 */
const NOWHERE: BusyJob = Object.freeze({
  label(): void {},
  step(): void {},
  end(): void {},
});

let overlays: Overlays | null = null;

/**
 * Wire the interface in. Called once, from main.ts, before anything can speak.
 *
 * Passing null puts it back to silence, which is what a test that wants to
 * assert on the absence of interface calls needs - and what keeps this from
 * being a one-way door onto a stale DOM after a teardown.
 */
export function setOverlays(impl: Overlays | null): void {
  overlays = impl;
}

/**
 * One-line status message at the foot of the screen. Newest at the bottom.
 *
 * **Every toast makes a sound, including one that lands on the heels of
 * something else.** There was a rule here that let the receipt step aside when
 * a more specific cue had just spoken - so a save said `done` and the toast
 * behind it said nothing - and it was wrong for the reason the whole design is
 * the way it is: a receipt that is sometimes silent is a receipt you stop
 * trusting, and two sounds a beat apart are two things having happened. They
 * overlap, which is what the limiter in cuelume/engine.ts is for.
 *
 * The sound happens whether or not there is an interface to draw the words on,
 * and that is deliberate rather than an oversight of the `?.` above: this
 * module's promise is that saying something is safe from a layer with no
 * screen, and a speaker is not a screen.
 */
export function toast(msg: string, kind: ToastKind = ''): void {
  overlays?.toast(msg, kind);
  cue(kind === 'error' ? 'fail' : 'note');
}

/**
 * Say, once, why a card has no picture of the thing it holds.
 *
 * Four paths in this app make a picture *of* a file rather than showing the
 * file: a PDF's first page, a clip's first frame, a document's baked thumbnail,
 * a TIFF decoded outright. All four are allowed to fail, all four fail to the
 * same soft answer - a named card - and until this every one of them said so
 * only to the console.
 *
 * Which is fine on a desktop and useless where it matters. **The engines that
 * fail these are the ones on phones**, and a phone has no console at all: the
 * person watching a folder of clips land as grey rectangles cannot see the one
 * line that says which of a dozen reasons it was, and neither can anybody they
 * report it to. A feature whose failure is only visible to somebody who already
 * has a debugger is a feature that is undiagnosable by exactly the people who
 * hit it.
 *
 * Once per reason per session, which is what makes this a line rather than a
 * pile: forty clips a browser cannot decode are one fact said once, and two
 * different faults are two lines. Plain rather than an error, because it is
 * usually not one - a codec this engine does not have is the ordinary case, and
 * the card is still a card.
 */
const saidNoPreview = new Set<string>();

export function noPreview(subject: string, why: unknown): void {
  const message = why instanceof Error ? why.message : String(why ?? '');
  const reason = message.trim().slice(0, 100) || 'no reason given';
  if (saidNoPreview.has(reason)) return;
  saidNoPreview.add(reason);
  toast(`No ${subject} preview - ${reason}`);
}

/**
 * Run a command from a button and say so if it fails.
 *
 * The two delegated `data-cmd` dispatchers - ui/sidebar.ts and ui/toolbar.ts -
 * called `fn()` and threw the return value away. Half the commands behind those
 * buttons are async (`save`, `clear-data`, `restart`, `export`, `optimize`), so
 * a rejection became an unhandled rejection with no toast, no console line
 * anybody would connect to the press, and no change to the button: the press
 * read as having silently done nothing. It is also what made two stranded-
 * button bugs in ui/board-actions.ts invisible for as long as they lasted.
 *
 * Here rather than in each dispatcher because there are two of them and they
 * are the same door, and here rather than in a ui/ helper because this is the
 * module that owns saying things to people.
 *
 * Synchronous throws are left alone deliberately: those are programming errors
 * in this codebase's own command surface and belong in the console with their
 * stack, not behind a toast.
 */
export function runCommand(result: unknown, what = 'That'): void {
  // SAFETY: both assertions are the duck type on the first line, which is the
  // only test that matters here - a command returns whatever it returns, and
  // what this function does is catch the rejection of the ones that return a
  // promise. Anything without a callable `then` leaves on that line.
  if (typeof (result as { then?: unknown } | null)?.then !== 'function') return;
  // SAFETY: see above - the duck type on the line before is the check.
  (result as Promise<unknown>).catch((err: unknown) => {
    console.warn('[mbrd] command failed', err);
    toast(`${what} did not work`, 'error');
  });
}

/**
 * Say that something is being waited on. Returns the handle that ends it.
 *
 *   const job = busy('Reading 40 files');
 *   job.step(12, 40);            // a bar that means something
 *   job.label('Optimising');     // the same wait, a different phase
 *   job.end();                   // always, including on the failure path
 */
export function busy(label = 'Working', opts: BusyOptions = {}): BusyJob {
  return overlays?.busy(label, opts) ?? NOWHERE;
}
