// The desktop's Google sign-in (desktop/google-oauth.mts): the loopback flow
// with PKCE, run whole in plain Node. The system browser is faked by a fetch
// to the redirect Google would send, and Google's token endpoint by a function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { authUrl, checkRequest, pkcePair, readRedirect, readToken, signIn } from '../desktop/google-oauth.mts';
import { setPlatform } from '../web/assets/js/platform/platform.ts';
import { canShareLink } from '../web/assets/js/storage/cloud/provider.ts';
import { cloudProviders, shareProvider } from '../web/assets/js/storage/cloud/cloud.ts';
import {
  GOOGLE_ANDROID_CLIENT, GOOGLE_DESKTOP_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_SECRET, SHARE_SITE,
} from '../web/assets/js/storage/cloud/config.ts';
import { readFileSync } from 'node:fs';

const REQ = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-not-really-secret',
  scope: 'https://www.googleapis.com/auth/drive.file',
};

/** A browser that follows the auth URL to Google, and Google answering with `reply`. */
function browser(reply) {
  const seen = {};
  return {
    seen,
    open: async url => {
      const u = new URL(url);
      seen.auth = u;
      const back = new URL(u.searchParams.get('redirect_uri'));
      for (const [k, v] of Object.entries(reply(u))) back.searchParams.set(k, v);
      // Not awaited by the flow: the page answers while the token fetch runs.
      seen.page = fetch(back).then(r => r.text());
    },
  };
}

test('a sign-in trades the code and the PKCE verifier for a token', async () => {
  const b = browser(u => ({ code: 'the-code', state: u.searchParams.get('state') }));
  let exchange;
  const got = await signIn(REQ, {
    open: b.open,
    fetch: async (url, init) => {
      exchange = { url, body: new URLSearchParams(init.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3599 }) };
    },
  });
  assert.deepEqual(got, { token: 'tok', expiresIn: 3599 });
  assert.equal(b.seen.auth.origin + b.seen.auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(b.seen.auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(b.seen.auth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(exchange.url, 'https://oauth2.googleapis.com/token');
  assert.equal(exchange.body.get('code'), 'the-code');
  assert.equal(exchange.body.get('redirect_uri'), b.seen.auth.searchParams.get('redirect_uri'));
  // The verifier sent at the exchange is the one the challenge was made from.
  const verifier = exchange.body.get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), b.seen.auth.searchParams.get('code_challenge'));
  assert.match(await b.seen.page, /Signed in/);
});

test('a refusal, a wrong state and a slow reader each end the sign-in', async () => {
  const noFetch = async () => assert.fail('no token exchange after a failed redirect');
  const denied = browser(() => ({ error: 'access_denied' }));
  await assert.rejects(signIn(REQ, { open: denied.open, fetch: noFetch }), /not granted/);
  const forged = browser(() => ({ code: 'c', state: 'somebody-else' }));
  await assert.rejects(signIn(REQ, { open: forged.open, fetch: noFetch }), /different request/);
  await assert.rejects(signIn(REQ, { open: async () => {}, fetch: noFetch, timeoutMs: 50 }), /too long/);
});

test('the renderer asks for one client shape and one scope', () => {
  assert.deepEqual(checkRequest(REQ), REQ);
  assert.throws(() => checkRequest(null), /no sign-in request/);
  assert.throws(() => checkRequest({ ...REQ, clientId: 'evil.example.com' }), /no Google client/);
  assert.throws(() => checkRequest({ ...REQ, clientSecret: '' }), /no client secret/);
  assert.throws(() => checkRequest({ ...REQ, scope: 'https://www.googleapis.com/auth/drive' }), /scope/);
});

test('an app offers Drive sign-in only with a client of its own, and still opens a link', () => {
  const web = canShareLink();
  const app = kind => ({ auth: { googleClient: kind, google: () => Promise.reject(new Error('unused')) } });
  try {
    setPlatform(app('desktop'));
    const desktop = web && !!GOOGLE_DESKTOP_CLIENT_ID && !!GOOGLE_DESKTOP_CLIENT_SECRET;
    assert.equal(canShareLink(), desktop);
    assert.equal(cloudProviders().length > 0, desktop);
    setPlatform(app('android'));
    assert.equal(canShareLink(), web && GOOGLE_ANDROID_CLIENT);
    // The recipient half needs no sign-in, so a link still opens in either app.
    assert.equal(!!shareProvider('gdrive'), web);
  } finally {
    setPlatform(null);
  }
  assert.equal(!!GOOGLE_DESKTOP_CLIENT_ID, !!GOOGLE_DESKTOP_CLIENT_SECRET,
    'config.ts has the desktop client id and not its secret, or the other way round');
});

test('a link made in the apps names the website, which the canonical URL agrees on', () => {
  const site = new URL(SHARE_SITE);
  assert.equal(site.protocol, 'https:');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`<link rel="canonical" href="${SHARE_SITE.replace(/[.]/g, '\\.')}">`),
    'config.ts SHARE_SITE and the canonical URL in index.html name different sites');
  assert.match(readFileSync(new URL('../web/assets/js/commands/file.ts', import.meta.url), 'utf8'),
    /isDesktop\(\) \? new URL\(SHARE_SITE\)/, 'the share command no longer links the apps to the website');
});

test('the redirect, the token answer and the PKCE pair read strictly', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[\w-]{43}$/);
  assert.notEqual(verifier, challenge);
  const url = new URL(authUrl(REQ, 'http://127.0.0.1:5', 's', challenge));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(readRedirect(new URL('http://127.0.0.1/favicon.ico'), 's'), null);
  assert.equal(readRedirect(new URL('http://127.0.0.1/?code=c&state=s'), 's'), 'c');
  assert.throws(() => readRedirect(new URL('http://127.0.0.1/?state=s'), 's'), /no sign-in code/);
  assert.throws(() => readToken('<html>'), /not JSON/);
  assert.throws(() => readToken('{"error":"invalid_grant","error_description":"Bad Request"}'), /Bad Request/);
  assert.throws(() => readToken('{"access_token":"t","expires_in":0}'), /usable token/);
});
