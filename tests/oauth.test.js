// The web sign-in's poll: which popup address counts as having come home.
// The deploy redirects /oauth.html to /oauth and keeps the fragment, so a
// poll that wants the literal redirect URI waits five minutes for nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRedirectPage } from '../web/assets/js/storage/cloud/oauth.ts';

const HOME = 'https://mbrd.valjdakosta.com/oauth.html';

test('the redirect page counts with and without its .html', () => {
  assert.ok(isRedirectPage(`${HOME}#access_token=t&state=s`, HOME));
  assert.ok(isRedirectPage('https://mbrd.valjdakosta.com/oauth#access_token=t&state=s', HOME));
  assert.ok(isRedirectPage('https://mbrd.valjdakosta.com/oauth?error=access_denied', HOME));
});

test('the redirect page counts under a sub-path', () => {
  const home = 'http://localhost:6273/app/oauth.html';
  assert.ok(isRedirectPage('http://localhost:6273/app/oauth#access_token=t', home));
  assert.ok(!isRedirectPage('http://localhost:6273/oauth#access_token=t', home));
});

test('nothing else counts', () => {
  for (const href of [
    '',
    'about:blank',
    'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://mbrd.valjdakosta.com/oauth.html',
    'https://evil.example/oauth.html#access_token=t',
    'https://mbrd.valjdakosta.com/oauth.htmlx#access_token=t',
    'https://mbrd.valjdakosta.com/oauthx#access_token=t',
    'https://mbrd.valjdakosta.com/#access_token=t',
    'http://mbrd.valjdakosta.com/oauth.html#access_token=t',
  ]) {
    assert.ok(!isRedirectPage(href, HOME), href);
  }
});
