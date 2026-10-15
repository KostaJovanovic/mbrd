// Ghost card copy and lifecycle. state.ts owns the items; this owns the words
// and the dismissal. Rows with `desktop: true` are hidden on mobile by CSS.

import { bus, dismissGhosts, hasContent, hasGhosts, isNotFoundBoard } from '../state.ts';
import type { Item } from '../board-model.ts';
import { cue } from '../cuelume/engine.ts';
import { icon } from '../util.ts';

export type HintRow = {
  icon: string;
  label: string;
  desktop?: true;
};

export type Hint = {
  title: string;
  line?: string;
  rows?: readonly HintRow[];
  href?: string;
  go?: string;
  /** A command the card's button runs - see GhostCommands. */
  run?: 'appTour';
};

export type HintKey = 'drop' | 'move' | 'formats' | 'whimsy' | 'gone' | 'back';

export const HINTS: Readonly<Record<HintKey, Hint>> = Object.freeze({
  drop: {
    title: 'A surface for thinking',
    rows: [
      { icon: 'i-move', label: 'Drag or two fingers to pan' },
      { icon: 'i-zoom-in', label: 'Wheel or pinch to zoom' },
      { icon: 'i-select-all', label: 'Shift-drag to select', desktop: true },
    ],
    go: 'Show me around',
    run: 'appTour',
  },
  move: {
    title: 'Whatever you\'re gathering',
    rows: [
      { icon: 'i-plus', label: 'Drop files anywhere' },
      { icon: 'i-link', label: 'Add a link' },
      { icon: 'i-pen', label: 'Write a note' },
    ],
  },
  formats: {
    title: 'Almost anything you have',
    rows: [
      { icon: 'i-picture', label: 'Images, video, audio, 3D' },
      { icon: 'i-edit-text', label: 'PDFs, documents, code' },
      { icon: 'i-music', label: 'Music becomes a playlist' },
    ],
  },
  whimsy: {
    title: 'Whimsy',
    line: 'Playful, or plain.',
  },

  gone: {
    title: '404',
    line: 'Nothing of ours lives at that address. This board is blank and it is not yours - nothing on it is saved, and your own is exactly where you left it.',
  },
  back: {
    title: 'Back to the board',
    line: 'Open the app at its own address. Your last board comes back with it.',
    href: '/',
    go: 'Open mbrd',
  },
});

/** The hint whose card holds a control rather than a paragraph. */
export const DIAL = 'whimsy';

/**
 * The names of the three whimsy stops, printed under the dial.
 *
 * The same three words the sidebar prints under the same slider, because it is
 * the same slider - see ui/settings-schema.ts, where the panel's copy of this
 * list lives. Duplicated rather than imported: the list is owned by ui/, which
 * canvas/ may not reach into, and three words are a cheaper duplicate than a
 * new module in the base layer. Whichever way it were shared, the panel and the
 * card would still have to be changed together, so the trailing full stop on
 * "Harsh." is kept exactly - it is the joke the panel already tells.
 */
export const STOPS: readonly string[] = Object.freeze(['Softish', 'Middle', 'Harsh.']);

/** The stop name for a level, for the value a screen reader reads out. */
export const stopName = (level: number): string => STOPS[level] || STOPS[1];

/**
 * The key an item actually resolves to, falling back to the first hint.
 *
 * The test is on the entry, not on the key, and the cast says only that: a key
 * out of a file is checked by what it looks up rather than by its spelling.
 */
export const hintKey = (key: string | undefined): HintKey => {
  // SAFETY: both assertions are the lookup, which is the paragraph above - the
  // key is checked by what it finds in HINTS rather than by its spelling, and a
  // key that finds nothing takes 'drop'. The first cast is only what lets an
  // arbitrary string be looked up at all.
  return HINTS[key as HintKey] ? key as HintKey : 'drop';
};

/**
 * A strip of tape as state.ts's tapeFor() places it: an edge, how far along it,
 * an optional turn and a length in px. `edge` stays a plain string because it
 * arrives from a stored board and tapeStyle() falls back rather than refuses.
 */
export type Tape = { edge: string; pos: number; rot?: number; len: number };

/** The same strip as CSS wants it: two percentages, an angle and a length. */
export type TapeStyle = { x: string; y: string; rot: string; len: string };

