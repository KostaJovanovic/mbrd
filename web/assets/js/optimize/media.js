// Moving pictures, through ffmpeg.
//
// Sound used to come through here too and no longer does: the browser can
// encode Opus by itself, and the only thing it was missing was a container, so
// opus.js writes one. Demuxing an MP4 is a much larger problem than muxing an
// Ogg, so video is still ffmpeg's - but that means a board of photographs and
// music now optimises with nothing downloaded at all, and this module is only
// woken by a board that actually has a clip on it.
//
// It stays the audio path's fallback for a browser with no WebCodecs, which in
// practice means one old enough that this is a theoretical case.
//
// This is the one place in the whole app that depends on somebody else's code,
// and it is written to keep that fact contained:
//
//   - it is **vendored, not fetched**. `web/assets/vendor/ffmpeg/` is served
//     from this origin like every other file here. A CDN pull would be the
//     first third-party request in an app whose first promise is that nothing
//     leaves the machine, and it would put the feature behind a network.
//   - it is **loaded on demand**. Nothing here is touched until somebody
//     presses Optimize on a board that actually has video on it, and it is
//     deliberately *not* in sw.js's SHELL: thirty megabytes has no business in
//     the cache of an app that is otherwise under two.
//   - it is **single-threaded**. The threaded core needs SharedArrayBuffer,
//     which needs COOP/COEP, which would break the YouTube embeds - the one
//     third-party thing the app does offer, and only on request. Slower and
//     entirely worth it.
//   - it runs in a **worker**. A single-threaded encoder on the main thread is
//     a frozen board for the length of a song.
//
// Everything degrades to "left alone": if the files are not there, video is
// skipped, the pictures and the sound still shrink, and the dialog says so
// before anything starts.

import { extOf } from '../util.js';

/** Where the core lives, relative to the page. */
const CORE_DIR = './assets/vendor/ffmpeg/';
const CORE_JS = CORE_DIR + 'ffmpeg-core.js';

/** Roughly what it weighs, for the sentence in the dialog. */
export const MEDIA_MB = 32;

/** Opus, in kbit/s. Smaller than a 192k MP3 and not tellable apart on a board. */
const AUDIO_KBPS = 96;

/** The long edge a clip keeps, matching the picture ceiling. */
const VIDEO_MAX_SIDE = 1200;

let worker = null;
let ready = null;
let present = null;

/**
 * Whether the encoder is on this machine, without loading it.
 *
 * A HEAD request against our own origin - which the service worker answers from
 * cache once it has been fetched, and which costs nothing when it 404s because
 * the files were never put there.
 */
export async function mediaAvailable() {
  if (present !== null) return present;
  try {
    const res = await fetch(CORE_JS, { method: 'HEAD' });
    present = res.ok;
  } catch {
    present = false;
  }
  return present;
}

/** What mediaAvailable() last answered, for a dialog that cannot wait. */
export const mediaReady = () => present === true;

/**
 * Bring the encoder up and hand back the function optimize.js wants:
 * `(asset, kind) => { blob } | null`.
 *
 * Throws if the files are not there. The caller treats that as "leave the sound
 * and video alone", which is what it is.
 */
export async function loadMedia(say = () => {}) {
  if (!(await mediaAvailable())) {
    throw new Error('ffmpeg core is not vendored at ' + CORE_DIR);
  }
  if (!ready) {
    say(`Loading the media encoder (${MEDIA_MB} MB, once)…`);
    ready = spawn();
  }
  await ready;
  return (asset, kind) => encode(asset, kind);
}

/** The long edge of an extracted poster frame. A card, not a screening. */
const FRAME_MAX_SIDE = 1280;

/**
 * The first frame of a clip this browser cannot open, as a picture it can.
 *
 * The case is H.265. A phone shoots HEVC by default and every desktop browser
 * except Safari refuses to decode it, so the file arrives, is registered, is
 * saved into the .mbrd - and shows on the board as a black rectangle with a
 * play button that does nothing. The bytes are all there and none of them can
 * be seen. Anything else the browser will not open lands here too - AV1 on an
 * older build, ProRes, a raw stream - because the test that sends work this way
 * is "did the browser manage to read it", not "which codec is this". That is
 * both easier to be right about and the question that actually matters.
 *
 * A poster rather than a conversion, and that is the whole restraint of it. The
 * clip is untouched: it stays exactly the file that was dropped, so it plays the
 * day the browser learns to, it exports as itself, and Optimize can still turn
 * it into something this machine can play if that is what somebody wants. What
 * this buys is that the card looks like the thing it is in the meantime.
 *
 * Null whenever anything is not right - the core is not vendored, the file is
 * not readable, the encoder is missing a format. The caller treats that as "no
 * poster", which is the black rectangle it was already going to be.
 */
