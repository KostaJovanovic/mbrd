// The button's half of optimising: what it says before, during and after.
//
// Separate from optimize.js for the same reason ui/look.js is separate from
// ui/appearance.js - that one is the work and has no business knowing there is
// a screen, this one is the conversation and has no business knowing how a WebP
// is made.

import { ask } from '../ui/dialog.js';
import { toast, busy, formatBytes } from '../util.js';
import { discardOriginals, originalsHeld } from '../state.js';
import { planOptimize, runOptimize, describeSaving } from './optimize.js';
import { opusAvailable, OPUS_KBPS } from './opus.js';

/**
 * What the waiting strip calls each pass - what it is doing, and what one item
 * of it is called. Anything not listed is the main encoding pass.
 */
const PHASE = {
  thumbs: ['Making thumbnails', 'Thumbnail'],
  posters: ['Taking video stills', 'Video still'],
};
const MAIN = ['Optimizing', 'Optimizing'];

/**
 * Ask, run, and say what happened.
 *
 * The dialog is built out of the plan rather than out of a fixed sentence,
 * because the honest answer depends entirely on what is on the board: a board
 * of photographs and a board of one FLAC want different warnings, and a board
 * that has nothing worth touching should be told so instead of being asked a
 * question.
 */
export async function optimizeBoard() {
  const plan = planOptimize();
  const counts = [
    [plan.pictures.length, 'picture'],
    [plan.sounds.length, 'sound file'],
  ].filter(([n]) => n);

  if (!counts.length && !plan.posters && !plan.empty.length) {
    // Two different nothings, and telling them apart is the difference between
    // "this is done" and "this button does not work".
    toast(plan.done
      ? `Already optimized - ${plan.done} file${plan.done === 1 ? '' : 's'}, nothing left to do`
      : 'There is nothing on this board to optimize');
    return;
  }

  const lines = counts.length
    ? [counts.map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ') +
        ` - ${formatBytes(plan.total)} in total.`]
    // A board with nothing to shrink but clips to take stills from, or empty
    // files to clear out. Said first and on its own, because otherwise the
    // dialog opens by listing zero files and then asks to be run anyway.
    : [plan.posters
        ? `Nothing on this board is worth shrinking, but ${plan.posters} ` +
          `video${plan.posters === 1 ? '' : 's'} ${plan.posters === 1 ? 'has' : 'have'} no still yet.`
        : 'Nothing on this board is worth shrinking, but there are empty files on it.'];

  if (plan.pictures.length) lines.push('Pictures are capped at 1200px and rewritten as WebP.');
  if (plan.sounds.length) {
    lines.push(opusAvailable()
      ? `Sound becomes Opus at ${OPUS_KBPS}k, keeping its tags and its album art.`
      : 'Sound is left alone - this browser has no Opus encoder.');
  }
  // Video is not optimised: shrinking a clip needs ffmpeg, and that is not worth
  // waking for a moodboard (see optimize.js). Say how many are being left alone,
  // so a count smaller than the board holds does not read as a bug.
  const skippedVideos = plan.skipped.filter(e => e.kind === 'video').length;
  if (skippedVideos && counts.length) {
    lines.push(`${skippedVideos} video${skippedVideos === 1 ? ' is' : 's are'} left as ` +
      `${skippedVideos === 1 ? 'it is' : 'they are'} - clips are not optimised.`);
  }
  // The one thing done *to* a video, and worth saying plainly because it is why
  // a phone shows a black box where a clip should be: the card has no picture
  // until the clip is played, and on a touch device it is not played until it
  // is tapped.
  if (plan.posters) {
    lines.push(`${plan.posters} clip${plan.posters === 1 ? '' : 's'} will have a still taken ` +
      'from the first frame, so the card shows something before it is played.');
  }
  // The one thing here that takes something away rather than making it smaller,
  // so it is said plainly and it says where what it takes ends up. The two
  // halves read differently on purpose: a card whose own file is empty has
  // nothing on it at all and goes, while a card that merely wears an empty
  // picture keeps everything else and only loses the picture.
  const goneCards = plan.empty.filter(e => e.asset).length;
  const goneCovers = plan.empty.filter(e => e.cover && !e.asset).length;
  if (goneCards) {
    lines.push(`${goneCards} card${goneCards === 1 ? '' : 's'} hold${goneCards === 1 ? 's' : ''} ` +
      `an empty file with nothing in it and will be thrown away - ` +
      `${goneCards === 1 ? 'it goes' : 'they go'} to the bin, and one undo brings ` +
      `${goneCards === 1 ? 'it' : 'them'} back.`);
  }
  if (goneCovers) {
    lines.push(`${goneCovers} card${goneCovers === 1 ? '' : 's'} will lose an empty picture ` +
      `and keep everything else.`);
  }
  // Said out loud rather than left as a smaller number than expected: a board
  // half of which has already been done should not look like half a board.
  if (plan.done) {
    lines.push(`${plan.done} more ${plan.done === 1 ? 'file has' : 'files have'} been optimized already and will be left alone.`);
  }
  // Only when something is actually being rewritten. A stills-only pass has no
  // originals to keep and nothing to take back - it adds a picture beside a
  // clip and changes no file on the board.
  if (counts.length) {
    lines.push('The originals stay here until you discard them, and one undo puts them back.');
  }

  const answer = await ask({
    title: 'Optimize this board',
    body: lines.join(' '),
    go: 'Optimize',
    cancel: 'Cancel',
  });
  if (answer !== 'go') return;

  // The waiting strip rather than a toast per file, which is what this was.
  // A toast is a receipt and this is a state: forty of them in a row was the
  // same sentence rewritten forty times, each one resetting its own dismissal
  // timer, and the count buried in a line of prose. See busy() in util.js.
  const job = busy('Optimizing');
  let report;
  try {
    report = await runOptimize({
      // Named as well as counted: the count says how long is left, the filename
      // says which one is taking it, and the phase says which pass it is on -
      // the two sweeps at the end are each their own pass over their own list,
      // so without that the bar would appear to run three times for no stated
      // reason.
      onProgress: ({ done, total, name, phase }) => {
        const [bare, one] = PHASE[phase] || MAIN;
        job.step(done, total);
        job.label(name ? `${one} - ${name}` : bare);
      },
    });
  } catch (err) {
    console.error('[mbrd] optimize failed:', err);
    toast('The board could not be optimized - nothing was changed', 'error');
    return;
  } finally {
    job.end();
  }
  toast(describeSaving(report));
}

/**
 * Let go of the originals.
 *
 * Its own question, and a plain one: this is the only part of the feature that
 * cannot be taken back, so it is never folded into the optimise itself.
 */
export async function discardOptimizeOriginals() {
  const held = originalsHeld();
  if (!held) {
    toast('There are no originals to discard');
    return;
  }
  const answer = await ask({
    title: 'Discard the originals?',
    body: `${held} file${held === 1 ? '' : 's'} still have their original version stored here. ` +
      'Discarding frees the space, and the optimisation can no longer be undone.',
    go: 'Discard',
    cancel: 'Keep them',
  });
  if (answer !== 'go') return;
  const n = discardOriginals();
  toast(`${n} original${n === 1 ? '' : 's'} released`);
}
