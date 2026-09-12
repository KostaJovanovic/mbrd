// Generic OAuth implicit-grant flow for cloud providers.
// Opens a popup, polls until it lands on our redirect page, reads the
// fragment. No SDK (would require script-src host), no server (PKCE code
// exchange needs one). Token in sessionStorage — survives reload, dies
// with the tab. Implicit grant chosen deliberately: PKCE requires a
// server-side exchange, and this app runs no server.

/** A token and the moment it stops being one. */
export interface TokenGrant {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** The page every provider redirects back to. Same origin, and carries no script. */
export const REDIRECT_PATH = 'oauth.html';

/** Buffer before true expiry — avoids starting an upload with a near-dead token. */
const EXPIRY_MARGIN_MS = 60_000;

/** Whether a grant is still worth using. Null is not, which is the common case. */
export function usable(grant: TokenGrant | null): boolean {
  return !!grant && grant.expiresAt - EXPIRY_MARGIN_MS > Date.now();
}

// ---------------------------------------------------------------------------
// sessionStorage cache — survives reload, dies with the tab
//
// sessionStorage, not localStorage: the token expires in ~1 hour anyway,
// so localStorage only adds a dead credential on disk. Not in prefs.ts
// because a token is not a preference.
// ---------------------------------------------------------------------------

/** One key per provider, so two accounts cannot overwrite each other. */
const storeKey = (provider: string) => `mbrd.cloud.${provider}`;

/** Persist or clear a grant. Wrapped because storage can throw (private mode, quota). */
export function rememberGrant(provider: string, grant: TokenGrant | null): void {
  try {
    if (grant) sessionStorage.setItem(storeKey(provider), JSON.stringify(grant));
    else sessionStorage.removeItem(storeKey(provider));
  } catch {
    // Token stays in memory; just will not survive a reload.
  }
}

/** Recall a cached grant, returning null if expired or malformed. Drops stale entries. */
export function recallGrant(provider: string): TokenGrant | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(storeKey(provider));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    // Checked field by field — malformed entries fall out as null.
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

/** CSRF nonce — response must echo it. Uses crypto.getRandomValues, not Math.random. */
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
 * Open `authUrl` in a popup, poll until it returns to our redirect page,
 * and return the parsed fragment/query parameters. Throws user-facing
 * messages on block, close, refusal, or timeout.
 */
export async function fragmentViaPopup(authUrl: string, windowName: string): Promise<URLSearchParams> {
  const home = redirectUri();
  // No `noopener` — with it, window.open returns null and the popup cannot be read.
  const popup = window.open(authUrl, windowName, 'width=520,height=680');
  if (!popup) {
    throw new Error('the sign-in window was blocked - allow pop-ups for this site and try again');
  }

  const started = Date.now();
  try {
    for (;;) {
      await new Promise(done => setTimeout(done, POLL_MS));

      // Check closed before location — reading location on a closed window throws.
      if (popup.closed) throw new Error('the sign-in window was closed before it finished');
      if (Date.now() - started > SIGN_IN_TIMEOUT_MS) throw new Error('the sign-in took too long');

      let href = '';
      try {
        href = popup.location.href;
      } catch {
        // Still on the provider's origin — cross-origin read throws, expected.
        continue;
      }
      // Some engines return 'about:blank' or '' between navigations.
      if (!href || !href.startsWith(home)) continue;

      // Fragment (never sent to a server) carries the token.
      const fragment = popup.location.hash.replace(/^#/, '');
      const query = popup.location.search.replace(/^\?/, '');
      // Refusal arrives as query, grant as fragment — read both.
      return new URLSearchParams(fragment || query);
    }
  } finally {
    // Always close, including on throw.
    try { popup.close(); } catch { /* already gone */ }
  }
}
