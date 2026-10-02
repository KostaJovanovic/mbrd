// Per-item commands: viewer, note, cover, fit, bare, faded, crop, model axis,
// sticker and note tint, lock, tags, tour stops. Mostly can*/set* pairs for the
// right-click menu. Predicates are deliberately narrower than the model:
// widening a `can*` is a product decision, not a tidy-up.

import { toast } from '../notify.ts';
import {
  addTourStop, board, boardTags, byId, cleanTag, freezeClip, isContent, isFiltered, isLocked, isRider,
  rolledAway, rolledFences,
  itemTags, selection, setItemBare, setItemCover, setItemDemosaiced, setItemFaded, setItemFit,
  setItemUpAxis,
  setItemsLocked, setItemsTagged, setNoteTint, setStickerTint, unstickItems, TAG_MAX, TAGS_PER_ITEM,
} from '../state.ts';
import { noteTint } from '../canvas/note-model.ts';
import { extOf } from '../util.ts';
import { fileKey, isOversize, lift } from '../consent.ts';
import { ask } from '../ui/dialog.ts';
import { defaultUpAxis, meshKind, upAxisIsGuessed } from '../mesh.ts';
import { stickerTint } from '../stickers/catalogue.ts';
import { addFile, derivedFile, getAsset } from '../storage/assets.ts';
import { displayFor, pickCover, pickReplacement, thumbFor } from '../import/drop.ts';
import { demosaic, isRaw } from '../optimize/demosaic.ts';
import { isTurning, rotateModel } from '../canvas/model.ts';
// The card's own <video>, and the one thing in the app that reads a frame off
// an element that is already on screen. Both for keepFrame() below.
import { nodeFor } from '../canvas/items.ts';
import { frameOnScreen } from '../canvas/poster.ts';
import { canEdit, canView, openViewer } from '../ui/viewer.ts';
import { canEditPicture, openDarkroom } from '../ui/darkroom.ts';
import { resetSize } from '../ui/board-actions.ts';
import { saveBlob } from '../storage/storage.ts';
import { isDesktop } from '../platform/platform.ts';

/**
 * The members of the selection an anchor can be put on.
 *
 * Everything but a hint card, and **not a rider**: a note or a sticker that is
 * stuck to something has no geometry of its own to hold. Its position is its
 * host's, and it is recomputed from the host every time the host moves.
 *
 * Offering it was not merely meaningless, it was actively broken. A drag
 * carries whatever is stuck to what it picked up, and then filters the anchored
 * out of that set (see `moving` in canvas/input.ts, and the note there about a
 * lock that yields to an indirect drag) - so an anchored sticky did the one
 * thing a sticky must never do: the photograph slid out from under it and the
 * note stayed where it was, still claiming to be stuck to a card now somewhere
 * else on the board. The way to hold a sticky still is to anchor *the card it
 * is on*, which already works and carries the note with it.
 *
 * A free function rather than a fourth entry in the object, because it is not a
 * command - nothing outside this file asks it, and the three entries that do
 * would otherwise have to reach for each other through the surface they are
 * being built into.
 *
 * `type !== 'ghost'` rather than isFurniture(), which is the *other* half of
 * that pair and is deliberately let through. The title card is movable and has
 * a menu of its own, so it is a card somebody can want held still - and it is
 * anchored by default (makeTitleItem, state.ts), which means its own menu has to
 * be able to say so and to undo it. A hint card has neither and stays out. Same
 * test at the door, in setItemsLocked().
 */
const lockable = () =>
  board.items.filter(i => selection.has(i.id) && i.type !== 'ghost' && !isRider(i));

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

/** How near two cards' tops must be, in world units, to read as one row. */
const READING_ROW = 160;

