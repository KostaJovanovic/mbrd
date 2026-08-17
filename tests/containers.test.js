// What a media container states about itself, checked against files built here.
//
// Every parser in import/containers.ts reads a handful of fields at fixed - and
// in three cases very much not fixed - offsets into somebody else's format. The
// failure mode is not a crash: it is a number that comes out plausible and
// wrong, a two-minute song reported as forty seconds because a field was read
// four bytes early. Nothing on a card would look broken.
//
// So each container is written forwards here from its own specification, with
// the duration chosen to be arithmetic anybody can check, and the parser is
// asked to read back what was written. The builders are as small as the format
// allows - a WAV with no data in it, an MP4 with no frames - because what is
// being tested is the header walk and nothing else.
//
// Same shape as tests/artwork.test.js, and for the same reason: a checked-in
// .mkv would be a binary nobody can read in a repository that has none.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaFacts } from '../web/assets/js/import/containers.ts';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const bytes = (...parts) => {
  const flat = parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [...p]));
  return Uint8Array.from(flat);
};
const le16 = n => [n & 0xff, (n >>> 8) & 0xff];
const le32 = n => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const be16 = n => [(n >>> 8) & 0xff, n & 0xff];
const be32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be64 = n => [...be32(Math.floor(n / 0x100000000)), ...be32(n >>> 0)];
const le64 = n => [...le32(n >>> 0), ...le32(Math.floor(n / 0x100000000))];
const zeros = n => new Uint8Array(n);

const file = (data, name = 'clip.bin') => new File([data], name);
// mediaFacts() takes the extension rather than the name - two of its fourteen
// branches need it, and every caller in the app has it to hand.
const facts = (data, name = 'clip.bin') => mediaFacts(file(data, name), name.split('.').pop());

/** A RIFF or IFF chunk: name, length, payload, and the pad byte on an odd one. */
const chunk = (name, payload, little = true) => {
  const body = bytes(payload);
  const len = little ? le32(body.length) : be32(body.length);
  return bytes(name, len, body, body.length & 1 ? [0] : []);
};

/** An MP4 atom. */
const atom = (name, ...payload) => {
  const body = bytes(...payload);
  return bytes(be32(body.length + 8), name, body);
};

/** A sample rate as AIFF writes it: an 80-bit IEEE 754 extended float. */
function ext80(rate) {
  const e = Math.floor(Math.log2(rate));
  const sig = BigInt(rate) << BigInt(63 - e);
  const out = [(16383 + e) >>> 8, (16383 + e) & 0xff];
  for (let i = 7; i >= 0; i--) out.push(Number((sig >> BigInt(i * 8)) & 0xffn));
  return out;
}

/** An EBML element: id bytes as written, a size, and a body. */
function ebml(id, payload) {
  const body = bytes(payload);
  const idBytes = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff);
  // Four-byte size marker, which is legal for any length and keeps this simple.
  return bytes(idBytes, [0x10, ...be32(body.length).slice(1)], body);
}

/** A one-page Ogg stream: a header page carrying `payload`, then a last page
 *  whose granule position is the sample count the whole stream ran to. */
function ogg(payload, granule) {
  const page = (gran, body, seg) => bytes(
    'OggS', [0, 0], le64(gran), le32(1), le32(0), le32(0), [seg], [body.length], body,
  );
  return bytes(page(0, bytes(payload), 1), page(granule, bytes([1, 2, 3]), 1));
}

/** One ADTS-free MPEG audio frame header, and the Xing header inside it. */
function mp3Frame({ frames = 0, mono = false } = {}) {
  // MPEG-1 Layer III, 128 kbps, 44100 Hz.
  const head = [0xff, 0xfb, 0x90, mono ? 0xc0 : 0x00];
  const pad = zeros(mono ? 17 : 32);
  const xing = frames
    ? bytes('Xing', be32(0x01), be32(frames))
    : bytes([]);
  return bytes(head, pad, xing, zeros(64));
}

// ---------------------------------------------------------------------------
// RIFF
// ---------------------------------------------------------------------------

