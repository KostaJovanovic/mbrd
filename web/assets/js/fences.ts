// Which card is inside which fence, and what travels when a fence moves.
//
// A fence is a labelled rectangle drawn on the board, and the cards inside it
// belong to it. Nothing about that membership is a list: a card is in a fence
// when its centre is inside the fence, which is a fact about where two things
// are and falls out of the geometry that is already there. There is no add, no
// remove, and nothing that can disagree with the picture on the screen. Drag a
// card out and it is out; that is the whole interface.
//
// This is sticky.js's argument with a different predicate, and the two files are
// deliberately parallel rather than merged - see the note at the bottom of this
// header for why. Read that one first; most of what is here is the same shape.
//
// Three things differ, and each is the interesting part of this file.
//
//   the predicate     A note sticks by *area*, because a sticky pressed onto the
//                     corner of a photograph is stuck to it. A fence contains by
//                     *centre*, because a fence is a region, regions have edges,
//                     and a card straddling one has to be on exactly one side of
//                     it. Where fences nest, the smallest containing one wins.
//
//   the layout        Stickiness is measured wherever the board currently is.
//                     Membership is measured on Desktop geometry and *only* on
//                     Desktop geometry - see desktopBox() below, which is the
//                     single most load-bearing function here.
//
//   resizing          Moving a fence does not re-measure what is in it; resizing
//                     one does. A photograph's edges are incidental to what is
//                     lying on it, and a fence's edges *are* the fence. Dragging
//                     a corner out over three more cards is the gesture that
//                     means "and these too", and there is no other one.
//
// Why this is not folded into sticky.js: the predicates differ, the layout rule
// differs, the resize rule differs, and only notes stick while anything can be
// fenced. An abstraction over the two would have to be parameterised by all four,
// which is a way of writing the differences down twice. They meet in exactly two
// places, both of which have to walk both relations to answer a question neither
// can answer alone: stackRoot() in stacking.js, for "what moves as one when the
// z-order changes", and travelling() in layout.js, for "what moves as one when
// the geometry does". Two is the right number and three would not be - every
// caller that wants either answer takes it from one of those, which is why the
// hover lift in canvas/items.js reads travelling() rather than composing the two
// again. If a third relation ever turns up, revisit it then.

import { pointInItem } from './geometry.ts';
import { isRecord } from './util.ts';
import { board, byId, isFurniture, TITLE_ID } from './board-model.ts';
import type { Geometry, Item } from './board-model.ts';

/** A rectangle in world space, centred on x,y - an item's box or a fence's. */
type Box = { x: number, y: number, w: number, h: number, rot?: number };
/** The other spelling of a rectangle: two corners, as itemBounds() returns. */
type Bounds = { x0: number, y0: number, x1: number, y1: number };

/**
 * What a membership question needs of an item: an id and a box. Structural for
 * the reason sticky.ts's Stickable is - the fences it *answers* with are real
 * items off the board.
 */
type Boxed = Box & { id: string };

/** A fence is an item like any other; this is the one thing that says so. */
// Generic in what it is handed, and narrowing to the *type* rather than to the
// argument, which is what makes it usable at both kinds of call site: `byId(id)`
// loses its undefined in the true branch, while a plain `isFence(x) || x.type
// === 'sticker'` keeps its item in the false branch - where a bare `it is T`
// would have left `never`. isRecord() inside for the reason isFurniture() gives:
// this is asked of items, of drafts on their way onto a board, and of the
// box-shaped types the command modules still declare privately.
export const isFence = <T>(it: T | null | undefined): it is T & { type: 'fence' } =>
  isRecord(it) && it.type === 'fence';

/**
 * itemId -> fenceId or null. Null is a real answer, "measured, and it is in no
 * fence", and it has to survive as one: falling through to a fresh measurement
 * every time would make a loose card the one case that *does* get swallowed by
 * a fence sliding underneath it.
 */
const fences = new Map<string, unknown>();

