// Getting a token out of somebody else's sign-in page, with no SDK.
//
// The generic half of every provider's sign-in, written once because the second
// provider will want exactly this and the third will too. It knows how to open a
// window, wait for it to come back to an address of ours, and read what was left
// in the fragment. It knows nothing about Google, Microsoft or Dropbox: the
// authorisation URL is built by the provider and handed in whole.
//
// ── Why the implicit grant, when Google itself advises against it ──
//
// Not "the modern advice is otherwise" - **the vendor's own documentation says
// this flow is wrong**, and that is worth writing down rather than leaving as a
// trade-off nobody questioned. developers.google.com/identity/protocols/oauth2
// states that the implicit grant "is considered insecure for browser-based
// single-page applications (SPAs)" and recommends authorisation code with PKCE.
//
// It is used anyway because the recommended flow is not available to an app with
// no server, and that was checked rather than assumed:
//
//   - The web-server guide's token exchange takes `client_secret`, and does not
//     mention PKCE at all.
//   - Google's own guide for browser apps using the code flow is explicit that
//     the exchange happens elsewhere: "An endpoint on your backend server
//     receives and validates the auth code, exchanging it for access and refresh
//     tokens."
//
// So the choice is not implicit-versus-PKCE. It is implicit versus running
// infrastructure, and this app does not run infrastructure. A client secret in a
// page is not a secret, and a refresh token in browser storage is a long-lived
// credential any script on the origin can read - which is the thing the advice
// is actually about.
//
// **If that ever stops being true, this is the module to revisit**: a public
// client type that takes PKCE without a secret would make the recommended flow
// reachable, and the whole of this file would be the wrong shape.
//
// The access token's lifetime is Google's and is deliberately not written down
// here as a number. Their docs say only that "access tokens have limited
// lifetimes" and their own sample returns 3920 seconds, so the hour everybody
// quotes is folklore. `expires_in` is read and believed; nothing assumes.
//
// That expiry is also why *sharing* was the right first cloud feature rather
// than the sync that was proposed years earlier. An expired token at share time
// is a sign-in prompt on a button somebody deliberately pressed. At sync time it
// is a silent background failure, which is the worst thing a storage feature can
// do.
//
// The token is held in memory by the provider that asked for it and is never
// written anywhere. A bearer token in localStorage would outlive the tab for no
// benefit at all: the cost of not keeping it is one popup per session, on a
// feature that is used a handful of times a year.
//
// ── Why no SDK, and why that is a CSP decision ──
//
// Google's own answer is a script from accounts.google.com. Loading it would put
// a remote host in script-src, which is the one directive web/_headers argues
// hardest about - a host there is a place an injected <script> can come from,
// and tests/csp.test.js fails outright on one. A hundred lines of fetch is the
// cheaper half of that trade by a wide margin.
//
// ── Why a popup that this module polls, rather than a page that posts back ──
//
// web/oauth.html carries no script at all. The provider redirects the popup to
// it, the popup is then same-origin, and the opener simply reads its location -
// no postMessage, no origin check to get wrong, and nothing to hash into
// script-src. The page exists only because the redirect has to land somewhere
// that is not the app: the app's own 404 is a byte copy of index.html, so a
// redirect to any address that does not exist would boot a whole second board
// inside a popup.
//
// Polling rather than a `load` listener because the popup crosses origins on the
// way - a listener on a window this document does not own fires for nothing it
// can see, and the only reliable signal that the journey is over is that the
// address has become readable again.

/** A token and the moment it stops being one. */
export interface TokenGrant {
  token: string;
  /** Epoch milliseconds. Compared against Date.now(), never trusted to the second. */
  expiresAt: number;
}

/** The page every provider redirects back to. Same origin, and carries no script. */
export const REDIRECT_PATH = 'oauth.html';

/**
 * How early a token is treated as expired.
 *
 * A token that is valid for another four seconds is not worth starting a
 * multi-megabyte upload with: the upload would fail somewhere in the middle,
 * having already written a partial file into somebody's Drive. Sixty seconds is
 * long enough for the metadata round trip and short enough not to throw away
 * most of an hour.
 */
const EXPIRY_MARGIN_MS = 60_000;

/** Whether a grant is still worth using. Null is not, which is the common case. */
export function usable(grant: TokenGrant | null): boolean {
  return !!grant && grant.expiresAt - EXPIRY_MARGIN_MS > Date.now();
}

// ---------------------------------------------------------------------------
// Surviving a reload, and not one thing more
//
// A token used to live in a module variable, so a refresh threw away something
// still valid for another fifty minutes and made the person sign in again to get
// an identical one. That is pure loss, and this fixes it.
//
// **sessionStorage, deliberately, and the choice is the whole of the security
// thinking here.** It survives a reload, a restored tab and a navigation, and it
// dies when the tab closes. localStorage would outlive the tab - which sounds
// like the thing being asked for and is not, because the token expires in an
// hour either way, so all localStorage actually buys is a *dead* credential
// sitting on disk for the next person at the machine to find. The live window is
// identical; only the residue differs.
//
// What this does not widen is worth stating too. A script on this origin could
// already read the token out of the module variable, so putting it in
// sessionStorage does not hand an attacker anything they did not have - the
// window is the same tab, the same session, the same origin. What it would widen
// is the *time* the credential exists at rest, and that is exactly the axis
// sessionStorage refuses to widen.
//
// It is not in prefs.ts, which CLAUDE.md calls "every localStorage read and
// write in the app", and the exception is deliberate: a token is not a
// preference. Preferences follow the person and are meant to persist; this is a
// credential whose whole design is that it does not.
// ---------------------------------------------------------------------------

