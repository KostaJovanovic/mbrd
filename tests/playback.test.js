// The five players, and the rules they had each written down separately.
//
// There is no browser here and no <audio>, so most of this is the shape of a
// repair held against the source - the same reading tests/menu-keyboard.js and
// tests/font-tokens.js take. One of them runs for real, because it is
// arithmetic: clock().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, JS, read } from './helpers.js';
import { clock } from '../web/assets/js/media/transport.ts';

const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = rel => code(read(join(JS, rel)));
const sheet = name => read(join(WEB, 'assets', 'css', name)).replace(/\/\*[\s\S]*?\*\//g, '');

test('the clock never reads NaN', () => {
  // `Math.max(0, Math.floor(NaN))` is NaN, so the clamp let one straight
  // through and the readout said "NaN:NaN". A duration is NaN until the
  // metadata arrives, and ui/playlist.ts guards it with `typeof === 'number'`,
  // which NaN passes.
  assert.equal(clock(Number.NaN), '0:00');
  assert.equal(clock(Number.POSITIVE_INFINITY), '0:00');
  assert.equal(clock(-5), '0:00');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(61), '1:01');
  assert.equal(clock(599.9), '9:59');
});

test('every player reports a refused play instead of swallowing it', () => {
  // canvas/transport.ts argued this at length - "an empty catch is why 'the
  // cards are unplayable' once had nothing behind it in the console" - and then
  // kept its own copy, while the queue, the playlist window, the now-playing
  // bar and canvas/audio.ts all used an empty catch. Pressing Play on the
  // playlist hero with autoplay blocked did nothing at all, silently, on the
  // one path every playlist press takes.
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
  // One track can play through two elements over its life: the queue's shared
  // <audio> while the card is culled, and the card's own once it mounts.
  // show() returned early on an unchanged item, so the bar kept its rAF, its
  // seekTo and its listeners on the element the exclusivity rule had just
  // paused - drawing 0:00 and showing Play while sound came out of the other.
  const s = src('ui/nowplaying.ts');
  assert.match(s, /if \(current\.item === shown && current\.el === boundEl\) return;/,
    'show() compares only the item again');
  assert.match(s, /let boundEl: HTMLMediaElement \| null = null;/,
    'the bar no longer records which element it is driving');
  assert.match(s, /boundEl = null;/, 'teardown() leaves boundEl set');
});

test('a frozen GIF gives its blob back when the card is discarded', () => {
  // A blob URL is an entry in the document's URL store, not a property of the
  // node - so throwing the node away threw away the string and left the blob
  // for the life of the tab. The module header argued the opposite.
  assert.match(src('canvas/stills.ts'), /export function releaseStills\(el: Element\)/,
    'releaseStills() is gone');
  assert.match(src('canvas/stills.ts'), /URL\.revokeObjectURL\(twin\._stillUrl\)/,
    'releaseStills() no longer revokes anything');
  assert.match(src('canvas/items.ts'), /releaseStills\(el\);/,
    'discard() stopped releasing frozen frames');
});

test('a discarded audio card stops listening to the selection', () => {
  // The per-card subscription unsubscribed only from inside its own handler, so
  // a board panned past and then left alone kept one live closure per card -
  // each holding the wave, the item, the element and the detached strip.
  assert.match(src('canvas/transport.ts'), /export function releaseTransports\(el: Element\)/,
    'releaseTransports() is gone');
  assert.match(src('canvas/items.ts'), /releaseTransports\(el\);/,
    'discard() stopped unsubscribing transports');
});

test('the still sweep is not guarded on a count that misses a swap', () => {
  // `world.childElementCount === mounted` is the wrong question asked cheaply:
  // a pan across a large board mounts and discards in the same pass, so the
  // count is often unchanged while the set is not - and a GIF that arrived in
  // one of those passes kept animating with is-stilled on.
  const s = src('canvas/stills.ts');
  assert.ok(!/childElementCount === mounted/.test(s),
    'the sweep is back to guarding on the mounted count');
  assert.match(s, /sweep = requestAnimationFrame/,
    'the sweep is no longer coalesced to a frame');
});

test('a deleted current track advances rather than restarting the queue', () => {
  // indexOf answers -1 for a track that has gone, and writing that into
  // queuePos made the next `ended` read `-1 >= length - 1` as false, step to 0
  // and play the *first* track.
  const s = src('canvas/playlist-queue.ts');
  assert.match(s, /if \(idx >= 0\) \{/,
    'rebuildOrder() writes indexOf() into queuePos again');
  // ...and a track whose bytes have gone is skipped rather than stalling the
  // queue in silence with no repaint.
  assert.match(s, /function startCurrent\(skips = 0\)/,
    'startCurrent() no longer counts what it has skipped');
  assert.match(s, /startCurrent\(skips \+ 1\);/,
    'a missing asset stalls the queue again');
});

test('a marked line keeps its mark through a split and a paste', () => {
  // buildNoteLine({tag, align, text}) copied alignment and nothing else, so
  // pressing Enter in the middle of a marked line left the second half
  // unmarked - a mark drawn across a sentence came apart where it was typed.
  const s = src('canvas/notes.ts');
  const builds = s.match(/buildNoteLine\(\{[\s\S]*?\}\)/g) || [];
  const fromLine = builds.filter(b => b.includes('align: lineAlign('));
  assert.ok(fromLine.length >= 2,
    'the split and the paste no longer build their new line from the current one');
  for (const b of fromLine) {
    assert.ok(b.includes('wash: lineWash('),
      `a line is rebuilt without its mark: ${b.slice(0, 60)}`);
  }
});

test('the marker menu marks the lines that were selected when it opened', () => {
  // The menu takes focus and ui/menu.ts closes it - handing focus back to the
  // contenteditable - *before* running the row's action. A setWash that
  // resolved the selection at that point resolved it against a caret the
  // hand-back had left: three lines selected, one line marked.
  const s = src('canvas/notes.ts');
  assert.match(s, /setWash\(wash: NoteWash \| null, lines: Element\[\]\): void;/,
    'setWash() no longer takes the lines it is to mark');
  assert.match(s, /const lines = api\.linesNow\(\);/,
    'the marker button no longer reads the selection before opening its menu');
});

test('the note colour no longer collides with the whimsy multiplier', () => {
  // tokens.css has owned --wash since long before as `1 / 1.4 / 0`, consumed by
  // base.css as `calc(3% * var(--wash))`, and it is in the look allowlist - so
  // a .mbrd carrying a --wash of "red" painted every unmarked marker chip red,
  // and the chip's own transparent fallback was unreachable behind an
  // inherited 1.
  const cards = sheet('cards.css');
  assert.match(cards, /\[data-wash="amber"\]\s*\{ --note-wash:/,
    'cards.css is back to defining --wash as a colour');
  assert.ok(!/--wash:/.test(cards), 'cards.css still declares --wash somewhere');
  // ...and nothing reads it as a colour any more. base.css's arithmetic is the
  // one true consumer and stays.
  for (const name of ['cards.css', 'timeline.css']) {
    assert.ok(!/var\(--wash[,)]/.test(sheet(name)),
      `${name} reads --wash as a colour again - it is a number`);
  }
  // The multiplier itself is untouched: tokens.css declares it and base.css
  // does arithmetic with it, which is the meaning that was there first.
  assert.match(sheet('base.css'), /calc\(3% \* var\(--wash\)\)/,
    'the whimsy ornament multiplier lost its one consumer');
});
