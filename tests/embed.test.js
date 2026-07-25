// The only string in this app that is allowed to become an iframe src.
//
// A .mbrd is a file anyone can hand-edit, so the id is checked rather than
// trusted, and the check is the whole of the security story for embeds: the
// src is a fixed template with one hole in it, and this decides what may go in
// the hole. Everything below is either "this is a video" or "this is not one".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { youTubeId } from '../web/assets/js/canvas/embed.js';

const id = s => youTubeId(new URL(s));

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

test('the embed module fetches nothing at import time', async () => {
  // The property the whole file exists to protect. If this module ever gained
  // a top-level request, loading a board would announce itself before anyone
  // had pressed anything - so the source is checked for the ways that could
  // happen rather than trusted to stay clean.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/assets/js/canvas/embed.js', import.meta.url), 'utf8');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'new Image', 'importScripts', 'navigator.sendBeacon']) {
    assert.ok(!src.includes(bad), `embed.js should not contain ${bad}`);
  }
  // And the frame's origin is the no-cookie one, spelt out rather than built.
  assert.ok(src.includes('https://www.youtube-nocookie.com/embed/'));
});
