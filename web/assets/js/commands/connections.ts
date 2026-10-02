// Connection commands: the tool, the generator, the mark, and the four
// edits a marked line accepts. The model is board-model.ts, mutations
// are connections.ts at top level, routing/drawing is canvas/web.ts.
// The hit test stays in canvas/web.ts — a richer one here would make
// lines selectable, which they deliberately are not.

import { toast } from '../notify.ts';
import {
  addConnections, board, clearConnections, connectionMeta, isFence, isFurniture,
  areConnected, isJoinEnd, isRider, selection, setSetting, toggleConnection,
  updateConnection, removeConnectionsOf, undoAction,
} from '../state.ts';
import { threads } from '../web-graph.ts';
import {
  activeConnection, clearActiveConnection, connectionAt, setActiveConnection,
} from '../canvas/web.ts';
import { ask } from '../ui/dialog.ts';
import { syncConnChip } from '../ui/conn-chip.ts';
import { connectArmed, connectTap, setArmed } from '../ui/toolbar.ts';

import type { ConnMeta } from '../board-model.ts';

/** A world point for hit-testing. */
interface At {
  x: number;
  y: number;
}

/** An id and a box — enough for the spanning-tree generator. */
interface Joinable {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

// Old boards carry an explicit `false` for settings.web; drawing a
// connection while it is off would produce an invisible line.
function showConnections(): void {
  if (board.settings.web === false) setSetting('web', true);
}

// The spanning tree is O(n^2); this caps the no-selection case.
const CONNECT_ALL_MAX = 2000;

// Items that can carry a line: no furniture, riders or fences.
const joinable = (items: Joinable[]): Joinable[] =>
  items.filter(i => !isFurniture(i) && !isRider(i) && !isFence(i) && isJoinEnd(i));

// Run the spanning-tree generator and turn the result into stored connections.
function joinAll(pool: Joinable[], label = 'Join cards'): number {
  showConnections();
  const pts = pool.map(i => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot || 0 }));
  const made: number = addConnections(
    threads(pts).map(([a, b]) => [pts[a].id, pts[b].id]),
    label);
  if (made) toast(`Joined ${made} pair${made === 1 ? '' : 's'}`, '', undoAction());
  else toast('Those are already joined');
  return made;
}

export function connectionCommands() {
  return {
    connect: () => {
      if (board.layoutMode === 'mobile') {
        toast('Connections are a canvas thing');
        return;
      }
      if (connectArmed()) { setArmed(false); return; }
      // >1 selected: run the generator as a one-shot. 1: arm with that as the first end.
      const picked = joinable(board.items.filter((i: Joinable) => selection.has(i.id)));
      showConnections();
      if (picked.length > 1) { joinAll(picked); return; }
      setArmed(true, picked.length === 1 ? picked[0].id : null);
      toast(picked.length
        ? 'Now pick the card to join that one to. Hold Shift to keep joining.'
        : 'Pick two cards to join them, or the same two again to part them. Hold Shift to keep joining.');
    },
    connectArmed,
    connectTap,
    // Set dir/style/label on a connection. Reached from the conn-chip editor.
    setConnectionStyle: (a: string, b: string, patch?: ConnMeta | null) => {
      if (!areConnected(a, b)) {
        toast('There is no connection between those two cards');
        return false;
      }
      if (!updateConnection(a, b, patch || {})) {
        toast('Nothing in that patch changes this connection');
        return false;
      }
      showConnections();
      return true;
    },
    connectionStyle: (a: string, b: string) => connectionMeta(a, b),
    // The connection under a world point, for the right-click menu.
    connectionUnder: (at: At) => (board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y)),
    removeConnection: (a: string, b: string) => { toggleConnection(a, b); },
    // Mark the connection under the pointer (or clear the mark).
    pickConnection: (at: At) => {
      const hit = board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y);
      setActiveConnection(hit ? hit.a : null, hit ? hit.b : null);
      syncConnChip();
      return !!hit;
    },
    activeConnection: () => activeConnection(),
    // Answers whether a line was marked, which Escape's mark reads (canvas/input.ts).
    clearActiveConnection: () => {
      const had = !!activeConnection();
      clearActiveConnection();
      syncConnChip();
      return had;
    },
    // Returns false when no line is marked, so Delete falls through to the selection.
    deleteActiveConnection: () => {
      const at = activeConnection();
      if (!at) return false;
      clearActiveConnection();
      toggleConnection(at.a, at.b);
      return true;
    },
    editConnectionLabel: async (a: string, b: string) => {
      // SAFETY: connectionMeta() is declared to return ConnMeta | null, so the cast only restates it.
      const current = (connectionMeta(a, b) as ConnMeta | null)?.label || '';
      const typed = await ask({
        title: 'Connection label',
        go: 'Set',
        field: { value: current, placeholder: 'e.g. leads to', maxLength: 60 },
      });
      if (typed === null) return;
      updateConnection(a, b, { label: typed });
      showConnections();
    },
    clearConnectionLabel: (a: string, b: string) => {
      updateConnection(a, b, { label: '' });
      showConnections();
    },
    /** How many lines touch the selection - what the card menu's row counts. */
    selectionLineCount: () =>
      board.connections.filter(([a, b]) => selection.has(a) || selection.has(b)).length,
    // Every line touching the selection, one undoable step: untangling a card
    // was one marked line and one Delete at a time.
    removeSelectionConnections: () => {
      const gone = removeConnectionsOf(selection);
      if (gone) toast(`Removed ${gone} connection${gone === 1 ? '' : 's'}`, '', undoAction());
    },
    // Remove every connection on the board. Undoable.
    clearConnections: () => {
      const gone = clearConnections();
      if (gone) toast(`Removed ${gone} connection${gone === 1 ? '' : 's'}`, '', undoAction());
      else toast('There are no connections on this board');
    },
    // Run the spanning-tree generator over the selection, or the whole board.
    connectSelection: () => {
      if (board.layoutMode === 'mobile') {
        toast('Connections are a canvas thing');
        return;
      }
      const pool = joinable(board.items.filter((i: Joinable) =>
        selection.size < 2 || selection.has(i.id)));
      if (pool.length < 2) {
        toast('Pick two or more cards, or put something on the board');
        return;
      }
      // O(n^2) spanning tree on the whole board — refuse rather than truncate.
      if (selection.size < 2 && pool.length > CONNECT_ALL_MAX) {
        toast(`Too many cards to join at once - select up to ${CONNECT_ALL_MAX} of them`);
        return;
      }
      joinAll(pool);
    },
  };
}
