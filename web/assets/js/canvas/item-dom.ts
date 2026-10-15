// What a card is made of: elements, not when they exist. items.ts decides
// which cards are mounted (culling, placement); this builds the tree for
// a given item. Boundary: markup here, node map/viewport/placement there.
// Content is canvas/renderers.ts; this builds the shell around it.

import { extOf, icon, shuffle } from '../util.ts';
import { formatName } from '../import/formats.ts';
import { adjustFilter, baseStep, flipTransform, isFence, isLocked, itemBare, itemFaded } from '../state.ts';
import { buildContent, fitMode } from './renderers.ts';
import { markLang, noteTint } from './note-model.ts';
import type { Item } from '../board-model.ts';
import { shownName } from '../board-model.ts';

/**
 * A link card with a valid address. It carries its own identity at every zoom
 * (site name, player offer or link chip), so it takes no far-zoom headline, as
 * a picture card does not. A bad URL falls back to the plain headline.
 */
function isEmbedLink(item: ItemLike): boolean {
  if (item.type !== 'link') return false;
  try { new URL(String(item.meta?.url)); } catch { return false; }
  return true;
}

/** An item you can draw: board-model.ts's Item under a name the signatures read by. */
export type ItemLike = Item;

/**
 * Anything an item might be, for the three pure questions below. Wider than
 * an Item on purpose: called with fragments (a test's bare `{}`, rebuild()'s
 * live item), so each must answer for a card with no name, meta or type.
 */
export interface ItemFragment {
  type?: string;
  name?: string;
  meta?: { ext?: unknown, text?: unknown, strokes?: unknown } | null;
}

/** A human word for an item's type, for when it has no name of its own. */
const TYPE_LABEL: Record<string, string> = {
  image: 'picture', video: 'video', audio: 'audio clip',
  note: 'note', model: 'model', link: 'link', embed: 'embed',
  // A fence somebody cleared the name of is still announced as one.
  fence: 'fence', board: 'board',
};

/** The name assistive technology announces for a card: its own, or a typed fallback. */
export function itemAccessibleName(item?: ItemFragment | null): string {
  const name = typeof item?.name === 'string' ? shownName({ type: item.type, name: item.name }).trim() : '';
  // A note with no name is called by its first line, which is what it says on it.
  const text = item?.type === 'note' && typeof item.meta?.text === 'string' ? item.meta.text : '';
  const said = text.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 80) ?? '';
  // A drawing with no name is called by what it is made of.
  const strokes = item?.type === 'drawing' && Array.isArray(item.meta?.strokes) ? item.meta.strokes.length : 0;
  // The title card's words are the board's, not an item name.
  const base = name || (said ? `Note: ${said}` : item?.type === 'title' ? 'The board’s title'
    : item?.type === 'drawing' ? `Drawing, ${strokes} stroke${strokes === 1 ? '' : 's'}`
    : `Untitled ${TYPE_LABEL[item?.type ?? ''] || 'item'}`);
  // Part of the name, because to a keyboard user an anchor is what the card is:
  // the one that will not move. The corner badge is aria-hidden so both do not speak.
  return isLocked(item) ? `${base}, anchored` : base;
}

/**
 * The cards that draw no head at the index rung. The question is whether there
 * is anything to look at: a card with a picture keeps it and takes no label, and
 * a card without one draws what it is and what it is called (items.css).
 */
const NO_HEAD = new Set([
  'fence',      // its plate and label survive the rung, at the region's size
  'title',      // the board's own name, already set large
  'ghost',      // a hint talks to the person; serializeBoard() strips them
  'image',      // a photograph is its own name at any size
  'video',
  'swatch',     // the hex under it is the only name it has
  'sticker',    // a mark; its name exists for the trash and Find
  'style-tile', // already nothing but headings
  'card',       // the cleaning simulator's card prints its own line
  'drawing',    // a mark, not a file
]);

export const wantsHead = (item: ItemFragment): boolean => !NO_HEAD.has(item.type ?? '');

/**
 * The word above the rule at the index rung: the extension first, which is the
 * card's own kicker (cardShell in renderers.ts) and says more than a type word,
 * then the type word for items that were never files. Empty for a note, which
 * draws no kind; the stylesheet decides whether to print it.
 */
const KIND_WORD: Record<string, string> = {
  link: 'link', audio: 'audio', text: 'text', model: 'model',
};

/** meta.ext as a string, or '' - a hand-edited .mbrd can hold any value, and a
 *  throw in buildItem() stops sync() before the cards after it mount. */
const extMeta = (item: ItemFragment): string =>
  (typeof item.meta?.ext === 'string' ? item.meta.ext : '');

