// Which page of the site this is, and the way back to the board from the one
// that is not a board.
//
// Two facts about the address bar that three layers now need and none of them
// owns. main.ts worked both out for itself and kept them private, which was
// right while it was the only module that cared: it is what decides whether to
// restore a session, whether to wire the idle fade, and what to put in the
// title. Then the changelog grew the app's *real* sidebar around it - the real
// tabs, the real sections, built from the real schema - and two more places had
// to know:
//
//   ui/panel.ts, because a Save button, an Export and a Clear everything on a
//   page with no board are three promises the page cannot keep. They are greyed
//   there rather than hidden, which is the one place the schema's own rule
//   (absence, not disabling) is deliberately inverted - see needsBoard in
//   ui/settings-schema.ts for why.
//
//   commands/view.ts, because Canvas, Feed and Playlist are the only rows of
//   that panel a reader can still press, and on the changelog they mean the one
//   thing they cannot mean anywhere else: take me back.
//
// Nothing here runs at import time. `document.baseURI` is read on the first ask
// and remembered after, which is what keeps this module inside the rule the
// whole tree follows (tests/imports.test.js): a module that touches the
// document merely by being imported cannot be loaded by a test with no browser,
// and the three that are allowed to are named there by hand.

/** Memoised: the answer cannot change without a navigation. */
let home: string | null = null;

/**
 * Where the app lives, as a path with a trailing slash.
 *
 * Derived from document.baseURI rather than assumed to be '/', because
 * index.html carries a <base> and the app is wherever that says it is. The two
 * agree at the root today; they would not if this were ever hosted in a
 * subdirectory, and then everything below would still be right.
 */
export function homePath(): string {
  if (home === null) home = new URL('.', document.baseURI).pathname;
  return home;
}

/**
 * The changelog, which is this app showing a document instead of a board.
 *
 * web/patch.html is index.html's entire body - built by
 * tools/gen-patch-page.mjs - so the whole app boots there exactly as it boots
 * on the board, and the panel that slides in over the changelog is this app's
 * panel. patch.css hides the board furniture; nothing on that page is a second
 * implementation of anything.
 *
 * `.html` counts as well, the way index.html does: the host resolves the
 * extensionless form and both spellings are this page. So does the trailing
 * slash, and that one is not tidiness: a host serving the changelog at
 * `/patch/` - or a link written with one, which any host that redirects to the
 * directory form will produce - would otherwise fall through to
 * isNotFoundPage(), and the not-found arm suspends the writer but does *not*
 * call freezePrefs(). Every whimsy nudge, quality change and palette pick a
 * reader made while reading the changelog would then be written to their
 * browser and follow them back to their own board. See prefs.ts: a page that
 * shows somebody a document has no business changing how their board looks.
 */
export function isPatchPage(): boolean {
  const at = location.pathname;
  const patch = homePath() + 'patch';
  return at === patch || at === patch + '/' || at === patch + '.html';
}

/**
 * A dead address, which /patch emphatically is not - hence the first clause.
 *
 * The app is its own 404 page: a host that cannot find a path serves index.html
 * at that path with a 404 status (serve.py does it; a static host is handed
 * 404.html, a byte copy of index.html, to do the same), and this is how the app
 * finds out. Nothing in the response says so - a document cannot read its own
 * status code - so the URL is the signal. `/index.html` is the same page by
 * another name and is not a miss.
 */
export function isNotFoundPage(): boolean {
  if (isPatchPage()) return false;
  const at = location.pathname;
  return at !== homePath() && at !== homePath() + 'index.html';
}

/** The three faces of a board, as the View row names them. */
export type BoardFace = 'canvas' | 'feed' | 'playlist';

/**
 * If this page is not a board, leave it for one, showing the face asked for.
 *
 * Returns whether it navigated, which is what lets the three View commands open
 * with one line each and otherwise carry on exactly as they did - the guard
 * reads as "if there is no board here, go and get one", and the body below it
 * is untouched.
 *
 * A whole navigation rather than a lens switch, because on the changelog there
 * is no board to switch: Feed there put the empty board behind the prose into
 * the mobile layout, and Playlist floated a player window over the changelog.
 * Both did exactly that, which is what this exists to stop.
 *
 * The face travels as a fragment because a fragment is the one part of a URL
 * this app already reads on the way in (#grips, #perf, #load), so it
 * costs main.ts one line rather than a router. Canvas carries none: it is what
 * a board opens as, and a #canvas left in somebody's history would be a URL
 * saying something the plain address already said.
 *
 * Only the changelog for now, and deliberately not the 404: that page is a real
 * board the visitor can drop a file onto, and it hands itself over to the
 * ordinary board the moment they do (leaveNotFound in main.ts). Its View row
 * means what it says.
 */
export function goHome(face: BoardFace = 'canvas'): boolean {
  if (!isPatchPage()) return false;
  location.href = homePath() + (face === 'canvas' ? '' : '#' + face);
  return true;
}

/**
 * Which face a fresh load was asked for, or null for the ordinary one.
 *
 * Read once by main.ts, after the session is back and before the opening view
 * is framed. Deliberately a `startsWith` on the whole fragment rather than the
 * `includes` the debug flags use: those are switches that may be combined on
 * one URL, and this is a choice of one of three.
 */
export function openingFace(): BoardFace | null {
  const hash = location.hash.replace(/^#/, '');
  return hash === 'feed' || hash === 'playlist' ? hash : null;
}
