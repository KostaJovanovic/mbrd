// A YouTube link that can become a player, if you ask it to.
//
// This is the only place in mbrd that will ever talk to a third party, and the
// whole file is arranged around making that a choice rather than a default.
//
// The rule everywhere else is that a board renders the same with the network
// off, and that opening one tells nobody. Link cards keep it by refusing to
// fetch a title, a favicon or a preview - see the `link` renderer. An embed
// cannot keep it: it is Google's page, running Google's code, and loading it
// says "somebody has this video on a board" to a server that logs it.
//
// So the trade is made explicitly and per click:
//
//   - Nothing loads on render. A YouTube link is a link card like any other,
//     with one extra button on it.
//   - The choice is *not* remembered. A per-item `embed: true` in the .mbrd
//     would be friendlier and is exactly wrong: it would turn one click today
//     into a silent request every time the board is opened, on any machine it
//     is ever copied to, and the person opening it would have no idea. If the
//     click is the consent, the click has to happen each time.
//   - youtube-nocookie.com, and `referrerpolicy=no-referrer` so the board's own
//     address stays out of their logs - the same reason link anchors carry
//     `rel=noreferrer`.
//
// The id is validated before it is used, on the same principle as `linkURL`: a
// .mbrd is a file anyone can edit by hand, and an iframe src is a place a
// string out of one must never arrive unchecked.

import { byId, snapshotGeom, applyGeom, commitGeom } from '../state.js';

/** Exactly what YouTube ids are: eleven characters of base64url. */
const ID = /^[\w-]{11}$/;

/**
 * The video id in a URL, or null.
 *
 * Four shapes carry one: the watch page, the short domain, a /shorts/ and an
 * /embed/. Anything else on the domain - a channel, a playlist on its own, the
 * home page - is a link and stays a link.
 *
 * Takes a URL object, not a string, so the caller has already been through
 * `linkURL` and the scheme is known to be http(s).
 */
export function youTubeId(u) {
  if (!u) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1);
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (u.pathname.startsWith('/shorts/')) id = u.pathname.slice(8);
    else if (u.pathname.startsWith('/embed/')) id = u.pathname.slice(7);
  }
  // A path can carry more after the id (`/shorts/ID/comments`), and the check
  // below is what makes that safe to slice off rather than a reason to reject.
  if (id) id = id.split('/')[0];
  return id && ID.test(id) ? id : null;
}

/**
 * The button that offers the trade, and the swap it performs.
 *
 * Returned rather than appended so the renderer decides where it sits, and so
 * this file never has to know what a link card looks like.
 */
export function embedOffer(item, id, card) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'yt-play';
  btn.title = 'Loads the player from YouTube. Nothing is requested until you press this.';
  btn.append(playGlyph(), text('Watch here'));

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    fitToVideo(item.id);
    card.classList.add('has-embed');
    // The name row stays, and it is not decoration: an iframe is another
    // origin, so every pointer event inside it belongs to YouTube and never
    // reaches this page. A card that was nothing but frame could not be
    // dragged, selected, or even clicked to bring its resize grips up. The
    // line above the picture is the part of the card that is still ours.
    for (const el of [...card.children]) {
      if (!el.classList.contains('card-name')) el.remove();
    }
    card.append(frameFor(id));
  });
  return btn;
}

/**
 * A link card is 320x132 and a video is not. Resized on the way in, as one
 * undoable step, so the player is a player rather than a letterboxed strip -
 * and so the card goes back to being a card if the change is not wanted.
 *
 * The width is whatever the card already had, so an item deliberately made
 * large stays large; only the height is derived: 16:9 for the picture, plus a
 * fixed allowance for the name row and the card's own padding above it.
 */
const CHROME = 38;

function fitToVideo(itemId) {
  const it = byId(itemId);
  if (!it) return;
  const want = Math.round(it.w * 9 / 16) + CHROME;
  if (Math.abs(it.h - want) < 2) return;
  const before = snapshotGeom([itemId]);
  applyGeom([{ id: itemId, x: it.x, y: it.y, w: it.w, h: want, rot: it.rot, z: it.z }]);
  commitGeom('Fit the player', before);
}

/**
 * The iframe.
 *
 * `src` is assembled from a template and an id that has already matched
 * /^[\w-]{11}$/, so there is nothing in it a hand-edited board could steer.
 * Set as a property on a real element, never as markup - the same rule the
 * link renderer follows for `href`.
 *
 * No `autoplay`: the click that got here asked for a player, not for sound.
 * The one inside the player is the second, deliberate one.
 */
function frameFor(id) {
  const frame = document.createElement('iframe');
  frame.className = 'yt-frame';
  frame.src = `https://www.youtube-nocookie.com/embed/${id}`;
  frame.title = 'YouTube video player';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.allow = 'accelerometer; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  // Anything else would be a handle on this page: the frame is another origin
  // and must stay one. allow-same-origin refers to *its* origin, not ours, and
  // without it YouTube's player cannot reach its own storage and refuses to
  // start.
  frame.setAttribute('sandbox',
    'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
  return frame;
}

function text(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el;
}

function playGlyph() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M5 3.4v9.2L13 8z');
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
