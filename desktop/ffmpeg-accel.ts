// The hardware H.264 encoders and the rewrite that moves a software encode
// onto one. Pure: no Node, Electron or DOM import, so tests/ffmpeg-accel.test.js
// runs it with no install. Ported from FileAnalyser's desktop/ffmpeg-accel.mjs,
// the rewrite half. Its checkArgs() is not here: in mbrd the page never picks
// ffmpeg arguments, and native/ffmpeg.ts builds each list from two clamped numbers.

/** x264's CRF scale as a VBR bitrate, for an encoder with no reliable
 * constant-quality mode. CRF 23 (x264's default) is 8 Mbit/s, and every 6 steps
 * halves or doubles it, x264's own rule of thumb. No desktop family needs it:
 * FileAnalyser uses it for Android's MediaCodec. */
export function crfToBitrate(crf: number): string {
  const c = Number.isFinite(crf) ? crf : 23;
  return `${Math.max(500, Math.round(8000 * 2 ** ((23 - c) / 6)))}k`;
}

export type Vendor = 'nvidia' | 'intel' | 'amd' | 'apple';

export interface Family {
  vendor: Vendor;
  label: string;
  /** The family's H.264 encoder. mbrd encodes nothing else. */
  h264: string;
  /** Decode acceleration, used only when no filter needs frames on the CPU. */
  hwaccel: string;
  /** x264's named presets in the family's own terms. Null: it takes none. */
  preset: Readonly<Record<string, string>> | null;
  /** -crf in the family's own terms. */
  quality(crf: number): string[];
}

/** In preference order: NVENC first (fastest and most predictable), then Intel
 * Quick Sync, AMD AMF and Apple VideoToolbox. No MediaCodec: no desktop build
 * lists it. */
export const FAMILIES: readonly Family[] = [
  {
    vendor: 'nvidia',
    label: 'NVIDIA NVENC',
    h264: 'h264_nvenc',
    hwaccel: 'cuda',
    // x264's named presets onto NVENC's p1..p7 speed and quality ladder.
    preset: {
      ultrafast: 'p1', superfast: 'p1', veryfast: 'p2', faster: 'p3', fast: 'p4',
      medium: 'p4', slow: 'p5', slower: 'p6', veryslow: 'p7',
    },
    quality: crf => ['-rc', 'vbr', '-cq', String(crf)],
  },
  {
    vendor: 'intel',
    label: 'Intel Quick Sync',
    h264: 'h264_qsv',
    hwaccel: 'qsv',
    preset: {
      ultrafast: 'veryfast', superfast: 'veryfast', veryfast: 'veryfast', faster: 'faster',
      fast: 'fast', medium: 'medium', slow: 'slow', slower: 'slower', veryslow: 'veryslow',
    },
    quality: crf => ['-global_quality', String(crf)],
  },
  {
    vendor: 'amd',
    label: 'AMD AMF',
    h264: 'h264_amf',
    hwaccel: 'd3d11va',
    preset: {
      ultrafast: 'speed', superfast: 'speed', veryfast: 'speed', faster: 'speed', fast: 'balanced',
      medium: 'balanced', slow: 'quality', slower: 'quality', veryslow: 'quality',
    },
    quality: crf => ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)],
  },
  {
    vendor: 'apple',
    label: 'Apple VideoToolbox',
    h264: 'h264_videotoolbox',
    hwaccel: 'videotoolbox',
    preset: null,
    quality: crf => ['-q:v', String(Math.max(1, Math.min(100, 100 - crf * 2)))],
  },
];

/** The software H.264 encoders the rewrite may replace. */
const SW_H264 = new Set(['libx264', 'libopenh264']);

/** Filters run on CPU frames, so decode acceleration would only add a copy back. */
const FILTER_FLAGS = new Set(['-vf', '-filter:v', '-filter_complex', '-lavfi']);

export interface Accelerated {
  args: string[];
  changed: boolean;
  /** Which encoder, for the log. Empty when nothing changed. */
  note: string;
}

/** Move a software H.264 encode onto `family`. Conservative: only a plain
 * software encode changes, a stream copy never does, and the caller retries the
 * original list when the hardware attempt fails. The input is not changed. */
export function accelerate(args: readonly string[], family: Family | null): Accelerated {
  const unchanged: Accelerated = { args: [...args], changed: false, note: '' };
  if (!family) return unchanged;

  const out = [...args];
  const codecAt = out.findIndex(a => a === '-c:v' || a === '-vcodec');
  // 'copy', a hardware encoder already, or another codec: left alone.
  if (codecAt === -1 || codecAt + 1 >= out.length || !SW_H264.has(out[codecAt + 1])) return unchanged;
  out[codecAt + 1] = family.h264;

  // x264's preset names mean nothing to the hardware, so translate or drop.
  const presetAt = out.indexOf('-preset');
  if (presetAt !== -1 && presetAt + 1 < out.length) {
    const mapped = family.preset?.[out[presetAt + 1]];
    if (mapped) out[presetAt + 1] = mapped;
    else out.splice(presetAt, 2);
  }

  // -crf is x264's. Each family spells constant quality its own way.
  const crfAt = out.indexOf('-crf');
  if (crfAt !== -1 && crfAt + 1 < out.length) {
    const crf = Number.parseInt(out[crfAt + 1], 10);
    out.splice(crfAt, 2, ...(Number.isFinite(crf) ? family.quality(crf) : []));
  }

  // Decode acceleration only when no filter needs CPU frames, and before the
  // first -i, where ffmpeg wants input options.
  let note = `${family.label} ${family.h264}`;
  const inputAt = out.indexOf('-i');
  if (!out.some(a => FILTER_FLAGS.has(a)) && inputAt !== -1 && !out.includes('-hwaccel')) {
    out.splice(inputAt, 0, '-hwaccel', family.hwaccel);
    note += ` (+${family.hwaccel} decode)`;
  }

  return { args: out, changed: true, note };
}
