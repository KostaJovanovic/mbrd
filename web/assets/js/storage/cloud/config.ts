// The registered application's identifiers, and the only file a deployer edits.
//
// Separate from google.ts, and the reason is not tidiness. The settings panel
// has to know *synchronously*, while it is building a row, whether this build
// can share a link at all - the schema's rule is absence rather than disabling,
// so a row that cannot work must not be drawn. Asking that question must not be
// the thing that makes the OAuth flow and the resumable uploader a dependency of
// the settings panel.
//
// Which is a statement about the module graph and not about download size, and
// the difference is worth being exact about because the obvious reading of
// "loaded on demand" is wrong here. `npm run build` is one esbuild invocation
// with no code splitting, so a dynamically imported module is inlined into
// web/assets/app.js like everything else - the bytes ship either way. What the
// seam buys is that ui/settings-schema.ts does not sit on top of google.ts in
// tests/layers.test.js's graph, and that none of that module is *evaluated* on a
// boot where nobody shares anything. optimize/ hangs off the tree on exactly
// these terms and CLAUDE.md states them.
//
// So this file imports nothing, is imported by provider.ts and google.ts, and
// holds two strings.
//
// ── Why these are in the clear, and what actually protects them ──
//
// A browser OAuth client id and a browser API key cannot be secret: the first is
// in every authorisation URL a person can read out of their own address bar, and
// the second is in every request the recipient's browser makes. What protects
// them is registration. The OAuth client names the exact origins allowed to use
// it and the API key is restricted to the same referrers, so a copy lifted from
// this repository is useless from any other host. Filling these in is the whole
// of turning the feature on; leaving them empty is the whole of leaving it off.
//
// ── Setting up the Google side, once ──
//
//   1. A Google Cloud project with the Drive API enabled.
//   2. An OAuth client of type *Web application*. Its authorised JavaScript
//      origins and its authorised redirect URIs must both list every origin this
//      app is served from - the deploy, and http://localhost:6273 for the dev
//      server, or the feature cannot be tried locally at all.
//   3. Each redirect URI is the origin plus `/oauth.html`. See web/oauth.html,
//      which exists for no other reason and carries no script.
//   4. A browser API key in the same project, restricted by HTTP referrer to the
//      same origins.
//
// The consent screen only ever asks for `drive.file`, which reaches files this
// app itself created and nothing else. That scope is non-sensitive, so it needs
// none of the annual third-party security assessment the wider Drive scopes
// drag in - see the header of google.ts, where widening it is argued against at
// length.

/** The OAuth client id. Empty means Google Drive is simply not offered. */
export const GOOGLE_CLIENT_ID =
  '250296048583-uifl9o940mbcamc1idu8sag4hikb6un7.apps.googleusercontent.com';

/**
 * The browser API key, used only by the recipient's half.
 *
 * Fetching a public file with no token still needs a project to bill the request
 * to, and this is that. The sender carries a bearer token and needs no key -
 * which means a build with a client id and no key can upload a board and then
 * not be able to open its own link. Both or neither, and provider.ts enforces it.
 */
export const GOOGLE_API_KEY = 'AIzaSyC8TAfzTKybC94aEikm4fsaR1qGvzdMYM4';
