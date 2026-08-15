// The connections half of the command surface: drawing lines between cards.
//
// The tool that arms, the generator behind "Join these", the mark a press puts
// on a line, and the four small edits a marked line accepts (direction, style,
// label, removal). One contiguous run of the object in commands.ts, lifted
// whole - see commands/file.ts for why the five runs became five files, and for
// why the merge cannot change what any of them does.
//
// ── Where the rest of a connection lives ──
//
// The shape of one - the pair key, the CONN_* tables, the normaliser - is
// board-model.ts. Every write to board.connections is connections.ts at the top
// level, which is the mutation half and sits below the mutation door. The
// routing and the drawing are canvas/web.ts, and the spanning tree behind Join
// these is web-graph.ts. What is *here* is only which gesture reaches which of
// those, which is what a command is.
//
// Note the two names: this file is `commands/connections.ts` and there is a
// `connections.ts` at the top level. They are the two ends of the same feature
// and neither is misnamed - one is the door a person presses, the other is the
// write it turns into.
//
// ── What must not move in here ──
//
// The hit test. connectionAt() is canvas/web.ts's, walking the routed points it
// already holds, and the note over toggleConnection() explains at length why a
// line is deliberately not a selectable object. A second, richer hit test in
// here would be that decision quietly reversed.

import { toast } from '../notify.ts';
import {
  addConnections, board, clearConnections, connectionMeta, isFence, isFurniture,
  areConnected, isJoinEnd, isRider, selection, setSetting, toggleConnection,
  updateConnection,
} from '../state.ts';
import { threads } from '../web-graph.ts';
import {
  activeConnection, clearActiveConnection, connectionAt, setActiveConnection,
} from '../canvas/web.ts';
import { ask } from '../ui/dialog.ts';
// The editor that follows the marked line. Kept true from here for the two
// moves that change the mark without redrawing it - see pickConnection.
import { syncConnChip } from '../ui/conn-chip.ts';
import { connectArmed, connectTap, setArmed } from '../ui/toolbar.ts';

/* The line this file used to carry here was a cast of setArmed, because
   ui/toolbar.ts was unchecked and its `from = null` default inferred the
   parameter as `null` rather than as "an item id or nothing". Its own comment
   said the day toolbar.ts was annotated the line goes and nothing else does.
   toolbar.ts is annotated - setArmed(on: boolean, from: string | null = null) -
   so the line has gone, and nothing else did. */

/* ConnMeta comes from board-model.ts, which is where the four closed lists and
   the type struck from them live. This file declared its own `{ label?: string }`
   under the same pressure conn-chip.ts did, and a second spelling of a closed
   list is how a list stops being closed. Reading one field of it is not a reason
   to describe it again. */
import type { ConnMeta } from '../board-model.ts';

/** A world point, which is all the two hit-testing commands take. */
interface At {
  x: number;
  y: number;
}

/** Enough of an item for the generator: an id and a box. */
interface Joinable {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

/**
 * Make sure the board is showing its connections, before drawing one.
 *
 * The migration nobody would otherwise notice. `settings.web` defaults to on
 * now, but a board saved by any earlier build carries an explicit `false` -
 * every board that never had the automatic web switched on does - and absence
 * of the key is the only case the new default reaches. Without this, somebody
 * on an existing board would press Join, pick two cards, and be shown nothing:
 * the connection is there, the setting is hiding it, and there is no way to
 * guess that from the screen.
 *
 * So arming the tool, or asking the generator for a set, turns the switch on.
 * You cannot ask for a line to be drawn and mean "but not shown", and the
 * checkbox is still one click away in View for anyone who wants them hidden
 * afterwards. Silent because it is not a decision - it is the tool refusing to
 * be pressed into doing nothing visible.
 */
function showConnections(): void {
  if (board.settings.web === false) setSetting('web', true);
}

/**
 * What may carry a line, out of some set of items.
 *
 * Furniture is out because a hint card relates to nothing - it is talking to
 * the person, not to the board - and the title card is the board's name. Riders
 * are out because a stuck note is part of the card it is pinned to, and the web
 * layer will not draw a line to one anyway. Fences are out because a line to a
 * region is a line to no particular card, and the generator would spend edges
 * joining boxes to the things already inside them.
 *
 * One predicate rather than three copies of it: both doors into the generator
 * ask the same question, and so does the tool when it reads the selection.
 */
/**
 * The most cards "Connect these" will join when nothing is selected.
 *
 * The selection case is bounded by what somebody picked. The no-selection case
 * is the whole board, and the spanning tree it runs is quadratic with nothing
 * in front of it - DENSE_LIMIT gates the second pass only. This is generously
 * past any board a person has arranged by hand and comfortably inside what the
 * arithmetic can do without the tab going quiet.
 */
const CONNECT_ALL_MAX = 2000;

const joinable = (items: Joinable[]): Joinable[] =>
  items.filter(i => !isFurniture(i) && !isRider(i) && !isFence(i) && isJoinEnd(i));

/**
 * Run the generator over a pool of cards and say what it drew.
 *
 * The spanning tree that used to *be* the web, turned into real connections -
 * the same ones a hand would have drawn, editable and removable one at a time
 * afterwards. One undo entry for the set, because you asked for a set.
 *
 * The graph works in the same plane the cards do; y is not flipped for it the
 * way canvas/web.js flips it to draw, because a reflection cannot turn a
 * non-crossing set into a crossing one and the tree is the same tree.
 */
function joinAll(pool: Joinable[], label = 'Join cards'): number {
  showConnections();
  const pts = pool.map(i => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, rot: i.rot || 0 }));
  const made: number = addConnections(
    threads(pts).map(([a, b]) => [pts[a].id, pts[b].id]),
    label);
  toast(made
    ? `Joined ${made} pair${made === 1 ? '' : 's'}`
    : 'Those are already joined');
  return made;
}

