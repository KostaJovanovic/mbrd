// Stamped by save.bat on every commit - do not edit these two lines by hand.
export const COMMIT_COUNT = 753;
export const VERSION = '0.753';

// Commits crowned as major releases, ascending. `save.bat crown "message"`
// appends the commit it makes; save.bat reads the list from here, so there is
// no second copy of it. Keep it on one line - the crown finds it by regex.
export const RELEASE_COMMITS = [];

/**
 * The version a commit count reads as. Before the first crown, 0.<count>,
 * padded to two digits as it always was. After one, <major>.<commits since
 * it>, unpadded, so 1.5 is the fifth commit after 1.0 and its installers say
 * 1.5.0 (desktop/scripts/version.mjs) - the same number either way.
 */
export function versionLabel(n = COMMIT_COUNT, releases = RELEASE_COMMITS) {
  let major = 0, base = 0;
  for (const r of releases) {
    if (n >= r) { major++; base = r; } else break;
  }
  if (major === 0) return '0.' + String(n).padStart(2, '0');
  return major + '.' + (n - base);
}
