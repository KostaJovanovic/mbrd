// What a media container states about itself, read by hand.
//
// A browser will tell you how long a clip is and how big its picture is - right
// up until it will not. Every engine refuses some part of this app's own format
// catalogue: Chrome and Firefox decline AVI, WMV, FLV, MPEG program streams and
// most of what a camcorder writes; nothing but Safari opens AC-3 or DTS; AIFF
// and Matroska audio come and go by engine and platform. For those the element
// answers nothing at all - no `loadedmetadata`, no duration, no dimensions -
// and the card that results is a rectangle of the wrong shape with no facts on
// it, which is the same card whatever the file was.
//
// The containers themselves are not shy about any of this. A duration, a frame
// rate and a picture size are in the header of every format here, stated in
// plain fields a few hundred bytes in, because that is what a player needs
// before it can start. So this module reads them: fourteen containers, walked
// with Blob.slice() the way import/artwork.ts and import/preview.ts walk theirs,
// answering the same three or four facts for all of them.
//
// The method is the sibling analyser's, which is where the field offsets and
// the awkward corners came from - the 80-bit sample rate in an AIFF COMM, the
// Xing frame count that is the only honest duration a VBR MP3 has, the
// difference between an AVI's per-stream and per-file frame counts. What is not
// borrowed is the part that needs somebody else's code: analyser decodes the
// pixels through ImageMagick and ffmpeg, and mbrd asks ffmpeg for one poster
// frame (optimize/media.ts) and nothing more. Header fields need no decoder, so
// these run everywhere, offline, in a few kilobytes of reads.
//
// What uses it:
//
//   - ui/playlist.ts, for the duration of a track this engine will not decode,
//     and for the one it decodes *wrongly* (see streamDuration in artwork.ts).
//   - import/drop.ts, for the shape of a clip nothing here can open, so a phone
//     video lands upright instead of as a landscape box.
//   - canvas/renderers.ts, for the facts a card shows when it cannot show the
//     thing itself.
//
// The contract is import/artwork.ts's, deliberately: slice, never slurp; cap
// every count read from the file before looping or allocating; bound every
// offset against the file's real size; and answer null rather than throwing,
// because a container that will not parse is a card that says a little less,
// never an import that fails. Nothing here trusts a number in the file except
// as a claim to be checked.

import { streamDuration } from './artwork.ts';

/**
 * What a container will say about itself.
 *
 * Every field is optional and an absent one means "this container does not
 * state it" - not zero, and not "unknown, ask again later". An AVI knows its
 * picture size and its frame count; a raw AC-3 stream knows its sample rate and
 * how long it runs but has no picture at all; an MP3 knows everything except
 * the two that only apply to video. The callers all read the fields they want
 * and ignore the rest, so a container that fills three of eight is useful.
 */
export type MediaFacts = {
  /** Seconds. Exact where the container counts samples or frames. */
  duration?: number,
  /** The picture, in pixels, as the container declares it. */
  width?: number,
  height?: number,
  sampleRate?: number,
  channels?: number,
  /** A short human label - 'AC-3', 'Matroska'. For a card, not for logic. */
  container?: string,
  /**
   * The duration is arithmetic rather than a count, and may be wrong.
   *
   * One branch sets it: an MP3 with no Xing header, whose length is audio bytes
   * over the first frame's bitrate and is therefore exact only if the file is
   * constant bitrate. Every other duration here is either stated outright by
   * the container or counted frame by frame.
   *
   * It matters because the engine is the better authority on exactly that case
   * and on no other - it will decode the file and count - so a caller that has
   * both takes the engine's number when this flag is set and this module's when
   * it is not. See runProbe() in ui/playlist.ts.
   */
  estimated?: boolean,
};

/**
 * How much of the front of a file is read to identify it and walk its header.
 *
 * Generous on purpose. Every container here states what this module wants
 * inside its first header structure, but "first" is not "at the top": an AVI
 * puts its `avih` behind two nested RIFF lists, a Matroska file may carry a
 * seek head and a hundred kilobytes of cues before its Tracks, and an MP3's
 * Xing frame sits behind an ID3v2 tag that legally holds a cover photograph.
 * A quarter-megabyte covers all of those and is one read.
 */
const HEAD = 256 * 1024;

/** And how much of the *end*, for the containers that count from the tail. */
const TAIL = 64 * 1024;

/**
 * Ceilings on anything the file itself claims. None is a correctness bound - a
 * real file clears all of them - they are what keeps a truncated or hostile
 * container from turning a walk into an unbounded loop.
 */
const MAX_CHUNKS = 4096;      // RIFF/AIFF chunks, MP4 atoms, ASF objects
const MAX_ELEMENTS = 4096;    // EBML elements in one walk
const MAX_FRAMES = 4_000_000; // AMR frames, ~22 hours

/**
 * The longest a duration may be before it is treated as nonsense.
 *
 * Ten days. Every arithmetic path here multiplies a count by a rate, and both
 * come out of the file - a corrupt sample rate of 1 turns a three-minute song
 * into eleven days, and a card reading "268435456:00" is worse than a card
 * reading nothing. Refused rather than clamped: a wrong number that looks
 * plausible is the one failure this whole module exists to end.
 */
const MAX_SECONDS = 10 * 24 * 3600;

/**
 * Everything one container says about itself, or null.
 *
 * Identified by its own first bytes rather than by its name, with two
 * exceptions noted at their branches - a raw AC-3 or DTS elementary stream has
 * a sync word a byte and a half long, which is not enough to hand a file to a
 * parser on, so those two are confirmed by extension as well. Every other
 * branch here would recognise its format inside a file called anything at all.
 *
 * `ext` is optional for that reason and for one other: half the callers hold a
 * File and can say `extOf(file.name)`, and half hold nothing but the stored
 * bytes - an asset in the registry is a Blob, and the archive carries no
 * filenames - and pass what the item remembers, or nothing at all. Every branch
 * but those two works without it.
 */
export async function mediaFacts(file: Blob, ext = ''): Promise<MediaFacts | null> {
  try {
    const head = await bytes(file, 0, Math.min(HEAD, file.size));
    if (head.length < 16) return null;
    const facts = await read(file, head, ext.toLowerCase().replace(/^\./, ''));
    return facts && clean(facts);
  } catch {
    return null;
  }
}

/** The branch table, in the order the signatures are unambiguous. */
async function read(file: Blob, head: Bytes, ext: string): Promise<MediaFacts | null> {
  // RIFF carries three of the formats here and says which in its form type, so
  // it is one read and a three-way branch rather than three signature tests.
  if (tag(head, 0) === 'RIFF') {
    const form = tag(head, 8);
    if (form === 'WAVE') return riffWave(head);
    if (form === 'AVI ') return riffAvi(head);
    return null;
  }
  if (tag(head, 0) === 'FORM') {
    const form = tag(head, 8);
    if (form === 'AIFF' || form === 'AIFC') return aiff(head);
    return null;
  }
  if (tag(head, 0) === 'fLaC') return flac(head);
  if (tag(head, 0) === 'OggS') return await ogg(file, head);
  if (tag(head, 0, 3) === 'FLV') return flv(head);
  if (isEbml(head)) return matroska(head);
  if (isAsf(head)) return asf(head);
  if (isMp4(head)) return mp4(head);
  // An ID3 tag is worn by MP3s and by raw AAC alike, so what is behind it
  // decides, not the tag. streamDuration() answers null for anything that is
  // not a run of ADTS frames, which is exactly the question being asked.
  if (isID3(head) || isMpegAudio(head, 0) || isAdts(head, 0)) {
    const adts = await streamDuration(file);
    if (adts) return { container: 'AAC', duration: adts };
    return mp3(file, head);
  }
  // The two elementary streams whose sync word is too short to trust alone.
  // Both are named by the only extensions they ever arrive under.
  if ((ext === 'ac3' || ext === 'eac3') && head[0] === 0x0b && head[1] === 0x77) return ac3(file, head);
  if (ext === 'dts' || ext === 'dtshd') return dts(file, head);
  if (tag(head, 0, 5) === '#!AMR') return await amr(file, head);
  // MPEG's two multiplexes and its two bare bitstreams, all four of which are
  // recognised by a start code rather than by a header at offset zero - see
  // their own sections.
  if (head[0] === 0x47 || isMpegPs(head)) return await mpegStream(file, head);
  if (findStart(head, 0) >= 0) return bitstream(head, ext);
  return null;
}