export function connectionCommands() {
  return {
    // The one tool on the bar that is a mode. Pressing it arms; pressing it
    // again, or Escape, puts it down. What a press on the board then means is
    // ui/toolbar.js's connectStep(), and canvas/input.js asks through the two
    // below rather than importing a ui/ module it has no business importing -
    // the same seam the title card's pen and the whimsy dial already use.
    connect: () => {
      if (board.layoutMode === 'mobile') {
        toast('Connections are a canvas thing');
        return;
      }
      if (connectArmed()) { setArmed(false); return; }
      // A selection made before the tool was pressed is already an answer to
      // "which cards", and the tool used to throw it away and ask again. So it
      // is read once, here, at the moment of arming - not on every press, which
      // would make what a click means depend on what happened to be picked
      // three clicks ago.
      //
      // Two selected or twenty is the generator's question, not the tool's, so
      // it goes straight to joinAll: you pointed at a set and asked for it to be
      // joined, and the answer is a set of lines in one undoable step. Exactly
      // one selected is half a pair, so it becomes the picked end and the next
      // card you press completes it.
      //
      // Armed either way, and that is the point of doing it here rather than in
      // a separate command: what follows the join is more joining, on the same
      // board, with the same tool already in your hand.
      const picked = joinable(board.items.filter((i: Joinable) => selection.has(i.id)));
      setArmed(true, picked.length === 1 ? picked[0].id : null);
      showConnections();
      if (picked.length > 1) { joinAll(picked); return; }
      toast(picked.length
        ? 'Now pick the card to join that one to'
        : 'Pick two cards to join them. Same two again to part them.');
    },
    connectArmed,
    connectTap,
    // Give a connection a direction, a line style or a label.
    //
    // No button, like connectSelection below and for the same reason its comment
    // gives: editing a line means first pointing at one, and this app leaves
    // connections deliberately un-hit-testable (see toggleConnection in
    // state.js - the machinery a selectable line needs was judged too much for
    // it). So this is the door a keyboard binding or a future menu row would bind
    // to, and today it is reached from the console handle:
    //
    //   mbrd.cmds.setConnectionStyle(a, b, { dir: 'fwd', style: 'dashed', label: 'leads to' })
    //
    // where a and b are the two card ids. `dir` is one of none/fwd/back/both,
    // read against the pair's stored order; `style` one of solid/dashed/dotted;
    // `label` any short string, '' to clear it. A patch that names only some of
    // the three leaves the rest as they were.
    setConnectionStyle: (a: string, b: string, patch?: object | null) => {
      // The two failures are told apart, because they mean different things and
      // the caller is a person at a console. updateConnection() answers false
      // for both "no such pair" and "that patch changed nothing" - connMeta()
      // is an allowlist, so `{ dir: 'sideways' }` is dropped whole - and this
      // used to report the first message for the second case while committing
      // an "Edit connection" that changed nothing.
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
    // The menu's way in: the connection whose line runs under a right-click, or
    // null. This is the hit-test toggleConnection's note said it was avoiding -
    // kept as small as that note asked, a walk over the routed points web.js
    // already holds rather than a selection model or a per-line element. Only on
    // the canvas, where a press lands on the board rather than on a card.
    connectionUnder: (at: At) => (board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y)),
    // Draw-or-part again, from the menu rather than the tool: the pair is joined,
    // so toggling parts them. Its own undo entry, like the tool's.
    removeConnection: (a: string, b: string) => { toggleConnection(a, b); },
    // ---- the line the board is pointing at ----
    //
    // A press on a line marks it, and the mark is what gives Delete something to
    // delete that is not a card. The hit-test is connectionUnder's, the mark
    // lives in canvas/web.js beside the hover it is the deliberate half of, and
    // it is deliberately not part of the selection - see the note over
    // activeConnection() there.
    //
    // Returns whether a line was found, which is what lets the press path tell a
    // click on a connection from a click on bare board. Called with nothing
    // under the pointer it clears the mark, so one call covers both.
    pickConnection: (at: At) => {
      const hit = board.layoutMode === 'mobile' ? null : connectionAt(at.x, at.y);
      setActiveConnection(hit ? hit.a : null, hit ? hit.b : null);
      // setActiveConnection redraws the mark, and the chip follows the mark - so
      // this is only here for the press that lands on nothing while nothing was
      // marked, which changes neither and would leave a stale chip up.
      syncConnChip();
      return !!hit;
    },
    activeConnection: () => activeConnection(),
    clearActiveConnection: () => { clearActiveConnection(); syncConnChip(); },
    // Delete's half. Answers whether there was one, so the key can fall through
    // to deleting the selection when there was not.
    deleteActiveConnection: () => {
      const at = activeConnection();
      if (!at) return false;
      clearActiveConnection();
      toggleConnection(at.a, at.b);
      return true;
    },
    // The label is the one connection setting that is not a choice from a short
    // list, so it is asked for rather than picked. null is every way out of the
    // box including an empty one; the way to clear a label is the menu's Remove
    // label, which sets it to '' through the same door.
    editConnectionLabel: async (a: string, b: string) => {
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
    // Every line off the board at once. In the panel's Debug fold rather than on
    // the toolbar: the way to remove one connection is to draw over it, and this
    // is the board-wide broom you want after trying the generator somewhere you
    // did not mean to. Undoable, so it says what it did rather than asking first.
    clearConnections: () => {
      const gone = clearConnections();
      toast(gone
        ? `Removed ${gone} connection${gone === 1 ? '' : 's'}`
        : 'There are no connections on this board');
    },
    /**
     * Join these for me.
     *
     * The spanning tree that used to *be* the web, run once on demand and
     * turned into real connections - the same ones a hand would have drawn,
     * editable and removable one at a time afterwards. Over the selection when
     * there is one worth calling a selection, over the whole board otherwise,
     * which is the same "everything, whatever happens to be picked" split
     * rearrange/rearrangeSelection already make.
     *
     * **No button**, and it no longer needs one for the case it was written for:
     * pressing the connector tool with two or more cards selected runs the same
     * generator over them, which is the shape somebody who has just picked a set
     * of cards actually reaches for. What survives here is the *whole board*
     * half - the thing you do once to a board rather than a tool you reach for,
     * which sat on the toolbar as a seventh segment that made the bar read as a
     * menu. The console handle is a shipped feature, and this is still the door
     * a keyboard binding or a menu row would bind to if either ever wants it.
     *
     * It is also the migration. A board that had the automatic web switched on
     * lost it the day connections became a stored list; this is how it comes
     * back, as something that can then be argued with.
     *
     * What is left out - furniture, riders, fences - is `joinable`'s answer, and
     * the same one the tool gets when it reads the selection.
     */
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
      // The no-selection case is the whole board, and the spanning tree under
      // joinAll() is O(n squared) distance tests with nothing gating it -
      // DENSE_LIMIT in web-graph.ts gates only the *second* pass, which the
      // guard's own comment gets backwards. On a board near MAX_ITEMS that is
      // about 4x10^8 tests on the main thread, after which addConnections()
      // throws all but MAX_CONNECTIONS of the result away.
      //
      // Refused rather than truncated: "connect everything" over twenty
      // thousand cards is not a thing anybody means, and a silent sample of it
      // would be a web nobody asked for over cards nobody chose.
      if (selection.size < 2 && pool.length > CONNECT_ALL_MAX) {
        toast(`Too many cards to join at once - select up to ${CONNECT_ALL_MAX} of them`);
        return;
      }
      joinAll(pool);
    },
  };
}
