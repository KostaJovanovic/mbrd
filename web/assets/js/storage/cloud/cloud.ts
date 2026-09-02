// The door onto the providers: one function to look one up, and nothing else.
//
// This directory is `cloud/` rather than `share/`, and the rename happened the
// moment a second feature wanted the same account. Sharing a link and keeping a
// board in sync are two things to do with one Google Drive sign-in - the same
// OAuth flow, the same token, the same registered application, the same host in
// connect-src - and a directory named for the first of them would have read as a
// claim that the second was a guest in it. The provider is the tenant here; what
// is done with it is not.
//
// Loaded on demand, which is the whole reason it is a file. `provider.ts` is the
// cheap half - the shape, the table and the link grammar, imported statically by
// ui/settings-schema.ts so the panel can decide whether to draw a row - and this
// is the half that pulls in an implementation.
//
// **Not a download saving, and the header of config.ts says why**: the build is
// one esbuild invocation with no splitting, so this module's bytes are in
// web/assets/app.js whatever the specifier looks like. What the seam buys is the
// module graph - the settings schema does not sit on top of the OAuth flow - and
// that none of it is evaluated on the overwhelming majority of boots, where
// nobody shares anything and no link is followed.
//
// It stays a lookup rather than becoming an orchestrator, and that boundary is
// deliberate. Packing a board is storage/storage.ts's business, asking whether
// to include the history is the command's, and putting a strip on the screen is
// notify.ts's; a module that did all three would be the fourth place in this app
// that knows how to write a .mbrd. What it owns is the sentence "which provider
// is `gdrive`".
//
// **The picker the plan asked for is not here, and that is the plan's own
// answer.** Choosing one of three is a menu, and ui/menu.ts renders every menu
// in the app - a second implementation is the thing CLAUDE.md forbids by name.
// With one provider there is nothing to choose, and a menu with one row is worse
// than no menu. The moment OneDrive lands, the picker is one `openAnchored()`
// call over `PROVIDER_IDS` and this file does not change.

import { googleDrive } from './google.ts';
import { PROVIDER_IDS } from './provider.ts';

import type { ShareProvider } from './provider.ts';

/**
 * The implementations, by the id that goes in a link.
 *
 * Statically imported rather than a table of dynamic imports, because this
 * module is *already* behind one: whoever reached here has decided to share or
 * to open a share, and splitting one provider across a second boundary would buy
 * nothing and cost a second failure mode. When the table has three entries and
 * two of them are dead weight for most people, that calculation changes.
 */
const PROVIDERS: Record<string, ShareProvider> = {
  [googleDrive.id]: googleDrive,
};

/**
 * The provider behind an id, or null.
 *
 * Null covers two different things on purpose: an id this build has never heard
 * of - an older app meeting a newer link - and one whose identifiers were never
 * filled in. Both mean the same thing to a caller, which is that this app cannot
 * do anything with that link, and both should read as a sentence rather than as
 * an error. See the header of config.ts for the second.
 */
export function shareProvider(id: string): ShareProvider | null {
  const provider = PROVIDERS[id];
  return provider && provider.configured() ? provider : null;
}

/**
 * Every provider this build could connect to, in the order a panel lists them.
 *
 * Configured ones only, which is what makes the Sync section's Connect rows
 * write themselves: a provider with no identifiers has no button, and the day
 * OneDrive's module and its two strings land, its button appears with no edit to
 * ui/settings-schema.ts at all.
 */
export function cloudProviders(): ShareProvider[] {
  return PROVIDER_IDS.map(id => PROVIDERS[id]).filter(p => !!p && p.configured());
}

/**
 * Whether any account is connected right now.
 *
 * Asked by the settings panel, synchronously, while it is drawing - which is the
 * reason ui/settings-schema.ts imports this module statically rather than
 * through the dynamic seam everything else uses. The alternative was a mirror of
 * "is a token live", and a token's liveness is exactly the kind of fact that must
 * not have two sources: the provider holds the grant and knows when it expires,
 * and a copy of that answer elsewhere would go stale in the direction that
 * matters - claiming connected after the hour is up.
 *
 * False after every reload, and that is the truth rather than a limitation. A
 * browser-only token cannot be persisted safely, so a page that has just loaded
 * genuinely has no account attached, however many boards are filed as synced.
 * The section says so by offering Connect again.
 */
export function anyConnected(): boolean {
  return cloudProviders().some(p => p.signedIn());
}
