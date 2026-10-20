// Which page this is (board, /patch, 404, #bench) and how to navigate back to a board.
// Shared by main.ts, ui/panel.ts (greys board-only actions), commands/view.ts
// (View rows navigate home from /patch). No document access at import time.

/** Memoised: the answer cannot change without a navigation. */
let home: string | null = null;

/** App root path (from document.baseURI / <base>), trailing slash. */
export function homePath(): string {
  if (home === null) home = new URL('.', document.baseURI).pathname;
  return home;
}

/** Whether the current page is /patch (the changelog). Accepts /patch, /patch/
 * and /patch.html — the trailing-slash form must match to avoid falling through
 * to isNotFoundPage (which would skip freezePrefs and leak look changes). */
export function isPatchPage(): boolean {
  const at = location.pathname;
  const patch = homePath() + 'patch';
  return at === patch || at === patch + '/' || at === patch + '.html';
}

/** True when the URL is neither the home page nor /patch — the app is its own
 * 404 page (served as index.html at the missing path). */
export function isNotFoundPage(): boolean {
  if (isPatchPage()) return false;
  const at = location.pathname;
  return at !== homePath() && at !== homePath() + 'index.html';
}

/**
 * Whether this is the benchmark's boot: the home page at `#bench`, or at
 * `#bench:` followed by its options (perf/bench.ts, parseBenchHash()). The
 * home page only - a missing path is the 404 board whatever its fragment -
 * and anchored, for the reason initPerfHash() is: a heading anchor that merely
 * contains the word must not throw away the board somebody opened.
 */
export function isBenchPage(): boolean {
  return !isPatchPage() && !isNotFoundPage() && /^#bench(:[\w=,.-]*)?$/.test(location.hash);
}

/** The three faces of a board, as the View row names them. */
export type BoardFace = 'canvas' | 'feed' | 'playlist';

/** Navigate from /patch back to a board face. Returns true if it navigated.
 * Face travels as a fragment (#feed, #playlist); canvas has none (it is the
 * default). Does not apply to the 404 page (that IS a board). */
export function goHome(face: BoardFace = 'canvas'): boolean {
  if (!isPatchPage()) return false;
  location.href = homePath() + (face === 'canvas' ? '' : '#' + face);
  return true;
}

/** The face requested via fragment (#feed, #playlist), or null for canvas. */
export function openingFace(): BoardFace | null {
  const hash = location.hash.replace(/^#/, '');
  return hash === 'feed' || hash === 'playlist' ? hash : null;
}

/** Whether the address asks for Check for updates (#update): the patch page's
 * link, which is a link because nothing runs on that page. Home page only. */
export function openingUpdateCheck(): boolean {
  return !isPatchPage() && !isNotFoundPage() && location.hash === '#update';
}

/** The query parameter for shared boards (?s=...). Query not fragment — chat
 * clients and mailers strip fragments more aggressively. Both the link builder
 * and the boot reader must agree on this name. */
export const SHARE_PARAM = 's';

/** Raw share reference from ?s=, or null. Unparsed — parsing requires the
 * cloud module, and main.ts should not load it just to check. */
export function openingShare(): string | null {
  try {
    return new URLSearchParams(location.search).get(SHARE_PARAM);
  } catch {
    // Malformed query string — not a share link.
    return null;
  }
}
