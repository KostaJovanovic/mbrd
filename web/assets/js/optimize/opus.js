// Sound, through the browser's own Opus encoder.
//
// The browser already has everything this needs and has for years: it decodes
// FLAC, ALAC, MP3, WAV and AAC through decodeAudioData, and it encodes Opus
// through WebCodecs. What it will not do is put the result in a file - an
// AudioEncoder hands back bare Opus packets, and a bare packet stream is not
// something you can save, name, play or hand to anybody.
//
// So the missing piece is a container, and a container is a header format, so
// it is written here by hand - the same bargain as storage/zip.js and
// import/artwork.js. Ogg is about ninety lines: a page header, a lacing table
// and a CRC. That is what stands between a 12 MB FLAC and a 3 MB file, and it
// is a much better trade than thirty megabytes of vendored ffmpeg, which is
// what this replaces for every sound file on a board.
//
// ffmpeg is still what video goes through - see media.js - because demuxing an
// MP4 is a different and much larger problem than muxing an Ogg. Sound no
// longer waits on it.

import { audioTags } from '../import/artwork.js';

/** Opus's own rate. Everything is resampled to it on the way in. */
const RATE = 48000;

/** 20 ms, which is what libopus wants and what WebCodecs emits by default. */
const FRAME = 960;

/** Packets to a page: a second of audio, which keeps pages around 12 KB. */
const PER_PAGE = 50;

/** How many frames may be in flight before the loop waits for the encoder. */
const QUEUE = 24;

/** The bitrate. Transparent enough for a board and a fifth of a 320k MP3. */
export const OPUS_KBPS = 96;

/**
 * How much smaller the result has to be to be worth keeping. The same rule the
 * pictures follow, and the reason an already-small MP3 is left exactly alone.
 */
const WORTH_IT = 0.1;

/**
 * The largest file this will try.
 *
 * Not a policy about big files, an arithmetic one: decoding is to 32-bit float
 * at 48 kHz, so an hour of stereo is a gigabyte of PCM resident at once. Past
 * this the honest answer is to leave the file alone rather than take the tab
 * down with it.
 */
const MAX_INPUT = 300 * 1024 * 1024;

/** Whether this browser can do any of it, checked before anything is promised. */
export const opusAvailable = () =>
  typeof AudioEncoder === 'function' &&
  typeof AudioData === 'function' &&
  typeof OfflineAudioContext === 'function';

/**
 * A smaller version of this sound, or null to leave it alone.
 *
 * `cover` is an optional File to embed as the front cover - the board extracts
 * album art on import anyway (import/artwork.js), and this puts a copy back
 * into the file so that what leaves the board is still a tagged track and not
 * an anonymous stream.
 *
 * Null for every ordinary refusal, the same as shrinkPicture(): a format this
 * browser cannot decode, a file already smaller than the re-encode, a stream
 * with no audio in it. None of those is a failure and all of them mean "keep
 * what you have".
 */
