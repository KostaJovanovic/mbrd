// What a card is made of: elements, not when they exist. items.ts decides
// which cards are mounted (culling, placement); this builds the tree for
// a given item. Boundary: markup here, node map/viewport/placement there.
// Content is canvas/renderers.ts; this builds the shell around it.

import { extOf, shuffle } from '../util.ts';
import { formatName } from '../import/formats.ts';
import { adjustFilter, baseStep, flipTransform, isFence, isLocked, itemBare, itemFaded } from '../state.ts';
import { buildContent, fitMode } from './renderers.ts';
import { noteTint } from './note-model.ts';
import type { Item } from '../board-model.ts';
import { shownName } from '../board-model.ts';

/**
 * A link card with a valid address. Every one now carries its own identity at
 * every zoom - the site name filling the width, and a player's offer or a link
 * chip - so it takes no far-zoom headline over the top, the same way a picture
 * card does not (item-chrome.css). A bad URL throws out of new URL and falls
 * back to the plain headline, which is all an inert link has to show.
 */
function isEmbedLink(item: ItemLike): boolean {
  if (item.type !== 'link') return false;
  try { new URL(String(item.meta?.url)); } catch { return false; }
  return true;
}

/**
 * Enough of a board item to draw one. A leftover alias from when board.items
 * inferred as never[]; kept only so signatures below read as "an item you can
 * draw", pointing at board-model.ts's Item rather than holding a second shape.
 */
export type ItemLike = Item;

/**
 * Anything an item might be, for the three pure questions below. Wider than
 * an Item on purpose: called with fragments (tests/items.test.js's bare `{}`,
 * rebuild()'s live item), so each must answer for a card with no name, no
 * meta, no type at all.
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
  const name = typeof item?.name === 'string' ? shownName({ type: item.type, name: item.name }).trim() : '';
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
  'style-tile', // three labelled bands and two face names already. A plate over
              // the top would be a fourth heading on a card that is nothing but
              // headings.
]);

export const wantsHead = (item: ItemFragment): boolean => !NO_HEAD.has(item.type ?? '');

/**
 * The word printed above the rule at the index rung.
 *
 * The extension, in preference to anything else, because that is the card's own
 * kicker (see cardShell in canvas/renderers.ts) and because on a board built out
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

/**
 * What an item *is*, in words, for the places that print a kind beside a name:
 * the feed's file tile, a name for one that has none of its own, a viewer title.
 *
 * All three printed `item.type` raw, and for one type that is a word about this
 * codebase rather than about the file. `generic` is classify()'s answer for "a
 * file, and nothing more is known" - the card the board draws when it cannot
 * draw the thing itself - and it went to the screen untranslated, so a
 * SolidWorks part somebody dropped on a board sat in the feed under the word
 * "generic". Everything else in that column is already a plain English noun.
 *
 * So ask the catalogue, which was lifted from analyser for exactly this and
 * names all but four of thirteen hundred extensions: the part is a SolidWorks
 * part, a .zip is a ZIP archive, and a .qqq nobody has heard of is a QQQ. Only
 * a file with no extension at all falls through to the plain word, and there is
 * genuinely nothing more to say about one of those.
 *
 * The other types are handed back as they are. `image`, `note`, `link` and the
 * rest are the words those cards have always shown, and the extension is not an
 * improvement on any of them - a picture is a picture whether it is a JPEG or a
 * PNG, and the card is showing it.
 */
export function kindName(item: ItemFragment): string {
  const type = item.type ?? '';
  if (type && type !== 'generic') return type;
  return formatName(item.meta?.ext || extOf(item.name)) || 'file';
}

/**
 * The same answer where there is no room for it: the search list's kind column
 * and the square on a bin tile, both of which are badges a few characters wide.
 *
 * The names the catalogue gives are written to be read - "Excel spreadsheet",
 * "SolidWorks part", and at the far end "REDengine 4 archive (Cyberpunk 2077)",
 * which is a fine thing to know and not something to set in 68 pixels of
 * letter-spaced capitals. Half of them run past twenty characters. So a badge
 * gets the extension instead, which is what the card itself is badged with (see
 * farKind above) - and a row in the search list reading SLDPRT next to the card
 * it will jump to reading SLDPRT is the two of them agreeing, which is worth
 * more here than the longer word is.
 *
 * Never the type word for a generic item: that is the whole point of both of
 * these. A file with no extension to show falls through to farKind's "file".
 */
export function kindTag(item: ItemFragment): string {
  const type = item.type ?? '';
  return type && type !== 'generic' ? type : farKind(item);
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
  // SAFETY: the refill three lines up runs whenever the bag is empty, so there
  // is always something to pop. pop() is typed `| undefined` because tsc cannot
  // see that; the multiplication below would answer NaN rather than throw if it
  // ever were wrong.
  const dir = tiltBag.pop() as number;
  return dir && dir * (TILT_MIN + Math.random() * (1 - TILT_MIN));
}