test('a WAV states its length in bytes and its rate in the fmt chunk', async () => {
  // 44100 Hz, stereo, 16-bit: 176400 bytes a second. Half a megabyte of it is
  // 2.97... seconds, and the point is that the parser divides rather than
  // guesses.
  const fmt = chunk('fmt ', [...le16(1), ...le16(2), ...le32(44100), ...le32(176400), ...le16(4), ...le16(16)]);
  const data = chunk('data', zeros(176400 * 3));
  const wav = bytes('RIFF', le32(4 + fmt.length + data.length), 'WAVE', fmt, data);
  const f = await facts(wav, 'song.wav');
  assert.equal(f.container, 'WAV');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.channels, 2);
  assert.equal(f.duration, 3);
});

test('an AVI states its frame count and its picture size', async () => {
  // 40 ms a frame, 250 frames: ten seconds, 640x480.
  const avih = chunk('avih', [
    ...le32(40000), ...le32(0), ...le32(0), ...le32(0),
    ...le32(250), ...le32(0), ...le32(1), ...le32(0),
    ...le32(640), ...le32(480),
  ]);
  const hdrl = bytes('LIST', le32(4 + avih.length), 'hdrl', avih);
  const avi = bytes('RIFF', le32(4 + hdrl.length), 'AVI ', hdrl);
  const f = await facts(avi, 'capture.avi');
  assert.equal(f.container, 'AVI');
  assert.equal(f.duration, 10);
  assert.equal(f.width, 640);
  assert.equal(f.height, 480);
});

test('an AIFF sample rate is read out of its 80-bit float', async () => {
  // The one field in any of these formats that is an extended-precision float,
  // and the one most likely to be read wrong: 44100 frames is one second.
  const comm = chunk('COMM', [...be16(2), ...be32(44100 * 5), ...be16(16), ...ext80(44100)], false);
  const aiff = bytes('FORM', be32(4 + comm.length), 'AIFF', comm);
  const f = await facts(aiff, 'take.aiff');
  assert.equal(f.container, 'AIFF');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.channels, 2);
  assert.equal(f.duration, 5);
});

test('an AIFC is read by the same walk as an AIFF', async () => {
  const comm = chunk('COMM', [...be16(1), ...be32(48000), ...be16(16), ...ext80(48000), ...bytes('NONE')], false);
  const aifc = bytes('FORM', be32(4 + comm.length), 'AIFC', comm);
  assert.equal((await facts(aifc, 'take.aifc')).duration, 1);
});

// ---------------------------------------------------------------------------
// FLAC and Ogg
// ---------------------------------------------------------------------------

test('FLAC counts its own samples in STREAMINFO', async () => {
  // 44100 Hz, 2 channels, 16-bit, 441000 samples = ten seconds, packed across
  // eight bytes on no byte boundary at all.
  const info = zeros(34);
  // sample rate (20 bits), channels (3), bit depth (5), total samples (36):
  // 0x0AC44 is 44100, then 2 channels and 16 bits, then the count as a nibble
  // and four bytes. Not one of them starts on a byte boundary.
  info[10] = 0x0a; info[11] = 0xc4; info[12] = 0x42;
  info[13] = 0xf0;                                        // bit depth's low bits
  info[15] = 0x06; info[16] = 0xba; info[17] = 0xa8;      // 441000
  const flac = bytes('fLaC', [0x80], [0, 0, 34], info);
  const f = await facts(flac, 'song.flac');
  assert.equal(f.container, 'FLAC');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.channels, 2);
  assert.equal(f.duration, 10);
});

test('an Ogg Vorbis stream is measured from its last granule', async () => {
  const id = bytes([1], 'vorbis', be32(0), [2], le32(44100), zeros(16));
  const f = await facts(ogg(id, 44100 * 4), 'song.ogg');
  assert.equal(f.container, 'Ogg Vorbis');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.duration, 4);
});

test('Ogg Theora states the picture, and no duration it cannot count', async () => {
  // The frame is rounded up to whole macroblocks - 1088 for a 1080-line clip -
  // and the picture fields after it are the real size.
  const id = bytes([0x80], 'theora', [3, 2, 1], be16(120), be16(68),
    [0, 7, 0x80], [0, 4, 0x38], zeros(20));
  const f = await facts(ogg(id, 999999), 'clip.ogv');
  assert.equal(f.container, 'Ogg Theora');
  assert.equal(f.width, 1920);
  assert.equal(f.height, 1080);
  assert.equal(f.duration, undefined);
});

