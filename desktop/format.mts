// How a stored value becomes a file, and back.
//
// Split out of store.ts so it can be tested without Electron. Everything here
// is pure - bytes in, bytes out, no filesystem and no `app` - which is what
// lets tests/desktop-store-format.test.js run it in the root suite with
// nothing installed.
//
// The `.mts` extension is that last part. Node reads a bare `.ts` under a
// package with no `"type"` field by guessing, and warns on every run of the
// suite that it had to; `desktop/package.json` cannot say `"type": "module"`
// because Electron loads `dist/main.js` as CommonJS. The extension says it per
// file instead, which is the only one of the three that costs nothing.
//
// One file per key, always: a JSON envelope, a newline, then the raw bytes of
// every Blob the value held, concatenated.
//
//     {"v":1,"value":{"blob":{"__bytes":1,"at":0,"len":8241,"mime":"image/png"}}}\n
//     <8241 bytes>
//
// **JSON on its own is not enough, and finding out why cost a run of the app.**
// A Blob does not survive JSON.stringify - it becomes `{}` - so the obvious
// implementation writes `{"blob":{},"ext":"png"}` and every picture on a
// restored board comes back empty. Nothing throws. The renderer reports "N
// items came back without their data", which reads like a corrupt store rather
// than a bug in the writer.
//
// So the bytes are kept out of the JSON and the JSON keeps an offset. The
// envelope can hold no raw newline - JSON escapes them inside strings - so the
// first `\n` is unambiguously the end of it.
//
// Base64 was the other option and is worse in the one place it matters: a
// twenty-megabyte clip becomes a twenty-seven-megabyte string that has to be
// encoded on the way in and decoded on the way out, on the thread that is
// trying to save a board.

/**
 * What crosses the bridge in place of a Blob.
 *
 * The same shape platform/electron.ts builds and reads, written twice because
 * the two live in packages with different tsconfigs - see the note over
 * `Bridge` there. `mime` travels because storage/assets.ts renders an asset by
 * its blob's own type: a Blob that came back as application/octet-stream turns
 * every picture on a restored board into a download prompt.
 */
export interface Bytes {
  __bytes: true;
  data: ArrayBuffer;
  mime?: string;
}

// SAFETY: as isPlaced() below - the truthy-object guard is first, so the
// property read is off an object, and the tag is compared rather than trusted.
const isBytes = (v: unknown): v is Bytes =>
  !!v && typeof v === 'object' && (v as Bytes).__bytes === true;

const ENVELOPE_VERSION = 1;

/** A Blob's bytes, lifted out of the JSON and described by where they landed. */
interface Placed {
  __bytes: 1;
  at: number;
  len: number;
  mime?: string;
}

// SAFETY: the three tests on these two lines are the check. The truthy-object
// guard comes first, so every property read below is off an object, and each
// field is compared rather than trusted - a value that is not a placement
// compares false rather than throwing.
const isPlaced = (v: unknown): v is Placed =>
  !!v && typeof v === 'object' && (v as Placed).__bytes === 1
  && typeof (v as Placed).at === 'number' && typeof (v as Placed).len === 'number';

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Pull every Bytes out of the value, replacing each with its placement. */
export function encode(value: unknown): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  const walk = (v: unknown): unknown => {
    if (isBytes(v)) {
      const buf = Buffer.from(v.data);
      const placed: Placed = { __bytes: 1, at, len: buf.length };
      if (v.mime) placed.mime = v.mime;
      parts.push(buf);
      at += buf.length;
      return placed;
    }
    if (Array.isArray(v)) return v.map(walk);
    // Only a literal is walked. A Date or a Map rebuilt field by field would
    // come back as something else; nothing in this store holds one, and the
    // check is what keeps that true rather than assumed.
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(v)) out[key] = walk(inner);
      return out;
    }
    return v;
  };
  const envelope = JSON.stringify({ v: ENVELOPE_VERSION, value: walk(value) ?? null });
  return Buffer.concat([Buffer.from(envelope + '\n', 'utf8'), ...parts]);
}

/** Put them back. Every slice is checked against the file's real length. */
export function decode(raw: Buffer): unknown {
  const split = raw.indexOf(0x0a);
  if (split < 0) throw new Error('no envelope');
  const head = JSON.parse(raw.subarray(0, split).toString('utf8'));
  if (!head || head.v !== ENVELOPE_VERSION) throw new Error('unknown store format');
  const body = raw.subarray(split + 1);

  const walk = (v: unknown): unknown => {
    if (isPlaced(v)) {
      // Bounds-checked, because this file was written by some build of this app
      // and may have been truncated by the crash it exists to recover from. A
      // slice past the end is silently short in Node, which would hand the
      // renderer a Blob of the wrong size rather than an error.
      if (v.at < 0 || v.len < 0 || v.at + v.len > body.length) {
        throw new Error(`bytes at ${v.at}+${v.len} are past the end of a ${body.length}-byte value`);
      }
      // A copy rather than a view: Buffer is a window onto a pooled allocation,
      // and handing `.buffer` across the bridge would hand over whatever else
      // Node happened to have in that pool. `new ArrayBuffer` + set rather than
      // `.slice`, because Node types `Buffer.buffer` as possibly shared.
      const slice = body.subarray(v.at, v.at + v.len);
      const data = new ArrayBuffer(slice.byteLength);
      new Uint8Array(data).set(slice);
      const out: Bytes = { __bytes: true, data };
      if (v.mime) out.mime = v.mime;
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(v)) out[key] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(head.value);
}