export async function firstFrame(file, say = () => {}) {
  if (!(await mediaAvailable())) return null;
  if (!ready) {
    say(`Loading the media decoder (${MEDIA_MB} MB, once)…`);
    ready = spawn();
  }
  await ready;

  const ext = extOf(file.name);
  const inName = 'in' + (ext ? '.' + ext : '');
  // Two ways of writing a still, tried in order. mjpeg is the one worth having -
  // a poster is a photograph and JPEG is a tenth the size - but a core can be
  // built without that encoder, and png is in every one of them.
  const attempts = [
    { out: 'frame.jpg', type: 'image/jpeg', codec: 'mjpeg', extra: ['-q:v', '3'] },
    { out: 'frame.png', type: 'image/png', codec: 'png', extra: [] },
  ];

  for (const attempt of attempts) {
    // Read again per attempt rather than holding one copy: the bytes are
    // *transferred* into the worker, not copied, so the buffer from the first
    // attempt is detached by the time a second one would want it. Reading a file
    // twice is cheaper than keeping forty megabytes alive to avoid it.
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
    let res = null;
    try {
      res = await ask({
        type: 'run',
        inName,
        out: attempt.out,
        bytes,
        argv: [
          '-i', inName,
          // One frame, no sound, no attached pictures - just the picture stream.
          '-frames:v', '1', '-an', '-map', '0:v:0',
          '-vf', `scale='min(${FRAME_MAX_SIDE},iw)':-2:flags=lanczos`,
          '-c:v', attempt.codec, ...attempt.extra,
          '-f', 'image2', attempt.out,
        ],
      });
    } catch {
      // A refused format is not a failure of the feature; try the next writer.
    }
    if (res?.bytes?.byteLength) return new Blob([res.bytes], { type: attempt.type });
  }
  return null;
}

function spawn() {
  return new Promise((resolve, reject) => {
    worker = new Worker('./assets/js/optimize/media-worker.js');
    const onMessage = e => {
      if (e.data?.type !== 'ready') return;
      worker.removeEventListener('message', onMessage);
      e.data.ok ? resolve() : reject(new Error(e.data.error || 'core failed to start'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', err => reject(err));
    worker.postMessage({ type: 'boot', core: new URL(CORE_JS, location.href).href });
  });
}

/** One file through the worker. Null when the result is not worth keeping. */
async function encode(asset, kind) {
  const inName = 'in' + (asset.ext ? '.' + asset.ext : '');
  const out = kind === 'audio' ? 'out.opus' : 'out.webm';
  const args = kind === 'audio' ? audioArgs(inName, out) : videoArgs(inName, out);
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());

  const result = await run({ inName, out, args, bytes });
  if (!result) return null;
  const blob = new Blob([result], { type: kind === 'audio' ? 'audio/ogg' : 'video/webm' });
  // The same rule the pictures follow: a re-encode that came out bigger is not
  // an optimisation, and a lossless source that was already small stays.
  if (blob.size >= asset.blob.size * 0.9) return null;
  return { blob, from: asset.blob.size, to: blob.size };
}

/**
 * Sound: Opus, tags carried over, embedded artwork carried over where the
 * container will hold it.
 *
 * `-map 0` takes every stream, which is what keeps an attached picture; the
 * fallback below drops to the audio alone for the files where that combination
 * is refused, rather than failing the whole thing over a cover the board has
 * already extracted for itself anyway (see import/artwork.js).
 */
const audioArgs = (inName, out) => ([
  ['-i', inName, '-map', '0', '-map_metadata', '0', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-c:a', 'libopus', '-b:a', `${AUDIO_KBPS}k`, '-vbr', 'on', out],
  ['-i', inName, '-map', '0:a', '-map_metadata', '0',
    '-c:a', 'libopus', '-b:a', `${AUDIO_KBPS}k`, '-vbr', 'on', out],
]);

/**
 * Moving pictures: VP9 and Opus in WebM, capped on the long edge.
 *
 * `-crf` with `-b:v 0` is VP9's constant-quality mode; 36 is the "this is a
 * moodboard, not a screening" end of the useful range. `-cpu-used 4` is the
 * compromise that makes a single-threaded wasm encoder finish this decade.
 *
 * The scale expression only ever shrinks - `min(iw,1200)` - and `-2` keeps the
 * other axis even, which every block-based codec requires.
 */
const videoArgs = (inName, out) => ([
  ['-i', inName, '-map_metadata', '0',
    '-vf', `scale='min(${VIDEO_MAX_SIDE},iw)':-2:flags=lanczos`,
    '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4',
    '-c:a', 'libopus', '-b:a', `${AUDIO_KBPS}k`, out],
]);

/** Try each argument list in turn; the first that produces bytes wins. */
async function run({ inName, out, args, bytes }) {
  for (const argv of args) {
    const res = await ask({ type: 'run', inName, out, argv, bytes });
    if (res?.bytes?.byteLength) return res.bytes;
  }
  return null;
}

let seq = 0;
function ask(msg) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMessage = e => {
      if (e.data?.id !== id) return;
      worker.removeEventListener('message', onMessage);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    worker.addEventListener('message', onMessage);
    // The bytes are transferred rather than copied: a 40MB file has no business
    // existing twice while it is being handed over.
    worker.postMessage({ ...msg, id }, [msg.bytes.buffer]);
  });
}
