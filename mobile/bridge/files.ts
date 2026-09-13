// The files half of the Android bridge: desktop/files.ts's six calls, over
// MbrdFiles.java. Native picks, copies and checks every path (the vouch rule),
// and hands a file over as a token this side fetches from /__mbrd/file/, so
// HandedFile.data arrives as the ArrayBuffer platform/electron.ts expects.

import type { HandedFile } from '../../web/assets/js/platform/electron.ts';
import { fetchBytes, transfer } from './bytes.ts';
import { call } from './native.ts';

/** A file native picked or vouched for, not read yet. */
export interface Picked {
  name: string;
  path: string;
  token: string;
}

/** The file's bytes, by its token. Each token serves once. */
export async function hand(file: Picked): Promise<HandedFile> {
  const data = await fetchBytes('file', file.token);
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

export function write(path: string, data: ArrayBuffer): Promise<void> {
  return transfer({ target: 'file', path }, new Uint8Array(data));
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
