// Share provider interface and link format.
// Bytes go to the sender's own cloud; the recipient fetches anonymously.
// No network imports here — ui/settings-schema.ts can check canShareLink()
// without pulling in OAuth or upload code. Link format: ?s=<code>.<id>,
// checked against a fixed provider table (CSP stays a named host list).

import { SHARE_PARAM } from '../../page.ts';
import { platform } from '../../platform/platform.ts';
import {
  GOOGLE_ANDROID_CLIENT, GOOGLE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_ID,
  GOOGLE_DESKTOP_CLIENT_SECRET,
} from './config.ts';

/** How far along an upload is, for the strip. Bytes, not a fraction. */
export interface ShareProgress {
  (sent: number, total: number): void;
}

/** One place a board can be put so a link reaches it. Thrown messages are shown to the user. */
export interface ShareProvider {
  /** Link token. Never change one that has shipped. */
  readonly id: string;
  readonly label: string;
  /** Whether this build has the registered app identifiers. Unconfigured = absent, not broken. */
  configured(): boolean;
  /** Whether this shell can sign in. Configured but not here opens a link it
   *  is sent, and offers no sign-in, upload or sync. */
  canSignIn(): boolean;
  signedIn(): boolean;
  /** Open the sign-in popup. Must be from a live user gesture (browsers block otherwise). */
  signIn(): Promise<void>;
  /** Local sign-out only — drops the token, does not revoke the grant. */
  signOut(): void;
  /** Upload, make public, return the file id. */
  upload(blob: Blob, name: string, onProgress: ShareProgress): Promise<string>;
  /** Fetch anonymously (recipient side, no token). */
  download(id: string): Promise<Blob>;
  /** Sync support (folders, listings, update-in-place). Absent if provider can only share. */
  store?: CloudStore;
}

/** One file in cloud storage. Names are content hashes — listing = diffing. */
export interface CloudFile {
  id: string;
  name: string;
  /** ISO 8601, the provider's own clock. Used only to spot a remote edit. */
  modifiedTime: string;
}

/** Sync half of a provider (folders, listings, update-in-place). Optional — absent means share-only. */
export interface CloudStore {
  /** Find or create a named folder. Returns its id. */
  folder(name: string, parent: string | null): Promise<string>;
  /** List a folder's contents. Caller diffs against local state. */
  list(folder: string): Promise<CloudFile[]>;
  /** Write or replace a file. Returns its id. */
  put(folder: string, name: string, blob: Blob, replacing: string | null): Promise<string>;
  /** Read a file back (authenticated, unlike download). */
  fetch(id: string): Promise<Blob>;
  /** Move one file to the account's trash, where the person can still get it back. */
  trash(id: string): Promise<void>;
  /** Every board shared as a link from this account, newest first. */
  shared(): Promise<CloudFile[]>;
  /**
   * Remove everything this app created. Provider must enumerate exactly
   * its own files (e.g. drive.file scope). Covers both synced boards and
   * loose shared files. Returns count removed.
   */
  purge(onProgress: ShareProgress): Promise<number>;
}

/** Provider + file id pair. Id is opaque; provider checked against the table. */
export interface ShareRef {
  provider: string;
  id: string;
}

/** Known providers in picker order. Modules loaded on demand by cloud.ts. */
export const PROVIDER_IDS = ['gdrive'] as const;

/**
 * Short codes for link format. Both long (gdrive) and short (g) are read;
 * only the short form is written. Old links with long form still work.
 */
const PROVIDER_CODES: Record<string, string> = { gdrive: 'g' };

/** The short spelling for a link, falling back to the full name. */
const codeFor = (provider: string) => PROVIDER_CODES[provider] || provider;

/**
 * Parse "g.abc123" or "gdrive.abc123" into a ShareRef. Unknown provider = null.
 * Always resolves to the long provider id internally.
 */
export function parseShareRef(value: string | null): ShareRef | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const said = value.slice(0, dot);
  const id = value.slice(dot + 1);
  const provider = PROVIDER_IDS.find(p => p === said || PROVIDER_CODES[p] === said);
  if (!provider) return null;
  if (!id || !/^[\w-]{1,256}$/.test(id)) return null;
  return { provider, id };
}

/** Build a share link. `home` is page.ts's homePath() (respects <base>). */
export function shareLinkFor(origin: string, home: string, ref: ShareRef): string {
  return `${origin}${home}?${SHARE_PARAM}=${codeFor(ref.provider)}.${ref.id}`;
}

/**
 * Whether this shell can sign in to Google. The web's popup fails in the apps
 * (the desktop denies it and serves app://, Android serves https://app), so
 * each app signs in with a client of its own, and has none until config.ts
 * names it.
 */
export function googleSignInHere(): boolean {
  switch (platform.auth.googleClient) {
    case 'desktop': return !!GOOGLE_DESKTOP_CLIENT_ID && !!GOOGLE_DESKTOP_CLIENT_SECRET;
    case 'android': return GOOGLE_ANDROID_CLIENT;
    default: return true;
  }
}

/** Synchronous check for ui/settings-schema.ts — both client id and API key, or neither, and a sign-in that works here. */
export function canShareLink(): boolean {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY && googleSignInHere();
}
