// The button's half of optimising: what it says before, during and after.
//
// Separate from optimize.js for the same reason ui/look.js is separate from
// ui/appearance.js - that one is the work and has no business knowing there is
// a screen, this one is the conversation and has no business knowing how a WebP
// is made.

import { ask } from '../ui/dialog.js';
import { toast, formatBytes } from '../util.js';
import { discardOriginals, originalsHeld } from '../state.js';
import { planOptimize, runOptimize, describeSaving } from './optimize.js';
import { loadMedia, mediaReady, MEDIA_MB } from './media.js';

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
    [plan.videos.length, 'video'],
  ].filter(([n]) => n);

  if (!counts.length) {
    toast('There is nothing on this board to optimize');
    return;
  }

  const media = plan.sounds.length + plan.videos.length;
  const lines = [
    counts.map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ') +
      ` - ${formatBytes(plan.total)} in total.`,
    'Pictures are capped at 1200px and rewritten as WebP.',
  ];
  if (media) {
    lines.push(mediaReady()
      ? 'Sound becomes Opus at 96k and video becomes WebM. Tags and album art are kept.'
      : `Sound and video need the media encoder (${MEDIA_MB} MB, kept on this machine). ` +
        'It downloads the first time only.');
  }
  lines.push('The originals stay here until you discard them, and one undo puts them back.');

  const answer = await ask({
    title: 'Optimize this board',
    body: lines.join(' '),
    go: 'Optimize',
    cancel: 'Cancel',
  });
  if (answer !== 'go') return;

  let encodeMedia = null;
  if (media) {
    try {
      encodeMedia = await loadMedia(msg => toast(msg));
    } catch (err) {
      console.warn('[mbrd] media encoder unavailable:', err);
      toast('Sound and video were left alone - the encoder could not be loaded', 'error');
    }
  }

  toast('Optimizing…');
  let report;
  try {
    report = await runOptimize({
      encodeMedia,
      // Named rather than counted: "12 of 40" says how long, and the filename
      // says which one is taking it.
      onProgress: ({ done, total, name }) => {
        if (done < total) toast(`Optimizing ${done + 1} of ${total}${name ? ` - ${name}` : ''}…`);
      },
    });
  } catch (err) {
    console.error('[mbrd] optimize failed:', err);
    toast('The board could not be optimized - nothing was changed', 'error');
    return;
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
