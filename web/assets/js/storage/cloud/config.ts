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

/**
 * The desktop app's own OAuth client, of the type "Desktop app". The desktop
 * signs in through the system browser and a loopback address
 * (desktop/google-oauth.mts), which a web client refuses. Google calls a
 * Desktop client's secret not secret, and still asks for it. Both or neither.
 * Empty keeps Google Drive out of the desktop app, rather than broken in it.
 */
export const GOOGLE_DESKTOP_CLIENT_ID: string = '';
export const GOOGLE_DESKTOP_CLIENT_SECRET: string = '';

/**
 * Whether an Android OAuth client exists for com.valjdakosta.mbrd and the
 * release key's SHA-1. Google finds that client by the app's signature, so
 * there is no id to write here. False keeps Google Drive out of the Android app.
 */
export const GOOGLE_ANDROID_CLIENT: boolean = false;
