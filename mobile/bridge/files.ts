// The files half of the Android bridge: desktop/files.ts's six calls, over
// MbrdFiles.java. Native picks, copies and checks every path (the vouch rule),
// and hands a file over as a token this side fetches from /__mbrd/file/, so
// HandedFile.data arrives as a Blob, never as the file in the page's heap.

import type { HandedFile } from '../../web/assets/js/platform/electron.ts';
import { fetchBlob, fetchBytes, transfer } from './bytes.ts';
import { call } from './native.ts';

/** A file native picked or vouched for, not read yet. */
export interface Picked {
  name: string;
  path: string;
  token: string;
}

/** The file's bytes, by its token. Each token serves once. */
export async function hand(file: Picked): Promise<HandedFile> {
  const data = await fetchBlob('file', file.token);
  if (!data) throw new Error(`${file.name} could not be read`);
  return { name: file.name, path: file.path, data };
}

export async function pickOpen(): Promise<HandedFile | null> {
  const r = await call<{ file?: Picked }>('MbrdFiles', 'pickOpen');
  return r.file ? hand(r.file) : null;
}

export async function pickSave(suggested: string): Promise<{ name: string, path: string } | null> {
  const r = await call<{ name?: string, path?: string }>('MbrdFiles', 'pickSave', { suggested });
  return r.name && r.path ? { name: r.name, path: r.path } : null;
}

/** One file after another, so a dozen clips are not all in flight at once. */
export async function pickImport(): Promise<HandedFile[]> {
  const r = await call<{ files?: Picked[] }>('MbrdFiles', 'pickImport');
  const out: HandedFile[] = [];
  for (const file of r.files ?? []) out.push(await hand(file));
  return out;
}

export async function write(path: string, data: ArrayBuffer | Blob): Promise<void> {
  await transfer({ target: 'file', path }, data);
}

/** A save's tail onto a file `at` bytes long, as desktop/files.ts's append(). */
export async function append(path: string, data: ArrayBuffer | Blob, at: number): Promise<void> {
  await transfer({ target: 'append', path, at }, data);
}

/** A board's size and its last `length` bytes, which hold its ZIP directory
 *  (desktop/files.ts's tail()). */
export async function tail(path: string, length: number): Promise<{ size: number, data: ArrayBuffer }> {
  const r = await call<{ size?: unknown, token?: unknown }>('MbrdFiles', 'tail', { path, length });
  if (typeof r.size !== 'number' || typeof r.token !== 'string') throw new Error('the shell handed back no file');
  const data = await fetchBytes('file', r.token);
  if (!data) throw new Error('the board could not be read');
  // Served to the end of the file, which may have grown since it was measured.
  return { size: r.size, data: data.slice(0, Math.min(length, r.size)) };
}

export async function read(path: string): Promise<HandedFile> {
  const r = await call<{ file?: Picked }>('MbrdFiles', 'read', { path });
  if (!r.file) throw new Error('the shell handed back no file');
  return hand(r.file);
}

export async function exists(path: string): Promise<boolean> {
  const r = await call<{ exists?: boolean }>('MbrdFiles', 'exists', { path });
  return r.exists === true;
}
