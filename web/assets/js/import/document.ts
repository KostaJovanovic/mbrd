// The picture a document already has of itself.
//
// A Word file, a spreadsheet, a Krita painting, a Procreate canvas, a Keynote
// deck: none of them is something a browser draws, and all of them land on a
// board as a grey named card. But most of them are carrying a rendered picture
// of their own first page, put there by the application that wrote them so that
// a file browser could show a thumbnail - and going and getting that is a zip
// read and a bounded byte walk, not a document renderer.
//
// So this is the third module in the shape import/preview.js established, and it
// is deliberately the same shape: walk a container written by something that is
// not this app, find one blob inside it, trust none of the numbers on the way,
// and identify what comes out by its own first bytes rather than by anything the
// container claimed. Every path returns null on anything unexpected - a preview
// that cannot be found is a named card, which is exactly where the caller was
// headed anyway.
//
// Two families, two techniques:
//
//   ZIP containers  OOXML (.docx/.xlsx/.pptx), OpenDocument, Krita, Procreate,
//                   iWork, Sketch. All of them are zip files with a picture at a
//                   known path, so all of them are one table (WELLS) and one
//                   read through storage/zip.js - the same hand-rolled reader
//                   the .mbrd format itself is built on.
//
//   PSD             Not a zip. Photoshop keeps a JPEG of the composite in its
//                   Image Resources block, which is a chain of length-prefixed
//                   records near the front of the file. That one is a byte walk.
//
// The original file is untouched and still the one embedded in the .mbrd, so the
// day any of these gets a real renderer the card upgrades itself; until then it
// shows the picture the authoring application already made rather than a hole.
// Same bargain import/pdf.js strikes for a PDF, without the dependency.

import { readZip } from '../storage/zip.ts';
import { extOf } from '../util.ts';

/**
 * How big a container this will open at all.
 *
 * readZip() inflates every entry to find one of them, which is the cost of using
 * the reader the rest of the app uses rather than writing a second, ranged one.
 * For a document that is nothing - a .docx is measured in megabytes - and for
 * the fifty-megabyte Procreate file somebody dropped by accident it is a tab
 * that stops responding. Its own ceiling rather than leaning on zip.js's, which
 * is set for a whole board archive and is three orders of magnitude too generous
 * for one document.
 */
const MAX_CONTAINER = 96 * 1024 * 1024;

/** A preview under a kilobyte is not one. Same floor import/preview.js uses. */
const MIN_IMAGE = 512;

/**
 * Where each family keeps its picture, in the order worth trying.
 *
 * Paths are exact and case-sensitive, because that is what the specifications
 * say and what every writer actually emits. The lists are ordered best-first:
 * a full-size composite before a thumbnail, since the card is drawn far larger
 * than a file browser's icon.
 */
const WELLS: Record<string, string[]> = {
  // OpenDocument. The specification *requires* Thumbnails/thumbnail.png in a
  // package, so this is the one family where a hit is close to guaranteed.
  odf: [
    'Thumbnails/thumbnail.png',
  ],
  // Office Open XML. docProps/thumbnail is optional - Word writes it when the
  // document was saved with "save thumbnail" on, which is the default for
  // documents created from a template and not for every file - so this family
  // misses often, and missing is a named card exactly as before.
  //
  // The .emf and .wmf spellings the specification also allows are deliberately
  // absent: no browser draws either, so finding one would mean replacing a grey
  // card with a broken image.
  ooxml: [
    'docProps/thumbnail.jpeg',
    'docProps/thumbnail.jpg',
    'docProps/thumbnail.png',
  ],
  // Krita. mergedimage.png is the flattened composite at full size and is what
  // the application itself shows; preview.png is a small one, kept as a fallback
  // for files written by older versions.
  krita: [
    'mergedimage.png',
    'preview.png',
  ],
  // Procreate, which is a zip with a QuickLook thumbnail and nothing else a
  // browser could use - the layers are in a proprietary blob.
  procreate: [
    'QuickLook/Thumbnail.png',
    'QuickLook/Thumbnail.jpg',
  ],
  // Apple iWork. The real content is Snappy-compressed protobuf and is not
  // reconstructable, so the QuickLook preview is the whole of what can be shown.
  // The full-size preview.jpg first, then the thumbnail; Preview.pdf, which
  // newer versions also write, would need pdf.js and is left to the PDF path.
  iwork: [
    'preview.jpg',
    'QuickLook/Thumbnail.jpg',
    'preview-web.jpg',
    'preview-micro.jpg',
  ],
  // Sketch, same idea.
  sketch: [
    'previews/preview.png',
  ],
  // Autodesk Fusion. Listed for completeness and expected to miss: an .f3d is a
  // zip whose entries are Zstandard-compressed, and storage/zip.js reads STORE
  // and DEFLATE only. It fails cleanly, which is the whole contract here.
  fusion: [
    'thumbnail.png',
  ],
};

