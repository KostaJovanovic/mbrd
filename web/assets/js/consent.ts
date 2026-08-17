// The ceilings, and who decides them.
//
// Everything in this app that used to refuse a file for being too large now
// asks instead. The numbers did not move and they are still worth having: they
// are where somebody who knows what a decode costs wrote down what a tab can
// take. What changed is what happens at the line. A ceiling is a warning with
// the reasoning attached, and the answer belongs to the person whose files
// these are - the board is local, the memory being spent is theirs, and an app
// that refuses to open a file the machine could plainly have opened is wrong in
// a way that no amount of being right about the risk repairs.
//
// So this module is two things and deliberately not a third:
//
//   1. The prose. One entry per ceiling, saying what was measured and what may
//      happen past it. Centralised because it is the only user-facing
//      explanation of a limit in the app and eight modules would otherwise each
//      invent their own sentence for the same danger. The *numbers* stay where
//      they are argued - IMPORT_LIMITS in import/budget.ts, LIMITS in
//      storage/zip.ts, MAX_TRIANGLES in mesh.ts - because that is where the
//      reasoning for each one lives and splitting the two would leave the
//      argument somewhere the number is not.
//   2. The decision, and the memory of it. One warning per file, however many
//      ceilings that file crosses, and once answered the file is not asked
//      about again for the rest of the session.
//
// It is not a policy engine. Nothing here decides anything; it carries a
// question up to whoever can ask it and an answer back down.
//
// **The retry contract.** Half of these ceilings are only knowable part-way
// through reading a file - what a ZIP entry inflates to, how many triangles an
// ASCII STL turns out to have - and the readers that find out are either
// synchronous (parseMesh) or six-at-a-time inside a pool. Awaiting a dialog
// from inside a parse loop is not available to the first and not sane in the
// second, so those readers do not ask. They throw `Oversize`, which names the
// ceiling and carries the numbers, and the async caller that *does* have the
// file catches it, asks the one question, and on a yes runs the read again with
// the ceiling lifted. Parsing twice is the price and it is small: it only
// happens to a file somebody has explicitly said yes to. What it buys is that
// every bounds-check in every hand-written reader stays exactly where it was,
// still throwing, still checked before it allocates - see the safety rules in
// CLAUDE.md. A lifted ceiling is a larger allocation the caller asked for, not
// a reader that stopped checking.
//
// Pure by design - no DOM, no state, imports nothing - so it sits in the base
// layer beside errors.ts, which is here for the same reason and wired the same
// way. import/, storage/ and mesh.ts all reach it, and a question askable from
// three tiers has to live under all of them.

/** Which ceiling was crossed. One id per number that used to be a refusal. */
export type CeilingId =
  | 'file-bytes'
  | 'batch-bytes'
  | 'pixels'
  | 'file-count'
  | 'archive-bytes'
  | 'archive-entries'
  | 'entry-bytes'
  | 'inflated-bytes'
  | 'entry-ratio'
  | 'container-bytes'
  | 'embedded-jpeg'
  | 'cover-art'
  | 'mesh-triangles'
  | 'mesh-buffer'
  | 'font-bytes';

/**
 * One crossed ceiling, ready to be read out.
 *
 * `what` is the measurement - this file, this number, the number it passed. The
 * risk sentence comes from the table below, so a caller only ever has to say
 * what it found.
 */
export type Crossed = { ceiling: CeilingId, what: string };

/**
 * What each ceiling is protecting against, in the words somebody deciding would
 * need.
 *
 * Two rules held throughout. It says what the cost actually is, in bytes or
 * seconds rather than in adjectives - "about four bytes a pixel, so 3.6 GB for
 * this one image" is a fact somebody can weigh against the machine in front of
 * them, and "this may use a lot of memory" is not. And it says what the app
 * does if the answer is no, because half of these degrade gracefully - a named
 * card, a track without its cover - and somebody choosing between "risk the
 * tab" and "lose nothing but a thumbnail" deserves to know which one this is.
 *
 * The one that is not like the others is `entry-ratio`. Every other line here
 * is about a file that is honestly large. That one is about a file that is
 * lying, and it says so.
 */