/**
 * A parsed answer, held to what is believable.
 *
 * Every field here was arithmetic on numbers a stranger wrote, so this is the
 * one place that decides what comes out. A field that does not survive is
 * dropped rather than the whole answer: an AVI with a broken frame count still
 * knows how big its picture is, and half a fact is the difference between a
 * card shaped like the clip and a card shaped like nothing.
 */
function clean(f: MediaFacts): MediaFacts | null {
  const out: MediaFacts = {};
  if (f.container) out.container = f.container;
  if (isSpan(f.duration)) {
    out.duration = f.duration;
    if (f.estimated) out.estimated = true;
  }
  // Both or neither: a picture with one dimension is not a shape, and fitToBox()
  // in canvas/renderers.ts would take the pair and divide by zero.
  if (isSize(f.width) && isSize(f.height)) { out.width = f.width; out.height = f.height; }
  if (isRate(f.sampleRate)) out.sampleRate = f.sampleRate;
  if (isCount(f.channels)) out.channels = f.channels;
  return Object.keys(out).length ? out : null;
}

// 65535 is the largest either dimension can be in most of these headers anyway;
// it is well past any real video and well short of an allocation.
const isSize = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535;
const isRate = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1000 && n <= 768000;
const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 64;
const isSpan = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && n < MAX_SECONDS;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A run of bytes off a Blob, named the way import/artwork.ts names it and for
 * the same reason - everything here is a view onto an ArrayBuffer that came
 * from a slice, and saying so keeps the chain assignable.
 */
type Bytes = Uint8Array<ArrayBuffer>;

async function bytes(file: Blob, start: number, length: number): Promise<Bytes> {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

const le16 = (b: Bytes, i: number) => b[i] | (b[i + 1] << 8);
const le32 = (b: Bytes, i: number) => ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000);
const be16 = (b: Bytes, i: number) => (b[i] << 8) | b[i + 1];
const be24 = (b: Bytes, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const be32 = (b: Bytes, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/**
 * A 64-bit field, as a double.
 *
 * Every 64-bit count in these formats - an ASF play duration, an MP4 version-1
 * mvhd, a Matroska element size - is a byte count or a tick count, and the
 * largest of them that describes a real file is nowhere near 2^53. So the high
 * half is folded in by multiplication rather than by BigInt: a number that
 * needs more than 53 bits of precision here is a number this module refuses on
 * the way out anyway.
 */
const be64 = (b: Bytes, i: number) => be32(b, i) * 0x100000000 + be32(b, i + 4);
const le64 = (b: Bytes, i: number) => le32(b, i) + le32(b, i + 4) * 0x100000000;

const tag = (b: Bytes, i: number, n = 4) =>
  i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '';

const isID3 = (h: Bytes) => tag(h, 0, 3) === 'ID3' && h[3] < 5;
const isMp4 = (h: Bytes) => tag(h, 4) === 'ftyp' || tag(h, 4) === 'moov' || tag(h, 4) === 'mdat';
const isEbml = (h: Bytes) => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3;
// The ASF header object's GUID, first eight bytes - enough that nothing else
// starts with them.
const isAsf = (h: Bytes) => h[0] === 0x30 && h[1] === 0x26 && h[2] === 0xb2 && h[3] === 0x75
  && h[4] === 0x8e && h[5] === 0x66 && h[6] === 0xcf && h[7] === 0x11;
/** Eleven sync bits, and a version and layer that are not the reserved ones. */
const isMpegAudio = (b: Bytes, i: number) =>
  b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0
  && ((b[i + 1] >> 3) & 0x03) !== 1 && ((b[i + 1] >> 1) & 0x03) !== 0;

/** The same sync bits with a layer of 00, which is what makes it AAC rather
 *  than MPEG audio - see streamDuration() in import/artwork.ts. */
const isAdts = (b: Bytes, i: number) => b[i] === 0xff && (b[i + 1] & 0xf6) === 0xf0;

/**
 * Walk the chunks of a RIFF or IFF file, calling back with each one.
 *
 * The two formats are the same structure read in opposite byte orders - a
 * four-character name, a length, and that many bytes - which is why one walker
 * serves WAV, AVI and AIFF. `LIST`/`RIFF` in a RIFF file and `FORM` in an IFF
 * one carry a form type and then more chunks, so those are descended into
 * rather than skipped; everything else is a leaf.
 *
 * The callback answers true to stop the walk. Odd-length chunks are followed by
 * a pad byte in both formats, which is the `+ (len & 1)` and is the single most
 * commonly forgotten line in any RIFF reader.
 */
function walkChunks(
  b: Bytes,
  from: number,
  to: number,
  little: boolean,
  visit: (name: string, start: number, len: number) => boolean | void,
) {
  const u32 = little ? le32 : be32;
  let at = from;
  for (let n = 0; n < MAX_CHUNKS && at + 8 <= to; n++) {
    const name = tag(b, at);
    const len = u32(b, at + 4);
    const body = at + 8;
    if (!(len >= 0) || body > to) return;
    // A container chunk: its first four bytes name the form, and its children
    // follow. Descending is what finds an `avih` inside `LIST hdrl`.
    if (name === 'LIST' || name === 'RIFF' || name === 'FORM') {
      if (visit(tag(b, body), body + 4, Math.max(0, len - 4))) return;
      walkChunks(b, body + 4, Math.min(to, body + len), little, visit);
    } else if (visit(name, body, len)) {
      return;
    }
    at = body + len + (len & 1);
  }
}

// ---------------------------------------------------------------------------
// RIFF  -  .wav and .avi
// ---------------------------------------------------------------------------

/**
 * A WAV, from its `fmt ` and the length of its `data`.
 *
 * Duration is bytes over bytes-per-second and nothing cleverer, which is exact
 * for the PCM that WAV almost always holds. The field is in the header
 * (`nAvgBytesPerSec`) rather than computed from rate x channels x depth,
 * because for the compressed payloads a WAV can carry - ADPCM, µ-law, an MP3
 * inside a RIFF - it is the only one of the two that is true.
 *
 * `data` is read as a *declared* length, and the file's real size is the
 * fallback for the case that matters: a recording cut off mid-write, or one
 * streamed to disk with a placeholder length of 0xFFFFFFFF, which is common
 * enough that a player that trusted the field would report several days.
 */
function riffWave(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'WAV' };
  let byteRate = 0;
  let dataLen = 0;
  walkChunks(head, 12, head.length, true, (name, start, len) => {
    if (name === 'fmt ' && len >= 16) {
      out.channels = le16(head, start + 2);
      out.sampleRate = le32(head, start + 4);
      byteRate = le32(head, start + 8);
    } else if (name === 'data') {
      dataLen = len;
    }
  });
  if (byteRate > 0 && dataLen > 0) out.duration = dataLen / byteRate;
  return out;
}

/**
 * An AVI, from the `avih` in its header list.
 *
 * The two fields are the frame count and how many microseconds one frame lasts,
 * which multiply to the duration, and the two after them are the picture. All
 * four are in the first hundred bytes of the file.
 *
 * `dwTotalFrames` in `avih` is the field ffmpeg calls unreliable, and it is -
 * some muxers leave it zero, some count only the first RIFF chunk of a
 * multi-gigabyte file. Zero is taken as "no duration" rather than as zero
 * seconds; wrong-but-nonzero is left standing, because a duration a fifth short
 * on a two-hour capture is still a better card than no duration at all, and
 * this is a label under a picture rather than a seek bar.
 */
function riffAvi(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'AVI' };
  walkChunks(head, 12, head.length, true, (name, start, len) => {
    if (name !== 'avih' || len < 40) return;
    const usecPerFrame = le32(head, start);
    const frames = le32(head, start + 16);
    out.width = le32(head, start + 32);
    out.height = le32(head, start + 36);
    if (usecPerFrame > 0 && frames > 0) out.duration = (frames * usecPerFrame) / 1e6;
    return true;
  });
  return out;
}

