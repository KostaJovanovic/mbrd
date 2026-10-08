# Boards inside boards — 7 October 2026

**Status: done, 2026-10-08.** Approved by the maintainer on 2026-10-08 with
every recommendation below taken, and built the same day in v0.672 to v0.677.
Each step under "Order of work" says what was built and where it differs.
Not built: the zoom in and out of the card's frame. Not checked on a phone or
in the apps: Android's Back, the phone's trail, touch drags onto a board card.

Item 18 of `features-2026-10-07.md`. Decided there and not reopened here: a
child board lives **inside** its parent's `.mbrd`, a board card opens its
child, and a breadcrumb leads back.

## What somebody sees

- **Make one.** "New board inside" in the board's right-click menu and in the
  `+` flyout puts a **board card** at the pointer: a card the size of a
  photograph, showing the child board small, with its name along the foot. It
  starts empty and titled "Untitled board". "Put in a new board" on a
  selection does the same and moves the selected cards into it, one undo step.
- **Go in.** Double-click or `Enter` on the card, or Open in its menu. The
  child fills the screen with a short zoom out of the card's own frame. The
  masthead becomes a **breadcrumb**: `Kitchen › Tiles › Grout`, each part a
  button back to that level. `Alt+↑`, the browser's Back button and Android's
  Back go up one level.
- **Inside, a child is a whole board.** Its own title, cards, connections,
  fences, look settings, tour and view. Its history is its own as well. What it
  shares with the parent is the file, the shelf entry and the pictures'
  storage. Its look **follows the parent's by default** ("Same look as the
  board above", on in the Look panel). An unticked child keeps its own.
- **Coming back out** zooms back into the card, which now shows the child as
  it was left.
- **Moving cards between levels.** Drag a card onto a board card and hold for
  a moment: it goes inside, to the middle of the child's view. Inside, "Move up
  a level" in a card's menu sends it out beside the board card. Both are
  single undo steps, on the board they leave.
- **One file.** Save, autosave, Save As, share, cloud sync and the shelf all
  handle the whole tree, from wherever you are in it. Opening the file opens it
  at the top. The shelf shows the top board's thumbnail and counts nothing
  inside it. Export (image, PDF, SVG, JSON Canvas) is of the board on screen,
  whichever level that is.
- **Deleting a board card** deletes its child with it, into the bin as one
  entry. Restored, it comes back whole. Emptying the bin is the only thing that
  ends a child.
- **Duplicate and copy-paste** copy the child with it, deeply, with new ids.
  Merging or dropping in another `.mbrd` brings its children as well.

## The file

```
kitchen.mbrd
├── manifest.json            "requires": ["boards"] — only while the tree has a child
├── board.json               the top board; a board card is an item of type "board"
├── boards/<id>/board.json   one child, the same shape as a top board.json
├── boards/<id>/timeline/…   its history, as timeline/ is for the top
├── boards/<id>/notes/…      its sticky notes as Markdown, as notes/ is
├── boards/<id>/thumbnail.webp   the child small, for the card that opens it
├── assets/…                 every picture of every level, deduped once
└── waveforms/…              likewise
```

- **A board card** is `{ "type": "board", "meta": { "board": "<id>" } }`. The id
  names a directory under `boards/`. Children nest by the same rule: a
  grandchild's directory is `boards/<id>/`, flat, never `boards/<a>/boards/<b>/`,
  so a path never grows with the depth and every child is one hop from the
  root. Which board holds which is said only by the board cards, so the tree
  can't disagree with itself.
- **`assets/` stays one shared directory.** A picture used on three levels is
  stored once. This is also why a child cannot be a nested `.mbrd`: that would
  store the photograph again.
- **The `requires` entry is the point.** An older build would open the top
  board, draw each board card as a plain named card, and on its next save
  write the file back **without `boards/`**, dropping every child with no
  warning. That is the one thing the format says may not degrade, and it is
  the case `requires` was put in the format to catch, empty, years ahead. So a
  file with a child says `"requires": ["boards"]`, and every build since that
  gate shipped refuses it with "this board needs a newer mbrd". A file with no
  child doesn't say it, and older builds keep opening it.
- **Limits, written down rather than argued later:** 8 levels deep, 200
  children a file. Past either, the menu entries are absent. A file claiming
  more is read up to them and the rest reported. A child whose directory is
  missing is a board card saying so, never a crash. A board card naming a
  directory already claimed by another card (two cards, one child) opens the
  same child from both, and the first save splits it into two copies, so the
  tree is a tree again.
- `mbrd-format.md` gets a section for `boards/`, the `board` item type and the
  `requires` name, in the same commit as the reader.

## How it is built, where

- **State.** `state.ts` keeps the open board as `board`, exactly as now, and
  gains a stack of where it is: `path: string[]`, the ids from the top. Every
  module that reads `board` reads the level on screen without knowing there
  are levels, which is most of the app. The other levels are held as parsed
  board objects in a map beside it (`children`), not mounted. A child is a
  board-sized object of its own, never merged into the parent's `items`.
- **Entering and leaving** is `board:load` with the child, through the same
  path an open takes, minus the file. The renderer, the spatial index, the
  web, Find and the timeline all already rebuild on `board:load`. The view
  each level was left at is kept in the stack, so coming back out lands where
  you were.