/**
 * The box a membership question is asked about: the item's Desktop geometry.
 *
 * This is the rule the whole feature stands on. On Mobile a fence is drawn as a
 * full-width band with its members packed *underneath* it (see the run packer in
 * layout.js), so no card is ever geometrically inside its own fence there.
 * Measuring in the active layout would therefore dissolve every fence on the
 * board the moment somebody switched to Mobile - and then stamp that dissolution
 * into the file on the next save, which is the same bug as losing the data.
 *
 * So the phone *renders* membership and never computes it. While Desktop is the
 * live layout its geometry is on the items themselves; while Mobile is, the
 * Desktop record captured on the way out of it is the truth, and board.layouts
 * is where that lives.
 *
 * Returns null when Mobile is live and an item has no Desktop record yet - a
 * card added on a phone, before completeLayout() has given it one. A null box is
 * unmeasurable rather than loose, and measure() treats it as "no answer", which
 * leaves the seeded memo standing. That is the right way round: a board opened
 * straight into Mobile has meta.fence and nothing else, and it must not be
 * talked out of it.
 */
function desktopBox(it: Boxed | null | undefined): Box | null {
  if (!it) return null;
  if (board.layoutMode !== 'mobile') return it;
  const record = desktopIndex().get(it.id);
  return record ? { ...it, x: record.x, y: record.y, w: record.w, h: record.h, rot: record.rot || 0 } : null;
}

/**
 * The Desktop layout as a Map, rebuilt only when the array behind it changes.
 *
 * Indexed rather than scanned, and this is not premature. measure() asks
 * desktopBox() once for the item and once for every fence it tests, and
 * stackRoot() asks measure() for every item on the board - so a linear `find()`
 * in here is a third power in the caller, on the layout where the board is
 * usually largest. Keyed on the array's identity because layout.js replaces
 * `board.layouts[mode]` wholesale rather than mutating it (writeLayout,
 * completeLayout, captureLayout all assign), which makes identity an exact
 * test for "this is stale" and costs one comparison.
 */
/**
 * The Desktop index and the array it was built from. `from` is the staleness
 * test described above, not data - it is compared by identity and never read.
 */
type DesktopIndex = { from: Geometry[] | null, map: Map<string, Geometry> };

let desktopCache: DesktopIndex = { from: null, map: new Map() };
function desktopIndex() {
  const list = board.layouts?.desktop || [];
  if (desktopCache.from !== list) {
    desktopCache = { from: list, map: new Map(list.map(g => [g.id, g])) };
  }
  return desktopCache.map;
}

const areaOf = (box: Box | null | undefined) => Math.abs((box?.w || 0) * (box?.h || 0));

/**
 * The fence an item is inside, or null.
 *
 * Measured by the item's centre falling within the fence, and remembered. Not
 * recomputed on demand, for the reason sticky.js gives at length and which
 * matters more here: a fence is dragged across a board full of loose cards, and
 * a relation that re-measured on every question would have it hoover up
 * everything it passed over. Only picking up the card itself asks again - or
 * resizing the fence, which is refence()'s other caller.
 *
 * Furniture is never in a fence. A fence drawn around the hint cards would own
 * four items that are about to delete themselves, and one drawn over the title
 * card would tow a singleton that is not on the Mobile board at all. Same
 * exclusion sticky.js makes, for the same two reasons.
 */
export function fenceOf(it: Boxed | null | undefined): Item | null {
  if (!it || isFurniture(it)) return null;
  if (fences.has(it.id)) {
    const id = fences.get(it.id);
    if (id === null) return null;
    // The typeof is what byId() used to do for nothing - see the same line in
    // sticky.ts. A record seeded out of a file need not be a string.
    const fence = typeof id === 'string' ? byId(id) : undefined;
    // A remembered fence that is no longer on the board - deleted, or undone
    // back out of existence. Measuring again is the lesser evil, exactly as it
    // is for a note whose host has gone.
    if (fence && isFence(fence)) return fence;
    fences.delete(it.id);
  }
  const fence = measure(it);
  // An unmeasurable item (no Desktop record yet) leaves the memo alone rather
  // than recording a null it has no grounds for.
  if (fence === undefined) return null;
  fences.set(it.id, fence ? fence.id : null);
  return fence;
}

/**
 * The smallest fence containing this item's centre, null for none, undefined for
 * "cannot be measured here".
 *
 * A fence may only be contained by a fence of strictly greater area. Two fences
 * the same size cannot each be inside the other, which is what makes the
 * containment chain a strict order and the walks below terminate as a property
 * rather than an assumption.
 */
