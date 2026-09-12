// Embed players for YouTube and Spotify. Nothing loads until the user clicks;
// the choice is not remembered. IDs are validated before reaching the iframe src.
// Uses youtube-nocookie.com and no-referrer for privacy.

import { byId, snapshotGeom, applyGeom, commitGeom } from '../state.ts';
import type { Item } from '../board-model.ts';
import { hasOwn } from '../util.ts';

export type EmbedSpec = {
  provider: 'youtube' | 'spotify';
  src: string;
  page: string;
  title: string;
  label: string;
  hint: string;
  allow: string;
  // The narrowest the frame may be. A player has an internal minimum below which
  // its own layout starts a horizontal scrollbar inside the frame - a thing no
  // stylesheet of ours can reach across the origin to suppress - so the surface
  // grows the frame to clear it. 0 for a player that is fully fluid (YouTube), a
  // real floor for one that is not (Spotify's compact track player scrolls under
  // about 340px of content width). The canvas card adds its own padding on top;
  // the Feed spans as many columns as the raw width needs.
  minWidth: number;
  // The player's own height, in CSS pixels, at a given frame width. YouTube is
  // 16:9 of the width; Spotify picks one of two flat layouts by kind and is
  // therefore width-independent. Just the player - a surface adds its own
  // furniture (chrome) around it.
  playerHeight: (w: number) => number;
  // The furniture a surface draws around the player. The canvas card carries a
  // name row and padding above and below; the Feed mounts the bare frame and
  // adds none. Read only by the canvas (fitToPlayer); the Feed sizes from
  // playerHeight alone.
  chrome: number;
};

// The canvas card's furniture around the frame, in CSS pixels: the padding
// above and below (15 each), the slim provider-name strip that is the drag
// handle, and the gap under it. Spotify's card closes that gap to 4 and
// YouTube's keeps the has-embed 6 (see cards.css), so the two differ by two
// pixels. The strip is small and tier-dependent, so these are close rather than
// exact; the couple of pixels of slack land in the paper mat around the frame,
// where a hairline of the card's own paper is wanted anyway.
const YT_CHROME = 50;
const SP_CHROME = 48;

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT_ID = /^[\w-]{11}$/;

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
  if (id) id = id.split('/')[0];
  return id && YT_ID.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

const SP_ID = /^[A-Za-z0-9]{22}$/;

// Heights match the two layouts the Spotify player picks from its box.
const SPOTIFY = {
  track: 152,
  episode: 152,
  album: 352,
  playlist: 352,
  artist: 352,
  show: 352,
};

type SpotifyKind = keyof typeof SPOTIFY;
const isSpotifyKind = (k: string): k is SpotifyKind => hasOwn(SPOTIFY, k);

// Strips /intl-xx/, /embed, /embed-podcast prefixes before extracting kind/id.
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
      // Fully fluid: it letterboxes to whatever box it is given, so the card
      // keeps the width it already had and only its height is set.
      minWidth: 0,
      playerHeight: w => Math.round(w * 9 / 16),
      chrome: YT_CHROME,
    };
  }

  const sp = spotifyRef(u);
  if (sp) {
    return {
      provider: 'spotify',
      // No theme parameter. `theme=0` was here for a light player and now does
      // the opposite - it forces the dark variant, the black slab this card was
      // shaped to avoid. The default player takes its colour from the artwork,
      // which is the look every Spotify embed on the web wears, so the card is
      // built around that rather than around a light option that no longer
      // exists. `theme=1` is the same default; only `theme=0` differs, and only
      // to go dark.
      src: `https://open.spotify.com/embed/${sp.kind}/${sp.id}`,
      page: `https://open.spotify.com/${sp.kind}/${sp.id}`,
      title: `Spotify ${sp.kind} player`,
      label: 'Listen here',
      hint: 'Loads the player from Spotify. Nothing is requested until you press this.',
      allow: 'encrypted-media; clipboard-write; picture-in-picture; fullscreen',
      // The compact player scrolls sideways under about 340px of frame width, so
      // the frame is grown to clear it: on the canvas the card adds 16px padding
      // each side (372 card), on the Feed the tile spans columns to reach 340.
      minWidth: 340,
      playerHeight: () => SPOTIFY[sp.kind],
      chrome: SP_CHROME,
    };
  }

  return null;
}

// Extracts src from a pasted <iframe> via regex (never parsed as HTML).
export function iframeURL<T>(text: unknown, parse: (raw: string) => T): T | null {
  const s = String(text ?? '').trim();
  if (!/^<iframe[\s>]/i.test(s)) return null;
  const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(s);
  const raw = m && (m[1] ?? m[2]);
  if (!raw) return null;
  return parse(raw.replace(/&amp;/gi, '&'));
}

