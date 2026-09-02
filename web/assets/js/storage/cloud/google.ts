// Google Drive: the first place a board can be put so that a link reaches it.
//
// The sender's own Drive, never ours. What this module does is put one file
// there, mark it readable by anyone with the link, and hand back its id; and, on
// the other side, fetch one back with no account at all. It is the first
// implementation of the shape in provider.ts and it was written to be the one
// the second and third copy from.
//
// ── The two identifiers are in config.ts, not here ──
//
// They are public by construction and protected by registration rather than by
// secrecy; that argument, and the four steps of setting the Google side up, are
// in the header of config.ts. What matters here is the consequence, because it
// looks like a bug the first time somebody clones this: **an unconfigured
// checkout has no Share link at all.** The row is absent from the panel rather
// than present and failing, which is the schema's own rule (absence, not
// disabling) applied to a capability instead of to a control.
//
// ── drive.file, and nothing wider, ever ──
//
// The scope reaches only files this app itself created. It is non-sensitive, so
// it needs no annual third-party security assessment - the wider scopes, which
// can read a person's whole Drive, do, and they cost real money every year. The
// recipient path is what makes the narrow scope enough: it is an anonymous fetch
// of a public file, so nothing here ever needs to *read* somebody's account.
// Widening this string is not a one-word edit; it is a change of what kind of
// application this is.
//
// ── The upload is resumable because it has to be ──
//
// Drive's simple upload tops out at 5 MB and a moodboard with three photographs
// on it is past that. A resumable session is two round trips instead of one, and
// it buys the only progress this feature can honestly report: the strip counts
// the bytes that have actually left, chunk by chunk, rather than animating while
// one enormous request hangs.

import { GOOGLE_API_KEY, GOOGLE_CLIENT_ID } from './config.ts';
import {
  fragmentViaPopup, nonce, recallGrant, redirectUri, rememberGrant, usable,
} from './oauth.ts';

import type { CloudFile, ShareProgress, ShareProvider } from './provider.ts';
import type { TokenGrant } from './oauth.ts';

// ---------------------------------------------------------------------------
// The three addresses
// ---------------------------------------------------------------------------

/**
 * Where the person signs in.
 *
 * **Navigated to, never fetched**, which is why it is not in connect-src and is
 * named in tests/csp.test.js's NOT_FETCHED list instead. A popup going to
 * somebody else's login page is an ordinary navigation; no directive in this
 * app's policy governs it, and form-action does not apply because there is no
 * form here - the parameters are in the query string of a URL we open.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Every request this module actually makes. One host, in connect-src. */
const API = 'https://www.googleapis.com';

/** Files this app created, and not one byte more. See the header. */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------------------------------------------------------------------------
// The token, held in memory and nowhere else
// ---------------------------------------------------------------------------

let grant: TokenGrant | null = null;

/**
 * The token, from memory or from the tab that was here before the reload.
 *
 * Read lazily rather than at module load, on the rule the whole tree follows: a
 * module that touches a browser global merely by being imported cannot be loaded
 * by a test with no browser (tests/imports.test.js). The first question anybody
 * asks of this provider is signedIn(), and that is early enough.
 */
function held(): TokenGrant | null {
  if (usable(grant)) return grant;
  grant = recallGrant('gdrive');
  return grant;
}

/**
 * Chunk size for the resumable upload.
 *
 * Drive requires every chunk but the last to be a multiple of 256 KB. Eight
 * megabytes is large enough that the per-chunk round trip is noise on a real
 * connection and small enough that the progress bar moves on a board of
 * photographs rather than jumping from nothing to done.
 */
const CHUNK = 8 * 1024 * 1024;

/**
 * The message inside a Google error response, or a description of the status.
 *
 * Worth the twenty lines because the alternative is showing somebody "403",
 * which is the same string for "your organisation does not allow this", "the
 * key is restricted to another site" and "you are out of Drive space" - three
 * different problems with three different answers, only one of which is ours.
 */
