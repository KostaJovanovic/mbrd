// What a share provider is, and what a share link says.
//
// Sending somebody a board by sending them a URL. The whole design is in
// research/old/share-link-2026-08-14.md and it is mostly a record of what was
// ruled out; the two rejections worth carrying here, because both get proposed
// again by anybody who has not read that document:
//
//   - **Peer-to-peer cannot work for a link.** Both tabs would have to be open
//     at the same moment, which is a session and not a link.
//   - **A link carrying the board inside it cannot hold one photograph.** Assets
//     are embedded bytes; megabytes of base64 in a URL are truncated by mail
//     clients long before a browser objects, and a board without its pictures is
//     not the board.
//
// So the bytes rest in the *sender's own* cloud account, the app runs no
// infrastructure, and the recipient fetches a public file with no account at
// all. The asymmetry is the whole design: the sender signs in, the recipient
// never does, and nothing here is ever a server.
//
// ── Why this file holds no network code ──
//
// This is the shape and the table, and it imports nothing that talks to a host -
// which is what lets ui/settings-schema.ts ask "can this build share at all"
// without the OAuth flow and the uploader becoming dependencies of the settings
// panel. Each provider is one module behind one interface, reached through
// share.ts. The second and third providers are cheap if this seam is right and
// expensive if it is not, which is the only reason Phase 1 was ever a seam
// rather than one function.
//
// ── The link format is ours, and that is a CSP decision ──
//
//   https://<host>/?s=<provider>.<id>
//
// The tempting alternative is to accept any https:// URL and fetch it, which
// would handle every service at once with no sign-in code at all. It is the
// wrong trade *here* specifically: it forces connect-src open to `https:`, and
// web/_headers spends two hundred lines arguing that this app fetches from a
// named list of hosts and that a board renders with the network off. A fixed
// provider table keeps the policy a list of names, which is a promise the header
// can actually keep. tests/csp.test.js holds the two in step.
//
// The reference is parsed here rather than in page.ts for the same reason the
// table is here: page.ts is the base module that knows *which page this is* and
// imports nothing, so it reads the query string and hands over a string. What a
// share reference means is this module's business.

import { SHARE_PARAM } from '../../page.ts';
import { GOOGLE_API_KEY, GOOGLE_CLIENT_ID } from './config.ts';

/** How far along an upload is, for the strip. Bytes, not a fraction. */
export interface ShareProgress {
  (sent: number, total: number): void;
}

/**
 * One place a board can be put so that a link reaches it.
 *
 * Every method may throw, and a thrown Error's message is shown to the person -
 * so a provider's failures have to read as sentences rather than as status
 * codes. The one that matters most is the tenant refusal OneDrive will bring:
 * work and school accounts frequently block anyone-with-the-link sharing, and
 * that is a fact about somebody's employer rather than a fault in this app.
 */
export interface ShareProvider {
  /** The token that goes in the link. Never change one that has shipped. */
  readonly id: string;
  /** What the person is told they are signing in to. */
  readonly label: string;
  /**
   * Whether this build carries the registered application's identifiers.
   *
   * A provider needs a registered app and a registered origin, and those are the
   * deployer's to create - so a checkout with nothing filled in has a provider
   * that is *absent* rather than one that fails when pressed. That is the
   * schema's own rule (absence, not disabling) applied one layer down.
   */
  configured(): boolean;
  /** Whether a usable token is already in hand, so no popup is needed. */
  signedIn(): boolean;
  /**
   * Get a token, opening the provider's own sign-in window.
   *
   * **Must be called from a live user gesture.** Every browser blocks a popup
   * that is not, and the two dialogs this feature asks first are long enough to
   * spend the activation - which is why commands/file.ts puts its own question
   * in front of this one and calls it from that answer.
   */
  signIn(): Promise<void>;
  /** Upload, make it readable by anyone with the link, and answer with its id. */
  upload(blob: Blob, name: string, onProgress: ShareProgress): Promise<string>;
  /** Fetch one back, with no account and no token. This is the recipient's half. */
  download(id: string): Promise<Blob>;
  /**
   * Folders and listings, for keeping boards rather than sending them. Absent on
   * a provider that can share and cannot sync; see CloudStore.
   */
  store?: CloudStore;
}

/**
 * One file in a provider's storage, as little of it as this app needs.
 *
 * `name` is the whole of the addressing. A synced board is a folder of files
 * named by the SHA-256 of their own bytes, so listing the folder *is* asking
 * "which of these do you already have" - there is no manifest to keep in step
 * and nothing to go stale, because the name is derived from the content rather
 * than recorded alongside it.
 */
