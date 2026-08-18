// App packages and books: the picture that has to be chosen rather than named.
//
// import/document.js finds a document's thumbnail at a known path - `docProps/
// thumbnail.jpeg`, `Thumbnails/thumbnail.png` - because the specifications that
// define those containers say where it goes. The containers here are the other
// kind. An Android package has its launcher icon at six densities under names the
// build tool chose; an iOS one has a dozen icons sized for places on a home
// screen; a book has a cover the OPF has to be read to find. There is no single
// path to look up, so each of these is a small ranking over the archive's own
// list of names.
//
// That is the whole of what separates this module from that one. Both open a zip
// and both answer with bytes or null; this one has to look at what is inside
// before it knows what it wants.
//
// ── Why the names alone, and not the resource table ──
//
// The correct way to find an Android launcher icon is to parse the binary
// AndroidManifest.xml for `application/@icon`, which yields a resource *reference*
// like `@0x7f0e0001`, and then resolve that through `resources.arsc` to a path.
// That is two more binary formats - and then the answer is often
// `res/mipmap-anydpi-v26/ic_launcher.xml`, an adaptive icon, which is a vector
// document referencing two more drawables, which is a vector renderer.
//
// The convention is strong enough not to need any of it. Every build tool since
// Android Studio's first release writes `res/mipmap-<density>/ic_launcher.png`,
// and where it does not, the largest raster under `res/mipmap-` is the icon in
// all but contrived cases. So this globs, ranks by density and then by size, and
// a package that does not follow the convention is the grey card it was. That is
// a real limit and it is written down here rather than discovered later.
//
// ── The one thing that must be refused ──
//
// Every PNG inside an iOS `.app` has been rewritten by Xcode: channels swapped to
// BGRA, alpha premultiplied, and a `CgBI` chunk where `IHDR` belongs. It is still
// a PNG by its first eight bytes and it decodes in nothing but Apple's own
// software. Handing one to an <img> is the "replace a grey card with a broken
// image" failure this codebase already refuses for .emf, so import/winimage.js
// answers the question and the .ipa path asks it of every candidate.

import { readZip } from '../storage/zip.ts';
import { isDrawablePng } from './winimage.ts';
import { byLocal, resolveFrom, xmlPart, type Entries } from './ooxml.ts';

/** A view whose buffer is named, so a subarray of it stays a legal BlobPart. */
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * How much a package may inflate to.
 *
 * Larger than import/document.js's ceiling for documents, because an app is
 * legitimately larger than a document and the alternative is refusing every real
 * game. Still a ceiling: six of these run at once under IMPORT_WORKERS.
 */
const MAX_INFLATED = 320 * 1024 * 1024;

/** A picture under this is a spacer or a one-colour placeholder, not an icon. */
const MIN_IMAGE = 512;

/** How many candidates are ranked before the list is called hostile. */
const MAX_CANDIDATES = 4096;

/** Which family a given extension is read as. */
const FAMILY = new Map<string, string>([
  ...['apk', 'apks'].map((e): [string, string] => [e, 'android']),
  ...['xapk', 'apkm'].map((e): [string, string] => [e, 'android-bundle']),
  ['ipa', 'ios'],
  ...['appx', 'msix', 'appxbundle', 'msixbundle'].map((e): [string, string] => [e, 'windows']),
  ['epub', 'book'],
  ['cbz', 'comic'],
  ['3mf', 'print'],
]);

/** Whether this module will look inside a file with this extension. */
export const isPackage = (ext: string) => FAMILY.has(ext);

/**
 * The picture inside `file`, as `{ bytes, ext }`, or null.
 *
 * Bytes rather than a File, because the caller names every derived picture the
 * same way and re-sniffs it - see import/document.js, which owns that rule and
 * the list of image types this app will actually mount.
 */
export async function packagePicture(
  file: Blob,
  ext: string,
  lift = false,
): Promise<Bytes | null> {
  const family = FAMILY.get(ext);
  if (!family) return null;
  // Only the entries that could possibly be the answer are inflated, which for a
  // package is the whole difference between this being cheap and being reckless:
  // an .apk is a hundred megabytes of code and art wrapped around a launcher icon
  // of forty kilobytes, and six imports run at once. See `only` in storage/zip.ts.
  const entries = await open(file, WANTS[family], lift);
  return await fromEntries(entries, family, file, lift);
}

/** One archive read, admitting only the names a family could want. */
const open = (file: Blob, only: ((name: string) => boolean) | undefined, lift: boolean) =>
  readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift, only });

