// Google sign-in for the desktop: the loopback flow with PKCE, in the system
// browser. The board's page cannot sign in itself, because main denies its
// window.open and Google knows nothing of app://. No Electron import, so
// tests/desktop-google-oauth.test.js runs the whole flow in plain Node: main
// hands in the two things that need Electron, opening a URL and fetching one.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The one scope the page may ask for: files this app created (google.ts). */
export const SCOPES = new Set(['https://www.googleapis.com/auth/drive.file']);

/** Give up on a sign-in nobody is completing, as the web popup does. */
const TIMEOUT_MS = 5 * 60_000;

/** What the page asks for. Checked here, since it crosses from the renderer. */
export interface SignInRequest {
  clientId: string;
  /** A Desktop-app client's secret. Google says it is not secret in an app
   *  anybody can unpack, and still asks for it at the token exchange. */
  clientSecret: string;
  scope: string;
}

export interface SignInAnswer {
  token: string;
  /** Seconds, as Google says it. */
  expiresIn: number;
}

export interface SignInDeps {
  /** Open the URL in the system browser. */
  open(url: string): Promise<void>;
  fetch(url: string, init: { method: string, headers: Record<string, string>, body: string }): Promise<{
    ok: boolean, status: number, text(): Promise<string>,
  }>;
  timeoutMs?: number;
}

/** Validate the renderer's request, or throw. */
export function checkRequest(raw: unknown): SignInRequest {
  if (!raw || typeof raw !== 'object') throw new Error('no sign-in request');
  // SAFETY: a non-null object, each field typeof-checked before use.
  const r = raw as Record<string, unknown>;
  const { clientId, clientSecret, scope } = r;
  if (typeof clientId !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('the sign-in names no Google client');
  }
  if (typeof clientSecret !== 'string' || !/^[\w-]{1,200}$/.test(clientSecret)) {
    throw new Error('the sign-in carries no client secret');
  }
  if (typeof scope !== 'string' || !SCOPES.has(scope)) throw new Error('the sign-in asks for a scope mbrd does not use');
  return { clientId, clientSecret, scope };
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function pkcePair(): { verifier: string, challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function authUrl(req: SignInRequest, redirect: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: req.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: req.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Without select_account, somebody with two accounts gets the wrong Drive.
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${params}`;
}

/** The code from Google's redirect, or a throw that says why there is none.
 *  Null for a request that is not the redirect (a favicon), to wait on. */
export function readRedirect(url: URL, state: string): string | null {
  if (url.pathname !== '/') return null;
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(error === 'access_denied'
      ? 'Google Drive access was not granted'
      : `Google refused the sign-in: ${error}`);
  }
  if (url.searchParams.get('state') !== state) throw new Error('the sign-in answered a different request - try again');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Google sent no sign-in code');
  return code;
}

/** Google's token answer, or a throw. */
export function readToken(text: string): SignInAnswer {
  let body: { access_token?: unknown, expires_in?: unknown, error?: unknown, error_description?: unknown };
  try {
    // SAFETY: every field is typed unknown and typeof-checked below.
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error('Google answered the sign-in with something that is not JSON');
  }
  if (!body || typeof body !== 'object') throw new Error('Google answered the sign-in with nothing');
  if (typeof body.error === 'string') {
    const why = typeof body.error_description === 'string' ? body.error_description : body.error;
    throw new Error(`Google refused the sign-in: ${why}`);
  }
  const seconds = Number(body.expires_in);
  if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Google did not return a usable token');
  }
  return { token: body.access_token, expiresIn: seconds };
}

// Plain text in a bare page: no style, since the app keeps no inline style= anywhere.
const PAGE = (words: string) => `<!doctype html><meta charset="utf-8"><title>mbrd</title><p>${words}</p>`;

function answer(res: ServerResponse, status: number, words: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(PAGE(words));
}

let running: Promise<SignInAnswer> | null = null;

/** Sign in once. A second press while the browser is open waits on the first. */
export function signIn(raw: unknown, deps: SignInDeps): Promise<SignInAnswer> {
  const req = checkRequest(raw);
  running ??= run(req, deps).finally(() => { running = null; });
  return running;
}

async function run(req: SignInRequest, deps: SignInDeps): Promise<SignInAnswer> {
  const state = base64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  let settle: { ok(code: string): void, fail(err: Error): void } = { ok: () => {}, fail: () => {} };
  const arrived = new Promise<string>((ok, fail) => { settle = { ok, fail }; });

  const server = createServer((request: IncomingMessage, res: ServerResponse) => {
    let code: string | null;
    try {
      code = readRedirect(new URL(request.url ?? '/', 'http://127.0.0.1'), state);
    } catch (err) {
      answer(res, 400, 'mbrd could not sign in. Go back to mbrd to see why.');
      settle.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (code === null) {
      res.writeHead(404).end();
      return;
    }
    answer(res, 200, 'Signed in. You can close this tab and go back to mbrd.');
    settle.ok(code);
  });
  // 127.0.0.1 and not localhost, as Google asks: localhost can resolve to ::1
  // or be claimed by another program listening on the same name.
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const timer = setTimeout(() => settle.fail(new Error('the sign-in took too long')), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the sign-in could not listen for its answer');
    const redirect = `http://127.0.0.1:${address.port}`;
    await deps.open(authUrl(req, redirect, state, challenge));
    const code = await arrived;
    const res = await deps.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: req.clientId,
        client_secret: req.clientSecret,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
    return readToken(await res.text());
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
