// Where everything is: the two layout profiles, the Mobile pack, and every
// write to an item's geometry.
//
// Fourth concern out of state.js, and the one that had to come as a single
// piece however the audit listed it. "Mobile grid packing" and "layout and
// settings profiles" read as two things and are not: placeMobileItems() calls
// completeLayout()'s fitMobile, and completeLayout() calls placeMobileItems.
// Splitting them would have been two modules importing each other.
//
// What is here is everything that answers "where does this go":
//
//   the Mobile pack   a first-fit over a column grid, with stuck notes riding
//                     their host rather than taking a slot of their own
//   the profiles      Desktop and Mobile geometry per item, captured on the way
//                     out of a mode and completed on the way in
//   the geometry writes  snapshotGeom / applyGeom / commitGeom, the undoable
//                     triple every drag, nudge and arrange goes through
//
// The presnap memo comes with them (forgetPresnap, usableMemo). It is a
// geometry fact - where an item was before the lattice took it - and snapping
// is only its first caller.
//
// Nothing above state.js imports this: state.js re-exports what callers have
// always had. See board-store.js for why the floor is built this way.


import {
  itemBounds, latticeBox, cellInset, MIN_SIZE, MAX_SIZE,
} from './geometry.ts';
import { isRecord } from './util.ts';
import { splitAppearance } from './layout-settings.ts';
import { arrange, mobileArrangement, mobileOrder } from './arrange/arrangements.ts';
import { bus, markDirty } from './board-store.ts';
import { commit, clearHistory } from './history.ts';
import {
  board, byId, BOARD_MODES, DEFAULT_SETTINGS, MOBILE_TOP_ROWS,
  MOBILE_MIN_ROWS, MOBILE_BOTTOM_ROWS, mobileColumnCount,
  cloneSettings, layoutSettingsOf, settingsFor, defaultLayoutSettings,
} from './board-model.ts';
// Types only. These were imported while this module was still unchecked, on the
// rule that a @ts-nocheck suppresses the errors *in* a file without hiding its
// declarations, so the four signatures below could be annotated ahead of the
// rest of the file for board-schema.ts to read its geometry through. The file is
// annotated now; the import stands unchanged, which is what that bet was for.
import type { Geometry, Item, LayoutMode, ItemMeta } from './board-model.ts';
import type { Box } from './geometry.ts';

/**
 * The four numbers a presnap memo holds - where an item was before the lattice
 * took it. Its own name because three things pass one around: the memo on
 * `meta.presnap`, the copy on a Geometry, and usableMemo(), which is the only
 * thing that decides whether what came out of a file is one.
 */
export type Presnap = { x: number, y: number, w: number, h: number };

/**
 * One item's geometry as a snapshot carries it: the six fields GEOM_KEYS names,
 * the presnap memo, and the one flag that rides with a movement rather than
 * beside it - see snapshotGeom(), which explains why `loose` is in here.
 */
export type GeomSnap = {
  id: string,
  x: number, y: number, w: number, h: number, rot: number, z: number,
  presnap: Presnap | null,
  loose: boolean,
};

/**
 * What applyGeom() will write: an id, and any part of the above.
 *
 * Partial because that is what its callers hand it - geometry.ts's align and
 * distribute answer `{ id, x, y }` and nothing else, and applyGeom() merges
 * whatever it is given onto the live item rather than replacing it.
 *
 * `presnap` is `unknown` here rather than a memo, and deliberately: applyGeom()
 * puts every one it is given through usableMemo(), which is the only thing in
 * this file that decides whether four numbers are a memo. A caller carrying one
 * straight off an item's meta is holding whatever a file put there.
 */
export type GeomPatch =
  { id: string } & Partial<Omit<GeomSnap, 'id' | 'presnap'>> & { presnap?: unknown };
import {
  isRider, attachRiders, stuckPlacement, restick, stuckFollowers, startSettling,
  isPinned,
} from './sticky.ts';
import { isFence, refence, refenceAround, mobileRuns, fenceFollowers } from './fences.ts';

/** A geometry snapshot entry as a plain rectangle, for the containment tests. */
const boxOf = (g: { x: number, y: number, w: number, h: number, rot?: number }): Box =>
  ({ x: g.x, y: g.y, w: g.w, h: g.h, rot: g.rot || 0 });

/** The four fields snapping moves, and the four a presnap memo remembers. */
export const SNAP_KEYS = ['x', 'y', 'w', 'h'] as const;

const MOBILE_PACK_EPSILON = 1e-9;

/**
 * Half the space left around a card in the column, in world units.
 *
 * The lattice seam is always there - cellInset() is what keeps a card from
 * sitting flush on the grid lines it is laid between - and Mobile's `spacing`
 * is *added* to it rather than replacing it. So the gap between two neighbours
 * is `spacing + 2 * cellInset(step)`, and a Mobile board at spacing 0 is
 * exactly the board that shipped before the setting existed, which is the one
 * property worth keeping: turning a slider up must be the only way to change
 * a board that was already saved.
 *
 * Half, because a gap is shared: each of the two cards either side of it gives
 * up this much, the same arrangement CELL_GAP makes in geometry.js and for the
 * same reason - an item at the edge of the column then has the same margin as
 * one in the middle of it.
 */
function mobileSeam(step: number, spacing = 0) {
  return cellInset(step) + Math.max(0, spacing || 0) / 2;
}

/** Number of Mobile grid cells needed to contain one unrotated side. */
function mobileCellSpan(side: number, step: number, maximum = Number.POSITIVE_INFINITY, spacing = 0) {
  const seam = 2 * mobileSeam(step, spacing);
  return Math.min(
    Math.max(Math.ceil((side + seam) / step - MOBILE_PACK_EPSILON), 1),
    maximum,
  );
}

/** First full grid row below every item that is staying where it is. */
function mobilePackStartRow(obstacles: Item[], step: number) {
  const bounds = itemBounds(obstacles);
  if (!bounds) return 0;
  return Math.max(
    0,
    Math.ceil((MOBILE_TOP_ROWS * step - bounds.y0) / step - MOBILE_PACK_EPSILON),
  );
}

/** Compact row-major packing into the selected Mobile occupancy grid. */
export function packMobileGrid(
  items: Item[], obstacles: Item[], step: number, columns: number, spacing = 0,
): Item[] {
  const occupied = new Set<string>();
  const startRow = mobilePackStartRow(obstacles, step);
  const inset = mobileSeam(step, spacing);
  const open = (col: number, row: number, cols: number, rows: number) => {
    for (let y = row; y < row + rows; y++) {
      for (let x = col; x < col + cols; x++) {
        if (occupied.has(`${x}:${y}`)) return false;
      }
    }
    return true;
  };
  const claim = (col: number, row: number, cols: number, rows: number) => {
    for (let y = row; y < row + rows; y++) {
      for (let x = col; x < col + cols; x++) occupied.add(`${x}:${y}`);
    }
  };

  return items.map(item => {
    const cols = mobileCellSpan(item.w, step, columns, spacing);
    const rows = mobileCellSpan(item.h, step, Number.POSITIVE_INFINITY, spacing);
    let row = startRow;
    let col = 0;
    let found = false;
    while (!found) {
      for (col = 0; col <= columns - cols; col++) {
        if (open(col, row, cols, rows)) {
          found = true;
          break;
        }
      }
      if (!found) row++;
    }
    claim(col, row, cols, rows);
    const left = (-columns / 2 + col) * step;
    const top = (MOBILE_TOP_ROWS - row) * step;
    return {
      ...item,
      // Anchor the visible box, not its centre, to the cell seam. Centring an
      // off-lattice size inside its claimed span can leave either edge a pixel
      // across a grid or board rule; the top-left seam is deterministic and
      // keeps the whole box inside the cells it owns.
      x: left + inset + item.w / 2,
      y: top - inset - item.h / 2,
      rot: 0,
    };
  });
}

