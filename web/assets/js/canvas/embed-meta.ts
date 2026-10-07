// Fetches a player card's title (and, for Spotify, its cover art) and stores
// them on the card. The one place in the app that reaches the network to
// decorate a card - see the local-first note in canvas/renderers.ts, which this
// deliberately steps outside of. It runs only when a player is pressed (the
// canvas card, a Feed tile, the viewer), the moment the frame contacts the
// provider anyway, and only for a card that has no title stored yet. Drawing a
// card fetches nothing.
//
// Spotify and YouTube, each through its own oembed (both send a CORS header the
// browser can read). Spotify also carries a cover on i.scdn.co, stored as an
// asset; YouTube's reply is the title alone. Any other provider returns early.
//
// Nothing here runs at import: enrichEmbed is called from the injected hook in
// renderers.ts (setEmbedEnrich), wired in main.ts, so the module stays loadable
// in a test with no network.

import { embedFor } from './embed.ts';
import { linkURL } from './renderers.ts';
import { byId, setEmbedMeta } from '../state.ts';
import { addFile, derivedFile } from '../storage/assets.ts';
import { isRecord } from '../util.ts';
import type { Item } from '../board-model.ts';

// Card and page pairs being fetched right now, so a second render of the same
// card mid-flight does not open a second request. Cleared in the finally.
const inFlight = new Set<string>();

// Pages whose oembed failed this session, so pressing play again does not ask
// again; the next load still tries once more.
const failed = new Set<string>();

// The cover host in the oembed reply. Checked before it is fetched so a reply
// naming some other origin cannot make this app request it - connect-src allows
// it (web/_headers) and the check keeps the code's promise the same as the CSP.
const ART_HOST = 'https://i.scdn.co/';

export async function enrichEmbed(item: Item): Promise<void> {
  // A stored title is the whole definition of "not missing"; leave it be.
  if (typeof item.meta?.title === 'string' && item.meta.title) return;
  const asked = item.meta?.url;
  const spec = embedFor(linkURL(asked));
  if (!spec || (spec.provider !== 'spotify' && spec.provider !== 'youtube')) return;
  if (failed.has(spec.page)) return;
  const key = `${item.id}\n${spec.page}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  // The reply is for the address that was asked about. An edit of the link
  // while it was on the way would put this page's title on the next one.
  const still = () => byId(item.id)?.meta?.url === asked;
  try {
    // YouTube: the video title, and nothing else - its oembed carries no cover
    // on a host of ours to store.
    if (spec.provider === 'youtube') {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(spec.page)}&format=json`,
        { referrerPolicy: 'no-referrer' });
      if (!res.ok) { failed.add(spec.page); return; }
      const title = pick(await res.json(), 'title');
      if (title && still()) setEmbedMeta(item.id, { title });
      return;
    }
    // Spotify: the title, and the cover if the reply names one on i.scdn.co.
    const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spec.page)}`;
    const res = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) { failed.add(spec.page); return; }
    const data: unknown = await res.json();
    const title = pick(data, 'title');
    const thumb = pick(data, 'thumbnail_url');
    let art: string | undefined;
    if (thumb.startsWith(ART_HOST)) {
      try {
        const img = await fetch(thumb, { referrerPolicy: 'no-referrer' });
        if (img.ok) art = await addFile(derivedFile(await img.blob(), 'cover'));
      } catch {
        // The cover is a bonus; a title with no art is still worth storing.
      }
    }
    if ((title || art) && still()) setEmbedMeta(item.id, { title, art });
  } catch {
    // Offline, blocked, or malformed. The card stays exactly as it was, which
    // is the local-first default, and the next load tries again - by design.
    failed.add(spec.page);
  } finally {
    inFlight.delete(key);
  }
}

// A string field off the parsed JSON, or '' - the reply is whatever the network
// handed back and is not trusted to have the shape it should.
function pick(data: unknown, key: string): string {
  if (!isRecord(data)) return '';
  const v = data[key];
  return typeof v === 'string' ? v : '';
}
