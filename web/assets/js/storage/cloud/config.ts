// Google OAuth + API key — the only file a deployer edits. Separate from
// google.ts so the panel can check synchronously whether sharing is on.
// Both values are safe in the clear (origin-restricted); empty = off.

/** The OAuth client id. Empty means Google Drive is simply not offered. */
export const GOOGLE_CLIENT_ID =
  '250296048583-uifl9o940mbcamc1idu8sag4hikb6un7.apps.googleusercontent.com';

/**
 * The browser API key, used only by the recipient's half.
 *
 * Fetching a public file with no token still needs a project to bill it to. The
 * sender carries a bearer token and needs no key, so a build with a client id
 * and no key could upload a board and then fail to open its own link. Both or
 * neither - provider.ts enforces it.
 */
export const GOOGLE_API_KEY = 'AIzaSyC8TAfzTKybC94aEikm4fsaR1qGvzdMYM4';
