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

  if (!counts.length) {
    // Two different nothings, and telling them apart is the difference between
    // "this is done" and "this button does not work".
    toast(plan.done
      ? `Already optimized - ${plan.done} file${plan.done === 1 ? '' : 's'}, nothing left to do`
      : 'There is nothing on this board to optimize');
    return;
  }

  const lines = [
    counts.map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ') +
      ` - ${formatBytes(plan.total)} in total.`,
  ];
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
  if (skippedVideos) {
    lines.push(`${skippedVideos} video${skippedVideos === 1 ? ' is' : 's are'} left as ` +
      `${skippedVideos === 1 ? 'it is' : 'they are'} - clips are not optimised.`);
  }
  // Said out loud rather than left as a smaller number than expected: a board
  // half of which has already been done should not look like half a board.
  if (plan.done) {
    lines.push(`${plan.done} more ${plan.done === 1 ? 'file has' : 'files have'} been optimized already and will be left alone.`);
  }
  lines.push('The originals stay here until you discard them, and one undo puts them back.');

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
      // the thumbnail sweep at the end is its own pass over its own list, so
      // without that the bar would appear to run twice for no stated reason.
      onProgress: ({ done, total, name, phase }) => {
        job.label(phase === 'thumbs' ? 'Making thumbnails' : 'Optimizing');
        job.step(done, total);
        if (name) job.label(`${phase === 'thumbs' ? 'Thumbnail' : 'Optimizing'} - ${name}`);
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