export async function toOpus(blob, { kbps = OPUS_KBPS, cover = null, coverW = 0, coverH = 0, tags = null } = {}) {
  if (!opusAvailable() || !blob || !blob.size || blob.size > MAX_INPUT) return null;

  // Read the tags before the bytes are decoded, so that a file that turns out
  // to be undecodable costs one header read rather than a decode.
  const pairs = tags || await audioTags(blob).catch(() => []);

  let buf;
  try {
    // decodeAudioData resamples to the context's own rate, so asking an
    // Opus-rate context to do the decoding is the resample - no second buffer,
    // and no hand-written interpolation to get wrong.
    buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
  if (!buf?.length || !buf.numberOfChannels) return null;

  // Mapping family 0 - the only one worth writing a header for - covers mono
  // and stereo. Anything wider is a film mix that has no business on a board,
  // and taking its front pair is better than refusing it.
  const channels = Math.min(2, buf.numberOfChannels);
  const config = { codec: 'opus', sampleRate: RATE, numberOfChannels: channels, bitrate: kbps * 1000 };
  const ok = await AudioEncoder.isConfigSupported(config).catch(() => null);
  if (!ok?.supported) return null;

  const encoded = await encode(buf, channels, config);
  if (!encoded?.packets.length) return null;

  const ogg = writeOgg({
    ...encoded,
    channels,
    samples: buf.length,
    comments: pairs,
    picture: cover ? await pictureBlock(cover, coverW, coverH) : null,
  });

  const out = new Blob([ogg], { type: 'audio/ogg' });
  if (out.size >= blob.size * (1 - WORTH_IT)) return null;
  return { blob: out, from: blob.size, to: out.size, seconds: buf.length / RATE };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Every packet the encoder produces, with the head it describes itself by.
 *
 * The loop waits on the encoder rather than handing it the whole track at once:
 * a five minute song is fifteen thousand frames, and queueing all of them puts
 * the entire decoded track in the encoder's own queue on top of the copy this
 * function is already holding.
 */
async function encode(buf, channels, config) {
  const packets = [];
  let head = null;
  let failed = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      // Chrome describes the stream once, on the first chunk, and what it hands
      // over is exactly the 19-byte OpusHead an Ogg stream opens with - so the
      // pre-skip and the output gain are the encoder's own rather than guessed.
      const desc = meta?.decoderConfig?.description;
      if (!head && desc) head = new Uint8Array(ArrayBuffer.isView(desc) ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push({ bytes, duration: chunk.duration });
    },
    error: err => { failed = err; },
  });

  try {
    encoder.configure(config);
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(buf.getChannelData(c));

    for (let at = 0; at < buf.length && !failed; at += FRAME) {
      const n = Math.min(FRAME, buf.length - at);
      // f32-planar wants the channels end to end in one buffer, which is what
      // an AudioBuffer already holds - just in separate arrays.
      const data = new Float32Array(channels * n);
      for (let c = 0; c < channels; c++) data.set(planes[c].subarray(at, at + n), c * n);
      const frame = new AudioData({
        format: 'f32-planar',
        sampleRate: RATE,
        numberOfFrames: n,
        numberOfChannels: channels,
        timestamp: Math.round((at / RATE) * 1e6),
        data,
      });
      encoder.encode(frame);
      frame.close();
      if (encoder.encodeQueueSize > QUEUE) {
        await new Promise(done => encoder.addEventListener('dequeue', done, { once: true }));
      }
    }
    await encoder.flush();
  } catch (err) {
    failed = failed || err;
  } finally {
    try { encoder.close(); } catch { /* already closed by the error path */ }
  }

  if (failed) return null;
  return { packets, head };
}

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

/**
 * Ogg's CRC: the ordinary CCITT polynomial, but with none of the reflection or
 * the final inversion that every other CRC32 in the world applies - which is
 * why the platform's checksums cannot be borrowed for it.
 */
const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    table[i] = r >>> 0;
  }
  return table;
})();

