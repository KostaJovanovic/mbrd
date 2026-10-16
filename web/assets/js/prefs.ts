// Per-person preferences via localStorage (vs board.settings, which travels in
// the .mbrd). Every access is wrapped: localStorage throws in private windows
// and some managed browsers, and an uncaught throw during boot would blank the
// app. Reads return the fallback; writes return false. Keys stay with their
// owning modules — this file stores and retrieves, it does not interpret.

/** Read a preference, returning fallback if absent or storage refused. */
export function readPref(key: string, fallback: string | null = null): string | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/**
 * Suppress all writes until reload. Used by /patch so browsing the changelog
 * cannot overwrite the visitor's real preferences. Reads are untouched.
 */
let frozen = false;

export function freezePrefs() { frozen = true; }

/** Store a value. False if frozen, quota full, or storage unavailable. */
export function writePref(key: string, value: unknown): boolean {
  if (frozen) return false;
  try { localStorage.setItem(key, String(value)); return true; }
  catch { return false; }
}

/** Forget a value, for a key that has been retired. False if frozen or storage refused. */
export function removePref(key: string): boolean {
  if (frozen) return false;
  try { localStorage.removeItem(key); return true; }
  catch { return false; }
}

/** Read a JSON preference. Parse failure returns fallback, same as absence. */
export function readPrefJSON<T = unknown>(key: string, fallback: T | null = null): T | null {
  try {
    const raw = localStorage.getItem(key);
    // SAFETY: T is unchecked. The three callers take unknown or pass it to cloneLook(),
    // which re-checks every field.
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Shared prefix for all app keys. Named here because clearPrefs() sweeps by it. */
const PREF_PREFIX = 'mbrd.';

/**
 * Remove all app preferences. Swept by prefix, not a list — no registration needed.
 * Collected first: removing while walking by index skips every other key.
 */
export function clearPrefs(): boolean {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREF_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
