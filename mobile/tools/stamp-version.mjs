// Stamp the Android app's version from the site's. versionName is VERSION and
// versionCode is COMMIT_COUNT, both read from web/assets/js/version.js, which
// save.bat stamps. Android refuses an update whose versionCode does not grow,
// and COMMIT_COUNT only grows: save.bat refuses a save that cannot read it.
// Writes both into android/app/build.gradle. Run from mobile/: node tools/stamp-version.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_JS = join(MOBILE, '..', 'web', 'assets', 'js', 'version.js');
const GRADLE = join(MOBILE, 'android', 'app', 'build.gradle');

const { COMMIT_COUNT, VERSION } = await import(pathToFileURL(VERSION_JS).href);
// Refused rather than guessed, for save.bat's reason: a wrong count strands every installed copy.
if (!Number.isInteger(COMMIT_COUNT) || COMMIT_COUNT < 1) {
  console.error(`stamp-version: COMMIT_COUNT in web/assets/js/version.js is ${COMMIT_COUNT}, not a count`);
  process.exit(1);
}
if (!/^\d+\.\d+$/.test(String(VERSION))) {
  console.error(`stamp-version: VERSION in web/assets/js/version.js is "${VERSION}", not <major>.<minor>`);
  process.exit(1);
}

if (!existsSync(GRADLE)) {
  console.log('stamp-version: no android/ project yet. Run `npx cap add android` in mobile/, then stamp again');
  process.exit(0);
}
const before = readFileSync(GRADLE, 'utf8');
if (!/versionCode\s+\d+/.test(before) || !/versionName\s+"[^"]*"/.test(before)) {
  console.error('stamp-version: android/app/build.gradle has no `versionCode N` and `versionName "…"` lines to stamp');
  process.exit(1);
}
const after = before
  .replace(/versionCode\s+\d+/, `versionCode ${COMMIT_COUNT}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${VERSION}"`);
if (after !== before) writeFileSync(GRADLE, after);
console.log(`stamp-version: ${VERSION} (versionCode ${COMMIT_COUNT})`);
