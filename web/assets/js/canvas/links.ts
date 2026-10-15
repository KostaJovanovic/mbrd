// Link addresses: whether a string is one, the guess a typed address is
// allowed, and what a link is called before anybody renames it. Pure string
// and URL work with no imports, so the modules that only ask "is this a link?"
// (the markdown and LaTeX views, the note editor, the gesture pipeline) need
// not load every renderer to find out. The card a link becomes is linkDraft()
// in renderers.ts.

/**
 * Whether a string is a link, and the parsed URL if it is.
 *
 * Strict on purpose, rather than helpful. A string qualifies only if the URL
 * parser accepts the whole of it and what came out was http or https, so
 * `www.example.com` and `example.com/things` are text and stay text: deciding
 * they meant `http://` is a guess, and a guess of that kind silently rewrites
 * what somebody wrote. Whitespace anywhere disqualifies it too, because
 * `have a look at https://example.com` is a sentence about a link rather than
 * a link - and both places that call this mean "this and nothing else".
 *
 * The scheme test is the security half, and an allowlist of exactly two is the
 * only shape of it that cannot be argued around. `javascript:` runs code in
 * this page with this page's privileges; `data:` carries a whole document that
 * arrives with no origin to be judged by; `file:` reaches into the machine.
 * None of the three may ever reach an href.
 *
 * The hostname test never fires as things stand - http and https are "special"
 * schemes and the parser will not hand back one of those without a host. It is
 * written down anyway, because the line under it feeds an href and a guarantee
 * an href rests on should be stated where it is relied on rather than inferred
 * from what a parser happens to do.
 */
export function linkURL(text: unknown): URL | null {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname ? u : null;
}

/**
 * Parse a typed address. Unlike linkURL(), prepends `https://` when no scheme
 * is present — intent is unambiguous from an "Add a link" or Properties box.
 */
export function linkTyped(text: string): URL | null {
  const direct = linkURL(text);
  if (direct) return direct;
  // Already has a scheme (including mailto: etc.) — don't double-prefix.
  return /^[a-z][a-z0-9+.-]*:/i.test(text.trim()) ? null : linkURL('https://' + text.trim());
}

/**
 * A link's host without `www.`, the one part of a hostname that identifies
 * nothing - a convention about a server, not about whose site this is. The URL
 * parser has already lowercased it.
 */
export const bareHost = (u: URL) => u.hostname.replace(/^www\./, '');

/** What a link is called before anybody renames it: the site it points at. */
export const linkName = bareHost;

/**
 * What a link is called before anybody renames it. The site by default, but a
 * couple of sites carry the useful name in the address itself: a Steam store URL
 * spells the game in its slug, a Reddit URL spells the subreddit. Reading it off
 * the path fetches nothing and is exact, so the chip says "ULTRAKILL" or "r/pics"
 * rather than the bare host. A rename still overrides it (it becomes item.name).
 */
export function smartLinkName(u: URL): string {
  return steamGame(u) ?? redditSub(u) ?? linkName(u);
}

// The game a Steam store link points at: the slug after /app/<id>/, underscores
// back to spaces, capped so a long title does not push the chip past the card.
function steamGame(u: URL): string | null {
  const host = bareHost(u);
  if (host !== 'store.steampowered.com' && host !== 'steamcommunity.com') return null;
  const m = /\/app\/\d+\/([^/]+)/.exec(u.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/[_+]/g, ' ').trim().slice(0, 20); }
  catch { return m[1].replace(/[_+]/g, ' ').slice(0, 20); }
}

// The subreddit a Reddit link is under: /r/<name>. Null for a user page or the
// front page, which fall back to the host.
function redditSub(u: URL): string | null {
  const host = u.hostname.replace(/^(www|old|new|np)\./, '');
  if (host !== 'reddit.com') return null;
  const m = /^\/r\/([^/]+)/i.exec(u.pathname);
  return m ? `r/${m[1]}` : null;
}