// ---------------------------------------------------------------------------
// IFF  -  .aif, .aiff, .aifc
// ---------------------------------------------------------------------------

/**
 * An AIFF, from its COMM chunk: channels, frame count, bit depth, and a sample
 * rate written as an 80-bit IEEE 754 extended float.
 *
 * That last field is the whole reason this format needs its own reader. Nobody
 * else uses an 80-bit float for anything, JavaScript has no type for one, and
 * the value is always a plain integer like 44100 - so it is decoded by hand
 * from its sign, its 15-bit exponent and its 64-bit significand, which is nine
 * lines and exact for every rate a real file carries.
 */
function aiff(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'AIFF' };
  walkChunks(head, 12, head.length, false, (name, start, len) => {
    if (name !== 'COMM' || len < 18) return;
    out.channels = be16(head, start);
    const frames = be32(head, start + 2);
    const rate = extended80(head, start + 8);
    if (rate > 0) out.sampleRate = Math.round(rate);
    if (frames > 0 && rate > 0) out.duration = frames / rate;
    return true;
  });
  return out;
}

/**
 * An 80-bit IEEE 754 extended float, as a double.
 *
 * Sign, then a 15-bit exponent biased by 16383, then a 64-bit significand whose
 * top bit is *explicit* here where a double's is implied - which is why this is
 * `significand * 2 ** (exponent - 63)` rather than the usual 1.f form.
 */