/**
 * A fence's Mobile geometry: a band across the whole column, one row deep.
 *
 * A fence is the one item that is not fitted to the column - it *is* the column.
 * Everything else keeps its proportions and is scaled down to fit; a region has
 * no proportions worth keeping, and a band narrower than the cards under it
 * would read as a card rather than as a heading over them.
 *
 * Sized to exactly the content width fitMobile() would allow, which is what
 * keeps that function free of a special case: with w already at the maximum, its
 * clamp is a no-op and its scale ratio is 1.
 */
function bandBox(fence: Item, step: number, columns: number, spacing: number): Item {
  const inset = mobileSeam(step, spacing);
  return {
    ...fence,
    w: Math.max(MIN_SIZE, mobileBoardWidth(step, columns) - 2 * inset),
    h: Math.max(MIN_SIZE, step - 2 * inset),
    rot: 0,
  };
}

/**
 * Pack a list into runs: a band across the column, then the cards it holds,
 * then the next band below all of them.
 *
 * The barrier is the whole point, and it is bought with no new machinery: each
 * run is packed against *everything already placed* as its obstacles, and
 * mobilePackStartRow() puts it on the first full row below the lowest of them.
 * So nothing in a later run can climb into a gap left in an earlier one, which a
 * plain first-fit over the whole column would do gladly - and a run that is not
 * contiguous is not a run.
 *
 * A board with no fences takes the first branch and packs exactly as it did
 * before any of this existed. That is deliberate: every board saved until now is
 * that board, and it must come back unchanged.
 *
 * The result is put back into the caller's order because placeMobileItems()
 * pairs its two packs by index.
 */
function packRuns(
  items: Item[], obstacles: Item[], step: number, columns: number, spacing: number,
): Item[] {
  const runs = mobileRuns(items);
  if (runs.length === 1 && !runs[0].band) {
    return packMobileGrid(items, obstacles, step, columns, spacing);
  }
  const placed: Item[] = [];
  const behind = [...obstacles];
  for (const run of runs) {
    if (run.band) {
      const [band] = packMobileGrid(
        [bandBox(run.band!, step, columns, spacing)], behind, step, columns, spacing);
      if (band) { placed.push(band); behind.push(band); }
    }
    const got = packMobileGrid(run.items, behind, step, columns, spacing);
    placed.push(...got);
    behind.push(...got);
  }
  const found = new Map(placed.map(item => [item.id, item]));
  return items.map(item => found.get(item.id)).filter((item): item is Item => !!item);
}

/**
 * Append items to Mobile as a compact selected-width grid without overlap.
 *
 * The incoming order still comes from the selected arrangement. Each item's
 * fitted dimensions become a rectangular cell span, then a row-major first-fit
 * search puts compatible spans beside one another before moving downward.
 * Existing items set the first available row, so imports and partial
 * rearrangements stay below content that was not part of the operation.
 *
 * Snapped and unsnapped geometry are packed separately. The snapped copy uses
 * the lattice's normal inset seam; its presnap memo therefore restores another
 * collision-free grid layout if the user later turns snapping off.
 *
 * `spacing` is the Mobile profile's own - zero on a board that has never been
 * asked for a gap, which is every board saved before the setting existed. It is
 * added to the seam on all four sides of every card and to the room each one
 * claims in the lattice; see mobileSeam().
 */
export function placeMobileItems(
  items: Item[],
  obstacles: Item[] = board.items,
  options: {
    step?: number, snap?: boolean, preserveSize?: boolean,
    columns?: number, spacing?: number,
  } = {},
): Item[] {
  const step = options.step && options.step > 0 ? options.step : baseStep();
  const snap = options.snap ?? board.settings.snap;
  const preserveSize = options.preserveSize === true;
  const columns = mobileColumnCount(options.columns ?? board.settings.mobileColumns);
  const spacing = Math.max(0, options.spacing ?? board.settings.spacing ?? 0);
  // Two kinds of card are never neighbours, and neither may set the first free
  // row - mobilePackStartRow() measures from the highest obstacle, so anything
  // left in this list that is not really in the way costs every import the rows
  // it stands in.
  //
  // The Desktop title card is not on this board at all. It has no Mobile
  // geometry, it is never rendered here (the masthead above the column is drawn
  // by canvas/mobile-frame.js and is not an item), and completeLayout() parks it
  // clear of the top edge. Left in, it pushed every import four or five rows
  // down; completeLayout() already takes it out of its own sweep.
  //
  // A hint is on the board, but it is leaving: the first real item to arrive
  // takes all four away (see canvas/ghosts.js). Counting them cost an import the
  // six rows they filled, and by the time the file was drawn the rows above it
  // were empty - a photograph dropped onto a blank phone board landed a screen
  // down from the top with nothing over it. They are packed as *items* when the
  // column is rebuilt (repackMobileBoard passes no obstacles at all), so this
  // does not strand them.
  obstacles = obstacles.filter(it => it.type !== 'title' && it.type !== 'ghost');
  const clean = (item: Item) => {
    const presnap = usableMemo(item.meta?.presnap);
    const { presnap: _oldPresnap, ...meta } = item.meta || {};
    const source = presnap ? { ...item, ...presnap } : item;
    return fitMobile({ ...source, meta, rot: 0 }, true, step, columns, spacing);
  };
  const rawItems = items.map(clean);
  const rawObstacles = obstacles.map((item: Item) => {
    const pre = usableMemo(item.meta?.presnap);
    return fitMobile(pre ? { ...item, ...pre } : item, false, step, columns, spacing);
  });
  const raw = packRuns(rawItems, rawObstacles, step, columns, spacing);
  if (!snap) return raw;

  const liveItems = preserveSize
    ? items.map((item: Item) => {
        const { presnap: _oldPresnap, ...meta } = item.meta || {};
        return fitMobile({ ...item, meta, rot: 0 }, true, step, columns, spacing);
      })
    : rawItems.map((item: Item) => {
        const box = latticeBox(item, step);
        return fitMobile({ ...item, w: box.w, h: box.h }, false, step, columns, spacing);
      });
  const liveObstacles = obstacles.map((item: Item) => fitMobile(item, false, step, columns, spacing));
  return packRuns(liveItems, liveObstacles, step, columns, spacing).map((item, index) => ({
    ...item,
    meta: {
      ...item.meta,
      presnap: {
        x: raw[index].x,
        y: raw[index].y,
        w: raw[index].w,
        h: raw[index].h,
      },
    },
  }));
}

