// Connections between cards: writes, index, and toggle/batch operations.
// Dangling pairs are tolerated at runtime — pruned only at file I/O edges
// (board-schema.ts), so delete/undo needs no bookkeeping here.
// Every write is one commit(), never one per pair — one Ctrl+Z undoes the set.
// Nothing here imports state.ts (BASE layer).

import { toast } from './notify.ts';
import { bus } from './board-store.ts';
import { commit } from './history.ts';
import { cue } from './cuelume/engine.ts';
import { board, pairKey, connMeta, MAX_CONNECTIONS } from './board-model.ts';
import type { Connection, ConnMeta } from './board-model.ts';

/** Lazy index over board.connections. Rebuilt on 'connections' and 'board:load' events. */
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

/** Toggle: join if unconnected, part if already joined. Returns the new state. */
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
  // Draw and part are the same recipe with the glide inverted.
  cue(had ? 'fall' : 'rise');
  return !had;
}

/** Batch add, skipping duplicates. One commit, returns count of new pairs. */
export function addConnections(pairs: Iterable<[string, string]> | null | undefined, label = 'Connect') {
  const keys = connKeys();
  const fresh: Connection[] = [];
  const taken = new Set();
  for (const [a, b] of pairs || []) {
    if (!a || !b || a === b) continue;
    const key = pairKey(a, b);
    if (keys.has(key) || taken.has(key)) continue;
    // Check before push — the old code checked after, leaving one past MAX.
    if (board.connections.length + fresh.length >= MAX_CONNECTIONS) break;
    taken.add(key);
    fresh.push([a, b]);
  }
  if (!fresh.length) return 0;
  const before = board.connections;
  const after = [...board.connections, ...fresh];
  commit(label, () => write(after), () => write(before), fresh.length);
  // One cue for the batch, matching the single commit.
  cue('rise');
  return fresh.length;
}

/** Remove all connections in one undoable step. Returns how many were removed. */
export function clearConnections(label = 'Remove all connections') {
  const before = board.connections;
  if (!before.length) return 0;
  commit(label, () => write([]), () => write(before), before.length);
  cue('fall');
  return before.length;
}

/**
 * Remove every line touching any of these cards, in one undoable step - the
 * way to untangle a card without marking each of its lines in turn. Returns
 * how many went.
 */
export function removeConnectionsOf(ids: Iterable<string>, label = 'Remove connections') {
  const set = new Set(ids);
  const before = board.connections;
  const after = before.filter(([a, b]) => !set.has(a) && !set.has(b));
  const gone = before.length - after.length;
  if (!gone) return 0;
  commit(label, () => write(after), () => write(before), gone);
  cue('fall');
  return gone;
}

/** Two connection metas, or two plain lines, are the same styling. */
const sameConnMeta = (a: ConnMeta | null | undefined, b: ConnMeta | null | undefined) => {
  if (!a || !b) return !a && !b;
  return a.dir === b.dir && a.style === b.style && a.color === b.color
    && a.weight === b.weight && a.label === b.label;
};

/**
 * Edit a connection's style/direction/label. Patch is merged and re-validated
 * through connMeta(). Returns false if the pair was not found or nothing changed.
 */
export function updateConnection(a: string, b: string, patch: ConnMeta) {
  if (!a || !b) return false;
  const key = pairKey(a, b);
  const idx = board.connections.findIndex(p => pairKey(p[0], p[1]) === key);
  if (idx < 0) return false;
  const cur = board.connections[idx];
  const meta = connMeta({ ...(cur[2] || {}), ...patch });
  const nextPair: Connection = meta ? [cur[0], cur[1], meta] : [cur[0], cur[1]];
  // No-op if nothing actually changed (compared field by field, not as JSON).
  if (sameConnMeta(cur[2] ?? null, meta)) return false;
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
