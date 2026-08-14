// The toolbar: the surface that says a board is made by putting things on it.
//
// Three jobs. It presses commands - every button in the markup carries a
// data-cmd and this module resolves it against the command surface, exactly as
// ui/sidebar.js does for the panel. On a phone it owns the open/closed state of
// the tier the buttons live in, because at that width the bar is a drawer
// rather than a strip. And it holds the connector tool's armed state, which is
// the one thing on this bar that is a *mode* rather than an action.
//
// It deliberately knows nothing about what any of those commands do. A tool is
// added by writing a button in index.html and an entry in commands.js; nothing
// here needs to hear about it, which is the same bargain the panel makes and
// the reason a new user-facing action is one entry rather than three.
//
// The armed state is the exception, and it is worth being honest that it is
// one. mbrd has never had a mode: every gesture in the app means the same thing
// whatever came before it, and "why is clicking not selecting?" is a question
// nobody has ever had to ask. Three things exist to keep it that way - the
// button says so with aria-pressed, Escape always gets out, and the tool stays
// armed after a pair so connecting five things is one trip to the toolbar
// rather than five. Whether that is enough is a thing to watch in real use.
//
// `cmds` is handed in by initToolbar() rather than imported, for the reason
// ui/hud.js states: commands.js imports *this* module (Escape closes the
// drawer, and the connector tool is driven from there), and the arrow may only
// go one way.

import { el } from '../util.ts';
import { board, bus, isJoinEnd, toggleConnection } from '../state.ts';
import { toast } from '../notify.ts';
import { setConnectPick } from '../canvas/items.ts';
// The line that follows the pointer out of the picked card. Written from the
// same place as the ring, because they are one state: a pick with no draft is
// the tool saying it has an end and not saying what it would do with it.
import { setDraftFrom } from '../canvas/web.ts';

/** data-cmd="add-files" -> cmds.addFiles. The panel's own mapping. */
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The command surface, as this module sees it: a lookup by name and nothing
 * else. Every button on the bar carries a data-cmd, so the index signature is
 * the whole of the contract - see the note above about knowing nothing of what
 * any of them do.
 */
export interface ToolbarCommands {
  [name: string]: ((...args: never[]) => unknown) | undefined;
}

let bar: HTMLElement | null = null;
let toggle: HTMLElement | null = null;

export function initToolbar(cmds: ToolbarCommands): void {
  bar = el('toolbar');
  toggle = el('toolbar-toggle');

  // Both ids are declared in index.html; this module has always read them
  // straight through, and an absent one is a broken build.
  toggle!.addEventListener('click', () => setOpen(!isOpen()));

  bar!.addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    const fn = cmds[camel(btn.dataset.cmd!)];
    if (!fn) return;
    fn();
    // Except the one command whose whole result is a menu hanging off the bar.
    // The three tools behind More are still on the tier - they are only hidden
    // from it - and closing the drawer would take the button the menu is pointing
    // at out from under it, leaving a panel in mid-air over a bar that is gone.
    // The rest of the row is unchanged: everything here makes something, and a
    // drawer left standing over the thing you just made is in the way of it.
    if (btn.dataset.cmd === 'more-tools') return;
    // A drawer that stays open over the board after you have used it is in the
    // way of the thing you just made. Harmless on a desktop, where the bar is
    // always out and the class means nothing.
    //
    // After fn(), not before: the connector tool arms itself inside its own
    // command, and closing the drawer must not be able to look like disarming
    // it. setOpen() touches the drawer and nothing else, for exactly that
    // reason - it is closeToolbar() that also puts the tool down.
    setOpen(false);
  });

  // A board arriving, or the layout switching under it, both leave a drawer
  // standing over something it no longer describes - and an armed tool pointing
  // at a card that is no longer there.
  bus.on('board:load', () => { setOpen(false); setArmed(false); });
  bus.on('layout', () => { setOpen(false); setArmed(false); });
  // A card being deleted while it is the picked end. Cheaper to drop the pick
  // than to check it: the pick is one id and the alternative is a lookup on
  // every add, remove and load.
  bus.on('items', () => setPick(null));
}

export const isOpen = () => !!bar?.classList.contains('is-open');

/**
 * Open or shut the phone's tier.
 *
 * The class and aria-expanded are written together, and that is not
 * bookkeeping: the class is what the stylesheet moves the tier and the player
 * with, and the attribute is the only thing that tells a screen reader the
 * button did anything at all. Written here rather than in the toggle's own
 * listener because three other things close this - a command firing, a board
 * loading, Escape - and each of them owes both halves.
 */
export function setOpen(open: boolean): void {
  if (!bar) return;
  bar.classList.toggle('is-open', !!open);
  toggle!.setAttribute('aria-expanded', String(!!open));
}

/** Escape's half. See cmds.closeSidebar - one key, every sheet that is up, and
 *  the tool put back down. Escape is the way out of a mode; it has to be. */
export const closeToolbar = () => { setOpen(false); setArmed(false); };

// ---------------------------------------------------------------------------
// The connector tool
// ---------------------------------------------------------------------------