test('Opus counts granules at 48 kHz and drops its pre-skip', async () => {
  // 312 samples of encoder warm-up, which every player subtracts and which is
  // the difference between agreeing with the player and being 6 ms long.
  const head = bytes('OpusHead', [1, 2], le16(312), le32(44100), le16(0), [0]);
  const f = await facts(ogg(head, 48000 * 2 + 312), 'song.opus');
  assert.equal(f.container, 'Opus');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.duration, 2);
});

// ---------------------------------------------------------------------------
// MPEG audio
// ---------------------------------------------------------------------------

test('a VBR MP3 is measured from its Xing frame count', async () => {
  // 38 frames of 1152 samples at 44100 - the only count a VBR file carries.
  const f = await facts(mp3Frame({ frames: 38 }), 'song.mp3');
  assert.equal(f.container, 'MP3');
  assert.equal(f.sampleRate, 44100);
  assert.ok(Math.abs(f.duration - (38 * 1152) / 44100) < 1e-9);
});

test('an MP3 with no Xing header falls back to its bitrate', async () => {
  // 128 kbps CBR: 16000 bytes a second. The frame header is four bytes in.
  const data = bytes(mp3Frame(), zeros(16000 * 2));
  const f = await facts(data, 'song.mp3');
  assert.ok(Math.abs(f.duration - data.length / 16000) < 0.05);
});

test('an ID3 tag in front of the audio is stepped over', async () => {
  const tag = bytes('ID3', [4, 0, 0], [0, 0, 0, 40], zeros(40));
  const f = await facts(bytes(tag, mp3Frame({ frames: 100 })), 'song.mp3');
  assert.ok(Math.abs(f.duration - (100 * 1152) / 44100) < 1e-9);
});

// ---------------------------------------------------------------------------
// MP4
// ---------------------------------------------------------------------------

