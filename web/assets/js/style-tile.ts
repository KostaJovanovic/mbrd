// What a style tile says about a board: which pictures, which pigments, which
// faces. Not how any of it is drawn.
//
// This used to live inside ui/snapshot.js, because a style tile used to be a
// picture you saved - a 1500x1000 canvas, a PNG, a download. It is a card on
// the board now, which moved the drawing into canvas/renderers.js and left this
// behind as the part both of them were really about: the three choices the
// feature has to make before anything is drawn at all.
//
// So it sits here rather than under canvas/ or ui/, and the reason is the
// layering rule in CONTRIBUTING.md rather than tidiness. The renderer is in
// canvas/ and canvas/ may not import from ui/; the tests import it with no
// document at all. A pure module below both is the only place all three callers
// can reach.
//
// Nothing here touches the DOM except through readToken(), which answers ''
// without a document - see tilePalette(). That is what lets tests/style-tile.test.js
// ask which pictures a board would show in a runner that cannot open a canvas,
// which is the half of this feature that has real rules in it.

import { readToken } from './util.ts';
import { board } from './board-model.ts';
import type { Item } from './board-model.ts';
import { PALETTE_TOKENS } from './layout-settings.ts';

/**
 * How many pictures a tile shows, at most.
 *
 * Three now rather than the four the printed tile carried. A card on a board is
 * a couple of hundred units across and the strip is a band inside it, so a
 * fourth picture buys a narrower crop of each rather than more of the board -
 * and the board itself is right there behind the card, which is the whole
 * reason this needs fewer than a page sent to somebody did.
 */
export const TILE_IMAGES = 3;

/**
 * The hash whose pixels stand for an item.
 *
 * The same rule the board export uses: an image is its own preview where it has
 * one (a document card's asset is the original file), and anything else offers
 * whatever picture it carries.
 */
const hashAt = (meta: Item['meta'], key: string): string | null =>
  typeof meta?.[key] === 'string' ? meta[key] : null;
export const pixelHash = (it: Item): string | null =>
  it.type === 'image' ? (hashAt(it.meta, 'preview') || it.asset?.hash || null)
  : (hashAt(it.meta, 'cover') || hashAt(it.meta, 'shot') || null);

/**
 * The pictures a tile shows: the selection if there is one, else the largest.
 *
 * `selected` is passed in rather than read here, because this is drawn from two
 * places - a command that knows what is selected, and a test that has no
 * selection at all - and reaching for the live set would make the second
 * impossible to write.
 *
 * A selection with no pictures in it falls through to the board. Three notes
 * selected is not a curation of pictures, and honouring it literally would make
 * a tile with an empty strip - which reads as the feature being broken rather
 * than as the selection being the wrong one.
 */
export function tilePictures(selected: Set<string> | null): Item[] {
  const pictures = board.items.filter(it => it.type === 'image' && pixelHash(it));
  const picked = selected && selected.size
    ? pictures.filter(it => selected.has(it.id))
    : [];
  const pool = picked.length ? picked : pictures;
  // Largest first, then by id, so a board of identically sized cards produces
  // the same tile twice rather than shuffling.
  return [...pool]
    .sort((a, b) => (b.w * b.h) - (a.w * a.h) || (a.id < b.id ? -1 : 1))
    .slice(0, TILE_IMAGES);
}

/**
 * The board's pigments, in the order tokens.css declares them.
 *
 * Empty without a document, because reading a token is a getComputedStyle and
 * there is nothing to compute a style against. That is not defensive padding:
 * it is what lets styleTileContents() below be asked *which pictures* in a
 * runner, which is the half of this feature that has real rules in it.
 *
 * The card does not draw from these values. It names the tokens and lets the
 * stylesheet resolve them, so a tile follows the palette being changed under it
 * rather than freezing the colours it was made with - see the style-tile
 * renderer. This is here for what wants the numbers rather than the colours:
 * the tests, and anything that later prints them.
 */
export function tilePalette(): { token: string, value: string }[] {
  const out: { token: string, value: string }[] = [];
  // The load-bearing line, not a defensive one: readToken() is a
  // getComputedStyle and there is nothing to compute against in a runner. This
  // is what lets styleTileContents() be asked which *pictures* a board would
  // show by a test that cannot open a document - see tests/style-tile.test.js.
  if (typeof document === 'undefined') return out;
  for (const token of PALETTE_TOKENS) {
    const value = readToken(token);
    if (value) out.push({ token, value });
  }
  return out;
}

/**
 * The face a token resolves to, as a person would name it.
 *
 * A font stack is a list of fallbacks, and printing the whole of it would fill
 * the card with commas. The first entry is the one that was chosen; the quotes
 * come off because they are CSS syntax rather than part of the name.
 */
export function faceName(token: string): string {
  const first = (readToken(token) || '').split(',')[0] || '';
  return first.replace(/["']/g, '').trim();
}

/** What a tile would show, without drawing one. Exported for the tests. */
export const styleTileContents = (selected: Set<string> | null = null) => ({
  pictures: tilePictures(selected),
  palette: tilePalette(),
});