/** Reflow the live Mobile board after its column count or its gap changes. */
export function repackMobileBoard() {
  if (!board.items.length) return;
  const ordered = [...board.items].sort((a, b) =>
    b.y - a.y || a.x - b.x || a.id.localeCompare(b.id));
  const before = snapshotGeom(ordered.map(item => item.id));
  // Stuck notes ride their host through a reflow instead of being repacked into
  // their own column slot; they keep their size and follow the host to its new
  // place. See attachRiders().
  // The Desktop title card is not part of the Mobile board at all: it is neither
  // packed into a column nor an obstacle for what is, and applyGeom below leaves
  // its geometry untouched (it never lands in `target`).
  const packable = ordered.filter(it => !isRider(it) && it.type !== 'title');
  const riders = ordered.filter(isRider);
  const target = new Map(placeMobileItems(packable, []).map(item => [item.id, item]));
  attachRiders(riders, target, (note, hostSrc, hostDst) => {
    const at = stuckPlacement(note, hostSrc, hostDst);
    return { ...note, x: at.x, y: at.y };
  });
  applyGeom(before.map(geometry => {
    const item = target.get(geometry.id);
    if (!item) return geometry;          // a rider whose host vanished: leave it
    return {
      ...geometry,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      rot: item.rot,
      // Through usableMemo() rather than spread raw: placeMobileItems() writes
      // exactly these four, and the memo is the only thing read back out.
      presnap: usableMemo(item.meta?.presnap),
    };
  }));
  commitGeom('Change Mobile grid width', before, ordered.map(item => item.id), {
    preservePresnap: true,
  });
}

/**
 * Whatever the lattice is measured in, with the fallback in one place.
 *
 * The *base* step, never the on-screen one. gridStep() in canvas/grid.js picks
 * a spacing from the zoom so the dots never become a fill, which is right for
 * something drawn and wrong for something stored - see snapAll() below.
 *
 * Exported because main.js's Rearrange lays the whole board out at once and has
 * to size the slots on the same lattice snapAll() would - and a second copy of
 * `gridStep > 0 ? gridStep : 64` in another file is how the two would come to
 * disagree about a board whose step is missing.
 */
export function baseStep() {
  return board.settings.gridStep > 0 ? board.settings.gridStep : 64;
}

const GEOM_KEYS = ['x', 'y', 'w', 'h', 'rot', 'z'] as const;

/**
 * The middle of all three geometry writers: fit the patched item to the live
 * board mode, then copy the keys that were asked for back onto it.
 *
 * Three loops in this file wrote geometry - writeLayout(), applyGeom() and
 * writeSnapState() - and all three had these two lines in the middle of them.
 * They differ in three ways that are all real and none of which is this: where
 * the patches come from, which keys they carry, and what each does about
 * presnap. So what is shared is the fit and the copy, and the loops keep their
 * own shapes rather than being folded into one function with three flags.
 *
 * fitBoardMode() is the load-bearing half. A patch is applied to a *copy* first
 * and the copy is what gets fitted, so an out-of-range value never lands on the
 * item even briefly - and on Mobile the fit is what holds a card to the column.
 */
function fitOnto(it: Item, patch: object, keys: readonly GeomKey[]): void {
  const next = fitBoardMode({ ...it, ...patch }) as Item;
  for (const key of keys) it[key] = next[key];
}

/**
 * The keys either list may name. Both are numbers, which is what lets one
 * assignment above serve both: widened to `keyof Item` the copy would be an
 * assignment between two unrelated union types and the checker would refuse it,
 * correctly - `it.meta = next.meta` is not a geometry write.
 */
type GeomKey = 'x' | 'y' | 'w' | 'h' | 'rot' | 'z';

/**
 * The presnap memo, written or forgotten. The other line all three shared.
 *
 * Copied rather than referenced: the memo comes off a snapshot that the history
 * stack is still holding, and an item pointing into it would let a later nudge
 * edit the undo entry that undoes it.
 */
function writePresnap(it: Item, presnap: Presnap | null | undefined): void {
  if (presnap) it.meta = { ...it.meta, presnap: { ...presnap } };
  else forgetPresnap(it);
}

/** The fixed width of the Mobile board in world units. */
export function mobileBoardWidth(
  step = baseStep(),
  columns = mobileColumnCount(),
) {
  return mobileColumnCount(columns) * step;
}

/**
 * The Mobile board's width read from the Mobile layout's own settings, whatever
 * layout is on screen.
 *
 * mobileBoardWidth() above answers for the *active* layout - its grid step and
 * its column count - which while Desktop shows is the Desktop grid and the
 * Desktop mobileColumns default (6, not the Mobile 8). The Desktop title card
 * needs the true Mobile figure: the masthead caps its font at 96px against this
 * width, so a card measuring 6x64=384 skipped the cap the 8x64=512 masthead
 * hits, ran its text larger, and wrapped sooner than the masthead. Read-only -
 * it does not touch the Mobile board. Same profile read repackMobileBoard makes.
 */
export function mobileBoardWorldWidth() {
  const profile = board.layoutSettings.mobile || defaultLayoutSettings('mobile');
  const step = profile.gridStep > 0 ? profile.gridStep : DEFAULT_SETTINGS.gridStep;
  return mobileColumnCount(profile.mobileColumns) * step;
}

/** The highest world-space edge of the Mobile board. */
export function mobileBoardTop(step = baseStep()) {
  return MOBILE_TOP_ROWS * step;
}

/**
 * The content-sized lower edge of the Mobile board.
 *
 * A new or sparse board is still twenty-five rows tall. Once an item reaches
 * below that minimum, the board grows just far enough to keep fifteen clear
 * rows beneath its lowest rendered edge.
 */
export function mobileBoardBottom(items = board.items) {
  const step = baseStep();
  const minimum = mobileBoardTop() - MOBILE_MIN_ROWS * step;
  const bounds = itemBounds(items);
  return bounds ? Math.min(minimum, bounds.y0 - MOBILE_BOTTOM_ROWS * step) : minimum;
}

/**
 * What geometryOf() will read: an Item, or one of the Geometry records this
 * file passes back through it (see completeLayout, which fits a saved record
 * and then re-reads it). `meta` is optional because a Geometry carries none.
 */
type GeomSource = Geometry & { meta?: ItemMeta };

export const geometryOf = (it: GeomSource): Geometry => {
  // The cast is the loop below it: GEOM_KEYS names exactly the fields a
  // Geometry has beyond its id, so the object is complete by the next line.
  const out = { id: it.id } as Geometry;
  for (const key of GEOM_KEYS) out[key] = it[key];
  const presnap = usableMemo(it.meta?.presnap);
  if (presnap) out.presnap = { ...presnap };
  return out;
};

