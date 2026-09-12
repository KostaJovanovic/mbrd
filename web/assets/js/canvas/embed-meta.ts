// Fetches a Spotify track's title and cover art and stores them on its link
// card. The one place in the app that reaches the network to decorate a card -
// see the local-first note in canvas/renderers.ts, which this deliberately
// steps outside of. It runs only for a card that has no title stored yet, so a
// board that has been seen once fetches nothing on the next load.
//
// Spotify only. YouTube's oembed sends no CORS header, so a browser cannot read
// it and this app has no server to proxy through - a YouTube card keeps the
// provider name (embed.ts) and this returns early.
//
// Nothing here runs at import: enrichEmbed is called from the injected hook in
// renderers.ts (setEmbedEnrich), wired in main.ts, so the module stays loadable
// in a test with no network.

import { embedFor } from './embed.ts';
import { linkURL } from './renderers.ts';
import { setEmbedMeta } from '../state.ts';
import { addFile, derivedFile } from '../storage/assets.ts';
import { isRecord } from '../util.ts';
import type { Item } from '../board-model.ts';

// Ids being fetched right now, so a second render of the same card mid-flight
// does not open a second request. Cleared in the finally.
const inFlight = new Set<string>();

// The cover host in the oembed reply. Checked before it is fetched so a reply
// naming some other origin cannot make this app request it - connect-src allows
// it (web/_headers) and the check keeps the code's promise the same as the CSP.
const ART_HOST = 'https://i.scdn.co/';

export async function enrichEmbed(item: Item): Promise<void> {
  // A stored title is the whole definition of "not missing"; leave it be.
  if (typeof item.meta?.title === 'string' && item.meta.title) return;
  const spec = embedFor(linkURL(item.meta?.url));
  if (!spec || spec.provider !== 'spotify') return;
  if (inFlight.has(item.id)) return;
  inFlight.add(item.id);
  try {
    const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spec.page)}`;
    const res = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
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
    if (title || art) setEmbedMeta(item.id, { title, art });
  } catch {
    // Offline, blocked, or malformed. The card stays exactly as it was, which
    // is the local-first default, and the next load tries again - by design.
  } finally {
    inFlight.delete(item.id);
  }
}

// A string field off the parsed JSON, or '' - the reply is whatever the network
// handed back and is not trusted to have the shape it should.
function pick(data: unknown, key: string): string {
  if (!isRecord(data)) return '';
  const v = data[key];
  return typeof v === 'string' ? v : '';
}
