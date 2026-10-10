// Audio metadata: cover art, tags, and stream duration.
// Parses ID3v2 (.mp3), MP4 atom tree (.m4a/.mp4), and FLAC metadata blocks.
// All reads go through Blob.slice() - never pulls the whole file into memory.
// Every path returns null on failure; a card with no cover is the normal case.

import { extOf } from '../util.ts';
import { ascii, be24, be32, bytes, syncsafe } from '../bytes.ts';
import type { Bytes } from '../bytes.ts';
import { oversize, isOversize, mb } from '../consent.ts';

/** A Vorbis-comment pair: `['ARTIST', 'Talk Talk']`. */
export type TagPair = [string, string];

/** Picture types a browser will draw. */
type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Payload bounds of one MP4 atom. */
type AtomRange = { start: number, end: number };

// Liftable ceiling - a cover past this is offered, not refused.
const MAX_ART = 12 * 1024 * 1024;

// Safety limit: tag size is a foreign claim and desync() may double the allocation.
const MAX_ID3_BYTES = MAX_ART + 256 * 1024;

// Measurement half of the cover warning; risk half is in consent.ts.
const artTooBig = (n: number) =>
  `The artwork inside this track is ${mb(n)}, past the ${mb(MAX_ART)} a cover is taken at.`;

// Runaway guard for atom/block walks.
const MAX_ATOMS = 4096;

/** Extract the embedded cover art as a File, or null. */
export async function coverArt(file: Blob, lift = false): Promise<File | null> {
  try {
    const head = await bytes(file, 0, 16);
    const data = isID3(head) ? await id3Art(file, head, lift)
               : isFLAC(head) ? await flacArt(file, lift)
               : isMP4(head) ? await mp4Art(file, lift)
               : null;
    if (!data || !data.length) return null;
    if (!lift && data.length > MAX_ART) throw oversize('cover-art', artTooBig(data.length));
    // Sniff the bytes - tag MIME types are unreliable, and we need to know
    // the browser will actually draw it.
    const type = sniff(data);
    if (!type) return null;
    return new File([data], 'cover.' + extFor(type), { type });
  } catch (err) {
    // Oversize is the one thing that propagates - everything else is a shrug.
    if (isOversize(err)) throw err;
    return null;
  }
}

/** Quick check before reading: can this extension carry art? */
export const mayHaveArt = (name: string) =>
  ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'alac', 'flac'].includes(extOf(name));

/** Tags as Vorbis pairs - Vorbis keys because Opus writes Vorbis comment headers. */
export async function audioTags(file: Blob): Promise<TagPair[]> {
  try {
    const head = await bytes(file, 0, 16);
    const pairs = isID3(head) ? await id3Tags(file, head)
                : isFLAC(head) ? await flacTags(file)
                : isMP4(head) ? await mp4Tags(file)
                : null;
    return clean(pairs);
  } catch {
    return [];
  }
}

// Lyrics live in tag fields too - cap values to something sane.
const MAX_TAG = 400;

