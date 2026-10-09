// Files in through the Add files picker: a picture, a video, a PDF, two 3D
// formats and a PureRef board. Every file is made here or is one the repository
// already carries, so the suite needs no fixtures folder. Each must land as the
// right kind of card and draw something, with no console error on the way.

import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect, items, frames } from './harness.js';
import { pur } from '../tests/pur-builder.js';

const ICON = new URL('../web/assets/img/icon-192.png', import.meta.url);
const ICON_BIG = new URL('../web/assets/img/icon-512.png', import.meta.url);

/** A one-page PDF with a line of text; offsets in the xref are computed. */
function pdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R'
      + ' /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const text = 'BT /F1 24 Tf 40 100 Td (mbrd) Tj ET';
  objs[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let out = '%PDF-1.4\n';
  const at = objs.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + at.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const TETRA = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const FACES = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

const stl = () => Buffer.from(['solid t', ...FACES.flatMap(f => [
  ' facet normal 0 0 0', '  outer loop', ...f.map(i => `   vertex ${TETRA[i].join(' ')}`),
  '  endloop', ' endfacet']), 'endsolid t', ''].join('\n'));

const obj = () => Buffer.from([...TETRA.map(v => `v ${v.join(' ')}`),
  ...FACES.map(f => `f ${f.map(i => i + 1).join(' ')}`), ''].join('\n'));

/** Add `files` through the picker, as the toolbar's Add does; the new cards. */
async function addFiles(page, files) {
  const before = new Set((await items(page)).map(i => i.id));
  const choosing = page.waitForEvent('filechooser');
  await page.evaluate(() => { void window.mbrd.cmds.addFiles(); });
  await (await choosing).setFiles(files);
  await expect.poll(async () => (await items(page)).filter(i => !before.has(i.id) && !i.id.startsWith('__')).length,
    { timeout: 30_000 }).toBeGreaterThanOrEqual(files.length > 0 ? 1 : 0);
  await frames(page);
  return (await items(page)).filter(i => !before.has(i.id) && !i.id.startsWith('__'));
}

const card = (page, id) => page.locator(`#world .item[data-id="${id}"]`);

test('a picture lands as an image card and decodes', async ({ app }) => {
  const [made] = await addFiles(app, [{ name: 'icon.png', mimeType: 'image/png', buffer: await readFile(ICON) }]);
  expect(made.type).toBe('image');
  await expect.poll(() => card(app, made.id).locator('img').evaluateAll(
    imgs => imgs.some(img => img.complete && img.naturalWidth > 0))).toBe(true);
});

test('a video lands as a video card', async ({ app, browserName }) => {
  // Recorded here from a canvas: a second of colour, in whatever container
  // this engine's MediaRecorder writes.
  const recorded = await app.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder !== 'function') return {};
    const g = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const type = ['video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    if (!type) return {};
    const rec = new MediaRecorder(stream, { mimeType: type });
    const parts = [];
    rec.ondataavailable = e => parts.push(e.data);
    const done = new Promise(ok => { rec.onstop = ok; });
    rec.start();
    for (let k = 0; k < 30; k++) {
      g.fillStyle = `hsl(${k * 12} 80% 50%)`;
      g.fillRect(0, 0, 160, 90);
      await new Promise(r => setTimeout(r, 33));
    }
    rec.stop();
    await done;
    const bytes = new Uint8Array(await new Blob(parts, { type }).arrayBuffer());
    return { type, bytes: [...bytes] };
  });
  test.skip(!recorded.type, `${browserName} records no video here`);
  const ext = recorded.type === 'video/mp4' ? 'mp4' : 'webm';
  const [made] = await addFiles(app, [{ name: `clip.${ext}`, mimeType: recorded.type, buffer: Buffer.from(recorded.bytes) }]);
  expect(made.type).toBe('video');
  await expect(card(app, made.id)).toBeVisible();
});

test('a PDF lands as a picture of its first page', async ({ app }) => {
  const [made] = await addFiles(app, [{ name: 'page.pdf', mimeType: 'application/pdf', buffer: pdf() }]);
  expect(made.type).toBe('image');
  await expect.poll(() => card(app, made.id).locator('img').evaluateAll(
    imgs => imgs.some(img => img.complete && img.naturalWidth > 0)), { timeout: 30_000 }).toBe(true);
});

for (const [name, make] of [['tetra.stl', stl], ['tetra.obj', obj]]) {
  test(`${name} lands as a model card`, async ({ app }) => {
    const [made] = await addFiles(app, [{ name, mimeType: 'application/octet-stream', buffer: make() }]);
    expect(made.type).toBe('model');
    await expect(card(app, made.id)).toBeVisible();
  });
}

test('a PureRef board lands as its pictures, placed', async ({ app }) => {
  const small = [...await readFile(ICON)];
  const big = [...await readFile(ICON_BIG)];
  const file = pur({
    pictures: [small, big],
    images: [
      { id: 1, picture: 0, name: 'small.png', w: 192, h: 192, m: [1, 0, 0, 1], x: -300, y: 0 },
      { id: 2, picture: 1, name: 'big.png', w: 512, h: 512, m: [1, 0, 0, 1], x: 300, y: 0 },
    ],
  });
  const made = await addFiles(app, [{ name: 'refs.pur', mimeType: 'application/octet-stream', buffer: Buffer.from(file) }]);
  const pictures = made.filter(i => i.type === 'image');
  expect(pictures.length).toBe(2);
  // Placed as the file had them: the small one left of the big one.
  const [left, right] = pictures.sort((a, b) => a.x - b.x);
  expect(left.w).toBeLessThan(right.w);
});
