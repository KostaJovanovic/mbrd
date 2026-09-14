// Style tile data: which pictures, pigments, and faces a tile shows.
// Pure (no DOM except readToken, which returns '' without a document).
// Below both canvas/ and ui/ so both the renderer and the tests can reach it.

import { readToken } from './util.ts';
import { board } from './board-model.ts';
import type { Item } from './board-model.ts';
import { PALETTE_TOKENS } from './layout-settings.ts';

/** Max pictures in a tile. Three — a fourth only narrows the crop on a small card. */
export const TILE_IMAGES = 3;

/**
 * The tile's swatches, in the order they are drawn: two rows of four, the
 * paper side above the accents. Named in the tile's own words rather than
 * the tokens'. Tokens, not values, so the tile follows the palette.
 */
export const TILE_SWATCHES: readonly { token: string, name: string }[] = [
  { token: '--paper', name: 'paper' },
  { token: '--paper-card', name: 'card' },
  { token: '--ink', name: 'ink' },
  { token: '--ink-3', name: 'ink-3' },
  { token: '--rule', name: 'rule' },
  { token: '--accent', name: 'accent' },
  { token: '--accent-warm', name: 'warm' },
  { token: '--leafy', name: 'leafy' },
];

/** The asset hash that represents an item visually (preview > asset > cover > shot). */
const hashAt = (meta: Item['meta'], key: string): string | null =>
  typeof meta?.[key] === 'string' ? meta[key] : null;
export const pixelHash = (it: Item): string | null =>
  it.type === 'image' ? (hashAt(it.meta, 'preview') || it.asset?.hash || null)
  : (hashAt(it.meta, 'cover') || hashAt(it.meta, 'shot') || null);

/** Pick tile pictures: selected images if any have pixels, else largest on board.
 *  `selected` is passed in (not read from state) so tests can call this without a DOM. */
export function tilePictures(selected: Set<string> | null): Item[] {
  const pictures = board.items.filter(it => it.type === 'image' && pixelHash(it));
  const picked = selected && selected.size
    ? pictures.filter(it => selected.has(it.id))
    : [];
  const pool = picked.length ? picked : pictures;
  // Largest first, then by id for stability.
  return [...pool]
    .sort((a, b) => (b.w * b.h) - (a.w * a.h) || (a.id < b.id ? -1 : 1))
    .slice(0, TILE_IMAGES);
}

/** Resolved palette tokens. Empty without a document (getComputedStyle needs one).
 *  The tile card itself names tokens, not values, so it follows palette changes. */
export function tilePalette(): { token: string, value: string }[] {
  const out: { token: string, value: string }[] = [];
  if (typeof document === 'undefined') return out;
  for (const token of PALETTE_TOKENS) {
    const value = readToken(token);
    if (value) out.push({ token, value });
  }
  return out;
}

/** First face in a font-stack token, unquoted. */
export function faceName(token: string): string {
  const first = (readToken(token) || '').split(',')[0] || '';
  return first.replace(/["']/g, '').trim();
}

/** What a tile would show, without drawing one. Exported for the tests. */
export const styleTileContents = (selected: Set<string> | null = null) => ({
  pictures: tilePictures(selected),
  palette: tilePalette(),
});
