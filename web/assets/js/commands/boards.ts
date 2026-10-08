// Board commands: boards inside the board - make one, go into one, come back
// out. The tree and the level change are state.ts's (enterBoard, leaveBoard);
// what is here is the gesture's half: the picture taken on the way out, the
// refusals while a tour or the Timeline holds the board.

import { toast } from '../notify.ts';
import {
  byId, select, childOf, enterBoard, leaveBoard, newChildBoard, canMakeChild, atTop,
  timelinePlaying,
} from '../state.ts';
import { flushNoteEdit } from '../canvas/notes.ts';
import { boardThumb } from '../ui/snapshot.ts';
import { tourActive } from '../ui/tour.ts';
import { tourEditing } from '../ui/tour-edit.ts';
import type { Point } from '../arrange/arrangements.ts';

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
    canLeaveBoard: () => !atTop(),
    /** Back out one level, with the child's picture for its card. */
    leaveBoard: async () => {
      if (atTop() || held() || leaving) return;
      leaving = true;
      try {
        flushNoteEdit();
        const thumb = await boardThumb().catch(() => null);
        leaveBoard(thumb);
      } finally {
        leaving = false;
      }
    },
  };
}
