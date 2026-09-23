// Dynamic: the board's own pictures as its palette. Which pictures count,
// whether they changed, and the extraction run over them. The look model
// (ui/appearance.ts) hands in what it owns through initPicturePalette(), the
// shape LookDeps has, so this imports nothing from it and loads without a browser.

import { board } from '../state.ts';
import { autoPaletteReady } from '../layout-settings.ts';
import { oklch, parseHex } from '../color.ts';
import { toast } from '../notify.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import { shownHash } from '../board-model.ts';
import { extractPalette, samplePixels, MAX_SOURCES, ALL_SOURCES_MAX, PALETTE_TOKENS } from './pigments.ts';
import { autoOn } from './look.ts';
import type { Look } from './appearance-controls.ts';

/** What the look model lends. `current` is a getter: a board load replaces the look. */
export type PaletteDeps = {
  current: () => Look,
  setPigments: (vars: Record<string, string>) => void,
  dropPigments: () => boolean,
  persist: () => void,
  syncControls: () => void,
};

// Filled by initPicturePalette() before any use.
let d!: PaletteDeps;

/** Wire up the look-model deps. Called once at boot. */
export function initPicturePalette(deps: PaletteDeps) {
  d = deps;
}

// Collect picture hashes (newest first) for palette extraction.
// Hashes, not URLs — minting blob URLs here would defeat lazy asset loading.
function pictureHashes() {
  const hashes = [];
  for (const it of [...board.items].reverse()) {
    // shownHash() returns the preview for PDFs/HEIC/RAW, not the raw document.
    const hash = it.type === 'image' ? shownHash(it) : null;
    // meta.art is a link card's fetched album cover (canvas/embed-meta.ts): a
    // real picture on the board, so it feeds the palette like any other.
    for (const h of [hash, it.meta?.cover, it.meta?.art]) {
      if (typeof h === 'string' && getAsset(h)) hashes.push(h);
    }
  }
  return hashes;
}

// The cap on "all photos" lives with the sampler, which has to hold it too.
export { ALL_SOURCES_MAX };

// Slider stop for "all photos" — one past MAX_SOURCES; stored as 0.
export const ALL_SOURCES_STOP = MAX_SOURCES + 1;

// How many pictures to sample. 0 means all (capped at ALL_SOURCES_MAX).
export function sourceCount() {
  const n = board.paletteSources;
  if (n === 0) return ALL_SOURCES_MAX;
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_SOURCES, n)) : MAX_SOURCES;
}

// Comparable key for "would re-extraction give a different answer?"
function sourceKey(hashes = pictureHashes()) {
  return hashes.slice(0, sourceCount()).join('\n');
}

let lastSources: string | null = null;

let lastFailure: string | null = null;

/** Forget the last run, so the next ask extracts again. Starting over does this. */
export function forgetSources() {
  lastSources = null;
  lastFailure = null;
}

// True when the board is actually wearing extracted pigments (auto + inline tokens).
export const dynamicOn = () => autoOn(d.current()) && PALETTE_TOKENS.some(key => key in d.current().vars);

// Auto-recolour on item changes. Skips if source set unchanged.
export function autoRecolour() {
  if (!autoOn(d.current())) return;
  const hashes = pictureHashes();
  if (!autoPaletteReady(hashes.length, dynamicOn())) return;
  if (sourceKey(hashes) === lastSources) return;
  recolourFromBoard({ silent: true, hashes }).catch(() => {});
}

// Extract palette from board pictures. Silent on auto-success, loud on user request.
export async function recolourFromBoard(
  { silent = false, hashes = pictureHashes() }: { silent?: boolean, hashes?: string[] } = {},
) {
  // Slice before resolving URLs — only the sampled pictures get blob URLs.
  const urls = hashes.slice(0, sourceCount()).map(assetURL)
    .filter((u): u is string => !!u);
  // Record before reading — avoids re-running on boards with colourless pictures.
  lastSources = sourceKey(hashes);
  const failed = (why: string) => {
    if (!silent || lastFailure !== why) toast(why);
    lastFailure = why;
    return false;
  };
  // No minimum here (the floor is only for the auto path). Empty board drops pigments.
  if (!hashes.length) {
    if (d.dropPigments()) {
      d.persist();
      d.syncControls();
      return failed('The colours came from those pictures - back to your palette');
    }
    lastFailure = 'No pictures on the board to take colours from';
    if (!silent) toast(lastFailure);
    return false;
  }

  const pixels = await samplePixels(urls, sourceCount());
  console.info(`[mbrd] palette: ${hashes.length} picture${hashes.length === 1 ? '' : 's'} on the board, ${pixels.length} read`);
  if (!pixels.length) return failed(`Could not read ${urls.length === 1 ? 'the picture' : 'any of the pictures'} on the board`);

  const current = d.current();
  const vars = extractPalette(pixels, { tier: current.whimsy });
  if (!vars) return failed('No colour to take from these pictures');
  lastFailure = null;
  const hueOf = (c: string) => Math.round(oklch(...parseHex(c)).h);
  console.info(`[mbrd] palette: sheet ${vars['--paper']} (hue ${hueOf(vars['--paper'])}), `
    + `accent ${vars['--accent']} (hue ${hueOf(vars['--accent'])}), `
    + `wash ${vars['--leafy']} (hue ${hueOf(vars['--leafy'])})`);
  // Skip if hues unchanged — avoids marking the board dirty for nothing.
  const moved = Object.entries(vars).some(([k, v]) => current.vars[k] !== v);
  if (moved) d.setPigments(vars);
  if (!silent) toast('Palette taken from the pictures');
  return true;
}
