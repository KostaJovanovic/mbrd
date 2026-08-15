// What a card is made of: the elements, and nothing about when they exist.
//
// canvas/items.ts is the module that decides *which* cards are mounted - the
// node map, the culling, the pooling, the placement arithmetic that turns an
// item's world box into a transform. This is the other half of it: given an
// item, hand back the tree of elements that draws it. The two used to be one
// file of 1,648 lines with the seam running straight through the middle of it,
// and the seam is a real one - almost nothing here needs to know that culling
// exists, and almost nothing there needs to know a caption is a `<div>`.
//
// ── The line, precisely ──
//
// A function belongs here if it takes an item (or an element) and produces or
// edits markup, and belongs in items.ts if it touches `nodes`, `shadows`, the
// viewport, or where a card sits. build() is the one place the two meet, and it
// is split at exactly that join: buildItem() below assembles the tree, and
// items.ts's build() is what registers it, gives it a shadow, places it and
// selects it. buildShadow() is the same shape - it makes the twin and does not
// place it, because placeBox() is placement math and stayed behind.
//
// ── Why the accessible name and the far-zoom head are here ──
//
// itemAccessibleName(), wantsHead() and farKind() are pure functions over an
// item and were always the tested part of items.ts (tests/items.test.js imports
// all three). They are here because they are decisions about *what a card says*,
// which is this file's subject, and items.ts re-exports them by name so nothing
// that imported them had to move. Re-exported explicitly rather than with
// `export *`, for the reason state.ts gives for the same choice.
//
// ── What must not move in here ──
//
// The node map and the culling. A builder that also remembered what it had built
// would be the module this came out of.
//
// Placement. place(), placeBox(), itemTransform() and deviceSnap() are geometry
// against the viewport, and they are items.ts's. The one thing this file writes
// that looks like geometry - `--item-tilt` - is deliberately not geometry at all:
// see restingTilt(), and the long note in items.ts about why a lean stays out of
// item.rot.
//
// Content. What goes *inside* a card is canvas/renderers.ts, reached through
// buildContent(). This builds the shell around it - the body, the bar, the
// caption, the head, the grips, the title card's two buttons - and calls that
// once. A per-type branch appearing in this file would be a second RENDERERS
// table.

import { extOf, shuffle } from '../util.ts';
import { adjustFilter, isFence, isLocked } from '../state.ts';
import { buildContent, fitMode } from './renderers.ts';
import type { Item } from '../board-model.ts';

/**
 * Enough of a board item to draw one, which is the whole of one.
 *
 * This was a private re-declaration - id, type, name and a three-key meta - made
 * while board.items still inferred as never[] and there was nothing else to name.
 * board-model.ts states the shape now, so the alias is kept only so the eight
 * signatures below still read as "an item you can draw", and it points at the
 * one answer rather than holding a second.
 */
export type ItemLike = Item;

/**
 * Anything an item might be, for the three pure questions below.
 *
 * Wider than an Item on purpose: these three are called with fragments - by
 * tests/items.test.js with a bare `{}`, and by rebuild() with a live item - and
 * every one of them is written to answer for a card that has no name, no meta
 * and no type at all.
 */
export interface ItemFragment {
  type?: string;
  name?: string;
  meta?: { ext?: string } | null;
}

/**
 * A human word for an item's type, for the times it has no name of its own.
 * "Untitled picture" reads; "generic" does not.
 */
const TYPE_LABEL: Record<string, string> = {
  image: 'picture', video: 'video', audio: 'audio clip',
  note: 'note', model: 'model', link: 'link', embed: 'embed',
  // Matches the visible default a new fence is given (nextFenceName), so a fence
  // somebody cleared the name of is still announced as the thing it is.
  fence: 'fence',
};

/**
 * The name assistive technology announces for a card.
 *
 * Cards were bare `<div class="item">` with no accessible name, and every
 * item's menu button was called only "Actions" - so a board read out as a run
 * of identical controls with no way to tell which was which. This gives each
 * card its own name: the item's, or a typed fallback. See AUD-09.
 */