/**
 * What each family could possibly use, as a predicate over the entry name.
 *
 * Wider than the ranking below - the ranking decides which of several candidates
 * is best, and this only decides what is worth unpacking to look at. A name that
 * gets through here and loses there costs one inflate; a name wrongly excluded
 * here is a picture that can never be found, so each of these errs open.
 */
const WANTS: Record<string, (name: string) => boolean> = {
  android: n => /^res\/(mipmap|drawable)/i.test(n),
  // A bundle needs the inner packages themselves, which are the large entries -
  // there is no way around unpacking one, and it is one rather than all of them.
  'android-bundle': n => /^icon\.(png|jpg)$/i.test(n) || /\.apk$/i.test(n),
  ios: n => /^itunesartwork/i.test(n) || /^payload\/.*\/(appicon|icon)[^/]*$/i.test(n),
  windows: n => /^assets\//i.test(n),
  // Both readings of a book: the two parts that name the cover, and the cover
  // itself under whichever name it turns out to have.
  book: n => n === 'META-INF/container.xml' || /\.opf$/i.test(n) || /cover/i.test(n),
  comic: n => RASTER.test(n.toLowerCase()),
  print: n => /^metadata\//i.test(n),
};

/**
 * The same, once the archive is open.
 *
 * Two of these need the file again rather than only the entries they were given.
 * A bundle has to descend into the package it found, and a book has to go back
 * for a cover whose name it could not know until it had read the manifest - which
 * is the cost of not unpacking everything up front, and it is one extra read
 * rather than a hundred megabytes.
 */