export interface CloudFile {
  id: string;
  name: string;
  /** ISO 8601, the provider's own clock. Used only to spot a remote edit. */
  modifiedTime: string;
}

/**
 * The half of a provider that keeps boards rather than shares them.
 *
 * Separate from the share methods and optional on purpose: sharing is one
 * upload and a public link, and every provider worth adding can do it. Keeping a
 * board in sync needs folders, a listing and an update-in-place, and a provider
 * that cannot do all three should be able to offer the first feature without
 * pretending to the second. `sync` being absent is how it says so.
 *
 * **Every method needs a live token.** Unlike `download()`, none of this is
 * anonymous - it is the signed-in person's own storage being read and written.
 */
export interface CloudStore {
  /** Find the folder of this name under `parent`, or make it. Answers its id. */
  folder(name: string, parent: string | null): Promise<string>;
  /** What is in a folder. One request; the caller diffs it against what it has. */
  list(folder: string): Promise<CloudFile[]>;
  /**
   * Write `blob` into `folder` as `name`, replacing `replacing` if given.
   *
   * The two cases are one method because the caller never wants to think about
   * which it is: an asset named by its own hash is written once and never
   * updated, and board.json is updated every time. Answers the file's id, which
   * is the only thing worth remembering about it.
   */
  put(folder: string, name: string, blob: Blob, replacing: string | null): Promise<string>;
  /** Read one back, with the token. The signed-in half of `download()`. */
  fetch(id: string): Promise<Blob>;
}

/**
 * Which provider, and which file within it.
 *
 * A pair rather than a URL, deliberately: the id half is opaque to this app and
 * is whatever the provider calls a file, and the provider half is checked
 * against the table below before anything is fetched.
 */
export interface ShareRef {
  provider: string;
  id: string;
}

/**
 * The providers this build knows about, in the order a picker would show them.
 *
 * Google first and alone: the argument in the plan was Dropbox first, on the
 * grounds that it is the simplest sign-in and the likeliest to work on the first
 * attempt, which is what a first provider is for. That was overruled on install
 * base, which is the better argument for a feature whose whole value is that the
 * person you are sending to can open it. OneDrive is next and lands on this
 * table with no user-facing design left to do.
 *
 * Names only - the modules are loaded on demand by share.ts.
 */
export const PROVIDER_IDS = ['gdrive'] as const;

/**
 * Read `gdrive.abc123` into a reference, or null for anything else.
 *
 * The value comes from page.ts's openingShare(), which owns the parameter name;
 * this owns what the value means. Deliberately strict about the provider half
 * and deliberately loose about the id: an id is the provider's own spelling of a
 * file and this app has no business having an opinion about it, beyond it being
 * non-empty and free of the characters that would let it climb out of a URL
 * path. A reference naming a provider this build does not carry is null rather
 * than an error, because an older build meeting a newer link should read as
 * "this app cannot open that" rather than as a fault.
 */
export function parseShareRef(value: string | null): ShareRef | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const provider = value.slice(0, dot);
  const id = value.slice(dot + 1);
  // SAFETY: the cast is a membership test against a frozen literal tuple, not a
  // claim about the value - `includes` on a `readonly string[]` refuses a plain
  // string argument, and widening the tuple is what the check is *for*.
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) return null;
  if (!id || !/^[\w-]{1,256}$/.test(id)) return null;
  return { provider, id };
}

/**
 * The link to hand somebody, built against the page the app is served from.
 *
 * `home` is page.ts's homePath() - the app is wherever its <base> says it is,
 * and a link built against '/' would be wrong the day this is hosted in a
 * subdirectory. The origin comes from the caller for the same reason this module
 * imports nothing: it is testable without a document.
 */
export function shareLinkFor(origin: string, home: string, ref: ShareRef): string {
  return `${origin}${home}?${SHARE_PARAM}=${ref.provider}.${ref.id}`;
}

/**
 * Whether this build can share a link at all, answered without loading any of
 * the code that would do it.
 *
 * The reason this is here and synchronous is ui/settings-schema.ts: a `when`
 * predicate runs while the panel is being built, and the schema's rule is that a
 * control which cannot work is *absent* rather than greyed. So the question has
 * to be answerable from two strings, and the OAuth flow and the uploader stay
 * behind the dynamic import in share.ts where they belong.
 *
 * Both halves of a provider or neither. A build with a client id and no API key
 * can upload a board and then fail to open its own link, which is the one
 * outcome worse than the feature being missing.
 */
export function canShareLink(): boolean {
  return !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY;
}
