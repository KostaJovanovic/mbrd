// The only string in this app that is allowed to become an iframe src.
//
// A .mbrd is a file anyone can hand-edit, so the id is checked rather than
// trusted, and the check is the whole of the security story for embeds: the
// src is a fixed template with one hole in it, and this decides what may go in
// the hole. Everything below is either "this is a video" or "this is not one".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  youTubeId, spotifyRef, embedFor, iframeURL,
} from '../web/assets/js/canvas/embed.ts';
import { linkURL } from '../web/assets/js/canvas/renderers.ts';

const id = s => youTubeId(new URL(s));
const sp = s => spotifyRef(new URL(s));

test('the four shapes that carry a video id', () => {
  assert.equal(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(id('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(id('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(id('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('the host is matched exactly, not by containment', () => {
  // The attack this rejects: a domain that merely *ends with* or *contains*
  // youtube.com would otherwise get an iframe pointed at it.
  assert.equal(id('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(id('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(id('https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('www and m are the same site; nothing else is', () => {
  assert.equal(id('https://youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(id('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(id('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('a page on the site that is not a video stays a link', () => {
  assert.equal(id('https://www.youtube.com/'), null);
  assert.equal(id('https://www.youtube.com/@somebody'), null);
  assert.equal(id('https://www.youtube.com/playlist?list=PL1234567890'), null);
  assert.equal(id('https://www.youtube.com/watch?list=PL1234567890'), null);
});

test('an id is eleven characters of base64url and nothing else', () => {
  assert.equal(id('https://youtu.be/short'), null, 'too short');
  assert.equal(id('https://youtu.be/waytoolongtobeanid'), null, 'too long');
  assert.equal(id('https://youtu.be/dQw4w9WgXc.'), null, 'a dot is not base64url');
  assert.equal(id('https://youtu.be/dQw4w9WgXc/'), null, 'nor an empty segment');
  assert.equal(id('https://youtu.be/'), null);
  assert.equal(id('https://www.youtube.com/watch?v='), null);
});

test('trailing path after a short or an embed is dropped, not rejected', () => {
  assert.equal(id('https://www.youtube.com/shorts/dQw4w9WgXcQ/comments'), 'dQw4w9WgXcQ');
  assert.equal(id('https://www.youtube.com/embed/dQw4w9WgXcQ/anything'), 'dQw4w9WgXcQ');
});

test('extra query parameters do not disturb the id', () => {
  assert.equal(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL9'), 'dQw4w9WgXcQ');
  assert.equal(id('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
});

test('nothing at all is not a video', () => {
  assert.equal(youTubeId(null), null);
  assert.equal(youTubeId(undefined), null);
});

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

const TRACK = '24wjVTP6exQrCFuUB6y6VM';

test('the shapes a Spotify share link comes in', () => {
  assert.deepEqual(sp(`https://open.spotify.com/track/${TRACK}`), { kind: 'track', id: TRACK });
  // The `si` is their share tracker and rides on every copied link.
  assert.deepEqual(sp(`https://open.spotify.com/track/${TRACK}?si=41a56cc15dd041bb`),
    { kind: 'track', id: TRACK });
  // What the Share menu's HTML block points at.
  assert.deepEqual(sp(`https://open.spotify.com/embed/track/${TRACK}?utm_source=generator`),
    { kind: 'track', id: TRACK });
  // A client in any other language writes a locale in front of the type.
  assert.deepEqual(sp(`https://open.spotify.com/intl-de/track/${TRACK}`),
    { kind: 'track', id: TRACK });
  // Both prefixes at once, which is what an embed of a localised page is.
  assert.deepEqual(sp(`https://open.spotify.com/embed/intl-pt/album/${TRACK}`),
    { kind: 'album', id: TRACK });
});

test('every kind Spotify will embed, and nothing else', () => {
  for (const kind of ['track', 'album', 'playlist', 'artist', 'show', 'episode']) {
    assert.deepEqual(sp(`https://open.spotify.com/${kind}/${TRACK}`), { kind, id: TRACK });
  }
  // A user page, a search, the home page: links, and they stay links.
  assert.equal(sp(`https://open.spotify.com/user/${TRACK}`), null);
  assert.equal(sp('https://open.spotify.com/search/blur'), null);
  assert.equal(sp('https://open.spotify.com/'), null);
});

test('a Spotify id is 22 characters of base62 or it is not one', () => {
  // The whole security story for the frame: this decides what may go in the one
  // hole in the src template, and a .mbrd is a file anyone can hand-edit.
  for (const bad of ['short', TRACK + 'x', TRACK.slice(1), '../../evil', TRACK.slice(0, 21) + '-']) {
    assert.equal(sp(`https://open.spotify.com/track/${bad}`), null, `${bad} was let through`);
  }
});

test('the host is matched exactly for Spotify too', () => {
  assert.equal(sp(`https://open.spotify.com.evil.test/track/${TRACK}`), null);
  assert.equal(sp(`https://notopen.spotify.com/track/${TRACK}`), null);
  assert.equal(sp(`https://spotify.com/track/${TRACK}`), null);
});

// ---------------------------------------------------------------------------
// What a link turns into
// ---------------------------------------------------------------------------

test('a player is described the same way whoever provides it', () => {
  const yt = embedFor(new URL('https://youtu.be/dQw4w9WgXcQ'));
  const spot = embedFor(new URL(`https://open.spotify.com/track/${TRACK}?si=x`));
  for (const spec of [yt, spot]) {
    for (const k of ['provider', 'src', 'page', 'title', 'label', 'hint', 'allow']) {
      assert.equal(typeof spec[k], 'string', `${spec.provider} has no ${k}`);
    }
    assert.equal(typeof spec.heightFor(256), 'number');
    assert.ok(spec.src.startsWith('https://'), spec.src);
  }
  // The src is built from a template, so the id is the only thing in it that
  // came from outside - and the page is the human link, not the embed one.
  assert.equal(spot.src, `https://open.spotify.com/embed/track/${TRACK}?theme=0`);
  assert.equal(spot.page, `https://open.spotify.com/track/${TRACK}`);
  assert.equal(yt.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
});

test('a track asks for the compact player and a playlist for the tall one', () => {
  const track = embedFor(new URL(`https://open.spotify.com/track/${TRACK}`));
  const list = embedFor(new URL(`https://open.spotify.com/playlist/${TRACK}`));
  assert.ok(list.heightFor(256) > track.heightFor(256));
  // Flat in the width, unlike a video: the player picks its layout from its
  // height, so a wider card must not become a taller one.
  assert.equal(track.heightFor(256), track.heightFor(900));
});

test('an ordinary link is not a player', () => {
  assert.equal(embedFor(new URL('https://example.com/track/x')), null);
  assert.equal(embedFor(null), null);
});

// ---------------------------------------------------------------------------
// The pasted <iframe>
// ---------------------------------------------------------------------------

const SPOTIFY_BLOCK = '<iframe data-testid="embed-iframe" style="border-radius:12px" '
  + `src="https://open.spotify.com/embed/track/${TRACK}?utm_source=generator&amp;si=14e4" `
  + 'width="100%" height="352" frameBorder="0" allowfullscreen="" loading="lazy"></iframe>';

test('the src comes out of a pasted share block', () => {
  const u = iframeURL(SPOTIFY_BLOCK, linkURL);
  assert.equal(u.hostname, 'open.spotify.com');
  // &amp; is how a generator writes the separator, and leaving it encoded would
  // make the second parameter part of the first one's value.
  assert.equal(u.searchParams.get('si'), '14e4');
  assert.deepEqual(spotifyRef(u), { kind: 'track', id: TRACK });
});

test('single quotes and a YouTube block work the same way', () => {
  const u = iframeURL("<iframe src='https://www.youtube.com/embed/dQw4w9WgXcQ'></iframe>", linkURL);
  assert.equal(youTubeId(u), 'dQw4w9WgXcQ');
});

test('only an iframe, and only a real src', () => {
  assert.equal(iframeURL('just some text', linkURL), null);
  assert.equal(iframeURL('<iframemalicious src="https://x.test/">', linkURL), null);
  assert.equal(iframeURL('<iframe></iframe>', linkURL), null);
  // The pasted string is searched, never parsed - so the scheme allowlist in
  // linkURL is what stands between a share block and an href, exactly as it
  // does for a typed address.
  assert.equal(iframeURL('<iframe src="javascript:alert(1)"></iframe>', linkURL), null);
  assert.equal(iframeURL('<iframe src="data:text/html,<b>x"></iframe>', linkURL), null);
  // A sentence *about* an iframe is not one.
  assert.equal(iframeURL('look at this <iframe src="https://x.test/"></iframe>', linkURL), null);
});

test('the embed module fetches nothing at import time', async () => {
  // The property the whole file exists to protect. If this module ever gained
  // a top-level request, loading a board would announce itself before anyone
  // had pressed anything - so the source is checked for the ways that could
  // happen rather than trusted to stay clean.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/assets/js/canvas/embed.ts', import.meta.url), 'utf8');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'new Image', 'importScripts', 'navigator.sendBeacon']) {
    assert.ok(!src.includes(bad), `embed.js should not contain ${bad}`);
  }
  // And the frame's origin is the no-cookie one, spelt out rather than built.
  assert.ok(src.includes('https://www.youtube-nocookie.com/embed/'));
});
