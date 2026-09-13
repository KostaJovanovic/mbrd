// The hardware rewrite (desktop/ffmpeg-accel.ts), run on a list shaped like
// the one native/ffmpeg.ts builds for a transcode. A pure module, so this needs
// no Electron and no ffmpeg. The probe and the software retry need both, and
// are checked by hand (research/apps-tasks-2026-09-13.md, G3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FAMILIES, accelerate, crfToBitrate } from '../desktop/ffmpeg-accel.ts';

const family = vendor => FAMILIES.find(f => f.vendor === vendor);

/** transcode()'s shape: a scale filter, libx264 at a named preset, a bitrate. */
const TRANSCODE = [
  '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
  '-vf', "scale='min(1600,iw)':-2:flags=lanczos",
  '-c:v', 'libx264', '-preset', 'medium', '-b:v', '2000000', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', 'pipe:1',
];

test('NVENC takes the encode, the preset in its own terms, and the bitrate as it was', () => {
  const { args, changed, note } = accelerate(TRANSCODE, family('nvidia'));
  assert.equal(changed, true);
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.equal(args[args.indexOf('-preset') + 1], 'p4');
  assert.equal(args[args.indexOf('-b:v') + 1], '2000000');
  // The scale filter wants CPU frames, so there is no decode acceleration.
  assert.equal(args.includes('-hwaccel'), false);
  assert.equal(note, 'NVIDIA NVENC h264_nvenc');
});

test('a family with no presets loses the preset rather than getting a wrong one', () => {
  const { args } = accelerate(TRANSCODE, family('apple'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox');
  assert.equal(args.includes('-preset'), false);
});

test('with no filter, decode acceleration goes in before the first input', () => {
  const plain = ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'];
  const { args, note } = accelerate(plain, family('amd'));
  assert.deepEqual(args, ['-hwaccel', 'd3d11va', '-i', 'in.mp4', '-c:v', 'h264_amf', 'out.mp4']);
  assert.match(note, /\+d3d11va decode/);
});

test('-crf becomes the family\'s own constant-quality options', () => {
  const { args } = accelerate(['-i', 'a', '-vf', 'null', '-c:v', 'libx264', '-crf', '23', 'b'], family('nvidia'));
  assert.deepEqual(args.slice(-6), ['h264_nvenc', '-rc', 'vbr', '-cq', '23', 'b']);
  assert.equal(args.includes('-crf'), false);
});

test('nothing changes with no family, a stream copy or another codec', () => {
  for (const [list, fam] of [
    [TRANSCODE, null],
    [['-i', 'a', '-c:v', 'copy', 'b'], family('nvidia')],
    [['-i', 'a', '-c:v', 'libx265', 'b'], family('nvidia')],
    [['-i', 'a', 'b'], family('nvidia')],
  ]) {
    const out = accelerate(list, fam);
    assert.equal(out.changed, false);
    assert.deepEqual(out.args, list);
  }
});

test('the list it was given comes back untouched', () => {
  const copy = [...TRANSCODE];
  accelerate(TRANSCODE, family('intel'));
  assert.deepEqual(TRANSCODE, copy);
});

test('the families are the four desktop ones, NVENC first', () => {
  assert.deepEqual(FAMILIES.map(f => f.vendor), ['nvidia', 'intel', 'amd', 'apple']);
});

test('crfToBitrate is 8 Mbit/s at 23, halves every 6 steps, and stops at 500k', () => {
  assert.equal(crfToBitrate(23), '8000k');
  assert.equal(crfToBitrate(29), '4000k');
  assert.equal(crfToBitrate(60), '500k');
  assert.equal(crfToBitrate(Number.NaN), '8000k');
});