/**
 * Where one strip of tape sits, as the four numbers CSS needs.
 *
 * The placement (see tapeFor in state.ts) names an edge and a percentage along
 * it; this turns that into a point in the card's box and an angle. The strip is
 * centred on that point - `translate(-50%, -50%)` in the stylesheet - so half of
 * it is on the card and half is off, which is the only arrangement that reads as
 * tape rather than as a printed band.
 *
 * The two vertical edges add a quarter turn, because a strip laid down the side
 * of a page runs with the side.
 *
 * Pure, so tests can check the geometry without a DOM.
 */
export function tapeStyle(t: Tape): TapeStyle {
  const pos = `${t.pos}%`;
  const along: Record<string, [string, string]> =
    { top: [pos, '0%'], bottom: [pos, '100%'], left: ['0%', pos], right: ['100%', pos] };
  const [x, y] = along[t.edge] || along.top;
  const turn = t.edge === 'left' || t.edge === 'right' ? 90 : 0;
  return { x, y, rot: `${(t.rot || 0) + turn}deg`, len: `${t.len}px` };
}

/** Copy for a ghost item, falling back to the first hint for an unknown key. */
export function hintFor(key: string | undefined): Hint {
  return HINTS[hintKey(key)];
}

/**
 * Watch for the board's first real content and sweep the hints when it lands.
 *
 * One subscriber on 'items' rather than a call at each door. A ghost has to go
 * when a file is dropped, when a note is added, when something is pasted, when
 * the bin gives something back, when a whole arrangement is imported - and
 * every one of those already ends in an 'items' emit. Hunting them down
 * individually is how one of them gets missed.
 *
 * Leaving is not this file's job either, as it turns out. dismissGhosts() emits
 * a delta naming the removed ids, and canvas/items.ts already flies out every
 * node in a removed delta - so a ghost exits with the same whimsy feel as any
 * deleted card (fall / dissolve / shatter) without a line here asking for it.
 * The one thing that has to be true for that is that the emit carries the ids,
 * which is why dismissGhosts() returns them rather than emitting bare.
 */
/**
 * The command surface, handed in rather than imported.
 *
 * The dial on the fourth card changes the whimsy level, and that lives in
 * ui/appearance.ts - which this file may not import, since canvas/ sits below
 * ui/ and tests/layers.test.js enforces it. main.ts owns `cmds` and hands it
 * down here, the same move it makes for storage's confirmation prompt
 * (setPrompt). So the dial drives the one command surface everything else does.
 */
type GhostCommands = { setWhimsy?: (level: number) => void, appTour?: () => void };

let cmds: GhostCommands | null = null;

/** A hint card's button: the example board and its tour, for the first card. */
export const runHint = (name: NonNullable<Hint['run']>) => cmds?.[name]?.();

/** Move the whole interface along the whimsy axis, from the card's dial. */
const setWhimsyLevel = (level: number) => cmds?.setWhimsy?.(level);

/**
 * Put a dial on a level: the thumb, and the word a screen reader reads out.
 *
 * The printed stops are what a sighted user reads and are hidden from the
 * accessibility tree, so the name has to reach the input itself - otherwise the
 * dial announces "1 of 2", which names nothing. Same move ui/mobile-header.ts
 * makes on the weight dial.
 */
function showLevel(dial: HTMLInputElement, level: string) {
  if (dial.value !== level) dial.value = level;
  dial.setAttribute('aria-valuetext', stopName(+level));
}

/**
 * Keep every mounted dial showing the level the interface is actually at.
 *
 * The level can be moved from the settings panel as well as from this card, and
 * an <input> that has drifted from the thing it controls is worse than no input
 * at all. Rather than have ui/appearance.ts learn about a card it cannot see,
 * this watches the one thing it already writes on every change: data-whimsy on
 * <html>. canvas/grid.ts reads the same attribute for the same reason.
 *
 * One observer for the app, not one per card - there are at most a handful of
 * dials and they are gone the moment the board has anything on it.
 */
function watchWhimsy() {
  if (typeof MutationObserver !== 'function') return;
  const root = document.documentElement;
  new MutationObserver(() => {
    const level = root.dataset.whimsy ?? '1';
    for (const dial of document.querySelectorAll<HTMLInputElement>('.ghost-dial input'))
      showLevel(dial, level);
  }).observe(root, { attributes: true, attributeFilter: ['data-whimsy'] });
}