function extended80(b: Bytes, i: number): number {
  const sign = b[i] & 0x80 ? -1 : 1;
  const exp = ((b[i] & 0x7f) << 8) | b[i + 1];
  if (exp === 0 || exp === 0x7fff) return 0;      // zero, subnormal, infinity, NaN
  const hi = be32(b, i + 2);
  const lo = be32(b, i + 6);
  return sign * (hi * 0x100000000 + lo) * 2 ** (exp - 16383 - 63);
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

/**
 * FLAC's STREAMINFO, which is always the first metadata block and always says
 * everything: a 20-bit sample rate, 3 bits of channel count, 5 of bit depth and
 * a 36-bit total sample count, packed across eight bytes with no alignment
 * whatsoever. The offsets below are that packing spelled out.
 *
 * The total is zero on a stream written without one - encoding straight to a
 * pipe - and that is taken as "no duration" rather than as a zero-length file.
 */
function flac(head: Bytes): MediaFacts | null {
  if (head.length < 42) return null;
  const b = head;                                   // STREAMINFO data at offset 8
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const channels = ((b[20] >> 1) & 0x07) + 1;
  const total = (b[21] & 0x0f) * 0x100000000 + be32(b, 22);
  const out: MediaFacts = { container: 'FLAC', channels };
  if (sampleRate > 0) {
    out.sampleRate = sampleRate;
    if (total > 0) out.duration = total / sampleRate;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ogg  -  .ogg, .oga, .opus, .ogv
// ---------------------------------------------------------------------------

/**
 * An Ogg stream, which is the one container here that has to be read from both
 * ends.
 *
 * There is no duration field anywhere in it. What there is instead is a granule
 * position on every page - a running count of samples encoded so far - so the
 * length of the stream is the granule on its *last* page. Hence the tail read:
 * find the last page header in the final chunk of the file, take its granule,
 * and divide by the sample rate from the identification header at the front.
 *
 * Two codecs, two rates. Vorbis states its own rate at a fixed offset in its
 * identification packet. Opus always counts granules at 48 kHz whatever the
 * input was, and states a pre-skip - the encoder's warm-up samples, which are
 * decoded and thrown away - that has to come off the total for the duration to
 * match what a player reports.
 */
async function ogg(file: Blob, head: Bytes): Promise<MediaFacts | null> {
  const out: MediaFacts = { container: 'Ogg' };
  let rate = 0;
  let preSkip = 0;
  // The first page's payload starts after the 27-byte page header and its
  // segment table, whose length is the byte before it.
  const segs = head[26];
  const body = 27 + segs;
  if (tag(head, body, 7) === '\x01vorbis') {
    rate = le32(head, body + 12);
    out.channels = head[body + 11];
    out.container = 'Ogg Vorbis';
  } else if (tag(head, body, 8) === 'OpusHead') {
    rate = 48000;                                   // granules are always 48 kHz
    preSkip = le16(head, body + 10);
    out.channels = head[body + 9];
    out.container = 'Opus';
    // The *input* rate, which is what a person means by "sample rate" and is not
    // what the granule counts in.
    const input = le32(head, body + 12);
    if (input > 0) out.sampleRate = input;
  } else if (tag(head, body, 7) === '\x80theora') {
    out.container = 'Ogg Theora';
    // Three version bytes, the frame size in macroblocks, and then the picture
    // itself as two 24-bit fields. The picture is the one to read: the frame is
    // rounded up to whole sixteen-pixel blocks, so a 1080-line video states
    // 1088 there and would land on the board eight pixels too tall.
    const w = be24(head, body + 14);
    const h = be24(head, body + 17);
    if (w > 0 && h > 0) { out.width = w; out.height = h; }
    // No duration: a Theora granule counts frames against a keyframe shift
    // rather than samples, so the arithmetic below would be wrong by whatever
    // the frame rate is. An absent duration is the honest answer, and every
    // engine that plays Theora at all reports one itself.
  }
  if (rate > 0 && !out.sampleRate) out.sampleRate = rate;
  const granule = await lastGranule(file);
  if (rate > 0 && granule > preSkip) out.duration = (granule - preSkip) / rate;
  return out;
}

/**
 * The granule position on the last Ogg page, found by scanning backwards
 * through the final chunk of the file for the page capture pattern.
 *
 * Backwards because the last page is what is wanted and forwards would mean
 * reading the whole file. The scan is bounded to TAIL bytes, which holds many
 * pages of any real stream - a page is at most 64 kB and typically a few - so
 * missing it means a file whose last page is enormous or a file that is not
 * really an Ogg, and both answer zero.
 */
async function lastGranule(file: Blob): Promise<number> {
  const at = Math.max(0, file.size - TAIL);
  const b = await bytes(file, at, Math.min(TAIL, file.size));
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) {
      return le64(b, i + 6);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// MPEG audio  -  .mp3
// ---------------------------------------------------------------------------

/** Bitrates in kbps by version group, layer and index. Index 0 and 15 are free
 *  and bad respectively, and both are left as zero so a lookup refuses them. */
const MP3_BITRATES: Record<number, Record<number, number[]>> = {
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  },
};

/** Sample rates by version bits (3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5). */
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * An MP3's duration, which it states in exactly one place if it states it at
 * all: the Xing or VBRI header a variable-bitrate encoder writes into the first
 * frame, holding the number of frames in the file.
 *
 * Without one there is no count anywhere, and the only honest answer is the
 * arithmetic every player falls back on - audio bytes over the first frame's
 * bitrate - which is exact for the constant-bitrate file it assumes and is a
 * guess for anything else. It is a good guess: a VBR file with no Xing header
 * is a file some tool has already mangled, and the alternative is walking a
 * hundred thousand frame headers to save a card from being a few seconds out.
 *
 * The ID3 tag is stepped over first, because the frame this reads has to be the
 * *first audio frame* and an APIC picture is full of bytes that look like sync
 * words.
 */
function mp3(file: Blob, head: Bytes): MediaFacts | null {
  let at = isID3(head) ? 10 + syncsafe(head, 6) + ((head[5] & 0x10) ? 10 : 0) : 0;
  // The tag length is a claim; a sync search from wherever it lands is what
  // makes a wrong one survivable.
  if (at >= head.length) at = 0;
  let h = -1;
  for (let i = at; i + 4 <= head.length; i++) {
    if (!isMpegAudio(head, i)) continue;
    const brIdx = (head[i + 2] >> 4) & 0x0f;
    const srIdx = (head[i + 2] >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 0x0f || srIdx === 3) continue;
    h = i;
    break;
  }
  if (h < 0) return null;
  const verBits = (head[h + 1] >> 3) & 0x03;
  const layer = 4 - ((head[h + 1] >> 1) & 0x03);
  const brIdx = (head[h + 2] >> 4) & 0x0f;
  const srIdx = (head[h + 2] >> 2) & 0x03;
  const mono = ((head[h + 3] >> 6) & 0x03) === 3;
  const sampleRate = (MP3_RATES[verBits] || MP3_RATES[2])[srIdx] || 0;
  const bitrate = ((MP3_BITRATES[verBits === 3 ? 1 : 2] || {})[layer] || [])[brIdx] || 0;
  const out: MediaFacts = { container: 'MP3', channels: mono ? 1 : 2 };
  if (sampleRate > 0) out.sampleRate = sampleRate;
  if (!sampleRate) return out;
  // Samples per frame: Layer I is 384, Layer II and III are 1152 - except that
  // MPEG-2 and 2.5 halve Layer III to 576, which is the one exception that
  // catches everybody out on low-bitrate files.
  const perFrame = layer === 1 ? 384 : layer === 2 ? 1152 : (verBits === 3 ? 1152 : 576);
  const frames = xingFrames(head, h, verBits, mono);
  if (frames > 0) {
    out.duration = (frames * perFrame) / sampleRate;
  } else if (bitrate > 0) {
    out.duration = ((file.size - h) * 8) / (bitrate * 1000);
    out.estimated = true;
  }
  return out;
}

/**
 * The frame count out of a Xing, Info or VBRI header, or zero.
 *
 * Xing sits at a fixed offset into the first frame that depends on the MPEG
 * version and whether the file is mono - it is written after the side
 * information, whose length is exactly what varies. VBRI, which Fraunhofer's
 * encoders write instead, is always 32 bytes after the header and needs no such
 * table.
 */
function xingFrames(b: Bytes, h: number, verBits: number, mono: boolean): number {
  const xingAt = h + 4 + (verBits === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const name = tag(b, xingAt);
  if (name === 'Xing' || name === 'Info') {
    const flags = be32(b, xingAt + 4);
    // Bit 0 is "frames field present", and it is the only field this wants -
    // when it is absent the rest of the header is still there, and reading a
    // byte count as a frame count would be an eight-hour song.
    if (flags & 0x01) return be32(b, xingAt + 8);
    return 0;
  }
  if (tag(b, h + 4 + 32) === 'VBRI') return be32(b, h + 4 + 32 + 14);
  return 0;
}

/** ID3's synchsafe integer - seven bits a byte. See import/artwork.ts. */
const syncsafe = (b: Bytes, i: number) =>
  (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

// ---------------------------------------------------------------------------
// MP4  -  .mp4, .m4v, .mov, .m4a, .m4b, .3gp
// ---------------------------------------------------------------------------

/**
 * An MP4's `mvhd` for the duration and the largest `tkhd` for the picture.
 *
 * Both are inside `moov`, which is the atom this walk is really looking for -
 * and which is at the *end* of a file written for streaming, past the audio and
 * the video. That is why the head read is a quarter-megabyte and why a miss
 * here is not treated as a broken file: for a clip whose moov is behind two
 * gigabytes of frames, the browser is the right tool and this module has
 * nothing to add. (The browser can open any file with an moov at all, since
 * `ftyp` means MP4 and MP4 means H.264 or HEVC, one of which every engine
 * plays. It is AVI and Matroska that need this reader.)
 *
 * Two of the sizes are 16.16 fixed point and one duration is 64-bit, both of
 * which are version-1 atom layouts rather than exotic - a phone writes them.
 */
function mp4(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'MP4' };
  const moov = findAtom(head, 0, head.length, 'moov');
  if (!moov) return out;
  const mvhd = findAtom(head, moov.start, moov.end, 'mvhd');
  if (mvhd) {
    // Version 0 puts a 32-bit creation and modification time before the
    // timescale; version 1 puts 64-bit ones, and its duration is 64-bit too.
    const v1 = head[mvhd.start] === 1;
    const timescale = be32(head, mvhd.start + (v1 ? 20 : 12));
    const duration = v1 ? be64(head, mvhd.start + 24) : be32(head, mvhd.start + 16);
    if (timescale > 0 && duration > 0) out.duration = duration / timescale;
  }
  // Every track has a tkhd and only the video track's carries a picture size, so
  // the largest non-zero pair wins rather than the first: a file with a cover
  // image track ahead of the video would otherwise be shaped like its artwork.
  let best = 0;
  eachAtom(head, moov.start, moov.end, 'trak', trak => {
    const tkhd = findAtom(head, trak.start, trak.end, 'tkhd');
    if (!tkhd) return;
    // The pair sits at the very end of the atom, behind the 36-byte display
    // matrix: 76 bytes in for version 0, 88 for version 1's wider times.
    const at = tkhd.start + (head[tkhd.start] === 1 ? 88 : 76);
    if (at + 8 > head.length) return;
    const w = be32(head, at) / 65536;
    const h = be32(head, at + 4) / 65536;
    if (w > 0 && h > 0 && w * h > best) {
      best = w * h;
      out.width = Math.round(w);
      out.height = Math.round(h);
    }
  });
  return out;
}

type Range = { start: number, end: number };

/** The payload of the first child atom named `type` between two offsets. */
function findAtom(b: Bytes, from: number, to: number, type: string): Range | null {
  let found: Range | null = null;
  eachAtom(b, from, to, type, r => { found = r; return true; });
  return found;
}

/**
 * Every child atom named `type`, as payload bounds. Siblings only - the caller
 * descends one named step at a time, so a `tkhd` inside some other tree is
 * never mistaken for one of this movie's.
 *
 * Size 1 means a 64-bit size follows the name; size 0 means "to the end of the
 * parent". Both are real and both appear in files a phone writes.
 */
function eachAtom(
  b: Bytes, from: number, to: number, type: string,
  visit: (r: Range) => boolean | void,
) {
  let at = from;
  for (let n = 0; n < MAX_CHUNKS && at + 8 <= to; n++) {
    let size = be32(b, at);
    let headLen = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = be64(b, at + 8);
      headLen = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < headLen || at + size > to) return;
    if (tag(b, at + 4) === type && visit({ start: at + headLen, end: at + size })) return;
    at += size;
  }
}

// ---------------------------------------------------------------------------
// Matroska  -  .mkv, .mka, .webm
// ---------------------------------------------------------------------------

/**
 * EBML, which is the one format here whose every field is variable-length.
 *
 * An element is an id, a size and a body, where the id and the size are each
 * written with a leading run of zero bits saying how many bytes they occupy -
 * so nothing is at a fixed offset and the walk has to decode as it goes. What
 * this wants out of it is three elements: the Segment's TimecodeScale and
 * Duration, and the Video block's PixelWidth and PixelHeight.
 *
 * Duration is a float, in scaled ticks, which is unlike every other duration in
 * this module: TimecodeScale is nanoseconds per tick (a million, always, which
 * makes a tick a millisecond) and Duration is how many ticks - as an IEEE
 * float, 4 or 8 bytes, because the spec allows both and muxers use both.
 */
function matroska(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'Matroska' };
  let scale = 1_000_000;                            // nanoseconds per tick
  let ticks = 0;
  walkEbml(head, 0, head.length, (id, start, len, isMaster) => {
    // 0x18538067 Segment, 0x1549A966 Info, 0x1654AE6B Tracks, 0xAE TrackEntry,
    // 0xE0 Video - the five masters on the path to what this wants.
    if (isMaster) return 'descend';
    if (id === 0x2ad7b1) scale = uint(head, start, len) || scale;
    else if (id === 0x4489) ticks = float(head, start, len);
    else if (id === 0xb0) out.width = uint(head, start, len) || out.width;
    else if (id === 0xba) out.height = uint(head, start, len) || out.height;
    return;
  });
  if (ticks > 0 && scale > 0) out.duration = (ticks * scale) / 1e9;
  return out;
}

/** The five master elements worth descending into, and nothing else. */
const EBML_MASTERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1a45dfa3]);