function crc32(b) {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

/**
 * The serial number every page in the stream carries.
 *
 * Ogg uses it to tell interleaved streams apart, and a file with one stream in
 * it has nothing to tell apart - so it is a constant rather than a random
 * number, which makes the output a pure function of the input. That matters
 * here: optimize.js addresses files by the hash of their bytes, and an
 * encoder that produced a different file every run would defeat it.
 */
const SERIAL = 0x6d627264;                      // 'mbrd'

/**
 * The whole file: an identification page, the comment header, then the audio.
 *
 * Granule position is the count of 48 kHz samples decodable by the end of the
 * page, pre-skip included, and belongs to the last packet that *finished* on
 * that page. The last page's is clamped to the real length of the source, which
 * is how the encoder's trailing padding gets trimmed - without it a player
 * reports a track a few milliseconds longer than it is and gates open on
 * silence at the end.
 */
function writeOgg({ packets, head, channels, samples, comments, picture }) {
  const id = usableHead(head, channels) || opusHead(channels);
  const preSkip = id[10] | (id[11] << 8);
  const ogg = pager();

  // The identification header is alone on the first page, which is what marks
  // the beginning of the stream. Neither header carries audio, so both end on a
  // granule of zero.
  ogg.packet(id, 0);
  ogg.page();
  // The comment header is the one packet here that routinely does not fit on a
  // page: an album cover is a couple of hundred kilobytes and a page holds
  // 65,025. pager() spills it across as many as it needs.
  ogg.packet(opusTags(comments, picture), 0);
  ogg.page();

  const end = preSkip + samples;
  let done = 0;
  for (let i = 0; i < packets.length; i++) {
    // The encoder's own duration, in case it ever packs something other than
    // 20 ms - falling back to the frame size rather than trusting a zero.
    done += Math.round((packets[i].duration || 0) * RATE / 1e6) || FRAME;
    ogg.packet(packets[i].bytes, Math.min(preSkip + done, end));
    if ((i + 1) % PER_PAGE === 0 && i + 1 < packets.length) ogg.page();
  }
  ogg.page(true);
  return ogg.done();
}

/** A granule of -1: this page finished no packet, so it dates nothing. */
const NO_GRANULE = -1;

/**
 * The page writer.
 *
 * Ogg's segment table is the whole of the format's cleverness and the whole of
 * what there is to get wrong. A packet is written as a run of 255s and a final
 * value below 255 that says it ended - so a packet whose length is an exact
 * multiple of 255 needs a trailing zero, or the next packet is read as more of
 * this one. A table holds at most 255 entries, so a packet longer than 65,025
 * bytes cannot fit on one page and continues onto the next, which flags itself
 * as a continuation and carries a granule of -1 because nothing completed on
 * it. All three of those are the album-art case, and all three are why this is
 * a small machine rather than a loop.
 */
function pager() {
  const pages = [];
  let laces = [];
  let body = [];
  let bodyLen = 0;
  let granule = NO_GRANULE;
  let seq = 0;
  let first = true;
  let continued = false;
  let inPacket = false;

  const write = (flags, gran) => {
    const buf = new Uint8Array(27 + laces.length + bodyLen);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x4f; buf[1] = 0x67; buf[2] = 0x67; buf[3] = 0x53;   // 'OggS'
    buf[4] = 0;                                                   // stream version
    buf[5] = flags;
    // A 64-bit granule, written as two 32-bit halves: an hour of audio is well
    // inside the low word, but the field is eight bytes and must all be there.
    if (gran === NO_GRANULE) { dv.setUint32(6, 0xffffffff, true); dv.setUint32(10, 0xffffffff, true); }
    else { dv.setUint32(6, gran >>> 0, true); dv.setUint32(10, Math.floor(gran / 2 ** 32), true); }
    dv.setUint32(14, SERIAL, true);
    dv.setUint32(18, seq++, true);
    dv.setUint32(22, 0, true);                                    // checksummed as zero
    buf[26] = laces.length;
    buf.set(laces, 27);
    let at = 27 + laces.length;
    for (const piece of body) { buf.set(piece, at); at += piece.length; }
    dv.setUint32(22, crc32(buf), true);
    pages.push(buf);
  };

  /** Close the page being built, if there is one. */
  const page = (eos = false) => {
    if (!laces.length) return;
    write((continued ? 1 : 0) | (first ? 2 : 0) | (eos ? 4 : 0), granule);
    first = false;
    // Whatever comes next is a continuation exactly when this page ended in the
    // middle of a packet.
    continued = inPacket;
    laces = []; body = []; bodyLen = 0; granule = NO_GRANULE;
  };

  return {
    page,
    packet(bytes, gran) {
      inPacket = true;
      let off = 0;
      for (;;) {
        const n = Math.min(255, bytes.length - off);
        laces.push(n);
        if (n) { body.push(bytes.subarray(off, off + n)); bodyLen += n; }
        off += n;
        if (n < 255) break;                    // a short lace is what ends a packet
        if (laces.length === 255) page();      // out of table: spill to the next
      }
      inPacket = false;
      granule = gran;
      if (laces.length === 255) page();
    },
    done() {
      const total = pages.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of pages) { out.set(p, at); at += p.length; }
      return out;
    },
  };
}