async function failure(res: Response, what: string): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`.trim();
  try {
    const text = await res.text();
    // SAFETY: the shape is asserted and then read defensively - every access
    // below is optional-chained, so a body that is valid JSON of some other
    // shape falls through to the status text rather than throwing inside an
    // error path. A body that is not JSON at all throws in parse() and is
    // caught.
    const body = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof body.error === 'string' ? body.error : body.error?.message;
    if (message) detail = message;
  } catch {
    // A non-JSON body from an API that documents JSON is not worth reporting as
    // its own failure; the status is still the truth.
  }
  return new Error(`${what}: ${detail}`);
}

/** Whether this build can offer Drive at all. Both halves or neither. */
function configured(): boolean {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY;
}

function signedIn(): boolean {
  return !!held();
}

/**
 * Open Google's sign-in window and keep what comes back.
 *
 * Must be called from a live user gesture - see the note on the interface. The
 * `state` nonce is checked on the way back so that a fragment left on that page
 * by anything else cannot be mistaken for an answer to this question.
 */
async function signIn(): Promise<void> {
  if (!configured()) throw new Error('this build has no Google application configured');
  if (held()) return;

  const state = nonce();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    state,
    // Asked for rather than assumed. Without it a person with two Google
    // accounts is silently signed in as whichever one the browser happens to
    // hold, and the board lands in the wrong Drive - which is not an error
    // anywhere and is very hard to explain afterwards.
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });

  const back = await fragmentViaPopup(`${AUTH_URL}?${params}`, 'mbrd-google-signin');

  const error = back.get('error');
  if (error) {
    throw new Error(error === 'access_denied'
      ? 'Google Drive access was not granted'
      : `Google refused the sign-in: ${error}`);
  }
  if (back.get('state') !== state) {
    throw new Error('the sign-in answered a different request - try again');
  }
  const token = back.get('access_token');
  const seconds = Number(back.get('expires_in'));
  if (!token || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Google did not return a usable token');
  }
  grant = { token, expiresAt: Date.now() + seconds * 1000 };
  // Kept for the life of this tab, so a reload does not throw away a token with
  // fifty minutes left on it and ask for an identical one. Dies with the tab -
  // see the note on rememberGrant() for why that is the right shelf and
  // localStorage is not.
  rememberGrant('gdrive', grant);
}

/** The bearer header, or a throw that says to sign in rather than a 401 later. */
function auth(): string {
  const live = held();
  if (!live) throw new Error('not signed in to Google Drive');
  return `Bearer ${live.token}`;
}

/**
 * Start a resumable session and answer with the URI to write the bytes to.
 *
 * The session URI comes back in the `Location` header, which is readable
 * cross-origin only because Google exposes it - a header a server does not list
 * in Access-Control-Expose-Headers reads as null however plainly it was sent, so
 * the check below is a real one rather than a formality.
 */
async function beginUpload(
  blob: Blob, name: string,
  { parent = null, replacing = null }: { parent?: string | null, replacing?: string | null } = {},
): Promise<string> {
  const type = blob.type || 'application/octet-stream';
  // PATCH against a file id replaces the bytes of a file that exists; POST makes
  // a new one. Both go through the same resumable session, which is what keeps
  // this one function rather than two - and `parents` may only be sent on the
  // create: Drive rejects it on an update, where moving a file is a different
  // request with `addParents`. Nothing here ever moves one.
  const where = replacing
    ? `${API}/upload/drive/v3/files/${encodeURIComponent(replacing)}?uploadType=resumable&fields=id`
    : `${API}/upload/drive/v3/files?uploadType=resumable&fields=id`;
  const meta: Record<string, unknown> = { name, mimeType: type };
  if (!replacing && parent) meta.parents = [parent];
  const res = await fetch(where, {
    method: replacing ? 'PATCH' : 'POST',
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw await failure(res, 'Google Drive would not start the upload');
  const uri = res.headers.get('location');
  if (!uri) throw new Error('Google Drive started an upload with nowhere to put it');
  return uri;
}

/**
 * Send the bytes, a chunk at a time, and answer with the new file's id.
 *
 * 308 is the interesting status and the reason this is a loop rather than one
 * PUT: it means "that chunk landed, keep going", and it is the only success
 * `res.ok` does not cover.
 */
async function sendChunks(
  uri: string, blob: Blob, onProgress: ShareProgress, from = 0,
): Promise<string> {
  let sent = from;
  // An empty blob would never enter the loop and would fall out of the bottom as
  // "the upload ended without finishing", which is a lie about a file that is
  // simply zero bytes long. Drive wants one PUT with an unsatisfied range for
  // this case. Nothing on a board is empty today; a format that starts writing
  // an empty sidecar would find out here rather than in a stuck sync.
  if (blob.size === 0) {
    const res = await fetch(uri, { method: 'PUT', headers: { 'Content-Range': 'bytes */0' } });
    if (!res.ok) throw await failure(res, 'the upload failed');
    onProgress(0, 0);
    // SAFETY: same response shape the loop below reads, and checked the same
    // way - `id` is optional here and the throw is what handles its absence.
    const done = await res.json() as { id?: string };
    if (!done.id) throw new Error('the upload finished without naming a file');
    return done.id;
  }
  while (sent < blob.size) {
    const end = Math.min(sent + CHUNK, blob.size);
    const res = await fetch(uri, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes ${sent}-${end - 1}/${blob.size}`,
      },
      body: blob.slice(sent, end),
    });
    if (res.status === 308) {
      sent = end;
      onProgress(sent, blob.size);
      continue;
    }
    if (!res.ok) throw await failure(res, 'the upload failed');
    onProgress(blob.size, blob.size);
    // SAFETY: the shape is asserted and then checked - `id` is read through an
    // optional property and the throw below is what handles a body that does
    // not carry one. Drive documents this response as the file resource, and
    // `fields=id` on the session request is what narrows it to this.
    const done = await res.json() as { id?: string };
    if (!done.id) throw new Error('the upload finished without naming a file');
    return done.id;
  }
  throw new Error('the upload ended without finishing');
}

