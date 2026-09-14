// What the desktop package ships, checked from the source, since no build runs
// here. FileAnalyser 9.8 shipped with no title bar because its chrome pages were
// left out of the package, and its updaters find a release file by the part of
// the name before the version. Both break silently, so both are held here.
// Reads every file as text: the shell is a second package with its own install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, read } from './helpers.js';

const DESKTOP = join(ROOT, 'desktop');
const protocol = read(join(DESKTOP, 'protocol.ts'));
const buildScript = read(join(DESKTOP, 'scripts', 'build.mjs'));
const builder = read(join(DESKTOP, 'electron-builder.yml'));
const updates = read(join(DESKTOP, 'updates.ts'));

/** The names in `CHROME_FILES`, the allow-list the protocol handler serves. */
function chromeFiles() {
  const list = protocol.match(/export const CHROME_FILES = new Set\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(list, 'desktop/protocol.ts has no `export const CHROME_FILES = new Set([...])`');
  return [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/** A regex literal exported by desktop/updates.ts, rebuilt as a RegExp. */
function exportedPattern(name) {
  const m = updates.match(new RegExp(`export const ${name} = /(.+)/([a-z]*);`));
  assert.ok(m, `desktop/updates.ts no longer exports ${name} as a regex literal`);
  return new RegExp(m[1], m[2]);
}

/** Top-level key -> artifactName, walked line by line as tests/download.test.js once did. */
const artifacts = new Map();
{
  let key = '';
  for (const line of builder.split('\n')) {
    const top = line.match(/^(\w+):/);
    if (top) { key = top[1]; continue; }
    const name = line.match(/^ {2}artifactName: (\S+)\s*$/);
    if (name) artifacts.set(key, name[1]);
  }
}

/** The file a release of 0.302.0 would carry, for one target. */
const EXT = { nsis: 'exe', dmg: 'dmg', appImage: 'AppImage' };
const sample = key => artifacts.get(key).replace('${version}', '0.302.0').replace('${ext}', EXT[key]);

test('every chrome file has a source the build turns into it', () => {
  const names = chromeFiles();
  assert.ok(names.includes('titlebar.html'), 'CHROME_FILES has no titlebar.html');
  const copied = buildScript.match(/\/\\\.\(([\w|]+)\)\$\//)?.[1]?.split('|') ?? [];
  for (const name of names) {
    const source = name.replace(/\.js$/, '.ts');
    assert.ok(existsSync(join(DESKTOP, 'chrome', source)),
      `CHROME_FILES serves ${name}, and desktop/chrome/${source} does not exist`);
    if (name.endsWith('.js')) {
      assert.ok(buildScript.includes(`'${source}'`),
        `desktop/scripts/build.mjs does not build chrome/${source}, so dist/chrome/${name} is never written`);
    } else {
      const ext = name.split('.').pop();
      assert.ok(copied.includes(ext),
        `desktop/scripts/build.mjs copies ${copied.join(', ') || 'nothing'} from chrome/, and not .${ext}, so dist/chrome/${name} is never written`);
    }
  }
});

test('the package ships dist/ whole, which is where the chrome is built', () => {
  assert.match(builder, /^files:\n(?: {2}- .*\n)*? {2}- dist\/\*\*$/m,
    'electron-builder.yml `files:` no longer lists dist/**, so dist/chrome/ is left out: the FileAnalyser 9.8 fault');
});

test('the builder names three files, each with the version', () => {
  assert.deepEqual([...artifacts.keys()].sort(), ['appImage', 'dmg', 'nsis'],
    'artifactName lines found under other keys - has electron-builder.yml been reshaped?');
  for (const [key, name] of artifacts) {
    assert.match(name, /^mbrd-[\w-]+-\$\{version\}\.\$\{ext\}$/, `${key}: ${name} does not end in -\${version}.\${ext}`);
  }
});

test('the updaters find the files the builder names', () => {
  const installer = exportedPattern('INSTALLER_ASSET');
  const appImage = exportedPattern('APPIMAGE_ASSET');
  assert.match(sample('nsis'), installer, 'desktop/updates.ts would not find the Windows installer in a release');
  assert.match(sample('appImage'), appImage, 'desktop/updates.ts would not find the AppImage in a release');
  // And each finds only its own: the release also carries the other systems and the source zip.
  for (const other of [sample('dmg'), sample('appImage'), 'mbrd-source-0.302.0.zip']) {
    assert.doesNotMatch(other, installer, `INSTALLER_ASSET also matches ${other}`);
  }
  for (const other of [sample('dmg'), sample('nsis'), 'mbrd-source-0.302.0.zip']) {
    assert.doesNotMatch(other, appImage, `APPIMAGE_ASSET also matches ${other}`);
  }
});

test('the Android updater finds the APK the release job names', () => {
  const java = read(join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'valjdakosta', 'mbrd', 'MbrdUpdate.java'));
  const literal = java.match(/APK_NAME = Pattern\.compile\("(.+)"\);/)?.[1];
  assert.ok(literal, 'MbrdUpdate.java no longer compiles APK_NAME from one string literal');
  // A Java string literal doubles every backslash.
  const apkName = new RegExp(literal.replace(/\\\\/g, '\\'));
  const workflow = read(join(ROOT, '.github', 'workflows', 'release.yml'));
  const prefix = workflow.match(/"out\/(mbrd-android-)\$VERSION\.apk"/)?.[1];
  assert.ok(prefix, '.github/workflows/release.yml no longer names the APK out/mbrd-android-$VERSION.apk');
  const apk = `${prefix}0.302.0.apk`;
  assert.match(apk, apkName, 'MbrdUpdate.java would not find the APK in a release');
  for (const other of [sample('nsis'), sample('dmg'), sample('appImage'), 'mbrd-source-0.302.0.zip']) {
    assert.doesNotMatch(other, apkName, `APK_NAME also matches ${other}`);
  }
  assert.doesNotMatch(apk, exportedPattern('INSTALLER_ASSET'), 'INSTALLER_ASSET also matches the APK');
  assert.doesNotMatch(apk, exportedPattern('APPIMAGE_ASSET'), 'APPIMAGE_ASSET also matches the APK');
});

test('electron-builder writes no update file and publishes nothing', () => {
  // updates.ts reads GitHub's API. Without `publish: null` electron-builder infers
  // a GitHub target from the git remote and writes latest*.yml anyway.
  assert.match(builder, /^publish: null\s*$/m, 'electron-builder.yml has no top-level `publish: null`');
});

test('the start-up cleanup of an old update cannot throw', () => {
  // The installer that updated the app starts it again before it exits, so its
  // file is still locked when startUpdates() clears the download folder. A bare
  // rmSync there threw EBUSY as an uncaught exception in main (0.336).
  const m = /export function startUpdates\([\s\S]*?\n\}/.exec(updates);
  assert.ok(m, 'no `export function startUpdates(` in desktop/updates.ts - has it moved?');
  assert.doesNotMatch(m[0], /\brmSync\(/, 'startUpdates() removes a file with a bare rmSync - use tidy()');
  assert.match(updates, /function tidy\([\s\S]*?try \{[\s\S]*?rmSync\([\s\S]*?\} catch/, 'tidy() no longer catches');
});