/** Wire a freshly built dial: drive the axis, and keep its own valuetext true. */
export function bindDial(dial: HTMLInputElement): void {
  showLevel(dial, dial.value);
  // Once per element. buildGhostCard() binds the slider it has just built, and
  // ui/feed.ts binds it again after calling that same builder - so on the Feed
  // every move of the dial called setWhimsyLevel() twice. A flag on the node
  // rather than a set here, for the reason canvas/stills.ts gives about the
  // still twin's URL: the node is what goes away.
  if (dial.dataset.dialBound) return;
  dial.dataset.dialBound = '1';
  dial.addEventListener('input', () => {
    showLevel(dial, dial.value);
    setWhimsyLevel(+dial.value);
  });
}

export function initGhosts(commands: GhostCommands | null | undefined): void {
  cmds = commands || null;
  watchWhimsy();
  bus.on('items', () => {
    // dismissGhosts() emits 'items' itself, so this runs again immediately -
    // and stops here, because by then there are no ghosts left. That is the
    // whole re-entrancy story; it is one level deep and it terminates.
    if (!hasGhosts() || !hasContent()) return;
    // The not-found set is not swept. A hint is earned away by doing the thing
    // it describes; these are a statement about the address, and one of them is
    // the way off it. See isNotFoundBoard() in state.ts for the whole argument.
    if (isNotFoundBoard()) return;
    dismissGhosts();
  });
}

/**
 * A ghost card: one of the three hints a brand-new board opens with, and
 * RENDERERS.ghost in renderers.ts.
 *
 * Structure only. What it says comes from HINTS above (the item carries a key,
 * not prose), and what it looks like is entirely items.css: a dashed outline at
 * Middle and Harsh, a page torn out of a pad and taped down at Softish - except
 * for the dial, which stays an ordinary card at every tier. Nothing here reads
 * the whimsy level to draw with, because nothing here needs to - the level is
 * on <html> as data-whimsy and CSS can see it. The dial reads it, but as a
 * value to show, not as a look.
 *
 * classify() is not involved and never will be. That function routes dropped
 * *files*, and no file is ever a hint; these are minted by state.ts on an
 * empty board and by nothing else.
 */
