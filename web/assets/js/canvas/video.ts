// Moving pictures on the board, with a transport the board owns.
//
// What was here before was a bare <video>: no controls, muted, looping, and
// playable only by double-clicking it. Every part of that is a way of not
// working. Muted means a video on a moodboard has no sound, ever. No controls
// means nothing on the card says it is playable, there is no way to pause, no
// way to seek, and no way to tell how long the clip is. And double-click is
// the canvas's zoom-to-fit gesture everywhere else, so the one interaction
// that did anything was both invisible and inconsistent with the rest of the
// board.
//
// The obvious fix is `controls`, and it is the wrong one for the same reason
// canvas/audio.js gives: the native widget is the one piece of chrome a
// browser will not let you restyle, so it puts a slab of vendor-grey plastic
// on a board whose whole premise is that it is a sheet of paper you chose the
// colour of. This draws the same three affordances - play, seek, position - in
// the board's own tokens.
//
// Deliberately shallow next to the audio transport. An audio card is nothing
// *but* its player, so it earns a measured waveform; a video already shows you
// what it is, and its controls are laid over the picture, where every pixel
// spent is a pixel of the thing you pinned up. So: a plain progress line, and
// a bar that stays out of the way until the pointer is on the card.

// No PAUSE_ICON: the only button here is the big one over the picture, and it
// is a play button that goes away rather than one that turns into a pause.
import { registerPlayer } from './audio.ts';
import { clamp } from '../util.ts';
import { toast } from '../notify.ts';
import { bindScrub, clock, PLAY_ICON, seekInnerHTML, sizeSeekWave } from '../media/transport.ts';
import type { Item } from '../board-model.ts';

/**
 * Where a parked video sits: the `#t=` media fragment canvas/renderers.js mounts
 * a desktop clip at, which buys a real poster frame instead of a black
 * rectangle.
 *
 * Here rather than beside the `v.src` line that writes it, because it is not a
 * private detail of the renderer - it is the value two other places have to
 * compare against, and comparing against zero instead is what made them both
 * wrong. canvas/items.js read `currentTime > 0` as "this clip is doing
 * something" and so exempted every desktop video card from the node cull, which
 * left the cache growing one detached <video> per card panned over for the life
 * of the tab; the transport below read the same thing as "this clip has been
 * played" and put 0:00 where the running time goes.
 *
 * A tenth of a second rather than zero because a decoder handed t=0 often has
 * nothing decoded yet and paints the black frame this exists to avoid. Small
 * enough that it is the first frame to anybody looking at it.
 */
export const POSTER_TIME = 0.1;

const SOUND_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.4L8.8 3.1v9.8L5.4 10H3z" fill="currentColor"/>' +
  '<path d="M11 5.6a3.4 3.4 0 010 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const MUTED_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.4L8.8 3.1v9.8L5.4 10H3z" fill="currentColor"/>' +
  '<path d="M10.8 6.2l3.4 3.6M14.2 6.2l-3.4 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/**
 * The transport for one video item.
 *
 * Takes the <video> rather than making it, exactly as buildTransport() takes
 * the <audio>: the element is the engine, and canvas/renderers.js is where an
 * item's media gets its source and its aspect handling.
 */
