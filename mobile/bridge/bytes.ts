// Bytes between the page and the Android shell, both ways. Page to native is
// FileAnalyser's transfer(): a begin message, chunks of 4 MB at most, an end
// message, and one JSON ack a message from MbrdBytes.java, in order, with DEPTH
// chunks at most in flight and transfers queued. Native to page is a plain GET
// under /__mbrd/, which MbrdWebViewClient.java answers from disk.

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

/** What native answered one message with. A create's "end" adds `name` and `path`. */
export type Ack = Record<string, unknown>;

interface Waiter {
  resolve(ack: Ack): void;
  reject(err: Error): void;
}

/** One waiter a message sent. Native answers in order, so the first is next. */
const acks: Waiter[] = [];
let wired = false;
let queue: Promise<unknown> = Promise.resolve();

function channel(): ByteChannel {
  const ch = window.mbrdBytes;
  if (!ch) throw new Error('the byte channel is missing');
  if (!wired) {
    wired = true;
    ch.addEventListener('message', event => {
      const waiter = acks.shift();
      if (!waiter) return;
      let ack: Ack = {};
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object') {
          // SAFETY: a non-null object, whose fields every reader checks.
          ack = parsed as Ack;
        }
      } catch {
        // A garbled ack is a failed message, which the reject below reports.
      }
      if (ack.ok === true) waiter.resolve(ack);
      else waiter.reject(new Error(typeof ack.error === 'string' ? ack.error : 'the transfer failed'));
    });
  }
  return ch;
}

function send(message: string | ArrayBuffer): Promise<Ack> {
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

/** Chunks sent before the oldest is acknowledged, so reading the next one,
 *  the crossing and native's disk write overlap rather than take turns. */
const DEPTH = 3;

/**
 * Stream `data` to native. `meta` names the target (`store`, `file`, `append`,
 * `create`, `ff` or `stage`) and what it needs, and MbrdBytes.java checks every
 * field of it. Answers the last ack, which is where a create says what it made.
 */
export function transfer(meta: Record<string, string | number>, input: Blob | Uint8Array | ArrayBuffer): Promise<Ack> {
  const data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const run = async () => {
    const size = data instanceof Blob ? data.size : data.byteLength;
    // `op` and `size` last, so no field of meta can stand in for them.
    await send(JSON.stringify({ ...meta, op: 'begin', size }));
    const inFlight: Promise<Ack>[] = [];
    try {
      for (let off = 0; off < size; off += CHUNK) {
        const end = Math.min(size, off + CHUNK);
        const part = data instanceof Blob
          ? new Uint8Array(await data.slice(off, end).arrayBuffer())
          : data.subarray(off, end);
        let sent: Promise<Ack>;
        if (BOOT.arrayBuffers) {
          // postMessage takes an ArrayBuffer, not a view. Copy only a view that
          // covers part of its buffer, or one on shared memory.
          const whole = part.byteOffset === 0 && part.byteLength === part.buffer.byteLength;
          const buffer = part.buffer;
          sent = send(whole && buffer instanceof ArrayBuffer ? buffer : part.slice().buffer);
        } else {
          sent = send(JSON.stringify({ op: 'chunk', b64: toBase64(part) }));
        }
        // Each is awaited in order below. This only keeps the ones behind a
        // failure from being reported as unhandled.
        sent.catch(() => {});
        inFlight.push(sent);
        if (inFlight.length >= DEPTH) await inFlight.shift();
      }
      for (const sent of inFlight) await sent;
      return await send(JSON.stringify({ op: 'end' }));
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

/** The answer native gives at /__mbrd/<segments>, or null when it is 404.
 *  Each segment is encoded here, so a key or a name never becomes a path. */
async function fetchShell(segments: string[]): Promise<Response | null> {
  const path = segments.map(encodeURIComponent).join('/');
  const res = await pageFetch(`/__mbrd/${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the shell answered ${res.status} for /__mbrd/${path}`);
  return res;
}

/** The bytes native serves at /__mbrd/<segments>, or null. */
export async function fetchBytes(...segments: string[]): Promise<ArrayBuffer | null> {
  const res = await fetchShell(segments);
  return res ? res.arrayBuffer() : null;
}

/** fetchBytes() as a Blob, which the WebView keeps out of the page's heap: a
 *  400 MB board fetched as an ArrayBuffer was 400 MB of it. */
export async function fetchBlob(...segments: string[]): Promise<Blob | null> {
  const res = await fetchShell(segments);
  return res ? res.blob() : null;
}
