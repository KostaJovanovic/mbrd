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
//   PDN             Not a zip either. Paint.NET opens with a header naming the
//                   length of an XML block, and the flattened preview is a PNG
//                   sitting inside that XML as base64 - which makes it the one
//                   picture here that is read out of text.
//
// The original file is untouched and still the one embedded in the .mbrd, so the
// day any of these gets a real renderer the card upgrades itself; until then it
// shows the picture the authoring application already made rather than a hole.
// Same bargain import/pdf.js strikes for a PDF, without the dependency.

import { readZip } from '../storage/zip.ts';
import { extOf } from '../util.ts';
import { oversize, isOversize, mb } from '../consent.ts';
// The two families whose picture is not at a path a specification names. A
// program keeps its icon in a resource tree (import/pe.js) and an app package or
// a book keeps its in one of several places that have to be ranked
// (import/packages.js). Both answer the same question this module asks and both
// are dispatched from bakedPreview() below, so there is one door for "does this
// file carry a picture of itself" rather than three.
import { exeIcon, isExecutable } from './pe.ts';
import { packagePicture, isPackage } from './packages.ts';
import { isDrawablePng } from './winimage.ts';
import { openCompound, compoundPicture, isCompoundExt } from './cfbf.ts';
import { carvedPicture, isCarved } from './carved.ts';

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
// Exported for import/slide.ts, which reads the same containers for the same
// caller and has no business holding a second opinion about how big a document
// is allowed to be.
export const MAX_CONTAINER = 96 * 1024 * 1024;

/**
 * How much a document may inflate to, whatever it compressed down from.
 *
 * MAX_CONTAINER is a cap on the bytes that arrive; this is the cap on the bytes
 * that come out, which is the number that actually has to fit in memory - and
 * six of these run at once under IMPORT_WORKERS. A document that expands past
 * this is probably not a document - but "probably" is the whole reason this is a
 * question now rather than a refusal, and the caller asks it. Declined, it turns
 * into a named card exactly as every other miss here does, which is why this is
 * the cheapest of all these ceilings to say no to: nothing is lost but a
 * thumbnail somebody else's exporter may not even have written.
 */
export const MAX_INFLATED = 192 * 1024 * 1024;

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
  return FAMILY.has(ext) || ext === 'psd' || ext === 'psb' || ext === 'pdn'
    || isExecutable(ext) || isPackage(ext) || isCompoundExt(ext, file.name) || isCarved(ext);
}

/**
 * A viewable picture out of a document, or null.
 *
 * Returned as a File so the caller can hand it straight to addFile() and to
 * measureSize(), which is what import/preview.js returns too - the two are used
 * interchangeably by prepareFile().
 */
