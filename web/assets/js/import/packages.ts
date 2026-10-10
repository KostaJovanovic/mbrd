// Extract a cover/icon from app packages (APK, IPA, APPX) and books (EPUB, CBZ,
// 3MF). Unlike import/document.ts (thumbnail at a known path), these containers
// require ranking candidates by name/density/size. Android icons are found by
// convention (res/mipmap-*) rather than parsing resources.arsc. iOS PNGs with
// CgBI optimisation are rejected — browsers cannot decode them.

import { readZip } from '../storage/zip.ts';
import { isDrawablePng } from './winimage.ts';
import { byLocal, resolveFrom, xmlPart, type Entries } from './ooxml.ts';
import type { Bytes } from '../bytes.ts';

/** Max inflated size. Higher than documents — apps are legitimately larger. */
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

/** Extract the icon/cover from `file`, or null. Returns raw bytes — the
 * caller (import/document.ts) handles naming and type-sniffing. */
export async function packagePicture(
  file: Blob,
  ext: string,
  lift = false,
): Promise<Bytes | null> {
  const family = FAMILY.get(ext);
  if (!family) return null;
  // Only inflate candidate entries — an APK is hundreds of MB wrapping a 40 KB icon.
  const entries = await open(file, WANTS[family], lift);
  return await fromEntries(entries, family, file, lift);
}

/** One archive read, admitting only the names a family could want. */
const open = (file: Blob, only: ((name: string) => boolean) | undefined, lift: boolean) =>
  readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift, only });

/** Entry filter per family — errs wide, since a miss here means a picture can
 * never be found. The ranking below picks the best among those admitted. */
const WANTS: Record<string, (name: string) => boolean> = {
  android: n => /^res\/(mipmap|drawable)/i.test(n),
  // Bundles need inner APKs — must unpack at least one.
  'android-bundle': n => /^icon\.(png|jpg)$/i.test(n) || /\.apk$/i.test(n),
  ios: n => /^itunesartwork/i.test(n) || /^payload\/.*\/(appicon|icon)[^/]*$/i.test(n),
  windows: n => /^assets\//i.test(n),
  // Manifest parts + anything named "cover" (name unknown until manifest is read).
  book: n => n === 'META-INF/container.xml' || /\.opf$/i.test(n) || /cover/i.test(n),
  comic: n => RASTER.test(n.toLowerCase()),
  print: n => /^metadata\//i.test(n),
};

/** Dispatch to the right family extractor. Bundles and books may re-read the
 * file for entries whose names were not known until the manifest was parsed. */
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

/** Best entry by `want(name, bytes) → rank | null`. Receives bytes too — iOS
 * candidates must be checked for CgBI. Byte length is the tie-break (proxy
 * for pixel count without decoding every candidate). */
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

/** Whether the bytes decode in a browser. Rejects CgBI PNGs (Apple-optimised). */
const drawable = (b: Bytes) => b[0] === 0x89 ? isDrawablePng(b) : true;

/** A raster this app can mount, by extension. Vectors and metafiles are not. */
const RASTER = /\.(png|jpg|jpeg|webp|gif)$/;

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

/** Density buckets, best first. `anydpi` ranks lowest — it is almost always
 * the adaptive-icon XML, not a raster. */
const DENSITY = ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi', 'ldpi', 'nodpi', 'anydpi'];

const densityRank = (name: string) => {
  const at = DENSITY.findIndex(d => name.includes('-' + d));
  return at < 0 ? 1 : (DENSITY.length - at) * 10;
};

/** Android launcher icon. Three passes, narrowest first: ic_launcher in mipmap,
 * then any mipmap raster, then ic_launcher in drawable (last resort). */
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

/** Bundle (zip of APKs). Root icon.png first, then descend into base.apk.
 * One level only — deeper nesting is a zip bomb. */
async function bundle(entries: Entries, lift: boolean): Promise<Bytes | null> {
  const direct = best(entries, (n, b) =>
    (n === 'icon.png' || n === 'icon.jpg') && drawable(b) ? 1 : null);
  if (direct) return direct;

  const inner = [...entries.entries()]
    .filter(([n]) => n.toLowerCase().endsWith('.apk'))
    // Prefer base.apk; else largest (has resources, not an arch split).
    .sort((a, b) => Number(b[0].endsWith('base.apk')) - Number(a[0].endsWith('base.apk'))
      || b[1].length - a[1].length)[0];
  if (!inner) return null;
  try {
    return android(await readZip(inner[1], { entry: MAX_INFLATED, total: MAX_INFLATED, lift }));
  } catch {
    // Inner APK failed — one missing picture, not a bad file.
    return null;
  }
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

/** iOS app icon. iTunesArtwork first — it is the only file not CgBI-optimised.
 * Payload/ candidates are checked and rejected if they carry the CgBI marker. */
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

/** MSIX/APPX logo. Everything is under Assets/ as plain PNGs, so no manifest
 * parsing needed. Wide logos rank lowest — banners look wrong on a square card. */
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

/** EPUB cover. Reads the OPF (located via META-INF/container.xml, not a fixed
 * path) for both EPUB 3 (`properties="cover-image"`) and EPUB 2 (`<meta
 * name="cover">`). Falls back to a file named "cover" if the manifest fails. */
async function book(entries: Entries, file: Blob, lift: boolean): Promise<Bytes | null> {
  const wanted = coverPath(entries);
  if (wanted) {
    // Second pass for the named cover — its path was unknown until the OPF was read.
    const found = (await open(file, n => n === wanted, lift)).get(wanted);
    if (found && found.length >= MIN_IMAGE && drawable(found)) return found;
  }
  // Fallback: any raster named "cover".
  return best(entries, (n, b) =>
    RASTER.test(n) && n.includes('cover') && drawable(b) ? 1 : null);
}

/** Resolve the cover path from the OPF. Checks both EPUB 3 (cover-image
 * property) and EPUB 2 (meta name="cover"). Hrefs are resolved against the
 * OPF's own directory. */
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
    // Decoded: manifest has URI-encoded name, archive has the plain name.
    if (href) return resolveFrom(base, decodeURIComponent(href));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comics and prints
// ---------------------------------------------------------------------------

/** Page one of a comic. Natural sort so page2 < page10. Only .cbz (zip) —
 * .cbr (RAR) and .cb7 (7z) are not in FAMILY. */
function comic(entries: Entries): Bytes | null {
  // Linear scan with cached tokens — full sort was O(n log n) re-tokenisations.
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

/** 3MF thumbnail. Spec says Metadata/thumbnail.png, but slicers vary —
 * falls back to any raster under Metadata/. */
function print(entries: Entries): Bytes | null {
  return entries.get('Metadata/thumbnail.png')
    || best(entries, (n, b) =>
      n.startsWith('metadata/') && RASTER.test(n) && drawable(b) ? 1 : null);
}
