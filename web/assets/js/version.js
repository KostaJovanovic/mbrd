// Stamped by save.bat on every commit - do not edit these two lines by hand.
export const COMMIT_COUNT = 248;
export const VERSION = '0.248';

// Commits crowned as major releases. Keep in sync with RELEASES in save.bat.
export const RELEASE_COMMITS = [];

export function versionLabel(n = COMMIT_COUNT) {
  let major = 0, base = 0;
  for (const r of RELEASE_COMMITS) {
    if (n >= r) { major++; base = r; } else break;
  }
  if (major === 0) return '0.' + String(n).padStart(2, '0');
  if (n - base === 0) return major + '.0';
  return major + '.' + String(n - base).padStart(2, '0');
}