export async function bakedPreview(file: File, lift = false): Promise<File | null> {
  try {
    const ext = extOf(file.name);
    if (ext === 'psd' || ext === 'psb') return await fromPsd(file);
    if (ext === 'pdn') return await fromPdn(file);
    // A program's icon. No container ceiling of its own here: pe.js reads only
    // the section it needs, out of a Blob, and carries its own ceiling on that -
    // so a 400 MB installer costs a few slices rather than 400 MB.
    if (isExecutable(ext)) {
      const icon = await exeIcon(file, lift);
      return icon ? named(new Uint8Array(await icon.blob.arrayBuffer())) : null;
    }
    // An app package or a book. The ceiling that matters for these is the
    // archive's, which readZip owns and asks about itself.
    if (isPackage(ext)) {
      const bytes = await packagePicture(file, ext, lift);
      return bytes ? named(bytes) : null;
    }
    // A compound file: SolidWorks, Office before OOXML, 3ds Max, Thumbs.db.
    // Matched on the whole name as well as the extension, because the one this
    // family is named after has no extension worth the word - `Thumbs.db` is a
    // .db only by accident.
    if (isCompoundExt(ext, file.name)) {
      const doc = await openCompound(file, lift);
      const bytes = doc && compoundPicture(doc);
      return bytes ? named(bytes) : null;
    }
    // The four that keep a picture behind a header of their own - an Apple icon,
    // an AutoCAD drawing, a binary EPS, a Blender scene - and a contact card.
    if (isCarved(ext)) {
      const bytes = await carvedPicture(file, ext);
      return bytes ? named(bytes) : null;
    }
    const family = FAMILY.get(ext);
    if (!family) return null;
    // Thrown rather than returned, which is the difference between this ceiling
    // and the misses around it. Every other null out of this function means "no
    // picture in there" and the card is a named card, correctly and finally. This
    // one means "there may well be a picture in there and looking would cost 96 MB
    // of somebody's memory" - a question, and one this module cannot ask from
    // inside an import pool. The caller asks it. See consent.ts.
    if (!lift && file.size > MAX_CONTAINER) {
      throw oversize(
        'container-bytes',
        `This document is ${mb(file.size)}, past the ${mb(MAX_CONTAINER)} one is opened at to look for `
        + 'the preview picture inside it.',
      );
    }
    return await fromZip(file, WELLS[family], lift);
  } catch (err) {
    // Past the caller, untouched. A ceiling is not a failure to find a preview,
    // it is a question nobody has answered yet, and swallowing it here would be
    // this module deciding after all - by doing quietly what it used to do
    // loudly.
    if (isOversize(err)) throw err;
    // A preview that throws is still a preview we did not find, and the card is
    // unchanged either way - but the two reasons to end up here are not the same
    // thing and only one of them is ordinary. A container with no thumbnail entry
    // returns null quietly from fromZip() and never reaches this line; a throw
    // means readZip refused the archive itself - a bad central directory, a
    // checksum that does not match, a compression method it does not speak, ZIP64
    // - and that is a file this app could not open at all rather than a document
    // that simply carries no picture of itself.
    console.warn('[mbrd] document: the container would not read', file.name, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZIP containers
// ---------------------------------------------------------------------------

async function fromZip(file: Blob, paths: string[], lift = false): Promise<File | null> {
  // readZip throws on anything that is not a well-formed archive, on an entry
  // whose checksum does not match, and on the expansion ratios a zip bomb needs.
  // All of that is caught by the caller and comes back as null.
  // Its own inflate ceiling, not the board archive's. MAX_CONTAINER above caps
  // what arrives *compressed*, and until this argument existed nothing capped
  // what came out: readZip's own ceiling is LIMITS.total = 768 MB at a 200:1
  // ratio, so six 96 MB files of compressible padding - IMPORT_WORKERS is 6 -
  // could each hold 768 MB of inflated entries at once. That is ~4.6 GB, which
  // is precisely the tab that stops responding MAX_CONTAINER's comment says it
  // exists to prevent.
  const entries = await readZip(file, { entry: MAX_INFLATED, total: MAX_INFLATED, lift });
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
    // A CgBI PNG passes every one of those bytes and decodes in nothing outside
    // Apple's software - see import/winimage.js. It is the .emf case wearing a
    // signature this function already trusted, which is why the check is here
    // rather than at the one call site that meets one.
    return isDrawablePng(b) ? { ext: 'png', mime: 'image/png' } : null;
  }
  // The three below arrive with the executables and the app packages and not from
  // any document: an icon resource wrapped as an .ico, a clipboard bitmap given
  // its file header back, and the WebP that Android build tools now write for
  // launcher icons. A browser draws all three, which is the whole of the bar this
  // function is applying - GIF is here for the same reason and costs one line.
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    return { ext: 'ico', mime: 'image/x-icon' };
  }
  if (b.length >= 14 && b[0] === 0x42 && b[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp' };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

/**
 * A picture as the File every caller of this module expects back.
 *
 * The name and the type come from the bytes rather than from whatever the reader
 * believed it built. That is the same rule fromZip() applies to a path a
 * container supplied, applied one layer further in, and it is what keeps
 * imageType() the single place that decides what this app will mount.
 */
function named(bytes: Uint8Array<ArrayBuffer>): File | null {
  const type = imageType(bytes);
  return type ? new File([bytes], `preview.${type.ext}`, { type: type.mime }) : null;
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
    // `size` is a getUint32, so it is never negative and the first half of this
    // was dead. Kept as the bound that matters, said once.
    if (q + size > end) break;

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

// ---------------------------------------------------------------------------
// PDN  -  Paint.NET
// ---------------------------------------------------------------------------
//
// Four bytes of magic, a 24-bit little-endian length, and then that many bytes
// of UTF-8 XML describing the document. The layers behind it are a serialised
// .NET object graph and are not readable without the application - but the XML
// carries a `<thumb png="...">` attribute holding a base64 PNG of the flattened
// image, which is a picture of the document and is all this needs.
//
// The only preview in this module that arrives as text, so it is the only one
// that is decoded rather than sliced. The length is capped before the read for
// the usual reason: it is a number a stranger wrote, and a claim of sixteen
// megabytes of header is not one to allocate against.

/** How much of a .pdn's XML header is worth reading. A thumbnail is tens of
 *  kilobytes of base64; the rest is a few hundred bytes of attributes. */
const PDN_MAX_XML = 4 * 1024 * 1024;

async function fromPdn(file: Blob): Promise<File | null> {
  const head = new Uint8Array(await file.slice(0, 7).arrayBuffer());
  // 'PDN3'
  if (head.length < 7 || head[0] !== 0x50 || head[1] !== 0x44 || head[2] !== 0x4e || head[3] !== 0x33) {
    return null;
  }
  const len = Math.min(head[4] | (head[5] << 8) | (head[6] << 16), PDN_MAX_XML);
  if (len < 32) return null;
  const xml = new TextDecoder().decode(await file.slice(7, 7 + len).arrayBuffer());
  const b64 = xml.match(/<thumb\s+png="([A-Za-z0-9+/=\s]*)"/i)?.[1];
  if (!b64) return null;
  const png = fromBase64(b64);
  // By its own first bytes, like every other picture that leaves this module.
  if (!png || png.length < MIN_IMAGE || imageType(png)?.ext !== 'png') return null;
  return new File([png], 'preview.png', { type: 'image/png' });
}

/**
 * Base64 to bytes, through atob.
 *
 * The attribute is written by Paint.NET and read here, so it is well-formed in
 * practice - but it arrived in a file, which makes it a string to be refused
 * rather than trusted, and atob throws on anything that is not base64. The
 * whitespace strip is because XML attributes may be wrapped across lines.
 */
function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
