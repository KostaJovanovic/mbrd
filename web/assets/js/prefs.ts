// The things that follow the person rather than the board.
//
// The look, the volume, whether a panel is open, which sticker page was last
// open - as against everything in `board.settings`, which travels inside the
// .mbrd and belongs to the document rather than to the machine it is being
// read on. That line is the whole reason this module exists as a concept: a
// value on the wrong side of it either fails to follow a board to another
// computer or follows it when it should not, and both are the kind of bug
// nobody reports because it looks like the app simply forgot.
//
// ── Why every access is wrapped ──
//
// localStorage is not merely *empty* in a private window - touching it throws
// outright, and some managed browsers refuse it on an ordinary one too. An
// uncaught throw on the way through boot would take the entire app down over a
// remembered slider position: a blank page, no board, no message, because of a
// preference. So there is no bare `localStorage` anywhere in the app; there is
// this. The wrapper was written out by hand six times in six modules before it
// was written down once here.
//
// The reads return the fallback and the writes return false. Deliberately not
// a throw and not a promise: a preference that cannot be read is a preference
// that was not set, and every caller's correct response to that is the same
// one - carry on with the default - so making them each handle it would only
// give six chances to handle it differently.
//
// ── What must not move in here ──
//
// The keys themselves. Each stays with the module that owns it, named at the
// point it is read, because a table of every key in the app would be a second
// place to remember a new preference and would drift from the first. PREF_PREFIX
// is the one exception and it is not a key: it is the shape all of them share,
// and it is here because clearPrefs() below sweeps by it.
//
// Nor anything that *interprets* a stored value. A number that has to be held
// to a range, a JSON blob that has to match a schema - those belong to whoever
// owns the key, since only that module knows what a sensible value is. This
// module's promise stops at "the string that was stored, or nothing".
//
// Nor IndexedDB. storage/ owns the asset registry and the session snapshot;
// those are the *board*, not the person, and they are large, asynchronous and
// evictable in ways nothing here is.

/**
 * The string stored under `key`, or `fallback` when there is none - or when
 * storage refused to answer at all.
 */
export function readPref(key: string, fallback: string | null = null): string | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/** Store a value. False when storage refused - full quota, or a private window. */
export function writePref(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, String(value)); return true; }
  catch { return false; }
}

/**
 * The same, for a value stored as JSON. Two ways to get nothing back - storage
 * refused, or what came out will not parse - and they want the same answer,
 * because a preference that cannot be read is a preference that was not set.
 */
export function readPrefJSON<T = unknown>(key: string, fallback: T | null = null): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Every key this app writes wears it. The only reason it is named here. */
export const PREF_PREFIX = 'mbrd.';

/**
 * Forget every preference, whichever module happens to own it.
 *
 * Swept by prefix rather than from a list, and that is deliberate: a list is a
 * second place to remember a new preference, and the one time it is read - a
 * user asking for everything to be deleted - is the one time being one key out
 * of date is a promise broken rather than a small bug. Each key's owner keeps
 * naming its own; nothing has to register anywhere.
 *
 * Collected before anything is removed, because removing from a live Storage
 * while walking it by index skips every other key.
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