- **Saving.** `storage/mbrd.ts` packs the top `board.json` and then every child
  from the map, the one on screen taken from `board`. **`itemHashes()` and
  `boardAssetHashes()` both walk every level**: the CLAUDE.md rule for a new
  class of asset reference, and the assertion in `tests/mbrd.test.js` that
  binds the two walks gets a child in its fixture. Otherwise the cloud sync
  stops uploading a child's pictures and the board comes back on another
  machine with holes in it.
- **The desktop and Android apps** change nothing: a board is still one file,
  written by `saveDocument()`. The rolling `.autosave` copies are copies of
  that file and so of the whole tree.
- **The board card's renderer** is one entry in `RENDERERS`, drawing the
  child's `thumbnail.webp` (refreshed whenever you leave the child), or a
  plain card with the child's title before one exists. The painter for Safari
  draws the same thumbnail. The capture needs nothing new.
- **Undo** is per level and follows the board, as it already follows `board`.
  Moving a card up or down is recorded on the level it leaves, together with
  the edit to the board card's child, as one step.
- **The breadcrumb** is the masthead's own field (`ui/board-title.ts`) showing
  the path when it is longer than one. On a phone, the parent's name and a
  back arrow.
- **Writers that must ask `notUsersBoard()`** — entering and leaving write
  the session's position. They go through the same guard as everything else.

## Order of work

1. The format: read and write `boards/`, the `requires` gate, the limits, the
   asset walks and their assertion, `mbrd-format.md`. Tested with fixtures:
   round trip, missing child, shared directory, too deep, too many, and an
   older build's refusal path.
2. State: the path, the children map, enter and leave through `board:load`,
   the view per level. *Built (v0.673):* `enterBoard()` / `leaveBoard()` in
   `state.ts`, with `levelSwap()` telling each `board:load` listener that is
   about the file (its name, picture, save button, sync latch) to stay put.
   The file's name is `fileTitle()`, the top board's. One departure: the
   session does not remember the level, so a reload opens at the top, as
   opening the file does. Nothing is written on the way in or out, which is
   why neither asks `notUsersBoard()`.
3. The board card: type, renderer, painter, menu entries, "New board inside".
   *Built (v0.674):* `commands/boards.ts`; "New board inside" in the board's
   right-click menu and the phone's More menu (there is no `+` flyout on the
   bar to put it in); "Open board" and double-click or `Enter` on the card;
   "Up a level" in the board's menu. Departures: the key is **Alt+Shift+↑**,
   because Alt+↑ already steps the keyboard focus to the next card up; the
   card's picture is *contained*, not cropped, since a child is as often tall
   as wide; the card's name and the child's title are one name, each taking
   the other's on the way in and out; and a save writes only the children a
   board card still reaches, which is what ends a child whose card was undone
   away or left with an emptied bin. The zoom in and out of the card's frame
   is not built. "Put in a new board" moves cards between levels, so it is in
   step 5.
4. The breadcrumb, `Alt+↑`, Back on the web and on Android.
   *Built (v0.675):* `ui/board-path.ts`. The trail is its own small bar under
   the menu button rather than the masthead's field, since on the canvas the
   masthead is the title card, which belongs to the board on screen; on a
   phone it is the one button back to the board above. A desktop browser's
   Back pops an entry pushed on the way in, and a way out by hand takes those
   entries back quietly. On a phone, an installed copy and both apps, Back
   goes through `main.ts`'s `onBack`, which comes up a level once nothing is
   left open to close. A tap on a board card in the Feed opens it.
5. Moving cards between levels, delete and restore, duplicate, copy-paste and
   merge carrying children.
   *Built (v0.676):* a drag held 0.7 s over a board card rings it, and a
   release there sends the cards inside; "Put in a new board", "Move into ›"
   and "Move up a level" in a card's menu. Each is one step on the board left,
   and none goes through the bin. Lines among the cards go with them; lines
   out of the group end. Duplicate, paste (the clipboard holds the boards
   under a copied card, and their pictures' bytes) and merging a dropped
   `.mbrd` copy every board under a board card, under new ids. Delete and
   restore needed nothing new: a card in the bin still reaches its board.
   Departures: cards sent into a board land to the right of what it holds,
   not in the middle of its last view, which a document does not know the
   size of; moves are canvas only, as a card's place on the Feed is the
   column's; and the board a card lands on starts its history afresh, since
   its stored steps never saw the card arrive and would replay a board
   without it.
6. "Same look as the board above".
   *Built (v0.677):* first row of the Look panel, inside a child only. A child
   that follows is dressed in the look of the board above each time it is
   opened, without a step or a dirty mark. Any choice made in its Look panel
   makes the look its own, which is a new `ownLook` key in its `board.json`
   (`mbrd-format.md`). Pigments read off the pictures by Dynamic do not count
   as a choice.

## Questions for the maintainer

Answered on 2026-10-08: the recommendation, in all four. Find stays on the
board on screen, a tour does not step into a child, the card shows the child's
thumbnail, and "Move to its own board" waits for a later round.

1. **Find across levels.** Find searches the board on screen. Should it also
   find cards in children and take you there? Recommended: later, as its own
   item. It changes Find's results from "here" to "somewhere", and that
   deserves its own design.
2. **The tour** is per board. Should a tour be able to step into a child?
   Recommended: no, not in this item.
3. **A board card's look:** the child's thumbnail (as designed), or a folder-
   like card with a peek of the thumbnail? Recommended: the thumbnail. It is
   what makes a child findable by eye.
4. **"Open as its own board".** Should a child be liftable out into a separate
   file and shelf entry? Recommended: yes, in a later round, as "Move to its
   own board".