/** One key per provider, so two accounts cannot overwrite each other. */
const storeKey = (provider: string) => `mbrd.cloud.${provider}`;

/**
 * Keep a grant for the life of this tab, or forget one.
 *
 * Every path is wrapped, because storage throws rather than degrades in the
 * cases that matter: a private window, a browser configured to block storage,
 * an origin over quota. None of those is a reason to fail a sign-in that has
 * already succeeded - the token is in memory and the feature works, it just will
 * not survive the next reload.
 */
export function rememberGrant(provider: string, grant: TokenGrant | null): void {
  try {
    if (grant) sessionStorage.setItem(storeKey(provider), JSON.stringify(grant));
    else sessionStorage.removeItem(storeKey(provider));
  } catch {
    // No storage here. The session still works; it just will not outlive a
    // reload, which is what it did before any of this existed.
  }
}

/**
 * The grant this tab was holding, if it is still worth anything.
 *
 * Expiry is checked here rather than by the caller, so a stale entry is dropped
 * on the way past instead of being handed out and rejected by Google a moment
 * later. Anything that is not the shape written above is treated as absent - a
 * hand-edited entry is not something to reason about, it is something to ignore.
 */
export function recallGrant(provider: string): TokenGrant | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(storeKey(provider));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    // SAFETY: asserted and then checked field by field on the next line - a
    // token that is not a non-empty string, or an expiry that is not a finite
    // number, falls out as null rather than being handed to a fetch.
    const parsed = JSON.parse(raw) as { token?: unknown, expiresAt?: unknown };
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return null;
    const grant = { token: parsed.token, expiresAt: parsed.expiresAt };
    if (!usable(grant)) {
      rememberGrant(provider, null);
      return null;
    }
    return grant;
  } catch {
    return null;
  }
}

/** Where the provider must be told to send the popup back to. */
export function redirectUri(): string {
  return new URL(REDIRECT_PATH, document.baseURI).href;
}

/**
 * A value the response has to echo, so that a fragment left over from something
 * else cannot be read as an answer to this question.
 *
 * crypto.getRandomValues rather than Math.random: this is the one thing in the
 * exchange doing a security job, and it costs the same.
 */
export function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Give up on a sign-in nobody is completing. Five minutes is a slow reader. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** How often the opener looks to see whether the popup has come home. */
const POLL_MS = 250;

/**
 * Open `authUrl`, wait for the popup to return to our redirect page, and read
 * the fragment it came back with.
 *
 * Answers with the parsed fragment parameters. The provider decides what they
 * mean, because the names differ - `access_token` and `expires_in` are Google's
 * and Microsoft's spelling and are not in any way guaranteed elsewhere.
 *
 * Throws with a sentence rather than a code, on all four ways this ends badly:
 * the popup was blocked, the person closed it, the provider said no, or nobody
 * finished. Every one of those is shown to a person, so every one of them is
 * written as something a person can act on.
 */
export async function fragmentViaPopup(authUrl: string, windowName: string): Promise<URLSearchParams> {
  const home = redirectUri();
  // Size only. `noopener` must not appear in this string in any form - not even
  // as `noopener=no`, which parses to false but is one reading away from being
  // "corrected" to the opposite by somebody tidying: with noopener, window.open
  // answers null and the severed popup can never be read, which is the one thing
  // this whole function does.
  const popup = window.open(authUrl, windowName, 'width=520,height=680');
  if (!popup) {
    throw new Error('the sign-in window was blocked - allow pop-ups for this site and try again');
  }

  const started = Date.now();
  try {
    for (;;) {
      await new Promise(done => setTimeout(done, POLL_MS));

      // Checked before the address, and that order matters: a closed window
      // still answers `.closed`, and reading `.location` on one throws a
      // different and much less helpful error.
      if (popup.closed) throw new Error('the sign-in window was closed before it finished');
      if (Date.now() - started > SIGN_IN_TIMEOUT_MS) throw new Error('the sign-in took too long');

      let href = '';
      try {
        href = popup.location.href;
      } catch {
        // Still on the provider's own origin, which is where it should be for
        // most of this. Not an error and not worth counting.
        continue;
      }
      // Some engines answer 'about:blank' rather than throwing while the popup
      // is between documents, and one answers the empty string. Neither is the
      // page being waited for.
      if (!href || !href.startsWith(home)) continue;

      // The token arrives in the fragment, which is the whole reason this flow
      // is safe to read out of a URL at all: a fragment is never sent to a
      // server, so it is not in our host's logs, not in a referrer, and not in
      // anything Cloudflare sees.
      const fragment = popup.location.hash.replace(/^#/, '');
      const query = popup.location.search.replace(/^\?/, '');
      // Both halves, because a refusal comes back as a query parameter where a
      // grant comes back as a fragment - and a refusal read as "not here yet"
      // would hang until the timeout.
      return new URLSearchParams(fragment || query);
    }
  } finally {
    // Always, including on the throw. A sign-in window left open over a board is
    // furniture nobody asked for, and the one case where it should stay - the
    // person closed it themselves - has already closed it.
    try { popup.close(); } catch { /* already gone */ }
  }
}