export function buildVideoPlayer(item: Item, video: HTMLVideoElement): HTMLElement {
  const player = document.createElement('div');
  player.className = 'vplayer';

  // One play button, over the middle of the picture.
  //
  // It is the only thing on a card that says "this moves" - a video parked on
  // its poster frame is otherwise indistinguishable from a photograph, which is
  // precisely the state the old bare <video> left every clip in. It is there
  // while paused and gone while playing.
  //
  // There used to be a second, small one at the left of the transport bar, and
  // the argument for it was that a transport's play button belongs in the
  // transport. What it actually bought was a 25px target to stop a clip with,
  // laid over the picture, on a control that fades out until you point at the
  // card - while the obvious thing to press, the picture itself, did nothing.
  // So the pause moved to the card: a tap anywhere on a playing video stops it,
  // which canvas/input.js does on the lift of a press that never travelled. The
  // big button is what starts it again, because a paused card has to keep some
  // mark saying it is a clip and not a photograph.
  const big = iconButton('vbig', 'Play', PLAY_ICON);

  const bar = document.createElement('div');
  bar.className = 'transport transport-video';

  const track = document.createElement('div');
  track.className = 'vtrack';
  // The same slider contract canvas/audio.js's waveform signs: focusable,
  // driven by the arrow keys, and reporting where it is. A role without those
  // is worse than no role - it announces a control that cannot be operated.
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', 'Seek');
  track.setAttribute('aria-valuemin', '0');
  track.tabIndex = 0;
  // The same three-svg scrubber the now-playing bar, the playlist window and
  // canvas/audio.js's own line all draw, so every seek on the board waves
  // together at the soft end of the whimsy axis - see the note in media/transport.js.
  track.innerHTML = seekInnerHTML('vt');
  const trackWave = track.querySelector('.vt-wave-svg');
  const trackWavePath = track.querySelector('.vt-fill-wave');
  // On a resize rather than on a playback frame: the path is a string built in a
  // loop over the width, so laying it per frame would rebuild it sixty times a
  // second to arrive at the same characters. A video card is resizable, which is
  // why it is laid more than once at all.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => sizeSeekWave(track, trackWave, trackWavePath)).observe(track);
  }

  const time = document.createElement('span');
  time.className = 'transport-time';
  time.textContent = '0:00';

  const mute = iconButton('vmute', 'Mute', SOUND_ICON);

  bar.append(track, time, mute);
  player.append(big, bar);

  // ---- painting ---------------------------------------------------------

  const paint = () => {
    const at = video.duration ? clamp(video.currentTime / video.duration, 0, 1) : 0;
    // A custom property the clip-path reads, rather than a transform: a wave
    // scaled on X is a wave whose frequency changes as the clip plays. Still a
    // compositor-only write, which matters because this runs on every frame of
    // playback.
    track.style.setProperty('--vt-progress', at.toFixed(4));
    // A parked clip shows how long it is; once it has started, where you are in
    // it. The old readout was currentTime alone, so every unplayed video on the
    // board said 0:00 and nothing anywhere gave its length.
    //
    // Measured against POSTER_TIME rather than zero, because that is where a
    // parked clip actually sits: the desktop path mounts the source at the
    // poster fragment, so `!video.currentTime` was false for every clip nobody
    // had touched and the length went back to never being shown. The touch path
    // holds the source back entirely and reads 0:00 for a different reason -
    // `duration` is NaN until the first play - which this does not address.
    const parked = video.paused && video.currentTime <= POSTER_TIME;
    time.textContent = clock(parked ? (video.duration || 0) : (video.currentTime || 0));
    // String() rather than the number these two used to be handed: setAttribute
    // was doing the conversion itself, and this is that conversion said aloud.
    track.setAttribute('aria-valuemax', String(Math.round(video.duration || 0)));
    track.setAttribute('aria-valuenow', String(Math.round(video.currentTime || 0)));
    track.setAttribute('aria-valuetext',
      `${clock(video.currentTime || 0)} of ${clock(video.duration || 0)}`);
  };

  // Driven by the frame clock while playing, for the reason the waveform is:
  // timeupdate fires about four times a second, which is fine for a digit and
  // nowhere near enough for a line that is supposed to glide.
  let frame = 0;
  const follow = () => {
    paint();
    frame = video.paused ? 0 : requestAnimationFrame(follow);
  };

  // ---- controls ---------------------------------------------------------

  const toggle = () => {
    // On a touch device the renderer mounts the clip without a source, so a
    // parked video holds no decoder (iOS rations them, and a whole board of live
    // ones crashes the tab). Attach it on the first play; once video.src is set
    // this is a no-op on every toggle after.
    if (!video.src && video.dataset.src) video.src = video.dataset.src;
    if (!video.paused) { video.pause(); return; }
    video.play().catch(err => {
      // Never swallowed, for the reason audio.js spells out: a rejected play()
      // is usually the browser refusing rather than the file being broken, and
      // an empty catch is how a card becomes silently dead with nothing in the
      // console to say why.
      toast(err && err.name === 'NotAllowedError'
        ? 'Your browser blocked playback — allow media for this site'
        : 'Could not play this video');
    });
  };
  big.addEventListener('click', toggle);

  mute.addEventListener('click', () => {
    video.muted = !video.muted;
    mute.innerHTML = video.muted ? MUTED_ICON : SOUND_ICON;
    mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    player.classList.toggle('is-muted', video.muted);
  });

  // On the player and not on the bar. The bar carried the same class so it
  // could stay up for the length of a clip, and that is exactly what the
  // two-second linger replaced - a bar pinned open by playback is one that
  // never goes away, since a playing clip never stops playing. The player's own
  // is-playing still does real work: it takes the big button off the picture,
  // and #world's `:has()` rules hide the caption plate over a running clip.
  video.addEventListener('play', () => {
    player.classList.add('is-playing');
    if (!frame) frame = requestAnimationFrame(follow);
  });
  video.addEventListener('pause', () => {
    player.classList.remove('is-playing');
    paint();
  });
  video.addEventListener('loadedmetadata', paint);
  // Covers everything the frame loop cannot see: a seek while paused, a
  // buffering stall, currentTime written from outside.
  video.addEventListener('timeupdate', paint);
  video.addEventListener('seeked', paint);
  // Rewound rather than left on the last frame, so the big button comes back
  // over the picture the clip started from and a second viewing is one click.
  video.addEventListener('ended', () => { video.currentTime = 0; paint(); });

  // ---- scrubbing --------------------------------------------------------

  const seekTo = (clientX: number) => {
    if (!video.duration) return;
    const box = track.getBoundingClientRect();
    if (!box.width) return;
    video.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * video.duration;
    paint();
  };

  // The shared gesture - see bindScrub() in audio.js for why it is captured.
  // It lived here first and the audio waveform went without it, which is how
  // one of the two seek controls on this board came to be draggable and the
  // other only clickable.
  bindScrub(track, seekTo);

  /** Seek by `secs`, or to an absolute point when `to` is given. */
  const seekBy = (secs: number, to: number | null = null) => {
    if (!video.duration) return;
    video.currentTime = clamp(to != null ? to : video.currentTime + secs, 0, video.duration);
    paint();
  };

  // stopPropagation is load-bearing: these are the canvas's keys too, and
  // without it an arrow would seek the clip *and* nudge the selection.
  track.addEventListener('keydown', e => {
    const step = e.shiftKey ? 1 : 5;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': seekBy(step); break;
      case 'ArrowLeft': case 'ArrowDown': seekBy(-step); break;
      case 'PageUp': seekBy(30); break;
      case 'PageDown': seekBy(-30); break;
      case 'Home': seekBy(0, 0); break;
      case 'End': seekBy(0, video.duration); break;
      case ' ': case 'Enter': toggle(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  // The item goes with it so the exclusive-playback rule can name what is
  // playing - and so the now-playing bar can, since it carries video as well as
  // audio and reads the type to pick its notation (ui/nowplaying.js).
  registerPlayer(video, item);
  paint();
  return player;
}

function iconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon;
  return b;
}
