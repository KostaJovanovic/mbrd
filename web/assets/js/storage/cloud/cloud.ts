// Cloud provider lookup — one function, loaded on demand. provider.ts
// (shape, table, link grammar) is the cheap half imported statically.
// Not an orchestrator: packing, consent and the strip stay elsewhere.

import { googleDrive } from './google.ts';
import { PROVIDER_IDS } from './provider.ts';

import type { ShareProvider } from './provider.ts';

/**
 * The implementations, by the id that goes in a link.
 *
 * Statically imported, not a table of dynamic imports: this module is already
 * behind one seam, and splitting a single provider across a second buys
 * nothing. Revisit once the table holds several and most are dead weight.
 */
const PROVIDERS: Record<string, ShareProvider> = {
  [googleDrive.id]: googleDrive,
};

/**
 * The provider behind an id, or null.
 *
 * Null covers two cases alike: an id this build has never heard of, and one
 * whose identifiers were never filled in. Both mean "cannot open that link",
 * and both read as a sentence rather than an error.
 */
export function shareProvider(id: string): ShareProvider | null {
  const provider = PROVIDERS[id];
  return provider && provider.configured() ? provider : null;
}

/**
 * Every provider this build could connect to, in the order a panel lists them.
 *
 * Configured ones only - a provider with no identifiers has no button, and a
 * newly configured one gets one with no edit to ui/settings-schema.ts. One
 * that cannot sign in in this shell has none either.
 */
export function cloudProviders(): ShareProvider[] {
  return PROVIDER_IDS.map(id => PROVIDERS[id]).filter(p => !!p && p.configured() && p.canSignIn());
}

/**
 * Whether any account is connected right now.
 *
 * Asked synchronously while the settings panel draws - why ui/settings-schema.ts
 * imports this module statically. Reads the provider's own grant rather than a
 * mirrored flag, so it can never claim connected after the token has expired.
 *
 * False after every reload, truthfully: a browser-only token cannot persist, so
 * a fresh page has no account attached however many boards are filed as synced.
 */
export function anyConnected(): boolean {
  return cloudProviders().some(p => p.signedIn());
}