function measure(it: Boxed): Item | null | undefined {
  // The common board has no fences on it at all - every board saved before this
  // existed is that board - and stackRoot() asks this of every item. One scan
  // for a type is cheaper than the work below, and skipping it keeps the cost of
  // the feature at zero for anyone not using it.
  if (!board.items.some(isFence)) return null;
  const box = desktopBox(it);
  if (!box) return undefined;
  const nested = isFence(it);
  let best: Item | null = null;
  let bestArea = Infinity;
  for (const other of board.items) {
    if (!isFence(other) || other.id === it.id) continue;
    const rect = desktopBox(other);
    if (!rect) continue;
    const area = areaOf(rect);
    if (area >= bestArea) continue;
    if (nested && area <= areaOf(box)) continue;
    if (!pointInItem(box.x, box.y, rect)) continue;
    best = other;
    bestArea = area;
  }
  return best;
}

/**
 * The smallest fence a bare world point falls inside, or null.
 *
 * measure()'s rule with no item to ask about - the same smallest-wins walk, so a
 * point in a nested region answers with the nested one. Not memoised, because
 * the only caller is a menu opening: once per right-click is not a hot path, and
 * a point has no identity to remember an answer against.
 *
 * Desktop only, like everything else here. On Mobile a fence is a band with its
 * cards packed underneath, so "inside it" names a strip of the column rather
 * than the region, and nothing that reads this offers its action there.
 */
export function fenceAt(x: number, y: number): Item | null {
  let best: Item | null = null;
  let bestArea = Infinity;
  for (const it of board.items) {
    if (!isFence(it)) continue;
    const rect = desktopBox(it);
    if (!rect) continue;
    const area = areaOf(rect);
    if (area >= bestArea || !pointInItem(x, y, rect)) continue;
    best = it;
    bestArea = area;
  }
  return best;
}

/**
 * Forget what these items were in, so the next question measures again.
 *
 * Called with the ids a gesture *drove* - what the pointer or the arrow keys
 * actually had hold of - and never with the followers those ids dragged along.
 * That distinction is the feature: a card carried across the board by the fence
 * around it has not moved relative to anything and must not be re-parented,
 * while a card you picked up and put down has been, and must.
 *
 * The other caller is a fence being resized, which passes the fence's *members*
 * rather than the fence: it is their answer that changed, not its.
 */
export function refence(ids: Iterable<string>) {
  for (const id of ids) fences.delete(id);
}


/**
 * A batch of items has arrived on the board; ask again around any fence in it.
 *
 * Every door that puts a fence back needs this and none of them would notice on
 * their own. Removing a fence heals itself - fenceOf() finds the id it remembers
 * naming nothing on the board and measures again - but *arriving* does not,
 * because what the cards underneath are holding is a remembered `null`, which is
 * a real answer rather than a gap. So an undone delete would put a fence back
 * around contents that still believed they were loose.
 *
 * Three callers: adding items, undoing a delete, and restoring from the bin.
 * They are one function rather than three copies of the box arithmetic, which is
 * the same reason isFurniture() exists.
 *
 * Desktop only, since membership is measured there and nowhere else. A restore
 * that happens on a phone leaves the memo exactly as meta.fence seeded it.
 */
export function refenceArrivals(items: Item[] | null | undefined) {
  if (board.layoutMode === 'mobile') return;
  refenceAround((items || []).filter(isFence)
    .map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot || 0 })));
}

/**
 * Forget the membership of everything a fence that changed size could have
 * changed the answer for: whatever lies inside it as it was, or as it now is.
 *
 * This is the resize half of the rule at the top of this file, and the union of
 * the two rectangles is exactly the set whose answer can have moved. Cards that
 * were inside and no longer are must be let go; cards that are inside and were
 * not must be picked up. Anything outside both is untouched, which is what stops
 * a resize in one corner of the board from re-parenting the other corner.
 *
 * Both boxes are Desktop rectangles. The caller only reaches this while Desktop
 * is the live layout, because a fence on Mobile is a band the packer owns and
 * dragging its edge is not a statement about what belongs to it.
 */
