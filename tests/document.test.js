// The picture a document already has of itself (import/document.js).
//
// One of the hand-written binary readers, so it is tested the way the others
// are: mostly on input that is wrong. A .docx off somebody's disk is a file this
// app did not write, and the whole contract of the module is that anything it
// does not understand comes back null rather than throwing into the import.
//
// The zips are built with the app's own writeZip(), so the fixtures are real
// archives rather than hand-assembled bytes - which also means these tests would
// notice if the reader and the writer ever stopped agreeing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeZip } from '../web/assets/js/storage/zip.js';
import { hasBakedPreview, bakedPreview } from '../web/assets/js/import/document.js';

// The two signatures the module will accept, padded past its 512-byte floor so
// a real preview is not rejected for being small. Neither has to decode - the
// module identifies by signature and hands the bytes on; deciding whether they
// draw is measureSize()'s job, one layer up.
const png = (extra = 1024) => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(extra).fill(0x42),
]);
const jpeg = (extra = 1024) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, ...new Array(extra).fill(0x42),
]);
/** An Enhanced Metafile, which is a picture no browser draws. */
const emf = (extra = 1024) => new Uint8Array([
  0x01, 0x00, 0x00, 0x00, ...new Array(extra).fill(0x42),
]);

/** A File named `name`, holding a zip of `entries`. */
async function zipFile(name, entries) {
  const blob = await writeZip(entries.map(([path, data]) => ({ name: path, data })));
  return new File([blob], name);
}

// ---------------------------------------------------------------------------
// Which files it will even look inside
// ---------------------------------------------------------------------------

test('it claims the families it can read and nothing else', () => {
  for (const name of ['a.odt', 'a.ods', 'a.odp', 'a.docx', 'a.xlsx', 'a.pptx',
                      'a.kra', 'a.procreate', 'a.pages', 'a.key', 'a.numbers',
                      'a.sketch', 'a.f3d', 'a.psd', 'a.psb']) {
    assert.equal(hasBakedPreview({ name }), true, name);
  }
  // Not a photograph, not a video, and emphatically not a PDF - that one has a
  // renderer of its own (import/pdf.js) and would otherwise be opened twice.
  for (const name of ['a.jpg', 'a.mp4', 'a.pdf', 'a.txt', 'a.zip', 'a']) {
    assert.equal(hasBakedPreview({ name }), false, name);
  }
});

// ---------------------------------------------------------------------------
// ZIP containers
// ---------------------------------------------------------------------------

test('an OpenDocument gives up its required thumbnail', async () => {
  const file = await zipFile('sheet.odt', [
    ['mimetype', new TextEncoder().encode('application/vnd.oasis.opendocument.text')],
    ['Thumbnails/thumbnail.png', png()],
    ['content.xml', new TextEncoder().encode('<office/>')],
  ]);
  const out = await bakedPreview(file);
  assert.ok(out, 'no preview found');
  assert.equal(out.type, 'image/png');
});

test('an OOXML document gives up docProps/thumbnail when it has one', async () => {
  const file = await zipFile('report.docx', [
    ['docProps/thumbnail.jpeg', jpeg()],
    ['word/document.xml', new TextEncoder().encode('<w/>')],
  ]);
  const out = await bakedPreview(file);
  assert.ok(out);
  assert.equal(out.type, 'image/jpeg');
});

test('an OOXML document without one is not an error', async () => {
  // The common case for a .docx that was not saved from a template: the option
  // is off, there is no thumbnail, and the card stays a named card.
  const file = await zipFile('plain.docx', [
    ['word/document.xml', new TextEncoder().encode('<w/>')],
  ]);
  assert.equal(await bakedPreview(file), null);
});

test('the full-size composite wins over the thumbnail', async () => {
  // Krita writes both. The card is drawn far larger than a file browser's icon,
  // so the order in the table is not arbitrary.
  const file = await zipFile('art.kra', [
    ['preview.png', png(600)],
    ['mergedimage.png', png(4096)],
  ]);
  const out = await bakedPreview(file);
  assert.ok(out);
  assert.equal(out.size, 4096 + 8);
});

test('a picture is identified by its own bytes, not by the path it is at', async () => {
  // OOXML allows docProps/thumbnail.emf, and a writer that emits one under a
  // .jpeg name is not hypothetical. Handing it to an <img> would replace a grey
  // card with a broken one, which is worse than the grey card.
  const file = await zipFile('metafile.docx', [
    ['docProps/thumbnail.jpeg', emf()],
  ]);
  assert.equal(await bakedPreview(file), null);
});

