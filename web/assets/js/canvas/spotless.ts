// The card the cleaning simulator leaves on the board: the board before and
// after, a line, and a second line under the pointer. A type of its own rather
// than a picture, so it follows the palette like every other card. Its frames
// are written into `meta` when it is made (ui/clean/clean.ts), and read back
// through spotlessRects(), which trusts nothing in a file it did not write.

import type { Item } from '../board-model.ts';

/**
 * One frame of the two, and the room round the board inside it. The card's whole
 * face is drawn to FACE_W x FACE_H and scales with the card.
 *
 * **Changing these two numbers throws away the "before" on every card already
 * made.** `meta.before` holds each dealt card's rectangle in *this* frame's
 * coordinates, and spotlessRects() drops anything that does not fit inside it -
 * so a frame that shrinks silently empties the left-hand picture on a card
 * somebody kept. Which is why the face's shape is got out of TEXT_H below and not
 * out of here: the card has been reshaped twice and the frame has not moved.
 */
export const SPOTLESS_FRAME = { w: 104, h: 78, pad: 7 } as const;

const PAD = 12;
const GAP = 8;

/**
 * The two lines under the frames: where each sits below them, and the room the
 * block takes in all.
 *
 * TEXT_H is the one number here chosen for the *card* rather than for the type.
 * The face is one SVG stretched over the card's box, so a viewBox of a different
 * shape would be letterboxed inside it - bands of bare paper along two edges of
 * a card whose whole job is to be looked at. The card is four grid spaces by
 * three (SPOTLESS_SIZE), so the face has to be 4:3, and with the frame fixed at
 * 104 x 78 and FACE_W therefore 240, that pins FACE_H at 180 and TEXT_H at 78.
 *
 * The two baselines are then spread through it rather than left where they were
 * under a 58-unit block, which would have hung both lines at the top of it with
 * forty units of nothing underneath.
 */
const SAID_Y = 34;
const COUNT_Y = 58;
const TEXT_H = 78;

/** 240 x 180, which is 4:3 exactly. See TEXT_H. */
const FACE_W = PAD * 2 + SPOTLESS_FRAME.w * 2 + GAP;
const FACE_H = PAD + SPOTLESS_FRAME.h + TEXT_H + PAD;

/** What was on the board, as it was dealt: where each card sat in a frame, and
 *  the colour of what was on it. */
export type SpotlessRect = { x: number, y: number, w: number, h: number, colour: string };

/** More than any board the mode deals from, and small enough that a crafted
 *  file cannot make one card draw a hundred thousand rectangles. */
const MOST = 400;

/** A colour as the mode writes one - `rgb(132 100 66)` or a hex - and nothing
 *  else. It only ever reaches setAttribute(), but a file is a file. */
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([0-9 .,%/]{1,40}\))$/i;

/** meta.before read back: every entry that is four finite numbers inside the
 *  frame and a colour, and nothing else. */
export function spotlessRects(before: unknown): SpotlessRect[] {
  if (!Array.isArray(before)) return [];
  const out: SpotlessRect[] = [];
  for (const entry of before.slice(0, MOST)) {
    if (!Array.isArray(entry) || entry.length !== 5) continue;
    const [x, y, w, h, colour] = entry;
    if (typeof colour !== 'string' || !COLOUR.test(colour)) continue;
    const nums = [x, y, w, h];
    if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) continue;
    // SAFETY: every one of the four was just checked to be a finite number.
    const [nx, ny, nw, nh] = nums as number[];
    if (nx < 0 || ny < 0 || nw <= 0 || nh <= 0) continue;
    if (nx + nw > SPOTLESS_FRAME.w + 0.01 || ny + nh > SPOTLESS_FRAME.h + 0.01) continue;
    out.push({ x: nx, y: ny, w: nw, h: nh, colour });
  }
  return out;
}

/** Who finished the board. The robot's card says something else. */
export const spotlessBy = (item: Item): 'hand' | 'robot' => (item.meta?.by === 'robot' ? 'robot' : 'hand');

/** The line on the card, and the one under the pointer. Placeholders the
 *  maintainer means to replace, kept together so that is one edit. */
export const SPOTLESS_WORDS = {
  hand: { said: 'Everything is spotless.', hover: 'I cleaned the whole board and all I got was this lousy card' },
  robot: { said: 'The future, today', hover: 'This will be cleaning in 2013' },
} as const;

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const cardsSaid = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;

/** Far past any board the mode would deal (it cleans thirty at most), and short
 *  of a number that stops reading as a count. */
const SPOTLESS_MOST = 9999;

/** How many cards the card says were cleaned. From a file the app may not have
 *  written, so a finite whole number in range or the drawing's own count - a
 *  1e999 in the JSON is Infinity, and "Infinity cards" is not a card. */
export function spotlessCount(said: unknown, drawn: number): number {
  if (typeof said !== 'number' || !Number.isFinite(said) || said < 0 || said > SPOTLESS_MOST) return drawn;
  return Math.floor(said);
}

/**
 * The card. One SVG for the whole face, so it keeps its layout at any size the
 * card is dragged to. The "before" rectangles carry the colours written into
 * the item; the "after" ones and every other colour are the stylesheet's
 * (items.css), which is what keeps the card in the board's palette.
 */
export function buildSpotlessCard(item: Item): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card spotless-card';
  const by = spotlessBy(item);
  const words = SPOTLESS_WORDS[by];
  const rects = spotlessRects(item.meta?.before);
  const count = spotlessCount(item.meta?.cards, rects.length);

  const face = el('svg', { viewBox: `0 0 ${FACE_W} ${FACE_H}`, class: 'spotless-face', 'aria-hidden': 'true' });
  for (const [n, before] of [[0, true], [1, false]] as const) {
    const ox = PAD + n * (SPOTLESS_FRAME.w + GAP);
    face.append(el('rect', {
      x: ox, y: PAD, width: SPOTLESS_FRAME.w, height: SPOTLESS_FRAME.h, rx: 2, class: 'spotless-frame',
    }));
    for (const r of rects) {
      const box = el('rect', {
        x: (ox + r.x).toFixed(2), y: (PAD + r.y).toFixed(2),
        width: r.w.toFixed(2), height: r.h.toFixed(2),
        rx: Math.min(1.5, r.w / 4, r.h / 4).toFixed(2),
        class: before ? 'spotless-before' : 'spotless-after',
      });
      if (before) box.setAttribute('fill', r.colour);
      face.append(box);
    }
  }
  const said = el('text', { x: FACE_W / 2, y: PAD + SPOTLESS_FRAME.h + SAID_Y, class: 'spotless-said' });
  said.textContent = words.said;
  const counted = el('text', { x: FACE_W / 2, y: PAD + SPOTLESS_FRAME.h + COUNT_Y, class: 'spotless-count' });
  counted.textContent = cardsSaid(count);
  face.append(said, counted);

  const hover = document.createElement('div');
  hover.className = 'spotless-hover';
  hover.textContent = words.hover;
  card.append(face, hover);
  return card;
}

/**
 * The card's box on the board: **four grid spaces by three** at the default
 * step, the way every other size in defaultSize() is reckoned - so a snapped
 * board lays the card where it already is rather than a quarter of a cell off.
 * It was 336 x 224, which is five and a quarter cells by three and a half.
 *
 * Whole cells are what decide the face's shape rather than the other way round.
 * See TEXT_H.
 */
export const SPOTLESS_SIZE = { w: 256, h: 192 };