function walkEbml(
  b: Bytes, from: number, to: number,
  visit: (id: number, start: number, len: number, isMaster: boolean) => 'descend' | void,
  depth = 0,
) {
  if (depth > 8) return;
  let at = from;
  for (let n = 0; n < MAX_ELEMENTS && at < to; n++) {
    const id = vint(b, at, to, true);
    if (!id) return;
    const size = vint(b, id.next, to, false);
    if (!size) return;
    const start = size.next;
    // An unknown-size element (all size bits set) runs to the end of its parent,
    // which is legal for a Segment being written live.
    const len = size.value < 0 ? to - start : size.value;
    if (len < 0 || start + len > to) {
      // Truncated: the head read stopped mid-element. Descending is still right
      // for a master - the Info block may be entirely present inside it.
      if (EBML_MASTERS.has(id.value)) walkEbml(b, start, to, visit, depth + 1);
      return;
    }
    const isMaster = EBML_MASTERS.has(id.value);
    if (visit(id.value, start, len, isMaster) === 'descend' || isMaster) {
      walkEbml(b, start, start + len, visit, depth + 1);
    }
    at = start + len;
  }
}

/**
 * One EBML variable-length integer.
 *
 * The first byte's leading zeros say how many bytes the whole number takes. For
 * an id the marker bit is *kept* (an id is its bytes, which is how 0x1A45DFA3
 * is written); for a size it is stripped, and an all-ones value means unknown,
 * which is reported as -1.
 */
function vint(b: Bytes, at: number, to: number, isId: boolean) {
  if (at >= to) return null;
  const first = b[at];
  if (!first) return null;                          // eight leading zeros: not valid here
  let width = 1;
  while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
  if (width > 8 || at + width > to) return null;
  let value = isId ? first : first & (0x7f >> (width - 1));
  let allOnes = (first & (0x7f >> (width - 1))) === (0x7f >> (width - 1));
  for (let i = 1; i < width; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value: !isId && allOnes ? -1 : value, next: at + width };
}

/** A big-endian unsigned integer of 1 to 8 bytes, as EBML writes them. */
function uint(b: Bytes, at: number, len: number): number {
  if (len < 1 || len > 8) return 0;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[at + i];
  return v;
}

/** An EBML float, which is 4 or 8 bytes and read through a DataView because
 *  reconstructing an IEEE mantissa by hand is the one place that is not worth
 *  it. Anything else is zero, which reads as "no duration stated". */
function float(b: Bytes, at: number, len: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + at, Math.max(0, Math.min(len, b.length - at)));
  if (len === 4) return dv.getFloat32(0);
  if (len === 8) return dv.getFloat64(0);
  // Some muxers write Duration as an integer, which the spec allows.
  return uint(b, at, len);
}

// ---------------------------------------------------------------------------
// ASF  -  .wmv, .wma, .asf
// ---------------------------------------------------------------------------

/**
 * ASF's File Properties object, found by walking the header object's children.
 *
 * Every object is a 16-byte GUID and a 64-bit length, which makes the walk
 * trivial; the only awkwardness is that the GUIDs are written half little-endian
 * (the first three fields are byte-swapped, the last two are not), so they are
 * matched here as raw byte strings rather than parsed into anything.
 *
 * The play duration includes the preroll - the amount of data a player is meant
 * to buffer before starting - and every player subtracts it, so this does too.
 * Both are in 100-nanosecond units.
 */
const ASF_FILE_PROPS = '\xa1\xdc\xab\x8c\x47\xa9\xcf\x11\x8e\xe4\x00\xc0\x0c\x20\x53\x65';
const ASF_STREAM_PROPS = '\x91\x07\xdc\xb7\xb7\xa9\xcf\x11\x8e\xe6\x00\xc0\x0c\x20\x53\x65';
const ASF_VIDEO_MEDIA = '\xc0\xef\x19\xbc\x4d\x5b\xcf\x11\xa8\xfd\x00\x80\x5f\x5c\x44\x2b';