test('an MP4 states its duration in mvhd and its picture in tkhd', async () => {
  // timescale 600, duration 3600 = six seconds; 1920x1080 as 16.16 fixed point
  // at the far end of the atom, behind the display matrix.
  const mvhd = atom('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(600), be32(3600), zeros(80));
  const tkhd = atom('tkhd',
    [0, 0, 0, 7], be32(0), be32(0), be32(1), be32(0), be32(3600),
    zeros(8), be16(0), be16(0), be16(0), be16(0), zeros(36),
    be32(1920 * 65536), be32(1080 * 65536));
  const trak = atom('trak', tkhd);
  const moov = atom('moov', mvhd, trak);
  const ftyp = atom('ftyp', 'isom', be32(512), 'isomavc1');
  const f = await facts(bytes(ftyp, atom('mdat', zeros(64)), moov), 'clip.mp4');
  assert.equal(f.container, 'MP4');
  assert.equal(f.duration, 6);
  assert.equal(f.width, 1920);
  assert.equal(f.height, 1080);
});

test('the largest track wins, so a cover image does not shape the clip', async () => {
  const tkhd = (w, h) => atom('tkhd',
    [0, 0, 0, 7], be32(0), be32(0), be32(1), be32(0), be32(0),
    zeros(8), be16(0), be16(0), be16(0), be16(0), zeros(36),
    be32(w * 65536), be32(h * 65536));
  const moov = atom('moov', atom('trak', tkhd(600, 600)), atom('trak', tkhd(1280, 720)));
  const f = await facts(bytes(atom('ftyp', 'isom', be32(512), 'isom'), moov), 'clip.mov');
  assert.equal(f.width, 1280);
  assert.equal(f.height, 720);
});

test('a 64-bit mvhd is read as one', async () => {
  // Version 1: wider creation and modification times, and a 64-bit duration.
  const mvhd = atom('mvhd', [1, 0, 0, 0], be64(0), be64(0), be32(90000), be64(90000 * 12), zeros(80));
  const f = await facts(bytes(atom('ftyp', 'isom', be32(512), 'isom'), atom('moov', mvhd)), 'clip.mp4');
  assert.equal(f.duration, 12);
});

// ---------------------------------------------------------------------------
// Matroska
// ---------------------------------------------------------------------------

test('a Matroska file states its duration in scaled ticks', async () => {
  // TimecodeScale is a million nanoseconds - a millisecond a tick - and the
  // Duration is a float, which is unlike every other duration here.
  const dur = new Uint8Array(8);
  new DataView(dur.buffer).setFloat64(0, 8500);
  const info = ebml(0x1549a966, bytes(
    ebml(0x2ad7b1, [0x0f, 0x42, 0x40]),
    ebml(0x4489, dur),
  ));
  const video = ebml(0xe0, bytes(ebml(0xb0, be16(1280)), ebml(0xba, be16(720))));
  const tracks = ebml(0x1654ae6b, ebml(0xae, video));
  const mkv = bytes(ebml(0x1a45dfa3, [0x42, 0x86, 0x81, 0x01]), ebml(0x18538067, bytes(info, tracks)));
  const f = await facts(mkv, 'clip.mkv');
  assert.equal(f.container, 'Matroska');
  assert.equal(f.duration, 8.5);
  assert.equal(f.width, 1280);
  assert.equal(f.height, 720);
});

test('a Matroska duration written as an integer is still read', async () => {
  const info = ebml(0x1549a966, bytes(ebml(0x2ad7b1, [0x0f, 0x42, 0x40]), ebml(0x4489, be16(2000))));
  const mkv = bytes(ebml(0x1a45dfa3, [0x42, 0x86, 0x81, 0x01]), ebml(0x18538067, info));
  assert.equal((await facts(mkv, 'song.mka')).duration, 2);
});

// ---------------------------------------------------------------------------
// ASF and FLV
// ---------------------------------------------------------------------------

const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
  0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
const ASF_PROPS = [0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11,
  0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
const ASF_STREAM = [0x91, 0x07, 0xdc, 0xb7, 0xb7, 0xa9, 0xcf, 0x11,
  0x8e, 0xe6, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65];
const ASF_VIDEO = [0xc0, 0xef, 0x19, 0xbc, 0x4d, 0x5b, 0xcf, 0x11,
  0xa8, 0xfd, 0x00, 0x80, 0x5f, 0x5c, 0x44, 0x2b];

test('an ASF play duration has its preroll taken off', async () => {
  // 100-nanosecond units, less a preroll in milliseconds: every player
  // subtracts it, so a file that does not is three seconds long by itself.
  const props = bytes(ASF_PROPS, le64(24 + 80),
    zeros(16), le64(0), le64(0), le64(0), le64(30e7), le64(0), le64(3000), zeros(16));
  const stream = bytes(ASF_STREAM, le64(24 + 62),
    ASF_VIDEO, zeros(16), le64(0), le32(0), le32(0), le16(0), le32(0),
    le32(1024), le32(576), zeros(8));
  const asf = bytes(ASF_HEADER, le64(30 + props.length + stream.length), le32(2), [1, 2],
    props, stream);
  const f = await facts(asf, 'clip.wmv');
  assert.equal(f.container, 'ASF');
  assert.equal(f.duration, 27);
  assert.equal(f.width, 1024);
  assert.equal(f.height, 576);
});

test('an FLV is read out of its onMetaData', async () => {
  const num = (name, value) => {
    const v = new Uint8Array(8);
    new DataView(v.buffer).setFloat64(0, value);
    return bytes(be16(name.length), name, [0], v);
  };
  const flv = bytes('FLV', [1, 5], be32(9), be32(0),
    [18], [0, 0, 0], zeros(7),
    num('duration', 42.5), num('width', 854), num('height', 480));
  const f = await facts(flv, 'clip.flv');
  assert.equal(f.container, 'FLV');
  assert.equal(f.duration, 42.5);
  assert.equal(f.width, 854);
  assert.equal(f.height, 480);
});

// ---------------------------------------------------------------------------
// The elementary streams
// ---------------------------------------------------------------------------

test('AC-3 is constant bitrate, so one frame header measures the file', async () => {
  // fscod 0 is 48 kHz; frmsizecod 20 is 384 words - 768 bytes - a frame, and a
  // frame is 1536 samples. Twenty frames is 0.64 seconds.
  const frame = bytes([0x0b, 0x77], be16(0), [(0 << 6) | 20], [0], [0x00 | (2 << 5)], zeros(762));
  const ac3 = bytes(...Array.from({ length: 20 }, () => frame));
  const f = await facts(ac3, 'track.ac3');
  assert.equal(f.container, 'AC-3');
  assert.equal(f.sampleRate, 48000);
  assert.ok(Math.abs(f.duration - (20 * 1536) / 48000) < 1e-9);
});

test('the AC-3 low-frequency bit is counted to, not guessed at', async () => {
  // acmod 7 is 3/2 - five channels - and both mix-level fields are present
  // before the LFE bit, which puts it at the very bottom of the byte. A reader
  // that assumed a fixed position calls this 5 instead of 5.1.
  const bsi = (7 << 5) | 0b00000001;              // acmod 7, cmixlev, surmixlev, lfe on
  const frame = bytes([0x0b, 0x77], be16(0), [20], [0], [bsi], zeros(762));
  const f = await facts(bytes(frame, frame), 'film.ac3');
  assert.equal(f.channels, 6);

  // acmod 2 is plain stereo, where one Dolby Surround field sits in the way.
  const stereo = bytes([0x0b, 0x77], be16(0), [20], [0], [(2 << 5) | 0b00000100], zeros(762));
  assert.equal((await facts(bytes(stereo, stereo), 'song.ac3')).channels, 3);
});

test('DTS reads its block count and frame size across byte boundaries', async () => {
  // nblks 15 is 16 blocks of 32 samples - 512 - and fsize is the frame length
  // less one. 48 kHz, 2048-byte frames, eight of them.
  const bits = (15 << 18) | (2047 << 4);
  const dts = bytes(
    [0x7f, 0xfe, 0x80, 0x01], be32(bits >>> 0), [(13 << 2)], zeros(2048 * 8 - 9),
  );
  const f = await facts(dts, 'track.dts');
  assert.equal(f.container, 'DTS');
  assert.equal(f.sampleRate, 48000);
  assert.ok(Math.abs(f.duration - (8 * 512) / 48000) < 1e-9);
});

test('AMR is counted frame by frame at fifty a second', async () => {
  // Mode 7 is 32 bytes a frame, mode 15 carries nothing and is one byte, and
  // both are twenty milliseconds - which is the whole reason this walks.
  const speech = bytes([7 << 3], zeros(31));
  const quiet = bytes([15 << 3]);
  const amr = bytes('#!AMR\n', ...Array.from({ length: 50 }, (_, i) => (i % 2 ? quiet : speech)));
  const f = await facts(amr, 'note.amr');
  assert.equal(f.container, 'AMR');
  assert.equal(f.duration, 1);
});

test('a wideband AMR is the same walk with a different table', async () => {
  const frame = bytes([8 << 3], zeros(60));
  const amr = bytes('#!AMR-WB\n', ...Array.from({ length: 25 }, () => frame));
  const f = await facts(amr, 'note.amr');
  assert.equal(f.container, 'AMR-WB');
  assert.equal(f.sampleRate, 16000);
  assert.equal(f.duration, 0.5);
});

// ---------------------------------------------------------------------------
// MPEG streams
// ---------------------------------------------------------------------------

/** A 33-bit MPEG timestamp, written the way a PES header carries it: three
 *  bits, a marker, eight, seven, a marker, eight, seven and a marker. */
function pts(v) {
  const at = (shift, bits) => Math.floor(v / 2 ** shift) & ((1 << bits) - 1);
  return [
    0x20 | (at(30, 3) << 1) | 1,
    at(22, 8),
    (at(15, 7) << 1) | 1,
    at(7, 8),
    ((v & 0x7f) << 1) | 1,
  ];
}

/** A PES packet carrying one presentation stamp. */
const pes = (v, id = 0xe0) => bytes([0, 0, 1, id], be16(13), [0x80, 0x80, 5], pts(v));

/** The MPEG-2 video sequence header, which states the picture size. */
const seqHeader = (w, h) => bytes([0, 0, 1, 0xb3],
  [w >> 4, ((w & 0x0f) << 4) | (h >> 8), h & 0xff, 0x23]);

/** A transport stream: 188-byte packets, the first carrying a stamp and a
 *  sequence header, the last carrying the stamp the stream runs to. */
function ts(from, to, { w = 1280, h = 720, packets = 12 } = {}) {
  const out = new Uint8Array(TS_PACKET * packets);
  for (let i = 0; i < packets; i++) {
    const p = i * TS_PACKET;
    out.set([0x47, 0x40, 0x11, 0x10], p);
  }
  out.set(bytes(pes(from), seqHeader(w, h)), 4);
  out.set(pes(to), (packets - 1) * TS_PACKET + 4);
  return out;
}

const TS_PACKET = 188;

test('a transport stream is measured between its first and last stamps', async () => {
  // 90 kHz: nine hundred thousand ticks is ten seconds.
  const f = await facts(ts(90000, 90000 + 900000), 'clip.mts');
  assert.equal(f.container, 'MPEG-TS');
  assert.equal(f.duration, 10);
  assert.equal(f.width, 1280);
  assert.equal(f.height, 720);
});

test('a timestamp past the 32-bit mark is read whole', async () => {
  // The counter is 33 bits, so the top of it is past what a shift can hold -
  // and a reader that shifts comes out negative here rather than long.
  const base = 8_000_000_000;
  const f = await facts(ts(base, base + 90000 * 30), 'clip.ts');
  assert.equal(f.duration, 30);
});

test('a program stream is the same walk without the packets', async () => {
  const ps = bytes([0, 0, 1, 0xba], zeros(10), seqHeader(720, 576),
    pes(0), zeros(2048), pes(90000 * 90));
  const f = await facts(ps, 'movie.vob');
  assert.equal(f.container, 'MPEG-PS');
  assert.equal(f.duration, 90);
  assert.equal(f.width, 720);
  assert.equal(f.height, 576);
});

test('a stream whose stamps run backwards states no duration', async () => {
  // A 33-bit counter wraps about every 26 hours, and a stream that crosses the
  // wrap would otherwise report a negative length - or, worse, a plausible one.
  const f = await facts(ts(900000, 1000), 'clip.ts');
  assert.equal(f.duration, undefined);
  assert.equal(f.width, 1280);
});

// ---------------------------------------------------------------------------
// H.264 and H.265
// ---------------------------------------------------------------------------

/** A bit writer, which is the only way to build an Exp-Golomb parameter set -
 *  the inverse of the reader in import/containers.ts. */
class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); return this; }
  ue(v) {
    const n = Math.floor(Math.log2(v + 1));
    for (let i = 0; i < n; i++) this.bits.push(0);
    return this.u(n + 1, v + 1);
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
  }
}