const RISKS: Record<CeilingId, string> = {
  'file-bytes':
    'Importing holds several copies of a file at once - the bytes, the hash, the decode, the thumbnail. '
    + 'Past this size the tab can run out of memory, and a tab that crashes takes an unsaved board with it. '
    + 'Save first if this board matters.',
  'batch-bytes':
    'Every file in an import is hashed, decoded and thumbnailed at roughly the same time, and two imports '
    + 'running together share this budget. Peak memory is a multiple of the number above, not the number itself.',
  'pixels':
    'A decode allocates about four bytes a pixel whatever the card is drawn at, and several images decode at '
    + 'once. A small file can declare enormous dimensions, so this may be a picture of nothing that costs '
    + 'gigabytes. Left alone it still arrives, as a named card rather than a picture.',
  'file-count':
    'This is not a memory limit - the bytes are budgeted separately. It is how long the import will take: '
    + 'each file is measured, and a measurement that fails waits out a timeout before giving up.',
  'archive-bytes':
    'Opening a board holds three things at once: the archive, every entry inflated out of it, and a copy of '
    + 'each asset as its own blob. Peak is roughly the archive plus twice its contents.',
  'archive-entries':
    'Every entry is held at once. A board of 500 files and its notes lands near 1500 entries, so an archive '
    + 'declaring far more than that is either not a board or not one this was sized for.',
  'entry-bytes':
    'This entry is inflated whole into memory before anything looks at it, and the rest of the archive is '
    + 'inflated alongside it.',
  'inflated-bytes':
    'The declared sizes added up, which is what actually bounds the memory an open costs - every entry is '
    + 'held at the same time. Nothing is inflated yet; this is the archive saying in advance what it will cost.',
  'entry-ratio':
    'This is the one warning here that is not about a file being large. DEFLATE reaches this ratio on padding '
    + 'and almost never on content, so an entry expanding this far is usually a file built to be unpacked '
    + 'rather than read. The cost is paid in full the moment it is, and nothing in the archive says what it '
    + 'really contains until then.',
  'container-bytes':
    'A document is opened to look for the preview picture inside it, and up to six are opened at once. This '
    + 'ceiling is far below the one for a board archive on purpose: the budget for one thumbnail is not the '
    + 'budget for a whole board. Left alone the file still arrives, as a named card.',
  'embedded-jpeg':
    'This is the preview picture a camera stored inside the file, and the size is the file’s own claim '
    + 'about it rather than something measured. Left alone the photo still arrives - as a named card, if this '
    + 'browser cannot decode the original itself.',
  'cover-art':
    'The artwork is decoded to draw a thumbnail on a card, and it travels inside every copy of the board '
    + 'afterwards. Left alone the track still imports, without its cover.',
  'mesh-triangles':
    'Positions and normals alone are about 36 bytes a triangle, so the geometry is that many times 36 before '
    + 'the renderer has touched it, and the card draws at thumbnail size either way. Past a few million the '
    + 'frame rate goes with it.',
  'mesh-buffer':
    'The buffer is embedded in the file as base64 and has to be decoded whole before anything can be read '
    + 'from it, which costs its full size again on top of the text it came out of.',
  'font-bytes':
    'A face is packed into every copy of the board and re-sent with every share, so this is a cost the file '
    + 'pays for as long as it exists rather than once at import.',
};

/** The sentence for one crossed ceiling: what was measured, then what it costs. */
export function explain(c: Crossed): string {
  return `${c.what}\n${RISKS[c.ceiling]}`;
}

/**
 * A ceiling met part-way through reading something, thrown for the caller to
 * ask about.
 *
 * A subclass rather than a flag on Error because the call sites have to tell it
 * apart from the corruption checks it sits among - "this entry declares 4 GB"
 * is a question and "this entry points past the end of the file" is not, and
 * both come out of readZip as a throw. Only the first is liftable.
 */
export class Oversize extends Error {
  ceiling: CeilingId;
  what: string;
  constructor(c: Crossed) {
    super(c.what);
    this.name = 'Oversize';
    this.ceiling = c.ceiling;
    this.what = c.what;
  }
}

/** Throwable form, for a reader that has just measured something too large. */
export const oversize = (ceiling: CeilingId, what: string) => new Oversize({ ceiling, what });

/** Whether a caught thing is a ceiling somebody could lift, rather than a broken file. */
export const isOversize = (e: unknown): e is Oversize => e instanceof Oversize;

/**
 * How the app asks, handed in rather than imported.
 *
 * `'go'` allows this one subject, `'all'` allows everything for the rest of the
 * session, `'no'` declines. The fifth of the seams the codebase keeps for
 * exactly this shape - setOverlays(), setAssetNameLookup(), setNoteMenu(),
 * setImportPrompt(), setBoardProbe() - and main.ts wires it to ui/dialog.ts at
 * startup.
 */
export type RiskPrompt =
  (opts: { title: string, body: string, go: string }) => Promise<'go' | 'all' | 'no'>;