function asf(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'ASF' };
  // Header object: GUID(16) + size(8) + object count(4) + two reserved bytes.
  let at = 30;
  for (let n = 0; n < MAX_CHUNKS && at + 24 <= head.length; n++) {
    const guid = tag(head, at, 16);
    const size = le64(head, at + 16);
    if (!(size >= 24)) break;
    const body = at + 24;
    if (guid === ASF_FILE_PROPS && body + 64 <= head.length) {
      const play = le64(head, body + 40);           // 100ns units
      const preroll = le64(head, body + 56);        // milliseconds
      const secs = play / 1e7 - preroll / 1000;
      if (secs > 0) out.duration = secs;
    } else if (guid === ASF_STREAM_PROPS && body + 62 <= head.length) {
      // The type GUID says video, and the type-specific data that follows opens
      // with the encoded picture size - two 32-bit fields ahead of the
      // BITMAPINFOHEADER, which states the same thing again and sometimes
      // disagrees with it after a crop.
      if (tag(head, body, 16) === ASF_VIDEO_MEDIA) {
        out.width = le32(head, body + 54);
        out.height = le32(head, body + 58);
      }
    }
    at += size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// FLV
// ---------------------------------------------------------------------------

/**
 * FLV's onMetaData, which is an AMF0 object in the file's first script tag.
 *
 * Only three of its properties matter and all three are doubles, so rather than
 * write an AMF parser this looks for each property name and reads the eight
 * bytes after it - the name is length-prefixed and followed by a type byte of
 * 0x00 for a number, which is checked. A file whose metadata is missing or is
 * some other AMF shape answers nothing, which is the honest result: an FLV
 * without onMetaData genuinely does not state its duration anywhere.
 */
function flv(head: Bytes): MediaFacts | null {
  const out: MediaFacts = { container: 'FLV' };
  // One pass for all three properties rather than a full rescan of up to 256 KB
  // per field. The shape is unchanged: two bytes of name length, the name, a
  // 0x00 type byte for an AMF0 number, then eight bytes of double. First
  // occurrence of each name wins, as the per-key scan's early return did. The
  // per-position bound `i + 11 + len <= head.length` is the same one the old
  // loop carried - a byte tighter loses the height of every FLV.
  const found = new Map<string, number>();
  for (let i = 13; i + 11 <= head.length && found.size < 3; i++) {
    const len = be16(head, i);
    if (len < 5 || len > 8) continue;               // duration/width/height only
    if (i + 11 + len > head.length) continue;
    const name = tag(head, i + 2, len);
    if ((name !== 'duration' && name !== 'width' && name !== 'height') || found.has(name)) continue;
    if (head[i + 2 + len] !== 0x00) continue;       // AMF0 number
    const dv = new DataView(head.buffer, head.byteOffset + i + 2 + len + 1, 8);
    found.set(name, dv.getFloat64(0));
  }
  const duration = found.get('duration') ?? 0;
  const width = found.get('width') ?? 0;
  const height = found.get('height') ?? 0;
  if (duration > 0) out.duration = duration;
  if (width > 0 && height > 0) { out.width = Math.round(width); out.height = Math.round(height); }
  return out;
}

// ---------------------------------------------------------------------------
// AC-3 and DTS  -  the elementary streams
// ---------------------------------------------------------------------------

/** Sample rates by fscod, and the frame size table, in 16-bit words, indexed by
 *  frmsizecod and fscod. AC-3 is constant bitrate by construction, so one frame
 *  header states the size of every frame in the file. */
const AC3_RATES = [48000, 44100, 32000];
const AC3_FRAME_WORDS = [
  [64, 69, 96], [64, 70, 96], [80, 87, 120], [80, 88, 120], [96, 104, 144], [96, 105, 144],
  [112, 121, 168], [112, 122, 168], [128, 139, 192], [128, 140, 192], [160, 174, 240],
  [160, 175, 240], [192, 208, 288], [192, 209, 288], [224, 243, 336], [224, 244, 336],
  [256, 278, 384], [256, 279, 384], [320, 348, 480], [320, 349, 480], [384, 417, 576],
  [384, 418, 576], [448, 487, 672], [448, 488, 672], [512, 557, 768], [512, 558, 768],
  [640, 696, 960], [640, 697, 960], [768, 835, 1152], [768, 836, 1152], [896, 975, 1344],
  [896, 976, 1344], [1024, 1114, 1536], [1024, 1115, 1536], [1152, 1253, 1728],
  [1152, 1254, 1728], [1280, 1393, 1920], [1280, 1394, 1920],
];

/**
 * An AC-3 stream: one frame header gives the rate and the frame size, and the
 * frames are all that size, so the duration is the file over the frame.
 *
 * Every frame is 1536 samples - six blocks of 256 - which is the constant that
 * makes this arithmetic rather than a walk. The channel count is in `acmod`,
 * plus one for the LFE bit, which is the difference between "5.1" and "6".
 */
function ac3(file: Blob, head: Bytes): MediaFacts | null {
  const fscod = (head[4] >> 6) & 0x03;
  const frmsizecod = head[4] & 0x3f;
  const rate = AC3_RATES[fscod];
  const words = (AC3_FRAME_WORDS[frmsizecod] || [])[fscod];
  if (!rate || !words) return null;
  // The channel mode, and then the low-frequency bit - which is not at a fixed
  // position. Three optional two-bit mix levels sit between them and which of
  // them are present depends on the mode itself, so the offset is counted
  // rather than assumed. It is the difference between calling a film's
  // soundtrack 5.1 and calling it 5.
  const acmod = (head[6] >> 5) & 0x07;
  let bit = 3;
  if ((acmod & 0x01) && acmod !== 0x01) bit += 2;   // centre mix level
  if (acmod & 0x04) bit += 2;                       // surround mix level
  if (acmod === 0x02) bit += 2;                     // Dolby Surround mode
  const lfe = (head[6] >> (7 - bit)) & 0x01;
  const CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
  const frameBytes = words * 2;
  return {
    container: 'AC-3',
    sampleRate: rate,
    channels: CHANNELS[acmod] + lfe,
    duration: (Math.floor(file.size / frameBytes) * 1536) / rate,
  };
}

/** DTS core sample rates, indexed by the header's four-bit sfreq. The gaps are
 *  reserved values, and a zero refuses the file. */
const DTS_RATES = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 0, 0];

/**
 * A DTS core stream. The sync word comes in four byte orders - 14- and 16-bit,
 * big- and little-endian - and only the commonest, 16-bit big-endian, is read
 * here; the others are rare enough outside a DVD authoring house that the honest
 * answer for one is no answer.
 *
 * Like AC-3 it is constant bitrate, so the frame size in the header describes
 * every frame. A frame is 32 samples per block times the block count.
 */
function dts(file: Blob, head: Bytes): MediaFacts | null {
  if (!(head[0] === 0x7f && head[1] === 0xfe && head[2] === 0x80 && head[3] === 0x01)) return null;
  // Nothing after the sync word is byte-aligned. Reading the next four bytes as
  // one number and shifting is the whole of the arithmetic: a frame type bit,
  // five of deficit samples and one of CRC come first, then the block count and
  // the frame size, and the sample rate is the four bits after those - which
  // have spilled into the byte after, hence the second read.
  const bits = be32(head, 4);
  const nblks = (bits >>> 18) & 0x7f;
  const fsize = (bits >>> 4) & 0x3fff;
  const sfreq = (head[8] >> 2) & 0x0f;
  const rate = DTS_RATES[sfreq];
  if (!rate || nblks < 5 || fsize < 95) return null;
  const samples = 32 * (nblks + 1);
  return {
    container: 'DTS',
    sampleRate: rate,
    duration: (Math.floor(file.size / (fsize + 1)) * samples) / rate,
  };
}

// ---------------------------------------------------------------------------
// AMR
// ---------------------------------------------------------------------------

/** Frame bytes by mode, for narrowband and wideband. Index 15 is a no-data
 *  frame and the reserved ones in between are refused by their zero. */
const AMR_NB_BYTES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 0, 0, 0, 0, 0, 0, 1];
const AMR_WB_BYTES = [18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 0, 0, 0, 0, 1, 1];

/**
 * An AMR file, counted frame by frame.
 *
 * Every frame is 20 milliseconds and its length is a table lookup on the mode
 * in its first byte, so the duration is the frame count divided by fifty. There
 * is nothing to extrapolate from and nothing to trust: a voice recording is
 * variable-mode by design, mode 15 frames are empty, and the file states no
 * total anywhere. The walk is what there is - and these are phone voice notes,
 * which are small.
 */
async function amr(file: Blob, head: Bytes): Promise<MediaFacts | null> {
  const wide = tag(head, 0, 9) === '#!AMR-WB\n';
  const table = wide ? AMR_WB_BYTES : AMR_NB_BYTES;
  let at = wide ? 9 : 6;
  if (!wide && tag(head, 0, 6) !== '#!AMR\n') return null;
  let chunk = head;
  let base = 0;
  let frames = 0;
  while (frames < MAX_FRAMES) {
    if (at >= base + chunk.length) {
      base = at;
      chunk = await bytes(file, base, HEAD);
      if (!chunk.length) break;
    }
    // The mode is four bits of the frame's one header byte, and the table's
    // sizes count that byte - so the step is the size itself, and a mode-15
    // frame, which carries no speech at all, is the single byte.
    const mode = (chunk[at - base] >> 3) & 0x0f;
    const size = table[mode];
    if (!size) break;
    at += size;
    frames++;
  }
  if (!frames) return null;
  return {
    container: wide ? 'AMR-WB' : 'AMR',
    sampleRate: wide ? 16000 : 8000,
    channels: 1,
    duration: frames / 50,
  };
}

