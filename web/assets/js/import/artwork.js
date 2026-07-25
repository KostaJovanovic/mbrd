// Cover art out of an audio file's own tags.
//
// Three container formats, parsed by hand: ID3v2 for .mp3, the MP4 atom tree
// for .m4a/.mp4/.aac, and FLAC's metadata blocks. No dependency, the same way
// storage/zip.js is no dependency - these are header formats, and a parser that
// only has to find one field in each is a short one.
//
// Everything here is read through Blob.slice(), never by pulling the file into
// memory. An album is routinely 40 MB of audio wrapped around 200 KB of
// picture, and the picture is the only part any of this wants.
//
// The contract is deliberately meek: any file may fail to parse, and failing is
// not an error. A card with no cover is the normal case - most audio has no art
// at all - so every path here answers `null` rather than throwing, and the
// importer treats a null as "nothing to show" and carries on.

import { extOf } from '../util.js';

/**
 * The biggest picture worth taking out of a tag.
 *
 * Not a safety limit - the bytes are already on the user's disk and they chose
 * to import them. It is a judgement about what a cover is *for*: this becomes a
 * thumbnail on a card, and a 30 MB scan of a gatefold sleeve costs the board's
 * memory and its .mbrd the same as the music does, to be looked at at 200px.
 */
const MAX_ART = 12 * 1024 * 1024;

/** How far into an MP4 the atom walk will go before giving up. */
const MAX_ATOMS = 4096;

/**
 * The picture embedded in an audio file, as a File, or null.
 *
 * A File rather than a Blob so it can go straight to addFile() in
 * storage/assets.js, which wants a name and a type - and so the asset registry
 * remembers it arrived as "cover.jpg" rather than as nothing.
 */
export async function coverArt(file) {
  try {
    const head = await bytes(file, 0, 16);
    const data = isID3(head) ? await id3Art(file, head)
               : isFLAC(head) ? await flacArt(file)
               : isMP4(head) ? await mp4Art(file)
               : null;
    if (!data || !data.length || data.length > MAX_ART) return null;
    // The picture is identified by its own first bytes and by nothing else.
    //
    // Every one of these formats has a field for the MIME type, and every one
    // of them is unreliable - written by hundreds of programs over thirty
    // years, routinely blank, routinely 'image/jpg', routinely just wrong. But
    // the reason for sniffing is stronger than mistrust: what this needs to
    // know is not what the tag *calls* the picture, it is whether this browser
    // will draw it. A TIFF or a camera RAW honestly declared as such would pass
    // any `startsWith('image/')` test and then mount as a broken image on a
    // card that was perfectly fine before. Four recognised signatures is
    // exactly the set that renders, so an unrecognised one is refused.
    const type = sniff(data);
    if (!type) return null;
    return new File([data], 'cover.' + extFor(type), { type });
  } catch {
    return null;
  }
}