export function normalizeLayout(raw: unknown, items: Item[]): Geometry[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(items.map(it => it.id));
  const seen = new Set<unknown>();
  const out: Geometry[] = [];
  for (const entry of raw) {
    // One key at a time, out of a file: `raw` is whatever board.json carried.
    if (!isRecord(entry)) continue;
    const value = entry;
    if (typeof value.id !== 'string' || !ids.has(value.id) || seen.has(value.id)) continue;
    // Number() rather than the unary +, which is the same conversion said in a
    // way that takes an `unknown` - and every one of these came out of a file.
    if (!GEOM_KEYS.every(key => Number.isFinite(Number(value[key])))) continue;
    const w = Math.min(Math.max(Number(value.w), MIN_SIZE), MAX_SIZE);
    const h = Math.min(Math.max(Number(value.h), MIN_SIZE), MAX_SIZE);
    // The memo as usableMemo() reads it: the same four numbers the spread used
    // to copy, minus anything else a hand-written file put beside them.
    const presnap = usableMemo(value.presnap);
    out.push({
      id: value.id,
      x: Number(value.x), y: Number(value.y), w, h,
      rot: Number(value.rot), z: Number(value.z),
      ...(presnap ? { presnap } : {}),
    });
    seen.add(value.id);
  }
  return out;
}

export function layoutMap(layout: Geometry[] | null | undefined): Map<string, Geometry> {
  return new Map((layout || []).map(geometry => [geometry.id, geometry]));
}

/**
 * What the column will fit: an item, or the Geometry record that stands for
 * one. completeLayout() fits a saved record rather than the live card, which is
 * why this is not simply Item - and the return is the same type as the argument,
 * because every branch of it hands back a copy of what it was given.
 */
type Fittable = { type?: string, x: number, y: number, w: number, h: number };

/** Keep an item inside the selected-width Mobile strip. */
export function fitMobile<T extends Fittable>(
  it: T,
  scaleHeight = false,
  step = baseStep(),
  columns = mobileColumnCount(),
  spacing = 0,
) {
  // Every item but one. The Desktop title card is not on the Mobile board at
  // all - canvas/items.js never mounts it there, the masthead is Mobile's title
  // - and completeLayout() parks it clear of the top edge so that nothing else
  // can run into a box that is not on the screen. That parking is above the top
  // edge, which is exactly what the clamp below undoes: it would drag the card
  // back down to flush with the first row, which is where the trouble was.
  if (it.type === 'title') return { ...it };
  const width = mobileBoardWidth(step, columns);
  // The seam the packer will actually leave, gap included - otherwise a card
  // fitted to the full strip is exactly as wide as the columns it claims, and
  // the gap has nowhere to come from but the far edge of the board.
  const inset = mobileSeam(step, spacing);
  const contentWidth = Math.max(MIN_SIZE, width - 2 * inset);
  const oldWidth = Math.min(Math.max(Number.isFinite(it.w) ? it.w : MIN_SIZE, MIN_SIZE), MAX_SIZE);
  const ratio = oldWidth > contentWidth ? contentWidth / oldWidth : 1;
  const w = Math.min(oldWidth, contentWidth);
  const h0 = Math.min(Math.max(Number.isFinite(it.h) ? it.h : MIN_SIZE, MIN_SIZE), MAX_SIZE);
  const h = scaleHeight ? Math.max(MIN_SIZE, h0 * ratio) : h0;
  const half = w / 2;
  const x = Math.min(
    Math.max(Number.isFinite(it.x) ? it.x : 0, -width / 2 + inset + half),
    width / 2 - inset - half,
  );
  const y0 = Number.isFinite(it.y) ? it.y : 0;
  const y = Math.min(y0, mobileBoardTop(step) - inset - h / 2);
  return { ...it, x, y, w, h };
}

export const fitBoardMode = <T extends Fittable>(it: T, scaleHeight = false) =>
  board.layoutMode === 'mobile'
    ? fitMobile(it, scaleHeight, baseStep(), mobileColumnCount(), board.settings.spacing)
    : it;

/**
 * Complete one profile for every live item.
 *
 * New items have no geometry in the inactive profile yet. Desktop inherits the
 * place where the item was added; Mobile appends it below the existing feed so
 * switching modes never drops a new card on top of an old one.
 */
