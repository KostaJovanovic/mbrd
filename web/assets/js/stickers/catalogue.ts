// Sticker catalogue: what shapes exist, their names, categories, and born tint.
// Hand-written; the sprite is generated (tools/gen-stickers.mjs). Ids are part
// of the .mbrd format and must not change. Adding a shape: one entry here, one
// in the generator's SHAPES table, then run the generator.

export const STICKER_SPRITE = 'assets/stickers.svg';

/** Phosphor's 256-unit grid; shared by the five places that draw a sticker. */
export const STICKER_VIEWBOX = '0 0 256 256';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an `<svg class="sticker-art"><use href="...#shape">` element. */
export function stickerArt(shape: string, extra = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', extra ? `sticker-art ${extra}` : 'sticker-art');
  svg.setAttribute('viewBox', STICKER_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${STICKER_SPRITE}#${shape}`);
  svg.append(use);
  return svg;
}

/** Number of tints (--sticker-1..8 in tokens.css). */
export const STICKER_TINTS = 8;

/** Names for --sticker-1..8, in order. */
export const STICKER_TINT_NAMES = [
  'Red', 'Amber', 'Terracotta', 'Sienna', 'Olive', 'Moss', 'Ink', 'Faded',
];

/** Categories in display order. */
export const STICKER_CATEGORIES: [key: string, label: string][] = [
  ['marks', 'Marks'],
  ['punctuation', 'Punctuation'],
  ['arrows', 'Arrows'],
  ['flags', 'Flags & pins'],
  ['faces', 'Faces & hands'],
  ['talk', 'Talk'],
  ['bits', 'Weather & bits'],
];

/** One catalogue entry. `id` is a `<symbol>` id in the sprite and a .mbrd value. */
export type Sticker = {
  id: string;
  name: string;
  tint: number;
  cat: string;
  keys: string;
};

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

const byShape = new Map(STICKERS.map(s => [s.id, s]));

/** Look up a shape id. Unknown ids return null; the renderer falls back. */
export const stickerShape = (id: unknown): Sticker | null =>
  (typeof id === 'string' ? byShape.get(id) : undefined) || null;

export const DEFAULT_SHAPE = STICKERS[0].id;

/** Clamp to 1..STICKER_TINTS, falling back to the shape's default. */
export function stickerTint(value: unknown, shapeId: unknown): number {
  const n = Math.trunc(Number(value));
  if (Number.isFinite(n) && n >= 1 && n <= STICKER_TINTS) return n;
  return stickerShape(shapeId)?.tint || 1;
}
