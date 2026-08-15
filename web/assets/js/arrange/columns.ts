// Shortest-column-first packing: the rule two masonries share.
//
// Drop each box into the column that has the least in it so far, leftmost when
// two are level, and fill that column down by the box's height plus a gap. Four
// lines of idea, and the app had it written out twice.
//
// ── Why one function and not two ──
//
// arrange/arrangements.ts's `masonry` lays the board out in world space, and
// ui/feed.ts's feedMasonry() lays the Feed out in screen pixels. layout.ts's own
// comment on the Mobile-to-Desktop pack said they "were written from each
// other", and used that to call the result "the one arrangement that can
// honestly be called the same board". They had drifted by then, in three ways,
// and only one of the three was deliberate:
//
//   - the Feed lets a tile span several columns; the board's masonry has no
//     spanning at all
//   - the Feed treats columns within half a pixel as level; the board's masonry
//     wants a strict win
//   - the Feed's columns are all one width; the board's are each as wide as the
//     widest card that chose them
//
// The third is a real difference between the two surfaces - a wall of tiles has
// a column width, a board of cards does not - and it stays in the callers, which
// is why this function answers in *columns and tops* rather than in x and y. The
// first two are parameters now, so the difference between the two packs is a
// pair of arguments you can read rather than two loops you have to diff.
//
// ── What it is not ──
//
// Not an arrangement. arrange/arrangements.ts is a table of pure
// `(items, opts) => [{x, y}]` and this is a floor underneath one of its
// entries - it knows nothing about items, geometry, spacing in world units or
// where the block is centred. Keeping it out of that file is what lets ui/feed.ts
// use it without reaching for the arrangement engine.
//
// Pure, and it holds no state between calls: the same boxes in the same order
// pack the same way every time, which is what stops a wall reshuffling itself
// when nothing about it has changed.

/**
 * One box to place. Only its height and how many columns it wants.
 *
 * `span` is optional and clamped rather than trusted, because the one caller
 * that uses it computes it from a stored fraction of the wall - see spanFor() in
 * ui/feed.ts, and the note there about a default that means different things
 * depending on the type carrying it.
 */
export type ColumnBox = { h: number; span?: number };

/** Where one box landed: its first column, and the line it starts on. */
export type ColumnSpot = { col: number; top: number };

export type PackColumnsOptions = {
  /** How many columns there are. Anything under one is treated as one. */
  cols: number;
  /** The space left below each box before the next one in that column. */
  gap?: number;
  /**
   * How much shorter a column must be to be preferred over one further left.
   *
   * Zero is a strict win and is the board's masonry. The Feed uses half a pixel,
   * because its heights are pixel arithmetic off measured elements and two
   * columns that differ in the eighth decimal place are level to anybody looking
   * at them - without it a full-width tile wanders off x = 0 between layouts.
   */
  tolerance?: number;
};

export type ColumnPack = {
  /** One spot per box, in the order the boxes were given. */
  spots: ColumnSpot[];
  /** Where each column has reached, including the gap below the last box. */
  heights: number[];
  /** The tallest column with that trailing gap taken back off. */
  height: number;
};

/**
 * Pack boxes into columns, shortest first.
 *
 * A box wanting more than one column takes a *run* of adjacent ones and starts
 * below every column in that run, since it has to clear all of them; the run
 * chosen is the one whose tallest column is lowest. Every column the box covers
 * is then filled to the same line, or the next box would tuck under a wide one
 * and overlap it.
 *
 * For a box of one column - which is every box in the board's masonry, and every
 * tile on the Feed but a hint - the run is that column and the two rules
 * collapse to the plain one.
 */
export function packColumns(boxes: ColumnBox[], opts: PackColumnsOptions): ColumnPack {
  const cols = Math.max(1, Math.floor(opts.cols) || 1);
  const gap = opts.gap || 0;
  const tolerance = opts.tolerance || 0;

  const heights: number[] = new Array(cols).fill(0);
  const spots: ColumnSpot[] = [];

  for (const box of boxes) {
    const span = Math.min(cols, Math.max(1, Math.floor(box.span ?? 1) || 1));
    // The best run of `span` adjacent columns: the one whose tallest column is
    // lowest. Ties go to the leftmost, which is what `top < best - tolerance`
    // says - a column further right has to actually win, not merely match.
    let col = 0;
    let best = Infinity;
    for (let i = 0; i + span <= cols; i++) {
      let top = heights[i];
      for (let k = i + 1; k < i + span; k++) if (heights[k] > top) top = heights[k];
      if (top < best - tolerance) { best = top; col = i; }
    }
    spots.push({ col, top: best });
    for (let i = col; i < col + span; i++) heights[i] = best + box.h + gap;
  }

  return { spots, heights, height: Math.max(0, ...heights) - gap };
}