export function farKind(item: ItemFragment): string {
  if (item.type === 'note') return '';
  // A folder or a board has no extension, and a dot in its name is not one.
  if (item.type === 'folder' || item.type === 'board') return item.type;
  const ext = (extMeta(item) || extOf(item.name) || '').replace(/^\./, '');
  return ext || KIND_WORD[item.type ?? ''] || 'file';
}

/**
 * What an item is, in words, for the feed's file tile and a viewer title.
 * `generic` is classify()'s internal word for "a file, nothing more known", so
 * it goes to the format catalogue instead: a SolidWorks part, a ZIP archive, a
 * QQQ. Every other type is already a plain noun and passes through.
 */
export function kindName(item: ItemFragment): string {
  const type = item.type ?? '';
  if (type && type !== 'generic') return type;
  return formatName(extMeta(item) || extOf(item.name)) || 'file';
}

/**
 * The same answer for a badge a few characters wide (the search list's kind
 * column, a bin tile): the extension, as farKind gives it, because catalogue
 * names run past twenty characters. Never the word `generic`.
 */
export function kindTag(item: ItemFragment): string {
  const type = item.type ?? '';
  return type && type !== 'generic' ? type : farKind(item);
}

// ---------------------------------------------------------------------------
// The lean
// ---------------------------------------------------------------------------

/**
 * A resting tilt in [-1, 1], dealt fresh as each card is built. A third of the
 * board hangs straight and the rest lean left and right equally; dealt from a
 * bag rather than rolled, so a small board hits those proportions exactly.
 *
 * Kept on the node, not the item: nodes are cached until culled, so a lean
 * lasts until a reload or another board (resetTilt()). It stays out of
 * item.rot because rot is saved geometry that fit, resize and marquee read;
 * this is presentation, and the browser hit-tests the rotated box anyway.
 */
const tiltBag: number[] = [];
/** Below this a tilted item reads as a straight one that missed, not a lean. */
const TILT_MIN = 0.4;

function tiltFactor(): number {
  if (!tiltBag.length) {
    // Shuffled, or every third card is square and a grid reads as banded.
    tiltBag.push(0, -1, 1);
    shuffle(tiltBag);
  }
  // SAFETY: refilled above whenever empty; tsc cannot see that pop() succeeds.
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

/** Whether an item takes a lean at all - see restingTilt() for the two that do
 *  not, and a drawing, which stays level so a sketch annotating the card beside
 *  it does not drift off it (research/pen-2026-10-07.md). */
const leans = (item: ItemLike) => !isFence(item) && item.type !== 'sticker' && item.type !== 'drawing';

/** Too large to lean: the lean turns about the centre, so a long side's far
 *  corners swing far enough to read as askew rather than pinned by hand. */
const tooLarge = (item: ItemLike) => {
  const step = baseStep();
  return item.w > TILT_MAX_WIDTH_CELLS * step || item.h > TILT_MAX_HEIGHT_CELLS * step;
};

/**
 * How far off square this card rests, as a fraction of what the whimsy axis
 * allows (--item-tilt against --tilt-max). A string, written straight into a
 * custom property; the straight cases are exactly `'0'`.
 *
 * A fence hangs straight: a region is a drawn line, and turning a large box
 * about its centre would make it disagree with the cards inside it. It takes no
 * slot from the bag either, which would bend the one-in-three split. A sticker
 * hangs straight here because its lean is already in item.rot (addSticker), and
 * two leans would compound.
 */
export function restingTilt(item: ItemLike): string {
  if (!leans(item)) return '0';
  // Before the bag, so a large card takes no slot; retilt() deals one if it shrinks.
  if (tooLarge(item)) return '0';
  return tiltFactor().toFixed(3);
}

/** A sticker's angle at a size: flat while too large to lean, its own angle
 *  (item.rot) inside the limits. Every other item's rot passes through. */
export function leanAtSize(item: ItemLike, rot: number): number {
  return item.type === 'sticker' && tooLarge(item) ? 0 : rot;
}

/**
 * A built card's lean after its size changed: straight while too large,
 * leaning again once back inside the limits.
 *
 * The lean given up is parked in data-lean, so a resize that wavers over the
 * line returns the card to its own angle rather than a new one. A card built
 * too large parks an empty one and draws from the bag when it first fits.
 * Returns null when nothing changed, else the lean now on the card for its twin.
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
 * The card-level flags the stylesheets key off: the effective object-fit
 * (fitMode), cut-out and faded. Attributes, so a rebuild can rewrite them on a
 * card that already exists.
 */
export function writeFit(el: HTMLElement, item: ItemLike): void {
  el.dataset.fit = fitMode(item);
  // Through itemBare() rather than the meta key: canvas/web.ts asks the same
  // question, and two spellings of it would let the line and the card disagree.
  if (itemBare(item)) el.dataset.bare = '';
  else delete el.dataset.bare;
  if (itemFaded(item)) el.dataset.faded = '';
  else delete el.dataset.faded;
}

/**
 * The lock, the picture adjustments and the mirror, onto a card.
 *
 * data-locked only hides the grips and shows the badge; the lock itself is
 * enforced in canvas/input.ts, never by a stylesheet. The adjustments are one
 * custom property holding a whole `filter` value, because `brightness(var(--x))`
 * with `--x` unset drops the entire declaration.
 */
export function writeAdjust(el: HTMLElement, item: ItemLike): void {
  const locked = isLocked(item);
  if (locked) el.dataset.locked = '';
  else delete el.dataset.locked;
  // An anchored card otherwise looks free until a press does nothing. The badge
  // is a button that takes the anchor off (canvas/items.ts).
  const badge = el.querySelector(':scope > .item-locked');
  if (locked && !badge) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-badge item-locked';
    btn.setAttribute('aria-label', 'Unanchor');
    btn.title = 'Unanchor';
    btn.append(icon('i-anchor'));
    el.append(btn);
  } else if (!locked && badge) {
    badge.remove();
  }
  const filter = adjustFilter(item);
  if (filter) el.style.setProperty('--item-filter', filter);
  else el.style.removeProperty('--item-filter');
  // On the body rather than the picture, so a card cannot show one way round
  // zoomed in and the other zoomed out (items.css).
  const flip = flipTransform(item);
  if (flip) el.style.setProperty('--item-flip', flip);
  else el.style.removeProperty('--item-flip');
}