export function completeLayout(mode: LayoutMode): Geometry[] {
  const map = layoutMap(board.layouts[mode]);
  if (mode === 'mobile') {
    const profile = board.layoutSettings.mobile || defaultLayoutSettings('mobile');
    const step = profile.gridStep > 0 ? profile.gridStep : DEFAULT_SETTINGS.gridStep;
    const columns = mobileColumnCount(profile.mobileColumns);
    // The inactive profile's own gap, not the live board's. This runs while
    // Desktop is on screen, where board.settings.spacing is Desktop's 12.
    const spacing = Math.max(0, profile.spacing || 0);
    const known = [];
    const missing = [];
    // A fenced board is packed whole rather than appended to, and this is the one
    // behaviour fences take away.
    //
    // Ordinarily an item that already has Mobile geometry keeps it and only new
    // arrivals are packed, which is what lets a card dragged around the column
    // stay where it was put. A run cannot be built that way: a fence drawn on
    // Desktop arrives here as the single missing item while every card it holds
    // still has a place somewhere up the column, so it would land alone at the
    // bottom as a band with nothing under it, and the grouping would be invisible
    // on exactly the layout it was supposed to become visible on.
    //
    // So on a board with fences the column is a function of the fences, rebuilt
    // from the current Desktop membership every time this runs. The cost is real
    // and worth naming: on such a board, positions you arranged by hand on the
    // phone do not survive a trip to Desktop and back. A board with no fences is
    // untouched by this, which is every board saved until now.
    const fenced = board.items.some(isFence);
    // A note stuck to something on the board rides it into the column rather than
    // being packed as a card of its own, so a pinned sticky stays pinned when the
    // board reflows for Mobile. It is neither packed nor an obstacle; its place is
    // derived from the host once the host has one. A note whose host is gone falls
    // through to being packed like anything else.
    const riders = [];
    for (const it of board.items) {
      // The Desktop title card is not on this board: canvas/items.js leaves it
      // out of the Mobile mount pass, and the masthead above the column is
      // Mobile's title instead. So it is parked clear of the top edge rather
      // than left wherever Desktop had it.
      //
      // Keeping its Desktop place was the bug. TITLE_DEFAULT_POS is y 244, and
      // the Mobile board's top edge is 384 with the first row just under it -
      // so an unrendered 256x171 box sat across the middle columns of the first
      // three rows. Nothing drew it and everything else could feel it: a card
      // dragged up there met an obstacle that was not on the screen, and a note
      // dropped on it became stuck to it - pinned to a card that cannot be seen,
      // selected or moved on this layout. Above the top edge it is out of every
      // one of those answers, and it costs nothing, because the one thing this
      // geometry is never used for on Mobile is drawing it.
      //
      // The stick half of that is now also fixed at the stick end - sticky.js
      // refuses furniture as a host on either layout - so this parking is doing
      // the obstacle job it was written for and no longer the only thing
      // standing between a note and an invisible card.
      if (it.type === 'title') {
        map.set(it.id, geometryOf({
          ...it, x: 0, y: mobileBoardTop(step) + step + it.h / 2, rot: 0,
        }));
        continue;
      }
      if (isRider(it)) { riders.push(it); continue; }
      const saved = fenced ? null : map.get(it.id);
      if (!saved) {
        missing.push(it);
        continue;
      }
      const presnap = saved.presnap;
      const geometry = {
        ...geometryOf(fitMobile(saved, false, step, columns, spacing)),
        ...(presnap ? { presnap: { ...presnap } } : {}),
      };
      map.set(it.id, geometry);
      known.push({
        ...it,
        ...geometry,
        meta: geometry.presnap
          ? { ...it.meta, presnap: { ...geometry.presnap } }
          : it.meta,
      });
    }
    const packed = placeMobileItems(missing, known, {
      step,
      snap: profile.snap,
      columns,
      spacing,
    });
    for (const item of packed) map.set(item.id, geometryOf(item));
    const stranded = attachRiders(riders, map, (note, hostSrc, hostDst) => {
      const at = stuckPlacement(note, hostSrc, hostDst);
      return geometryOf({ ...fitMobile(note, false, step, columns, spacing), x: at.x, y: at.y });
    });
    // A rider whose host never resolved - deleted, or a stuck-to-stuck cycle -
    // is packed after all, so it is at least visible somewhere.
    if (stranded.size) {
      const rest = riders.filter(r => stranded.has(r.id));
      const extra = placeMobileItems(rest, [...known, ...packed], {
        step, snap: profile.snap, columns, spacing,
      });
      for (const item of extra) map.set(item.id, geometryOf(item));
    }
    // Non-null: the loop above gives every item a record - the title card, each
    // rider, every saved card and every packed one - and the stranded pass just
    // above covers the riders it could not place against a host.
    const out = board.items.map(item => map.get(item.id)!);
    board.layouts.mobile = out;
    return out;
  }

  // Desktop, and it has the same shape as the Mobile branch above for the same
  // reason: an item with no geometry in this profile has to be *placed*, not
  // copied off the live board.
  //
  // `geometryOf(it)` was the whole of this, and it is where the two layouts
  // leaked into each other. This runs from setBoardMode() the instant the switch
  // happens, and at that instant the live item is still whatever the layout being
  // left made of it - fitted to the strip by fitMobile() and packed into the
  // column. So a board built on the phone arrived on Desktop as the same two
  // columns, one under the other, and the hint cards arrived at column width.
  // Neither had ever had a Desktop place, and copying the Mobile one was the
  // app answering a question it had no answer to.
  const known = [];
  const missing = [];
  const riders = [];
  for (const it of board.items) {
    const saved = map.get(it.id);
    if (saved) { known.push({ ...it, ...saved }); continue; }
    // Furniture places itself and must not be packed. The title card is a
    // singleton with a default spot of its own (ensureTitleCard), and a fence is
    // a rectangle drawn round its members rather than a card in a wall - putting
    // either in a masonry would be laying out the frame along with the pictures.
    if (it.type === 'title' || isFence(it)) {
      map.set(it.id, geometryOf(it));
      known.push(it);
      continue;
    }
    // A note stuck to something rides its host here exactly as it does on Mobile,
    // rather than taking a slot of its own in the wall.
    if (isRider(it)) { riders.push(it); continue; }
    missing.push(it);
  }

  if (missing.length) {
    const profile = board.layoutSettings.desktop || defaultLayoutSettings('desktop');
    const spacing = Math.max(0, profile.spacing || 0);
    const step = profile.gridStep > 0 ? profile.gridStep : DEFAULT_SETTINGS.gridStep;
    // In the order the Feed meets them, not in board.items order. The two are
    // different the moment the Mobile arrangement is anything but 'placed', and
    // the sequence somebody scrolled through on the phone is the sequence they
    // expect to read across on the desktop.
    // The cast is safe for the reason import/drop.ts gives at its own call:
    // mobileOrder() mints nothing, it returns the items it was handed in
    // another order, so every element here is one of `missing`.
    const ordered = mobileOrder(missing, { name: board.arrangements.mobile }) as Item[];
    // Masonry, and it is the same rule the Feed itself packs by: shortest column
    // first, leftmost on a tie (LAYOUTS.masonry in arrange/arrangements.js, and
    // feedMasonry() in ui/feed.js, which were written from each other). Fed the
    // Feed's order it reproduces the Feed's wall as a rectangular block, which is
    // the one arrangement that can honestly be called "the same board".
    //
    // Below whatever is already placed rather than on top of it, and `obstacles`
    // is the belt to that braces: arrange() pushes only the newcomers that would
    // still have landed on something, and leaves every saved position untouched.
    // So one file dropped on the phone and carried across appends one card; a
    // board that has never been here lays out whole.
    const bounds = known.length ? itemBounds(known) : null;
    const center = bounds
      ? { x: (bounds.x0 + bounds.x1) / 2, y: bounds.y0 - spacing - step }
      : { x: 0, y: 0 };
    const spots = arrange(ordered, {
      name: 'masonry',
      center,
      spacing,
      cellStep: profile.snap ? step : 0,
      obstacles: known,
    });
    ordered.forEach((it, i) => {
      const at = spots[i];
      if (at) map.set(it.id, geometryOf({ ...it, x: at.x, y: at.y }));
    });
  }

  // Riders last, so their hosts have somewhere to be first.
  const stranded = attachRiders(riders, map, (note, hostSrc, hostDst) => {
    const at = stuckPlacement(note, hostSrc, hostDst);
    return geometryOf({ ...note, x: at.x, y: at.y });
  });
  // A rider whose host never resolved - deleted, or a stuck-to-stuck cycle - is
  // left where it is, which is at least somewhere. The Mobile branch packs it
  // instead; here there is no packer running by then and one note at the live
  // coordinates is a smaller wrong than none.
  for (const note of riders) {
    if (stranded.has(note.id) && !map.has(note.id)) map.set(note.id, geometryOf(note));
  }

  const out = [];
  for (const it of board.items) {
    let geometry = map.get(it.id);
    // Everything above should have set one; this is the backstop, not the path.
    if (!geometry) geometry = geometryOf(it);
    out.push(geometry);
  }
  board.layouts[mode] = out;
  return out;
}

export function captureLayout(mode = board.layoutMode) {
  board.layouts[mode] = board.items.map(geometryOf);
}

/** Save the active layout's private settings and refresh the shared look. */
export function captureLayoutSettings(mode = board.layoutMode) {
  const { shared } = splitAppearance(board.settings.appearance);
  // Through the live settings rather than a bare `{ appearance }`: cloneSettings
  // takes a whole settings record and only the deep copy of the look is read
  // back out, which is what this line always wanted from it.
  board.sharedAppearance = cloneSettings({ ...board.settings, appearance: shared }).appearance;
  board.layoutSettings[mode] = layoutSettingsOf(board.settings);
  board.arrangements[mode] = board.arrangement;
}

