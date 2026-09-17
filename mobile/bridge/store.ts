// The store half of the Android bridge: desktop/store.ts's eight calls, over
// MbrdStore.java. Values are encoded here with the desktop's own format.mts and
// native keeps the bytes as they come, so a store folder copied from a phone
// reads on the desktop. A value goes down the byte channel and comes back by GET.

import { decode, encode } from '../../desktop/format.mts';
import { fetchBytes, transfer } from './bytes.ts';
import { call } from './native.ts';

export async function get(store: string, key: string): Promise<unknown> {
  const raw = await fetchBytes('store', store, key);
  if (!raw) return undefined;
  try {
    return decode(new Uint8Array(raw));
  } catch (err) {
    // As desktop/store.ts: an unreadable value (a crash mid-write, a hand edit)
    // reads as missing, and says so where somebody can see it.
    console.warn(`[mbrd] a stored value could not be read: ${store}/${key}`, err);
    return undefined;
  }
}

export async function set(store: string, key: string, value: unknown): Promise<void> {
  await transfer({ target: 'store', store, key }, encode(value));
}

export async function del(store: string, key: string): Promise<void> {
  await call('MbrdStore', 'del', { store, key });
}

export async function keys(store: string): Promise<string[]> {
  const r = await call<{ keys?: string[] }>('MbrdStore', 'keys', { store });
  return r.keys ?? [];
}

export async function clear(store: string): Promise<void> {
  await call('MbrdStore', 'clear', { store });
}

export function getMany(store: string, list: string[]): Promise<unknown[]> {
  return Promise.all(list.map(key => get(store, key)));
}

/** One at a time: the channel carries one transfer at once anyway, and this
 * keeps one encoded value in memory rather than the whole batch. */
export async function setMany(store: string, entries: [string, unknown][]): Promise<void> {
  for (const [key, value] of entries) await set(store, key, value);
}

export async function delMany(store: string, list: string[]): Promise<void> {
  await call('MbrdStore', 'delMany', { store, keys: list });
}