export function itemAccessibleName(item?: ItemFragment | null): string {
  const name = typeof item?.name === 'string' ? item.name.trim() : '';
  const base = name || `Untitled ${TYPE_LABEL[item?.type ?? ''] || 'item'}`;
  // Suffixed rather than announced by a separate element, because what an
  // anchor changes is what this card *is* to somebody driving by keyboard: it
  // is the one that will not move. The badge in the corner is the same sentence
  // drawn, and is marked aria-hidden so the two do not both speak.
  return isLocked(item) ? `${base}, anchored` : base;
}

/**
 * Which cards draw a head at the index rung, and it is one question rather than
 * a list: **is there anything to look at?**
 *
 * A card with a picture keeps the picture and takes no label at all. A
 * photograph is its own name at any size, and a plate across the bottom of one
 * is a caption on something that did not ask for one. A card without a picture
 * has nothing to lose and everything to gain, so it draws what it is and what it
 * is called - see the index rung block in items.css for the whole design.
 *
 * Two earlier versions are worth keeping. The name *centred in the card* fights
 * whatever is under it, so every visual type had to be argued out one at a time
 * and audio grew a bespoke layout on top. A *band across the foot* fixed that
 * and left the real problem standing: with the body switched off, six types all
 * became the same blank white rectangle with a small name at the bottom, on the
 * one view whose entire job is telling you what is where.
 *
 * The three non-picture exclusions are the cards already carrying a label of
 * their own out here; the three picture ones are listed beside them below,
 * because both halves of the split belong in the same place.
 */
const NO_HEAD = new Set([
  // Each of these already says what it is, louder than a label could.
  'fence',    // its plate and label survive the rung by name (items.css), set at
              // the region's size rather than a card's - finding your way around
              // a large board is exactly when its areas' names are what you came
              // for.
  'title',    // the board's own name, already set large. It is a title card.
  'ghost',    // a hint is talking to the person, not to the board, and
              // serializeBoard() strips them: naming one names nothing.
  'image',    // a photograph is its own name at any size, and a plate across the
  'video',    // bottom of one is a caption on something that did not ask for it.
  'swatch',   // a colour, and the hex under it is the only name it has.
  'sticker',  // a shape pressed onto a picture. Its name exists for the trash
              // and for Find; printing "Star" across a star at the index rung
              // would be a caption on a mark, which is a caption on a caption.
]);

export const wantsHead = (item: ItemFragment): boolean => !NO_HEAD.has(item.type ?? '');

/**
 * The word printed above the rule at the index rung.
 *
 * The extension, in preference to anything else, because that is the card's own
 * kicker (see cardShell in canvas/renderers.js) and because on a board built out
 * of somebody's files it is the most informative three characters available -
 * PDF, OBJ, WAV and MP3 each say something a type word cannot. The type word is
 * the fallback for the items that were never files: a link has no extension and
 * a pasted note has no name of its own to take one from.
 *
 * Empty for a note, which draws no kind at all - see the note rules in
 * items.css. Returned rather than special-cased at the call site so there is one
 * answer to "what does this card call itself" and the stylesheet decides whether
 * to print it.
 */
const KIND_WORD: Record<string, string> = {
  link: 'link', audio: 'audio', text: 'text', model: 'model',
};

export function farKind(item: ItemFragment): string {
  if (item.type === 'note') return '';
  const ext = (item.meta?.ext || extOf(item.name) || '').replace(/^\./, '');
  return ext || KIND_WORD[item.type ?? ''] || 'file';
}

// ---------------------------------------------------------------------------
// The lean
// ---------------------------------------------------------------------------

/**
 * A number in [-1, 1] for an item, used as its resting tilt - freshly dealt,
 * so the board is pinned up a little differently every time you open it.
 *
 * A third of the board hangs straight, and the tilted two-thirds lean left and
 * right in equal numbers. That is a property of the *set*, not of any one
 * item, so these are dealt from a bag rather than rolled independently: one
 * slot of each kind per three items, reshuffled whenever it runs out. Rolling
 * independently would only hit those proportions on average, and a small board
 * - which is most boards - would miss them visibly.
 *
 * Over any whole group of three the split is exact. A board whose count is not
 * a multiple of three is off by at most one item, which is the best that
 * exists.
 *
 * Dealt as a card is built rather than stored on the item, which also settles
 * how long a lean lasts: nodes are cached and only detached when culled, so an
 * item keeps its lean while you pan away and back, and only a reload or opening
 * another board re-deals the pack - see resetTilt(), which items.ts calls from
 * resetItems().
 *
 * It stays out of item.rot on purpose. rot is geometry - fit() reads it, the
 * resize handles work in its frame, a marquee tests against it, and it is
 * saved. This is presentation: the browser hit-tests the rotated box, so
 * pointing at a crooked item still works, and nothing that reasons about where
 * things *are* has to know the board is not square.
 */