/**
 * The whole of one card's markup, unplaced and unregistered.
 *
 * `tilt` comes in because the shadow twin must carry the same one. `picked`
 * marks the first end of a connection being drawn; it is written at build too
 * because a culled card is rebuilt from nothing when it comes back on screen.
 * Registering, placing and selecting are items.ts's build().
 */
export function buildItem(item: ItemLike, tilt: string, picked: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = item.id;
  el.dataset.type = item.type;
  // The ghost card's rules hang off this class, which the Feed's .feed-hint
  // wrapper carries too, so the hint lays out the same on both surfaces.
  if (item.type === 'ghost') el.classList.add('ghost-mount');
  writeFit(el, item);
  writeAdjust(el, item);
  // The board is the tab stop; Tab walks the cards (walkCards() in canvas/input.ts).
  el.setAttribute('role', 'group');
  el.setAttribute('aria-roledescription', 'board item');
  el.setAttribute('aria-label', itemAccessibleName(item));
  // noteTint() accepts the number addNote() writes and the string older
  // builds may have saved; neither form is wrong in a .mbrd.
  const tint = noteTint(item.meta.tint);
  if (tint) el.dataset.tint = String(tint);
  writeMissing(el, item);
  if (isFence(item)) writeFenceLook(el, item);
  if (picked) el.dataset.pick = '';
  el.style.setProperty('--item-tilt', tilt);
  // Built too large to lean: the empty park tells retilt() to deal one later.
  if (leans(item) && tooLarge(item)) el.dataset.lean = '';

  const body = document.createElement('div');
  body.className = 'item-body';
  body.append(buildContent(item));
  el.append(body);

  // The bar and the far-zoom headline go on .item, not in .item-body: a
  // re-render calls replaceChildren() on the body and would drop them.
  el.append(bottomBar(item));
  if (wantsHead(item) && !isEmbedLink(item)) el.append(farHead(item));

  return el;
}

/**
 * A content-free copy of an item's outer geometry, in #item-shadows below
 * every real item, so a high card's shadow never paints across a lower card.
 * Handed back unplaced; placeBox() in items.ts puts it where the item is.
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
 * A selected card's ring and corner marks, drawn in #item-rings above every
 * card so nothing stacked over a selected card can hide it. Drawing only; the
 * grips stay on the card. No data-id, so a lookup by id never finds this.
 */
export function buildRing(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'item-ring';
  for (const g of ['nw', 'ne', 'se', 'sw']) {
    const mark = document.createElement('div');
    mark.className = 'ring-mark';
    mark.dataset.g = g;
    el.append(mark);
  }
  return el;
}

/**
 * The eight resize handles: four corners, and four edges for one axis (the
 * single letters, .grip-edge in items.css). They exist only while the card is
 * selected: kept for a card's life they were the largest part of its DOM, and
 * every zoom frame paid a style recalculation for them.
 */