/** Let anyone with the link read it. Without this the link is a sign-in wall. */
async function publish(id: string): Promise<void> {
  const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}/permissions`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  // The one failure worth its own sentence. A managed Google Workspace account
  // can forbid anyone-with-the-link sharing outright, and when it does this is
  // where it says so - the upload has already succeeded, the file is in the
  // person's Drive, and nothing about that is a fault in this app.
  if (!res.ok) {
    throw await failure(res, 'the board uploaded, but Google would not make it shareable '
      + '(a work or school account often forbids this)');
  }
}

async function upload(blob: Blob, name: string, onProgress: ShareProgress): Promise<string> {
  const uri = await beginUpload(blob, name);
  const id = await sendChunks(uri, blob, onProgress);
  await publish(id);
  return id;
}

/**
 * The recipient's half: a public file, fetched with a key and no account.
 *
 * `alt=media` is what makes this the bytes rather than the metadata about them,
 * and the API key is what makes it billable to a project without a token. There
 * is deliberately no fallback to drive.google.com's download host - that one
 * serves an interstitial page for large files, sets no CORS headers, and would
 * be a second host in connect-src for a path that sometimes returns HTML.
 */
async function download(id: string): Promise<Blob> {
  if (!GOOGLE_API_KEY) throw new Error('this build cannot open Google Drive links');
  const res = await fetch(
    `${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(GOOGLE_API_KEY)}`);
  if (!res.ok) {
    throw await failure(res, 'the shared board could not be fetched '
      + '(the link may have been revoked, or the file deleted)');
  }
  return res.blob();
}

// ---------------------------------------------------------------------------
// The store: folders and listings, for keeping a board rather than sending one
//
// Everything below needs a live token and reads the signed-in person's own
// Drive. It stays inside `drive.file` without doing anything clever, and the
// reason is worth knowing because it looks like it should not work: with that
// scope, files.list returns **only files this application created**. So a
// listing is not a search of somebody's Drive that we then filter - it is a
// search that cannot see anything else in the first place. That is what lets the
// sync engine ask "which of these assets are already up there" with one request
// and no manifest, and it is why no Picker is needed to find a board again on a
// second machine.
// ---------------------------------------------------------------------------

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * A `q` string with a value quoted into it, safely.
 *
 * Drive's query language is a string language with no parameter binding, so a
 * folder called `it's` would end the literal and produce a syntax error at best.
 * Board folders are named by an id this app minted, so today nothing can reach
 * it - and "today nothing can reach it" is how every injection in every query
 * language has ever started.
 */