/** Deal the pack again. What opening another board means for the lean. */
export function resetTilt(): void {
  tiltBag.length = 0;
}

/** A card wider or taller than these, in grid spaces, hangs straight - see tooLarge(). */
const TILT_MAX_WIDTH_CELLS = 8;
const TILT_MAX_HEIGHT_CELLS = 6;

/** Whether an item takes a lean at all - see restingTilt() for the two that do not. */
const leans = (item: ItemLike) => !isFence(item) && item.type !== 'sticker';

/**
 * Too large to lean, for the reason a region is: the lean turns about the
 * centre, so along a long side the far corners swing far enough to read as
 * askew rather than as pinned by hand.
 */
const tooLarge = (item: ItemLike) => {
  const step = baseStep();
  return item.w > TILT_MAX_WIDTH_CELLS * step || item.h > TILT_MAX_HEIGHT_CELLS * step;
};

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
 * sticker gets none *here* because it already has one of its own - the degrees
 * rolled onto item.rot when it was pressed down (see addSticker). Two leans
 * would compound, and only one of them is a fact about the board. The roll over
 * there is taken against --tilt-max, so a sticker answers the whimsy dial the
 * same way a card does; it simply answers it once, at the moment it lands,
 * because its angle is geometry and a card's is a stylesheet.
 */
export function restingTilt(item: ItemLike): string {
  if (!leans(item)) return '0';
  // Straight *before* the bag, so a large card does not take a slot out of the
  // one-in-three split. retilt() deals it one if it is ever made smaller.
  if (tooLarge(item)) return '0';
  return tiltFactor().toFixed(3);
}

/**
 * A built card's lean after its size changed: straight while it is wider or
 * taller than the limits above tooLarge(), and leaning again once it is back
 * inside both.
 *
 * The lean a card gives up is parked in data-lean, so a resize that crosses the
 * line and comes back returns the card to its own angle rather than a new one -
 * a drag that wavers over the line crosses it on every frame it wavers. A card
 * built too large was never dealt a lean (buildItem() parks an empty one), and
 * draws from the bag the first time it fits. So data-lean is present exactly
 * while a card stands straight for its size.
 *
 * Null when nothing changed, which is every frame of a resize that stays on one
 * side of the line; otherwise the lean now on the card, for its twin to carry.
 */
export function retilt(el: HTMLElement, item: ItemLike): string | null {
  if (!leans(item)) return null;
  const parked = el.dataset.lean;
  const large = tooLarge(item);
  if (large === (parked !== undefined)) return null;
  let tilt = '0';
  if (large) el.dataset.lean = el.style.getPropertyValue('--item-tilt');
  else {
    tilt = parked || tiltFactor().toFixed(3);
    delete el.dataset.lean;
  }
  el.style.setProperty('--item-tilt', tilt);
  return tilt;
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
  //
  // Through itemBare() rather than off the meta key, because this stopped being
  // the only reader: canvas/web.ts has to know too - a line cannot stop on an
  // outline that is not drawn - and two spellings of one question is how the
  // stylesheet and the connector come to disagree about which cards have a card.
  if (itemBare(item)) el.dataset.bare = '';
  else delete el.dataset.bare;
  // Low opacity on a sticky - a stylesheet question too, answered in cards.css.
  if (itemFaded(item)) el.dataset.faded = '';
  else delete el.dataset.faded;
}