// ---------------------------------------------------------------------------
// MPEG  -  .ts, .m2ts, .mts, .mpg, .mpeg, .vob
// ---------------------------------------------------------------------------
//
// The two multiplexes, and among the best reasons this module exists: not one
// engine here will open a camcorder's .mts or a DVD's .vob, so before this they
// were a black rectangle of the wrong shape with no running time on it. Neither
// format has a header to read - both are a stream of packets, and what is
// wanted is found by looking for start codes inside them.
//
// The picture comes out of the video sequence header, which MPEG-2 writes
// before the first frame and repeats every second or so: twelve bits of width
// and twelve of height, packed across three bytes.
//
// The duration comes out of the timestamps. Every packet is stamped in 90 kHz
// units, so the last stamp less the first is how long the stream runs - which
// is why this is the second reader here that reads both ends of the file. It is
// exact to within a frame, and it is the only duration either format has.

/** A program stream opens with a pack header, or has one very near the front. */
const isMpegPs = (h: Bytes) => {
  const at = findCode(h, 0, 0xba);
  return at >= 0 && at < 4096;
};

/** The 188-byte packet a transport stream is made of. */
const TS_PACKET = 188;

/** The sequence header's start code, which carries the picture size. */
const SEQ_HEADER = 0xb3;

/** Ninety kilohertz: the clock every MPEG timestamp is counted in. */
const MPEG_CLOCK = 90000;

async function mpegStream(file: Blob, head: Bytes): Promise<MediaFacts | null> {
  const ts = head[0] === 0x47 && head[TS_PACKET] === 0x47;
  if (!ts && !isMpegPs(head)) return null;
  const out: MediaFacts = { container: ts ? 'MPEG-TS' : 'MPEG-PS' };
  // The sequence header can be a little way in - a transport stream opens with
  // its program tables - so the whole head read is searched rather than the
  // first few bytes of it.
  const seq = findCode(head, 0, SEQ_HEADER);
  if (seq >= 0 && seq + 7 <= head.length) {
    const w = (head[seq + 4] << 4) | (head[seq + 5] >> 4);
    const h = ((head[seq + 5] & 0x0f) << 8) | head[seq + 6];
    if (w > 0 && h > 0) { out.width = w; out.height = h; }
  }
  const first = firstStamp(head);
  const tail = await bytes(file, Math.max(0, file.size - TAIL), Math.min(TAIL, file.size));
  const last = lastStamp(tail);
  // A 33-bit counter wraps about every 26 hours, and a stream that crosses the
  // wrap gives a negative span. Refused rather than corrected: the correction
  // would be a guess about how many times it had gone round.
  if (first >= 0 && last > first) out.duration = (last - first) / MPEG_CLOCK;
  return out;
}

/** The offset of the next `00 00 01 xx` start code at or after `from`, or -1. */
function findCode(b: Bytes, from: number, code: number): number {
  for (let i = Math.max(0, from); i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === code) return i;
  }
  return -1;
}

/**
 * Any start code at all, which is what says "an MPEG bitstream begins here".
 *
 * The four-byte form `00 00 00 01` that the bare bitstreams below use is
 * matched by the same test - its `00 00 01` simply begins one byte later.
 */
function findStart(b: Bytes, from: number): number {
  for (let i = Math.max(0, from); i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
  }
  return -1;
}

/**
 * A 33-bit MPEG timestamp, spread across five bytes with a marker bit after
 * every chunk of it - which is what all the masking and the odd shifts are.
 *
 * Multiplication rather than shifting, because the top of a 33-bit value is
 * past what a 32-bit shift can hold and `<< 30` on it silently goes negative.
 *
 * The layout is the same wherever a timestamp appears, so one reader serves the
 * presentation stamps in a PES header and the clock reference in a program
 * stream's pack header.
 */
function stampAt(b: Bytes, i: number): number {
  if (i + 5 > b.length) return 0;
  return ((b[i] & 0x0e) * 0x20000000)
    + (b[i + 1] * 0x400000)
    + ((b[i + 2] & 0xfe) * 0x4000)
    + (b[i + 3] * 128)
    + (b[i + 4] >> 1);
}

/**
 * The first timestamp in a window, or -1.
 *
 * Minus one and not zero, which is not fussiness: a program stream routinely
 * starts its clock at exactly zero, and a "no stamp found" of 0 would treat the
 * commonest opening timestamp there is as an absence and lose the duration of
 * every such file.
 */
function firstStamp(b: Bytes): number {
  // A stamp occupies the fourteen bytes from `i`, so the last position worth
  // testing is fourteen from the end - and a window that stops one short of
  // that misses a stream whose final packet ends the file exactly.
  for (let i = 0; i + STAMP_SPAN <= b.length; i++) {
    const at = stampFrom(b, i);
    if (at >= 0) return at;
  }
  return -1;
}

/** How much of the window one timestamped packet header occupies. */
const STAMP_SPAN = 14;

/** The last timestamp in a window, scanning backwards. */
function lastStamp(b: Bytes): number {
  for (let i = b.length - STAMP_SPAN; i >= 0; i--) {
    const at = stampFrom(b, i);
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * A presentation timestamp starting at exactly `i`, or 0.
 *
 * Both multiplexes carry them the same way, inside a PES packet: a start code,
 * a stream id, a length, two flag bytes, and then the stamps. So the test is
 * the start code, an id in the audio or video range, and the flag that says a
 * presentation stamp is actually present.
 *
 * The clock reference in a program stream's pack header is deliberately not
 * read, though it is a timestamp and it is right there. MPEG-1 writes it in the
 * layout above and MPEG-2 writes it in a different one, with the bits split
 * around an extension field - so reading it without telling the two apart gives
 * a number that is wrong by a factor. The PES stamps are in every stream of
 * either kind and mean the same thing in both.
 */
function stampFrom(b: Bytes, i: number): number {
  if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) return -1;
  const id = b[i + 3];
  // 0xC0-0xDF is an audio stream and 0xE0-0xEF a video one. Everything else is
  // a map, a directory or padding, and carries no presentation stamp.
  if (id < 0xc0 || id > 0xef) return -1;
  // Two flag bytes follow the six-byte packet header; the top two bits of the
  // second say whether a presentation stamp - and then a decoding one - follow.
  if ((b[i + 7] >> 6) === 0) return -1;
  return stampAt(b, i + 9);
}

// ---------------------------------------------------------------------------
// H.264 and H.265  -  .264, .h264, .avc, .265, .h265, .hevc
// ---------------------------------------------------------------------------
//
// A bare bitstream: no container, no index, no timing anywhere - a file of
// coded frames and nothing else. So the one thing to read is the picture size,
// out of the sequence parameter set, and the honest thing to say about the
// length is nothing at all.
//
// The fields are Exp-Golomb coded, which is why this needs a bit reader rather
// than a table of offsets: each value is written as a run of zeros, a one, and
// then that many more bits, so nothing after the first field is at a known
// position and every field ahead of the two that are wanted has to be decoded
// to get past it.

function bitstream(head: Bytes, ext: string): MediaFacts | null {
  const hevc = ext === '265' || ext === 'h265' || ext === 'hevc';
  const size = hevc ? hevcSize(head) : avcSize(head);
  // Only when a parameter set was actually found and read. Three bytes of
  // anything can be a start code, and answering with a container label for a
  // file that has no sequence header in it would be this module claiming to
  // have recognised something it did not.
  return size ? { container: hevc ? 'HEVC' : 'H.264', width: size.w, height: size.h } : null;
}

/**
 * Every NAL unit in the window: its type, and where its header begins.
 *
 * The type is five bits of the first byte in H.264 and six bits of it in H.265,
 * whose header is two bytes rather than one - which is the whole of the
 * difference at this level.
 */
function eachNal(b: Bytes, hevc: boolean, visit: (type: number, start: number) => boolean | void) {
  let at = findStart(b, 0);
  for (let n = 0; at >= 0 && n < MAX_CHUNKS; n++) {
    const start = at + 3;
    const type = hevc ? (b[start] >> 1) & 0x3f : b[start] & 0x1f;
    if (visit(type, start)) return;
    at = findStart(b, start);
  }
}

/** H.264's sequence parameter set, NAL type 7. */
function avcSize(b: Bytes): Size | null {
  let found: Size | null = null;
  eachNal(b, false, (type, start) => {
    if (type !== 7) return;
    const r = new Bits(unescapeNal(b, start + 1));
    const profile = r.u(8);
    r.u(8);                                   // constraint flags and reserved
    r.u(8);                                   // level_idc
    r.ue();                                   // seq_parameter_set_id
    // The high profiles insert the chroma format and the scaling lists ahead of
    // everything else, which is the one branch in this parser.
    if (HIGH_PROFILES.has(profile)) {
      const chroma = r.ue();
      if (chroma === 3) r.u(1);               // separate_colour_plane_flag
      r.ue();                                 // bit_depth_luma_minus8
      r.ue();                                 // bit_depth_chroma_minus8
      r.u(1);                                 // qpprime_y_zero_transform_bypass
      if (r.u(1)) skipScaling(r, chroma === 3 ? 12 : 8);
    }
    r.ue();                                   // log2_max_frame_num_minus4
    const order = r.ue();                     // pic_order_cnt_type
    if (order === 0) {
      r.ue();
    } else if (order === 1) {
      r.u(1);
      r.se(); r.se();
      const cycle = Math.min(r.ue(), 256);
      for (let i = 0; i < cycle && r.ok; i++) r.se();
    }
    r.ue();                                   // max_num_ref_frames
    r.u(1);                                   // gaps_in_frame_num_value_allowed
    const wMbs = r.ue() + 1;
    const hMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);                // mb_adaptive_frame_field_flag
    r.u(1);                                   // direct_8x8_inference_flag
    let w = wMbs * 16;
    let h = hMapUnits * (frameMbsOnly ? 1 : 2) * 16;
    // The cropping window, which is what makes 1080 out of the 1088 the
    // macroblock grid actually codes - and skipping it is a card eight pixels
    // too tall on every phone video ever taken.
    if (r.u(1)) {
      const left = r.ue(), right = r.ue(), top = r.ue(), bottom = r.ue();
      w -= (left + right) * 2;
      h -= (top + bottom) * 2 * (frameMbsOnly ? 1 : 2);
    }
    if (r.ok && w > 0 && h > 0) found = { w, h };
    return true;
  });
  return found;
}