const quoted = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** One page of a listing, asking for the three fields anything here reads. */
async function query(q: string): Promise<CloudFile[]> {
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,modifiedTime)',
    pageSize: '1000',
    spaces: 'drive',
  });
  const res = await fetch(`${API}/drive/v3/files?${params}`, { headers: { Authorization: auth() } });
  if (!res.ok) throw await failure(res, 'Google Drive would not list your files');
  // SAFETY: the shape is asserted and then read defensively - `files` is
  // optional and the fallback below covers a body that carries none. `fields`
  // on the request is what narrows the resource to these three keys.
  const body = await res.json() as { files?: CloudFile[] };
  return body.files ?? [];
}

/**
 * Find a folder by name under a parent, or make one.
 *
 * Not atomic, and it cannot be: Drive has no create-if-absent and permits two
 * folders with the same name in the same parent. Two tabs syncing the same board
 * for the first time in the same second can therefore both create one, and the
 * loser's board.json goes into a folder nothing looks in again. The cost of that
 * is a duplicate folder in somebody's Drive, not lost work - the board on screen
 * is untouched and the next sync finds whichever folder the query returns first
 * and carries on with it. Worth the honesty of saying so rather than the
 * machinery of a lock this app cannot hold across tabs.
 */
async function folder(name: string, parent: string | null): Promise<string> {
  const within = parent ? ` and ${quoted(parent)} in parents` : '';
  const found = await query(
    `name = ${quoted(name)} and mimeType = ${quoted(FOLDER_MIME)} and trashed = false${within}`);
  if (found[0]) return found[0].id;

  const meta: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parent) meta.parents = [parent];
  const res = await fetch(`${API}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw await failure(res, `Google Drive would not create the ${name} folder`);
  // SAFETY: asserted then checked - `fields=id` narrows the response to this one
  // key, and the throw below is what handles a body that does not carry it.
  const made = await res.json() as { id?: string };
  if (!made.id) throw new Error('Google Drive made a folder without naming it');
  return made.id;
}

const list = (folderId: string) =>
  query(`${quoted(folderId)} in parents and trashed = false`);

/**
 * Write a file into a folder, creating or replacing.
 *
 * No progress callback, unlike the share path. Every caller of this is the sync
 * engine, which reports progress in *files* rather than in bytes - "3 of 40" is
 * the number that means something when the work is forty separate uploads, and a
 * bar that restarted at zero forty times would be worse than no bar.
 */
// ── Picking up an upload that was cut off ──
//
// A resumable session is a URI Drive keeps for about a week, and until now this
// app threw one away the moment a request failed: the next sync found the file
// absent from the listing and started the whole thing again from byte zero. On a
// board of video over a connection that drops, that is the difference between a
// sync that eventually finishes and one that never does.
//
// The map is in memory and that is the honest scope. It covers the case that
// actually happens - a chunk fails, the push reports it, the person or the next
// autosave tries again a minute later - and not the one that reads as if it
// should - a reload, where the map is gone. Persisting it would mean a second
// store keyed by content that IndexedDB would then have to be swept for, to buy
// a retry across a page load nobody performs mid-upload. What survives a reload
// already is every asset that finished, because they are named by their bytes.
const sessions = new Map<string, { uri: string, size: number }>();

const sessionKey = (folderId: string, name: string) => `${folderId}/${name}`;

/**
 * How much of a session's file the server already has, or null to start again.
 *
 * A PUT with an unsatisfied range asks Drive that question. 308 means the
 * session is alive and `Range` says what landed; 200 or 201 mean it actually
 * finished and we never saw the answer; anything else means the session is gone
 * and the caller opens a new one.
 *
 * **`Range` is readable only because Drive exposes it**, and a header a server
 * does not list in Access-Control-Expose-Headers reads as null however plainly
 * it was sent - so an absent one is treated as "nothing landed" rather than as
 * an error. That is the safe direction: it re-sends bytes that were already
 * there, which costs time and cannot corrupt anything.
 */
type SessionState =
  /** Alive, and this many bytes have landed. */
  | { sent: number }
  /** It actually finished and we never saw the answer. Here is the file. */
  | { id: string }
  /** Gone. Open a new one. */
  | null;

async function sessionProgress(uri: string, size: number): Promise<SessionState> {
  const res = await fetch(uri, {
    method: 'PUT', headers: { 'Content-Range': `bytes */${size}` },
  });
  if (res.status === 308) {
    const range = res.headers.get('range');
    const end = range && /bytes=0-(\d+)/.exec(range);
    return { sent: end ? Number(end[1]) + 1 : 0 };
  }
  if (res.ok) {
    // The upload had in fact completed - the answer to the last chunk was lost
    // rather than the chunk itself. Reading the id off this response is the only
    // way to find that out, and re-sending would make a second file.
    //
    // SAFETY: asserted then checked - `id` is optional here and the fallthrough
    // below is what handles a body that does not carry one, which is treated as
    // a dead session and starts again.
    const done = await res.json() as { id?: string };
    if (done.id) return { id: done.id };
  }
  return null;
}

/**
 * Write a file into a folder, resuming a cut-off attempt where there is one.
 *
 * The session is remembered before a byte is sent and forgotten only on success,
 * which is the ordering that makes the retry possible at all: a session dropped
 * on failure is a session that cannot be resumed, and failure is exactly when it
 * is wanted.
 */
async function put(
  folderId: string, name: string, blob: Blob, replacing: string | null,
): Promise<string> {
  const key = sessionKey(folderId, name);
  const open = sessions.get(key);

  // Same name, same length: this is the file that was cut off, so ask the server
  // what it managed to keep. A size that differs is a different file under a
  // name that cannot be reused - which for an asset is impossible, since the
  // name is the hash of the bytes, and for board.json is the ordinary case.
  if (open && open.size === blob.size) {
    const state = await sessionProgress(open.uri, blob.size);
    if (state && 'id' in state) {
      sessions.delete(key);
      return state.id;
    }
    if (state) {
      // Left in the map on the way through: if this attempt fails too, the next
      // one picks the same session up again. A session dropped on failure is a
      // session that cannot be resumed, and failure is exactly when it is
      // wanted.
      const id = await sendChunks(open.uri, blob, () => {}, state.sent);
      sessions.delete(key);
      return id;
    }
    // Expired or rejected. Fall through and open a new one.
    sessions.delete(key);
  }

  const uri = await beginUpload(blob, name, { parent: folderId, replacing });
  sessions.set(key, { uri, size: blob.size });
  const id = await sendChunks(uri, blob, () => {});
  sessions.delete(key);
  return id;
}

/**
 * Read a file back with the token.
 *
 * The signed-in twin of download(), and the difference is the whole asymmetry of
 * this feature: download() is the recipient of a share link, who has no account
 * and reaches a public file with an API key, and this is the owner reading their
 * own storage. A synced board is never made public, which is why it cannot use
 * the other one.
 */
async function fetchFile(id: string): Promise<Blob> {
  const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
    { headers: { Authorization: auth() } });
  if (!res.ok) throw await failure(res, 'Google Drive would not hand back a file');
  return res.blob();
}

export const googleDrive: ShareProvider = {
  id: 'gdrive',
  label: 'Google Drive',
  configured,
  signedIn,
  signIn,
  upload,
  download,
  store: { folder, list, put, fetch: fetchFile },
};