test('a preview under the floor is not a preview', async () => {
  const file = await zipFile('tiny.odt', [
    ['Thumbnails/thumbnail.png', png(16)],
  ]);
  assert.equal(await bakedPreview(file), null);
});

test('a container that is not a container comes back null', async () => {
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array([0x50, 0x4b]),                   // half a signature
    new Uint8Array(2048).fill(0x41),                // no directory anywhere
    png(4096),                                      // a picture named .docx
  ]) {
    assert.equal(await bakedPreview(new File([bytes], 'broken.docx')), null);
  }
});

test('a truncated archive comes back null rather than throwing', async () => {
  const whole = await zipFile('cut.odt', [['Thumbnails/thumbnail.png', png()]]);
  const bytes = new Uint8Array(await whole.arrayBuffer());
  // Keep the end-of-directory record and destroy the middle: the archive still
  // parses far enough to name its entries and then fails to inflate one.
  for (let i = 40; i < bytes.length - 60; i++) bytes[i] ^= 0xff;
  assert.equal(await bakedPreview(new File([bytes], 'cut.odt')), null);
});

// ---------------------------------------------------------------------------
// PSD
// ---------------------------------------------------------------------------

/**
 * A Photoshop file with one Image Resources record.
 *
 * 26-byte header, an empty Colour Mode Data section, then the resources: an
 * '8BIM' signature, the resource id, an empty Pascal-string name, the record
 * length, and the record itself - a 28-byte thumbnail header followed by a JPEG.
 */
function psd({ id = 1036, format = 1, payload = jpeg(), signature = '8BPS', pad = true } = {}) {
  const head = new Uint8Array(26);
  head.set(new TextEncoder().encode(signature), 0);
  const record = new Uint8Array(28 + payload.length);
  new DataView(record.buffer).setUint32(0, format, false);
  record.set(payload, 28);

  // colour-mode length, resources length, 8BIM, id, empty name, record length,
  // the record, and its pad byte.
  const body = new Uint8Array(4 + 4 + 4 + 2 + 2 + 4 + record.length + 1);
  const view = new DataView(body.buffer);
  let p = 0;
  view.setUint32(p, 0, false); p += 4;                       // colour mode data: empty
  const resLenAt = p; p += 4;                                // resources length, back-filled
  view.setUint32(p, 0x3842494d, false); p += 4;              // '8BIM'
  view.setUint16(p, id, false); p += 2;
  view.setUint16(p, 0, false); p += 2;                       // empty name, padded to two
  view.setUint32(p, record.length, false); p += 4;
  body.set(record, p);
  p += record.length + (pad ? record.length % 2 : 0);
  view.setUint32(resLenAt, p - resLenAt - 4, false);

  return new File([head, body.subarray(0, p)], 'art.psd');
}

test('a PSD gives up its composite thumbnail', async () => {
  const out = await bakedPreview(psd());
  assert.ok(out);
  assert.equal(out.type, 'image/jpeg');
});

test('the older BGR thumbnail record is read too', async () => {
  const out = await bakedPreview(psd({ id: 1033 }));
  assert.ok(out);
});

test('a raw-RGB thumbnail is declined', async () => {
  // Format 0 is uncompressed RGB, which nothing here can draw. No writer emits
  // it, which is exactly why a file claiming it is one to walk away from.
  assert.equal(await bakedPreview(psd({ format: 0 })), null);
});

test('a PSD whose thumbnail is not a JPEG is declined', async () => {
  assert.equal(await bakedPreview(psd({ payload: emf() })), null);
});

test('anything that is not a PSD is declined on its signature', async () => {
  assert.equal(await bakedPreview(psd({ signature: '8BQS' })), null);
});

test('a truncated PSD comes back null rather than reading past the buffer', async () => {
  const whole = psd();
  const bytes = new Uint8Array(await whole.arrayBuffer());
  for (const cut of [10, 26, 30, 40, 60, bytes.length - 100]) {
    const part = new File([bytes.subarray(0, Math.max(0, cut))], 'cut.psd');
    // The assertion is that it returns at all - a walk that trusted the declared
    // lengths would run off the end here.
    assert.equal(await bakedPreview(part), null, `cut at ${cut}`);
  }
});

test('a PSD with a lying record length is declined', async () => {
  const bytes = new Uint8Array(await psd().arrayBuffer());
  // The record length sits after the header, the empty colour-mode length, the
  // resources length, the 8BIM signature, the id and the empty name.
  const at = 26 + 4 + 4 + 4 + 2 + 2;
  new DataView(bytes.buffer).setUint32(at, 0x7fffffff, false);
  assert.equal(await bakedPreview(new File([bytes], 'lying.psd')), null);
});