let prompt: RiskPrompt | null = null;
export function setRiskPrompt(fn: RiskPrompt | null | undefined) {
  prompt = typeof fn === 'function' ? fn : null;
}

/**
 * **Unwired, everything is allowed.**
 *
 * The same default setImportPrompt() takes and for a reason this change makes
 * sharper. There, silence meant yes because the question was a courtesy in
 * front of something already asked for twice. Here silence has to mean yes
 * because the alternative is a module with no interface wired to it inventing a
 * refusal on the user's behalf - which is the exact behaviour every ceiling in
 * this app just stopped doing. It also keeps import/, storage/ and mesh.ts
 * loadable in a test with no DOM, which is what their headers promise.
 */
const isWired = () => prompt !== null;

/** Subjects already answered yes, so nothing asks twice about one file. */
const allowed = new Set<string>();
/** Set by the "everything" answer: no further question this session. */
let allowEverything = false;

/**
 * Ask about one subject, once.
 *
 * `key` is what "once" means - a file's name and size, an asset hash, whatever
 * identifies the thing being asked about to the caller. Every ceiling that
 * subject goes on to cross is covered by one yes: a 700 MB PSD that then
 * inflates to 900 MB and declares 80 megapixels is one question, because it is
 * one decision somebody has already made. That is the whole of what "one
 * warning per file" means here, and it is why this remembers anything at all.
 *
 * `reasons` is every ceiling known to be crossed at the moment of asking, in
 * the order they were found. All of them go in the one dialog.
 */
export async function allow(
  key: string,
  subject: string,
  reasons: Crossed[],
  go = 'Import',
): Promise<boolean> {
  if (!reasons.length) return true;
  if (allowEverything || allowed.has(key)) return true;
  if (!isWired()) return true;

  const answer = await prompt!({
    // Named for what was found rather than for how bad it is. "Large file" was
    // the old warning's title and it is still the right one for most of these;
    // a ratio is not a size and gets its own.
    title: reasons.some(r => r.ceiling === 'entry-ratio') ? 'This file expands suspiciously' : 'Past a safe limit',
    body: `${subject}\n\n${reasons.map(explain).join('\n\n')}`,
    go,
  });
  if (answer === 'no') return false;
  if (answer === 'all') allowEverything = true;
  allowed.add(key);
  return true;
}

/**
 * Ask about a ceiling a reader threw on, then say whether to run it again.
 *
 * The other half of the retry contract in this module's header. The caller's
 * shape is always the same three lines, which is why this exists rather than
 * each of the five call sites writing them:
 *
 *     try { return read(file); }
 *     catch (e) { if (await lift(e, key(file), file.name)) return read(file, LIFTED); throw e; }
 */
export async function lift(e: unknown, key: string, subject: string, go = 'Import'): Promise<boolean> {
  if (!isOversize(e)) return false;
  return allow(key, subject, [{ ceiling: e.ceiling, what: e.what }], go);
}

/**
 * Whether this subject has already been allowed, without asking anything.
 *
 * For the ceilings that are checked twice. The importer asks about a file's
 * declared pixel count before the work starts, and the same check runs again
 * further down where the decode actually happens - so the second one has to be
 * able to tell "nobody has looked at this" from "somebody said yes an hour of
 * hashing ago", or a yes would be quietly overruled by the code that asked.
 */
export const isAllowed = (key: string) => allowEverything || allowed.has(key);

/** What "this file" means to the memory above: the two things a picker gives us. */
export const fileKey = (f: { name?: string, size?: number }) => `${f.name || ''}:${f.size || 0}`;

/**
 * A blob's filename, when it has one.
 *
 * Half the callers hold a File, from a drop or a picker, and half hold a plain
 * Blob out of the asset store - which has a name recorded beside it in the
 * registry and none on the blob itself. Both need a subject line for the dialog,
 * and a warning headed "undefined" is worse than one headed "This document".
 *
 * Narrowed rather than asserted. `blob as File` would compile and then hand the
 * dialog `undefined` for every asset blob in the app, which is the class of
 * mistake the assertion rule in .oxlintrc.json exists to stop.
 */
export function nameOf(b: Blob, fallback: string): string {
  if ('name' in b && typeof b.name === 'string' && b.name) return b.name;
  return fallback;
}

/** For a test, or anything that wants the session's answers forgotten. */
export function resetConsent() {
  allowed.clear();
  allowEverything = false;
}

/** Whether the session has been told to stop asking. For a caller reporting state. */
export const askingStopped = () => allowEverything;

/** Whole megabytes, for a sentence. Nothing in these warnings needs the decimal. */
export const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
