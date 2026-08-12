// The sticker catalogue: what shapes exist, what they are called, what colour
// each one is born.
//
// A plain array, hand-written, and deliberately not generated - which is worth
// being precise about, because the sprite it names *is* generated
// (tools/gen-stickers.mjs, out of Phosphor). The split is between the drawings
// and the decisions. Which glyph a shape is drawn as is upstream's business;
// which forty-five are worth having, what to call each one here, which of them
// a person will look for under "Marks" and what colour it is born - none of
// that falls out of anything, and none of it is Phosphor's to say.
//
// So adding a shape is two edits: an entry here, and an entry in the generator's
// own SHAPES table, which is where the Phosphor name and weight live. Run the
// generator; nothing else. tests/stickers.test.js checks the two lists hold the
// same ids in both directions, which is what stops one of them drifting.
//
// The ids are mbrd's rather than Phosphor's, and that is load-bearing: an id
// here is written into a .mbrd as meta.shape (see research/docs/mbrd-format.md), so it
// is part of the file format and cannot move because an upstream icon was
// renamed.
//
// **The tint is part of the entry**, and that is the one thing here that is
// not obvious. Notes cycle NOTE_TINTS as they are made, so the colour is a
// property of the run rather than of the note; a sticker is born the colour it
// looked in the window - the heart red, the star gold, the bolt yellow -
// because you picked *that* sticker and not a shape you then had to colour in.
// The palette is still an override (the item menu changes it), but it is an
// override rather than a lottery.
//
// Every shape is tintable and any shape can be set to any tint, which is a
// constraint on --sticker-1..8 rather than on this file: the tint is the *ink*
// a shape is drawn in, so it has to hold a seven-unit line against a pale
// photograph across all forty-five of them.

/** The sprite each `id` below names a `<symbol>` in. */
export const STICKER_SPRITE = 'assets/stickers.svg';

/**
 * The box every shape in that sprite is drawn to - Phosphor's 256 grid.
 *
 * Named here because five places build a `<svg class="sticker-art">` around a
 * `<use>` and every one of them has to set it: the board, the pad, the pad's
 * drag ghost, a Mobile feed tile and the bin. A `<symbol>` carries its own
 * viewBox, but the wrapper needs one too or the shape arrives at its authored
 * size instead of filling the box it was given - and five literals is five
 * chances for one of them to be left behind when the grid changes, which it
 * just did (the shapes were drawn to 100 before they were Phosphor's).
 */
export const STICKER_VIEWBOX = '0 0 256 256';

/**
 * How many tints the pad comes in - see --sticker-1..8 in tokens.css.
 *
 * Read by anything that has to hold a tint to the set that exists: the item
 * menu's colour row, and the guard on meta.tint arriving from a .mbrd.
 */
export const STICKER_TINTS = 8;

/**
 * What to call each of them, in order, for the item menu's colour row.
 *
 * Names rather than swatches, and in the same order as --sticker-1..8 - the
 * menu is a list of words and a row of eight coloured dots in it would be a
 * palette pretending to be a menu. The words have to match what the tokens
 * actually are, which is the one thing here that can drift; the test that they
 * are the same length is in tests/stickers.test.js.
 */
export const STICKER_TINT_NAMES = [
  'Red', 'Amber', 'Terracotta', 'Sienna', 'Olive', 'Moss', 'Ink', 'Faded',
];

/**
 * The categories, in the order the window shows them.
 *
 * Held here rather than derived from the entries so the order is a decision
 * rather than an accident of what was typed first, and so a category can be
 * renamed in one place. The window draws one heading per entry and everything
 * filed under it; at forty-five shapes that is a single scrolling grid and
 * wants no filter field, which is roughly the point at which this list would
 * have to grow one.
 */
