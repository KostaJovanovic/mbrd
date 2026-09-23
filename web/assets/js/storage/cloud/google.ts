// Google Drive share provider. Uploads to the sender's own Drive, marks files
// public, and fetches shared files anonymously with an API key.
// Scope is drive.file only — sees nothing the app did not create. Resumable
// upload because boards exceed the 5 MB simple-upload limit.
// Identifiers live in config.ts; an unconfigured checkout has no Share link.

import {
  GOOGLE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_SECRET,
} from './config.ts';
import { googleSignInHere } from './provider.ts';
import { platform } from '../../platform/platform.ts';
import {
  fragmentViaPopup, nonce, recallGrant, redirectUri, rememberGrant, usable,
} from './oauth.ts';

import type { CloudFile, ShareProgress, ShareProvider } from './provider.ts';
import type { TokenGrant } from './oauth.ts';

// ---------------------------------------------------------------------------
// The three addresses
// ---------------------------------------------------------------------------

/** Navigated to, never fetched — not in connect-src, listed in NOT_FETCHED. */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Every request this module actually makes. One host, in connect-src. */
const API = 'https://www.googleapis.com';

/** Files this app created, and not one byte more. See the header. */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------------------------------------------------------------------------
// The token, held in memory and nowhere else
// ---------------------------------------------------------------------------

let grant: TokenGrant | null = null;

/** Lazy recall — no browser global at import time (tests/imports.test.js). */
function held(): TokenGrant | null {
  if (usable(grant)) return grant;
  grant = recallGrant('gdrive');
  return grant;
}

/** 8 MB chunks (must be 256 KB multiple). Big enough to minimize round trips, small enough for visible progress. */
const CHUNK = 8 * 1024 * 1024;

