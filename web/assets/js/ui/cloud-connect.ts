// Attaching a cloud account: the one implementation, reachable from two places.
//
// It lived in commands/file.ts, as a helper for the Sync section's Connect
// button, and moved the day the board switcher grew a Connect button of its own
// in its foot. Two callers is the moment a helper stops being a helper: the
// alternative was ui/library.ts importing commands/file.ts - which is a cycle,
// since commands.ts imports openLibrary() - or writing the dialog a second time,
// which is how the two copies start disagreeing about what a sign-in warns you
// of.
//
// It sits in ui/ rather than beside the provider because what it mostly is, is a
// question asked of a person. The network part is one call.
//
// **The dialog is not ceremony, it is what makes the popup open at all.** Every
// browser blocks a window that is not opened from a live user gesture, and a
// press on this dialog's own button is the freshest gesture there is. It also
// happens to be the honest interface - somebody else's login page appearing
// unannounced over a board is a worse surprise than a sentence saying it is
// about to.

import { toast } from '../notify.ts';
import { ask } from './dialog.ts';
import { paintPanel } from './panel.ts';

/**
 * Say what is about to happen, then open the popup. Answers whether an account
 * is attached when it returns - which is true for "already was", so a caller
 * can treat it as "is there one now" rather than "did I just make one".
 *
 * The panel is repainted on every path because the Sync section's whole shape
 * hangs off whether an account is connected, and paintPanel() listens for four
 * bus events of which none is "somebody signed in".
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
