// Sound and moving pictures, through ffmpeg.
//
// This is the one place in the whole app that depends on somebody else's code,
// and it is written to keep that fact contained:
//
//   - it is **vendored, not fetched**. `web/assets/vendor/ffmpeg/` is served
//     from this origin like every other file here. A CDN pull would be the
//     first third-party request in an app whose first promise is that nothing
//     leaves the machine, and it would put the feature behind a network.
//   - it is **loaded on demand**. Nothing here is touched until somebody
//     presses Optimize on a board that actually has sound or video on it, and
//     it is deliberately *not* in sw.js's SHELL: thirty megabytes has no
//     business in the cache of an app that is otherwise under two.
//   - it is **single-threaded**. The threaded core needs SharedArrayBuffer,
//     which needs COOP/COEP, which would break the YouTube embeds - the one
//     third-party thing the app does offer, and only on request. Slower and
//     entirely worth it.
//   - it runs in a **worker**. A single-threaded encoder on the main thread is
//     a frozen board for the length of a song.
//
// Everything degrades to "left alone": if the files are not there, sound and
// video are skipped, the pictures still shrink, and the dialog says so before
// anything starts.

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