const tiltBag: number[] = [];
/** Below this a tilted item reads as a straight one that missed, not a lean. */
const TILT_MIN = 0.4;

function tiltFactor(): number {
  if (!tiltBag.length) {
    // Shuffled, so the straight one is not always in the same position within
    // its three. Dealing them in order would put every third item square, and
    // in a grid arrangement that regularity reads as banding rather than as a
    // hand-pinned board.
    tiltBag.push(0, -1, 1);
    shuffle(tiltBag);
  }
  const dir = tiltBag.pop() as number;
  return dir && dir * (TILT_MIN + Math.random() * (1 - TILT_MIN));
}

/** Deal the pack again. What opening another board means for the lean. */
export function resetTilt(): void {
  tiltBag.length = 0;
}

/**
 * How far off square this card rests, as a fraction of whatever the whimsy axis
 * currently allows (--item-tilt against --tilt-max). A string, because it is
 * written straight into a custom property, and because the two straight cases
 * below are exactly `'0'` rather than a rounded zero.
 *
 * A fence hangs straight, and it is the one type that has to. A lean is a *card*
 * pinned up by hand and slightly off square; a region is a line drawn on the
 * board, and a drawn line does not arrive crooked. The tilt also costs more the
 * larger the box, since it turns about the centre: at a few hundred units a
 * corner moves a hair, and across two thousand it moves far enough that the
 * region visibly disagrees with the cards inside it - which do not turn with it,
 * because a lean is per item and theirs are their own. It does not draw from the
 * bag either, rather than drawing and throwing the number away: the
 * one-in-three-hangs-straight split is a property of the pack, and a region
 * taking a slot out of it would bend that split for the cards.
 *
 * A sticker joins the fence in hanging straight, and for the opposite reason. A
 * fence gets no lean because it is a drawn line rather than a pinned card; a
 * sticker gets none *here* because it already has one of its own - the +/-8
 * degrees rolled onto item.rot when it was pressed down (see addSticker). Two
 * leans would compound, and only one of them is a fact about the board rather
 * than about the whimsy dial.
 */
