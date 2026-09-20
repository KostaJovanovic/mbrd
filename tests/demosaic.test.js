// Camera RAW: which cards count as one, the undoable Demosaic step, and what
// Optimize plans and swaps for a RAW. LibRaw itself needs a browser (wasm in a
// worker), so the decode is checked by hand - see optimize/demosaic.ts.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  byId, loadBoard, undo, redo, setBoardMode, swapAssets, setItemDemosaiced,
} from '../web/assets/js/state.ts';
import { putAsset, clearAssets } from '../web/assets/js/storage/assets.ts';
import { planOptimize } from '../web/assets/js/optimize/optimize.ts';
import { isRaw, SENSOR_PIXELS } from '../web/assets/js/optimize/demosaic.ts';
import { explain } from '../web/assets/js/consent.ts';
import { hash } from './helpers.js';
import { photo } from './state-fixtures.js';

const RAW = hash('raw');
const PREVIEW = hash('preview');
const THUMB = hash('thumb');
const DISPLAY = hash('display');
const DEV = hash('developed');
const DEV_THUMB = hash('devthumb');
const WEBP = hash('webp');

const rawCard = (meta = {}) => photo({
  id: 'r', name: 'IMG_0001.CR2', asset: { hash: RAW, embedded: true },
  meta: { ext: 'cr2', mime: '', preview: PREVIEW, thumb: THUMB, display: DISPLAY, ...meta },
});

// What the import makes of a RAW now: the developed picture is the card's file,
// and the sensor data is kept beside it at `source` until Optimize drops it.
const devCard = (meta = {}) => photo({
  id: 'r', name: 'IMG_0001.webp', asset: { hash: WEBP },
  meta: {
    ext: 'webp', mime: 'image/webp', source: RAW, origName: 'IMG_0001.CR2',
    thumb: THUMB, ...meta,
  },
});

beforeEach(() => {
  setBoardMode('desktop');
  clearAssets();
  putAsset(RAW, new Blob([new Uint8Array(8192)]), { name: 'IMG_0001.CR2', ext: 'cr2', mime: '' });
  putAsset(PREVIEW, new Blob([new Uint8Array(1024)], { type: 'image/jpeg' }),
    { name: 'preview.jpeg', ext: 'jpeg', mime: 'image/jpeg' });
  putAsset(DISPLAY, new Blob([new Uint8Array(512)], { type: 'image/webp' }),
    { name: 'display.webp', ext: 'webp', mime: 'image/webp' });
  putAsset(DEV, new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }),
    { name: 'demosaic.jpeg', ext: 'jpeg', mime: 'image/jpeg' });
  putAsset(WEBP, new Blob([new Uint8Array(1536)], { type: 'image/webp' }),
    { name: 'IMG_0001.webp', ext: 'webp', mime: 'image/webp' });
  loadBoard({ title: 'T', items: [rawCard()] });
});

test('a RAW is a picture card whose file arrived as a camera RAW', () => {
  assert.equal(isRaw(byId('r')), true);
  assert.equal(isRaw({ type: 'image', name: 'x.NEF', asset: { hash: RAW } }), true,
    'the name answers when meta has no ext');
  assert.equal(isRaw({ type: 'image', name: 'x.jpg', asset: { hash: RAW }, meta: { ext: 'jpg' } }), false);
  assert.equal(isRaw({ type: 'generic', name: 'x.cr2', asset: { hash: RAW }, meta: { ext: 'cr2' } }), false,
    'a RAW with no preview in it lands as a named card, and stays one');
  assert.equal(isRaw({ type: 'image', name: 'x.cr2', meta: { ext: 'cr2' } }), false, 'no file, nothing to develop');
  assert.equal(isRaw(devCard()), true,
    'the card file is a WebP, but the file that arrived was a RAW and is still beside it');
});

test('Optimize drops the sensor file a developed card keeps beside it', () => {
  loadBoard({ title: 'T', items: [devCard()] });
  const plan = planOptimize();
  assert.deepEqual(plan.pictures.map(j => j.hash), [WEBP],
    'the RAW behind it is not a job of its own - it is about to be thrown away');
  assert.ok(!plan.pictures[0].raw, 'and it is not developed a second time');
  swapAssets([{ id: 'r', dropSource: true }]);
  let it = byId('r');
  assert.equal('source' in it.meta, false);
  assert.equal(it.asset.hash, WEBP, 'the picture on screen does not change');
  undo();
  it = byId('r');
  assert.equal(it.meta.source, RAW, 'undo puts the sensor file back');
});