export function refenceAround(boxes: (Box | null | undefined)[]) {
  const rects = boxes.filter((b): b is Box => !!b);
  if (!rects.length) return;
  for (const it of board.items) {
    if (isFurniture(it)) continue;
    const box = desktopBox(it);
    if (!box) continue;
    if (rects.some(rect => pointInItem(box.x, box.y, rect))) fences.delete(it.id);
  }
}

/**
 * Seed the memo from what a loaded board wrote down.
 *
 * `meta.fence` is the durable record, stamped at serialize time, and seeding it
 * here does two jobs. The small one is sticky.js's: a pixel of geometry drift
 * across a save and reload must not lose a grouping somebody plainly made.
 *
 * The large one is that a board opened straight into Mobile has no Desktop
 * geometry to measure against until the user switches modes, so for that board
 * this *is* the membership - there is nothing else. Which is also why a record
 * naming furniture is dropped rather than seeded, and why a record naming a
 * fence that is no longer there is left to fall through to measurement.
 */
export function seedFences() {
  fences.clear();
  // Unknown rather than string, as in seedSticks(): `meta.fence` out of a file
  // is whatever the file said, and this asks whether it names furniture without
  // first insisting it is the kind of thing that could.
  const furniture = new Set<unknown>([TITLE_ID]);
  for (const it of board.items) if (isFurniture(it)) furniture.add(it.id);
  for (const it of board.items) {
    if (isFurniture(it) || !it.meta || !('fence' in it.meta)) continue;
    const id = it.meta.fence ?? null;
    fences.set(it.id, id && !furniture.has(id) ? id : null);
  }
}

/** The items directly inside a fence, in board order. Not its nested contents. */
export function fenceMembers(fenceId: string) {
  return board.items.filter(it => fenceOf(it)?.id === fenceId);
}

/**
 * The Mobile column as an ordered list of runs: a band, then the cards under it.
 *
 * `[{ band: fenceItem | null, items: [...] }]`, with the bandless run last and
 * holding everything in no fence. The caller packs each run below the one before
 * it, which is what makes a band a barrier and a run contiguous.
 *
 * **The order of the runs is the arrangement's order, read through their
 * members.** A run's rank is the earliest position any of its contents holds in
 * the list it was handed, so under `date` the fence holding the oldest card
 * comes first and under `shuffle` the runs shuffle. That keeps
 * `layouts.mobile.arrangement` meaning exactly what it has always meant - an
 * order, not a shape - and adds no setting: the sort key is derived from an
 * order that already exists.
 *
 * Loose cards go last rather than interleaved. The fenced regions are the
 * structure somebody made; the unfenced remainder is the inbox, and an inbox
 * belongs at the bottom. Interleaving is the alternative and would make every
 * stray its own run, which complicates the barrier for a gain nobody has asked
 * for.
 *
 * Nesting flattens: a fence inside a fence becomes its own band immediately
 * after its parent's own cards, so it reads as a subsection. The barrier rule is
 * the same one level down and needs no case of its own.
 *
 * Membership is read through byId() rather than off the items handed in, and
 * that is not defensive. The caller passes *fitted copies* - the same items with
 * Mobile geometry already written onto them - and measuring containment against
 * those would ask where a card sits on the layout being built rather than on the
 * Desktop board, which is the one place membership means anything.
 */
export function mobileRuns(items: Item[]): { band: Item | null, items: Item[] }[] {
  const rank = new Map(items.map((it, index) => [it.id, index]));
  const kids = new Map<string, Item[]>(items.filter(isFence).map(f => [f.id, []]));
  const roots: Item[] = [];
  for (const it of items) {
    const parent = fenceOf(byId(it.id) || it);
    // Non-null: guarded by has() on the same line, and nothing deletes from it.
    (parent && kids.has(parent.id) ? kids.get(parent.id)! : roots).push(it);
  }
  // A fence sorts where its earliest content does, so an empty one keeps its own
  // place rather than sinking to the end. Memoised because the walk is called
  // once per comparison and a deep nest would otherwise re-walk its whole
  // subtree every time.
  const ranks = new Map<string, number>();
  const rankOf = (it: Item): number => {
    // Non-null: has() on the line above, and nothing deletes from this map.
    if (ranks.has(it.id)) return ranks.get(it.id)!;
    let best = rank.get(it.id) ?? 0;
    ranks.set(it.id, best);                       // breaks any cycle before it runs
    for (const kid of kids.get(it.id) || []) best = Math.min(best, rankOf(kid));
    ranks.set(it.id, best);
    return best;
  };
  const runs: { band: Item | null, items: Item[] }[] = [];
  const emit = (list: Item[]) => {
    for (const it of [...list].sort((a, b) => rankOf(a) - rankOf(b))) {
      if (!isFence(it)) continue;
      const members = kids.get(it.id) || [];
      runs.push({ band: it, items: members.filter(m => !isFence(m)) });
      emit(members);
    }
  };
  emit(roots);
  const loose = roots.filter(it => !isFence(it));
  if (loose.length || !runs.length) runs.push({ band: null, items: loose });
  return runs;
}