/** Whether a press on a card means "connect this" rather than "select this". */
let armed = false;
/** The first end, once one has been chosen. Null between pairs. */
let pick: string | null = null;

/**
 * What one press does, as a total function of the state and what was hit.
 *
 * Pure, and lifted out for that reason: this is the whole of the interaction,
 * it is four cases, and every one of them is a sentence somebody has to be able
 * to check. `id` is the card that was pressed, or null for empty canvas.
 *
 *   nothing picked, a card      pick it
 *   one picked, a different card    join them, and clear the pick
 *   one picked, the same card       clear the pick - a card joined to itself
 *                                   is not a connection, and pressing the card
 *                                   you just picked is how you change your mind
 *   anything, empty canvas          clear the pick
 *   anything, a card no line can    refuse it, and *keep the pick*
 *   reach
 *
 * What it never does is disarm. Staying armed after a pair is what makes
 * connecting five things one trip to the toolbar, and clicking empty canvas is
 * "not that one" rather than "stop" - Escape and the button are the two ways to
 * stop, and both of them are unmistakable.
 *
 * `joinable` is the fifth case and the reason this function grew a parameter
 * rather than an import. It stays pure: the caller answers "may this id be an
 * end", because the answer needs the board and this file is four lines of
 * arithmetic that a test can drive with strings. Passing it *false* is not the
 * same as passing empty canvas, and the difference is the whole point - empty
 * canvas is "not that one" and clears the pick, while a sticker is a slip of the
 * hand and must cost nothing. Losing a standing pick to a mis-tap means pointing
 * at the first card again.
 *
 * `refused` is separate from the pick because the caller has to say something.
 * Silence here is what the defect was: the pair went into the board, saved,
 * survived a reload, and was never drawn, and the only way to find out was to
 * read the file.
 */
export function connectStep(
  from: string | null,
  id: string | null,
  joinable = true,
): { pick: string | null; connect: [string, string] | null; refused: boolean } {
  if (!id) return { pick: null, connect: null, refused: false };
  // Before every other case, including `from === id`: a sticker you picked by
  // mistake cannot have been picked in the first place, so there is no
  // "pressing it again to change your mind" to honour.
  if (!joinable) return { pick: from, connect: null, refused: true };
  if (!from) return { pick: id, connect: null, refused: false };
  if (from === id) return { pick: null, connect: null, refused: false };
  return { pick: null, connect: [from, id], refused: false };
}

/**
 * Arm or disarm. Written through here so the button and the mark never drift.
 *
 * `from` is the end to arm *on*, for the one caller that has an answer already:
 * a card that was selected when the tool was pressed is a card you have already
 * pointed at, and making you point at it again is the tool pretending not to
 * have seen. Ignored when disarming - putting the tool down cannot leave a pick
 * standing - which is why the two are one write rather than an arm and a
 * separate seed that a `bus.on('items')` could land between.
 */
export function setArmed(on: boolean, from: string | null = null): void {
  armed = !!on;
  setPick(armed ? from : null);
  bar?.querySelector('[data-cmd="connect"]')?.setAttribute('aria-pressed', String(armed));
  // A board-wide cursor, and the honest half of saying the app is in a mode:
  // the button is at the top of the screen and the hand is on a card at the
  // bottom of it. Same shape as data-snap and data-whimsy - the flag goes on
  // the root element and the stylesheets take it from there.
  document.documentElement.classList.toggle('is-connecting', armed);
}

export const connectArmed = () => armed;

function setPick(id: string | null): void {
  pick = id || null;
  setConnectPick(pick);
  setDraftFrom(pick);
}

/**
 * A press on the board while the tool may be armed.
 *
 * Returns whether the connector took the press. False is the answer on every
 * ordinary board and on every press of an unarmed one, which is what keeps this
 * to a single boolean read on the pointer path in canvas/input.js.
 */
export function connectTap(id: string | null): boolean {
  if (!armed) return false;
  const next = connectStep(pick, id, !id || canJoin(id));
  setPick(next.pick);
  if (next.refused) toast('A sticker is already a remark about the card under it');
  if (next.connect) toggleConnection(next.connect[0], next.connect[1]);
  // True even when the tap was refused, and deliberately: the press was the
  // connector's, it has been answered, and falling through into selection would
  // put the sticker in the selection as a consolation prize for a gesture that
  // was about something else.
  return true;
}

/**
 * May a line reach this id?
 *
 * The same question the draw path asks, asked one gesture earlier. `centres()`
 * in canvas/web.js filters the ends it places through isJoinEnd(), so a pair
 * naming anything else is skipped every frame - which is invisible, permanent,
 * and survives a save. The selection door already asked it (`joinable` in
 * commands/connections.js); this is the tap door catching up.
 *
 * isRider() is deliberately *not* part of it, though the draw path refuses that
 * too. A rider is a note stuck to something right now; unstick it and the line
 * appears. Refusing here would turn a temporary display rule into a permanent
 * refusal, which is a bigger loss than the bug.
 */
function canJoin(id: string): boolean {
  return isJoinEnd(board.items.find(i => i.id === id));
}