export function buildGhostCard(item: Item): DocumentFragment {
  const said = typeof item.meta?.hint === 'string' ? item.meta.hint : '';
  // A fragment, not a card, and that is load-bearing. At Softish the card is
  // perforated by a CSS mask, and a mask applies to an element's descendants
  // as well as to itself - tape drawn inside the card would be punched full
  // of the same holes. So the strips are siblings of the card, and both land
  // in .item-body together. items.ts appends whatever this returns, and
  // append() spreads a fragment, so nothing there had to change.
  const frag = document.createDocumentFragment();
  const card = document.createElement('div');
  card.className = 'card ghost-card';
  // The key reaches the DOM as well as the words, because Softish gives each
  // hint a torn silhouette of its own and CSS has to be able to tell them
  // apart. It cannot do that by position: these are children of #world
  // alongside the web, the shadow layer and the title card, so :nth-child
  // counts things that are not cards and hands two hints the same outline.
  const key = hintKey(said);
  card.dataset.hint = key;
  const { title, line, rows, href, go: goes, run } = hintFor(said);
  // Every hint but the dial prints its title here, at the head of the card and
  // ranged left. The dial prints its own, inside the row and centred over the
  // track - see below.
  if (key !== DIAL) {
    const head = document.createElement('div');
    head.className = 'ghost-title';
    head.textContent = title;
    card.append(head);
  }

  if (key === DIAL) {
    // A hint you operate rather than read. The range input is what makes
    // canvas/input.ts let the press through - its widget branch names `input`
    // outright, so a drag on the thumb moves the thumb and not the card.
    //
    // .field is the sidebar's own form row, borrowed whole rather than
    // imitated: the track, the lozenge thumb, the stop names underneath and
    // the way all three answer the whimsy axis are one block of CSS in the
    // panel's section, and a second copy of it here would be a second thing to
    // remember. This is the same slider, so it is the same class.
    //
    // The head is .field's own as well, and it carries the title instead of
    // the card printing one: a card's title is ranged left at the top of it,
    // and what this one wants is the word centred over the track it names,
    // with the three stops under it. `is-dial` is that centring.
    const row = document.createElement('div');
    row.className = 'ghost-dial field is-dial';
    const head = document.createElement('span');
    head.textContent = title;
    row.append(head);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '2';
    slider.step = '1';
    // The level the interface is at, read off the attribute ui/appearance.ts
    // writes - the same source watchWhimsy() keeps this in step with.
    slider.value = document.documentElement.dataset.whimsy ?? '1';
    slider.setAttribute('aria-label', title);
    // The detent tick, inline rather than through ui/controls.ts's
    // tickSlider(). That helper is where every other slider in the app gets
    // this, and this one cannot have it: canvas/ may not import ui/, which
    // tests/layers.test.js enforces and architecture.md calls a layering
    // regression rather than a style note. What tickSlider() computes is
    // whether a slider has few enough stops to be worth marking, and this one
    // has three, written two lines up - so the arithmetic it exists for has
    // no work to do here and only the listener is copied.
    let ticked = slider.value;
    slider.addEventListener('input', () => {
      if (slider.value === ticked) return;
      ticked = slider.value;
      cue('pick');
    });

    // The stops, built the way ui/panel.ts builds them: names rather than a
    // <datalist>, which Chromium ignores on a painted track and Firefox draws
    // as ticks whose ends vanish into the rounded ends of it. Hidden from the
    // accessibility tree, because the same three words reach a screen reader
    // through the dial's own aria-valuetext (see bindDial).
    //
    // Under the track, the same way round as the panel: the name of the axis
    // over it, the names of its three stops under it.
    const stops = document.createElement('span');
    // The styling hook is a *class*, and the id is only the target for
    // aria-describedby: ui/feed.ts calls this same builder, so with the Feed
    // up and the canvas card mounted the document holds two dials, and one
    // hardcoded id would resolve the Feed slider's description to the canvas's
    // node. quality.css reaches both whimsy rows through .whimsy-stops and
    // #whimsy-stop-labels.
    stops.className = 'field-stops whimsy-stops';
    stops.id = `ghost-whimsy-stops-${item.id}`;
    stops.setAttribute('aria-hidden', 'true');
    for (const name of STOPS) {
      const stop = document.createElement('span');
      stop.textContent = name;
      stops.append(stop);
    }
    slider.setAttribute('aria-describedby', stops.id);
    row.append(slider, stops);

    bindDial(slider);
    card.append(row);
  } else if (rows) {
    // A legend rather than a paragraph, which is what all three hints print;
    // the prose branch below is the not-found pair's.
    //
    // .ico is base.css's, plain screen pixels - which on a card is what is
    // wanted, since the whole card is inside the board transform and a 16px
    // glyph there zooms with the words beside it.
    const list = document.createElement('div');
    list.className = 'ghost-keys';
    for (const { icon: glyph, label, desktop } of rows) {
      const row = document.createElement('div');
      row.className = 'ghost-key';
      // Named rather than hidden here: Mobile and Desktop share the item, the
      // card is rebuilt on a layout switch either way, and a row that CSS can
      // drop is one list instead of two. See HintRow above.
      if (desktop) row.dataset.only = 'desktop';
      const word = document.createElement('span');
      word.textContent = label;
      row.append(icon(glyph), word);
      list.append(row);
    }
    card.append(list);
    // A command from the hint itself, as the href below is, never from the item.
    if (run) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'ghost-go';
      go.textContent = goes || title;
      go.addEventListener('click', () => runHint(run));
      card.append(go);
    }
  } else {
    const body = document.createElement('div');
    body.className = 'ghost-line';
    body.textContent = line ?? '';
    card.append(body);
    // A hint carrying an href is one you follow. Only the not-found set has
    // one today - the way back off a dead address - and it is built here
    // rather than being a fourth branch because it is still a line of prose;
    // the anchor sits under it as the thing you press. The href comes from
    // the hint, never from the item, so nothing a board could carry can put a
    // link on a card.
    if (href) {
      const go = document.createElement('a');
      go.className = 'ghost-go';
      go.href = href;
      go.textContent = goes || title;
      card.append(go);
    }
  }
  frag.append(card);

  // Built at every tier and shown only at Softish (the CSS hides it
  // otherwise), so sliding the whimsy dial does not have to rebuild a card.
  for (const t of Array.isArray(item.meta?.tape) ? item.meta.tape : []) {
    const strip = document.createElement('div');
    strip.className = 'ghost-tape';
    const { x, y, rot, len } = tapeStyle(t);
    strip.style.setProperty('--t-x', x);
    strip.style.setProperty('--t-y', y);
    strip.style.setProperty('--t-rot', rot);
    strip.style.setProperty('--t-len', len);
    frag.append(strip);
  }
  return frag;
}
