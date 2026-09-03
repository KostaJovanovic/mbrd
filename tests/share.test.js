// The share link's grammar, and the two directions it has to survive.
//
// A share link is written by one machine and read by another, days apart and
// possibly by two different builds of this app, and there is no round trip
// anywhere in the product that would catch a disagreement between the writer and
// the reader. So the round trip is here: every assertion below either builds a
// link and parses it back, or feeds the parser something a link is not.
//
// What is deliberately NOT here is the network. Nothing in this file signs in,
// uploads or fetches - storage/cloud/google.ts is the module that talks to a
// host, and standing up a fake Drive to assert against would be testing the fake.
// The provider modules were split so that the half worth testing has no network
// in it, and this is that half. CI covers the rest the way it covers every other
// remote: tests/csp.test.js holds the host in the policy in step with the module
// that names it, so the failure that would actually ship - an upload the deploy's
// own header refuses - fails in `npm test`.

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
  // The property the whole format exists to have, and the only one a reader on
  // another machine can rely on.
  for (const provider of PROVIDER_IDS) {
    const ref = { provider, id: '1a2B3c-_dEf' };
    const link = shareLinkFor(ORIGIN, '/', ref);
    const value = new URL(link).searchParams.get(SHARE_PARAM);
    assert.deepEqual(parseShareRef(value), ref, `${provider} did not survive the round trip`);
  }
});

test('a link is built against the path the app is served from', () => {
  // homePath() rather than '/', because index.html carries a <base> and the app
  // is wherever that says it is. A link hard-coded to the root would be wrong
  // the day this is hosted in a subdirectory - and wrong in the way that is
  // hardest to notice, since it would keep working on the machine that made it.
  // The provider is written short. It is spelled `gdrive` everywhere a person
  // might have to read it - a stored sync row, an error, the console handle -
  // and `g` in a link, which is the one place nobody reads it and every
  // character is one more to paste.
  assert.equal(shareLinkFor(ORIGIN, '/', { provider: 'gdrive', id: 'x1' }),
    `${ORIGIN}/?${SHARE_PARAM}=g.x1`);
  assert.equal(shareLinkFor(ORIGIN, '/boards/', { provider: 'gdrive', id: 'x1' }),
    `${ORIGIN}/boards/?${SHARE_PARAM}=g.x1`);
});

test('a link written before the short spelling still opens', () => {
  // The whole reason parseShareRef reads both: every link handed out before the
  // codes existed says `gdrive`, and those are in other people's chat histories
  // where nothing can go and correct them. A format change that broke them
  // would also be the hardest kind to notice - the sender's own copy of the
  // board is on their shelf, so it is only ever the recipient who finds out.
  assert.deepEqual(parseShareRef('gdrive.x1'), { provider: 'gdrive', id: 'x1' });
  assert.deepEqual(parseShareRef('g.x1'), { provider: 'gdrive', id: 'x1' });
});

test('a reference answers with the long provider id, whichever spelling it carried', () => {
  // Nothing downstream of parseShareRef learns that links have a short
  // spelling: it looks the provider up in PROVIDERS by this value, and a `g`
  // reaching that table would find nothing and read as "this app cannot open
  // that link".
  assert.equal(parseShareRef('g.x1')?.provider, 'gdrive');
});

test('an id keeps every character a provider may put in one', () => {
  // Drive ids carry letters, digits, hyphens and underscores, and all four have
  // to come back exactly as they went in - an id mangled by one character is a
  // link that resolves to nothing, reported as "the file was deleted".
  const id = 'aA0_-zZ9' + 'x'.repeat(40);
  assert.deepEqual(parseShareRef(`gdrive.${id}`), { provider: 'gdrive', id });
});

test('everything that is not a share reference is null, not a throw', () => {
  // Null rather than an error on all of these, because every one of them arrives
  // as a URL somebody was handed: a truncated paste, a link from a newer build,
  // an ordinary board with no query string at all. main.ts turns null into one
  // sentence and leaves the board alone.
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
  // indexOf rather than split, and it matters: nothing says a provider will
  // never mint an id with a dot in it, and losing the tail would be a link that
  // silently points at a different file rather than at none.
  assert.deepEqual(parseShareRef('gdrive.a.b'), null,
    'a dot is not one of the characters an id may carry, so this is not a reference');
});

test('this build carries both halves of a provider, or neither', () => {
  // Inverted from what it was written as, in the commit that filled in
  // storage/cloud/config.ts - which is what its first version said to do. It
  // asserted `false` while the file shipped empty, so that turning the feature
  // on could not happen by accident on a branch; now that it is on, the thing
  // worth guarding is the half-configured state.
  //
  // **Both or neither is the whole of this test.** A client id with no API key
  // is the worst of the three possible states: the panel row appears, the
  // sign-in works, the upload works, and then the link the sender has just
  // handed somebody opens nothing - because the recipient's fetch is the only
  // half that uses the key. That failure lands on the person who was sent the
  // board, days later, with nobody able to explain it. canShareLink() is what
  // makes it impossible, and this is what keeps canShareLink() honest.
  assert.equal(canShareLink(), !!GOOGLE_CLIENT_ID && !!GOOGLE_API_KEY);
  assert.equal(!!GOOGLE_CLIENT_ID, !!GOOGLE_API_KEY,
    'storage/cloud/config.ts has one identifier and not the other - the share row would '
    + 'appear, upload happily, and produce links that open nothing');
});

test('the committed identifiers are the shape Google issues', () => {
  // Not a check that they are *correct* - nothing here can know that, and the
  // only real test is a round trip through somebody's Drive. It is a check
  // against the two ways these arrive wrong: a value pasted with the
  // surrounding quotes or whitespace still on it, and the client secret pasted
  // where the client id goes. Both look plausible in a diff and both fail at
  // the popup with a message about a malformed request.
  if (!canShareLink()) return;
  assert.match(GOOGLE_CLIENT_ID, /^[\w-]+\.apps\.googleusercontent\.com$/,
    'the client id is not the form Google issues - a client *secret* is the usual mix-up');
  assert.match(GOOGLE_API_KEY, /^[\w-]{20,}$/,
    'the API key has whitespace or punctuation in it that Google would not have issued');
});

test('the provider table and the link grammar agree on what an id may be', () => {
  // The guard on the guard. Every assertion above is written against 'gdrive',
  // so a table that grew a second entry with nothing testing it would leave this
  // file quietly covering half the feature.
  assert.ok(PROVIDER_IDS.length >= 1, 'the provider table is empty');
  for (const id of PROVIDER_IDS) {
    assert.match(id, /^[a-z]{2,16}$/,
      `${id} is not a provider name this app's own link grammar can carry`);
  }
});