async function fromEntries(
  entries: Entries,
  family: string,
  file: Blob,
  lift: boolean,
): Promise<Bytes | null> {
  switch (family) {
    case 'android': return android(entries);
    case 'android-bundle': return await bundle(entries, lift);
    case 'ios': return ios(entries);
    case 'windows': return windows(entries);
    case 'book': return await book(entries, file, lift);
    case 'comic': return comic(entries);
    case 'print': return print(entries);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Ranking helpers
// ---------------------------------------------------------------------------

/** An entry worth considering, with the number that decides between them. */
type Candidate = { name: string, bytes: Bytes, rank: number };

/**
 * The best entry matching `want`, by the rank it returns.
 *
 * `want` answers with a rank or null, which keeps the "is this a candidate" and
 * "how good is it" questions in one place per family rather than in a filter and
 * a comparator that have to agree.
 *
 * It is handed the **bytes as well as the name**, and that is not convenience:
 * whether a candidate can be drawn is sometimes a question about its content
 * rather than its path. An .ipa is the case - every icon under `Payload/` is
 * named perfectly well and most of them are Apple-optimised PNGs no browser
 * decodes - and a ranking that could only see names had no way to say so.
 *
 * Entry size is the tie-break and it is a deliberate stand-in for pixel count:
 * reading the real dimensions means decoding every candidate, and for icons from
 * one source at several densities the byte length orders them the same way.
 */
function best(
  entries: Entries,
  want: (name: string, bytes: Bytes) => number | null,
): Bytes | null {
  const found: Candidate[] = [];
  for (const [name, bytes] of entries) {
    if (found.length >= MAX_CANDIDATES) break;
    if (bytes.length < MIN_IMAGE) continue;
    const rank = want(name.toLowerCase(), bytes);
    if (rank === null) continue;
    found.push({ name, bytes, rank });
  }
  if (!found.length) return null;
  found.sort((a, b) => b.rank - a.rank || b.bytes.length - a.bytes.length);
  return found[0].bytes;
}

/**
 * Whether these bytes are something this app can actually mount.
 *
 * The extension said it was a picture; this asks the bytes. The one case that
 * matters is a CgBI PNG - see import/winimage.js - and the rule it follows is
 * the one document.js already applies to a .emf named thumbnail.png: a picture
 * nothing can draw is worse than no picture, because the card stops saying what
 * the file is and starts showing a broken image.
 */
const drawable = (b: Bytes) => b[0] === 0x89 ? isDrawablePng(b) : true;

/** A raster this app can mount, by extension. Vectors and metafiles are not. */
const RASTER = /\.(png|jpg|jpeg|webp|gif)$/;

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

/**
 * Density buckets, best first.
 *
 * `anydpi` is deliberately worth *less* than every real density rather than more,
 * despite being the one the system prefers: an anydpi drawable is almost always
 * the adaptive-icon XML, and where it is a raster it is no better than xxxhdpi.
 */
const DENSITY = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'ldpi', 'nodpi', 'anydpi'];

const densityRank = (name: string) => {
  const at = DENSITY.findIndex(d => name.includes('-' + d));
  return at < 0 ? 1 : (DENSITY.length - at) * 10;
};

/**
 * An Android launcher icon.
 *
 * Three passes, narrowest first, because a package holds hundreds of rasters and
 * the launcher icon is the one named after itself. Only when nothing is named
 * `ic_launcher` does the whole mipmap tree get ranked, and `res/drawable-` is the
 * last resort - it is where an app's *content* art lives as well as its icon.
 */
function android(entries: Entries): Bytes | null {
  const raster = (n: string, b: Bytes) => RASTER.test(n) && drawable(b);
  return best(entries, (n, b) =>
    n.startsWith('res/mipmap-') && n.includes('ic_launcher') && raster(n, b)
      ? 1000 + densityRank(n) : null)
    || best(entries, (n, b) =>
      n.startsWith('res/mipmap-') && raster(n, b) ? 500 + densityRank(n) : null)
    || best(entries, (n, b) =>
      n.startsWith('res/drawable-') && n.includes('ic_launcher') && raster(n, b)
        ? densityRank(n) : null);
}

/**
 * A bundle: a zip of APKs, usually beside an `icon.png` the store put there.
 *
 * The root icon first because it is the one the packaging tool chose to show,
 * then one level down into the base APK. One level and no more - a zip that
 * contains itself is a zip bomb, and the depth to stop at is the depth the format
 * actually uses.
 */
async function bundle(entries: Entries, lift: boolean): Promise<Bytes | null> {
  const direct = best(entries, (n, b) =>
    (n === 'icon.png' || n === 'icon.jpg') && drawable(b) ? 1 : null);
  if (direct) return direct;

  const inner = [...entries.entries()]
    .filter(([n]) => n.toLowerCase().endsWith('.apk'))
    // `base.apk` where there is one; otherwise the largest, which is the one
    // carrying the resources rather than a per-architecture split.
    .sort((a, b) => Number(b[0].endsWith('base.apk')) - Number(a[0].endsWith('base.apk'))
      || b[1].length - a[1].length)[0];
  if (!inner) return null;
  try {
    return android(await readZip(inner[1], { entry: MAX_INFLATED, total: MAX_INFLATED, lift }));
  } catch {
    // A bundle whose inner package will not open is still a bundle; the outer
    // archive read fine, so this is one missing picture rather than a bad file.
    return null;
  }
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

/**
 * An iOS app icon.
 *
 * `iTunesArtwork` first and it is not just a preference: that file is the one
 * picture in an .ipa that was *not* run through Xcode's PNG optimiser, so it is
 * the only one guaranteed to decode outside Apple's software. Everything under
 * `Payload/` is checked for the CgBI marking and dropped if it carries it, which
 * on a store-built package is most of them.
 */
function ios(entries: Entries): Bytes | null {
  const artwork = best(entries, (n, b) =>
    (n === 'itunesartwork' || n === 'itunesartwork@2x') && drawable(b) ? 1 : null);
  if (artwork) return artwork;

  return best(entries, (n, b) => {
    if (!n.startsWith('payload/') || !RASTER.test(n) || !drawable(b)) return null;
    const file = n.slice(n.lastIndexOf('/') + 1);
    if (!file.startsWith('appicon') && !file.startsWith('icon')) return null;
    return file.startsWith('appicon') ? 2 : 1;
  });
}

// ---------------------------------------------------------------------------
// Windows app packages
// ---------------------------------------------------------------------------

/**
 * An MSIX or APPX logo.
 *
 * The manifest names these, but every one of the names it can give lives under
 * `Assets/` and is a plain PNG, so the glob answers without reading it. Store and
 * Square logos outrank the wide one, which is a banner rather than an icon and
 * looks wrong on a square card.
 */
function windows(entries: Entries): Bytes | null {
  return best(entries, (n, b) => {
    if (!n.startsWith('assets/') || !RASTER.test(n) || !drawable(b)) return null;
    if (n.includes('wide') || n.includes('splash') || n.includes('badge')) return 1;
    if (n.includes('storelogo')) return 4;
    if (n.includes('square') || n.includes('logo')) return 3;
    return null;
  });
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

/**
 * A book's cover.
 *
 * Properly, and the properly is worth it here because unlike the packages above
 * an EPUB genuinely states where its cover is - twice, in two vocabularies from
 * two versions of the specification, both of which are still in the wild:
 *
 *   EPUB 3   a manifest item carrying `properties="cover-image"`.
 *   EPUB 2   a `<meta name="cover" content="ID">` naming a manifest item's id.
 *
 * Both need the OPF, and the OPF is wherever `META-INF/container.xml` says - it
 * is not at a fixed path and assuming one is the usual way this is got wrong.
 * Every href is then resolved against the OPF's own directory and *looked up* in
 * the archive rather than opened as a path, which is the rule import/ooxml.js
 * exists to keep.
 */
async function book(entries: Entries, file: Blob, lift: boolean): Promise<Bytes | null> {
  const wanted = coverPath(entries);
  if (wanted) {
    // Named at last, so go back for it. The first read could not have known this
    // path - it is whatever the manifest says - so this is the one place a second
    // pass is unavoidable, and it inflates exactly one entry.
    const found = (await open(file, n => n === wanted, lift)).get(wanted);
    if (found && found.length >= MIN_IMAGE && drawable(found)) return found;
  }
  // No manifest, one that names a cover the archive does not hold, or no DOM to
  // read it with. A file called cover is the convention every tool follows anyway.
  return best(entries, (n, b) =>
    RASTER.test(n) && n.includes('cover') && drawable(b) ? 1 : null);
}

/**
 * Where the manifest says the cover is, as an archive key.
 *
 * Two vocabularies, both still in the wild and both checked: EPUB 3 marks the
 * manifest item itself with `properties="cover-image"`, EPUB 2 names the item's
 * id from a `<meta name="cover">`. The href is relative to the OPF's own
 * directory, and the OPF is wherever `META-INF/container.xml` says rather than at
 * any fixed path - assuming `OEBPS/content.opf` is the usual way this is got
 * wrong.
 */
function coverPath(entries: Entries): string | null {
  const container = xmlPart(entries, 'META-INF/container.xml');
  const opfPath = container && byLocal(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath ? xmlPart(entries, opfPath) : null;
  if (!opf || !opfPath) return null;

  const base = opfPath.slice(0, opfPath.lastIndexOf('/') + 1);
  const items = byLocal(opf, 'item');
  const declared = items.find(i => (i.getAttribute('properties') || '').includes('cover-image'));
  const namedId = byLocal(opf, 'meta')
    .find(m => (m.getAttribute('name') || '').toLowerCase() === 'cover')
    ?.getAttribute('content');
  const byId = namedId ? items.find(i => i.getAttribute('id') === namedId) : undefined;

  for (const item of [declared, byId]) {
    const href = item?.getAttribute('href');
    // Decoded because a manifest states a URI and an archive holds a name: a
    // cover called `cover art.png` is written `cover%20art.png` in the OPF.
    if (href) return resolveFrom(base, decodeURIComponent(href));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comics and prints
// ---------------------------------------------------------------------------

/**
 * Page one of a comic.
 *
 * Sorted the way a reader would: the numbers inside the names compared as
 * numbers, so `page2` precedes `page10`. A plain sort puts chapter 10 first,
 * which is the wrong cover.
 *
 * `.cbr` and `.cb7` are RAR and 7z rather than zips. storage/zip.js reads
 * neither, and they are declined by not being in FAMILY at all rather than by
 * being opened and failing.
 */
function comic(entries: Entries): Bytes | null {
  // A linear scan for the first page, not a full sort to take [0]: on a 300-page
  // .cbz that was thousands of comparisons and the comparator re-tokenised both
  // names on each. Each name is tokenised once here, and the running best keeps
  // its tokens rather than being re-split against every candidate.
  let best: { bytes: Bytes, toks: string[] } | null = null;
  for (const [n, b] of entries.entries()) {
    if (!RASTER.test(n.toLowerCase()) || b.length < MIN_IMAGE) continue;
    const toks = tokenise(n);
    if (!best || naturalToks(toks, best.toks) < 0) best = { bytes: b, toks };
  }
  return best ? best.bytes : null;
}

/** A name split into its digit and non-digit runs, lower-cased, for natural sort. */
function tokenise(name: string): string[] {
  return name.toLowerCase().match(/\d+|\D+/g) || [];
}

/** Compare two already-tokenised names with their digit runs read as numbers. */
function naturalToks(ax: string[], bx: string[]): number {
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d/.test(ax[i]);
    const bn = /^\d/.test(bx[i]);
    if (an && bn) {
      const d = Number(ax[i]) - Number(bx[i]);
      if (d) return d;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * A 3MF print's thumbnail.
 *
 * An Open Packaging Convention container, so `Metadata/thumbnail.png` is where
 * the specification puts it - but slicers vary and the ranked fallback costs a
 * line, so a writer that put it elsewhere under Metadata still answers.
 */
function print(entries: Entries): Bytes | null {
  return entries.get('Metadata/thumbnail.png')
    || best(entries, (n, b) =>
      n.startsWith('metadata/') && RASTER.test(n) && drawable(b) ? 1 : null);
}