/** The stem every unnamed fence is given, numbered. */
const FENCE_NAME = 'Untitled fence';

/**
 * The name a new fence opens with.
 *
 * A fence starts named for the same reason it opens with its name field ready to
 * type into: the name is the whole point of drawing one, and a board of blank
 * plates is a board where nothing can be referred to. A default is the version of
 * that which survives somebody pressing Escape.
 *
 * One past the highest number in use, rather than the lowest number free. Filling
 * a gap would give a *new* region a name a different region had last week - in
 * the file, in a screenshot, in somebody's memory of where a thing was - and the
 * only thing the counter owes anyone is that two fences never share a name.
 */
export function nextFenceName() {
  const numbered = new RegExp(`^${FENCE_NAME} (\\d+)$`, 'i');
  let top = 0;
  for (const it of board.items) {
    if (!isFence(it)) continue;
    const found = numbered.exec((it.name || '').trim());
    if (found) top = Math.max(top, +found[1]);
  }
  return `${FENCE_NAME} ${top + 1}`;
}

/**
 * The rectangle a new fence should occupy, from a drawn area, a set of items, or
 * both. `{ x, y, w, h }` about its centre, or null when handed neither.
 *
 * The only function here that makes a fence rather than measuring one, and it is
 * here rather than in commands.js because the union rule below is the same
 * containment rule the rest of the file enforces, seen from the other end: a
 * fence has to *start* holding what it was drawn to hold.
 *
 * Two boxes go in and the larger survives on each edge. The drawn rectangle is
 * taken exactly as drawn - somebody put that edge there - while the items are
 * given a step of padding, so a fence made from a selection alone has a margin
 * rather than sitting flush against the cards. Which is also why the union is
 * needed at all: the marquee catches anything it *overlaps* (itemInRect), so a
 * card can perfectly well poke out of the rectangle that selected it, and a
 * fence cut to the rectangle would open not containing its own contents.
 */
export function fenceBox(rect: Bounds | null | undefined, bounds: Bounds | null | undefined, pad: number) {
  const boxes: Bounds[] = [];
  if (rect) boxes.push(rect);
  if (bounds) {
    boxes.push({
      x0: bounds.x0 - pad, y0: bounds.y0 - pad,
      x1: bounds.x1 + pad, y1: bounds.y1 + pad,
    });
  }
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.x0));
  const y0 = Math.min(...boxes.map(b => b.y0));
  const x1 = Math.max(...boxes.map(b => b.x1));
  const y1 = Math.max(...boxes.map(b => b.y1));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * The ids that have to come along when `ids` are moved.
 *
 * Transitive, so a fence inside a fence brings its own contents: a region reads
 * as one object, and having to move it in two goes would be the surprise. It
 * goes one way only - dragging a card does not tow the fence around it - and the
 * walk cannot loop, because containment requires strictly greater area.
 *
 * Anything already moving is left out, which is what keeps this from fighting a
 * marquee: a card caught by the same rubber band as its fence is moved once, by
 * the selection, instead of once by the selection and again as a follower.
 */
export function fenceFollowers(ids: Iterable<string>) {
  const moving = new Set(ids);
  const pool = board.items.filter(it => !moving.has(it.id) && !isFurniture(it));
  const out: string[] = [];
  // Passes rather than one sweep: a card can only join once whatever contains it
  // has joined, and the pool is in no particular order.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const fence = fenceOf(pool[n]);
      if (!fence || !moving.has(fence.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}
