// The links that can become players, if you ask them to.
//
// This is the only place in mbrd that will ever talk to a third party, and the
// whole file is arranged around making that a choice rather than a default.
//
// The rule everywhere else is that a board renders the same with the network
// off, and that opening one tells nobody. Link cards keep it by refusing to
// fetch a title, a favicon or a preview - see the `link` renderer. An embed
// cannot keep it: it is somebody else's page running somebody else's code, and
// loading it says "this board has this track on it" to a server that logs it.
//
// So the trade is made explicitly and per click:
//
//   - Nothing loads on render. A YouTube or Spotify link is a link card like
//     any other, with one extra button on it.
//   - The choice is *not* remembered. A per-item `embed: true` in the .mbrd
//     would be friendlier and is exactly wrong: it would turn one click today
//     into a silent request every time the board is opened, on any machine it
//     is ever copied to, and the person opening it would have no idea. If the
//     click is the consent, the click has to happen each time.
//   - The most private host each provider offers - youtube-nocookie.com - and
//     `referrerpolicy=no-referrer` so the board's own address stays out of
//     their logs, the same reason link anchors carry `rel=noreferrer`.
//
// Every id is validated before it is used, on the same principle as `linkURL`:
// a .mbrd is a file anyone can edit by hand, and an iframe src is a place a
// string out of one must never arrive unchecked. Each provider below states the
// exact shape of its ids, the src is a fixed template with one hole in it, and
// nothing else can reach the hole.

import { byId, snapshotGeom, applyGeom, commitGeom } from '../state.ts';
import type { Item } from '../board-model.ts';

/**
 * Everything the offer and the frame need about one provider's player. One
 * shape for both, so the renderer asks one question - see embedFor().
 */
export type EmbedSpec = {
  provider: 'youtube' | 'spotify';
  src: string;
  page: string;
  title: string;
  label: string;
  hint: string;
  allow: string;
  /** The card height this player wants, given the width the card already has. */
  heightFor: (w: number) => number;
};

/**
 * The height the card's own furniture needs above the frame: the name row and
 * the padding over it. Every provider adds it to whatever its player wants.
 */