const GRIPS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function setGrips(el: HTMLElement, want: boolean): void {
  // The title card's size is the style dial, and a ghost holds a fixed 3:2
  // sentence. Grips are the only way into a resize, so this is the whole lock.
  // A pinned sticky is decided by the caller (paintGrips() in canvas/items.ts).
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
 * The title card's pen, which opens the masthead style panel. Built once and
 * shown by CSS on hover or selection; a child of `.item` so it rides the card's
 * transform. The click is caught by canvas/input.ts, which owns cmds.
 */
export function buildTitleControls(el: HTMLElement): void {
  if (el.querySelector(':scope > .item-pen')) return;
  const pen = document.createElement('button');
  pen.type = 'button';
  pen.className = 'item-pen';
  pen.setAttribute('aria-label', 'Edit title style');
  pen.title = 'Edit title style';
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
  el.append(pen);
}

/**
 * Whether a card names a file that is not here - restored from a store that
 * lost it, say. Injected by main.ts, since the asset registry is storage's and
 * canvas/ does not reach into it; unwired, nothing is missing.
 */
let fileMissing: (item: ItemLike) => boolean = () => false;
export function setMissingCheck(fn: ((item: ItemLike) => boolean) | null) {
  fileMissing = fn ?? (() => false);
}

/**
 * Mark a card whose file is missing, so it reads as broken rather than blank -
 * cards.css draws the mark. At build and at every rebuild, which is when a
 * file arriving with the same hash (import/drop.ts) takes the mark away.
 */
export function writeMissing(el: HTMLElement, item: ItemLike): void {
  el.toggleAttribute('data-missing', fileMissing(item));
}

/** A note's sheet, rewritten by rebuild() once the note's menu changes it. */
export function writeNoteTint(el: HTMLElement, item: ItemLike): void {
  const tint = noteTint(item.meta.tint);
  if (tint) el.dataset.tint = String(tint);
  else delete el.dataset.tint;
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
 * The strip across a card's foot: caption left, handle right, one element so
 * the two share an edge. Built for every type; CSS decides which show a
 * caption, and shows the handle only while selected.
 */
function bottomBar(item: ItemLike): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'item-bar';
  // A fence's interior lets the pointer through, so its bar is its only hit
  // area and has to draw even with no name, or it could never be selected again.
  if (item.type === 'fence') bar.classList.add('item-bar-always');
  bar.append(nameplate(item));
  return bar;
}

/** The caption, always present and [hidden] when empty, so a rename fills it
 *  without rebuilding the bar. */
function nameplate(item: ItemLike): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'item-label';
  fillCaption(label, item);
  return label;
}

/**
 * Write a name into a caption: the stem, which fades out where it runs past
 * the plate, and the extension after it, which always shows - "a-very-long-
 * name…" said nothing about whether it was the .psd or the .png. The fade is
 * drawn only on a stem that overflows (`is-long`, set by fitCaption()).
 */
export function fillCaption(label: HTMLElement, item: ItemLike) {
  const name = shownName(item);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && /^\.[\p{L}\p{N}]{1,8}$/u.test(name.slice(dot)) ? name.slice(dot) : '';
  const stem = document.createElement('span');
  stem.className = 'item-label-stem';
  stem.textContent = ext ? name.slice(0, dot) : name;
  label.replaceChildren(stem);
  if (ext) {
    const tail = document.createElement('span');
    tail.className = 'item-label-ext';
    tail.textContent = ext;
    label.append(tail);
  }
  label.hidden = !item.name;
  markLang(label, name);
}

/** Fade the caption's stem if it runs past the plate - measured at hover, when the plate shows. */
export function fitCaption(card: HTMLElement) {
  const stem = card.querySelector<HTMLElement>(':scope > .item-bar .item-label-stem');
  if (stem) stem.classList.toggle('is-long', stem.scrollWidth > stem.clientWidth + 1);
}

/**
 * The line a card shows when too small to show anything else: `item.name`,
 * which for a note is its first line (noteName()). Built whether or not there
 * is a name and hidden without one, as nameplate() is; the stylesheet's
 * `:has(> .far-head:not([hidden]))` decides whether the body is worth drawing.
 */
function farHead(item: ItemLike): HTMLDivElement {
  const head = document.createElement('div');
  head.className = 'far-head';
  // The same string the accessible name carries; announcing it again would
  // read every card twice on a zoomed-out board.
  head.setAttribute('aria-hidden', 'true');
  // Two blocks: a line clamp cannot bite on an anonymous flex child, and the
  // rule is the kind's border so it always ends where the kind does.
  const kind = document.createElement('b');
  kind.className = 'fh-kind';
  kind.textContent = farKind(item);

  const line = document.createElement('span');
  line.className = 'fh-name';
  line.textContent = shownName(item);
  markLang(line, line.textContent);

  head.append(kind, line);
  head.hidden = !item.name;
  return head;
}
