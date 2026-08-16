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
// colour of. This draws what is left in the board's own tokens.
//
// ── One button, and what the bar at the foot took ──
//
// Seek, position and mute are not here any more, and the whole of this file is
// what is left after they went: a play button in the middle of the picture.
//
// The now-playing bar carries a scrubber for whatever is sounding, video
// included, and it is *pinned to the glass* - so the seek line on the card was
// the same control drawn a second time, in the one place it is worst: laid over
// the picture, faded out until the pointer is on the card, and gone the moment
// the clip is panned away from. A card cannot hold a seek that survives the
// board moving. The bar can.
//
// Mute went with the chin those two lived on. It looks like a property of this
// clip rather than of the room, which is the argument for keeping it - but only
// one thing on a board plays at a time (the exclusivity rule in canvas/audio.js),
// so the level on the bar already governs whatever is making a noise, and it is
// on screen for exactly as long as something is. A per-card mute was a second
// way to silence the one clip the bar could already silence, and it cost a strip
// of paper across the foot of every video on the board - which on a card whose
// whole content is a picture is the most expensive place to put anything.
//
// An audio card kept its waveform through the same change, and the asymmetry is
// the one this file always described: an audio card is nothing *but* its player
// and a measured waveform is the whole of what it has to show, while a video
// already shows you what it is and every pixel of chrome over it is a pixel of
// the thing you pinned up.

// No PAUSE_ICON: the only button here is the big one over the picture, and it
// is a play button that goes away rather than one that turns into a pause.
import { registerPlayer } from './audio.ts';
import { toast } from '../notify.ts';
import { PLAY_ICON } from '../media/transport.ts';
import type { Item } from '../board-model.ts';

/**
 * Where a parked video sits: the `#t=` media fragment canvas/renderers.js mounts
 * a desktop clip at, which buys a real poster frame instead of a black
 * rectangle.
 *
 * Here rather than beside the `v.src` line that writes it, because it is not a
 * private detail of the renderer - it is the value the cull has to compare
 * against, and comparing against zero instead is what made it wrong.
 * canvas/items.js read `currentTime > 0` as "this clip is doing something" and
 * so exempted every desktop video card from the node cull, which left the cache
 * growing one detached <video> per card panned over for the life of the tab.
 * The card's own clock used to read it too, for the same reason and to the same
 * end; that clock is the now-playing bar's now.
 *
 * A tenth of a second rather than zero because a decoder handed t=0 often has
 * nothing decoded yet and paints the black frame this exists to avoid. Small
 * enough that it is the first frame to anybody looking at it.
 */
export const POSTER_TIME = 0.1;

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
  const big = document.createElement('button');
  big.type = 'button';
  big.className = 'vbig';
  big.setAttribute('aria-label', 'Play');
  big.innerHTML = PLAY_ICON;

  player.append(big);

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

  // is-playing does two things and both are elsewhere: it takes the big button
  // off the picture, and #world's `:has()` rules hide the caption plate over a
  // running clip.
  video.addEventListener('play', () => player.classList.add('is-playing'));
  video.addEventListener('pause', () => player.classList.remove('is-playing'));
  // Rewound rather than left on the last frame, so the big button comes back
  // over the picture the clip started from and a second viewing is one click.
  video.addEventListener('ended', () => { video.currentTime = 0; });

  // No seek and no frame loop. Both were here and both are the bar's now - see
  // the head of this file. What went with them is a per-card requestAnimationFrame
  // for every clip playing on the board, which was one loop that existed to move
  // a line the pointer had to be resting on the card to see.

  // The item goes with it so the exclusive-playback rule can name what is
  // playing - and so the now-playing bar can, since it carries video as well as
  // audio and reads the type to pick its notation (ui/nowplaying.js).
  registerPlayer(video, item);
  return player;
}
