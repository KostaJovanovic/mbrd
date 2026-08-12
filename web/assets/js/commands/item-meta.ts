// The per-item half of the command surface: what one card, specifically, can be
// asked to do.
//
// Open it full size, edit its note, take it off what it is stuck to, put its
// size back, give it a cover or take one away, fill or fit its picture, stand a
// model up the other way, turn one, tint a sticker. One contiguous run of the
// object in commands.ts, lifted whole - see commands/file.ts for why the five
// runs became five files.
//
// ── Why it is mostly pairs ──
//
// Nearly every entry here is a `can*` predicate and the setter it guards, and
// that shape is the right-click menu's doing rather than a habit. ui/menu.ts
// builds its rows from this surface and has no other way to know whether a row
// applies: it asks `canCoverItem(id)` and only then offers Set cover. So the
// predicate is as much a part of the command as the action, and separating the
// two - the predicate in the menu, the action here - would put the rule that
// says "only a track wears a cover" in a file about drawing menus.
//
// The predicates are also deliberately *narrower than the model*. setItemCover()
// will dress any card and state.ts says why; canCoverItem() offers it on audio
// alone, so a picture an older build put on a note still draws and no new one
// can be added. That gap is on purpose and is the one thing to be careful of
// when editing this file: widening a `can*` is a product decision, not a tidy-up.
//
// ── What must not move in here ──
//
// The writes. setItemCover, setItemFit, setItemUpAxis and setStickerTint are all
// state.ts's, and every one of them is undoable through the mutation door. What
// is here is which card is eligible and what the menu should tick.
//
// Nor the selection-wide actions. Raise, lower, duplicate, delete and the
// alignments read `selection` and stayed in commands.ts; `unstick` is the one
// exception in this file and it is here because its predicate, canUnstick(), is
// the same shape as everything around it and reads the same menu.

import { toast } from '../notify.ts';
import {
  board, byId, isRider, selection, setItemCover, setItemFit, setItemUpAxis,
  setStickerTint, unstickItems,
} from '../state.ts';
import { defaultUpAxis, meshKind } from '../mesh.ts';
import { stickerTint } from '../stickers/catalogue.ts';
import { getAsset } from '../storage/assets.ts';
import { pickCover } from '../import/drop.ts';
import { isTurning, rotateModel } from '../canvas/model.ts';
import { canView, openViewer } from '../ui/viewer.ts';
import { resetSize } from '../ui/board-actions.ts';

