// Board commands: boards inside the board - make one, go into one, come back
// out, send cards from one to another. The tree, the level change and the
// moves are state.ts's (enterBoard, leaveBoard, moveIntoBoard, ...);
// what is here is the gesture's half: the picture taken on the way out, the
// refusals while a tour or the Timeline holds the board.

import { toast } from '../notify.ts';
import {
  board, byId, select, selection, childOf, enterBoard, leaveBoard, newChildBoard, canMakeChild, atTop,
  boardPath, timelinePlaying, putInNewBoard, moveIntoBoard, moveUpLevel, undoAction,
} from '../state.ts';
import { flushNoteEdit } from '../canvas/notes.ts';
import { boardThumb } from '../ui/snapshot.ts';
import { settleHistory } from '../ui/board-path.ts';
import { tourActive } from '../ui/tour.ts';
import { tourEditing } from '../ui/tour-edit.ts';
import type { Point } from '../arrange/arrangements.ts';

/** What a card's menu acts on: the selection when the card is in it, else the card. */
const picked = (id: string) => new Set(selection.has(id) ? selection : [id]);

/** A tour shows the board and the Timeline replays it: neither steps levels. */
const held = () => tourActive() || tourEditing() || timelinePlaying();

/** Where a card goes with no pointer to put it at: the middle of the view. */
type Centre = () => Point;

/** A way out is under way: the picture is being taken. One press, one level. */
let leaving = false;

export function boardCommands(centre: Centre) {
  return {
    isBoardCard: (id: string) => !!childOf(byId(id)),
    canNewBoard: () => canMakeChild(),
    /** "New board inside", at the pointer or the middle of the view. */
    newBoard: (at: Point | null = null) => {
      if (held()) return;
      const card = newChildBoard(at ?? centre());
      if (card) select([card.id]);
      else toast('This board can hold no more boards inside it');
    },
    /** Into the board a board card opens. */
    openBoard: (id: string) => {
      const child = childOf(byId(id));
      if (!child || held()) return;
      flushNoteEdit();
      if (!enterBoard(child)) toast('That board cannot be opened from here');
    },
    /** The board cards a card could be moved into: every one on this board
     *  but those being moved. */
    boardCardsBesides: (id: string) => {
      const moving = picked(id);
      return board.items
        .filter(it => childOf(it) && !moving.has(it.id))
        .map(it => ({ id: it.id, name: it.name || 'Untitled board' }));
    },
    putInNewBoard: (id: string) => {
      if (held()) return;
      const card = putInNewBoard(picked(id));
      if (card) select([card.id]);
    },
    moveIntoBoard: (id: string, cardId: string) => sendInto(picked(id), cardId),
    /** A drag held over a board card and let go there. */
    dropIntoBoard: (ids: readonly string[], cardId: string) => sendInto(ids, cardId),
    moveUpLevel: (id: string) => {
      if (held()) return;
      const n = moveUpLevel(picked(id));
      if (n) toast(`Moved ${n} card${n === 1 ? '' : 's'} up a level`, '', undoAction());
    },
    canLeaveBoard: () => !atTop(),
    /** Back out one level, with the child's picture for its card. */
    leaveBoard: () => leaveTo(boardPath().length - 1),
    /** Back out to `level`, 0 being the top: the trail's buttons. */
    leaveTo,
  };
}

/** Cards into the board a board card on this one opens, said with an undo. */
function sendInto(ids: Iterable<string>, cardId: string) {
  if (held()) return;
  const n = moveIntoBoard(ids, cardId);
  if (n) toast(`Moved ${n} card${n === 1 ? '' : 's'} into ${byId(cardId)?.name || 'the board'}`, '', undoAction());
}

/**
 * Out, one level at a time to `level`, each taking its own picture on the way
 * for the card that opens it. Then the history entries going in pushed, which
 * are behind the board on screen now (ui/board-path.ts).
 */
async function leaveTo(level: number) {
  if (atTop() || held() || leaving) return;
  leaving = true;
  try {
    flushNoteEdit();
    while (boardPath().length > Math.max(0, level)) {
      const thumb = await boardThumb().catch(() => null);
      if (!leaveBoard(thumb)) break;
    }
  } finally {
    leaving = false;
  }
  settleHistory();
}
