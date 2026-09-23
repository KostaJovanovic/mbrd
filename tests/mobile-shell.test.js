// The Android shell's own checks, read as text: no JDK or Android SDK runs in
// this suite. Each holds one rule a crafted file with an XSS would test first,
// since it can call every plugin and fetch every route directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, read } from './helpers.js';

const APP = join(ROOT, 'mobile', 'android', 'app', 'src', 'main');
const JAVA = join(APP, 'java', 'com', 'valjdakosta', 'mbrd');
const skip = !existsSync(JAVA) && 'mobile/ is absent from this checkout';

test('Capacitor\'s file and content routes answer 404 before any origin branch', { skip }, () => {
  const client = read(join(JAVA, 'MbrdWebViewClient.java'));
  const intercept = /WebResourceResponse intercept\([\s\S]*?\n {4}\}/.exec(client)[0];
  const refused = intercept.indexOf('if (path.startsWith("/_capacitor_")) return status(404);');
  assert.ok(refused > 0, 'no 404 for /_capacitor_');
  // http://app and the live-reload server reach Capacitor's server through
  // these branches, which serve the two routes on every host they know.
  for (const branch of ['bridge.getServerUrl()', 'boolean appOrigin', 'bridge.getLocalServer()']) {
    const at = intercept.indexOf(branch);
    assert.ok(at > refused, `${branch} comes before the 404`);
  }
  assert.equal([...intercept.matchAll(/_capacitor_/g)].length, 1);
});

test('the FileProvider hands out only the share folder', { skip }, () => {
  // Wider, "Open with" on a URI of the app's own provider made mbrd read a
  // file the sending app could not, and hand it to the page.
  const paths = read(join(APP, 'res', 'xml', 'file_paths.xml')).replace(/<!--[\s\S]*?-->/g, '');
  const entries = [...paths.matchAll(/<([a-z-]+-path)\b([^>]*)\/>/g)];
  assert.equal(entries.length, 1, 'one path');
  assert.equal(entries[0][1], 'cache-path');
  assert.match(entries[0][2], /path="mbrd-share\/"/);
  const shell = read(join(JAVA, 'MbrdShell.java'));
  assert.match(shell, /new File\(ctx\.getCacheDir\(\), "mbrd-share"\)/, 'share() stages where the provider looks');
});

test('an incoming file on the app\'s own provider is refused', { skip }, () => {
  const shell = read(join(JAVA, 'MbrdShell.java'));
  const deliver = /boolean deliver\(Intent intent\) \{[\s\S]*?\n {4}\}/.exec(shell)[0];
  assert.match(deliver, /ContentResolver\.SCHEME_CONTENT\.equals\(u\.getScheme\(\)\) && !isOwn\(ctx, u\)/);
  const isOwn = /private static boolean isOwn\([\s\S]*?\n {4}\}/.exec(shell)[0];
  assert.match(isOwn, /ctx\.getPackageName\(\) \+ "\.fileprovider"/);
  assert.match(isOwn, /resolveContentProvider\(authority, 0\)/);
});
