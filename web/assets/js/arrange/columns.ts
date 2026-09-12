// Shortest-column-first packing, shared by the board's masonry and the Feed wall.
// Answers in columns and tops, not x/y -- callers own the widths.
// Pure: same boxes in same order always pack identically.

/** One box: its height and optional column span (clamped, not trusted). */
export type ColumnBox = { h: number; span?: number };

/** Where a box landed: first column and top edge. */
export type ColumnSpot = { col: number; top: number };

export type PackColumnsOptions = {
  cols: number;
  gap?: number;
  /** 0 = strict win (board masonry). Feed uses ~0.5px to absorb rounding. */
  tolerance?: number;
};

export type ColumnPack = {
  spots: ColumnSpot[];
  heights: number[];
  /** Tallest column height (trailing gap excluded). */
  height: number;
};

/** Pack boxes into the shortest column. Multi-span boxes take the lowest run. */
export function packColumns(boxes: ColumnBox[], opts: PackColumnsOptions): ColumnPack {
  const cols = Math.max(1, Math.floor(opts.cols) || 1);
  const gap = opts.gap || 0;
  const tolerance = opts.tolerance || 0;

  const heights: number[] = new Array(cols).fill(0);
  const spots: ColumnSpot[] = [];

  for (const box of boxes) {
    const span = Math.min(cols, Math.max(1, Math.floor(box.span ?? 1) || 1));
    // Ties go to the leftmost column.
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
