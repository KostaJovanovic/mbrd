// The share link's grammar: build a link, parse it back, and feed the parser
// things a link is not. No network here - storage/cloud/google.ts talks to
// the host; this is the half worth testing without one. tests/csp.test.js
// covers the host-policy half.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_IDS, canShareLink, parseShareRef, shareLinkFor,
} from '../web/assets/js/storage/cloud/provider.ts';
import {
  GOOGLE_API_KEY, GOOGLE_CLIENT_ID,
} from '../web/assets/js/storage/cloud/config.ts';
import { SHARE_PARAM } from '../web/assets/js/page.ts';

const ORIGIN = 'https://mbrd.valjdakosta.com';

test('a link built for a reference parses back to that reference', () => {
  // The one property a reader on another machine can rely on.
  for (const provider of PROVIDER_IDS) {
    const ref = { provider, id: '1a2B3c-_dEf' };
    const link = shareLinkFor(ORIGIN, '/', ref);
    const value = new URL(link).searchParams.get(SHARE_PARAM);
    assert.deepEqual(parseShareRef(value), ref, `${provider} did not survive the round trip`);
  }
});

test('a link is built against the path the app is served from', () => {
  // homePath() rather than '/': index.html carries a <base>, and a link
  // hard-coded to root would silently break in a subdirectory. The provider
  // spells out `gdrive` everywhere a person reads it, and `g` only in the
  // link itself, where every character is one more to paste.
  assert.equal(shareLinkFor(ORIGIN, '/', { provider: 'gdrive', id: 'x1' }),
    `${ORIGIN}/?${SHARE_PARAM}=g.x1`);
  assert.equal(shareLinkFor(ORIGIN, '/boards/', { provider: 'gdrive', id: 'x1' }),
    `${ORIGIN}/boards/?${SHARE_PARAM}=g.x1`);
});

test('a link written before the short spelling still opens', () => {
  // Old links say `gdrive` and live in other people's chat histories, where
  // nothing can go correct them - parseShareRef must keep reading both forms.
  assert.deepEqual(parseShareRef('gdrive.x1'), { provider: 'gdrive', id: 'x1' });
  assert.deepEqual(parseShareRef('g.x1'), { provider: 'gdrive', id: 'x1' });
});

test('a reference answers with the long provider id, whichever spelling it carried', () => {
  // Nothing downstream learns of the short spelling: it looks the provider up
  // in PROVIDERS by this value, and a `g` there would read as an unopenable link.
  assert.equal(parseShareRef('g.x1')?.provider, 'gdrive');
});

test('an id keeps every character a provider may put in one', () => {
  // Drive ids carry letters, digits, hyphens and underscores; one mangled
  // character is a link that resolves to nothing.
  const id = 'aA0_-zZ9' + 'x'.repeat(40);
  assert.deepEqual(parseShareRef(`gdrive.${id}`), { provider: 'gdrive', id });
});

test('everything that is not a share reference is null, not a throw', () => {
  // Null, never a throw: these arrive as URLs somebody was handed - a
  // truncated paste, a newer build's link, an ordinary board. main.ts turns
  // null into one sentence and leaves the board alone.
  for (const value of [
    null,                       // the ordinary case - no ?s= at all
    '',                         // ?s= with nothing after it
    'gdrive',                   // no separator
    '.abc',                     // no provider
    'gdrive.',                  // no id
    'dropbox.abc',              // a provider this build does not carry
    'd.abc',                    // nor a short code this build does not carry
    'GDRIVE.abc',               // the id is opaque; the provider name is not
    'G.abc',                    // and the code is not either
    'gdrive.a/b',               // a separator that would climb out of a URL
    'gdrive.a b',               // whitespace
    'gdrive.' + 'x'.repeat(257),  // longer than any provider's id
  ]) {
    assert.equal(parseShareRef(value), null, `${JSON.stringify(value)} parsed as a reference`);
  }
});

test('the first dot separates, and later ones belong to the id', () => {
  // indexOf, not split: an id may contain a dot, and losing the tail would
  // silently point the link at a different file rather than at none.
  assert.deepEqual(parseShareRef('gdrive.a.b'), null,
    'a dot is not one of the characters an id may carry, so this is not a reference');
});

test('this build carries both halves of a provider, or neither', () => {
  // **Both or neither is the whole of this test.** A client id with no API
  // key is the worst state: sign-in and upload work, then the recipient's
  // fetch - the only half that uses the key - opens nothing, days later, with
  // no way to explain it. canShareLink() prevents that; this keeps it honest.
  assert.equal(canShareLink(), !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY);
  assert.equal(!!GOOGLE_CLIENT_ID, !!GOOGLE_API_KEY,
    'storage/cloud/config.ts has one identifier and not the other - the share row would '
    + 'appear, upload happily, and produce links that open nothing');
});

test('the committed identifiers are the shape Google issues', () => {
  // Not a check that they are *correct* - only a round trip through Drive
  // proves that. Catches the two wrong-but-plausible pastes: stray quotes or
  // whitespace, and a client secret where the client id goes.
  if (!canShareLink()) return;
  assert.match(GOOGLE_CLIENT_ID, /^[\w-]+\.apps\.googleusercontent\.com$/,
    'the client id is not the form Google issues - a client *secret* is the usual mix-up');
  assert.match(GOOGLE_API_KEY, /^[\w-]{20,}$/,
    'the API key has whitespace or punctuation in it that Google would not have issued');
});

test('the provider table and the link grammar agree on what an id may be', () => {
  // Every assertion above is written against 'gdrive' - this guards against a
  // second provider arriving with nothing else here testing it.
  assert.ok(PROVIDER_IDS.length >= 1, 'the provider table is empty');
  for (const id of PROVIDER_IDS) {
    assert.match(id, /^[a-z]{2,16}$/,
      `${id} is not a provider name this app's own link grammar can carry`);
  }
});
