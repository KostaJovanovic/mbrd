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
  board, boardTags, byId, cleanTag, isContent, isFurniture, isLocked, isRider,
  itemTags, selection, setItemCover, setItemFit, setItemUpAxis, setItemsLocked,
  setItemsTagged, setStickerTint, setTourMembers, unstickItems, TAG_MAX, TAGS_PER_ITEM,
} from '../state.ts';
import { ask } from '../ui/dialog.ts';
import { defaultUpAxis, meshKind } from '../mesh.ts';
import { stickerTint } from '../stickers/catalogue.ts';
import { getAsset } from '../storage/assets.ts';
import { pickCover } from '../import/drop.ts';
import { isTurning, rotateModel } from '../canvas/model.ts';
import { canView, openViewer } from '../ui/viewer.ts';
import { canEditPicture, openDarkroom } from '../ui/darkroom.ts';
import { resetSize } from '../ui/board-actions.ts';

/**
 * The members of the selection a lock can be put on: everything but furniture.
 *
 * A free function rather than a fourth entry in the object, because it is not a
 * command - nothing outside this file asks it, and the three entries that do
 * would otherwise have to reach for each other through the surface they are
 * being built into.
 */
const lockable = () => board.items.filter(i => selection.has(i.id) && !isFurniture(i));

/**
 * The members of the selection a tag can go on.
 *
 * isContent(), which is narrower than lockable()'s test by one type: a fence
 * cannot be tagged. A region is already a name drawn round a group - tagging
 * one would be a second, invisible grouping over the top of a visible one, and
 * the by-tag arrangement would then have to decide whether a fence goes in its
 * own tag's block or carries its contents, which is a question with no good
 * answer. setItemsTagged() applies the same test at the door.
 */
