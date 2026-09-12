// Note stickiness: which note is stuck to what, and what travels when
// something moves. Stickiness is measured from live geometry and memoised
// until the note itself is handled — moving a host does not re-parent.
// meta.stuckTo seeds the memo on load; meta.loose is the only stored override
// (the user unstuck it on purpose). Nothing here commits — mutations in state.ts.

import { overlapFraction } from './geometry.ts';
import { isRecord } from './util.ts';
import { board, byId, isFurniture, TITLE_ID } from './board-model.ts';
import type { Item } from './board-model.ts';
import { isFence } from './fences.ts';

/** Anything with a place and a size: an item, or one layout's record of one. */
type Box = { x: number, y: number, w: number, h: number };

/** Structural subset of Item so command modules' box-shaped types also fit. */
type Stickable = Box & { id: string, rot?: number, z?: number, meta?: Record<string, unknown> };

/**
 * A note cannot stick to furniture or fences (double-move, Mobile band issues).
 * Stickers are the exception — they may stick to fences and the title card
 * (decoration that rides), but not to ghosts (deleted on first real content).
 */
const cannotHost = (it: Item, rider: unknown) => {
  if (isRecord(rider) && rider.type === 'sticker') return it?.type === 'ghost';
  return isFurniture(it) || isFence(it);
};

/** Notes and stickers — the two types that stick. One list so stuckTo() and stuckFollowers() stay in sync. */
export const isSticky = <T>(it: T | null | undefined): it is T & { type: 'note' | 'sticker' } =>
  isRecord(it) && (it.type === 'note' || it.type === 'sticker');

// ---------------------------------------------------------------------------
// Sticky notes that stick
//
// Measured from geometry, memoised until the note is handled. Moving a host
// does not re-parent its riders. The memo is a runtime Map — older .mbrd files
// with no meta.stuckTo simply measure on first ask.
// ---------------------------------------------------------------------------

/** 5% overlap floor — low so a corner-placed sticky counts, nonzero so a drag-past does not. */
export const STICK_MIN = 0.05;

/** noteId -> hostId or null. Null = measured, stuck to nothing (must not re-measure). */
const sticks = new Map<string, unknown>();

/**
 * The item this note is stuck to, or null. Measured by overlap area (>STICK_MIN).
 * Only real items below the note in z qualify — furniture and fences excluded.
 * Memoised: only picking up the note itself re-measures.
 */
export function stuckTo(note: Stickable | null | undefined): Item | null {
  if (!isSticky(note)) return null;
  // meta.loose outranks the memo — user explicitly unstuck this.
  if (note.meta?.loose) return null;
  if (sticks.has(note.id)) {
    const id = sticks.get(note.id);
    if (id === null) return null;
    // Seeded value from a file may not be a string — guard before lookup.
    const host = typeof id === 'string' ? byId(id) : undefined;
    // Host deleted or undone — re-measure rather than leave the note permanently orphaned.
    if (host) return host;
    sticks.delete(note.id);
  }
  const host = measureStick(note);
  sticks.set(note.id, host ? host.id : null);
  return host;
}

function measureStick(note: Stickable): Item | null {
  let best: Item | null = null;
  for (const it of board.items) {
    if (cannotHost(it, note) || it.id === note.id || (it.z || 0) >= (note.z || 0)) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(note, it) > STICK_MIN) best = it;
  }
  return best;
}

/**
 * What a box would stick to if dropped here. Same rule as measureStick but for
 * a box not yet on the board (drag preview). Not guarded by meta.loose — a
 * loose note dropped on a card is the way back from Unstick. `rider` widens
 * the host rules for stickers (see cannotHost).
 */
export function wouldStick(
  box: { x: number, y: number, w: number, h: number, rot?: number },
  excludeId?: string,
  rider?: { type?: string } | null,
): Item | null {
  let best: Item | null = null;
  for (const it of board.items) {
    if (cannotHost(it, rider) || it.id === excludeId) continue;
    if (best && (it.z || 0) < (best.z || 0)) continue;
    if (overlapFraction(box, it) > STICK_MIN) best = it;
  }
  return best;
}

/** Measure without the meta.loose guard. For resettle() deciding whether to clear the flag. */
export function hostUnder(it: Stickable | null | undefined) {
  return isSticky(it) ? measureStick(it) : null;
}

// ---------------------------------------------------------------------------
// Setting
//
// A freshly dropped note is stuck (travels with host) but not yet pinned
// (press still grabs the note itself). After SETTLE_MS it "sets" and a press
// redirects to the host. No timer — readers compare against a drop timestamp.
// Runtime only: a loaded board is already set.
// ---------------------------------------------------------------------------

/** Grace period before a drop becomes a pin. Long enough to adjust, short enough to remember. */
export const SETTLE_MS = 10_000;

/** id -> when it was last let go. Absent means set, which is the ordinary case. */
const settling = new Map();

/** Mark these ids as freshly dropped. Only driven ids, not towed followers. */
export function startSettling(ids: Iterable<string>) {
  const now = Date.now();
  for (const id of ids) settling.set(id, now);
}

/** Is this item still lying where it was dropped rather than set to it? */
export function isSettling(it: { id: string } | null | undefined) {
  const at = it && settling.get(it.id);
  if (at === undefined) return false;
  if (Date.now() - at < SETTLE_MS) return true;
  // Swept lazily — no timer needed, every id is checked within frames of mattering.
  settling.delete(it!.id);
  return false;
}