/** The profiles that carry a chroma format and scaling lists. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** H.265's sequence parameter set, NAL type 33. */
function hevcSize(b: Bytes): Size | null {
  let found: Size | null = null;
  eachNal(b, true, (type, start) => {
    if (type !== 33) return;
    const r = new Bits(unescapeNal(b, start + 2));
    r.u(4);                                   // sps_video_parameter_set_id
    const maxSubLayers = Math.min(r.u(3) + 1, 8);
    r.u(1);                                   // sps_temporal_id_nesting_flag
    profileTierLevel(r, maxSubLayers);
    r.ue();                                   // sps_seq_parameter_set_id
    const chroma = r.ue();
    if (chroma === 3) r.u(1);                 // separate_colour_plane_flag
    const w = r.ue();
    const h = r.ue();
    // Conformance cropping, counted in chroma units - two for the 4:2:0 that
    // everything shoots, one for the 4:4:4 that almost nothing does.
    let left = 0, right = 0, top = 0, bottom = 0;
    if (r.u(1)) { left = r.ue(); right = r.ue(); top = r.ue(); bottom = r.ue(); }
    const sx = chroma === 1 || chroma === 2 ? 2 : 1;
    const sy = chroma === 1 ? 2 : 1;
    const cw = w - (left + right) * sx;
    const ch = h - (top + bottom) * sy;
    if (r.ok && cw > 0 && ch > 0) found = { w: cw, h: ch };
    return true;
  });
  return found;
}

/**
 * The profile, tier and level block, whose only job here is to be stepped over:
 * twelve bytes, and then a bit or two for each temporal sub-layer.
 *
 * The spec pads the sub-layer flag list out to eight entries whenever there is
 * more than one layer, and forgetting those two bits per missing layer is the
 * classic way to read this block short and come out with a picture size that is
 * pure noise.
 */
function profileTierLevel(r: Bits, maxSubLayers: number) {
  r.u(8);                                     // profile space, tier, profile idc
  for (let i = 0; i < 4; i++) r.u(8);         // compatibility flags
  for (let i = 0; i < 6; i++) r.u(8);         // constraint flags and reserved
  r.u(8);                                     // general_level_idc
  const profilePresent: number[] = [];
  const levelPresent: number[] = [];
  for (let i = 0; i < maxSubLayers - 1; i++) {
    profilePresent.push(r.u(1));
    levelPresent.push(r.u(1));
  }
  if (maxSubLayers > 1) for (let i = maxSubLayers - 1; i < 8; i++) r.u(2);
  for (let i = 0; i < maxSubLayers - 1 && r.ok; i++) {
    if (profilePresent[i]) for (let n = 0; n < 11; n++) r.u(8);
    if (levelPresent[i]) r.u(8);
  }
}

/** Step over a scaling-list block, which the high profiles carry. */
function skipScaling(r: Bits, lists: number) {
  for (let i = 0; i < lists && r.ok; i++) {
    if (!r.u(1)) continue;
    const size = i < 6 ? 16 : 64;
    let next = 8, last = 8;
    for (let j = 0; j < size && r.ok; j++) {
      if (next) next = (last + r.se() + 256) % 256;
      last = next || last;
    }
  }
}

/**
 * A NAL payload with its emulation-prevention bytes taken out.
 *
 * A coded stream may never contain `00 00 00`, `00 00 01` or `00 00 02`,
 * because those would read as a start code - so the encoder inserts an `03`
 * after any two zeros and every reader has to take it back out before decoding
 * a single field. Bounded to half a kilobyte: a parameter set is tens of bytes,
 * and the fields wanted are at the front of it.
 */
function unescapeNal(b: Bytes, from: number): Bytes {
  const cap = Math.min(b.length, from + 512);
  const out = new Uint8Array(Math.max(0, cap - from));
  let n = 0;
  let zeros = 0;
  for (let i = from; i < cap; i++) {
    const byte = b[i];
    if (zeros >= 2 && byte === 3) { zeros = 0; continue; }
    out[n++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

/** What a parameter set answers with, and all this module wants from one. */
type Size = { w: number, h: number };

/**
 * A bit reader with Exp-Golomb, which is the whole of what a parameter set
 * needs and is not worth having anywhere else in this codebase.
 *
 * `ok` goes false the moment a read runs past the end, and both callers check
 * it before believing a number. Without it a truncated parameter set reads as a
 * picture thirty million pixels wide - exactly the kind of plausible nonsense
 * clean() exists to refuse, and much cheaper to refuse here.
 */
class Bits {
  private b: Bytes;
  private at = 0;
  ok = true;

  constructor(b: Bytes) { this.b = b; }

  /** `n` bits, as an unsigned number. */
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.at >> 3;
      if (byte >= this.b.length) { this.ok = false; return 0; }
      v = v * 2 + ((this.b[byte] >> (7 - (this.at & 7))) & 1);
      this.at++;
    }
    return v;
  }

  /** Unsigned Exp-Golomb: a run of zeros, a one, then that many more bits. */
  ue(): number {
    let zeros = 0;
    while (this.ok && this.u(1) === 0 && zeros < 32) zeros++;
    if (!this.ok || zeros >= 32) { this.ok = false; return 0; }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  /** Signed Exp-Golomb: the unsigned value folded around zero. */
  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}