export function restingTilt(item: ItemLike): string {
  return isFence(item) || item.type === 'sticker' ? '0' : tiltFactor().toFixed(3);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * Write both fit attributes onto a card.
 *
 * data-fit is the *effective* object-fit - the item's own meta.fit if it set
 * one, else the board-wide default - and is what items.css keys the ordinary
 * cover/contain off. data-fit-own carries only the choice made on this card, and
 * exists for one rule: at whimsy 0 an image is a polaroid pinned to cover, which
 * has to hold against the board default (whose contain would otherwise letterbox
 * every Softish photo) but yield to somebody explicitly asking for Fit in the
 * card. data-fit cannot tell those two contains apart; this can.
 */
export function writeFit(el: HTMLElement, item: ItemLike): void {
  el.dataset.fit = fitMode(item);
  const own = item?.meta?.fit;
  if (own === 'cover' || own === 'contain') el.dataset.fitOwn = own;
  else delete el.dataset.fitOwn;
  // The cut-out flag, written here for the same reason the fit is: it is a
  // stylesheet question, and the alternative is a renderer that knows about
  // paper. An attribute rather than a class so it reads like the rest of the
  // card's state in the inspector, and so item-chrome.css can answer it with
  // one selector next to the rules it is turning off.
  if (item?.meta?.bare === true) el.dataset.bare = '';
  else delete el.dataset.bare;
}

/**
 * The lock, and the three picture adjustments, onto a card.
 *
 * Both are here rather than in the renderers for the reason writeFit() is: they
 * describe the *card*, not its content, and both have to be re-readable on a
 * card that already exists - an item event rebuilds a card's body and would
 * otherwise leave the outer element carrying the old answer.
 *
 * data-locked drives two rules and no more: the grips do not draw, and a small
 * padlock sits in the corner. The lock is enforced in canvas/input.ts, never
 * here - a stylesheet that was the only thing standing between a pointer and an
 * item's geometry would be one `display: block` in a user stylesheet away from
 * meaning nothing.
 *
 * The adjustments become one CSS custom property holding a whole `filter`
 * value, rather than three properties the stylesheet assembles. The stylesheet
 * cannot assemble them: `filter: brightness(var(--x))` with `--x` unset is an
 * invalid declaration and drops the whole filter, so every card on the board
 * would need all three set to keep the one card that uses them working. One
 * property, set only where there is something to say, and `none` everywhere
 * else by the rule's own default.
 */
export function writeAdjust(el: HTMLElement, item: ItemLike): void {
  const locked = isLocked(item);
  if (locked) el.dataset.locked = '';
  else delete el.dataset.locked;
  // The badge, and it exists because the anchor is otherwise invisible: an
  // anchored card looks exactly like a free one until you press it and nothing
  // happens. It is drawn only while the card is *selected* (see the rule in
  // item-chrome.css), because that is the moment the question is asked - you
  // select the card, no grips appear, and this says why.
  //
  // Built here with createElementNS rather than through ui/menu.ts's icon(),
  // which is the same six lines: canvas/ may not import ui/, and one small
  // duplicate is the price of that arrow pointing the way it does.
  const badge = el.querySelector(':scope > .item-locked');
  if (locked && !badge) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico item-locked');
    // The card's accessible name already says it is anchored - see
    // itemAccessibleName() - so announcing this as well reads it out twice.
    svg.setAttribute('aria-hidden', 'true');
    // i-anchor, where this was a padlock. The class stays .item-locked: it is
    // the hook item-chrome.css draws the badge by, and a class rename is a
    // second edit in a second file buying nothing anybody can see.
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', 'assets/icons.svg#i-anchor');
    svg.append(use);
    el.append(svg);
  } else if (!locked && badge) {
    badge.remove();
  }
  // The string itself is board-model.ts's now, because ui/snapshot.ts assigns
  // the same one to a canvas context - see adjustFilter(). What is left here is
  // where it goes.
  const filter = adjustFilter(item);
  if (filter) el.style.setProperty('--item-filter', filter);
  else el.style.removeProperty('--item-filter');
}

/**
 * The whole of one card's markup, unplaced and unregistered.
 *
 * `tilt` comes in rather than being dealt here because the geometry twin has to
 * carry the same one, and dealing it twice would give a card and its shadow two
 * different leans. `picked` is whether this is the first end of a connection
 * being drawn: written at build time as well as by setConnectPick(), and that is
 * the whole reason the picked id is held in items.ts rather than in
 * ui/toolbar.ts - a card that is culled while it is picked is thrown away and
 * rebuilt from nothing when it comes back on screen, so a mark applied only to
 * the live node would quietly disappear the moment somebody panned away from it
 * and back.
 *
 * Everything the caller then does to it - registering it in the node map, giving
 * it a shadow, placing it, selecting it, adding the title card's buttons - is
 * items.ts's build(), which is the half of this that knows a board exists.
 */
