// Bytes between the page and the Android shell, both ways. Page to native is
// FileAnalyser's transfer(): a begin message, chunks of 4 MB at most, an end
// message, and one JSON ack a message from MbrdBytes.java, so one chunk at most
// is in flight and transfers queue. Native to page is a plain GET under
// /__mbrd/, which MbrdWebViewClient.java answers from disk.

import { BOOT } from './boot.ts';

/** window.mbrdBytes: the WebMessageListener MbrdShell.java registers. */
interface ByteChannel {
  postMessage(message: string | ArrayBuffer): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void;
}

declare global {
  interface Window {
    mbrdBytes?: ByteChannel;
  }
}

export const CHUNK = 4 * 1024 * 1024;

/** Taken at document start, before any page script can replace it. */
export const pageFetch = window.fetch.bind(window);

interface Waiter {
  resolve(): void;
  reject(err: Error): void;
}

/** One waiter a message sent. Native answers in order, so the first is next. */
const acks: Waiter[] = [];
let wired = false;
let queue: Promise<void> = Promise.resolve();

function channel(): ByteChannel {
  const ch = window.mbrdBytes;
  if (!ch) throw new Error('the byte channel is missing');
  if (!wired) {
    wired = true;
    ch.addEventListener('message', event => {
      const waiter = acks.shift();
      if (!waiter) return;
      let ack: { ok?: unknown, error?: unknown } = {};
      try {
        ack = JSON.parse(event.data);
      } catch {
        // A garbled ack is a failed message, which the reject below reports.
      }
      if (ack.ok === true) waiter.resolve();
      else waiter.reject(new Error(typeof ack.error === 'string' ? ack.error : 'the transfer failed'));
    });
  }
  return ch;
}

function send(message: string | ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    acks.push({ resolve, reject });
    try {
      channel().postMessage(message);
    } catch (err) {
      acks.pop();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** For a WebView with no ArrayBuffer messages. 32 KB a step keeps the spread small. */
function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Stream `data` to native. `meta` names the target (`store`, `file`, `ff` or
 * `stage`) and what it needs, and MbrdBytes.java checks every field of it.
 */
export function transfer(meta: Record<string, string>, data: Blob | Uint8Array): Promise<void> {
  const run = async () => {
    const size = data instanceof Blob ? data.size : data.byteLength;
    // `op` and `size` last, so no field of meta can stand in for them.
    await send(JSON.stringify({ ...meta, op: 'begin', size }));
    try {
      for (let off = 0; off < size; off += CHUNK) {
        const end = Math.min(size, off + CHUNK);
        const part = data instanceof Blob
          ? new Uint8Array(await data.slice(off, end).arrayBuffer())
          : data.subarray(off, end);
        if (BOOT.arrayBuffers) {
          // postMessage takes an ArrayBuffer, not a view. Copy only a view that
          // covers part of its buffer, or one on shared memory.
          const whole = part.byteOffset === 0 && part.byteLength === part.buffer.byteLength;
          const buffer = part.buffer;
          await send(whole && buffer instanceof ArrayBuffer ? buffer : part.slice().buffer);
        } else {
          await send(JSON.stringify({ op: 'chunk', b64: toBase64(part) }));
        }
      }
      await send(JSON.stringify({ op: 'end' }));
    } catch (err) {
      try {
        await send(JSON.stringify({ op: 'abort' }));
      } catch {
        // Native resets on the next begin anyway.
      }
      throw err;
    }
  };
  const done = queue.then(run, run);
  queue = done.catch(() => {});
  return done;
}

/**
 * The bytes native serves at /__mbrd/<segments>, or null when it answers 404.
 * Each segment is encoded here, so a key or a name never becomes a path.
 */
export async function fetchBytes(...segments: string[]): Promise<ArrayBuffer | null> {
  const path = segments.map(encodeURIComponent).join('/');
  const res = await pageFetch(`/__mbrd/${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the shell answered ${res.status} for /__mbrd/${path}`);
  return res.arrayBuffer();
}
