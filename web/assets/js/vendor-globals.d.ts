/**
 * The prefixed globals this app feature-detects, declared once.
 *
 * Three APIs it reaches for are not in lib.dom because only Safari has them
 * under these names. The code that wants them already asks before using them -
 * that is not the problem this file solves. The problem is that asking used to
 * cost a double cast: `window as unknown as { webkitAudioContext?: ... }`, once
 * per site, each one an independent guess at the shape. A double cast is
 * indistinguishable from a wrong one at the call site, and there were four of
 * them describing three APIs.
 *
 * Declaring them here makes the read a plain optional property access, which is
 * what it always was in fact: the checker now knows the name may be absent and
 * makes the caller handle that, instead of being told to look away.
 *
 * This file emits nothing and is never imported. It is picked up by
 * tsconfig.json's `include` and is the only .d.ts in the tree - a second one
 * would mean this rationale is being repeated somewhere, so add to this file
 * instead. Everything in it is optional, without exception: a declaration that
 * is not optional is a claim that every browser has it, and if that were true
 * the API would be in lib.dom and this file would not need the entry.
 *
 * See research/docs/browser-support.md for what is actually promised to whom.
 */

interface Window {
  /** Safari's AudioContext. cuelume/engine.ts, for the interaction sounds. */
  webkitAudioContext?: typeof AudioContext;
  /** Safari's OfflineAudioContext. canvas/waveform.ts, to decode for peaks. */
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

interface Navigator {
  /**
   * The Audio Session API, Safari-only today. cuelume/engine.ts sets `ambient`
   * so a hundred-millisecond blip mixes with whatever the phone is already
   * playing rather than interrupting it. `type` is writable where the API
   * exists at all, but the write is still guarded: a browser may ship it
   * read-only.
   */
  audioSession?: { type?: string };
}