/** Make one layout's settings and arrangement the live compatibility surface. */
export function activateLayoutSettings(mode: LayoutMode) {
  if (mode === 'mobile') {
    // '' rather than 'none': that is what DEFAULT_SETTINGS holds, what the
    // select's None option carries, and what PAPERS has no entry for. A second
    // spelling would read as truthy everywhere `settings.paper` is tested.
    board.layoutSettings.mobile.paper = '';
    board.layoutSettings.mobile.paperLandscape = false;
    board.layoutSettings.mobile.paperResize = false;
    // Spacing used to be pinned to zero here alongside the paper keys, and it
    // was the wrong list to be on. Paper is Desktop-only because a fixed-width
    // strip has no page to fit anything onto; a gap between cards is something
    // a column can perfectly well have. Zero stays the *default* a Mobile
    // profile is born with (see defaultLayoutSettings) - so no saved board
    // moves - and the slider is now free to move it.
  }
  const fonts = (board.layoutSettings.desktop.fonts || [])
    .map(font => ({ ...font }));
  board.layoutSettings.desktop.fonts = fonts.map(font => ({ ...font }));
  board.layoutSettings.mobile.fonts = fonts.map(font => ({ ...font }));
  const profile = board.layoutSettings[mode] || defaultLayoutSettings(mode);
  board.layoutSettings[mode] = cloneSettings(profile);
  board.settings = settingsFor(profile, board.sharedAppearance);
  // Read through the mode's own catalogue: Desktop's seven layouts are shapes
  // and Mobile's six are orders, and a board carrying `spiral` for Mobile - as
  // every board saved before this did, since 'spiral' was the fallback for both
  // - is asking for a shape a column cannot make. mobileArrangement() answers
  // with the order nearest to it. Nothing is written back; the stored id is
  // still whatever it was until the user picks something.
  const stored = board.arrangements[mode];
  board.arrangement = mode === 'mobile'
    ? mobileArrangement(stored)
    : (stored || 'spiral');
}

export function writeLayout(layout: Geometry[]) {
  const map = layoutMap(layout);
  const ids: string[] = [];
  for (const it of board.items) {
    const saved = map.get(it.id);
    if (!saved) continue;
    fitOnto(it, saved, GEOM_KEYS);
    writePresnap(it, saved.presnap);
    ids.push(it.id);
  }
  // Walked over board.items rather than over the layout, so an id in the file
  // that is on no card is skipped rather than looked up and dropped - and the
  // event carries the ids in board order.
  if (ids.length) bus.emit('geom', ids);
}

/** Whether a string names one of the two profiles. See setBoardMode() below. */
const isLayoutMode = (v: unknown): v is LayoutMode =>
  BOARD_MODES.some(mode => mode === v);

/**
 * Switch which geometry profile is live.
 *
 * Content and the board-wide color identity never move. Geometry, arrangement,
 * and every other setting are exchanged as one profile. History is cleared
 * because neither geometry nor setting undo may replay into the other layout.
 */
export function setBoardMode(mode: string | null) {
  // The membership test is what makes the argument a LayoutMode, and it is
  // written as a predicate so the assignments below need no second opinion:
  // this is the door a stored preference and a `data-cmd` come through, and
  // neither has been held to anything before it arrives.
  if (!isLayoutMode(mode) || mode === board.layoutMode) return false;
  captureLayout();
  captureLayoutSettings();
  const generated = mode === 'mobile' && !(board.layouts.mobile || []).length && board.items.length;
  board.layoutMode = mode;
  activateLayoutSettings(mode);
  writeLayout(completeLayout(mode));
  clearHistory();
  if (generated) markDirty();
  bus.emit('layout', mode);
  bus.emit('settings', 'profile');
  return true;
}

/**
 * Everything that travels when these ids do: the ids themselves, whatever is
 * stuck to them, and whatever they fence.
 *
 * To a fixed point, and it has to be. A note stuck to a card inside a fence
 * travels with the fence, and neither relation can see that on its own - asking
 * one after the other in either order stops a step short of it. So both are
 * asked until the set stops growing. Two passes settle every real board, and the
 * loop is bounded by the item count because each pass either adds somebody or
 * ends it.
 *
 * Both halves already leave out anything they are handed, which is what keeps a
 * marquee from moving a card once as a selection and again as a follower.
 *
 * Here rather than in canvas/input.js, where it was written and where the drag
 * that needed it lives, because it turned out not to be a fact about gestures:
 * it is the set a geometry write acts on, which is this module's subject, and
 * canvas/items.js needs the same set to lift a region and its cards together on
 * hover. A copy in the renderer would have been the two relations meeting in a
 * third place, and one of the two was already stale by then.
 */
export function travelling(ids: Iterable<string>) {
  const out = [...ids];
  for (let grew = true; grew;) {
    grew = false;
    for (const id of [...stuckFollowers(out), ...fenceFollowers(out)]) {
      if (out.includes(id)) continue;
      out.push(id);
      grew = true;
    }
  }
  return out;
}

/** Geometry snapshot for a set of ids - the before/after pair of a drag. */
export function snapshotGeom(ids: Iterable<string>): GeomSnap[] {
  return [...ids].map(id => {
    const it = byId(id);
    if (!it) return null;
    // The cast is the loop below it, as in geometryOf(): GEOM_KEYS names every
    // number a snapshot holds, and the two fields after it fill the rest.
    const g = { id } as GeomSnap;
    for (const k of GEOM_KEYS) g[k] = it[k];
    const presnap = usableMemo(it.meta?.presnap);
    g.presnap = presnap ? { ...presnap } : null;
    // Not geometry, and here anyway. "Unstuck on purpose" is the one durable
    // piece of stickiness state (see sticky.js) and the two things that change
    // it - the arrow keys, and a drop that finds a host - are both gestures that
    // move something. So it belongs to the same undo entry as the movement that
    // set it, and riding in the pair is how it gets there without a second
    // history entry sitting beside every nudge.
    g.loose = !!it.meta?.loose;
    return g;
  }).filter((g): g is GeomSnap => !!g);
}

/** Write a geometry snapshot back onto the items (live, not undoable). */
export function applyGeom(snap: GeomPatch[]) {
  const ids: string[] = [];
  for (const g of snap) {
    const it = byId(g.id);
    if (!it) continue;
    fitOnto(it, g, GEOM_KEYS);
    // `in` rather than truthiness, and that is the difference from the other
    // two: a patch that says nothing about presnap must leave it alone, where a
    // patch carrying an explicit null is asking for it to be forgotten.
    if ('presnap' in g) writePresnap(it, usableMemo(g.presnap));
    if ('loose' in g) writeLoose(it, !!g.loose);
    ids.push(g.id);
  }
  // Unguarded, unlike the other two. This is the live path - a drag frame - and
  // its callers rely on the frame being announced even when every id in the
  // patch has since been deleted, so the view stops drawing what is no longer
  // there.
  bus.emit('geom', ids);
}

