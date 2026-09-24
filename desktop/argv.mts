// The boards named on a command line: a double-click, "Open with", or a second
// launch handing its argv to the first. Pure Node with no `app`, like
// format.mts, so the root suite runs it.
// A relative path is resolved against the launch's own folder, never against
// the running copy's, which is somewhere else after a second launch.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The .mbrd files in `argv`, named in full. Flags and the executable are
 *  skipped. A Linux launcher can hand a file:// URL, since the .deb's desktop
 *  entry takes %U, so one is turned back into its path. */
export function boardsIn(argv: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-') || !/\.mbrd$/i.test(arg)) continue;
    if (!/^file:\/\//i.test(arg)) { out.push(resolve(cwd, arg)); continue; }
    try { out.push(fileURLToPath(arg)); } catch { /* not a local file: skipped */ }
  }
  return out;
}