/** How long until this item sets, in ms. Zero once it has. */
export function settlesIn(it: { id: string } | null | undefined) {
  const at = it && settling.get(it.id);
  return at === undefined ? 0 : Math.max(0, SETTLE_MS - (Date.now() - at));
}

/** Stuck *and* set — null during the settle window after a drop. */
const pinnedTo = (it: Stickable | null | undefined) => (isSettling(it) ? null : stuckTo(it));

/** Is this item pinned? Three callers (drag, keys, geometry commands) read this with different responses. */
export const isPinned = (it: Stickable | null | undefined) => !!pinnedTo(it);

/**
 * Walk up the pin chain to find the root host — a press on a sticker on a note
 * on a photo should move the photo. Stops at the first non-pinned item.
 * Visited set guards against cycles (should be impossible, but runs on pointerdown).
 */
export function dragRoot(it: Item): Item {
  const seen = new Set<string>([it.id]);
  for (let host = pinnedTo(it); host; host = pinnedTo(it)) {
    if (seen.has(host.id)) break;
    seen.add(host.id);
    it = host;
  }
  return it;
}

/** Clear the memo for driven ids so the next stuckTo() re-measures. Never called for towed followers. */
export function restick(ids: Iterable<string>) {
  for (const id of ids) sticks.delete(id);
}


/**
 * Seed the memo from meta.stuckTo so saved stickiness survives geometry drift
 * across a reload. Records naming furniture are dropped — they predate the
 * exclusion and the memo would never re-measure them. Also clears settle clocks
 * (a loaded board is fully set).
 */
export function seedSticks() {
  sticks.clear();
  // A loaded board is fully set — stale settle stamps would unpin everything for 10s.
  settling.clear();
  // Unknown — file values are not guaranteed to be strings.
  const furniture = new Set<unknown>([TITLE_ID]);
  for (const it of board.items) if (isFurniture(it)) furniture.add(it.id);
  for (const it of board.items) {
    if (isSticky(it) && it.meta && 'stuckTo' in it.meta) {
      const hostId = it.meta.stuckTo ?? null;
      // Self-reference and furniture records are dropped.
      sticks.set(it.id, furniture.has(hostId) || hostId === it.id ? null : hostId);
    }
  }
  breakCycles();
}

/**
 * Break cycles in the seeded memo. measureStick() is acyclic by z-order, but
 * the memo trusts meta.stuckTo — a self-reference or mutual pair would put
 * dragRoot() in an infinite loop. Three-colour walk: null the entry that
 * closes the loop, keep everything below it.
 */
function breakCycles() {
  const settled = new Set<unknown>();
  for (const start of sticks.keys()) {
    if (settled.has(start)) continue;
    const path = new Set<unknown>();
    let at: unknown = start;
    // SAFETY: `at` is a sticks key (string) when non-null — typed unknown because
    // values are not guaranteed to be keys.
    while (at != null && !settled.has(at)) {
      if (path.has(at)) {
        sticks.set(at as string, null);
        break;
      }
      path.add(at);
      at = sticks.get(at as string) ?? null;
    }
    for (const id of path) settled.add(id);
  }
}

/** Offset as fraction of host size — survives the host being resized across layouts. */
function stuckOffset(note: Box, host: Box) {
  return { fx: (note.x - host.x) / (host.w || 1), fy: (note.y - host.y) / (host.h || 1) };
}

/** Place a stuck note in the target layout using its fractional offset from the source layout. */
export function stuckPlacement(note: Box, hostSrc: Box, hostDst: Box) {
  const off = stuckOffset(note, hostSrc);
  return { x: hostDst.x + off.fx * hostDst.w, y: hostDst.y + off.fy * hostDst.h };
}

/** A note stuck to something still on the board - one that rides, not packs. */
export function isRider(it: Stickable) {
  return isSticky(it) && !!stuckTo(it);
}

/**
 * Place riders in a target layout via multi-pass resolution (note-on-note chains).
 * Returns ids that never resolved (deleted host / cycle) for fallback placement.
 */
export function attachRiders<T>(
  riders: Item[],
  place: Map<string, T>,
  build: (note: Item, hostSrc: Item, hostDst: T) => T,
) {
  const pending = new Set(riders.map(r => r.id));
  for (let grew = true; grew && pending.size;) {
    grew = false;
    for (const note of riders) {
      if (!pending.has(note.id)) continue;
      const host = stuckTo(note);
      if (!host) { pending.delete(note.id); continue; }
      if (pending.has(host.id)) continue;        // host is a rider, not placed yet
      const hostDst = place.get(host.id);
      if (!hostDst) continue;                     // host not laid out yet this pass
      // Use `host` directly — stuckTo() already returned the live item.
      place.set(note.id, build(note, host, hostDst));
      pending.delete(note.id);
      grew = true;
    }
  }
  return pending;
}

/**
 * Transitive followers: notes/stickers stuck to anything in `ids`, recursively.
 * Items already in `ids` are excluded to avoid double-moving in multi-select.
 */
export function stuckFollowers(ids: Iterable<string>) {
  const moving = new Set(ids);
  const pool = board.items.filter(i => isSticky(i) && !moving.has(i.id));
  const out: string[] = [];
  // Multi-pass: a note joins only after its host has joined.
  for (let grew = true; grew;) {
    grew = false;
    for (let n = pool.length - 1; n >= 0; n--) {
      const host = stuckTo(pool[n]);
      if (!host || !moving.has(host.id)) continue;
      moving.add(pool[n].id);
      out.push(pool[n].id);
      pool.splice(n, 1);
      grew = true;
    }
  }
  return out;
}

