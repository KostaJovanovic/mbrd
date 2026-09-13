// The release version, from the one stamp. save.bat writes VERSION into
// web/assets/js/version.js, and electron-builder wants semver, so 0.301 becomes
// 0.301.0 and 1.05 becomes 1.5.0. Shared by scripts/portable.mjs and the
// release workflow, so both compute it the same way. Run directly, it prints
// `version=` and `label=` lines for $GITHUB_OUTPUT.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION_JS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'assets', 'js', 'version.js');

/** '0.301' -> '0.301.0', '1.05' -> '1.5.0'. Anything else is refused, not guessed. */
export function semver(label) {
  const m = /^(\d+)\.(\d+)$/.exec(String(label));
  if (!m) throw new Error(`VERSION "${label}" is not <major>.<minor>`);
  return `${Number(m[1])}.${Number(m[2])}.0`;
}

/** The stamped label and its semver. */
export async function stampedVersion() {
  const { VERSION } = await import(pathToFileURL(VERSION_JS).href);
  return { label: VERSION, version: semver(VERSION) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { label, version } = await stampedVersion();
  console.log(`version=${version}`);
  console.log(`label=${label}`);
}
