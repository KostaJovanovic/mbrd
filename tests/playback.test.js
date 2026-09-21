// The five players, and rules each had written down separately. No
// browser or <audio> here, so most of this checks the shape of a repair
// against the source, as menu-keyboard.js and font-tokens.js do. clock()
// runs for real, since it's arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, JS, read } from './helpers.js';
import { clock, trackLength } from '../web/assets/js/media/transport.ts';

const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = rel => code(read(join(JS, rel)));
const sheet = name => read(join(WEB, 'assets', 'css', name)).replace(/\/\*[\s\S]*?\*\//g, '');

test('the clock never reads NaN', () => {
  // `Math.max(0, Math.floor(NaN))` is NaN, so the clamp let one through
  // and the readout said "NaN:NaN". A duration is NaN until metadata
  // arrives, and ui/playlist.ts's `typeof === 'number'` guard lets NaN pass.
  assert.equal(clock(Number.NaN), '0:00');
  assert.equal(clock(Number.POSITIVE_INFINITY), '0:00');
  assert.equal(clock(-5), '0:00');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(61), '1:01');
  assert.equal(clock(599.9), '9:59');
});

test('the counted length wins over the engine guess', () => {
  // A containerless .aac has no duration field, so the engine divides the
  // file by the first frame's bitrate. A 95-minute stream that opens on a
  // 9-byte silent frame reads as 7319 minutes in Firefox and 97 in
  // Chromium; import/containers.ts counted 5731s off the frames themselves.
  assert.equal(trackLength({ duration: 439170 }, 5731.09), 5731.09);
  // No counted number: the engine's is all there is, and a stream still
  // loading has none of its own.
  assert.equal(trackLength({ duration: 300 }, undefined), 300);
  assert.equal(trackLength({ duration: 300 }, null), 300);
  assert.equal(trackLength({ duration: Number.NaN }, undefined), 0);
  // Neither, and the callers read the 0 as "not yet" and refuse to seek.
  assert.equal(trackLength({ duration: Number.NaN }, Number.NaN), 0);
  assert.equal(trackLength({ duration: Number.POSITIVE_INFINITY }, 0), 0);
});

