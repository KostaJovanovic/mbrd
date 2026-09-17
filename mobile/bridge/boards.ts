// The boards half of the Android bridge: desktop/boards.ts's five calls, over
// MbrdBoards.java. A new board's bytes go down the byte channel (target
// "create"), and native names the file once they are all there, so the name
// arrives in the last ack rather than from a plugin call.

import type { FolderBoard } from '../../web/assets/js/platform/platform.ts';
import { transfer } from './bytes.ts';
import { call } from './native.ts';

interface Ref {
  name: string;
  path: string;
}

const refOf = (r: { name?: unknown, path?: unknown }): Ref | null =>
  typeof r.name === 'string' && typeof r.path === 'string' && r.path ? { name: r.name, path: r.path } : null;

export async function list(): Promise<{ folder: string, files: FolderBoard[] }> {
  const r = await call<{ folder?: unknown, files?: { name?: unknown, path?: unknown, at?: unknown }[] }>('MbrdBoards', 'list');
  if (typeof r.folder !== 'string') throw new Error('the shell named no boards folder');
  const files: FolderBoard[] = [];
  for (const f of r.files ?? []) {
    const ref = refOf(f);
    if (ref) files.push({ ...ref, at: typeof f.at === 'number' ? f.at : 0 });
  }
  return { folder: r.folder, files };
}

export async function create(suggested: string, data: ArrayBuffer | Blob): Promise<Ref> {
  const ref = refOf(await transfer({ target: 'create', suggested }, data));
  if (!ref) throw new Error('the shell did not say where the board went');
  return ref;
}

/** Null for a board outside the folder, which keeps its name. */
export async function rename(path: string, suggested: string): Promise<Ref | null> {
  return refOf(await call<{ name?: unknown, path?: unknown }>('MbrdBoards', 'rename', { path, suggested }));
}

export async function trash(path: string): Promise<void> {
  await call('MbrdBoards', 'trash', { path });
}

export async function reveal(): Promise<void> {
  await call('MbrdBoards', 'reveal');
}
