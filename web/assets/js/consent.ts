// Size ceilings: prose, decision, and the retry contract for oversized files.
// Numbers stay where they are argued (budget.ts, zip.ts, mesh.ts); this module
// centralises the user-facing explanation and the once-per-file memory.
// Readers that discover a ceiling mid-parse throw Oversize; the async caller
// catches it, asks once, and re-runs with the ceiling lifted. Pure — no DOM,
// no state, sits in BASE layer.

/** Which ceiling was crossed. One id per number that used to be a refusal. */
export type CeilingId =
  | 'file-bytes'
  | 'batch-bytes'
  | 'pixels'
  | 'sensor-pixels'
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

/** One crossed ceiling. `what` is the measurement; the risk sentence comes from RISKS. */
export type Crossed = { ceiling: CeilingId, what: string };

/**
 * Risk prose per ceiling. States cost in concrete terms (bytes, seconds) and
 * what happens on "no" (graceful degradation where possible).
 * `entry-ratio` is the outlier — not about size but about a file lying.
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
  'sensor-pixels':
    'Developing a RAW holds the sensor at eight bytes a pixel while it works, then the picture again at four '
    + 'bytes a pixel to draw it, so a sensor this size can cost well over a gigabyte at once. Left alone the '
    + 'card keeps the preview the camera made.',
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

/** Thrown when a ceiling is crossed mid-parse. Subclass so callers can distinguish it from corruption errors. */
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

/** Injected prompt: 'go' (this file), 'all' (stop asking), 'no' (decline). Wired by main.ts. */
export type RiskPrompt =
  (opts: { title: string, body: string, go: string }) => Promise<'go' | 'all' | 'no'>;

let prompt: RiskPrompt | null = null;
export function setRiskPrompt(fn: RiskPrompt | null | undefined) {
  prompt = typeof fn === 'function' ? fn : null;
}

// Unwired = allow everything. A module with no UI must not invent a refusal.
const isWired = () => prompt !== null;

/** Subjects already answered yes, so nothing asks twice about one file. */
const allowed = new Set<string>();
/** Set by the "everything" answer: no further question this session. */
let allowEverything = false;

/**
 * Ask once per `key` (file name+size). One yes covers all ceilings that subject
 * crosses — a 700 MB PSD that also exceeds pixels is one question, not three.
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
    // Ratio gets its own title — it is not about size but about suspicious expansion.
    title: reasons.some(r => r.ceiling === 'entry-ratio') ? 'This file expands suspiciously' : 'Past a safe limit',
    body: `${subject}\n\n${reasons.map(explain).join('\n\n')}`,
    go,
  });
  if (answer === 'no') return false;
  if (answer === 'all') allowEverything = true;
  allowed.add(key);
  return true;
}

/** Ask about a thrown Oversize. Returns true to retry with the ceiling lifted. */
export async function lift(e: unknown, key: string, subject: string, go = 'Import'): Promise<boolean> {
  if (!isOversize(e)) return false;
  return allow(key, subject, [{ ceiling: e.ceiling, what: e.what }], go);
}

/** Whether this subject was already allowed. For ceilings checked twice (e.g. pixel count). */
export const isAllowed = (key: string) => allowEverything || allowed.has(key);

/** What "this file" means to the memory above: the two things a picker gives us. */
export const fileKey = (f: { name?: string, size?: number }) => `${f.name || ''}:${f.size || 0}`;

/** Blob's filename if it is a File, otherwise the fallback. Narrowed, not asserted. */
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
