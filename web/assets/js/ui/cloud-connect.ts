// Attaching a cloud account: the one implementation, reachable from two places
// (the Sync section's Connect button and the board switcher's own) so the two
// never disagree about what a sign-in warns you of.
//
// **The dialog is not ceremony, it is what makes the popup open at all.**
// Every browser blocks a window not opened from a live user gesture, and a
// press on this dialog's own button is the freshest gesture there is.

import { toast } from '../notify.ts';
import { ask } from './dialog.ts';
import { paintPanel } from './panel.ts';

/**
 * Say what is about to happen, then open the popup. Resolves to whether an
 * account is attached, true for "already was" too, so a caller can treat it as
 * "is there one now" rather than "did I just make one".
 *
 * Repaints the panel on every path: the Sync section's shape hangs off
 * whether an account is connected, and no bus event covers "signed in".
 */
export async function connectCloud(id: string): Promise<boolean> {
  const { shareProvider } = await import('../storage/cloud/cloud.ts');
  const provider = shareProvider(id);
  if (!provider) { toast('That account is not set up in this build', 'error'); return false; }
  if (provider.signedIn()) { toast(`Already connected to ${provider.label}`); return true; }

  const go = await ask({
    title: `Connect ${provider.label}?`,
    body: `Boards you choose are copied into your own ${provider.label} and kept up to `
      + 'date while this tab is open — never onto a server of ours. Photographs are '
      + 'uploaded once each, so only what changes is sent again. A sign-in window opens '
      + 'next, and the connection lasts until you reload.',
    go: 'Sign in',
    cancel: 'Cancel',
    danger: false,
  });
  if (go !== 'go') return false;
  try {
    await provider.signIn();
    toast(`Connected to ${provider.label}`);
    return true;
  } catch (err) {
    console.error(err);
    // SAFETY: the value came out of a catch and what this app throws is an
    // Error. A thrown string reads `undefined` here rather than throwing, which
    // is the same trade commands/file.ts's why() documents at length.
    toast('Sign-in failed: ' + (err as Error).message, 'error');
    return false;
  } finally {
    paintPanel();
  }
}