/**
 * The lock, the three picture adjustments and the mirror, onto a card.
 *
 * All are here rather than in the renderers for the reason writeFit() is: they
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
  // happens. It is drawn while the card is hovered or selected (see the rule in
  // item-chrome.css), and it is a button: a press takes the anchor off, which
  // canvas/items.ts handles for every card at once.
  //
  // Built here with createElementNS rather than through ui/menu.ts's icon(),
  // which is the same six lines: canvas/ may not import ui/, and one small
  // duplicate is the price of that arrow pointing the way it does.
  const badge = el.querySelector(':scope > .item-locked');
  if (locked && !badge) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // .item-locked is the hook item-chrome.css draws the badge by, and the
    // click handler in canvas/items.ts tells the two badges apart by.
    btn.className = 'item-badge item-locked';
    btn.setAttribute('aria-label', 'Unanchor');
    btn.title = 'Unanchor';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', 'assets/icons.svg#i-anchor');
    svg.append(use);
    btn.append(svg);
    el.append(btn);
  } else if (!locked && badge) {
    badge.remove();
  }
  // The string itself is board-model.ts's now, because ui/snapshot.ts assigns
  // the same one to a canvas context - see adjustFilter(). What is left here is
  // where it goes.
  const filter = adjustFilter(item);
  if (filter) el.style.setProperty('--item-filter', filter);
  else el.style.removeProperty('--item-filter');
  // The mirror, by the same route and for the same reason: one property holding
  // a whole value, set only where there is something to say. It goes on the body
  // rather than the picture so a card cannot show one way round zoomed in and
  // the other zoomed out - see the rule in items.css, and flipTransform() in
  // board-model.ts, which is the one place the string is built.
  const flip = flipTransform(item);
  if (flip) el.style.setProperty('--item-flip', flip);
  else el.style.removeProperty('--item-flip');
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
  // A *number*, which is what addNote() writes: `meta: { text, tint }` with
  // tint an integer 1..4, cycled or picked off the Note flyout's pad. This read
  // `typeof tint === 'string'`, so data-tint was never written and
  // cards.css:87-89 never matched - **every note on every board rendered on
  // sheet 1 and the four-colour pad did nothing.** Introduced by 7724374
  // ("Type most of the tree"), which replaced `if (item.meta.tint)
  // el.dataset.tint = item.meta.tint` - where dataset coerced the number - with
  // a string test. Sticker tints were unaffected because renderers.ts:1107
  // writes String(...).
  //
  // Both forms are accepted rather than one, because a .mbrd written by any
  // build in between may carry either and neither is wrong.
  const tint = noteTint(item.meta.tint);
  if (tint) el.dataset.tint = String(tint);
  if (isFence(item)) writeFenceLook(el, item);
  if (picked) el.dataset.pick = '';
  el.style.setProperty('--item-tilt', tilt);
  // Built too large to lean, so it has no lean to take back when it is made
  // smaller. The empty park tells retilt() to deal one then.
  if (leans(item) && tooLarge(item)) el.dataset.lean = '';

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
  if (wantsHead(item) && !isEmbedLink(item)) el.append(farHead(item));

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
  // Grips are the only way into a resize - canvas/input.ts reaches it through
  // `.grip` and nothing else - so withholding them here is the whole lock.
  //
  // Two kinds and no more, because they are the two this element can answer on
  // its own. A pinned sticky has no grips either, and that one is decided by the
  // caller: it is a fact about two items and a ten-second clock, neither of
  // which is written on the node. See paintGrips() in canvas/items.ts.
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
 * the dblclick handler in input.ts). Only the title card has them, built once and
 * kept - the CSS shows them on hover or while the card is selected. Children of
 * `.item` like the grips, so they ride the card's transform and hold a constant
 * on-screen size through --iz. The clicks themselves are caught by
 * canvas/input.ts (which owns cmds), the way grip and widget hits are - this only
 * draws the buttons.
 */
export function buildTitleControls(el: HTMLElement): void {
  if (el.querySelector(':scope > .item-pen')) return;
  const pen = document.createElement('button');
  pen.type = 'button';
  pen.className = 'item-pen';
  pen.setAttribute('aria-label', 'Edit title style');
  pen.title = 'Edit title style';
  // Built, not written. The lock badge ten lines up hand-builds its icon with
  // createElementNS and says why; this used innerHTML for the same job in the
  // same file, so the two adjacent icon builders disagreed about the house
  // rule. Nothing was getting through - every character of that string is
  // written here - but a rule that half a file keeps is a rule the next person
  // reads twice.
  const NS = 'http://www.w3.org/2000/svg';
  const nib = document.createElementNS(NS, 'svg');
  nib.setAttribute('viewBox', '0 0 16 16');
  nib.setAttribute('fill', 'none');
  nib.setAttribute('stroke', 'currentColor');
  nib.setAttribute('stroke-width', '1.4');
  nib.setAttribute('stroke-linecap', 'round');
  nib.setAttribute('stroke-linejoin', 'round');
  nib.setAttribute('aria-hidden', 'true');
  for (const d of ['M11.5 2.5l2 2L6 12l-3 1 1-3z', 'M10 4l2 2']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    nib.append(p);
  }
  pen.append(nib);
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'item-rename';
  rename.setAttribute('aria-label', 'Rename board');
  rename.title = 'Rename board';
  rename.textContent = 'T';
  el.append(pen, rename);
}

/**
 * A fence's colour and its roll, on the outer element (fences.css reads both).
 * Written at build and again by rebuild() in canvas/items.ts, since both change
 * from the fence's menu as an 'item' event and a rebuild keeps the element.
 */
export function writeFenceLook(el: HTMLElement, item: ItemLike): void {
  const tint = noteTint(item.meta.tint);
  if (tint) el.dataset.tint = String(tint);
  else delete el.dataset.tint;
  el.classList.toggle('is-rolled', item.meta.rolled === true);
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
  label.textContent = shownName(item);
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
  line.textContent = shownName(item);

  head.append(kind, line);
  head.hidden = !item.name;
  return head;
}