/** An H.264 sequence parameter set for a picture of `w` x `h`, cropped out of
 *  the macroblock grid the way a real 1080p stream is. */
function avcSps(w, h, profile = 66) {
  const mbW = Math.ceil(w / 16);
  const mbH = Math.ceil(h / 16);
  const r = new BitWriter();
  r.u(8, profile).u(8, 0).u(8, 40);
  r.ue(0);                    // seq_parameter_set_id
  // The high profiles carry four more fields and a scaling-list flag before
  // anything else - the one branch the reader has, so the one worth writing.
  if (profile === 100) {
    r.ue(1);                  // chroma_format_idc: 4:2:0
    r.ue(0).ue(0);            // bit depths
    r.u(1, 0);                // qpprime_y_zero_transform_bypass
    r.u(1, 0);                // seq_scaling_matrix_present
  }
  r.ue(0);                    // log2_max_frame_num_minus4
  r.ue(0).ue(0);              // pic_order_cnt_type, log2_max_poc_lsb_minus4
  r.ue(1);                    // max_num_ref_frames
  r.u(1, 0);                  // gaps_in_frame_num_value_allowed
  r.ue(mbW - 1).ue(mbH - 1);
  r.u(1, 1);                  // frame_mbs_only_flag
  r.u(1, 1);                  // direct_8x8_inference_flag
  r.u(1, 1);                  // frame_cropping_flag
  r.ue(0).ue((mbW * 16 - w) / 2).ue(0).ue((mbH * 16 - h) / 2);
  r.u(1, 0);                  // vui_parameters_present_flag
  return bytes([0, 0, 0, 1, 0x67], r.bytes());
}

