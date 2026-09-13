// Stage web/ for the Android app: a copy in mobile/www/ with the desktop's
// exclusions, which `cap sync` puts in the APK. Beside it, in the Android
// assets, go mbrd-files.txt (MbrdRouter), mbrd-csp.json (MbrdWebViewClient) and
// the bridge bundle (MbrdShell). It refuses a bundle older than its sources.
// Run from mobile/: node tools/stage-web.mjs

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parsePolicy } from '../../desktop/csp.mts';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(MOBILE, '..');
const WEB = join(ROOT, 'web');
const OUT = join(MOBILE, 'www');
const ASSETS = join(MOBILE, 'android', 'app', 'src', 'main', 'assets');

/** The `extraResources` filter in desktop/electron-builder.yml, written out, for
 * its reasons: the two benches are debug harnesses, sw.js is the web's updater,
 * and the source map is not even committed. `_headers` stays, as on the
 * desktop. Paths are '/'-separated and relative to web/. */
function excluded(rel) {
  if (!rel.includes('/')) return /^lab.*\.html$/.test(rel) || rel === 'sw.js';
  return /^assets\/lab-[^/]*\.js$/.test(rel) || rel === 'assets/app.js.map';
}

/** Every file under `dir`, as paths relative to `base`, '/'-separated. */
function walk(dir, base = dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, base, found);
    else found.push(relative(base, path).split(sep).join('/'));
  }
  return found;
}

function fail(message) {
  console.error(`stage-web: ${message}`);
  process.exit(1);
}

if (!existsSync(join(WEB, 'index.html'))) fail(`${WEB} has no index.html. Is this the repository?`);

// index.html loads assets/app.js, a build artefact, and nothing here builds it.
// A .ts saved after the last build would be in the repository and not in the APK.
const bundle = join(WEB, 'assets', 'app.js');
if (!existsSync(bundle)) fail('web/assets/app.js is missing. Run `npm run build` at the root first.');
const built = statSync(bundle).mtimeMs;
const sources = join(WEB, 'assets', 'js');
const newer = walk(sources).filter(rel => rel.endsWith('.ts') && statSync(join(sources, rel)).mtimeMs > built);
if (newer.length) {
  fail(`web/assets/app.js is older than ${newer.length} source file(s), web/assets/js/${newer[0]} first. `
    + 'Run `npm run build` at the root first.');
}

rmSync(OUT, { recursive: true, force: true });
cpSync(WEB, OUT, {
  recursive: true,
  filter: src => !excluded(relative(WEB, src).split(sep).join('/')),
});

const staged = walk(OUT).sort();
// The Android Gradle plugin unpacks every .gz asset and drops the extension, so
// the file would reach the APK under another name. web/ holds none today. Plan
// §5.8 says what to do when one appears: FileAnalyser stores it as
// <name>.gz.anr, and its router maps the request.
const zipped = staged.filter(rel => rel.endsWith('.gz'));
if (zipped.length) fail(`web/${zipped[0]} is a .gz file, which Android would unpack. See plan §5.8.`);
const bytes = staged.reduce((sum, rel) => sum + statSync(join(OUT, rel)).size, 0);
console.log(`stage-web: ${staged.length} files, ${(bytes / 1048576).toFixed(1)} MB -> mobile/www`);

if (!existsSync(join(MOBILE, 'android'))) {
  console.log('stage-web: no android/ project yet. Run `npx cap add android` in mobile/, then stage again');
  process.exit(0);
}
mkdirSync(ASSETS, { recursive: true });
writeFileSync(join(ASSETS, 'mbrd-files.txt'), staged.join('\n') + '\n');

// The policy the desktop sends, through the desktop's parser. tests/csp.test.js
// holds this file against a fresh parse.
const policy = parsePolicy(readFileSync(join(WEB, '_headers'), 'utf8'));
if (!policy.value) fail('web/_headers has no /* Content-Security-Policy, and the app would run with none.');
writeFileSync(join(ASSETS, 'mbrd-csp.json'), JSON.stringify(policy) + '\n');

// The bridge, one IIFE. The wrapper holds what esbuild would drop or rename: the
// guard, and MBRD_BOOT with the comment MbrdShell.java replaces with the boot
// JSON. esbuild keeps a comment only where it is a legal notice.
const bridge = await build({
  entryPoints: [join(MOBILE, 'bridge', 'mbrd-bridge.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // capacitor.config.json's minWebViewVersion.
  target: 'chrome110',
  write: false,
  logLevel: 'warning',
});
const code = bridge.outputFiles[0].text;
writeFileSync(join(ASSETS, 'mbrd-bridge.js'),
  '// Built by mobile/tools/stage-web.mjs from mobile/bridge/. Do not edit.\n'
  + '(function () {\n'
  + "'use strict';\n"
  + 'if (window.mbrdDesktop) return;\n'
  + 'const MBRD_BOOT = /*MBRD_BOOT*/{};\n'
  + code
  + '})();\n');
console.log('stage-web: mbrd-files.txt, mbrd-csp.json, mbrd-bridge.js -> mobile/android/app/src/main/assets');