// Drop empty, trim long, deduplicate by key.
function clean(pairs: TagPair[] | null): TagPair[] {
  const seen = new Set<string>();
  const out: TagPair[] = [];
  for (const [key, value] of pairs || []) {
    const k = String(key || '').toUpperCase();
    // '=' is the Vorbis separator; keys must be ASCII printable per spec.
    if (!/^[A-Z0-9_-]{1,32}$/.test(k) || seen.has(k)) continue;
    const v = String(value || '').replace(/\0/g, '').trim().slice(0, MAX_TAG);
    if (!v) continue;
    seen.add(k);
    out.push([k, v]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Identify picture format by magic bytes.
function sniff(b: Bytes): ImageType | '' {
  if (b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image/png';
  if (ascii(b, 0, 3) === 'GIF') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return '';
}

const extFor = (type: ImageType) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
}[type]);

// ---------------------------------------------------------------------------
// ID3v2  -  .mp3
// ---------------------------------------------------------------------------

const isID3 = (h: Bytes) => h.length >= 10 && ascii(h, 0, 3) === 'ID3' && h[3] < 5;

// Read the whole ID3v2 tag and undo unsynchronisation if flagged.
async function id3Body(file: Blob, head: Bytes, lift = false): Promise<Bytes | null> {
  const size = syncsafe(head, 6);
  if (size <= 0) return null;
  // Cap before reading: size is a foreign claim, and desync() may double it.
  if (!lift && size > MAX_ID3_BYTES) throw oversize('cover-art', artTooBig(size));
  const footer = (head[5] & 0x10) ? 10 : 0;
  const tag = await bytes(file, 10, size + footer);
  // Tag-level unsync: 0x00 padding after every 0xFF, applied to frames and sizes.
  return (head[5] & 0x80) ? desync(tag) : tag;
}

// Walk ID3 frames. v2.2: 3-char id + 3-byte size; v2.3: 4-char + BE32;
// v2.4: 4-char + synchsafe (but v2.3-sized v2.4 files are common, so fallback).
function eachID3Frame(
  tag: Bytes,
  major: number,
  visit: (id: string, body: Bytes) => boolean | void,
) {
  const idLen = major <= 2 ? 3 : 4;
  const headLen = major <= 2 ? 6 : 10;

  let at = 0;
  while (at + headLen <= tag.length) {
    const id = ascii(tag, at, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;          // padding, or the end of the frames
    let len = major <= 2 ? be24(tag, at + 3)
            : major === 4 ? syncsafe(tag, at + 4)
            : be32(tag, at + 4);
    // Fallback: v2.4 file with v2.3-style plain sizes.
    if (major === 4 && at + headLen + len > tag.length) {
      const plain = be32(tag, at + 4);
      if (at + headLen + plain <= tag.length) len = plain;
    }
    if (len <= 0 || at + headLen + len > tag.length) break;
    let start = at + headLen;
    const end = start + len;
    let body: Bytes | null = null;
    if (major >= 3) {
      const flags = tag[at + headLen - 1];
      // Data-length indicator: 4 extra bytes before body.
      if (major === 4 && (flags & 0x01)) start += 4;
      // Per-frame unsync (v2.4 replacement for tag-wide flag).
      if (major === 4 && (flags & 0x02)) body = desync(tag.subarray(start, end));
    }
    if (visit(id, body || tag.subarray(start, end)) === false) return;
    at = end;
  }
}

// Extract the APIC/PIC picture frame.
async function id3Art(file: Blob, head: Bytes, lift = false): Promise<Bytes | null> {
  const tag = await id3Body(file, head, lift);
  if (!tag) return null;
  const major = head[3];
  const want = major <= 2 ? 'PIC' : 'APIC';
  let art: Bytes | null = null;
  eachID3Frame(tag, major, (id, body) => {
    if (id !== want) return;
    art = readAPIC(body, major);
    return false;
  });
  return art;
}

// ID3 text frame ids mapped to Vorbis keys. Both v2.2 (3-char) and v2.3+ (4-char).
const ID3_TAGS: Record<string, string> = {
  TIT2: 'TITLE', TT2: 'TITLE',
  TPE1: 'ARTIST', TP1: 'ARTIST',
  TPE2: 'ALBUMARTIST', TP2: 'ALBUMARTIST',
  TALB: 'ALBUM', TAL: 'ALBUM',
  TRCK: 'TRACKNUMBER', TRK: 'TRACKNUMBER',
  TPOS: 'DISCNUMBER', TPA: 'DISCNUMBER',
  TCON: 'GENRE', TCO: 'GENRE',
  TCOM: 'COMPOSER', TCM: 'COMPOSER',
  TDRC: 'DATE', TYER: 'DATE', TYE: 'DATE',
};

async function id3Tags(file: Blob, head: Bytes): Promise<TagPair[]> {
  // Oversized tag → no tags (not worth asking about for just a title).
  const tag = await id3Body(file, head).catch(err => {
    if (isOversize(err)) return null;
    throw err;
  });
  if (!tag) return [];
  const major = head[3];
  const out: TagPair[] = [];
  eachID3Frame(tag, major, (id, body) => {
    const key = ID3_TAGS[id];
    if (key) out.push([key, id3Text(body)]);
  });
  return out;
}

// Decode an ID3 text frame. Encoding byte: 0=latin1, 1=UTF-16+BOM, 2=UTF-16BE, 3=UTF-8.
function id3Text(body: Bytes): string {
  if (!body || body.length < 2) return '';
  const enc = body[0];
  let raw = body.subarray(1);
  let label = 'windows-1252';
  if (enc === 3) label = 'utf-8';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 1) {
    const be = raw[0] === 0xfe && raw[1] === 0xff;
    label = be ? 'utf-16be' : 'utf-16le';
    if (be || (raw[0] === 0xff && raw[1] === 0xfe)) raw = raw.subarray(2);
  }
  try {
    // Multiple null-separated values; take the first.
    return new TextDecoder(label).decode(raw).split('\0')[0];
  } catch {
    return '';
  }
}

// Undo unsync: strip the 0x00 padding after every 0xFF.
function desync(b: Bytes): Bytes {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

// Parse APIC/PIC body → picture bytes. Description is null-terminated in its
// own encoding, so UTF-16 needs a 0x0000 pair (can't use indexOf).
function readAPIC(b: Bytes, major: number): Bytes | null {
  if (b.length < 4) return null;
  const enc = b[0];
  // v2.2: 3-char format ('JPG'); v2.3+: null-terminated MIME string.
  let at = 5;                                 // v2.2: enc(1) + format(3) + type(1)
  if (major > 2) {
    const end = b.indexOf(0, 1);
    if (end < 0) return null;
    at = end + 2;                             // the MIME null, then the picture type
  }
  const wide = enc === 1 || enc === 2;        // UTF-16, with or without a BOM
  while (at < b.length) {
    if (!wide) { if (b[at++] === 0) break; continue; }
    if (b[at] === 0 && b[at + 1] === 0) { at += 2; break; }
    at += 2;
  }
  if (at >= b.length) return null;
  return b.subarray(at);
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

const isFLAC = (h: Bytes) => ascii(h, 0, 4) === 'fLaC';

// FLAC METADATA_BLOCK_PICTURE (type 6). Walk 4-byte block headers until found.
async function flacArt(file: Blob, lift = false): Promise<Bytes | null> {
  let at = 4;
  for (let n = 0; n < MAX_ATOMS; n++) {
    const head = await bytes(file, at, 4);
    if (head.length < 4) return null;
    const last = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const len = be24(head, 1);
    if (type === 6) {
      // +4096 accounts for the block's own header fields around the picture.
      if (!lift && len > MAX_ART + 4096) throw oversize('cover-art', artTooBig(len));
      const b = await bytes(file, at + 4, len);
      return readFlacPicture(b);
    }
    if (last) return null;
    at += 4 + len;
  }
  return null;
}

// FLAC VORBIS_COMMENT (type 4) - already Vorbis pairs, no translation needed.
async function flacTags(file: Blob): Promise<TagPair[]> {
  let at = 4;
  for (let n = 0; n < MAX_ATOMS; n++) {
    const head = await bytes(file, at, 4);
    if (head.length < 4) return [];
    const last = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const len = be24(head, 1);
    if (type === 4) return readVorbis(await bytes(file, at + 4, Math.min(len, MAX_COMMENT)));
    if (last) return [];
    at += 4 + len;
  }
  return [];
}

// Cap for comment blocks (lyrics can be very long).
const MAX_COMMENT = 256 * 1024;

// Vorbis comment block: vendor string, count, `KEY=value` strings. Little-endian.
function readVorbis(b: Bytes): TagPair[] {
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const dec = new TextDecoder();
  const out: TagPair[] = [];
  let at = 0;
  if (b.length < 8) return out;
  at += 4 + le32(at);                           // the vendor string, stepped over
  if (at + 4 > b.length) return out;
  const count = le32(at); at += 4;
  for (let i = 0; i < count && at + 4 <= b.length; i++) {
    const len = le32(at); at += 4;
    if (len > b.length - at) break;
    const s = dec.decode(b.subarray(at, at + len)); at += len;
    const eq = s.indexOf('=');
    if (eq > 0) out.push([s.slice(0, eq), s.slice(eq + 1)]);
  }
  return out;
}

function readFlacPicture(b: Bytes): Bytes | null {
  // type(4) | mimeLen(4) mime | descLen(4) desc | w h depth colours (16) | len(4) data
  let at = 4;
  at += 4 + be32(b, at);                      // the MIME string, stepped over
  at += 4 + be32(b, at);                      // the description
  at += 16;                                   // width, height, depth, colours
  const dataLen = be32(b, at); at += 4;
  if (at + dataLen > b.length) return null;
  return b.subarray(at, at + dataLen);
}

// ---------------------------------------------------------------------------
// MP4  -  .m4a and friends
// ---------------------------------------------------------------------------

const isMP4 = (h: Bytes) => h.length >= 12 && ascii(h, 4, 4) === 'ftyp';

// Walk moov/udta/meta/ilst/covr/data via slice(), never reading the whole file.
// 'meta' has 4 extra version+flags bytes before its children.
async function mp4Art(file: Blob, lift = false): Promise<Bytes | null> {
  const moov = await findAtom(file, 0, file.size, 'moov');
  if (!moov) return null;
  const udta = await findAtom(file, moov.start, moov.end, 'udta');
  if (!udta) return null;
  const meta = await findAtom(file, udta.start, udta.end, 'meta');
  if (!meta) return null;
  const ilst = await findAtom(file, meta.start + 4, meta.end, 'ilst');
  if (!ilst) return null;
  const covr = await findAtom(file, ilst.start, ilst.end, 'covr');
  if (!covr) return null;
  const data = await findAtom(file, covr.start, covr.end, 'data');
  if (!data) return null;
  // data: version+flags(4) + reserved(4) + picture. iTunes type byte ignored.
  const len = data.end - data.start - 8;
  if (len <= 0) return null;
  if (!lift && len > MAX_ART) throw oversize('cover-art', artTooBig(len));
  return await bytes(file, data.start + 8, len);
}

// iTunes atom names → Vorbis keys. 0xA9 prefix = © sign; ascii() reads bytes.
const MP4_TAGS: Record<string, string> = {
  '\xa9nam': 'TITLE',
  '\xa9ART': 'ARTIST',
  aART: 'ALBUMARTIST',
  '\xa9alb': 'ALBUM',
  '\xa9day': 'DATE',
  '\xa9gen': 'GENRE',
  '\xa9wrt': 'COMPOSER',
};

// Read ilst fields by name lookup, reusing findAtom().
async function mp4Tags(file: Blob): Promise<TagPair[]> {
  const moov = await findAtom(file, 0, file.size, 'moov');
  if (!moov) return [];
  const udta = await findAtom(file, moov.start, moov.end, 'udta');
  if (!udta) return [];
  const meta = await findAtom(file, udta.start, udta.end, 'meta');
  if (!meta) return [];
  const ilst = await findAtom(file, meta.start + 4, meta.end, 'ilst');
  if (!ilst) return [];

  const out: TagPair[] = [];
  for (const [name, key] of Object.entries(MP4_TAGS)) {
    const value = await mp4Value(file, ilst, name);
    if (value) out.push([key, new TextDecoder().decode(value)]);
  }
  // 'trkn' is binary, not a string: reserved(2) + track(u16) + total(u16).
  const trkn = await mp4Value(file, ilst, 'trkn');
  if (trkn && trkn.length >= 4) {
    const n = (trkn[2] << 8) | trkn[3];
    if (n) out.push(['TRACKNUMBER', String(n)]);
  }
  return out;
}

// Payload of one named field's 'data' atom, capped.
async function mp4Value(file: Blob, ilst: AtomRange, name: string): Promise<Bytes | null> {
  const box = await findAtom(file, ilst.start, ilst.end, name);
  if (!box) return null;
  const data = await findAtom(file, box.start, box.end, 'data');
  if (!data) return null;
  // version+flags(4) + reserved(4), same as 'covr'.
  const len = Math.min(data.end - data.start - 8, MAX_TAG * 4);
  if (len <= 0) return null;
  return await bytes(file, data.start + 8, len);
}

// Find the first sibling atom named `type` between two offsets.
async function findAtom(file: Blob, from: number, to: number, type: string): Promise<AtomRange | null> {
  let at = from;
  for (let n = 0; n < MAX_ATOMS && at + 8 <= to; n++) {
    const head = await bytes(file, at, 16);
    if (head.length < 8) return null;
    let size = be32(head, 0);
    let headLen = 8;
    // size 1 → 64-bit extended size follows the name.
    if (size === 1) {
      if (head.length < 16) return null;
      const hi = be32(head, 8);
      if (hi > 0x1fffff) return null;
      size = hi * 2 ** 32 + be32(head, 12);
      headLen = 16;
    } else if (size === 0) {
      size = to - at;             // "to the end of the enclosing atom"
    }
    if (size < headLen || at + size > to) return null;
    if (ascii(head, 4, 4) === type) return { start: at + headLen, end: at + size };
    at += size;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ADTS  -  raw .aac, the one file here that is not a container at all
// ---------------------------------------------------------------------------

// Samples per ADTS block. Same for HE-AAC (SBR doubles both rate and samples).
const ADTS_BLOCK = 1024;

// ADTS sampling rate table (4-bit index).
const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000,
  22050, 16000, 12000, 11025, 8000, 7350,
];

// Fixed ADTS header size.
const ADTS_HEAD = 7;

// Read window for the header-hopping scan.
const SCAN_CHUNK = 256 * 1024;

// Floor: 8 chained frames rules out coincidence. Ceiling: ~13h runaway guard.
const MIN_FRAMES = 8;
const MAX_FRAMES = 2_000_000;

// Duration of a raw .aac (ADTS) stream by hopping frame headers.
// Needed because HTMLMediaElement.duration is a VBR guess for containerless AAC
// (Firefox once reported 90 min as 7000 min). Returns null for non-ADTS files.
export async function streamDuration(file: Blob): Promise<number | null> {
  try {
    const head = await bytes(file, 0, 16);
    if (head.length < 16 || isMP4(head) || isFLAC(head)) return null;
    // Skip leading ID3 tag if present.
    let at = isID3(head) ? 10 + syncsafe(head, 6) + ((head[5] & 0x10) ? 10 : 0) : 0;
    let base = at;
    let chunk = await bytes(file, base, SCAN_CHUNK);
    let seconds = 0;
    let frames = 0;
    let ended = false;
    while (frames < MAX_FRAMES) {
      // Re-read from the frame offset so headers straddling chunk boundary aren't split.
      if (at + ADTS_HEAD > base + chunk.length) {
        base = at;
        chunk = await bytes(file, base, SCAN_CHUNK);
        if (chunk.length < ADTS_HEAD) { ended = true; break; }
      }
      const i = at - base;
      // 12 sync bits + layer=00 (AAC). ID bit is MPEG-2 vs MPEG-4, ignored.
      if (chunk[i] !== 0xff || (chunk[i + 1] & 0xf6) !== 0xf0) { ended = true; break; }
      const rate = ADTS_RATES[(chunk[i + 2] >> 2) & 0x0f];
      // Frame length includes header + CRC, so protection bytes don't matter.
      const len = ((chunk[i + 3] & 0x03) << 11) | (chunk[i + 4] << 3) | (chunk[i + 5] >> 5);
      if (!rate || len < ADTS_HEAD) { ended = true; break; }
      // Per-frame sum: rate can change at frame boundaries (concatenated streams).
      seconds += ((chunk[i + 6] & 0x03) + 1) * ADTS_BLOCK / rate;
      at += len;
      frames += 1;
    }
    return ended && frames >= MIN_FRAMES ? seconds : null;
  } catch {
    return null;
  }
}