/**
 * Close a live drag/resize into one undo entry. `before` is the snapshot taken
 * when the gesture started; the current geometry becomes the redo state.
 */
export function commitGeom(
  label: string,
  before: GeomSnap[],
  driven?: string[],
  options: { preservePresnap?: boolean } = {},
) {
  let after = snapshotGeom(before.map(b => b.id));
  // The loose flag counts as a change even where nothing moved. A drag that
  // ends a pixel from where it began has still dropped a loose note onto a
  // card, and on a snapped board it can end *exactly* where it began - so
  // testing geometry alone would clear the flag and then decline to record it,
  // which is the one shape of bug this pair exists to rule out: a real change
  // with no entry to reverse it.
  const changed = after.some((a, i) =>
    a.loose !== before[i].loose || GEOM_KEYS.some(k => a[k] !== before[i][k]));
  if (!changed) return;
  // Placed by hand while snapping was on: this *is* where the item belongs
  // now, so it gives up its memory of where it sat before the board was laid
  // on the lattice. Turning snapping off later leaves it exactly here.
  if (board.settings.snap && !options.preservePresnap) {
    for (let i = 0; i < after.length; i++) {
      // SNAP_KEYS, not GEOM_KEYS. The memo records where a card sat before the
      // lattice moved it, and unsnapAll() restores exactly those four - so only
      // a spatial change can invalidate it. Bring to front rewrites z and
      // nothing else, which the note below already lists among the callers that
      // "change no note's position relative to anything", and it was throwing
      // away the memory of every card it raised. Rotation is deliberately out
      // too: turning a card does not change its snapped box.
      if (SNAP_KEYS.some(k => after[i][k] !== before[i][k])) forgetPresnap(byId(after[i].id));
    }
    after = snapshotGeom(before.map(b => b.id));
  }
  // What the gesture actually had hold of, as opposed to what came along for
  // the ride. Only these ask again where they are stuck; see restick(). Left
  // out entirely by callers that move things without anybody touching them -
  // Bring to front, the embed's fit - which change no note's position relative
  // to anything and so change no answer.
  //
  // It rides *inside* the committed pair rather than running once here, because
  // moving is moving whether a hand or the history did it. Undo puts a note back
  // where it was without anybody touching it, so nothing in the gesture path
  // runs - and the answer measured after the drop would then stand over a note
  // no longer anywhere near the thing it names. The memo outliving the geometry
  // that justified it is the one thing the memo must never do. commit() runs
  // the redo half immediately, so the gesture's own restick is that first call.
  //
  // Fences ask the same question and one more. A fence that changed *size* is
  // the one gesture that re-parents without anybody touching the cards: its
  // edges are what membership means, so dragging a corner out over three more
  // cards is how you say "and these too". Everything inside the rectangle as it
  // was or as it now is has to ask again - see refenceAround(), which is handed
  // both boxes so the pair is symmetric and undo needs no separate case.
  //
  // Desktop only, because membership is measured there and nowhere else, and a
  // fence on Mobile is a band the packer owns rather than a region anybody drew.
  const resized: Box[] = [];
  if (driven && board.layoutMode !== 'mobile') {
    for (let i = 0; i < after.length; i++) {
      if (!driven.includes(before[i].id) || !isFence(byId(before[i].id))) continue;
      if (after[i].w === before[i].w && after[i].h === before[i].h) continue;
      resized.push(boxOf(before[i]), boxOf(after[i]));
    }
  }
  const move = (snap: GeomSnap[]) => {
    applyGeom(snap);
    if (!driven) return;
    restick(driven);
    // These have just been let go, so their ten seconds start now - see the
    // settling block in sticky.js. Beside restick() and handed the same set for
    // the same reason: a note towed across the board by the photograph under it
    // was not put down, and its grace period is not its to have again.
    //
    // Inside the committed pair, like restick(), so an undo that puts an item
    // back on a card gives it the same window a hand would have. Stepping back
    // is a thing you did to it.
    startSettling(driven);
    refence(driven);
    refenceAround(resized);
  };
  // Weighted: this pair retains two snapshots of everything it moved, and a
  // whole-board drag or arrange is where the history's memory actually goes.
  //
  // The fifth argument is the one place in the app that needs it. By the time a
  // gesture is closed the cards are already where they end up - they have been
  // moving under the pointer - so `move(after)` re-applies values the board
  // already holds, and the step ledger, which measures a change by looking at
  // the board on either side of the redo call, would see nothing at all and
  // record an empty step. This puts the geometry back for the instant it takes
  // to look. applyGeom() rather than move(): the pre-image is wanted for
  // measuring, not for living in, so restick() and the settling window stay out
  // of it and run once, forward, where they belong.
  commit(label, () => move(after), () => move(before), before.length * 2,
         () => applyGeom(before));
}

/**
 * Set or clear "unstuck on purpose" on one item.
 *
 * Guarded on no-change, because it runs from applyGeom - which a drag calls
 * every frame - and the restick() below must not fire sixty times a second.
 * That restick is the point of routing this through a function at all: the
 * memo in sticky.js still holds whatever the item was stuck to before it was
 * unstuck, and the flag is read *in front of* the memo rather than instead of
 * it, so clearing the flag has to send the question back to the measurement.
 */
function writeLoose(it: Item, loose: boolean) {
  if (loose === !!it.meta?.loose) return;
  if (loose) it.meta = { ...it.meta, loose: true };
  else { const { loose: _drop, ...rest } = it.meta || {}; it.meta = rest; }
  restick([it.id]);
}

export function forgetPresnap(it: Item | null | undefined) {
  if (!it?.meta || !('presnap' in it.meta)) return;
  const { presnap, ...rest } = it.meta;
  it.meta = rest;
}