const CHROME = 38;

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/** Exactly what YouTube ids are: eleven characters of base64url. */
const YT_ID = /^[\w-]{11}$/;

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
export function youTubeId(u: URL | null | undefined): string | null {
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
  return id && YT_ID.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

/** A Spotify id is 22 characters of base62. Nothing else is one. */
const SP_ID = /^[A-Za-z0-9]{22}$/;

/**
 * What Spotify will embed, and how tall each one wants to be.
 *
 * The heights are not arbitrary and they are not ours to choose freely: the
 * player decides its own layout from the height it is given, so these are the
 * two the layouts exist at. 152 is the compact bar - artwork, title, a play
 * button - which is what a single track is. 352 is the one with a track list
 * under it, which is the only sensible shape for a thing that has a track list.
 *
 * Resizing the card afterwards is not prevented and does the right thing: drag
 * a track's card taller and Spotify re-lays it out as the big player, because
 * the frame is 100% of the card and the player is reading its own box.
 */
const SPOTIFY = {
  track: 152,
  episode: 152,
  album: 352,
  playlist: 352,
  artist: 352,
  show: 352,
};

/** The kinds above, and the predicate that lets a path segment become one. */
type SpotifyKind = keyof typeof SPOTIFY;
const isSpotifyKind = (k: string): k is SpotifyKind => Object.hasOwn(SPOTIFY, k);

/**
 * The { kind, id } a Spotify URL carries, or null.
 *
 * Three prefixes have to come off before the interesting part: a locale
 * (`/intl-de/track/…`, which is what a share link from a non-English client
 * looks like), an `/embed`, and an `/embed-podcast`. They can appear together.
 * What is left is /kind/id, and both halves are checked against the tables
 * above rather than passed through.
 */
export function spotifyRef(u: URL | null | undefined): { kind: SpotifyKind; id: string } | null {
  if (!u) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  while (parts.length && (/^intl-[a-z]{2,3}$/i.test(parts[0]) || parts[0] === 'embed' || parts[0] === 'embed-podcast')) {
    parts.shift();
  }
  const [kind, id] = parts;
  if (!kind || !isSpotifyKind(kind) || !id || !SP_ID.test(id)) return null;
  return { kind, id };
}

// ---------------------------------------------------------------------------
// What a link turns out to be
// ---------------------------------------------------------------------------

/**
 * The player behind a URL, as everything the offer and the frame need, or null.
 *
 * One shape for both providers so the renderer asks one question and the button
 * has one thing to hold. `page` is the canonical link - what the card stores
 * and what the name row points at - which matters because a pasted embed URL
 * should leave a card that says open.spotify.com/track/… rather than
 * open.spotify.com/embed/track/….
 */
export function embedFor(u: URL | null | undefined): EmbedSpec | null {
  const yt = youTubeId(u);
  if (yt) {
    return {
      provider: 'youtube',
      src: `https://www.youtube-nocookie.com/embed/${yt}`,
      page: `https://www.youtube.com/watch?v=${yt}`,
      title: 'YouTube video player',
      label: 'Watch here',
      hint: 'Loads the player from YouTube. Nothing is requested until you press this.',
      allow: 'accelerometer; encrypted-media; picture-in-picture; fullscreen',
      // 16:9 for the picture, plus the card's own furniture.
      heightFor: w => Math.round(w * 9 / 16) + CHROME,
    };
  }

  const sp = spotifyRef(u);
  if (sp) {
    return {
      provider: 'spotify',
      // theme=0 is Spotify's light variant. It is the one lever the player
      // gives from outside, and it is worth pulling: the default is a black
      // slab, and a black slab on a sheet of papyrus is the one thing on the
      // whole board that looks like it was cut out of a different app.
      src: `https://open.spotify.com/embed/${sp.kind}/${sp.id}?theme=0`,
      page: `https://open.spotify.com/${sp.kind}/${sp.id}`,
      title: `Spotify ${sp.kind} player`,
      label: 'Listen here',
      hint: 'Loads the player from Spotify. Nothing is requested until you press this.',
      allow: 'encrypted-media; clipboard-write; picture-in-picture; fullscreen',
      // Flat, not a ratio: the player picks its layout from its height, so this
      // is a layout being asked for rather than a shape being preserved.
      heightFor: () => SPOTIFY[sp.kind] + CHROME,
    };
  }

  return null;
}

/**
 * The src out of a pasted `<iframe>`, as a URL, or null.
 *
 * Every one of these providers hands out a block of HTML rather than a link,
 * and pasting that block is a thing people do - so it lands as the card the
 * link would have made instead of as a sticky note full of angle brackets.
 *
 * Read with a regular expression and never parsed as HTML, which is the whole
 * of the safety argument. Nothing here builds a node out of the pasted string,
 * so there is no markup to be executed and no attribute to be honoured; one
 * quoted value is pulled out as text and then has to survive `linkURL` - and,
 * if it is going to become a frame, a provider's id pattern as well.
 */
export function iframeURL<T>(text: unknown, parse: (raw: string) => T): T | null {
  const s = String(text ?? '').trim();
  if (!/^<iframe[\s>]/i.test(s)) return null;
  const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(s);
  const raw = m && (m[1] ?? m[2]);
  if (!raw) return null;
  // The one entity that matters here: a `src` written out by any of these
  // generators separates its query parameters with `&amp;`. Replaced by hand
  // rather than by letting an HTML parser near the string.
  return parse(raw.replace(/&amp;/gi, '&'));
}

// ---------------------------------------------------------------------------
// The offer, and the swap
// ---------------------------------------------------------------------------

/**
 * The button that offers the trade, and the swap it performs.
 *
 * Returned rather than appended so the renderer decides where it sits, and so
 * this file never has to know what a link card looks like.
 */
export function embedOffer(item: Item, spec: EmbedSpec, card: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'embed-go';
  btn.dataset.provider = spec.provider;
  btn.title = spec.hint;
  btn.append(glyph(spec.provider), text(spec.label));

  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    fitToPlayer(item.id, spec);
    card.classList.add('has-embed');
    // The name row stays, and it is not decoration: an iframe is another
    // origin, so every pointer event inside it belongs to the provider and
    // never reaches this page. A card that was nothing but frame could not be
    // dragged, selected, or even clicked to bring its resize grips up. The
    // line above the player is the part of the card that is still ours.
    for (const el of [...card.children]) {
      if (!el.classList.contains('card-name')) el.remove();
    }
    card.append(frameFor(spec));
  });
  return btn;
}

