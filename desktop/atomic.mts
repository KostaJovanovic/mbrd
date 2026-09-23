// A file replaced whole or not at all: a temp file beside the target, flushed
// to the disk, then renamed over it. Without the flush a power loss can keep
// the rename and lose the bytes, and the only copy of a board opens as zeros.
// Pure Node with no `app`, like format.mts, so the root suite runs it.

import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Write `data` to `tmp`, flush it, and rename it over `target`. `durable`
 *  also flushes the folder, so the rename itself outlives a power loss. */
export async function writeAtomic(
  target: string, data: Uint8Array | string, tmp: string, durable = false,
): Promise<void> {
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  if (durable) await syncFolder(dirname(target));
}

/** Windows cannot open a folder for a flush, and NTFS journals the rename. */
async function syncFolder(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // A file system that refuses a folder flush still has the file flushed.
  } finally {
    await handle?.close();
  }
}