/** An H.265 sequence parameter set, whose picture size is stated outright. */
function hevcSps(w, h) {
  const r = new BitWriter();
  r.u(4, 0);                  // sps_video_parameter_set_id
  r.u(3, 0);                  // sps_max_sub_layers_minus1
  r.u(1, 1);                  // sps_temporal_id_nesting_flag
  for (let i = 0; i < 12; i++) r.u(8, 0);   // profile_tier_level
  r.ue(0);                    // sps_seq_parameter_set_id
  r.ue(1);                    // chroma_format_idc: 4:2:0
  r.ue(w).ue(h);
  r.u(1, 0);                  // conformance_window_flag
  return bytes([0, 0, 0, 1, 0x42, 0x01], r.bytes());
}

test('an H.264 stream states its picture in its parameter set', async () => {
  // 1080 out of a grid that codes 1088, which is what the cropping window is
  // for and what every phone video in the world needs read correctly.
  const f = await facts(bytes(avcSps(1920, 1080), zeros(2048)), 'clip.264');
  assert.equal(f.container, 'H.264');
  assert.equal(f.width, 1920);
  assert.equal(f.height, 1080);
  // A bare bitstream carries no timing at all, and saying so is the point.
  assert.equal(f.duration, undefined);
});

test('a high-profile parameter set is read past its scaling lists', async () => {
  const f = await facts(bytes(avcSps(1280, 720, 100), zeros(512)), 'clip.h264');
  assert.equal(f.width, 1280);
  assert.equal(f.height, 720);
});

