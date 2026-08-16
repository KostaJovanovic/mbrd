// Lines between two cards, drawn by hand - the half that changes them.
//
// The list is `board.connections` - unordered pairs of item ids, top-level
// because items are shared across both layouts while geometry is not (see
// board-model.js). That module owns the *shape* of a connection: pairKey(),
// MAX_CONNECTIONS, the CONN_* tables, connMeta() and normalizeConnections().
// This one owns every write to the list, and the index that makes asking about
// it cheap. The split is the same one sticky.js and fences.js have with the
// mutations that act on their answers: a question about what a thing is, and a
// separate place where it is changed.
//
// **Dangling is tolerated, not prevented,** and that one decision is why there
// is no bookkeeping here for delete, undo, trash or restore. A connection whose
// item is not on the board is simply not drawn; the item comes back and its
// connections come back with it, because they never left. Every alternative -
// stripping pairs on delete and restoring them on undo, or refusing to let an
// item go while something points at it - is a second undoable thing to get
// right at four call sites, to arrive at the same picture.
//
// The pruning happens once, at the edges: on the way into a file and on the way
// out of one, against the items that file actually holds (live *and* binned).
// So nothing accumulates on disk, and nothing is lost while the app is running.
// Both of those edges are in board-schema.js, and neither is here on purpose -
// a module that prunes while the app runs is a module that quietly loses work.
//
// Every write below is one commit(), never one per pair. That is not a
// performance note: you asked for a set of connections, or for a board to be
// cleared, and one Ctrl+Z has to take back what you asked for. Forty separate
// entries would also be forty of the history limit spent on a single button
// press, which is to say the rest of the session's undo thrown away.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { toast } from './notify.ts';
import { bus } from './board-store.ts';
import { commit } from './history.ts';
import { cue } from './cuelume/engine.ts';
import { board, pairKey, connMeta, MAX_CONNECTIONS } from './board-model.ts';
import type { Connection, ConnMeta } from './board-model.ts';

/**
 * key -> true for every pair on the board, rebuilt lazily.
 *
 * The same arrangement byId() has with board.items, for the same reason: the
 * array is the truth and an index maintained by hand is one missed write away
 * from lying. `connections` is the only event that can change membership, so it
 * is the only one that drops this.
 */
let connIndex: Set<string> | null = null;

function connKeys() {
  if (!connIndex) {
    connIndex = new Set();
    for (const [a, b] of board.connections) connIndex.add(pairKey(a, b));
  }
  return connIndex;
}
bus.on('connections', () => { connIndex = null; });
bus.on('board:load', () => { connIndex = null; });

/** The one way the list is replaced: assign, then announce. */
const write = (list: Connection[]) => {
  board.connections = list;
  bus.emit('connections');
};

/** Whether these two cards are joined. Order does not matter. */
export const areConnected = (a: string, b: string) =>
  !!a && !!b && connKeys().has(pairKey(a, b));