test('no player reads a length off the element behind trackLength', () => {
  // Three players painted `sound.duration` straight into the clock and the
  // fill, so a raw .aac read as 7319 minutes on the card, in the bar and in
  // the playlist window - while the board itself held the right number.
  // currentTime and seeking are sample-accurate even there, so only the
  // length is corrected.
  for (const rel of ['canvas/transport.ts', 'ui/nowplaying.ts', 'ui/playlist.ts']) {
    const s = src(rel);
    assert.match(s, /trackLength\(/, `${rel} no longer asks for the counted length`);
    assert.ok(!/\b(?:sound|s|el)\.duration\b/.test(s),
      `${rel} reads a length off the media element again`);
  }
});

test('every player reports a refused play instead of swallowing it', () => {
  // canvas/transport.ts argued this at length - an empty catch is why
  // "the cards are unplayable" once had nothing in the console - yet kept
  // its own copy while the queue, playlist window, now-playing bar and
  // canvas/audio.ts all used an empty catch. Pressing Play on the
  // playlist hero with autoplay blocked did nothing, silently.
  assert.match(src('media/transport.ts'), /export function reportPlayError/,
    'the shared reporter is gone');
  for (const rel of [
    'canvas/audio.ts', 'canvas/playlist-queue.ts', 'canvas/transport.ts',
    'ui/nowplaying.ts', 'ui/playlist.ts',
  ]) {
    const s = src(rel);
    assert.ok(!/\.play\(\)\.catch\(\(\) =>/.test(s),
      `${rel} swallows a refused play() again`);
    if (/\.play\(\)\.catch\(/.test(s)) {
      assert.match(s, /\.play\(\)\.catch\(reportPlayError\)/,
        `${rel} catches a refused play() with something other than the shared reporter`);
    }
  }
});

test('the now-playing bar rebinds when the element changes under one track', () => {
  // One track can play through two elements over its life: the queue's
  // shared <audio> while the card is culled, and the card's own once
  // mounted. show() returned early on an unchanged item, so the bar kept
  // its rAF, seekTo and listeners on the element the exclusivity rule had
  // just paused - drawing 0:00 while sound came from the other.
  const s = src('ui/nowplaying.ts');
  assert.match(s, /if \(current\.item === shown && current\.el === boundEl\) return;/,
    'show() compares only the item again');
  assert.match(s, /let boundEl: HTMLMediaElement \| null = null;/,
    'the bar no longer records which element it is driving');
  assert.match(s, /boundEl = null;/, 'teardown() leaves boundEl set');
});

test('a frozen GIF gives its blob back when the card is discarded', () => {
  // A blob URL is an entry in the document's URL store, not a property
  // of the node - discarding the node threw away the string and left the
  // blob for the life of the tab.
  assert.match(src('canvas/stills.ts'), /export function releaseStills\(el: Element\)/,
    'releaseStills() is gone');
  assert.match(src('canvas/stills.ts'), /URL\.revokeObjectURL\(twin\._stillUrl\)/,
    'releaseStills() no longer revokes anything');
  assert.match(src('canvas/items.ts'), /releaseStills\(el\);/,
    'discard() stopped releasing frozen frames');
});

test('a discarded audio card stops listening to the selection', () => {
  // The per-card subscription unsubscribed only from inside its own
  // handler, so a board panned past and left alone kept one live closure
  // per card, each holding the wave, item, element and detached strip.
  assert.match(src('canvas/transport.ts'), /export function releaseTransports\(el: Element\)/,
    'releaseTransports() is gone');
  assert.match(src('canvas/items.ts'), /releaseTransports\(el\);/,
    'discard() stopped unsubscribing transports');
});

test('the still sweep is not guarded on a count that misses a swap', () => {
  // `world.childElementCount === mounted` is the wrong question asked
  // cheaply: a pan across a large board mounts and discards in the same
  // pass, so the count is often unchanged while the set isn't - a GIF
  // arriving in one of those passes kept animating with is-stilled on.
  const s = src('canvas/stills.ts');
  assert.ok(!/childElementCount === mounted/.test(s),
    'the sweep is back to guarding on the mounted count');
  assert.match(s, /sweep = requestAnimationFrame/,
    'the sweep is no longer coalesced to a frame');
});

test('a deleted current track advances rather than restarting the queue', () => {
  // indexOf answers -1 for a gone track, and writing that into queuePos
  // made the next `ended` read `-1 >= length - 1` as false, stepping to 0
  // and playing the *first* track.
  const s = src('canvas/playlist-queue.ts');
  assert.match(s, /if \(idx >= 0\) \{/,
    'rebuildOrder() writes indexOf() into queuePos again');
  // A track whose bytes have gone is skipped rather than stalling the
  // queue silently with no repaint.
  assert.match(s, /function startCurrent\(skips = 0\)/,
    'startCurrent() no longer counts what it has skipped');
  assert.match(s, /startCurrent\(skips \+ 1\);/,
    'a missing asset stalls the queue again');
});

test('the marker and font menus restyle what was selected when they opened', () => {
  // The menu takes focus and ui/menu.ts closes it, handing focus back to
  // the contenteditable, *before* running the row's action. A setWash
  // resolving the selection at that point resolved it against the caret
  // the hand-back left: three lines selected, one marked. (The split and
  // paste half of this used to be read off the source here; it is a
  // behaviour of the run model now, in tests/note-model.test.js.)
  const s = src('canvas/notes.ts');
  assert.match(s, /setWash\(wash: NoteWash \| null, at: Grab \| null\): void;/,
    'setWash() no longer takes the selection it is to mark');
  assert.equal((s.match(/const at = api\.grab\(\);/g) || []).length, 2,
    'the marker and font buttons no longer read the selection before opening their menus');
});

test('the note colour no longer collides with the whimsy multiplier', () => {
  // tokens.css owned --wash as `1 / 1.4 / 0`, consumed by base.css as
  // `calc(3% * var(--wash))`, and it's in the look allowlist - so a
  // .mbrd's --wash of "red" painted every unmarked marker chip red, its
  // transparent fallback unreachable behind an inherited 1.
  const cards = sheet('cards.css');
  assert.match(cards, /\[data-wash="amber"\]\s*\{ --note-wash:/,
    'cards.css is back to defining --wash as a colour');
  assert.ok(!/--wash:/.test(cards), 'cards.css still declares --wash somewhere');
  // Nothing reads it as a colour any more; base.css's arithmetic is the
  // one true consumer and stays.
  for (const name of ['cards.css', 'timeline.css']) {
    assert.ok(!/var\(--wash[,)]/.test(sheet(name)),
      `${name} reads --wash as a colour again - it is a number`);
  }
  // The multiplier itself is untouched: tokens.css declares it and
  // base.css does arithmetic with it, the meaning that was there first.
  assert.match(sheet('base.css'), /calc\(3% \* var\(--wash\)\)/,
    'the whimsy ornament multiplier lost its one consumer');
});