const taggable = () => board.items.filter(i => selection.has(i.id) && isContent(i));

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
    canUnstick: () => board.items.some(i => selection.has(i.id) && isRider(i)),
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

    /**
     * Fix the selection where it is, or let it go.
     *
     * Selection-wide and not single-item, which puts it with unstick above
     * rather than with the picture rows: "lock these nine so I can arrange on
     * top of them" is the sentence, and it is the same sentence for one.
     *
     * The pair the menu draws its row from answers three states rather than two
     * - none locked, some, all - because a mixed selection has to offer
     * something unambiguous. It offers Lock: locking a set where two of nine
     * are already locked ends with nine locked, which is what the word says,
     * where a toggle would have unlocked two of them.
     *
     * Both counts are over the *lockable* members rather than over the whole
     * selection, which is the difference that makes "all" mean anything: a
     * selection holding the title card can never have every member locked, so
     * comparing against the selection size would leave such a menu permanently
     * offering Lock on a set that is already entirely locked.
     */
    canLock: () => lockable().length > 0,
    lockableCount: () => lockable().length,
    lockedCount: () => lockable().filter(isLocked).length,
    lockSelection: (on: boolean) => {
      setItemsLocked([...selection], on);
      // Said out loud because the effect is the *absence* of something - a card
      // that no longer moves looks exactly like a card that does - and because
      // the way back is in a menu the person has just closed.
      toast(on ? 'Locked. Drag it to pan the board.' : 'Unlocked');
    },
    isLockedItem: (id: string) => isLocked(byId(id)),

    /**
     * Tags: what this card carries, what the board knows about, and the two
     * ways to change it.
     *
     * The menu draws a fold listing every tag on the board with a tick against
     * the ones on this selection, plus a row that asks for a new one. That
     * shape is why the surface is four small entries rather than one editor:
     * the second and third tag anybody adds to a board are tags that already
     * exist, and picking one off a list is the case worth making cheap.
     *
     * Every one of these is selection-wide, unlike the picture rows above.
     * "Tag these nine kitchen" is the sentence people actually say, and a tag
     * means exactly the same thing applied to one card as to nine - which is
     * the test this file's header sets for what belongs on the selection.
     */
    canTag: () => taggable().length > 0,
    boardTags: () => boardTags(),
    // Ticked when *everything* taggable in the selection carries it, so the
    // tick answers "is this true of what I have selected" rather than "is it
    // true of one of them". A partly-tagged selection therefore shows unticked
    // and the press completes it, which is the same three-state reasoning the
    // lock row uses a few entries up.
    selectionHasTag: (tag: string) => {
      const items = taggable();
      return items.length > 0 && items.every(i => itemTags(i).includes(tag));
    },
    toggleSelectionTag: (tag: string) => {
      const items = taggable();
      const on = !items.every(i => itemTags(i).includes(tag));
      setItemsTagged(items.map(i => i.id), tag, on);
    },
    /**
     * A tag that is not on the board yet.
     *
     * Asks, rather than opening an editor, because what is being collected is
     * one short string - and ask() is the app's one door for exactly that, so
     * this costs no second dialog. Comma-separated, so "blue, kitchen, 1972" in
     * one go is three tags: the separator is the one thing about the format
     * worth teaching, and cleanTag() strips commas from inside a tag so the
     * split can never be ambiguous.
     */
    addTag: async () => {
      const items = taggable();
      if (!items.length) return;
      const typed = await ask({
        title: items.length > 1 ? `Tag ${items.length} items` : 'Add a tag',
        body: 'Separate several with commas.',
        go: 'Add',
        field: { placeholder: 'kitchen, blue', maxLength: TAG_MAX * TAGS_PER_ITEM },
      });
      if (!typed) return;
      const ids = items.map(i => i.id);
      // One call per tag, and therefore one history entry per tag. That is the
      // honest count - each is a separate thing now true of these items - and it
      // means an accidental third tag is one Ctrl+Z rather than an undo that
      // takes the two good ones with it.
      for (const raw of typed.split(',')) {
        const tag = cleanTag(raw);
        if (tag) setItemsTagged(ids, tag, true);
      }
    },
    /**
     * On the tour, or off it.
     *
     * Here rather than with the four tour commands in commands/view.ts, and the
     * line between them is the one this file's header draws: those move the
     * camera, this writes board.tour. It is the same relation the tag rows have
     * to the filter rows one run over - membership is a fact about the card,
     * and what you are looking at is not.
     *
     * Selection-wide and ticked the same three-state way the tags are: checked
     * only when *everything* eligible in the selection is already a stop, so a
     * half-added selection shows unticked and the press completes it. That is
     * what makes "select six cards, add them" one gesture, and setTourMembers()
     * puts them on in the board's own stacking order rather than in whatever
     * order the selection iterates - see state.ts.
     *
     * The same eligibility as a tag: isContent(), so no fence and no title
     * card. A tour stop is a card the camera can frame and somebody can look
     * at, and a fence is already a name drawn round a group.
     */
    canTour: () => taggable().length > 0,
    selectionInTour: () => {
      const items = taggable();
      const stops = new Set(board.tour);
      return items.length > 0 && items.every(i => stops.has(i.id));
    },
    toggleSelectionTour: () => {
      const items = taggable();
      if (!items.length) return;
      const stops = new Set(board.tour);
      const on = !items.every(i => stops.has(i.id));
      setTourMembers(items.map(i => i.id), on);
      toast(on
        ? (items.length > 1 ? `${items.length} stops added to the tour` : 'Added to the tour')
        : (items.length > 1 ? `${items.length} stops taken off the tour` : 'Taken off the tour'));
    },
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

    /**
     * Crop a photograph, and grade it.
     *
     * One entry for both, because they are one dialog and one sitting - see the
     * header of ui/darkroom.ts. Single-item, like every other picture row here:
     * a crop is a rectangle over *this* picture, and there is no rectangle that
     * means anything over nine different ones.
     *
     * The predicate is the darkroom's own rather than a copy of it. It excludes
     * more than the type - an animated picture and a vector both come out - and
     * a second spelling of that list here is a menu that offers Crop on a GIF
     * the month after somebody edits one of the two.
     */
    canEditPicture: (id: string) => canEditPicture(id),
    editPicture: (id: string) => openDarkroom(id),

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
