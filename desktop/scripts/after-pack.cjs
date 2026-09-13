// electron-builder afterPack hook: an ad-hoc signature for the macOS app. A
// port of FileAnalyser's desktop/tools/after-pack.cjs. With no Developer ID,
// mac.identity is null and the bundle keeps Electron's own signature, which the
// renamed executable breaks, so macOS calls the app "damaged". Ad-hoc is valid,
// so macOS offers Open Anyway instead. CommonJS: electron-builder require()s it.

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

// electron-builder runs user hooks after its own ("user handlers are always
// last", app-builder-lib's asyncEventEmitter.js), so nothing it writes into the
// bundle comes after the signature and breaks it again. Remove this hook and
// mac.identity: null once a certificate exists.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // The universal build packs x64 and arm64 into `<dir>-x64-temp` and
  // `<dir>-arm64-temp`, merges them, then calls this hook once more on the
  // merged app. Only that last one ships, so only it is signed, and the two
  // halves reach the merge as electron-builder made them.
  if (context.appOutDir.endsWith('-temp')) return;
  const bundle = join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
};