/** A memo is four finite numbers with a size that is actually a size. */
export function usableMemo(pre: unknown): Presnap | null {
  // One key at a time and each one checked, because a memo arrives from a
  // .mbrd like everything else - see the note over unsnapAll().
  if (!isRecord(pre)) return null;
  // SNAP_KEYS' four, read one at a time rather than through the list: the
  // typeof is what Number.isFinite() was already saying about a value out of a
  // file - it answers false for anything that is not a number - and saying it
  // this way is what lets the four come back out as the numbers they are.
  const { x, y, w, h } = pre;
  if (typeof x !== 'number' || typeof y !== 'number'
    || typeof w !== 'number' || typeof h !== 'number') return null;
  const ok = Number.isFinite(x) && Number.isFinite(y)
    && Number.isFinite(w) && Number.isFinite(h);
  if (!ok || w < MIN_SIZE || h < MIN_SIZE || w > MAX_SIZE || h > MAX_SIZE) return null;
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Snapping the whole board
//
// The board-wide half of the lattice, beside SNAP_KEYS and the presnap memo it
// is written in terms of rather than in state.js, where it used to sit calling
// down into all three. It is a geometry write like every other one in this
// file: a before list, an after list, and one commit that carries them.
//
// The setting comes with it and that is the whole reason it is one block. The
// flag used to be written by setSetting() *outside* this command, so one Ctrl+Z
// took the board off the lattice and left the checkbox ticked - the only place
// in the app where undo produced a state nobody could have produced by hand.
// state.js still owns setSetting(); what it hands over on the `snap` key is the
// value, and everything after that is here.
// ---------------------------------------------------------------------------

/**
 * Turning snapping on lays every item on the lattice at once, rather than only
 * governing the next thing you drag - so the board *looks* snapped the moment
 * the setting is on, which is the only way a grid reads as a grid.
 *
 * Turning it off puts everything back. That needs the old geometry kept
 * somewhere, and it goes in `meta.presnap` on the item: per item, so an item
 * touched during a snapped session can drop its own memo without affecting the
 * rest, and serialised with the board, so the promise survives a save and a
 * reload rather than lasting only as long as the tab.
 *
 * Two consequences worth being explicit about:
 *
 * - **The step is the base step, not the one on screen.** `gridStep()` picks a
 *   spacing from the current zoom so the lattice never becomes a fill, which is
 *   right for something drawn and wrong for something stored: snapping at 20%
 *   zoom would otherwise commit a board to a coarser geometry than snapping at
 *   100%, and the same click would do two different things depending on how far
 *   out you happened to be.
 * - **Edges land on the lattice, not centres**, and the arithmetic is latticeBox() in
 *   geometry.js, shared with the gestures in canvas/input.js so that laying the
 *   board out and then dragging one item across it agree about where things go.
 *   What makes a snapped board look snapped is items sitting flush in cells; an
 *   item whose size is an odd number of cells therefore ends up with its centre
 *   on a half-step, which is correct and is not a rounding error.
 */
export function snapAll(snapTo?: boolean) {
  const step = baseStep();
  const before: SnapState[] = [], after: SnapState[] = [];
  for (const it of board.items) {
    // A pinned item is not on the board, it is on its host - see isPinned() in
    // sticky.js. Its place is a fraction of the card underneath it, and putting
    // that fraction on the lattice would slide a sticky off the photograph it
    // was pressed onto, in a sweep the person asked of the *board*. The host
    // lands on the grid and the rider comes along.
    if (isPinned(it)) continue;
    const pre = it.meta?.presnap || null;
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });

    const box = latticeBox(it, step);
    after.push({
      id: it.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // A board snapped, unsnapped and snapped again remembers the first
      // position, not the second - the memo is of life before the lattice.
      pre: pre || { x: it.x, y: it.y, w: it.w, h: it.h },
    });
  }
  applySnapState(before, after, 'Snap to grid', snapTo);
}

/**
 * Re-assert the geometry rules that can drift from their rendered result.
 *
 * A reload is not an edit by itself. Snapping only records history and dirties
 * the board when it actually repairs a box; the final event also makes every
 * renderer re-read positions when nothing in the data needed changing.
 */
export function recheckBoardGeometry() {
  if (board.settings.snap) snapAll();
  const ids = board.items.map(item => item.id);
  if (ids.length) bus.emit('geom', ids);
}

/** Put back what snapAll() remembered, for everything still carrying a memo. */
export function unsnapAll(snapTo?: boolean) {
  const before: SnapState[] = [], after: SnapState[] = [];
  for (const it of board.items) {
    // Checked rather than trusted: a memo arrives from a .mbrd like everything
    // else, and a hand-edited one holding a string would write it straight onto
    // the item's geometry. A memo that does not describe a box is no memo.
    //
    // Pinned items are skipped for the same reason snapAll() skips them: the
    // sweep never moved one, so there is nothing of its to put back.
    if (isPinned(it)) continue;
    const pre = usableMemo(it.meta?.presnap);
    if (!pre) { forgetPresnap(it); continue; }
    before.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, pre });
    after.push({ id: it.id, x: pre.x, y: pre.y, w: pre.w, h: pre.h, pre: null });
  }
  applySnapState(before, after, 'Leave the grid', snapTo);
}

/**
 * Write the snap flag itself - the setting half of the same act.
 *
 * The layoutSettings mirror is written with it and not left to setSetting()'s
 * tail: the two are one value kept in two places, and an undo that restored the
 * flag while leaving the mirror behind would put the lie back at the next
 * layout switch instead of at the next drag.
 */
/**
 * One item as the two board-wide snap sweeps carry it: the box, and the memo
 * that goes with it. `pre` is whatever was on the item - the sweep moves it
 * from one place to another rather than reading it, and usableMemo() is what
 * decides whether it means anything.
 */
type SnapState = {
  id: string, x: number, y: number, w: number, h: number, pre: unknown,
};

function writeSnapSetting(v: boolean) {
  board.settings.snap = v;
  board.layoutSettings[board.layoutMode] = layoutSettingsOf(board.settings);
  markDirty();
  bus.emit('settings', 'snap');
}

/**
 * The geometry, and - when a person actually turned the setting - the setting
 * with it, as one command.
 *
 * `snapTo` is the flag the user asked for, or undefined for
 * recheckBoardGeometry(), which re-asserts a rule that is already on rather than
 * toggling one. Folding the flag in is the whole point: it used to be written by
 * setSetting() *outside* this command, so one Ctrl+Z took the board off the
 * lattice and left the checkbox ticked - the only place in the app where undo
 * produced a state nobody could have produced by hand.
 *
 * Nothing moved is not nothing happened: an empty board, or one already flush on
 * the lattice, still has a setting to write. It goes in without history, the way
 * every other setting does - there is no geometry to take back, so there is
 * nothing for an undo entry to be about.
 */
function applySnapState(
  before: SnapState[], after: SnapState[], label: string, snapTo: boolean | undefined,
) {
  const moved = after.some((a, i) =>
    SNAP_KEYS.some(k => a[k] !== before[i][k]) || !!a.pre !== !!before[i].pre);
  if (!moved) {
    if (snapTo !== undefined) writeSnapSetting(snapTo);
    return;
  }
  const apply = (list: SnapState[], flag: boolean | undefined) => {
    if (flag !== undefined) writeSnapSetting(flag);
    writeSnapState(list);
  };
  // commit() runs its redo half itself, which is what applies `after` here.
  commit(label,
    () => apply(after, snapTo),
    () => apply(before, snapTo === undefined ? undefined : !snapTo));
}

function writeSnapState(list: SnapState[]) {
  const ids: string[] = [];
  for (const g of list) {
    const it = byId(g.id);
    if (!it) continue;
    // SNAP_KEYS, not GEOM_KEYS: snapping moves and resizes and must not touch
    // rotation or z, which is the whole reason there are two lists.
    fitOnto(it, g, SNAP_KEYS);
    // `pre` is unknown on SnapState because it arrives from a caller that took
    // it off an item's meta; usableMemo() is the same check applyGeom() runs and
    // is what turns it back into a memo or into nothing.
    writePresnap(it, usableMemo(g.pre));
    ids.push(g.id);
  }
  if (ids.length) bus.emit('geom', ids);
}