/** The encoder's own header, if it gave one and it is the shape it should be. */
function usableHead(head, channels) {
  if (!head || head.length < 19) return null;
  if (String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') return null;
  if (head[9] !== channels) return null;
  return head;
}

/**
 * A header written from scratch, for a browser that describes nothing.
 *
 * 312 samples is libopus's own lookahead at 48 kHz. Getting it wrong offsets
 * the track by six milliseconds, which is inaudible - but getting it right
 * costs nothing.
 */
function opusHead(channels) {
  const b = new Uint8Array(19);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);     // 'OpusHead'
  b[8] = 1;                                                       // version
  b[9] = channels;
  b[10] = 312 & 0xff;
  b[11] = 312 >> 8;
  new DataView(b.buffer).setUint32(12, RATE, true);               // the original rate
  // Output gain (16..17) stays 0, and mapping family (18) stays 0 for stereo.
  return b;
}

/**
 * The comment header: a vendor string, then `KEY=value` strings.
 *
 * Cover art rides in here too, as METADATA_BLOCK_PICTURE - a whole FLAC picture
 * block, base64'd, which is the roundabout but entirely standard way an Opus
 * stream carries a picture, and what every player that shows one reads.
 */
function opusTags(comments, picture) {
  const enc = new TextEncoder();
  const vendor = enc.encode('mbrd');
  const list = (comments || []).map(([k, v]) => enc.encode(`${k}=${v}`));
  if (picture) list.push(enc.encode('METADATA_BLOCK_PICTURE=' + picture));

  const size = 8 + 4 + vendor.length + 4 + list.reduce((n, c) => n + 4 + c.length, 0);
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b.set(enc.encode('OpusTags'), 0);
  let at = 8;
  dv.setUint32(at, vendor.length, true); at += 4;
  b.set(vendor, at); at += vendor.length;
  dv.setUint32(at, list.length, true); at += 4;
  for (const c of list) {
    dv.setUint32(at, c.length, true); at += 4;
    b.set(c, at); at += c.length;
  }
  return b;
}

/**
 * A picture as a base64 FLAC METADATA_BLOCK_PICTURE.
 *
 * Big-endian throughout, unlike the comment block it will be stored in, because
 * it is a FLAC structure being carried by an Ogg one. The dimensions are read
 * from the picture rather than declared, because a wrong pair of numbers here
 * is worse than none - some players lay out from them without looking.
 */
async function pictureBlock(file, width = 0, height = 0) {
  let data;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
  if (!data.length) return null;

  // The caller (carried()) often already decoded this cover to shrink it and
  // passes its dimensions; only decode when they are not in hand.
  if (!(width > 0 && height > 0)) {
    width = 0; height = 0;
    try {
      const bmp = await createImageBitmap(file);
      width = bmp.width; height = bmp.height;
      bmp.close?.();
    } catch { /* undrawable: the numbers stay 0, which is allowed */ }
  }

  const mime = new TextEncoder().encode(file.type || 'image/jpeg');
  const b = new Uint8Array(32 + mime.length + data.length);
  const dv = new DataView(b.buffer);
  let at = 0;
  dv.setUint32(at, 3); at += 4;                       // picture type 3: front cover
  dv.setUint32(at, mime.length); at += 4;
  b.set(mime, at); at += mime.length;
  dv.setUint32(at, 0); at += 4;                       // description: none
  dv.setUint32(at, width); at += 4;
  dv.setUint32(at, height); at += 4;
  dv.setUint32(at, 24); at += 4;                      // bits per pixel
  dv.setUint32(at, 0); at += 4;                       // indexed colours: none
  dv.setUint32(at, data.length); at += 4;
  b.set(data, at);
  return base64(b);
}

/**
 * base64 of a byte array, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 200 KB cover is 200,000 arguments in one
 * call, which overflows the stack on every engine. The chunk size is a multiple
 * of three so no chunk boundary lands mid-triplet and produces padding in the
 * middle of the string.
 */
function base64(bytes) {
  const CHUNK = 12288;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