test('Demosaic is one undo step that swaps the preview and the copies cut from it', () => {
  setItemDemosaiced('r', { picture: DEV, thumb: DEV_THUMB });
  let it = byId('r');
  assert.equal(it.meta.preview, DEV);
  assert.equal(it.meta.thumb, DEV_THUMB);
  assert.equal('display' in it.meta, false, 'a display copy of the camera preview is not a copy of this picture');
  assert.equal(it.meta.demosaiced, true);
  assert.equal(it.asset.hash, RAW, 'the RAW stays the card file');
  undo();
  it = byId('r');
  assert.equal(it.meta.preview, PREVIEW);
  assert.equal(it.meta.thumb, THUMB);
  assert.equal(it.meta.display, DISPLAY);
  assert.equal('demosaiced' in it.meta, false);
  redo();
  assert.equal(byId('r').meta.preview, DEV);
});

test('on a card the import already developed, Demosaic replaces the file itself', () => {
  loadBoard({ title: 'T', items: [devCard()] });
  setItemDemosaiced('r', { picture: DEV, thumb: DEV_THUMB, mime: 'image/jpeg', asItsFile: true });
  let it = byId('r');
  assert.equal(it.asset.hash, DEV, 'the better picture became the card file');
  assert.equal(it.meta.mime, 'image/jpeg');
  assert.equal(it.meta.ext, 'jpeg');
  assert.equal(it.meta.source, RAW, 'the sensor file stays beside it for Optimize to drop');
  assert.equal('preview' in it.meta, false, 'the file is the picture; there is no stand-in left');
  assert.equal(it.meta.thumb, DEV_THUMB);
  assert.equal(isRaw(it), true, 'the row still offers a fuller develop');
  undo();
  it = byId('r');
  assert.equal(it.asset.hash, WEBP);
  assert.equal(it.meta.ext, 'webp');
  assert.equal(it.meta.source, RAW);
});

test('Demosaic refuses anything that is not a picture it can point at', () => {
  setItemDemosaiced('r', { picture: 'not a hash' });
  assert.equal(byId('r').meta.preview, PREVIEW);
});

test('Optimize plans the RAW itself, and not the preview and display it replaces', () => {
  const [job, ...rest] = planOptimize().pictures;
  assert.equal(rest.length, 0, 'the preview or the display copy was planned as a job of its own');
  assert.equal(job.hash, RAW);
  assert.equal(job.raw, true);
  assert.equal(job.kind, 'image');
  assert.equal(job.developed, undefined);
});

test('a RAW the Demosaic row already developed hands Optimize that picture', () => {
  loadBoard({ title: 'T', items: [rawCard({ preview: DEV, demosaiced: true })] });
  const [job] = planOptimize().pictures;
  assert.equal(job.developed, DEV);
});

test('an older build marking the RAW as looked at does not stop it being developed', () => {
  loadBoard({ title: 'T', items: [rawCard({ opt: [RAW, PREVIEW] })] });
  assert.deepEqual(planOptimize().pictures.map(j => j.hash), [RAW]);
});

test('the swap makes a developed RAW a plain picture, and undo makes it a RAW again', () => {
  swapAssets([{ id: 'r', asset: WEBP, plain: { ext: 'webp', mime: 'image/webp' } }]);
  let it = byId('r');
  assert.equal(it.asset.hash, WEBP);
  assert.equal(it.meta.was, RAW, 'the RAW is pinned for undo like any original');
  assert.equal(it.meta.ext, 'webp');
  assert.equal(it.meta.mime, 'image/webp');
  for (const key of ['preview', 'display', 'demosaiced']) assert.equal(key in it.meta, false, `${key} survived`);
  assert.equal(isRaw(it), false, 'the menu stops offering Demosaic');
  undo();
  it = byId('r');
  assert.equal(it.asset.hash, RAW);
  assert.equal(it.meta.preview, PREVIEW);
  assert.equal(isRaw(it), true);
});

test('the sensor ceiling has a sentence of its own', () => {
  assert.ok(SENSOR_PIXELS > 61_000_000, 'a 61 Mpx full-frame body would be asked about');
  assert.match(explain({ ceiling: 'sensor-pixels', what: 'x' }), /preview the camera made/);
});
