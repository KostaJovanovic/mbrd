// Choosing a picture out of an app package or a book (import/packages.js).
//
// Unlike import/document.js, which looks a thumbnail up at a path a
// specification names, every family here has to *rank* what it finds - so what
// these tests are really about is the ordering, and the ordering is where the
// judgement calls live. Each one below states a rule the module is making rather
// than a byte layout it is reading.
//
// Archives are built through the app's own writeZip(), which is what
// tests/document.test.js does and for the reason it gives: a fixture assembled by
// hand can be wrong in exactly the way the reader is wrong, and the two agree
// with each other while disagreeing with every real file.
//
// The discipline is tests/preview.test.js's: **every refusal is paired with a
// working fixture asserted first**, because null is this module's answer to
// everything and a test that only asserts null passes on a broken fixture too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeZip } from '../web/assets/js/storage/zip.ts';
import { packagePicture, isPackage } from '../web/assets/js/import/packages.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/**
 * A run of bytes that sniffs as a PNG, `size` long.
 *
 * The length is the point in most of these: entry size is the module's stand-in
 * for pixel count, so making one candidate longer is how a test says "this is
 * the bigger icon" without carrying a real encoder.
 */
function png(size = 2048, fill = 0x21) {
  const b = new Uint8Array(Math.max(size, 16)).fill(fill);
  b.set(PNG_SIG);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  return b;
}

/** The same, marked the way Xcode marks every PNG inside an .app. */
function cgbi(size = 2048) {
  const b = png(size);
  b.set([0x43, 0x67, 0x42, 0x49], 12);
  return b;
}

function jpeg(size = 2048) {
  const b = new Uint8Array(Math.max(size, 16)).fill(0x33);
  b.set([0xFF, 0xD8, 0xFF, 0xE0]);
  return b;
}

/** An archive from `{ path: bytes }`. */
const zip = (files) =>
  writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));

/** The chosen picture's bytes, or null. */
const pick = async (files, ext) => await packagePicture(await zip(files), ext);

// ---------------------------------------------------------------------------
// What it claims
// ---------------------------------------------------------------------------

test('it claims the package extensions and leaves the rest alone', () => {
  for (const ext of ['apk', 'xapk', 'apkm', 'apks', 'ipa', 'appx', 'msix', 'epub', 'cbz', '3mf']) {
    assert.equal(isPackage(ext), true, ext);
  }
  // .cbr and .cb7 are RAR and 7z. Declining them by not claiming them is the
  // honest shape - opening one and failing would report a broken file.
  for (const ext of ['cbr', 'cb7', 'docx', 'zip', 'exe', '']) {
    assert.equal(isPackage(ext), false, ext);
  }
});

test('a file whose extension it does not claim comes back null', async () => {
  assert.equal(await pick({ 'res/mipmap-hdpi/ic_launcher.png': png() }, 'zip'), null);
});

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

test('it finds an Android launcher icon and prefers the densest one', async () => {
  const got = await pick({
    'res/mipmap-mdpi/ic_launcher.png': png(1024, 1),
    'res/mipmap-xxxhdpi/ic_launcher.png': png(1024, 2),
    'res/mipmap-hdpi/ic_launcher.png': png(1024, 3),
  }, 'apk');
  assert.ok(got, 'the fixture is broken if this is null');
  assert.equal(got[100], 2, 'xxxhdpi won');
});

test('a name that says ic_launcher beats a larger picture that does not', async () => {
  // Size is only the tie-break. A screenshot in the mipmap tree is bigger than
  // the icon and is not the icon.
  const got = await pick({
    'res/mipmap-xxxhdpi/ic_launcher.png': png(1024, 7),
    'res/mipmap-xxxhdpi/splash_art.png': png(80000, 8),
  }, 'apk');
  assert.ok(got);
  assert.equal(got[100], 7);
});

test('with nothing named ic_launcher the mipmap tree is ranked anyway', async () => {
  const got = await pick({
    'res/mipmap-hdpi/app_mark.png': png(1024, 4),
    'res/mipmap-xxhdpi/app_mark.png': png(1024, 5),
  }, 'apk');
  assert.ok(got);
  assert.equal(got[100], 5);
});

