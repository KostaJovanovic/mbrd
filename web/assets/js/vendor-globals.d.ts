/** Prefixed/Safari-only globals the app feature-detects. All optional — if it
 * were in lib.dom this file would not need the entry. The only .d.ts in the
 * tree; picked up by tsconfig include, never imported. */

interface Window {
  /** Safari's AudioContext. cuelume/engine.ts, for the interaction sounds. */
  webkitAudioContext?: typeof AudioContext;
  /** Safari's OfflineAudioContext. canvas/waveform.ts, to decode for peaks. */
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

interface Navigator {
  /** Safari Audio Session API. cuelume/engine.ts sets `ambient` so interface
   * sounds mix with existing audio instead of interrupting it. */
  audioSession?: { type?: string };
}