/**
 * A link card is 256x106 and a player is not. Resized on the way in, as one
 * undoable step, so the player is a player rather than a letterboxed strip.
 *
 * Only the resize is undoable. The swap to the iframe (embedOffer) is a DOM
 * change the item model does not carry, so undoing 'Fit the player' gives the
 * size back but not the link - the card stays a player in a link-sized box until
 * the next rebuild. Reversing the embed itself is not offered.
 *
 * The width is whatever the card already had, so an item deliberately made
 * large stays large; only the height is derived, by the provider, from the
 * layout its player is going to choose.
 */
function fitToPlayer(itemId: string, spec: EmbedSpec) {
  const it = byId(itemId);
  if (!it) return;
  const want = spec.heightFor(it.w);
  if (Math.abs(it.h - want) < 2) return;
  const before = snapshotGeom([itemId]);
  applyGeom([{ id: itemId, x: it.x, y: it.y, w: it.w, h: want, rot: it.rot, z: it.z }]);
  commitGeom('Fit the player', before);
}

/**
 * The iframe.
 *
 * `src` was assembled from a template and an id that has already matched its
 * provider's pattern, so there is nothing in it a hand-edited board could
 * steer. Set as a property on a real element, never as markup - the same rule
 * the link renderer follows for `href`.
 *
 * No `autoplay` in the allow list: the click that got here asked for a player,
 * not for sound. The one inside the player is the second, deliberate one.
 */
function frameFor(spec: EmbedSpec): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = 'embed-frame';
  frame.dataset.provider = spec.provider;
  frame.src = spec.src;
  frame.title = spec.title;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.allow = spec.allow;
  frame.allowFullscreen = true;
  // Anything else would be a handle on this page: the frame is another origin
  // and must stay one. allow-same-origin refers to *its* origin, not ours, and
  // without it neither player can reach its own storage and both refuse to
  // start.
  frame.setAttribute('sandbox',
    'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
  return frame;
}

function text(s: string) {
  const el = document.createElement('span');
  el.textContent = s;
  return el;
}

const NS = 'http://www.w3.org/2000/svg';

/**
 * One line-art mark per provider, drawn here rather than borrowed.
 *
 * Neither is the company's logo, and that is deliberate twice over: a brand
 * mark is theirs to license, and both of them are a filled roundel that would
 * be the only such thing on a board of hairline strokes. A triangle means play
 * and three bars mean sound in any drawing style, including this one.
 */
function glyph(provider: EmbedSpec['provider']) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  if (provider === 'spotify') {
    // A rising then falling level meter. Round caps, so it belongs with the
    // rest of the app's strokes rather than reading as a bar chart.
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    for (const [x, h] of [[3, 4], [6.5, 9], [10, 6], [13, 2.5]]) {
      const line = document.createElementNS(NS, 'line');
      // String() rather than letting setAttribute coerce: same characters, and
      // the coercion is now said where it happens.
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(8 - h / 2));
      line.setAttribute('y2', String(8 + h / 2));
      svg.append(line);
    }
    return svg;
  }
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M5 3.4v9.2L13 8z');
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