test('res/drawable is the last resort, under every mipmap', async () => {
  const got = await pick({
    'res/drawable-xxxhdpi/ic_launcher.png': png(9000, 6),
    'res/mipmap-ldpi/whatever.png': png(1024, 9),
  }, 'apk');
  assert.ok(got);
  assert.equal(got[100], 9, 'even ldpi in mipmap outranks drawable');
});

test('an adaptive icon is XML and is not a picture', async () => {
  // This is the case the whole glob-instead-of-ARSC decision turns on: anydpi
  // holds the adaptive icon, which is a vector document, and taking it would be
  // mounting markup as an image.
  const xml = new Uint8Array(4096).fill(0x3C);
  const got = await pick({
    'res/mipmap-anydpi-v26/ic_launcher.xml': xml,
    'res/mipmap-hdpi/ic_launcher.png': png(1024, 11),
  }, 'apk');
  assert.ok(got);
  assert.equal(got[100], 11);
  assert.equal(await pick({ 'res/mipmap-anydpi-v26/ic_launcher.xml': xml }, 'apk'), null);
});

test('a package with no icon anywhere is null, not an accident', async () => {
  assert.equal(await pick({ 'classes.dex': png(4096), 'AndroidManifest.xml': png(600) }, 'apk'), null);
});

test('a picture too small to be an icon is not one', async () => {
  assert.equal(await pick({ 'res/mipmap-hdpi/ic_launcher.png': png(200) }, 'apk'), null);
});

// ---------------------------------------------------------------------------
// Android bundles
// ---------------------------------------------------------------------------

test('a bundle takes the store icon beside the packages', async () => {
  const got = await pick({
    'icon.png': png(1024, 12),
    'base.apk': png(5000, 13),
  }, 'xapk');
  assert.ok(got);
  assert.equal(got[100], 12);
});

test('with no store icon a bundle descends one level into the base package', async () => {
  const inner = await zip({ 'res/mipmap-xxhdpi/ic_launcher.png': png(1024, 14) });
  const got = await pick({
    'base.apk': new Uint8Array(await inner.arrayBuffer()),
    'split_config.arm64_v8a.apk': png(9000, 15),
  }, 'xapk');
  assert.ok(got, 'the inner package was not opened');
  assert.equal(got[100], 14);
});

test('a bundle whose inner package is nonsense is null rather than a throw', async () => {
  const got = await pick({ 'base.apk': png(9000) }, 'xapk');
  assert.equal(got, null);
});

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

test('an .ipa takes iTunesArtwork, which is the one PNG Xcode did not rewrite', async () => {
  const got = await pick({
    'iTunesArtwork': png(1024, 16),
    'Payload/App.app/AppIcon60x60@3x.png': png(60000, 17),
  }, 'ipa');
  assert.ok(got);
  assert.equal(got[100], 16);
});

test('an Apple-optimised icon is refused rather than mounted broken', async () => {
  // The rule this codebase already applies to docProps/thumbnail.emf: a picture
  // nothing can draw is worse than no picture.
  assert.ok(
    await pick({ 'Payload/App.app/AppIcon76x76.png': png(4096, 18) }, 'ipa'),
    'an ordinary PNG under Payload is taken, so the refusal below means something',
  );
  assert.equal(
    await pick({ 'Payload/App.app/AppIcon76x76.png': cgbi(4096) }, 'ipa'),
    null,
  );
});

test('a CgBI iTunesArtwork does not sneak past on its name', async () => {
  assert.equal(await pick({ 'iTunesArtwork': cgbi(4096) }, 'ipa'), null);
});

test('a JPEG iTunesArtwork is legal and is taken', async () => {
  const got = await pick({ 'iTunesArtwork': jpeg(2048) }, 'ipa');
  assert.ok(got);
  assert.equal(got[0], 0xFF);
});

// ---------------------------------------------------------------------------
// Windows app packages
// ---------------------------------------------------------------------------

test('an .appx takes a square logo over the wide banner', async () => {
  const got = await pick({
    'Assets/Wide310x150Logo.scale-200.png': png(40000, 19),
    'Assets/Square150x150Logo.scale-200.png': png(1024, 20),
  }, 'appx');
  assert.ok(got);
  assert.equal(got[100], 20, 'a banner is the wrong shape for a card');
});