// ---------------------------------------------------------------------------
// The offer, and the swap
// ---------------------------------------------------------------------------

// The offer's visual, without behaviour: the same chip on the canvas card and
// on a Feed tile, so the two surfaces make the same promise the same way. Each
// attaches its own press - the canvas swaps the card in place, the Feed mounts
// the frame and reflows the wall. `label` overrides the default ("Listen here")
// - the canvas card passes the song title once it has one, so the button reads
// the track next to the logo rather than a generic verb.
export function offerButton(spec: EmbedSpec, label: string = spec.label): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'embed-go';
  btn.dataset.provider = spec.provider;
  btn.title = spec.hint;
  btn.append(glyph(spec.provider), text(label));
  return btn;
}

export function embedOffer(item: Item, spec: EmbedSpec, card: HTMLElement): HTMLButtonElement {
  // The song, once fetched (embed-meta.ts), reads on the button itself; until
  // then the standing offer verb.
  const title = typeof item.meta?.title === 'string' && item.meta.title ? item.meta.title : spec.label;
  const btn = offerButton(spec, title);
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    // Swap DOM before fitToPlayer: the geom emit could rebuild the card.
    card.classList.add('has-embed');
    // Keep the title row — it is the drag handle, the one surface still ours
    // once the frame is in and eating every pointer over itself (renderers.ts,
    // cards.css). The faint provider watermark goes with the rest.
    for (const el of [...card.children]) {
      if (!el.classList.contains('embed-title')) el.remove();
    }
    card.append(frameFor(spec));
    fitToPlayer(item.id, spec);
  });
  return btn;
}

// The horizontal padding a card draws around the frame: --card-pad-x, both
// sides (cards.css). The frame's minimum width plus this is the card's minimum.
const CARD_PAD_X = 32;

// The smallest a card holding this player may be drawn, width and height, in
// world units. Below the width the player starts a sideways scrollbar it draws
// itself and no stylesheet of ours can reach; below the height it is clipped.
// canvas/input.ts holds a resize to this floor so neither can happen - the same
// box fitToPlayer grows a card up to when the player is taken.
export function embedFloor(spec: EmbedSpec): { w: number; h: number } {
  const w = spec.minWidth + CARD_PAD_X;
  return { w, h: spec.playerHeight(w - CARD_PAD_X) + spec.chrome };
}

// Resize the card to fit the player: the height always, and the width up to the
// frame's floor plus the card's own padding when the card is narrower than the
// player can be drawn. Never narrows a card the user already made wide - the
// floor is a minimum, not a target. The resize is undoable.
function fitToPlayer(itemId: string, spec: EmbedSpec) {
  const it = byId(itemId);
  if (!it) return;
  const w = Math.max(it.w, spec.minWidth + CARD_PAD_X);
  const h = spec.playerHeight(w - CARD_PAD_X) + spec.chrome;
  if (Math.abs(it.w - w) < 2 && Math.abs(it.h - h) < 2) return;
  const before = snapshotGeom([itemId]);
  applyGeom([{ id: itemId, x: it.x, y: it.y, w, h, rot: it.rot, z: it.z }]);
  commitGeom('Fit the player', before);
}

export function frameFor(spec: EmbedSpec): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = 'embed-frame';
  frame.dataset.provider = spec.provider;
  frame.src = spec.src;
  frame.title = spec.title;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.allow = spec.allow;
  frame.allowFullscreen = true;
  // allow-same-origin is the frame's origin, not ours — without it neither player starts.
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

// Spotify's own green. The one brand colour let onto the board, and only on the
// mark inside the offer chip - the chip's own paper and type stay the board's,
// so a logo is recognisably Spotify's while the card is recognisably ours.
const SPOTIFY_GREEN = '#1ed760';

// The Spotify wordless mark: the circle with three arcs, as one filled path
// whose arcs are the shape's holes (the chip's paper reads through them). The
// official single-colour icon, on its own 24x24 grid, drawn green rather than
// in currentColor.
const SPOTIFY_MARK = 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 '
  + '17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899'
  + '-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3'
  + 'c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48'
  + '.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 '
  + '8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28'
  + '-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z';

function glyph(provider: EmbedSpec['provider']) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (provider === 'spotify') {
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', SPOTIFY_MARK);
    p.setAttribute('fill', SPOTIFY_GREEN);
    svg.append(p);
    return svg;
  }
  svg.setAttribute('viewBox', '0 0 16 16');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M5 3.4v9.2L13 8z');
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