/** Extension -> which family's paths to look down. */
const FAMILY = new Map<string, string>([
  ...['odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg', 'odf', 'odc', 'odb']
    .map((e): [string, string] => [e, 'odf']),
  ...['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm',
      'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'vsdx']
    .map((e): [string, string] => [e, 'ooxml']),
  ['kra', 'krita'],
  ['krz', 'krita'],
  ['procreate', 'procreate'],
  ...['pages', 'numbers', 'key', 'keynote'].map((e): [string, string] => [e, 'iwork']),
  ['sketch', 'sketch'],
  ['f3d', 'fusion'],
  ['f3z', 'fusion'],
]);

/** Whether this file is one this module knows how to look inside. */
export function hasBakedPreview(file: File) {
  const ext = extOf(file.name);
  return FAMILY.has(ext) || ext === 'psd' || ext === 'psb';
}

/**
 * A viewable picture out of a document, or null.
 *
 * Returned as a File so the caller can hand it straight to addFile() and to
 * measureSize(), which is what import/preview.js returns too - the two are used
 * interchangeably by prepareFile().
 */
export async function bakedPreview(file: File): Promise<File | null> {
  try {
    const ext = extOf(file.name);
    if (ext === 'psd' || ext === 'psb') return await fromPsd(file);
    const family = FAMILY.get(ext);
    if (!family) return null;
    if (file.size > MAX_CONTAINER) return null;
    return await fromZip(file, WELLS[family]);
  } catch {
    return null;   // a preview that throws is a preview we did not find
  }
}

// ---------------------------------------------------------------------------
// ZIP containers
// ---------------------------------------------------------------------------

async function fromZip(file: Blob, paths: string[]): Promise<File | null> {
  // readZip throws on anything that is not a well-formed archive, on an entry
  // whose checksum does not match, and on the expansion ratios a zip bomb needs.
  // All of that is caught by the caller and comes back as null.
  const entries = await readZip(file);
  for (const path of paths) {
    const bytes = entries.get(path);
    if (!bytes || bytes.length < MIN_IMAGE) continue;
    const type = imageType(bytes);
    // By its own first bytes and not by the extension in the path: a container
    // that says thumbnail.png and holds an EMF is a container this app should
    // decline rather than hand to an <img>.
    if (!type) continue;
    return new File([bytes], 'preview.' + type.ext, { type: type.mime });
  }
  return null;
}

/** JPEG or PNG, by signature. The only two anything here is allowed to return. */
function imageType(b: Uint8Array): { ext: string, mime: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ext: 'png', mime: 'image/png' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PSD
// ---------------------------------------------------------------------------
//
// A Photoshop file opens with a fixed 26-byte header, then two length-prefixed
// sections. The second of those - Image Resources - is a chain of records, and
// two of them are a JPEG of the flattened composite: resource 1036, written
// since Photoshop 5, and resource 1033, its older BGR-ordered twin. Either is a
// real picture of the document, which is more than the layer data can give
// without a decoder.
//
// Only the front of the file is read. The resources sit before the layer data
// and before the image data, so a 2 GB PSB gives up its thumbnail from the first
// few hundred kilobytes - which is the whole reason this is worth doing at all.

/** How far into a PSD the resource chain is allowed to be looked for. */
const PSD_SCAN = 8 * 1024 * 1024;
/** Records walked before giving up. A real file has a few dozen. */
const PSD_MAX_RECORDS = 4096;

const RES_THUMBNAIL = 1036;      // kJpegRGB, Photoshop 5 and later
const RES_THUMBNAIL_OLD = 1033;  // the same picture, BGR order

async function fromPsd(file: Blob): Promise<File | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(PSD_SCAN, file.size)).arrayBuffer());
  if (head.length < 34) return null;
  // '8BPS'
  if (head[0] !== 0x38 || head[1] !== 0x42 || head[2] !== 0x50 || head[3] !== 0x53) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  // 26-byte header, then the Colour Mode Data section, then Image Resources.
  let p = 26;
  const modeLen = view.getUint32(p, false);
  p += 4 + modeLen;
  if (p + 4 > head.length) return null;

  const resLen = view.getUint32(p, false);
  p += 4;
  // Bounded against what was actually read, not against what the file claims -
  // the section can legitimately run past PSD_SCAN on a huge document, and the
  // walk below simply stops where the buffer does.
  const end = Math.min(head.length, p + resLen);

  let best: Uint8Array<ArrayBuffer> | null = null;
  for (let n = 0; n < PSD_MAX_RECORDS && p + 12 <= end; n++) {
    // '8BIM'
    if (view.getUint32(p, false) !== 0x3842494d) break;
    const id = view.getUint16(p + 4, false);
    // A Pascal string name, padded to an even length. Almost always empty, which
    // is two bytes: one length byte of zero and one pad.
    const nameLen = head[p + 6];
    let q = p + 6 + 1 + nameLen;
    if (q % 2) q++;
    if (q + 4 > end) break;
    const size = view.getUint32(q, false);
    q += 4;
    if (size < 0 || q + size > end) break;

    if ((id === RES_THUMBNAIL || id === RES_THUMBNAIL_OLD) && size > 28) {
      // The record's own 28-byte header - format, dimensions, row bytes, sizes,
      // bit depth, planes - then the JPEG. Format 1 is JPEG; format 0 is raw
      // RGB, which nothing here can draw and which no writer emits.
      const format = view.getUint32(q, false);
      if (format === 1) {
        const jpeg = head.subarray(q + 28, q + size);
        // By its own first bytes, like everything else in this file.
        if (jpeg.length >= MIN_IMAGE && imageType(jpeg)?.ext === 'jpg') {
          // 1036 wins if both are present - it is the RGB one, and 1033's BGR
          // ordering shows as a blue-for-red picture in some writers.
          if (id === RES_THUMBNAIL) return file1(jpeg);
          best = best || jpeg;
        }
      }
    }

    // Records are padded to an even length.
    p = q + size + (size % 2);
  }
  return best ? file1(best) : null;
}

// The bytes are a view onto a buffer this module read itself, which is what the
// File constructor needs to be told - a view onto a shared one is not a BlobPart.
const file1 = (bytes: Uint8Array<ArrayBuffer>) =>
  new File([bytes], 'preview.jpg', { type: 'image/jpeg' });
