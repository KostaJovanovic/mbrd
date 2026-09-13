// What MbrdShell.java tells the bridge before the page runs. stage-web.mjs
// wraps the bundle in a function that declares MBRD_BOOT with a marker, and
// bridgeScript() in MbrdShell.java puts the JSON in its place. So the value
// exists only in the injected script, and a bundle run any other way sees {}.

declare const MBRD_BOOT: {
  /** The app's versionName, which stamp-version.mjs wrote. */
  version?: string;
  /** False for a debuggable build, as app.isPackaged is on the desktop. */
  packaged?: boolean;
  /** Whether the byte channel takes ArrayBuffer messages (WEB_MESSAGE_ARRAY_BUFFER). */
  arrayBuffers?: boolean;
};

export const BOOT = MBRD_BOOT;