export function itemMetaCommands() {
  return {
    /**
     * One item, full size, on either layout.
     *
     * Routed through cmds so canvas/input.js can reach it off a double-click
     * without importing a ui/ module, which is the arrow this file exists to
     * turn around. The Feed calls openViewer() directly - it is a ui/ module
     * itself and a tile tap is not a command anybody would bind.
     */
    openViewer: (id: string) => { if (canView(id)) openViewer(id); },
    canViewItem: (id: string) => canView(id),
    canEditNote: (id: string) => byId(id)?.type === 'note',
    /**
     * Is there anything in the selection that is stuck to a host?
     *
     * Stuck, not pinned - isRider() rather than isPinned(). An item dropped
     * three seconds ago is stuck and has not set yet (see sticky.js), and
     * Unstick during that window is a real thing to want: it is how you say
     * "leave this here but do not fix it", without waiting for it to fix itself
     * so that you can unfix it.
     *
     * The selection rather than the item under the cursor, because Unstick acts
     * on the selection - "these nine are all stuck to that photograph and I
     * want them off it" is the same sentence for one as for nine.
     */
    canUnstick: () => board.items.some((i: { id: string }) =>
      selection.has(i.id) && isRider(i)),
    /**
     * The sticker colour row: is this one item a sticker, what colour is it,
     * and set it.
     *
     * Single-item, like the picture and fit rows above and for the same reason
     * - it is an edit to one thing, and the menu has nowhere to show a tick for
     * nine stickers that are three different colours.
     */
    canTintSticker: (id: string) => byId(id)?.type === 'sticker',
    stickerTintOf: (id: string) => {
      const it = byId(id);
      return it ? stickerTint(it.meta?.tint, it.meta?.shape) : 1;
    },
    setStickerTint: (id: string, tint: number) => setStickerTint(id, tint),
    /**
     * Take the selection off whatever it is stuck to and leave it where it is.
     *
     * The only way off a host that is not dropping the item on something else,
     * and deliberately without a matching "stick to this card": putting it on
     * the card is already how you say that, and a menu entry for it would be a
     * second vocabulary for a gesture that works.
     */
    unstick: () => unstickItems([...selection]),
    resetSize,
    // Album art, and nothing else. A cover is the picture a card that cannot be
    // looked at borrows so it can be recognised from across the board, and in
    // practice that card is a track: the art usually arrives inside the file
    // (import/artwork.js), and this is how one that came without any gets it.
    // Offering the same thing on a note or a link put a picture behind words
    // that were already legible, which is a card wearing a costume rather than
    // a card that has something to show.
    //
    // The model is deliberately wider than the offer - setItemCover() dresses
    // any card, and state.js says why - so a picture an older build put on
    // something else still draws. canClearCover is how it comes back off.
    canCoverItem: (id: string) => byId(id)?.type === 'audio',
    itemHasCover: (id: string) => !!byId(id)?.meta?.cover,
    // Anything already wearing one, except a video: a video's cover is the
    // poster frame the importer grabs and the optimiser repairs, not a choice
    // somebody made, and taking it away would only mean the board makes it again.
    canClearCover: (id: string) => {
      const it = byId(id);
      return !!it?.meta?.cover && it.type !== 'video';
    },
    setCover: (id: string) => pickCover(id),
    clearCover: (id: string) => setItemCover(id, null),

    // Fill (crop to the card) or fit (whole picture in) - only photos and videos.
    // itemFit reports the *effective* fit (the item's own override, else the
    // board-wide default), which is what the menu ticks; setItemFit pins it.
    canSetFit: (id: string) => {
      const type = byId(id)?.type;
      return type === 'image' || type === 'video';
    },
    itemFit: (id: string) => {
      const own = byId(id)?.meta?.fit;
      if (own === 'cover' || own === 'contain') return own;
      return board.mediaFit === 'contain' ? 'contain' : 'cover';
    },
    setItemFit: (id: string, fit: string) => setItemFit(id, fit),

    // Only models, and only the formats where the answer is not already written
    // down: glTF fixes Y-up in its spec, so offering to argue with it would be
    // offering to break it.
    canFlipUpAxis: (id: string) => {
      const it = byId(id);
      if (it?.type !== 'model') return false;
      const kind = meshKind(getAsset(it.asset?.hash)?.name || it.name || '');
      return kind === 'obj' || kind === 'stl';
    },
    flipUpAxis: (id: string) => {
      const it = byId(id);
      if (!it) return;
      const kind = meshKind(getAsset(it.asset?.hash)?.name || it.name || '');
      // Written out rather than toggled between "set" and "unset", so the board
      // records the reading it is actually using. A .mbrd that says nothing means
      // "whatever this version guesses", and a guess that changed between
      // versions would silently lie a model down that somebody had stood up.
      const now = it.meta?.upAxis === 'z' || it.meta?.upAxis === 'y'
        ? it.meta.upAxis : defaultUpAxis(kind);
      setItemUpAxis(id, now === 'z' ? 'y' : 'z');
      toast(now === 'z' ? 'Read as Y-up' : 'Read as Z-up');
    },
    // Every model card is a photograph of itself until this is asked for - see
    // canvas/model.js. Offered on any model, including one that has never been
    // photographed and is already live: the entry is how somebody learns the card
    // can be turned at all, and asking for it while it is already turning is a
    // no-op rather than a wrong answer. Not offered on a card that is mid-turn,
    // which would be a menu item that does nothing visible.
    canRotateModel: (id: string) => byId(id)?.type === 'model' && !isTurning(id),
    rotateModel: (id: string) => {
      rotateModel(id);
      toast('Drag the model to turn it. It settles when you click away.');
    },
  };
}