/** Does this extension have any chance of carrying art? Saves a read. */
export const mayHaveArt = name =>
  ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'alac', 'flac'].includes(extOf(name));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function bytes(file, start, length) {
  if (start < 0 || length <= 0 || start >= file.size) return new Uint8Array(0);
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const be24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * ID3's "synchsafe" integer: seven bits per byte, so the encoded size can never
 * contain a 0xFF byte that a player scanning for an audio frame would mistake
 * for the start of one.
 */
const syncsafe = (b, i) =>
  (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

/** The picture formats a browser will draw, identified by their own first bytes. */
function sniff(b) {
  if (b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image/png';
  if (ascii(b, 0, 3) === 'GIF') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return '';
}

// Total over what sniff() can return, which is the only thing that reaches it.
const extFor = type => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
}[type]);

// ---------------------------------------------------------------------------
// ID3v2  -  .mp3
// ---------------------------------------------------------------------------

const isID3 = h => h.length >= 10 && ascii(h, 0, 3) === 'ID3' && h[3] < 5;

/**
 * The APIC frame of an ID3v2 tag.
 *
 * The tag sits at the very front of the file and states its own length, so the
 * whole of it is read at once and walked in memory - it is kilobytes plus the
 * picture, and the picture is what we came for anyway.
 *
 * Three revisions are in the wild and they disagree about the frame header:
 * v2.2 uses a 3-character id and a 3-byte size, v2.3 a 4-character id and a
 * plain 32-bit size, v2.4 the same but synchsafe. Files written as v2.4 with
 * v2.3 sizes are common enough that the size is sanity-checked rather than
 * trusted, and a frame that runs past the end of the tag ends the walk.
 */
async function id3Art(file, head) {
  const size = syncsafe(head, 6);
  if (size <= 0) return null;
  const footer = (head[5] & 0x10) ? 10 : 0;
  let tag = await bytes(file, 10, size + footer);
  // Tag-level unsynchronisation: every 0xFF in the body was followed by a
  // padding 0x00 so that no byte pair could look like an audio frame header.
  // Undone first, because it is applied to the frames and their sizes alike.
  if (head[5] & 0x80) tag = desync(tag);

  const major = head[3];
  const idLen = major <= 2 ? 3 : 4;
  const headLen = major <= 2 ? 6 : 10;
  const want = major <= 2 ? 'PIC' : 'APIC';

  let at = 0;
  while (at + headLen <= tag.length) {
    const id = ascii(tag, at, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;          // padding, or the end of the frames
    let len = major <= 2 ? be24(tag, at + 3)
            : major === 4 ? syncsafe(tag, at + 4)
            : be32(tag, at + 4);
    // A v2.4 file written by a tagger that used v2.3 sizes: the synchsafe read
    // comes out far too small and the walk desynchronises. If the plain reading
    // fits the tag and the synchsafe one does not describe a frame that does,
    // take the plain one.
    if (major === 4 && at + headLen + len > tag.length) {
      const plain = be32(tag, at + 4);
      if (at + headLen + plain <= tag.length) len = plain;
    }
    if (len <= 0 || at + headLen + len > tag.length) break;
    let start = at + headLen;
    let end = start + len;
    if (major >= 3) {
      const flags = tag[at + headLen - 1];
      // A data-length indicator adds four bytes in front of the frame body.
      if (major === 4 && (flags & 0x01)) start += 4;
      // Per-frame unsynchronisation, v2.4's replacement for the tag-wide flag.
      if (major === 4 && (flags & 0x02)) {
        const body = desync(tag.subarray(start, end));
        if (id === want) return readAPIC(body, major);
        at = end;
        continue;
      }
    }
    if (id === want) return readAPIC(tag.subarray(start, end), major);
    at = end;
  }
  return null;
}

/** Undo unsynchronisation: a 0x00 inserted after every 0xFF comes back out. */
function desync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/**
 * The body of an APIC/PIC frame: encoding, MIME, picture type, description,
 * then the picture. Only the last of those is returned - the fields in front of
 * it exist here to be stepped over, not to be believed.
 *
 * The description is the awkward part. It is terminated by a null *in its own
 * encoding*, so a UTF-16 description ends at a 0x00 0x00 pair on an even offset
 * - and a single zero byte inside a UTF-16 character is not the end of it. That
 * distinction is why this is written out rather than done with an indexOf.
 */
function readAPIC(b, major) {
  if (b.length < 4) return null;
  const enc = b[0];
  // v2.2 carries a bare three-letter format - 'JPG', 'PNG' - where the later
  // revisions carry a null-terminated MIME string. Different widths, same
  // treatment: skipped.
  let at = 4;
  if (major > 2) {
    const end = b.indexOf(0, 1);
    if (end < 0) return null;
    at = end + 2;                             // the null, then the picture type
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

const isFLAC = h => ascii(h, 0, 4) === 'fLaC';

/**
 * FLAC's METADATA_BLOCK_PICTURE, block type 6.
 *
 * The cleanest of the three: a flat list of length-prefixed blocks at the front
 * of the file, each one declaring its own size, so finding the picture is a
 * walk through four-byte headers and the only block ever read in full is the
 * one we want.
 */
async function flacArt(file) {
  let at = 4;
  for (let n = 0; n < MAX_ATOMS; n++) {
    const head = await bytes(file, at, 4);
    if (head.length < 4) return null;
    const last = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const len = be24(head, 1);
    if (type === 6) {
      if (len > MAX_ART + 4096) return null;
      const b = await bytes(file, at + 4, len);
      return readFlacPicture(b);
    }
    if (last) return null;
    at += 4 + len;
  }
  return null;
}

function readFlacPicture(b) {
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

const isMP4 = h => h.length >= 12 && ascii(h, 4, 4) === 'ftyp';

/**
 * The 'covr' atom, down at moov/udta/meta/ilst/covr/data.
 *
 * Walked through Blob.slice() one 16-byte header at a time rather than read
 * whole, because in an MP4 the metadata is as likely to be at the *end* of the
 * file as the start - the 'moov' atom follows the audio in anything written
 * for streaming - and pulling a 60 MB track into memory to reach the last
 * kilobyte of it is exactly what this module exists not to do.
 *
 * 'meta' is the one irregular step: it carries four bytes of version and flags
 * before its children, where every other container here starts them
 * immediately. A walk that misses that reads the first child's size out of the
 * middle of the version field and goes nowhere.
 */
async function mp4Art(file) {
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
  // data: version+flags(4) then reserved(4), then the picture. The low byte of
  // the flags is iTunes' own type - 13 JPEG, 14 PNG - and it is ignored in
  // favour of sniffing the bytes, which cannot disagree with themselves.
  const len = data.end - data.start - 8;
  if (len <= 0 || len > MAX_ART) return null;
  return await bytes(file, data.start + 8, len);
}

/**
 * The payload bounds of the first child atom named `type` between two offsets,
 * or null. Siblings only - the caller descends deliberately, one named step at
 * a time, so a stray 'data' somewhere else in the tree is never mistaken for
 * the one being looked for.
 */
async function findAtom(file, from, to, type) {
  let at = from;
  for (let n = 0; n < MAX_ATOMS && at + 8 <= to; n++) {
    const head = await bytes(file, at, 16);
    if (head.length < 8) return null;
    let size = be32(head, 0);
    let headLen = 8;
    // size 1 means the real, 64-bit size follows the name. Read as two 32-bit
    // halves because a length that needs more than 53 bits of precision is not
    // a file anything here can open anyway.
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