export function itemMetaCommands() {
  return {
    /**
     * One item, full size, on either layout.
     *
     * Routed through cmds so canvas/input.ts can reach it off a double-click
     * without importing a ui/ module, which is the arrow this file exists to
     * turn around. The Feed calls openViewer() directly - it is a ui/ module
     * itself and a tile tap is not a command anybody would bind.
     */
    // The card's box goes along, so a picture can grow out of it.
    openViewer: (id: string) => {
      if (canView(id)) openViewer(id, { thumb: nodeFor(id)?.getBoundingClientRect() ?? null });
    },
    canViewItem: (id: string) => canView(id),
    /**
     * The order the viewer steps through: reading order, rows from the top
     * and left to right in each, over what is on show - not a card the tag
     * filter has faded or a rolled fence has folded away. The same sort serves
     * the Feed, whose column is laid out in exactly that order. The viewer
     * skips what it cannot show.
     */
    viewOrder: () => {
      const rolled = rolledFences();
      const top = (i: { y: number, h: number }) => Math.round((i.y + i.h / 2) / READING_ROW);
      return board.items
        .filter(i => isContent(i) && !isFiltered(i) && !rolledAway(i, rolled))
        // World y points up, so the higher row is the larger number.
        .sort((a, b) => top(b) - top(a) || a.x - b.x)
        .map(i => i.id);
    },
    /** A text document in the editor. Open and a double-click only read it; writing is asked for. */
    editDocument: (id: string) => { if (canEdit(id)) openViewer(id, { edit: true }); },
    canEditDocument: (id: string) => canEdit(id),
    canEditNote: (id: string) => byId(id)?.type === 'note',
    /**
     * Is there anything in the selection that is stuck to a host?
     *
     * Stuck, not pinned - isRider() rather than isPinned(). An item dropped
     * three seconds ago is stuck and has not set yet (see sticky.ts), and
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
     * A note's sheet, on the same single-item terms as the sticker row above.
     * A note with no stored tint draws on the first sheet, so that is the one
     * ticked for it.
     */
    canTintNote: (id: string) => byId(id)?.type === 'note',
    noteTintOf: (id: string) => noteTint(byId(id)?.meta?.tint) || 1,
    setNoteTint: (id: string, tint: number) => setNoteTint(id, tint),
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
     * selection holding a hint card, or a sticky riding on one of its own
     * members, can never have every member locked - so comparing against the
     * selection size would leave such a menu permanently offering Anchor on a
     * set that is already entirely anchored.
     */
    canLock: () => lockable().length > 0,
    lockableCount: () => lockable().length,
    lockedCount: () => lockable().filter(isLocked).length,
    lockSelection: (on: boolean) => {
      setItemsLocked([...selection], on);
      // Said out loud because the effect is the *absence* of something - a card
      // that no longer moves looks exactly like a card that does - and because
      // the way back is in a menu the person has just closed.
      // "Anchored", not "Locked" - the word the menu row uses, and the reason
      // it changed is written out beside that row in ui/menu.ts.
      toast(on ? 'Anchored. Drag it to pan the board.' : 'Unanchored');
    },
    /** The L key: the menu's pair as one press, on the menu's rule - Anchor
     *  until every lockable member is anchored, then Unanchor. */
    toggleAnchor: () => {
      const can = lockable();
      if (!can.length) return;
      const on = can.some(i => !isLocked(i));
      setItemsLocked([...selection], on);
      toast(on ? 'Anchored. Drag it to pan the board.' : 'Unanchored');
    },

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
     * The selection, added to the tour as one stop.
     *
     * Here rather than with the tour commands in commands/view.ts, and the line
     * between them is the one this file's header draws: those move the camera,
     * this writes board.tour. It is the same relation the tag rows have to the
     * filter rows one run over - membership is a fact about the cards, and what
     * you are looking at is not.
     *
     * **One stop, however many cards.** That is the whole of the editor's Add
     * button: a selection is a group somebody made, and a stop that frames the
     * group is the thing a flat list could not say. Six separate stops are
     * still reachable - add them one at a time - and the reverse would not be.
     *
     * The same eligibility as a tag: isContent(), so no fence and no title
     * card. A tour stop is a card the camera can frame and somebody can look
     * at, and a fence is already a name drawn round a group.
     *
     * It used to be a ticked row on the item menu, toggling membership card by
     * card. The menu no longer says anything about the tour at all - the whole
     * of it is the editor in the Board tab (ui/tour-edit.ts), which is where an
     * *order* can be seen and changed, and a right-click menu never could.
     */
    addSelectionToTour: () => {
      const items = taggable();
      if (!items.length) return;
      const added = addTourStop(items.map(i => i.id));
      toast(!added ? 'Already on the tour'
        : added > 1 ? `A stop with ${added} cards, added to the tour`
          : 'Added to the tour');
    },
    resetSize,
    // Album art, and nothing else. A cover is the picture a card that cannot be
    // looked at borrows so it can be recognised from across the board, and in
    // practice that card is a track: the art usually arrives inside the file
    // (import/artwork.ts), and this is how one that came without any gets it.
    // Offering the same thing on a note or a link put a picture behind words
    // that were already legible, which is a card wearing a costume rather than
    // a card that has something to show.
    //
    // The model is deliberately wider than the offer - setItemCover() dresses
    // any card, and state.ts says why - so a picture an older build put on
    // something else still draws. canClearCover is how it comes back off.
    canCoverItem: (id: string) => byId(id)?.type === 'audio',
    // Anything already wearing one, except a video: a video's cover is the
    // poster frame the importer grabs and the optimiser repairs, not a choice
    // somebody made, and taking it away would only mean the board makes it again.
    canClearCover: (id: string) => {
      const it = byId(id);
      return !!it?.meta?.cover && it.type !== 'video';
    },
    setCover: (id: string) => pickCover(id),
    clearCover: (id: string) => setItemCover(id, null),

    // Fill (crop to the cells) or fit (whole picture in) - only photos and
    // videos, and only on the grid: off it a card is its picture's shape and
    // the two are the same (fitMode, canvas/renderers.ts). itemFit reports the
    // *effective* fit, which is what the menu ticks; setItemFit pins it.
    canSetFit: (id: string) => {
      const type = byId(id)?.type;
      return (type === 'image' || type === 'video')
        && !!board.settings.snap && board.layoutMode !== 'mobile';
    },
    itemFit: (id: string) => {
      const own = byId(id)?.meta?.fit;
      if (own === 'cover' || own === 'contain') return own;
      return board.mediaFit === 'contain' ? 'contain' : 'cover';
    },
    setItemFit: (id: string, fit: string) => setItemFit(id, fit),

    // The card, on or off - and only one at a time, like every other row here.
    // A cut-out is a judgement about *this* item, and the import guess is a
    // default rather than a verdict: whatever is chosen here wins and is what
    // gets saved.
    //
    // Pictures, notes and models, which is three readings of one idea. On a
    // photograph the card is a mount and taking it away leaves the silhouette;
    // on a sticky the card is the pad paper and taking it away leaves the words,
    // sitting on the board the way something written straight onto it would. A
    // caption over a photograph, a title across a corner of the board, a line of
    // text that is not a note about anything - those all wanted a note with no
    // paper and had to be made by dropping a transparent image instead.
    //
    // A model is the picture reading. canvas/model.ts draws on a transparent
    // buffer, so a part on a card is already a silhouette with board showing
    // through the corners of its box - and a bracket or a bolt is exactly the
    // shape somebody wants sitting *on* a moodboard rather than mounted on a
    // plate. It is the type where the frame round nothing is most of the frame.
    //
    // A sticky now offers Low opacity in its place (below). One that already
    // has no paper still sees the row, ticked, so it can have its paper back.
    canSetBare: (id: string) => {
      const it = byId(id);
      if (it?.type === 'note') return it.meta?.bare === true;
      return it?.type === 'image' || it?.type === 'model';
    },
    itemBare: (id: string) => byId(id)?.meta?.bare === true,
    setItemBare: (id: string, bare: boolean) => setItemBare(id, bare),
    canSetFaded: (id: string) => byId(id)?.type === 'note',
    itemFaded: (id: string) => byId(id)?.meta?.faded === true,
    setItemFaded: (id: string, faded: boolean) => setItemFaded(id, faded),

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
    // down - which is mesh.ts's question to answer and not this file's. glTF
    // fixes Y-up in its spec and FBX and Collada each carry the axis in the
    // document, so all three are left alone; the rest are a guess about who
    // writes the format, and a guess is a thing somebody should be able to
    // overrule.
    canFlipUpAxis: (id: string) => {
      const it = byId(id);
      if (it?.type !== 'model') return false;
      return upAxisIsGuessed(meshKind(getAsset(it.asset?.hash)?.name || it.name || ''));
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
    // canvas/model.ts. Offered on any model, including one that has never been
    // photographed and is already live: the entry is how somebody learns the card
    // can be turned at all, and asking for it while it is already turning is a
    // no-op rather than a wrong answer. Not offered on a card that is mid-turn,
    // which would be a menu item that does nothing visible.
    canRotateModel: (id: string) => byId(id)?.type === 'model' && !isTurning(id),
    rotateModel: (id: string) => {
      rotateModel(id);
      toast('Drag the model to turn it. It settles when you click away.');
    },

    /**
     * Keep the frame that is on the card and send the clip to the bin.
     *
     * Every clip on a board is on it for one of two reasons - it is something to
     * watch, or it is a picture that happens to move - and the second kind costs
     * what the first kind costs. A three-minute clip somebody put there for one
     * shot in it is thirty megabytes in the file, a decoder while it is on
     * screen, and a card that has to be played before it shows anything on a
     * phone. This is the way to say "that shot is the reason it is here": the
     * card stays, wearing the frame, and the video goes to the bin.
     *
     * **Which frame** is the frame that is on the card, and that is the whole
     * design. Not the first, not the poster, not one chosen in a dialog with a
     * scrubber - the person scrubbed already, in the now-playing bar, and left
     * it where they wanted it. There is nothing to ask.
     *
     * Two sources, and the second is not a fallback so much as the same answer
     * arrived at differently. A clip that is playing, or paused, or has simply
     * loaded its metadata, has a frame on its element and it is captured. A
     * clip whose source is *parked* has none - on iOS the renderer holds the
     * `src` back until the first tap, to stay inside the decoder ration - and
     * what the card is showing there is `meta.cover`, the poster. So that is
     * what is kept, and its bytes are already in the registry, which is why the
     * hash is reused rather than a second copy of the same picture cut.
     *
     * Offered on any clip, without asking first whether either source will
     * answer. The predicate cannot await and the answer is a decode away, so a
     * row that hid itself on the clips this might refuse would hide itself on
     * clips it would in fact have managed; the refusal says so in words instead.
     */
    canKeepFrame: (id: string) => {
      const it = byId(id);
      return it?.type === 'video' && !!it.asset?.hash;
    },
    keepFrame: async (id: string) => {
      const it = byId(id);
      if (it?.type !== 'video') return;
      // The card's own element, which is where the frame somebody is looking at
      // actually is. nodeFor() answers nothing for a culled card, and a card
      // whose menu is open is on screen by construction.
      const v = nodeFor(id)?.querySelector('video');
      const shot = v ? await frameOnScreen(v) : null;
      let hash = '';
      let facts: Record<string, unknown> = {};
      if (shot) {
        // Named for what it is rather than 'poster': a poster is the picture a
        // clip wears, and this is the picture that replaces one.
        const file = derivedFile(shot.blob, 'frame');
        hash = await addFile(file);
        facts = { mime: file.type, ext: extOf(file.name), size: shot.blob.size };
      } else {
        // The parked case - see the header. `meta` is open, so the cover is
        // narrowed here, and getAsset() is what establishes that it names bytes
        // this session actually holds rather than a hash out of a file whose
        // asset went missing.
        const cover = typeof it.meta?.cover === 'string' ? it.meta.cover : '';
        const asset = cover ? getAsset(cover) : null;
        if (asset) {
          hash = cover;
          facts = { mime: asset.mime, ext: asset.ext, size: asset.size };
        }
      }
      if (!hash) {
        toast('No frame to keep yet - play the clip to the frame you want');
        return;
      }
      if (!freezeClip(id, hash, facts)) return;
      // Said out loud because half of what happened is invisible: the card looks
      // almost the same, and the part that changed is that the clip is now
      // somewhere else. The bin is where it is and where it comes back from.
      toast('Kept the frame. The clip is in the bin - click it there to put it back.');
    },

    /**
     * Develop a camera RAW from its sensor data, at every pixel.
     *
     * The sensor is wherever this card keeps it. A RAW imported since the
     * importer started developing them holds the developed picture at
     * asset.hash and the RAW itself at meta.source (import/drop.ts), and what
     * the importer made is a *half-size* develop - a fifth of the time, and
     * the reason a folder of RAWs is not a minute of waiting. This row is the
     * other half of that bargain: it reads the same sensor again and asks for
     * all of it. On a board written before that, the RAW is still the card's
     * file and the card draws whatever preview the camera baked in, which is
     * sometimes a postage stamp; rawBytes() answers for both shapes.
     *
     * Several seconds of work in a worker, so a second press on the same card
     * while it runs does nothing.
     */
    /**
     * Give a card's own file back: written to disk, or handed to the share
     * sheet where the engine has one that takes files. The only way out for a
     * file that was dropped on the board short of exporting the whole .mbrd and
     * unzipping it, which on a phone cannot be done at all.
     */
    canSaveItemFile: (id: string) => !!ownFile(id),
    // Any card that holds a file, whether or not its bytes are here: a card
    // whose file went missing is the one most in need of another.
    canReplaceItemFile: (id: string) => {
      const it = byId(id);
      return !!it?.asset?.hash && it.type !== 'folder';
    },
    replaceItemFile: (id: string) => pickReplacement(id),
    canSendItemFile: (id: string) => {
      const own = ownFile(id);
      return !!own && canSendFile(asFile(own));
    },
    saveItemFile: async (id: string) => {
      const own = ownFile(id);
      if (!own) return;
      try {
        await saveBlob(own.blob, own.name);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        toast(`Could not save ${own.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
    sendItemFile: async (id: string) => {
      const own = ownFile(id);
      if (!own) return;
      const file = asFile(own);
      if (!canSendFile(file)) return;
      try {
        await navigator.share({ files: [file], title: own.name });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        toast(`Could not send ${own.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },

    canDemosaic: (id: string) => {
      const it = byId(id);
      return isRaw(it) && it?.meta?.demosaiced !== true && !!rawBytes(it);
    },
    demosaic: async (id: string) => {
      const it = byId(id);
      const asset = rawBytes(it);
      if (!it || !asset || !isRaw(it) || developing.has(id)) return;
      developing.add(id);
      const name = it.name || asset.name || 'this RAW';
      toast(`Demosaicing ${name} - this takes a few seconds`);
      try {
        let made;
        try {
          made = await demosaic(asset.blob);
        } catch (err) {
          if (!isOversize(err)) throw err;
          if (!await lift(err, fileKey({ name, size: asset.size }), `"${name}"`, 'Demosaic')) return;
          made = await demosaic(asset.blob, true);
        }
        const file = derivedFile(made.blob, 'demosaic');
        const picture = await addFile(file);
        const [thumb, display] = await Promise.all([
          thumbFor(file, made.width).catch(() => null),
          displayFor(file).catch(() => null),
        ]);
        setItemDemosaiced(id, {
          picture, thumb: thumb?.hash, display: display?.hash,
          mime: made.blob.type,
          // The card's file where it holds one already, its stand-in where the
          // RAW is still the file - see setItemDemosaiced().
          asItsFile: !!byId(id)?.meta?.source,
        });
        toast('Demosaiced. Undo puts the picture back.');
      } catch (err) {
        console.warn('[mbrd] could not demosaic', name, err);
        toast('Could not demosaic this RAW - the card keeps the picture it had', 'error');
      } finally {
        developing.delete(id);
      }
    },
  };
}

/**
 * The sensor data on a RAW card, whichever of the two shapes it is in: at
 * meta.source on a card whose file is already a developed picture, and at
 * asset.hash on a board written before the importer developed them.
 */
function rawBytes(it: { asset?: { hash?: string } | null, meta?: { source?: unknown } | null } | null | undefined) {
  const source = it?.meta?.source;
  return getAsset(typeof source === 'string' && source ? source : it?.asset?.hash);
}

/** RAW cards being developed now - see demosaic() above. */
const developing = new Set<string>();

/**
 * A card's own file, as it arrived, and the name to hand it back under - or
 * null for a card that holds none.
 *
 * The bytes are rawBytes()'s answer, which is the right one for every card and
 * not only a RAW: a HEIC keeps its original at meta.source beside the WebP
 * drawn from it, and everything else holds its file at asset.hash. A folder
 * card holds a list of files rather than one, so it has nothing to save here.
 *
 * The name goes to the operating system, so it is cleaned of the characters a
 * file system refuses, and it gets the extension of the bytes it names - an
 * optimised picture's stored name can still say .png over a WebP.
 */
function ownFile(id: string) {
  const it = byId(id);
  if (!it || it.type === 'folder') return null;
  const asset = rawBytes(it);
  if (!asset) return null;
  const fromSource = typeof it.meta?.source === 'string' && !!it.meta.source;
  const given = typeof it.meta?.origName === 'string' && it.meta.origName ? it.meta.origName : '';
  const named = given || asset.name || it.name || 'file';
  const ext = fromSource ? extOf(named) : asset.ext || extOf(named);
  const bare = ext && extOf(named) === ext ? named.slice(0, -(ext.length + 1)) : named;
  // What Windows, macOS and Linux refuse between them, control characters included.
  const stem = [...bare].map(ch => (ch < ' ' || '\\/:*?"<>|'.includes(ch) ? ' ' : ch)).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
  return { blob: asset.blob, name: ext ? `${stem}.${ext}` : stem, mime: asset.mime };
}

/** Whether the engine's share sheet takes a file, asked of a real one. Never in
 *  the apps, where Save already is the native dialog. */
const canSendFile = (file: File) =>
  !isDesktop() && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });

const asFile = (own: { blob: Blob, name: string, mime: string }) =>
  new File([own.blob], own.name, { type: own.mime || own.blob.type });
