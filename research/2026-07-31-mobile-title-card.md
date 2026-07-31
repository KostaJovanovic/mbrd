# The invisible card on the Mobile board

Found 2026-07-31 by dragging a sticky note on a snapped Mobile board: it came to
rest against something that was not on the screen.

**What it was.** The Desktop title card. `canvas/items.js` deliberately leaves it
out of the Mobile mount pass (the masthead above the column is Mobile's title),
but it is still an item, and `completeLayout('mobile')` used to keep whatever
geometry it had on Desktop. `TITLE_DEFAULT_POS` is y 244; the Mobile board's top
edge is 384 with the first packed row just beneath it. So an unrendered 256x171
box sat across the middle columns of the first three rows of every Mobile board.

Nothing drew it and everything else could feel it:

- `stuckTo()` is geometry, not DOM, so a note dropped up there became a **rider
  of a card that cannot be seen, selected or moved on this layout** - confirmed
  in a scratch run: `isRider` true, host `__title__`.
- `mobilePackStartRow()` measures the first free row from the highest obstacle,
  so every import onto a phone board started four or five spaces down with a
  screen of blank column above it.
- Snapped drags met a collision with no card at the other end of it.

**The fix, in three places.**

1. `completeLayout('mobile')` parks it one row above the board's top edge instead
   of copying its Desktop place. That geometry is never drawn on Mobile, so its
   only job is to be out of everything else's way.
2. `fitMobile()` returns the title untouched. Its clamp - `y <= boardTop - inset
   - h/2` - is what dragged the parked card back down to flush with the first
   row, which is exactly where the trouble was.
3. `placeMobileItems()` drops `type === 'title'` from its obstacle list, and
   `cmds.fit` drops it from the Mobile fit. Belt and braces for the first, and
   the second is the same reasoning as the mount pass: fitting the view to a card
   nobody can see would zoom out to make room for nothing.

Desktop is untouched - `board.layouts.desktop` still holds the real place, and
switching back restores it.