test('an .msix with only a store logo still answers', async () => {
  const got = await pick({ 'Assets/StoreLogo.png': png(2048, 21) }, 'msix');
  assert.ok(got);
  assert.equal(got[100], 21);
});

test('pictures outside Assets are not the app package logo', async () => {
  assert.equal(await pick({ 'Images/Icon.png': png(4096) }, 'appx'), null);
});

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

// The manifest walk is the half of this module that reads XML, and it needs a
// DOMParser - which Node does not have, and which nothing in this suite shims.
// ui/documents.ts is in exactly the same position and tests/documents.test.js
// says so outright: what is testable here is the module's *decisions*, and the
// tree walk is checked by opening a book in a browser.
//
// So what these cover is everything either side of the parse: the fallback taken
// when the manifest cannot be read, and the refusals. In Node, xmlPart() answers
// null for every part, which makes every EPUB fixture below take exactly the path
// a real book with a malformed OPF takes - which is worth having tested in its
// own right, since that is the case nobody constructs deliberately.

const opf = (manifest, meta = '') => new TextEncoder().encode(
  `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">`
  + `<metadata>${meta}</metadata><manifest>${manifest}</manifest></package>`,
);

const container = (path) => new TextEncoder().encode(
  `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">`
  + `<rootfiles><rootfile full-path="${path}" media-type="application/oebps-package+xml"/>`
  + `</rootfiles></container>`,
);

test('a book whose manifest cannot be read falls back to a file called cover', async () => {
  const got = await pick({
    'META-INF/container.xml': container('OEBPS/book.opf'),
    'OEBPS/book.opf': opf('<item id="c" href="images/front.png" properties="cover-image"/>'),
    'OEBPS/cover.jpeg': jpeg(2048),
  }, 'epub');
  assert.ok(got, 'the fallback did not fire');
  assert.equal(got[0], 0xFF);
});

test('the fallback is a name match, not "the biggest picture in the book"', async () => {
  // A book is mostly pictures. Taking the largest would hand back a plate from
  // the middle of it, which is worse than the grey card because it looks right.
  assert.equal(await pick({
    'OEBPS/images/plate1.png': png(90000),
    'OEBPS/images/plate2.png': png(90000),
  }, 'epub'), null);
});

test('a book with no cover under any reading is null', async () => {
  assert.equal(await pick({
    'META-INF/container.xml': container('book.opf'),
    'book.opf': opf('<item id="c" href="missing.png" properties="cover-image"/>'),
    'text/chapter1.xhtml': png(4096),
  }, 'epub'), null);
});

// ---------------------------------------------------------------------------
// Comics and prints
// ---------------------------------------------------------------------------

test('a comic opens on page one, with the numbers read as numbers', async () => {
  // A plain string sort puts page10 before page2, which is the wrong cover.
  const got = await pick({
    'page10.png': png(1024, 27),
    'page2.png': png(1024, 28),
    'page1.png': png(1024, 29),
  }, 'cbz');
  assert.ok(got);
  assert.equal(got[100], 29);
});

test('a comic ignores anything that is not a page', async () => {
  const got = await pick({
    'ComicInfo.xml': png(4096, 30),
    '001.jpg': jpeg(2048),
  }, 'cbz');
  assert.ok(got);
  assert.equal(got[0], 0xFF, 'the .xml is not a page even though it is bigger');
});

test('a 3MF takes the thumbnail the packaging convention names', async () => {
  const got = await pick({
    'Metadata/thumbnail.png': png(2048, 31),
    '3D/3dmodel.model': png(9000, 32),
  }, '3mf');
  assert.ok(got);
  assert.equal(got[100], 31);
});

test('a 3MF whose slicer put the thumbnail elsewhere under Metadata still answers', async () => {
  const got = await pick({ 'Metadata/plate_1.png': png(2048, 33) }, '3mf');
  assert.ok(got);
  assert.equal(got[100], 33);
});

// ---------------------------------------------------------------------------
// Not an archive at all
// ---------------------------------------------------------------------------

test('a file that is not a zip throws rather than answering null', async () => {
  // Deliberate, and the split import/document.js already makes: "no picture in
  // this container" is null, "this is not a container" is the archive reader's
  // error for the caller to turn into a card.
  await assert.rejects(() => packagePicture(new Blob([png(4096)]), 'apk'));
});