/** Extract the message from a Google error response — a bare 403 hides three different problems. */
async function failure(res: Response, what: string): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`.trim();
  try {
    const text = await res.text();
    // SAFETY: typeof and ?. guard every read below. A null or non-JSON body throws into
    // the catch, which keeps the status text.
    const body = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof body.error === 'string' ? body.error : body.error?.message;
    if (message) detail = message;
  } catch {
    // Non-JSON body — status text is still the truth.
  }
  return new Error(`${what}: ${detail}`);
}

/** Whether this build can offer Drive at all. Both halves or neither. */
function configured(): boolean {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY;
}

/** Configured, and a client of the kind this shell signs in with. */
function canSignIn(): boolean {
  return configured() && googleSignInHere();
}

/** The apps' sign-in: the shell asks Google, and the page gets the token. */
async function signInThroughShell(): Promise<void> {
  const got = await platform.auth.google({
    clientId: GOOGLE_DESKTOP_CLIENT_ID,
    clientSecret: GOOGLE_DESKTOP_CLIENT_SECRET,
    scope: SCOPE,
  });
  if (!got || typeof got.token !== 'string' || !got.token || !Number.isFinite(got.expiresIn) || got.expiresIn <= 0) {
    throw new Error('Google did not return a usable token');
  }
  grant = { token: got.token, expiresAt: Date.now() + got.expiresIn * 1000 };
  rememberGrant('gdrive', grant);
}

function signedIn(): boolean {
  return !!held();
}

/** Open sign-in popup. Must be from a live gesture. State nonce verified on return. */
async function signIn(): Promise<void> {
  if (!canSignIn()) throw new Error('this build has no Google application configured');
  if (held()) return;
  if (platform.auth.googleClient !== 'web') return signInThroughShell();

  const state = nonce();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    state,
    // Without select_account, multi-account users get the wrong Drive silently.
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
  // sessionStorage — survives reload, dies with the tab.
  rememberGrant('gdrive', grant);
}

/** Clear token, session storage, and resumable sessions (they belong to the old account). */
function signOut(): void {
  grant = null;
  rememberGrant('gdrive', null);
  sessions.clear();
}

/** The bearer header, or a throw that says to sign in rather than a 401 later. */
function auth(): string {
  const live = held();
  if (!live) throw new Error('not signed in to Google Drive');
  return `Bearer ${live.token}`;
}

/** Start a resumable session. Location header readable only because Google exposes it. */
async function beginUpload(
  blob: Blob, name: string,
  { parent = null, replacing = null }: { parent?: string | null, replacing?: string | null } = {},
): Promise<string> {
  const type = blob.type || 'application/octet-stream';
  // PATCH = replace existing; POST = create new. `parents` only on create.
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

/** The file id out of the reply to an upload's last byte. */
async function finished(res: Response): Promise<string> {
  // SAFETY: Drive's documented upload reply to fields=id; a missing id throws below.
  const done = await res.json() as { id?: string };
  if (!done.id) throw new Error('the upload finished without naming a file');
  return done.id;
}

/** How many bytes a session holds, from a 308's Range header, or null if it names none. */
function landed(res: Response): number | null {
  const end = /bytes=0-(\d+)/.exec(res.headers.get('range') || '');
  return end ? Number(end[1]) + 1 : null;
}

/**
 * How often an upload may fail in a row before it gives up, and the first wait
 * between tries, doubled each time: 0.5 s up to 8 s, half a minute in all. A
 * dropped Wi-Fi comes back inside that more often than not.
 */
const RETRIES = 5;
const RETRY_MS = 500;

/** The statuses Drive documents as "try again": a timeout, a rate limit, a server fault. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * After a drop or a server fault: wait, then ask the session how far it got.
 * Offline again counts one more try. A session Drive has let go throws, since
 * nothing but a fresh upload can follow it.
 */
async function recover(uri: string, size: number, fail: () => number): Promise<{ sent: number } | { id: string }> {
  for (;;) {
    const tries = fail();
    if (tries > RETRIES) throw new Error('the connection dropped and did not come back');
    await pause(RETRY_MS * 2 ** (tries - 1));
    let state: SessionState;
    try {
      state = await sessionProgress(uri, size);
    } catch {
      continue;
    }
    if (!state) throw new Error('Google Drive let the upload go - start it again');
    return state;
  }
}

/**
 * Send bytes in chunks. 308 = chunk landed, keep going (the one success res.ok
 * misses). A dropped connection or a server fault does not end the upload: the
 * session is asked how far it got, and the bytes go on from there
 * (research/old/done-2026-09-15.md, R13).
 */
async function sendChunks(
  uri: string, blob: Blob, onProgress: ShareProgress, from = 0,
): Promise<string> {
  let sent = from;
  // Empty blob needs special handling — one PUT with unsatisfied range.
  if (blob.size === 0) {
    const res = await fetch(uri, { method: 'PUT', headers: { 'Content-Range': 'bytes */0' } });
    if (!res.ok) throw await failure(res, 'the upload failed');
    onProgress(0, 0);
    return finished(res);
  }
  // Failures in a row; a chunk that lands starts the count again.
  let tries = 0;
  while (sent < blob.size) {
    const end = Math.min(sent + CHUNK, blob.size);
    let res: Response | null = null;
    try {
      res = await fetch(uri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${sent}-${end - 1}/${blob.size}`,
        },
        body: blob.slice(sent, end),
      });
    } catch {
      // No answer at all: the connection dropped. Recovered below.
    }
    if (res?.status === 308) {
      sent = landed(res) ?? end;
      tries = 0;
      onProgress(sent, blob.size);
      continue;
    }
    if (res?.ok) {
      onProgress(blob.size, blob.size);
      return finished(res);
    }
    if (res && !TRANSIENT.has(res.status)) throw await failure(res, 'the upload failed');
    const state = await recover(uri, blob.size, () => ++tries);
    if ('id' in state) {
      onProgress(blob.size, blob.size);
      return state.id;
    }
    sent = state.sent;
    onProgress(sent, blob.size);
  }
  throw new Error('the upload ended without finishing');
}

/**
 * Finish the upload a session opened earlier, or null when it cannot be: Drive
 * let it go, or cannot be reached to ask. The caller hands in the same Blob the
 * session began with, never one of equal size: equal size is not equal bytes
 * (a board.json), and bytes spliced from two files are a broken file.
 */