/** The ids joined to this one. Linear, and called once per reroute. */
export function connectedTo(id: string) {
  const out: string[] = [];
  for (const [a, b] of board.connections) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

/**
 * Join these two, or part them if they are already joined.
 *
 * One function rather than a connect and a disconnect, because it is one
 * gesture: the connector tool run again on a pair that already has a line is
 * how a line is removed. The alternative was making connections selectable,
 * which means hit-testing a path in canvas/input.js and a selection model
 * holding things that are not items - a great deal of machinery for a delete
 * key. See research/old/toolbar-2026-08-03.md.
 *
 * Returns whether the pair is connected now, so the caller can say which of the
 * two things just happened.
 */
export function toggleConnection(a: string, b: string) {
  if (!a || !b || a === b) return false;
  const key = pairKey(a, b);
  const had = connKeys().has(key);
  if (!had && board.connections.length >= MAX_CONNECTIONS) {
    toast('That is as many connections as one board can hold', 'error');
    return false;
  }
  const before = board.connections;
  const after: Connection[] = had
    ? board.connections.filter(p => pairKey(p[0], p[1]) !== key)
    : [...board.connections, [a, b]];
  commit(had ? 'Remove connection' : 'Connect',
    () => write(after), () => write(before));
  // A line drawn and a line parted are the same recipe with the glide inverted,
  // which is as close as this app gets to saying a thing and its opposite.
  cue(had ? 'fall' : 'rise');
  return !had;
}

/**
 * Add several at once, skipping the ones already there. One undo entry.
 *
 * The generator's door (cmds.connectSelection). One commit rather than one per
 * pair for the reason swapAssets() gives: you asked for a set of connections
 * and one Ctrl+Z has to take back a set, and forty separate entries would also
 * be forty of the history limit spent on a single button press.
 *
 * Returns how many were actually new, which is what the toast reports.
 */
export function addConnections(pairs: Iterable<[string, string]> | null | undefined, label = 'Connect') {
  const keys = connKeys();
  const fresh: Connection[] = [];
  const taken = new Set();
  for (const [a, b] of pairs || []) {
    if (!a || !b || a === b) continue;
    const key = pairKey(a, b);
    if (keys.has(key) || taken.has(key)) continue;
    // Checked before the push, not after: at capacity the old order pushed one
    // pair before breaking, leaving board.connections one past MAX_CONNECTIONS.
    if (board.connections.length + fresh.length >= MAX_CONNECTIONS) break;
    taken.add(key);
    fresh.push([a, b]);
  }
  if (!fresh.length) return 0;
  const before = board.connections;
  const after = [...board.connections, ...fresh];
  commit(label, () => write(after), () => write(before), fresh.length);
  // One cue for the set, as it is one commit for the set: forty lines drawn by
  // one button press is one thing happening, not forty.
  cue('rise');
  return fresh.length;
}

/**
 * Take every line off the board, in one undoable step.
 *
 * The board-wide counterpart to drawing over a pair, and the answer to the one
 * thing the generator makes easy to regret: running it on a board you did not
 * mean to leaves forty lines that would otherwise be forty trips with the Join
 * tool. Returns how many went, so the caller can say.
 *
 * One commit rather than one per pair, for the reason swapAssets() gives: you
 * asked to clear a board and one Ctrl+Z has to give a board back.
 */
export function clearConnections(label = 'Remove all connections') {
  const before = board.connections;
  if (!before.length) return 0;
  commit(label, () => write([]), () => write(before), before.length);
  cue('fall');
  return before.length;
}

/**
 * Change how one connection is drawn - its direction, line style or label.
 *
 * The edit door that pairs with toggleConnection's draw-or-part. `patch` is
 * merged over the connection's current settings and run back through connMeta(),
 * so the same validation the file reader applies also gates a live edit, and a
 * patch that sets everything back to a default leaves a bare `[a, b]` again. One
 * commit, and it emits 'connections' like the others - which is what makes
 * canvas/web.js repaint the line with its new look. No geometry changes, so the
 * cached route is reused; only the drawing is redone.
 *
 * Returns whether a matching connection was found to edit.
 */
export function updateConnection(a: string, b: string, patch: ConnMeta) {
  if (!a || !b) return false;
  const key = pairKey(a, b);
  const idx = board.connections.findIndex(p => pairKey(p[0], p[1]) === key);
  if (idx < 0) return false;
  const cur = board.connections[idx];
  const meta = connMeta({ ...(cur[2] || {}), ...patch });
  const nextPair: Connection = meta ? [cur[0], cur[1], meta] : [cur[0], cur[1]];
  // Nothing to record when nothing moved. connMeta() is an allowlist and drops
  // whatever it does not recognise, so a patch of `{ dir: 'sideways' }` came
  // out of it identical to what was already stored - and this committed an
  // "Edit connection" onto the undo stack for it and told the caller it had
  // worked. Compared as JSON because a ConnMeta is five optional strings and
  // connMeta() writes them in a fixed order, so two equal metas serialise the
  // same way.
  if (JSON.stringify(cur[2] ?? null) === JSON.stringify(meta)) return false;
  const before = board.connections;
  const after = board.connections.map((p, i) => (i === idx ? nextPair : p));
  commit('Edit connection', () => write(after), () => write(before));
  return true;
}

/** The display settings of one connection, or null if it is a plain line. */
export function connectionMeta(a: string, b: string): ConnMeta | null {
  if (!a || !b) return null;
  const key = pairKey(a, b);
  const found = board.connections.find(p => pairKey(p[0], p[1]) === key);
  return found?.[2] || null;
}