export function buildItem(item: ItemLike, tilt: string, picked: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  // What the ghost card's own rules hang off, on both surfaces that mount one.
  // The Feed puts the same class on its .feed-hint wrapper - see fillHint() -
  // so the dial is laid out the same way in both places rather than only on the
  // canvas, which is where its rules used to be scoped and where they used to
  // stop. A class rather than the existing [data-type="ghost"], because the two
  // mounts have no element in common to key off.
  if (item.type === 'ghost') el.classList.add('ghost-mount');
  writeFit(el, item);
  writeAdjust(el, item);
  // A named, self-describing card for assistive technology. The full
  // keyboard-selection model (roving tabindex, arrow navigation) is a separate,
  // browser-verified change; naming and role are the part that is safe to ship
  // without a focus-order regression. See AUD-09.
  el.setAttribute('role', 'group');
  el.setAttribute('aria-roledescription', 'board item');
  el.setAttribute('aria-label', itemAccessibleName(item));
  // Which colour off the sticky pad. CSS picks the tint from this. `meta` is
  // unknown per key by design - see board-model.ts - so the tint is read as the
  // string it is meant to be rather than trusted to be one.
  const tint = item.meta.tint;
  if (typeof tint === 'string' && tint) el.dataset.tint = tint;
  if (picked) el.dataset.pick = '';
  el.style.setProperty('--item-tilt', tilt);

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(buildContent(item));
  el.append(body);

  // The strip across the foot: the caption, and the handle that opens this
  // item's menu. One element holding both, because they share an edge and two
  // absolutely positioned boxes guessing at each other's height is how you get
  // a one-pixel step between them - which is exactly what the first attempt at
  // this looked like.
  //
  // On .item rather than in .item-body, and that is load-bearing: re-rendering
  // an item calls replaceChildren() on the body, so a bar built in there would
  // survive until the first redraw and then quietly vanish.
  el.append(bottomBar(item));

  // And the far-zoom headline, on .item beside the bar for the same reason the
  // bar is there rather than in the body: re-rendering an item calls
  // replaceChildren() on the body, and anything built in there would survive
  // until the first redraw and then quietly vanish.
  if (wantsHead(item)) el.append(farHead(item));

  return el;
}

/**
 * A content-free copy of an item's outer geometry.
 *
 * All copies share #item-shadows, a layer below every real item. Keeping these
 * separate from the item stacking contexts is what prevents a high card's
 * shadow from being painted across a lower card.
 *
 * Handed back unplaced: putting it where the item is is placeBox(), which is
 * placement arithmetic against the viewport and stays in items.ts. This only
 * says what the twin is made of, which is very little.
 */
export function buildShadow(item: ItemLike, tilt: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'item-shadow';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  el.style.setProperty('--item-tilt', tilt);
  return el;
}

/**
 * The eight resize handles: four corners, and four edges for resizing one axis
 * alone. The single-letter ones are the edges (see .grip-edge in items.css).
 *
 * They exist for exactly as long as the card is selected, which is exactly as
 * long as they are drawn - CSS hides them otherwise, and there is no grabbing
 * one that is not on screen. They used to be built with the card and kept for
 * its life, which made them the largest single part of an item's DOM and the
 * least used: on a full screen of cards, a few hundred elements the browser
 * walked past on every style recalculation for nothing. That bill falls due on
 * every frame of a zoom, since the zoom is what item chrome is sized against.
 *
 * Built and dropped rather than built once and left, because a board is
 * something you sweep a marquee across: keeping them would mean every card the
 * marquee ever touched carrying its eight for the rest of the session, which is
 * the state this was trying to get out of. The churn is not per frame - a card
 * only changes hands when its selection actually changes, which is once per
 * sweep - so it is eight elements per card touched, not eight per card per
 * gesture.
 */
const GRIPS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function setGrips(el: HTMLElement, want: boolean): void {
  // The title card moves but does not resize: its size is the style's size dial,
  // not a drag on a corner. So it never gets grips, however it is selected.
  //
  // A ghost card is the same, for a different reason: it holds a fixed sentence
  // at a fixed 3:2, and it is leaving as soon as the board has anything on it.
  // There is nothing to gain by resizing one and a stretched hint looks broken.
  // Grips are the only way into a resize - canvas/input.js reaches it through
  // `.grip` and nothing else - so withholding them here is the whole lock.
  if (el.dataset.type === 'title' || el.dataset.type === 'ghost') want = false;
  if (!!el.dataset.grips === want) return;
  if (!want) {
    delete el.dataset.grips;
    for (const grip of el.querySelectorAll(':scope > .grip')) grip.remove();
    return;
  }
  el.dataset.grips = '1';
  for (const g of GRIPS) {
    const grip = document.createElement('div');
    grip.className = g.length === 1 ? 'grip grip-edge' : 'grip';
    grip.dataset.g = g;
    el.append(grip);
  }
}