test('an HEVC stream states its picture outright', async () => {
  const f = await facts(bytes(hevcSps(3840, 2160), zeros(2048)), 'clip.hevc');
  assert.equal(f.container, 'HEVC');
  assert.equal(f.width, 3840);
  assert.equal(f.height, 2160);
});

test('a start code with no parameter set behind it answers null', async () => {
  // Three bytes of anything can be a start code. Answering "H.264" for a file
  // that merely contains one would be claiming a recognition that did not happen.
  assert.equal(await facts(bytes([0, 0, 1, 0x41], zeros(4096)), 'clip.264'), null);
});

test('a truncated parameter set answers nothing absurd', async () => {
  // A parameter set cut short and padded is, byte for byte, a different and
  // perfectly readable one - so the claim here is not that the answer is right,
  // it is that there is an answer at all and that it is a picture size rather
  // than a number with eight digits in it. That bound is clean()'s, and this is
  // what walks it: the bit reader, the padding and the ceiling together.
  const whole = avcSps(1920, 1080);
  for (let cut = 5; cut < whole.length; cut++) {
    const f = await facts(bytes(whole.slice(0, cut), zeros(64)), 'clip.264');
    const sane = !f || f.width === undefined
      || (f.width > 0 && f.width <= 65535 && f.height > 0 && f.height <= 65535);
    assert.ok(sane, `cut at ${cut}`);
  }
});

// ---------------------------------------------------------------------------
// Refusing
// ---------------------------------------------------------------------------

test('a file that is not a container answers null', async () => {
  const cases = {
    'nothing at all': new Uint8Array(0),
    'a few bytes': bytes([1, 2, 3, 4]),
    'plain text': bytes('this is a text file, and it is not a movie'),
    'a PNG': bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], zeros(64)),
    'a RIFF that is neither WAVE nor AVI': bytes('RIFF', le32(64), 'PAL ', zeros(64)),
  };
  for (const [what, data] of Object.entries(cases)) {
    assert.equal(await facts(data, 'thing.dat'), null, what);
  }
});

test('a header that states no duration leaves the field absent, not zero', async () => {
  // A WAV with a fmt chunk and no data: everything about it parses and none of
  // it is a duration. The callers read the field they want and fall back where
  // it is missing, so a zero here would be a track claiming to be empty - which
  // is a claim, where an absence is not.
  const fmt = chunk('fmt ', [...le16(1), ...le16(2), ...le32(0), ...le32(0), ...le16(4), ...le16(16)]);
  const wav = bytes('RIFF', le32(4 + fmt.length), 'WAVE', fmt);
  const f = await facts(wav, 'broken.wav');
  assert.equal(f.container, 'WAV');
  assert.equal(f.duration, undefined);
  assert.equal(f.sampleRate, undefined);
});

test('a duration nobody could have recorded is refused', async () => {
  // A sample rate of one turns a small file into a hundred days. Ten days is
  // the ceiling, and past it the field is dropped rather than shown.
  const info = zeros(34);
  info[10] = 0x00; info[11] = 0x00; info[12] = 0x12;      // rate 1, 2 channels
  info[14] = 0xff; info[15] = 0xff; info[16] = 0xff;
  const flac = bytes('fLaC', [0x80], [0, 0, 34], info);
  const f = await facts(flac, 'song.flac');
  assert.equal(f?.duration, undefined);
});

test('a truncated container is a container that says less', async () => {
  // Every one of these is a real header cut off mid-field. None may throw and
  // none may answer a number it did not read.
  const mvhd = atom('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(600), be32(3600), zeros(80));
  const full = bytes(atom('ftyp', 'isom', be32(512), 'isom'), atom('moov', mvhd));
  for (let cut = 8; cut < full.length; cut += 7) {
    await facts(full.slice(0, cut), 'clip.mp4');       // must not throw
  }
});