export const STICKER_CATEGORIES: [key: string, label: string][] = [
  ['marks', 'Marks'],
  ['punctuation', 'Punctuation'],
  ['arrows', 'Arrows'],
  ['flags', 'Flags & pins'],
  ['faces', 'Faces & hands'],
  ['talk', 'Talk'],
  ['bits', 'Weather & bits'],
];

/**
 * One entry in the catalogue.
 *
 * `id` is the `<symbol>` id in the sprite, minus nothing - it is written into
 * a `<use href>` verbatim, so a typo here is a hole where the shape was and no
 * console warning to say so. `name` is what the trash, the item name and the
 * window's tooltip show. `keys` are extra words to find it by; the window has
 * no filter field yet and they cost nothing to carry until it does.
 */
export type Sticker = {
  id: string;
  name: string;
  /** Which of --sticker-1..8 it is born in; 1..STICKER_TINTS. */
  tint: number;
  /** The key of one of STICKER_CATEGORIES. */
  cat: string;
  keys: string;
};

/** Every sticker, in the order the window shows them within a category. */
export const STICKERS: Sticker[] = [
  // ---- marks ----
  { id: 's-star', name: 'Star', tint: 2, cat: 'marks', keys: 'favourite best top' },
  { id: 's-star-four', name: 'Four-point star', tint: 2, cat: 'marks', keys: 'favourite sparkle shine' },
  { id: 's-sparkle', name: 'Sparkle', tint: 2, cat: 'marks', keys: 'shine new magic' },
  { id: 's-heart', name: 'Heart', tint: 1, cat: 'marks', keys: 'love like' },
  { id: 's-heart-break', name: 'Broken heart', tint: 1, cat: 'marks', keys: 'love sad split' },
  { id: 's-check', name: 'Check', tint: 5, cat: 'marks', keys: 'tick done yes ok' },
  { id: 's-cross', name: 'Cross', tint: 1, cat: 'marks', keys: 'no wrong delete x' },
  { id: 's-plus', name: 'Plus', tint: 5, cat: 'marks', keys: 'add more and' },
  { id: 's-asterisk', name: 'Asterisk', tint: 4, cat: 'marks', keys: 'footnote star note' },
  { id: 's-dot', name: 'Dot', tint: 7, cat: 'marks', keys: 'bullet point circle' },
  { id: 's-eye', name: 'Eye', tint: 3, cat: 'marks', keys: 'look see watch notice' },

  // ---- punctuation ----
  { id: 's-exclamation', name: 'Exclamation', tint: 1, cat: 'punctuation', keys: 'important bang' },
  { id: 's-warning', name: 'Warning', tint: 1, cat: 'punctuation', keys: 'careful danger alert' },
  { id: 's-question', name: 'Question', tint: 3, cat: 'punctuation', keys: 'unsure ask why' },
  { id: 's-question-circle', name: 'Query', tint: 4, cat: 'punctuation', keys: 'unsure ask help what' },
  { id: 's-ellipsis', name: 'Ellipsis', tint: 7, cat: 'punctuation', keys: 'dots more pause' },

  // ---- arrows ----
  { id: 's-arrow', name: 'Arrow', tint: 7, cat: 'arrows', keys: 'point right this way' },
  { id: 's-arrow-curved', name: 'Curved arrow', tint: 3, cat: 'arrows', keys: 'point bend' },
  { id: 's-arrow-corner', name: 'Corner arrow', tint: 3, cat: 'arrows', keys: 'point turn elbow' },
  { id: 's-arrow-double', name: 'Double arrow', tint: 3, cat: 'arrows', keys: 'both ways swap' },
  { id: 's-arrow-circular', name: 'Circular arrow', tint: 5, cat: 'arrows', keys: 'again repeat loop redo' },

  // ---- flags and pins ----
  { id: 's-pin', name: 'Pin', tint: 1, cat: 'flags', keys: 'place location here' },
  { id: 's-pushpin', name: 'Pushpin', tint: 1, cat: 'flags', keys: 'tack fix stick' },
  { id: 's-flag', name: 'Flag', tint: 1, cat: 'flags', keys: 'mark claim' },
  { id: 's-ribbon', name: 'Medal', tint: 4, cat: 'flags', keys: 'award prize rosette ribbon' },
  { id: 's-bookmark', name: 'Bookmark', tint: 4, cat: 'flags', keys: 'save later read' },
  { id: 's-tag', name: 'Tag', tint: 2, cat: 'flags', keys: 'label price name' },

  // ---- faces and hands ----
  { id: 's-smile', name: 'Smile', tint: 2, cat: 'faces', keys: 'happy good yes' },
  { id: 's-frown', name: 'Frown', tint: 3, cat: 'faces', keys: 'sad bad no' },
  { id: 's-wink', name: 'Wink', tint: 2, cat: 'faces', keys: 'joke sly' },
  { id: 's-neutral', name: 'Straight face', tint: 8, cat: 'faces', keys: 'meh flat unsure' },
  { id: 's-thumb-up', name: 'Thumbs up', tint: 5, cat: 'faces', keys: 'yes good approve' },
  { id: 's-thumb-down', name: 'Thumbs down', tint: 1, cat: 'faces', keys: 'no bad reject' },

  // ---- talk ----
  { id: 's-speech', name: 'Speech bubble', tint: 7, cat: 'talk', keys: 'say quote comment' },
  { id: 's-thought', name: 'Thought bubble', tint: 6, cat: 'talk', keys: 'think idea wonder' },
  { id: 's-banner', name: 'Banner', tint: 1, cat: 'talk', keys: 'title ribbon headline' },

  // ---- weather and bits ----
  { id: 's-lightning', name: 'Lightning', tint: 2, cat: 'bits', keys: 'bolt fast power' },
  { id: 's-flame', name: 'Flame', tint: 1, cat: 'bits', keys: 'fire hot burn' },
  { id: 's-cloud', name: 'Cloud', tint: 8, cat: 'bits', keys: 'weather sky soft' },
  { id: 's-sun', name: 'Sun', tint: 2, cat: 'bits', keys: 'weather bright day' },
  { id: 's-moon', name: 'Moon', tint: 4, cat: 'bits', keys: 'night sleep dark' },
  { id: 's-crown', name: 'Crown', tint: 2, cat: 'bits', keys: 'king best win' },
  { id: 's-skull', name: 'Skull', tint: 7, cat: 'bits', keys: 'dead danger poison' },
  { id: 's-gem', name: 'Diamond', tint: 3, cat: 'bits', keys: 'gem jewel precious' },
  { id: 's-leaf', name: 'Leaf', tint: 5, cat: 'bits', keys: 'plant nature green' },
];

/** Shapes by id, so a `meta.shape` off a .mbrd can be checked in one lookup. */
const byShape = new Map(STICKERS.map(s => [s.id, s]));

/**
 * The catalogue entry for a shape id, or null.
 *
 * The gate every `meta.shape` arriving from a file goes through. A .mbrd is
 * something anybody can edit by hand and the value ends up inside a `<use
 * href>`, so an unknown id is refused here rather than written into the DOM to
 * silently draw nothing - the renderer falls back to the first shape and the
 * card is a sticker rather than a hole.
 */
export const stickerShape = (id: unknown): Sticker | null =>
  (typeof id === 'string' ? byShape.get(id) : undefined) || null;

/** The shape a sticker with no usable `meta.shape` comes out as. */
export const DEFAULT_SHAPE = STICKERS[0].id;

/**
 * A tint held to the palette that exists: an integer in 1..STICKER_TINTS, or
 * the shape's own default when the value is missing or nonsense.
 */
export function stickerTint(value: unknown, shapeId: unknown): number {
  const n = Math.trunc(Number(value));
  if (Number.isFinite(n) && n >= 1 && n <= STICKER_TINTS) return n;
  return stickerShape(shapeId)?.tint || 1;
}
