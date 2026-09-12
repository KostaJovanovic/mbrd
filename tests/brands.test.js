// The brand registry behind the stylised link card: the host-to-brand reduction
// and the lookup, both pure. The SVG the card draws from a Brand is in
// renderers.ts (linkGlyph) and is not reached here - this file has no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteName, brandFor } from '../web/assets/js/canvas/brands.ts';

const site = (h) => siteName(new URL(`https://${h}/some/path`));
const brand = (h) => brandFor(new URL(`https://${h}/`))?.key ?? null;

test('siteName reduces a host to its registrable brand label', () => {
  assert.equal(site('reddit.com'), 'reddit');
  assert.equal(site('www.reddit.com'), 'reddit');       // www dropped
  assert.equal(site('open.spotify.com'), 'spotify');    // subdomain not the brand
  assert.equal(site('news.ycombinator.com'), 'ycombinator');
  assert.equal(site('bbc.co.uk'), 'bbc');               // two-label public suffix
  assert.equal(site('example.com.au'), 'example');
  assert.equal(site('localhost'), 'localhost');         // no dot: itself
});

test('brandFor matches known sites, their rename, and their shorteners', () => {
  assert.equal(brand('reddit.com'), 'reddit');
  assert.equal(brand('www.youtube.com'), 'youtube');
  assert.equal(brand('youtu.be'), 'youtube');           // shortener alias
  assert.equal(brand('x.com'), 'x');
  assert.equal(brand('twitter.com'), 'x');              // the old name still routes
  assert.equal(brand('fb.me'), 'facebook');
  assert.equal(brand('lnkd.in'), 'linkedin');
  assert.equal(brand('bsky.app'), 'bluesky');
});

test('an unknown site has no brand', () => {
  assert.equal(brand('example.com'), null);
  assert.equal(brand('some-blog.net'), null);
});

test('every brand carries a non-empty path and a matching key', () => {
  for (const host of ['reddit.com', 'vimeo.com', 'pinterest.com', 'patreon.com', 'github.com']) {
    const b = brandFor(new URL(`https://${host}/`));
    assert.ok(b, `${host} should resolve to a brand`);
    assert.ok(b.path.length > 20, `${host} path looks empty`);
    assert.ok(b.label.length > 0, `${host} has no label`);
  }
});