async function resume(uri: string, blob: Blob, onProgress: ShareProgress): Promise<string | null> {
  const state = await sessionProgress(uri, blob.size).catch(() => null);
  if (!state) return null;
  if ('id' in state) return state.id;
  onProgress(state.sent, blob.size);
  return sendChunks(uri, blob, onProgress, state.sent);
}

/** Let anyone with the link read it. Without this the link is a sign-in wall. */
async function publish(id: string): Promise<void> {
  const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}/permissions`, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  // Workspace accounts can forbid public sharing — upload succeeded but link fails.
  if (!res.ok) {
    throw await failure(res, 'the board uploaded, but Google would not make it shareable '
      + '(a work or school account often forbids this)');
  }
}

/**
 * A share's session, by the very Blob it sends, so a second try with the same
 * pack goes on where the first stopped. Weak, so a pack nobody retries is not
 * held. `id` is set once the bytes are all up: a publish refused after that
 * retries the publish alone, not the upload.
 */
const shares = new WeakMap<Blob, { uri: string | null, id: string | null }>();

async function upload(blob: Blob, name: string, onProgress: ShareProgress): Promise<string> {
  const open = shares.get(blob) ?? { uri: null, id: null };
  shares.set(blob, open);
  if (!open.id && open.uri) open.id = await resume(open.uri, blob, onProgress);
  if (!open.id) {
    open.uri = await beginUpload(blob, name);
    open.id = await sendChunks(open.uri, blob, onProgress);
  }
  await publish(open.id);
  shares.delete(blob);
  return open.id;
}

/** Fetch a public file anonymously via API key. No drive.google.com fallback (no CORS, interstitial). */
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
// The store: folders and listings for syncing boards
//
// drive.file scope means files.list sees only files this app created — no
// filtering needed, no Picker needed to find a board on another machine.
// ---------------------------------------------------------------------------

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Escape a value for Drive's q-string language (no parameter binding). */
const quoted = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * A whole listing, asking for the three fields anything here reads. Paged: a
 * board folder past 1000 files would otherwise lose board.json off page one.
 */
async function query(q: string): Promise<CloudFile[]> {
  const out: CloudFile[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id,name,modifiedTime)',
      pageSize: '1000',
      spaces: 'drive',
    });
    if (page) params.set('pageToken', page);
    const res = await fetch(`${API}/drive/v3/files?${params}`, { headers: { Authorization: auth() } });
    if (!res.ok) throw await failure(res, 'Google Drive would not list your files');
    // SAFETY: Drive's documented files.list shape, trimmed by `fields`. Both keys are optional:
    // `files` defaults to [] and a missing token ends the loop.
    const body = await res.json() as { files?: CloudFile[], nextPageToken?: string };
    out.push(...(body.files ?? []));
    page = body.nextPageToken;
  } while (page);
  return out;
}

/**
 * Find or create a folder. Not atomic (Drive allows duplicates) — two tabs
 * racing can create two folders; the next sync picks whichever query returns
 * first. Cost is a stray folder, not lost work.
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
  // SAFETY: Drive's documented files.create reply to fields=id; a missing id throws below.
  const made = await res.json() as { id?: string };
  if (!made.id) throw new Error('Google Drive made a folder without naming it');
  return made.id;
}

const list = (folderId: string) =>
  query(`${quoted(folderId)} in parents and trashed = false`);

/**
 * The boards shared as links. upload() names no parent, so a share lands at
 * the top of My Drive, and a synced board lives inside the mbrd folder: the
 * top holds shares and that one folder. Read from Drive rather than from a
 * list kept here, so a link shared on another machine shows too, and nothing
 * can drift from what is really up there.
 */
async function shared(): Promise<CloudFile[]> {
  const files = await query(`'root' in parents and trashed = false and mimeType != ${quoted(FOLDER_MIME)}`);
  // ISO 8601 on one clock sorts as text.
  return files.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
}

// ---------------------------------------------------------------------------
// Taking it all back out
//
// Trashed (30-day recovery), not permanently deleted. drive.file scope means
// "everything" is already exactly "files this app created". Parent walk skips
// children whose parent is also being trashed (folder trash is recursive).
// ---------------------------------------------------------------------------

/** One file, with the one extra field the walk below needs. */
interface OwnedFile {
  id: string;
  parents?: string[];
}

/** Everything this application created and has not already thrown away. */
async function owned(): Promise<OwnedFile[]> {
  const out: OwnedFile[] = [];
  let page: string | undefined;
  // Paged — unlike list() this reads the whole account, not one board folder.
  do {
    const params = new URLSearchParams({
      q: 'trashed = false',
      fields: 'nextPageToken, files(id,parents)',
      pageSize: '1000',
      spaces: 'drive',
    });
    if (page) params.set('pageToken', page);
    const res = await fetch(`${API}/drive/v3/files?${params}`, { headers: { Authorization: auth() } });
    if (!res.ok) throw await failure(res, 'Google Drive would not list your files');
    // SAFETY: Drive's documented files.list shape, trimmed by `fields`. Both keys are optional:
    // `files` defaults to [] and a missing token ends the loop.
    const body = await res.json() as { files?: OwnedFile[], nextPageToken?: string };
    out.push(...(body.files ?? []));
    page = body.nextPageToken;
  } while (page);
  return out;
}

/** Move one file to the person's Drive trash. See the note above on why not delete. */
async function trash(id: string): Promise<void> {
  const res = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw await failure(res, 'Google Drive would not remove a file');
}

async function purge(onProgress: ShareProgress): Promise<number> {
  const all = await owned();
  const ids = new Set(all.map(f => f.id));
  const roots = all.filter(f => !(f.parents || []).some(p => ids.has(p)));

  let done = 0;
  onProgress(0, roots.length);
  for (const file of roots) {
    await trash(file.id);
    onProgress(++done, roots.length);
  }
  // Count is roots, not files — one root can be a folder of hundreds.
  return roots.length;
}

/** Write a file into a folder. No per-byte progress — sync reports progress in files. */
// Resumable sessions kept in memory so a failed push resumes without
// re-uploading from byte zero. Map dies with the tab — persisting it would add
// complexity for a reload-during-upload edge case. The Blob is kept to compare:
// an asset's is the store's own object on every push, and a board.json is new
// each time, so it never resumes bytes that were a different file.
const sessions = new Map<string, { uri: string, blob: Blob }>();

const sessionKey = (folderId: string, name: string) => `${folderId}/${name}`;

/**
 * Query a resumable session: 308 = alive (Range says how far), 200/201 = already
 * finished, else dead. Range header readable only because Drive exposes it.
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
  // No Range at all: the session is alive and holds nothing yet.
  if (res.status === 308) return { sent: landed(res) ?? 0 };
  if (res.ok) {
    // Upload already completed — last chunk's response was lost. Read id here
    // to avoid creating a duplicate file.
    // SAFETY: Drive's documented upload reply; a missing id falls through to null (a fresh upload).
    const done = await res.json() as { id?: string };
    if (done.id) return { id: done.id };
  }
  return null;
}

/** Write a file, resuming any cut-off session. Session kept until success so failures can retry. */
async function put(
  folderId: string, name: string, blob: Blob, replacing: string | null,
): Promise<string> {
  const key = sessionKey(folderId, name);
  const open = sessions.get(key);
  // A throw in here keeps the session in the map, and the next push resumes it.
  const resumed = open?.blob === blob ? await resume(open.uri, blob, () => {}) : null;
  if (resumed) {
    sessions.delete(key);
    return resumed;
  }

  const uri = await beginUpload(blob, name, { parent: folderId, replacing });
  sessions.set(key, { uri, blob });
  const id = await sendChunks(uri, blob, () => {});
  sessions.delete(key);
  return id;
}

/** Authenticated fetch — the owner reading their own storage (synced boards are not public). */
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
  canSignIn,
  signedIn,
  signIn,
  signOut,
  upload,
  download,
  store: { folder, list, put, fetch: fetchFile, trash, shared, purge },
};
