// Video on the board — play button over the picture, no native controls.
// Seek/position/mute live in the now-playing bar (pinned to the glass,
// survives panning). Only a play button here; it hides once playing.

// No PAUSE_ICON: the only button here is the big one over the picture, and it
// is a play button that goes away rather than one that turns into a pause.
import { registerPlayer } from './audio.ts';
import { toast } from '../notify.ts';
import { PLAY_ICON } from '../media/transport.ts';
import type { Item } from '../board-model.ts';

/**
 * Where a parked video sits: the `#t=` fragment canvas/renderers.ts mounts a
 * desktop clip at, for a real poster frame instead of black.
 *
 * Lives here rather than beside the `v.src` line that writes it because
 * canvas/items.ts compares `currentTime` against it for the node cull —
 * comparing against 0 instead exempted every desktop video from culling and
 * leaked one detached `<video>` per card panned over. 0.1s rather than 0
 * because a decoder at t=0 often has nothing decoded yet and paints black.
 */
export const POSTER_TIME = 0.1;

/**
 * The transport for one video item. Takes the `<video>` rather than making it,
 * as buildTransport() does for `<audio>` — canvas/renderers.ts sets its source
 * and aspect handling.
 */
export function buildVideoPlayer(item: Item, video: HTMLVideoElement): HTMLElement {
  const player = document.createElement('div');
  player.className = 'vplayer';

  // One play button, over the middle of the picture — the only thing on a
  // card that says "this moves" (otherwise a parked video is indistinguishable
  // from a photo). Visible while paused, gone while playing.
  //
  // There used to also be a small one in the transport bar, but that was just
  // a 25px target laid over the picture on a control that fades out, while the
  // obvious thing to press — the picture itself — did nothing. So pausing
  // moved to the card: a tap anywhere on a playing video stops it (see
  // canvas/input.ts, on the lift of a press that never travelled). This big
  // button is what starts it again.
  const big = document.createElement('button');
  big.type = 'button';
  big.className = 'vbig';
  big.setAttribute('aria-label', 'Play');
  big.innerHTML = PLAY_ICON;

  player.append(big);

  // ---- controls ---------------------------------------------------------

  const toggle = () => {
    // Touch devices mount without a source, so a parked video holds no decoder
    // (iOS rations them; a board of live ones crashes the tab). Attach on
    // first play; a no-op on every toggle after that.
    if (!video.src && video.dataset.src) video.src = video.dataset.src;
    if (!video.paused) { video.pause(); return; }
    video.play().catch(err => {
      // Never swallowed: a rejected play() is usually the browser refusing,
      // not a broken file, and an empty catch leaves a card silently dead.
      toast(err && err.name === 'NotAllowedError'
        ? 'Your browser blocked playback — allow media for this site'
        : 'Could not play this video');
    });
  };
  big.addEventListener('click', toggle);

  // is-playing does two things elsewhere: takes the big button off the
  // picture, and lets #world's `:has()` rules hide the caption plate over a
  // running clip.
  video.addEventListener('play', () => player.classList.add('is-playing'));
  video.addEventListener('pause', () => player.classList.remove('is-playing'));
  // Rewound rather than left on the last frame, so the big button reappears
  // over the clip's start and a second viewing is one click.
  video.addEventListener('ended', () => { video.currentTime = 0; });

  // No seek and no frame loop — both moved to the bar (see file header),
  // taking with them a per-card requestAnimationFrame for every playing clip.

  // The item is passed so the exclusive-playback rule can name what's
  // playing, and so the now-playing bar can pick its notation by type
  // (ui/nowplaying.ts).
  registerPlayer(video, item);
  return player;
}