/**
 * The title card's two pop-up buttons: a pen to the RIGHT that opens the shared
 * masthead style panel, and a T to the LEFT that drops into inline rename of the
 * board name (single tap). Renaming is also a double-tap of the card itself (see
 * the dblclick handler in input.js). Only the title card has them, built once and
 * kept - the CSS shows them on hover or while the card is selected. Children of
 * `.item` like the grips, so they ride the card's transform and hold a constant
 * on-screen size through --iz. The clicks themselves are caught by
 * canvas/input.js (which owns cmds), the way grip and widget hits are - this only
 * draws the buttons.
 */
export function buildTitleControls(el: HTMLElement): void {
  if (el.querySelector(':scope > .item-pen')) return;
  const pen = document.createElement('button');
  pen.type = 'button';
  pen.className = 'item-pen';
  pen.setAttribute('aria-label', 'Edit title style');
  pen.title = 'Edit title style';
  pen.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/><path d="M10 4l2 2"/></svg>';
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'item-rename';
  rename.setAttribute('aria-label', 'Rename board');
  rename.title = 'Rename board';
  rename.textContent = 'T';
  el.append(pen, rename);
}

/**
 * The strip across the foot of a card: caption on the left, handle on the right.
 *
 * Always built, for every type. Which types show a *caption* is still a
 * question the CSS answers - a sticky note has a name nothing draws - and CSS
 * reveals the handle only while this item is selected. Touch also has the
 * long-press route, so hiding the resting handle does not strand its actions.
 */
function bottomBar(item: ItemLike): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'item-bar';
  // A fence's bar is the only part of it that takes a press - its interior lets
  // the pointer through so that panning still works inside a region - so unlike
  // every other card's plate it is drawn even when there is no name on it yet.
  // Otherwise an unnamed fence would have no hit area anywhere and could never
  // be selected, moved or renamed again. items.css does the rest.
  if (item.type === 'fence') bar.classList.add('item-bar-always');
  bar.append(nameplate(item));
  return bar;
}

/**
 * The caption itself. Built in one place because a rename rebuilds it.
 *
 * Always present, empty when there is no name - so the bar has something to
 * lay out against, and [hidden] rather than absence is what makes the strip
 * shrink to just the handle. A rename can then fill it without the bar being
 * rebuilt around it.
 */
function nameplate(item: ItemLike): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'item-label';
  label.textContent = item.name || '';
  label.hidden = !item.name;
  return label;
}

/**
 * The line a card shows when it is too small to show anything else.
 *
 * `item.name` for every type, and that is worth a sentence because it is not
 * obvious for one of them: **a note carries a name too** - the first line of its
 * text, rewritten by noteName() on every edit - and until now nothing on the
 * board drew it (see canRenameItem, which explains why a note cannot be renamed:
 * you would be typing into a field with no visible effect). This is that field's
 * first visible effect. It is still not editable here; editing a note's first
 * line is how it changes, which is what it always was.
 *
 * Built for every eligible card whether or not it has a name yet, and hidden
 * when it has none - the same bargain nameplate() strikes and for the same
 * reason: a rename can then fill it without anything being rebuilt around it,
 * and `:has(> .far-head:not([hidden]))` in the stylesheet is what decides
 * whether the body underneath is worth drawing. No class to keep in step.
 */
function farHead(item: ItemLike): HTMLDivElement {
  const head = document.createElement('div');
  head.className = 'far-head';
  // Decorative, and deliberately so: this is the *same string* the accessible
  // name already carries, shown at a different zoom. Announcing it again would
  // read every card out twice on a board somebody merely zoomed out of.
  head.setAttribute('aria-hidden', 'true');
  // Two children, not one: the kind over the rule and the name under it. Both
  // are blocks of their own - a line clamp has nothing to bite on when the text
  // is an anonymous child of a flex container, and the rule is a border on the
  // kind so it can only ever be where the kind ends.
  const kind = document.createElement('b');
  kind.className = 'fh-kind';
  kind.textContent = farKind(item);

  const line = document.createElement('span');
  line.className = 'fh-name';
  line.textContent = item.name || '';

  head.append(kind, line);
  head.hidden = !item.name;
  return head;
}
