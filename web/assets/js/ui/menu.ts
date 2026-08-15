// Right-click menu - and, through openAnchored(), the renderer every other menu
// in the app is drawn by.
//
// The canvas already suppresses the browser's own menu (input.js), because a
// board's useful actions are all spatial - "put a note *here*", "zoom to
// *this*" - and a generic browser menu can't express any of them. The world
// point under the cursor is captured when the menu opens and handed to the
// action, so "Add a note here" means here even after the menu has closed.
//
// One menu exists at a time. It is built fresh on each open rather than kept
// hidden, so entries can be enabled, checked or omitted per context.
//
// ── The renderer, and who else uses it ──
//
// render() below is the whole of what a menu is here: an array of plain entry
// objects in, a placed panel out, with the arrow keys walking it and initMenu's
// listeners closing it on every event that would make its anchor a lie. The
// toolbar's hover flyouts (ui/flyout.js) are the same panel opened under a
// button instead of at a cursor, and they are drawn through openAnchored()
// rather than through a second implementation - which is why the entry
// vocabulary grew `swatch` and `range` rows that no right-click fold uses yet.
//
// The single `node` is right for both. A right-click and a hover flyout cannot
// be up at once: the capture-phase pointerdown that closes on an outside press
// fires before either could open the other.
//
// Every entry carries an `icon`, naming a <symbol> in assets/icons.svg - the
// same file the toolbar and the rest of the chrome draw from, so an action that
// appears in two places wears one face. All of them, deliberately: a menu with
// icons on the half of it somebody thought worth marking reads as a menu with
// pieces missing, and the eye stops using the column as a column. Where an
// action is already on the toolbar the entry names that toolbar icon and no
// second drawing exists - the item menu's "Add a note here" wears the toolbar's
// pen.
//
// ── One resting home per action ──
//
// Sharing the icon was the answer to an action appearing twice. It is not an
// answer to an action appearing four times, which is what add-note managed:
// toolbar, canvas menu, item menu and the panel, under two different names. The
// canvas menu has since given up its six duplicated rows (see canvasEntries).
//
// The rule that replaced them: an action rests in exactly one place - one you
// can see without doing anything - and may be repeated elsewhere only where the
// repeat reaches something the resting home cannot. The cursor point is the
// usual excuse and a good one; "also handy" is not one. A keyboard accelerator
// is not a second home and never counted against this.

// Reached straight rather than through cmds, which every other entry here goes
// by. Renaming *is* the name drawn on the item, so the affordance lives with
// the code that draws it, and routing it through the command surface would add
// a second name for it and nothing else. canvas/notes.js takes the same
// shortcut to the same module for the same reason.
import { canRenameItem, editItemName } from '../canvas/items.ts';
import { STICKER_TINT_NAMES } from '../stickers/catalogue.ts';
import type { ConnMeta, ConnColor, ConnWeight } from '../board-model.ts';
import type { Point } from '../geometry.ts';
import type { Viewport } from '../canvas/viewport.ts';

/**
 * A slider row - see rangeRow(). `get` and `set` are the dial's two ends, so the
 * value lives wherever it already lived rather than in the menu.
 */
export type MenuRange = {
  min: number;
  max: number;
  step: number;
  unit?: string;
  /**
   * `unknown` for the reason `check` below is: what a dial reads is a board
   * setting, and getSetting() knowing that a key can be read is not knowing what
   * came back. rangeRow() only ever puts it through String(), which is the whole
   * of what a slider's starting position is.
   */
  get: () => unknown;
  set: (value: number) => void;
};

/**
 * One row, as every builder in this file and every flyout in ui/flyout.ts writes
 * one. Flat rather than a union of the five kinds render() actually draws, and
 * that is a statement about how the rows are written: `sub` is handed a ternary
 * on the one row that only has children in one case, and a discriminated union
 * would refuse the shape the menu is easiest to read as.
 *
 * `check` is `unknown` because the ticks come from settings - getSetting() gives
 * back a board setting and knowing that a key can be read is not knowing what
 * came back. render() only ever asks whether it is present and whether it is
 * truthy, which is the whole of what a tick is.
 */
export type MenuEntry = {
  label?: string;
  /** a <symbol> in assets/icons.svg, by name */
  icon?: string;
  accel?: string;
  check?: unknown;
  hidden?: boolean;
  danger?: boolean;
  sep?: boolean;
  /**
   * A colour drawn in the icon column instead of an icon - or several, drawn as
   * one split chip.
   *
   * The list form arrived with the palette picker, whose rows are choices
   * between whole palettes rather than between single colours: three bands of
   * paper, accent and ink say which palette a row is far better than any one of
   * the three alone. A bare string is still a bare string and draws exactly as
   * it did for the note tints and the connection colours.
   */
  swatch?: string | string[];
  /**
   * The same colours, on the trailing edge instead, and wider.
   *
   * **Two positions rather than one, because there are two kinds of row.** A
   * note tint or a connection colour *is* the colour - the row says Yellow and
   * the chip is what yellow means - so the chip belongs where an icon would be,
   * in front of the word it is defining. A palette is not: the row says
   * *Terracotta* and the chip is three bands showing what that palette is made
   * of, which is a specimen of the thing rather than an icon for it. Specimens
   * belong on the trailing edge, in a column of their own, where they line up
   * against each other and can be compared down the list - which is the whole
   * act a palette menu exists for and is impossible when they are interleaved
   * with the words in a ragged left column.
   *
   * Drawn as a bar rather than a square, for the same reason: five colours in a
   * thirteen-pixel square is five bands of two and a half pixels.
   */
  swatchEnd?: string | string[];
  /**
   * A row that reads rather than acts: shown, greyed, and skipped by the arrow
   * keys. There is no heading in this renderer and this is deliberately not one
   * - a heading labels the rows under it, where these say something about the
   * state the menu is describing ("Showing 4 of 61", "nothing is tagged yet").
   */
  disabled?: boolean;
  /** a child menu, opened in place */
  sub?: MenuEntry[];
  /** where the Back row goes - the parent menu it was drilled into from */
  to?: MenuEntry[];
  range?: MenuRange;
  action?: () => void;
};

/**
 * What a panel is hung off: the three edges of an anchor's box that render()
 * actually reads. A DOMRect satisfies it, and so does the box ui/flyout.ts
 * builds by hand out of the button's left and the bar's bottom - which is the
 * reason this is the three numbers rather than the rectangle.
 *
 * `bounds` is the fourth thing and the optional one: the container the panel
 * must stay inside, when there is one it should. It arrived for a reason that
 * has since gone - a flyout used to be drawn as the *underside of the bar*, and
 * past the end of the bar its squared top corner became a cut edge hanging
 * against the board - and it stays for one that has not: a panel belonging to a
 * button on a bar should not hang off the end of that bar, whatever shape it is.
 * The window is the wrong container for that and was the only one render() had.
 *
 * Left off, the behaviour is exactly what it was: the window is the bound.
 */
export type MenuAnchor = {
  left: number;
  top: number;
  bottom: number;
  bounds?: { left: number; right: number };
};

/** What openAnchored() and render() take beyond the point they are drawn at. */
type MenuOpts = {
  label?: string;
  focus?: boolean;
  /** hung off a button rather than dropped at a cursor - see render() */
  anchor?: MenuAnchor;
};

/**
 * What this menu asks of the command surface, and nothing else.
 *
 * Named here rather than borrowed from commands.ts for the reason
 * FlyoutCommands states in ui/flyout.ts: that module imports this one, so the
 * arrow may only go one way - which is also why `cmds` is handed in by
 * initMenu() rather than imported.
 */
export interface MenuCommands {
  // Five members that no builder in this file called were removed - addFiles,
  // find, fit, recenter and duplicate. This interface's own sentence above is
  // "what this menu asks of the command surface, and nothing else", and a
  // declaration nothing reads is a requirement on every implementer for
  // nothing: commands.ts still has all five, the keyboard still reaches
  // duplicate on Ctrl+D, and this list is now the menu again.
  //
  // The canvas menu
  addNoteAt: (at: Point | null) => unknown;
  selectAll: () => unknown;
  rearrange: () => unknown;
  rearrangeFence: (id: string) => unknown;
  // The touch multi-select mode: whether it is on, and the one way in or out.
  multiSelect: () => boolean;
  toggleMultiSelect: () => unknown;
  reload: () => unknown;
  fenceUnder: (at: Point) => string | null;
  getSetting: (key: 'snap' | 'grid') => unknown;
  toggleSetting: (key: 'snap' | 'grid') => unknown;
  // One card, or the selection it is part of
  isTitleCard: (id: string) => boolean;
  isFenceItem: (id: string) => boolean;
  canEditNote: (id: string) => boolean;
  canCoverItem: (id: string) => boolean;
  canClearCover: (id: string) => boolean;
  canSetFit: (id: string) => boolean;
  canEditPicture: (id: string) => boolean;
  canFlipUpAxis: (id: string) => boolean;
  canRotateModel: (id: string) => boolean;
  canExtractSwatches: (id: string) => boolean;
  canTintSticker: (id: string) => boolean;
  canViewItem: (id: string) => boolean;
  canUnstick: () => boolean;
  canTag: () => boolean;
  boardTags: () => { tag: string, count: number }[];
  selectionHasTag: (tag: string) => boolean;
  toggleSelectionTag: (tag: string) => unknown;
  addTag: () => unknown;
  tagFilter: () => string[];
  hasTagFilter: () => boolean;
  isTagFiltered: (tag: string) => boolean;
  toggleTagFilter: (tag: string) => unknown;
  clearTagFilter: () => unknown;
  filterCounts: () => { shown: number, all: number };
  selectFiltered: () => unknown;
  selectionInTour: () => boolean;
  toggleSelectionTour: () => unknown;
  inTour: () => boolean;
  tourLength: () => number;
  tourStart: () => unknown;
  tourStop: () => unknown;
  canLock: () => boolean;
  lockableCount: () => number;
  lockedCount: () => number;
  selectionHasStackOverlap: () => boolean;
  itemFit: (id: string) => string;
  stickerTintOf: (id: string) => number;
  openViewer: (id: string) => unknown;
  editNote: (id: string) => unknown;
  setCover: (id: string) => unknown;
  clearCover: (id: string) => unknown;
  setItemFit: (id: string, fit: string) => unknown;
  canSetBare: (id: string) => boolean;
  itemBare: (id: string) => boolean;
  setItemBare: (id: string, bare: boolean) => unknown;
  editPicture: (id: string) => unknown;
  flipUpAxis: (id: string) => unknown;
  extractSwatches: (id: string) => unknown;
  rotateModel: (id: string) => unknown;
  setStickerTint: (id: string, tint: number) => unknown;
  raise: () => unknown;
  lower: () => unknown;
  unstick: () => unknown;
  lockSelection: (on: boolean) => unknown;
  resetSize: () => unknown;
  rearrangeSelection: () => unknown;
  fenceSelection: () => unknown;
  alignSelection: (edge: string) => unknown;
  distributeSelection: (axis: 'x' | 'y') => unknown;
  copy: () => unknown;
  paste: (at: Point | null) => unknown;
  canPaste: () => boolean;
  zoomToSelection: () => unknown;
  deleteSelection: () => unknown;
  // The title card
  editTitle: () => unknown;
  resetTitlePosition: () => unknown;
  // A line between two cards
  connectionUnder: (at: Point) => { a: string, b: string } | null;
  connectionStyle: (a: string, b: string) => ConnMeta | null;
  setConnectionStyle: (a: string, b: string, patch?: object | null) => unknown;
  editConnectionLabel: (a: string, b: string) => unknown;
  clearConnectionLabel: (a: string, b: string) => unknown;
  removeConnection: (a: string, b: string) => unknown;
}

let node: HTMLElement | null = null;
let vp: Viewport | null = null;
let cmds: MenuCommands | null = null;
// Whatever had the keyboard when the menu opened, so it can be given back.
// document.activeElement answers Element; what holds the keyboard on this page
// is a button, a field or the board, all of them HTMLElements - and focus() is
// the only thing ever asked of it, which is why the three assignments below say
// so rather than testing for it.
let opener: HTMLElement | null = null;
// The anchor the menu was opened at, kept so a drill-down submenu re-renders in
// the same place rather than jumping to wherever the pointer has drifted. The
// options go with it for the same reason: a fold opened inside a flyout must
// still hang below the bar and must still not grab the keyboard.
let lastX = 0, lastY = 0;
let lastOpts: MenuOpts = {};

/**
 * Whether the menu that is up was opened by a finger.
 *
 * Set by openContextMenu() from what the pipeline knows about the press. It is
 * the one thing this module asks about the *pointer* rather than about the
 * board, and exactly one row reads it - see multiSelectEntry().
 */
let byTouch = false;

/**
 * Told after every close, whoever caused it.
 *
 * One hook and not a list, because there is one thing that needs to hear this:
 * the toolbar owes its button an aria-expanded, and the panel can go without
 * ui/flyout.js being the one to take it - Escape, a press on the board, a
 * right-click somewhere else. A second subscriber would mean this module
 * growing a subscription list for an audience of one.
 */
let onClose: (() => void) | null = null;
export function setMenuCloseHook(fn: (() => void) | null) { onClose = fn; }

/**
 * The press that dismissed the menu, and when - so that pressing the button
 * that opened it a second time *closes* it.
 *
 * **Why this needs recording at all, which is the whole of the bug.** The
 * outside-press listener below closes on `pointerdown`, in the capture phase,
 * and a button that opens a menu is outside that menu. So a second tap on the
 * More button already did close it - and then the `click` that followed a few
 * milliseconds later ran the command and opened it again. The menu never looked
 * as though it had closed, and every attempt to fix it by adding a toggle in the
 * *opener* failed for the same reason: by the time the opener runs, the menu is
 * shut and there is nothing left to see.
 *
 * So the fact has to survive the gap between the two events, and it is a fact
 * about that press rather than about the menu: *this element's pointerdown is
 * what dismissed it*. An opener asks, and declines to reopen.
 *
 * Timestamped because the pair is a pointerdown and its own click. A stale
 * record would make the *next* press on that button do nothing, which is a
 * worse bug than the one being fixed - so anything older than a slow tap is
 * treated as unrelated.
 */
let dismissed: { by: EventTarget | null, at: number, owner: Element | null } =
  { by: null, at: -Infinity, owner: null };
const DISMISS_MS = 400;

/**
 * The button the standing menu hangs off, when it hangs off one.
 *
 * Passed by the three openers that also ask justDismissed(), and it is what
 * turns that question from "did a press just close a menu" into "did a press on
 * *this* button close *this* button's menu" - which is what it always meant.
 *
 * Without it, pressing a second menu button while the first's menu was up
 * closed one and opened neither: the capture pointerdown recorded the second
 * button as the dismisser, and the second button's own opener then read that as
 * "I am the toggle that just closed" and declined. Reproduces in the note
 * composer between Font and Highlight, and on the toolbar between More and the
 * palette picker - two buttons, one press, nothing on screen.
 */
let menuOwner: Element | null = null;

/**
 * Did a press on (or inside) this element just close the menu?
 *
 * Asked by anything that opens a menu from a button it owns. True means the
 * press the caller is handling *was* the close, and opening again would undo it.
 * Consumed on the way out, so one press answers one question.
 */
export function justDismissed(el: Element | null): boolean {
  if (!el || !dismissed.by) return false;
  if (performance.now() - dismissed.at > DISMISS_MS) return false;
  if (!el.contains(dismissed.by as Node)) return false;
  // ...and it has to have been *this* button's menu. See menuOwner. A menu with
  // no owner - the right-click menu, a fold - was never a toggle, so a press on
  // a button that happens to close one is that button's ordinary press.
  if (!dismissed.owner || !el.contains(dismissed.owner)) return false;
  dismissed = { by: null, at: -Infinity, owner: null };
  return true;
}

// `vp` and `cmds` are read with `!` throughout: initMenu() is called from
// main.ts before anything can open a menu, so an absent one is a broken build
// rather than a state to paint around - the reading ui/hud.ts states at length.
// The `e.target as Node | null` below is the same cast ui/search.ts and
// ui/fence-prompt.ts make in this exact close-on-outside listener: contains()
// takes a Node or null and is only being asked whether the press was inside.
/**
 * Is this press inside the menu - counting the hover submenu as part of it?
 *
 * **Both panels, and the second one is the whole reason this is a function.**
 * The child is a sibling of the root on `<body>`, not a descendant of it, so
 * `node.contains()` alone calls every press inside a submenu an outside press.
 * The three listeners below close on that in the *capture* phase, which is
 * before the click - so a submenu row could be opened, hovered, pointed at and
 * pressed, and the only thing that happened was the menu closing. Every row in
 * the Edit fold was dead on arrival and looked like a menu that simply ignored
 * you. The same trap the two panels' own `pointerleave` handling has to dodge,
 * from the other side.
 */
const insideMenu = (target: EventTarget | null) =>
  !!node?.contains(target as Node | null) || !!child?.contains(target as Node | null);

/**
 * Does the open menu own the keyboard?
 *
 * Two ways to own it, and both are needed. Focus being inside the panel is the
 * ordinary one - a menu opened from a keyboard press, or one a row has since
 * been arrowed onto. `lastOpts.focus` covers the frame after render() and
 * before the browser has settled focus, and it is also the honest answer for a
 * panel that asked for the keyboard and is between rows.
 *
 * The hover flyout answers no to both, which is the whole point: it declined
 * focus on the way in, so it may not take a keystroke on the way past.
 */
const ownsKeyboard = () =>
  !!lastOpts.focus || insideMenu(document.activeElement);

export function initMenu(viewport: Viewport, commands: MenuCommands) {
  vp = viewport;
  cmds = commands;

  // Close on anything that would make the anchor point meaningless. Both
  // pointer and wheel let the menu's own scroller through: a menu too tall for
  // the window scrolls (see render), and closing on the wheel that scrolls it
  // would make the entries past the fold unreachable with a mouse.
  addEventListener('pointerdown', e => {
    if (!node || insideMenu(e.target)) return;
    // Recorded before the close, because close() is what clears the state this
    // is a fact about. See justDismissed().
    dismissed = { by: e.target, at: performance.now(), owner: menuOwner };
    close();
  }, true);
  addEventListener('wheel', e => {
    if (node && !insideMenu(e.target)) close();
  }, { passive: true, capture: true });
  // Capture, because a scroll does not bubble. The board itself does not
  // scroll today, so this is the surrounding page moving under a menu that is
  // pinned to the window - the anchor point would be a lie afterwards.
  addEventListener('scroll', e => {
    if (node && !insideMenu(e.target)) close();
  }, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
  addEventListener('keydown', e => {
    if (!node) return;
    // Escape closes whatever is up, focus or no focus: a panel a pointer opened
    // by drifting over a button is still a panel somebody wants gone, and
    // Escape is how anything in this app is dismissed.
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Everything below this line is *navigation of the menu*, and it only
    // belongs to the menu when the menu has the keyboard.
    //
    // It used to belong to it whenever a panel was up, which openAnchored's own
    // header says is wrong: `focus` is false for a hover precisely so that "a
    // panel that took the keyboard because a pointer drifted over a button"
    // does not "move the caret out of whatever was being typed". This listener
    // is on the window, in the capture phase, and did exactly that - dwell on
    // the toolbar's Note button, press Ctrl+K, type `cat`, and each letter went
    // to typeAhead(), matched a flyout row, focused it and was eaten by
    // preventDefault(). The caret left the field and the word never arrived.
    // The arrows and Home/End the same.
    if (!ownsKeyboard()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // The ends. Cheap, and the first thing a keyboard reaches for in a list of
    // eleven papers - the arrows are for the row next door, not for the far end.
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusEnd(e.key === 'Home' ? 1 : -1);
      return;
    }
    // And type-ahead, which is the one thing a native <select> does that no
    // amount of arrow keys substitutes for: in a list of eleven papers, `t`
    // is the difference between reading the list and knowing where you are
    // going. Written here rather than left as a gap, because this menu is what
    // a dropdown in this app is built out of and the gap is what made replacing
    // a native control a regression rather than a change.
    //
    // Anything that is not a single printable character is somebody else's key.
    // The modifier test is what keeps Ctrl+C and the accelerators out of it.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (typeAhead(e.key)) e.preventDefault();
    }
  }, true);
}

/**
 * Jump to the first or last row that can take focus.
 *
 * Shares moveFocus's `:not(:disabled)` reasoning: a readout row cannot take
 * focus, so landing on one would leave the keyboard nowhere.
 */
function focusEnd(dir: 1 | -1) {
  const items = focusRows();
  if (items.length) items[dir > 0 ? 0 : items.length - 1].focus();
}

/**
 * The rows the keyboard is walking: the panel that holds focus.
 *
 * All three keyboard routes - the arrows, Home/End and type-ahead - queried the
 * root and only the root. The hover child is a *sibling* of the root on the
 * body, not a descendant, so a keyboard inside it walked the rows behind it
 * instead: focus jumped out of the panel it was in and back into the one
 * underneath, one row at a time, which reads as the menu refusing to move.
 *
 * Following focus rather than following the child is the whole of the rule. A
 * hover flyout must not take the keyboard merely by being open - openAnchored's
 * header says why, and ownsKeyboard() holds the same line one level up.
 *
 * :not(:disabled), because a readout row cannot take focus - so without it the
 * walk would land on one, focus() would do nothing, and the next press would
 * compute its step from whatever still had focus. One inert row would stop the
 * arrow keys dead in the middle of the menu.
 */
function focusRows(): HTMLElement[] {
  const panel = child?.contains(document.activeElement) ? child : node;
  return panel ? [...panel.querySelectorAll<HTMLElement>('.ctx-item:not(:disabled)')] : [];
}

/**
 * The letters typed so far, and when the last one landed.
 *
 * A buffer rather than a single character, because *Terracotta* and *Tea rose*
 * are told apart by their second letter and a per-key search would flip between
 * them for ever. It clears itself after a pause, so a later `t` starts a new
 * search rather than continuing one from a minute ago.
 *
 * One exception, and it is the convention every platform's list control shares:
 * the *same* letter pressed repeatedly cycles through the rows beginning with
 * it rather than searching for a doubled letter. `p p p` walks the P's; `p a`
 * looks for Papyrus.
 */
let typed = '';
let typedAt = -Infinity;
const TYPE_MS = 900;

function typeAhead(key: string): boolean {
  const now = performance.now();
  typed = now - typedAt > TYPE_MS ? key : typed + key;
  typedAt = now;
  const items = focusRows();
  if (!items.length) return false;
  // The row's own words, lowercased. A row's first child may be an icon or a
  // chip, so this reads the whole button rather than one element - the accel
  // key and the tick contribute nothing a person would type at the front.
  const words = items.map(row => (row.textContent || '').trim().toLowerCase());
  const want = typed.toLowerCase();
  const repeat = want.length > 1 && [...want].every(c => c === want[0]);
  const needle = repeat ? want[0] : want;
  // From the row after the current one, so a repeated letter advances rather
  // than landing on the same match every time. A fresh search still finds the
  // first match from here, which for a menu just opened is the top.
  const from = items.findIndex(row => row === document.activeElement);
  for (let i = 1; i <= items.length; i += 1) {
    const at = (Math.max(from, 0) + (repeat || typed.length === 1 ? i : i - 1)) % items.length;
    if (words[at].startsWith(needle)) { items[at].focus(); return true; }
  }
  return false;
}

export function close() {
  if (!node) return;
  // The child first, or it outlives its parent as a panel hanging off nothing.
  closeChild();
  // Read before the node goes: removing the element that holds focus drops the
  // keyboard on <body>, and the board's shortcuts go with it.
  const held = node.contains(document.activeElement);
  node.remove();
  node = null;
  // The letters somebody was typing belonged to the menu that has just gone.
  // Left standing, the first key pressed in the next one would continue a search
  // against a list it was never made about.
  typed = '';
  typedAt = -Infinity;
  // Ditto the button it hung off. `dismissed` has already taken its copy by the
  // time this runs - see the capture listener in initMenu().
  menuOwner = null;
  const back = opener;
  opener = null;
  // Only when the menu actually had focus. Closing on a pointerdown elsewhere
  // means the browser is about to decide where focus goes on its own, and
  // taking it back first would fight that.
  if (held && back?.isConnected) back.focus({ preventScroll: true });
  // Last, and after the node has gone: the flyout driver writes aria-expanded
  // back onto its button from here, and it must not be able to see a panel that
  // is on its way out as one that is still up.
  onClose?.();
}

/**
 * The same panel, hung under an element instead of dropped at a cursor.
 *
 * `rect` is the anchor's getBoundingClientRect(). Everything about the panel
 * below this line is the right-click menu's, which is the point.
 *
 * `focus` is false for a hover, and that is not a detail: a panel that took the
 * keyboard because a pointer drifted over a button would move the caret out of
 * whatever was being typed. The keyboard route (ArrowDown on the button) passes
 * true and gets the ordinary behaviour.
 *
 * There is no third option saying what the panel is hung off, and there was.
 * `flyout` used to be hardcoded true here on the reading that the toolbar was
 * the only caller, which stopped being so when the settings panel's pickers
 * started using this door - and menu.css answered it by squaring the corners on
 * the attached edge, so the palette menu was drawn as a box with one side
 * missing beside a field with no bar within two hundred pixels of it. Making it
 * a parameter fixed that and left two panel shapes in the app; taking it out
 * leaves one. A menu is a closed panel wherever it is opened from.
 */
export function openAnchored(rect: MenuAnchor, entries: MenuEntry[],
  { label = 'Menu', focus = false, owner = null }:
    { label?: string, focus?: boolean, owner?: Element | null } = {}) {
  close();
  opener = document.activeElement as HTMLElement | null;
  // The button this hangs off, for the toggle question - see menuOwner. Set
  // after close(), which clears it.
  menuOwner = owner;
  render(entries, rect.left, rect.bottom, { anchor: rect, label, focus });
}

/**
 * Open the menu for a right-click at (clientX, clientY).
 * `itemId` is the item under the cursor, or null for bare canvas.
 *
 * `mobile` is the Feed asking rather than the canvas, and it changes two things.
 * The item menu drops its spatial rows (see itemEntries), and a press on
 * anything that is not a tile opens nothing at all - the canvas menu below is
 * half zoom and half board-wide placement, and the Feed can honour neither.
 */
export function openContextMenu(clientX: number, clientY: number, itemId: string | null,
  selectionSize: number,
  { mobile = false, touch = false }: { mobile?: boolean, touch?: boolean } = {}) {
  // Which pointer opened this menu, for the one row that is about the pointer -
  // see multiSelectEntry(). Written to a module field rather than threaded
  // through four entry builders: it is a fact about the menu that is up, which
  // is what this module's other module fields already hold.
  byTouch = touch;
  if (mobile) {
    if (!itemId) return;
    close();
    opener = document.activeElement as HTMLElement | null;
    // No `at`: the only row that reads it is "Add a note here", and that is one
    // of the rows the Feed drops. The wall has no *here* to add anything at.
    render(itemEntries(itemId, 1, null, true), clientX, clientY);
    return;
  }
  // After the close, not before it: a second right-click while a menu is up
  // has the old menu holding focus, and close() has just handed it back to
  // whatever owned it first. That is the element this menu owes it to as well.
  close();
  opener = document.activeElement as HTMLElement | null;
  // Annotated rather than inferred: canvas/viewport.ts is still on the migration
  // pragma, so toWorld() answers `any` until it is not.
  const at: Point = vp!.toWorld(clientX, clientY);
  // A right-click that lands on a connection line, on bare board, is about that
  // line: open its editor directly rather than a fold down the board menu. Only
  // when nothing else is under the cursor - over a card the press is the card's.
  const conn = !itemId ? cmds!.connectionUnder(at) : null;
  const entries = conn ? connectionEntries(conn)
    : !itemId ? canvasEntries(at)
    // The title card is a singleton with its own short menu - never the group
    // menu's copy/duplicate/cover/stack actions. Only when it is the whole
    // selection; right-clicked inside a larger group it takes the group menu,
    // where it is already excluded from copy and duplicate (see itemsIn).
    : selectionSize <= 1 && cmds!.isTitleCard(itemId) ? titleEntries(itemId, at)
    : itemEntries(itemId, selectionSize, at);
  render(entries, clientX, clientY);
}

/**
 * The Desktop title card's menu. It is the board's name made movable, not a
 * copyable card: no Duplicate, no Copy, no picture or stacking. Editing its
 * style is the pen's action, offered here too; Reset position is its way home
 * (it is a movable singleton); Delete hides it, and the bin's restore button
 * brings it back.
 */
function titleEntries(_id: string, _at: Point): MenuEntry[] {
  return [
    { label: 'Edit style', icon: 'i-style', action: () => cmds!.editTitle() },
    { label: 'Reset position', icon: 'i-reset-position', action: () => cmds!.resetTitlePosition() },
    { sep: true },
    { label: 'Zoom to it', icon: 'i-zoom-to', action: () => cmds!.zoomToSelection() },
    { sep: true },
    { label: 'Delete', icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds!.deleteSelection() },
  ];
}

// ---------------------------------------------------------------------------
// Entry sets
// ---------------------------------------------------------------------------

/**
 * The menu for a card, on either board.
 *
 * `mobile` is the Feed asking, and it takes rows away rather than adding any.
 * About a third of what follows is spatial - z-order, sizes, zoom, a note placed
 * *here*, a fence - and the Feed is a wall that throws every computed position
 * away, so those rows would either do nothing visible or quietly rearrange the
 * canvas from a surface that cannot show the canvas. The rest is about what the
 * card *is*, and all of it means exactly the same thing on both boards.
 *
 * Gated as a flag on the rows rather than as a second entry list, which was the
 * alternative and the worse one: two lists of the same menu drift the first time
 * only one of them is edited, and one ui/menu.js for every menu in the app is
 * the whole arrangement here.
 */
function itemEntries(id: string, count: number, at: Point | null, mobile = false): MenuEntry[] {
  const many = count > 1;
  const what = many ? `${count} items` : 'item';
  // Both are single-item edits: they act on the one thing under the cursor, and
  // there is nowhere sensible to put the caret when a whole group is selected.
  const editable = !many && cmds!.canEditNote(id);
  const renamable = !many && canRenameItem(id);
  // A track can be given a picture - see canCoverItem, which is where the rule
  // and the reason for it live. Single-item, like the two above: a file dialog
  // answers with one file, and there is no sensible reading of "set the
  // picture" for a group of nine.
  const coverable = !many && cmds!.canCoverItem(id);
  // Asked separately rather than read off `coverable`, so a picture an older
  // build allowed onto a note or a link is still one click from coming off. A
  // card that cannot be given one can still be wearing one.
  const covered = !many && cmds!.canClearCover(id);
  // Photos and videos can fill their card (crop) or fit inside it (letterbox),
  // overriding the board-wide default for this one card. Single-item, like the
  // cover actions above and for the same reason: it is an edit to one picture.
  const fittable = !many && cmds!.canSetFit(id);
  const fills = fittable && cmds!.itemFit(id) === 'cover';
  const bareable = !many && cmds!.canSetBare(id);
  const bare = bareable && cmds!.itemBare(id);
  // A photograph can be cropped and graded. Single-item like the fit pair above
  // it, and offered on the Feed too: neither edit is spatial - the crop is a
  // rectangle over the picture's own pixels, not over the board - so both mean
  // exactly the same thing on a phone.
  const croppable = !many && cmds!.canEditPicture(id);
  // Anything in the selection that a tag can go on: content, so not a fence and
  // not furniture. Selection-wide like the lock, and for the same reason.
  const taggable = cmds!.canTag();
  const flippable = !many && cmds!.canFlipUpAxis(id);
  // A model card is a photograph of a model until somebody asks for the model.
  // Single-item for the same reason as the rest: you turn one thing over.
  const turnable = !many && cmds!.canRotateModel(id);
  // Z-order only has a visible meaning where this selection's sticky layer
  // crosses another layer. A note covering its own host is intentionally one
  // layer and does not make these actions useful by itself. Never on the Feed,
  // where nothing overlaps anything: the wall is packed, not stacked.
  const stackable = !mobile && cmds!.selectionHasStackOverlap();
  // Anything in the selection fixed to a host. Asked of the selection rather
  // than of the item under the cursor, like the stacking pair above and unlike
  // the edit group before them: taking nine stickies off one photograph means
  // exactly what taking one off means.
  const unstickable = !mobile && cmds!.canUnstick();
  // Offered on the Feed as well as the canvas, unlike Unstick above it. A lock
  // is a fact about the item rather than about a position, it survives the trip
  // between the two layouts, and the Feed is exactly where somebody scrolling a
  // board on a phone notices that a card ought not to move on the other one.
  const lockable = cmds!.canLock();
  const allLocked = lockable && cmds!.lockedCount() === cmds!.lockableCount();
  // A picture can hand over its own colours as swatches. Single-item, like the
  // cover and fit actions above: it reads the one image under the cursor, and
  // "the colours of these nine" is not a thing a person means.
  const swatchable = !many && cmds!.canExtractSwatches(id);
  // A sticker's colour, as a fold rather than eight rows in the main column.
  // Single-item, like the picture and fit rows: it is an edit to one shape.
  const tintable = !many && cmds!.canTintSticker(id);
  // Anything with something worth seeing full size. Single-item: the viewer
  // shows one thing, which is the whole of what it is for.
  const viewable = !many && cmds!.canViewItem(id);
  // ── The picture edits, as a fold ──
  //
  // Four rows about how one picture *looks*, taken out of the main column and
  // put behind one. The card menu had reached a dozen entries on a photograph -
  // long enough that the rows anybody actually presses were somewhere in the
  // middle of it - and these four are the group that reads as one subject: how
  // the picture sits in its card, and what the picture is made of. Crop leads
  // because it is the one that opens a surface.
  //
  // What deliberately did *not* come in here: Rename, Set a picture, Turn it
  // upright and Rotate model. Those are edits to the *item* rather than to the
  // look of the picture on it, and they are each one press today - burying a
  // one-press action one level down to tidy a menu is a menu tidied against the
  // person using it. No card was in here and left for exactly that reason; it
  // sits under the fold's own row now.
  //
  // Hovering opens it beside the row and pressing it turns the page; see
  // openChild in this file for why it is both and not either.
  const pictureEdits: MenuEntry[] = [
    // The ellipsis is the one in this menu that means it - the row opens a
    // surface and decides nothing on its own.
    { label: 'Crop & adjust…', icon: 'i-crop', hidden: !croppable,
      action: () => cmds!.editPicture(id) },
    // A radio pair drawn as two ticked entries: the current fit reads checked,
    // the other is the one click to switch to it. The icons are a mirrored
    // pair, arrows out and arrows in, so the column says "one or the other"
    // before the tick says which.
    { label: 'Fill the card', icon: 'i-fill', check: fills, hidden: !fittable,
      action: () => cmds!.setItemFit(id, 'cover') },
    { label: 'Fit in the card', icon: 'i-fit-card', check: fittable && !fills,
      hidden: !fittable, action: () => cmds!.setItemFit(id, 'contain') },
    // A photo's own palette, dropped beside it as swatches. Last, because it is
    // the only row here that puts something new on the board rather than
    // changing the thing under the cursor.
    { label: 'Extract palette', icon: 'i-swatch', hidden: !swatchable,
      action: () => cmds!.extractSwatches(id) },
  ];
  // A fold with nothing behind it is a row that opens an empty box. The rows
  // hide themselves one at a time on the conditions above, so the fold has to
  // ask them rather than repeat the five tests.
  const editable_picture = pictureEdits.some(e => !e.hidden);
  return [
    // The very first row, on the one type it appears on at all.
    //
    // The whole of this menu is ordered by one question - is this row what the
    // press was for - and on a sticky the answer is not close. A note is the
    // only item in the app whose content you make rather than import, it is
    // made empty and filled afterwards, and there is nothing else about a
    // square of paper with four words on it that anybody opens a menu to do.
    // Everything above it here was something the card *is* lying on or lying
    // under; this is the card itself.
    //
    // It was below Open and below Unstick, each of which had a good argument
    // for its own place and neither of which was arguing against this one. Open
    // on a note shows the same words larger, which is the second thing you want
    // from a note and reads as the first when it is printed above the row that
    // lets you change them; Unstick is the answer to a question about the
    // photograph underneath.
    { label: 'Edit text', icon: 'i-edit-text', accel: 'dbl-click', hidden: !editable,
      action: () => cmds!.editNote(id) },
    // Off its host and left exactly where it is. A stuck note is *pinned* - a
    // drag on it moves the card underneath it instead - so this is the only way
    // out that is not dropping it somewhere else, and the menu is the only place
    // it can be. An open padlock rather than a pin, because the entry is the act
    // of letting go and the badge on the card is already the pin.
    //
    // Above Open, and it earns that on the same argument: only a rider can be
    // unstuck, only a note or a sticker can be a rider (isSticky in sticky.ts is
    // that list), and the reason somebody right-clicks a sticky lying on a
    // photograph is nearly always that they want it off. It sat with the
    // stacking pair on the reading that it is about how a card sits on the
    // board, which is true and was the wrong thing to sort by - it put the
    // answer four bands below the question.
    //
    // Absent on everything else, so this costs the other types no row at all:
    // the band below is the first thing a photograph shows.
    { label: many ? 'Unstick these' : 'Unstick', icon: 'i-lock-open',
      hidden: !unstickable, action: () => cmds!.unstick() },
    // The card menu's copy of the board menu's row, and it earns the duplication
    // that this file otherwise refuses: a hold on a *card* is how somebody starts
    // collecting - the card under the thumb is already the first of the group -
    // and sending them to bare board to find the switch would mean beginning by
    // pointing at nothing. Never on the Feed, which has no selection to build.
    // Never on a mouse either; see multiSelectEntry.
    ...(mobile ? [] : multiSelectEntry()),
    // First on everything that is not a note, because on a wall of thumbnails it
    // is the thing you most often want and the one row that was not reachable
    // any other way. It carries no accelerator on a note: the double-click there
    // belongs to Edit text, which is also why it sits below it.
    { label: 'Open', icon: 'i-expand', accel: editable ? '' : 'dbl-click',
      hidden: !viewable, action: () => cmds!.openViewer(id) },
    // Copy and paste rather than Duplicate, and the swap is not a rename. A
    // duplicate is a copy that lands somewhere the app chose - beside the
    // original, always - and it is one press for that one case. Copy and paste
    // are two presses and answer the case duplicate cannot: the copy lands where
    // the cursor is, on this board or another, now or after ten minutes of
    // looking around. That is the thing people right-click a card to do.
    //
    // Ctrl+D still duplicates, and cmds.duplicate() is still there for it. The
    // key kept the one-press case; the menu took the general one.
    //
    // i-duplicate on Copy, deliberately: the two cards *are* the copy mark, and
    // it is the drawing every other surface in the app already uses to mean "a
    // second of this". Paste gets its own, because a menu with two rows drawn
    // the same is a menu with one row read twice.
    { label: many ? `Copy ${count} items` : 'Copy', icon: 'i-duplicate', accel: 'Ctrl C',
      action: () => cmds!.copy() },
    // Absent on an empty clipboard rather than greyed - the schema's rule, and
    // the honest one here: a Paste that cannot paste has nothing to explain.
    { label: 'Paste', icon: 'i-paste', accel: 'Ctrl V', hidden: !cmds!.canPaste(),
      action: () => cmds!.paste(at) },
    // The accel is conditional for the same reason Open's is, and the two
    // conditions are the two halves of one rule: `input.ts` sends a double-click
    // on anything that is not a note and not the title card to openViewer, so on
    // a photograph the gesture opens the viewer and belongs to Open. Printed on
    // both rows it was a menu advertising one key twice, which teaches the wrong
    // thing about both of them. Zoom keeps it only where nothing else claims it.
    { label: 'Zoom to it', icon: 'i-zoom-to', accel: viewable || editable ? '' : 'dbl-click',
      action: () => cmds!.zoomToSelection(), hidden: mobile || many },
    { label: 'Zoom to them', icon: 'i-zoom-to',
      action: () => cmds!.zoomToSelection(), hidden: mobile || !many },
    // ── What the card is ──
    //
    // The edits to the thing itself, all of them conditional on what the thing
    // is, which is why this rule has to ask every one of them: on a sticker the
    // band is one row, on a photograph it is six, and on a fence there is no
    // band at all.
    { sep: true, hidden: !coverable && !covered && !editable_picture && !flippable
      && !turnable && !tintable && !taggable },
    { label: covered ? 'Change picture' : 'Set a picture', icon: 'i-picture',
      hidden: !coverable, action: () => cmds!.setCover(id) },
    { label: 'Remove picture', icon: 'i-picture-off', hidden: !covered,
      action: () => cmds!.clearCover(id) },
    // The five picture edits, one row deep. Built above, where the note saying
    // what is in it and what is deliberately not sits with the list itself.
    { label: 'Edit', icon: 'i-crop', hidden: !editable_picture,
      sub: editable_picture ? pictureEdits : undefined },
    // Out of the fold and directly under the row that opens it, because it was
    // the one entry in there that is not about the picture. Fill and Fit are two
    // positions of one dial and belong together wherever they live; this asks
    // whether the card exists at all, which is a question about the *item*, and
    // the fold's own note already says edits to the item stay in the main
    // column. A sticky proves the point - it can be bare and has no picture
    // fold to have been buried in.
    //
    // Inside, it also made the fold lie: Fit and No card are independent, so
    // both could read ticked at once in a list whose two other ticks are a radio
    // pair. One level out, the tick has nothing to be mistaken for. A tick
    // rather than a pair of rows - "no card" has no opposite worth naming.
    { label: 'No card', icon: 'i-cut-out', check: bare, hidden: !bareable,
      action: () => cmds!.setItemBare(id, !bare) },
    // OBJ says nothing about which way is up and both readings are common, so
    // the format's default is a guess. This is the way out of a wrong one - and
    // it is on the item rather than in Appearance because a board can hold a
    // Z-up scan and a Y-up export at the same time.
    { label: 'Turn it upright', icon: 'i-upright', hidden: !flippable,
      action: () => cmds!.flipUpAxis(id) },
    // Above the upright toggle would put the rare fix in front of the ordinary
    // gesture; below it, this is the last thing on the model's own group.
    { label: 'Rotate model', icon: 'i-rotate', hidden: !turnable,
      action: () => cmds!.rotateModel(id) },
    // Every shape can take every tint, so this is the whole palette on every
    // sticker rather than a set that varies by shape. It is an override: the
    // shape arrived wearing the colour it wore in the pad, and the tick shows
    // which one it is on now.
    { label: 'Colour', icon: 'i-swatch', hidden: !tintable,
      sub: tintable ? stickerTintEntries(id) : undefined },
    // Tags, as a fold. On the Feed as well as the canvas - a tag is a fact
    // about the card and not about where it is - and on the selection rather
    // than on the one card under the cursor, which is why the label does not
    // change with the count the way Unstick's does: "Tags" is what the fold
    // holds whether it is about one card or nine.
    { label: 'Tags', icon: 'i-tag', hidden: !taggable,
      sub: taggable ? tagEntries() : undefined },
    // The tour, as a single ticked row rather than a fold. There is exactly one
    // tour on a board, so there is nothing to choose between - the whole of the
    // question is "is this card a stop", and a fold holding one entry would be a
    // drill-down into a checkbox. Selection-wide and three-state on the same
    // terms as the tags above it: ticked only when every eligible card in the
    // selection is already on, so a half-added selection completes.
    //
    // The zoom-to icon rather than an invented one, and it is the honest glyph:
    // what a stop *is* is a card the camera goes and frames.
    { label: many ? 'These are tour stops' : 'A tour stop', icon: 'i-zoom-to',
      check: taggable && cmds!.selectionInTour(), hidden: !taggable,
      action: () => cmds!.toggleSelectionTour() },
    // ── How it sits on the board ──
    //
    // Everything above this rule is about what the card *is*. Everything below
    // it, as far as the next rule, is about where it sits and what it sits on.
    // The band can empty out completely on a phone, where none of the spatial
    // rows are offered - hence the condition, which asks the two that survive.
    { sep: true, hidden: mobile && !lockable && !many },
    // The other mirrored pair: one card and one arrow, turned over.
    { label: 'Bring to front', icon: 'i-front', hidden: !stackable, action: () => cmds!.raise() },
    { label: 'Send to back', icon: 'i-back', hidden: !stackable, action: () => cmds!.lower() },
    // Fix it where it is. One row rather than a
    // checked pair: the answer is Anchor until everything in the selection is
    // anchored, at which point it becomes Unanchor. A mixed selection therefore
    // offers Anchor and means it - see lockedCount() in commands/item-meta.ts.
    // A mirrored pair drawn as two rows of which exactly one shows, the shape
    // the Fill/Fit pair above uses. One row with a conditional icon would have
    // read the same and been the one entry in this file whose icon is not a
    // literal - which tests/icons.test.js counts, and rightly: an icon computed
    // in a ternary is an icon nobody can grep for.
    //
    // "Anchor", and it used to be "Lock". The act is holding a card still on a
    // board, and a padlock is what you put on a door: it promises a card nobody
    // can change, which is not what this does - the name, the colour, the tags
    // and Delete are all still one click away, and only the *geometry* is
    // fixed. An anchor says exactly that much and no more, and it belongs to
    // the same room as the paper, the tape and the pins. The word "pin" was
    // the first answer and is already taken: isPinned() is a sticky riding on
    // its host, and the badge for it is a pin. See isLocked() in
    // board-model.ts, which is the *stored* name and deliberately unchanged -
    // renaming a key in the file format to rename a word on a menu would make
    // every board written before today ask a question this app stopped
    // answering. "Unanchor" rather than "Release", matching Unstick above.
    { label: many ? 'Anchor these' : 'Anchor', icon: 'i-anchor',
      hidden: !lockable || allLocked, action: () => cmds!.lockSelection(true) },
    { label: many ? 'Unanchor these' : 'Unanchor', icon: 'i-anchor-off',
      hidden: !lockable || !allLocked, action: () => cmds!.lockSelection(false) },
    // The way back from a corner dragged too far. With the stacking pair rather
    // than in the group above, because those are all edits to what a card *is*
    // and this is one to how it sits on the board - the same kind of thing as
    // raising it or zooming to it. Works on a group: unlike renaming or setting
    // a picture, "put these back to their own size" means one thing for nine
    // cards as clearly as for one.
    // Not on the Feed: a tile's size is the packer's, computed from the column
    // count and the item's aspect, so putting a card back to "its own size"
    // changes a number that surface never draws.
    { label: many ? `Reset ${count} sizes` : 'Reset size', icon: 'i-reset-size',
      hidden: mobile, action: () => cmds!.resetSize() },
    // A region right-clicked by its name plate - which is the only part of one a
    // press can land on - arranges what is inside it. Single-item, because with a
    // group selected "these" is the group and this row is about one region's
    // contents; the row below still covers that case.
    { label: 'Rearrange fence', icon: 'i-rearrange',
      hidden: mobile || many || !cmds!.isFenceItem(id),
      action: () => cmds!.rearrangeFence(id) },
    // The board's arrangement, applied to these and nowhere else. Only offered
    // for a group, because one card has nothing to be arranged against - and it
    // says "these" rather than "everything" because that is the difference:
    // the selection is relaid about its own centre and the rest of the board
    // does not move. The whole-board one is on the canvas menu.
    { label: `Rearrange these ${count}`, icon: 'i-rearrange', hidden: !many,
      action: () => cmds!.rearrangeSelection() },
    // Straighten or space out, one fold deeper. A group only, like Rearrange -
    // one card has no edge to line up against - and behind one row because eight
    // ways to tidy would swamp the menu the moment two cards were picked. See
    // alignDistributeEntries().
    { label: 'Align & distribute', icon: 'i-align-center', hidden: !many,
      sub: alignDistributeEntries() },
    // Beside Rearrange because it is the other answer to the same question -
    // "these belong together". Rearrange says so by moving them; a fence says so
    // by drawing a line round them and leaving them where they are. Group only,
    // for the reason above: one card has nothing to be grouped with.
    //
    // The second surface, not the only one: a rubber band offers this for itself
    // as it is let go (ui/fence-prompt.js), which is the gesture people reach for
    // and the one Fences itself uses. This is what is left for a selection built
    // by shift-clicking, where there is no band to catch the answer - so it stays
    // even though the band is now the ordinary way in.
    { label: `Fence these ${count}`, icon: 'i-fence', hidden: !many,
      action: () => cmds!.fenceSelection() },
    // ── The board, from here ──
    //
    // Two rows that are not about the card under the cursor at all. They are on
    // this menu deliberately: a right-click is the way back to the board's own
    // actions from wherever the pointer happens to be, and having to first find
    // empty ground would be the menu being precious about which surface it was
    // opened on. Last before the naming and the unmaking, because that is what
    // they are - the thing you do next, not the thing you opened the menu for.
    { sep: true, hidden: mobile },
    // The Feed has no "here": it is a packed wall, so a note placed at the point
    // somebody pressed would be picked up by the packer and put wherever the
    // column had room. Add is on the toolbar there, which is the surface that
    // means "somewhere on this board" rather than "at this spot" - and that is
    // the only promise the Feed can keep.
    { label: 'Add a note here', icon: 'i-pen', hidden: mobile,
      action: () => cmds!.addNoteAt(at) },
    { label: 'Reload board', icon: 'i-reload', action: () => cmds!.reload() },
    // ── The name, and the end of the card ──
    //
    // Rename is a one-press action sitting at the foot of the menu, which the
    // picture-fold note above argues against: burying a one-press action to tidy
    // a menu is a menu tidied against the person using it. It is here anyway and
    // on purpose. Renaming is the last thing you do to a card you are keeping,
    // the way deleting is the last thing you do to one you are not, and read in
    // that order the two are the pair they have always been. F2 stays printed on
    // the row for anyone who disagrees, which is the difference between moving a
    // row down and taking it away.
    // One band, not two. Delete is drawn in the danger colour and carries Del,
    // which is the marking that keeps it from being pressed by accident - a rule
    // above it was doing the same job twice and cost the pair the thing that
    // makes them read as a pair.
    { sep: true },
    { label: 'Rename', icon: 'i-rename', accel: 'F2', hidden: !renamable,
      action: () => editItemName(id) },
    { label: `Delete ${what}`, icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds!.deleteSelection() },
  ];
}

/**
 * The align/distribute fold. Six edges to line up on and two axes to space
 * along - the whole of geometry.js's alignTargets/distributeTargets, one row
 * each, in reading order: the horizontal edges, the vertical edges, then the
 * two distributions. Each closes the menu and files one undo step through the
 * command, so it reads and undoes as the single tidy-up it is.
 */
/**
 * The finger's Shift key, as one row on both board menus.
 *
 * A phone can hold a group by dragging a band with a double tap or by taking
 * the whole board with Select all, and by nothing else: every other way of
 * saying "these four" in this app is a modifier key. So the row turns on a mode
 * in which a tap adds instead of replacing - see isMultiSelect() in
 * board-store.ts, which is where the mode is described and where the argument
 * for having one at all lives.
 *
 * **Only on a menu a finger opened**, which is what `byTouch` is for and the
 * only thing this module asks about the pointer. A mouse already has three
 * modifiers and a marquee, and a row offering a slower version of Shift to
 * somebody holding Shift is a row explaining the app to itself. It stays on
 * once the mode is on whatever opened the menu, because a mode with no way out
 * is worse than a row in the wrong place - and a mode entered with a finger and
 * left by picking up the mouse is exactly the case that would strand it.
 *
 * One row that flips, the shape the tour and Lock use: the mode is on or it is
 * not, and the way out being where the way in was is the whole reason a mode is
 * bearable. The tick says which, in the column the snap and grid rows use.
 */
function multiSelectEntry(): MenuEntry[] {
  const on = cmds!.multiSelect();
  if (!byTouch && !on) return [];
  return [{
    label: on ? 'Done selecting' : 'Select multiple',
    icon: 'i-select-all',
    check: on,
    action: () => cmds!.toggleMultiSelect(),
  }];
}

function alignDistributeEntries(): MenuEntry[] {
  return [
    { label: 'Align left', icon: 'i-align-left', action: () => cmds!.alignSelection('left') },
    { label: 'Align centre', icon: 'i-align-center', action: () => cmds!.alignSelection('hcenter') },
    { label: 'Align right', icon: 'i-align-right', action: () => cmds!.alignSelection('right') },
    { sep: true },
    { label: 'Align top', icon: 'i-align-top', action: () => cmds!.alignSelection('top') },
    { label: 'Align middle', icon: 'i-align-middle', action: () => cmds!.alignSelection('vcenter') },
    { label: 'Align bottom', icon: 'i-align-bottom', action: () => cmds!.alignSelection('bottom') },
    { sep: true },
    { label: 'Distribute across', icon: 'i-distribute-h', action: () => cmds!.distributeSelection('x') },
    { label: 'Distribute down', icon: 'i-distribute-v', action: () => cmds!.distributeSelection('y') },
  ];
}

/**
 * The connection editor's fold, for a line the right-click landed on. Direction
 * and style are each a short radio of ticked rows; the label is asked for, since
 * it is the one setting that is not a choice from a list. Every row files one
 * undo step through cmds!.setConnectionStyle. "One end" and "other end" rather
 * than a card's name, because the pair is unordered and neither end has a name a
 * person would recognise - the two simply point opposite ways.
 */
function connectionEntries(conn: { a: string, b: string }): MenuEntry[] {
  const meta = cmds!.connectionStyle(conn.a, conn.b) || {};
  const dir = meta.dir || 'none';
  const style = meta.style || 'solid';
  const color = meta.color || 'line';
  const weight = meta.weight || 'normal';
  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  return [
    { label: 'No arrows', icon: 'i-connect', check: dir === 'none', action: () => set({ dir: 'none' }) },
    { label: 'Arrow one end', icon: 'i-arrow-fwd', check: dir === 'fwd', action: () => set({ dir: 'fwd' }) },
    { label: 'Arrow other end', icon: 'i-arrow-back', check: dir === 'back', action: () => set({ dir: 'back' }) },
    { label: 'Arrows both ends', icon: 'i-arrow-both', check: dir === 'both', action: () => set({ dir: 'both' }) },
    { sep: true },
    { label: 'Solid line', icon: 'i-line-solid', check: style === 'solid', action: () => set({ style: 'solid' }) },
    { label: 'Dashed line', icon: 'i-line-dashed', check: style === 'dashed', action: () => set({ style: 'dashed' }) },
    { label: 'Dotted line', icon: 'i-line-dotted', check: style === 'dotted', action: () => set({ style: 'dotted' }) },
    { sep: true },
    // Colour and weight go one fold deeper, where direction and style stay on
    // the face of the menu. Not a judgement about which matters more: arrows and
    // dashes are four and three rows, and colour and weight are five and three
    // more, which would make this the longest menu in the app for a right-click
    // on a hairline. The two that change what a line *says* are here; the two
    // that change what it looks like are one press away.
    { label: 'Colour', icon: 'i-swatch', sub: connectionColorEntries(conn, color) },
    { label: 'Weight', icon: 'i-line-solid', sub: connectionWeightEntries(conn, weight) },
    { sep: true },
    { label: meta.label ? 'Change label' : 'Add a label', icon: 'i-style',
      action: () => cmds!.editConnectionLabel(conn.a, conn.b) },
    { label: 'Remove label', icon: 'i-style', hidden: !meta.label,
      action: () => cmds!.clearConnectionLabel(conn.a, conn.b) },
    { sep: true },
    { label: 'Remove connection', icon: 'i-delete', danger: true,
      action: () => cmds!.removeConnection(conn.a, conn.b) },
  ];
}

/**
 * The eight colours a sticker may be set to.
 *
 * The names come from the catalogue rather than being spelled out here, so the
 * words and the tokens they describe are one list - the same bargain the
 * connection palette below makes with canvas.css, one relation over. The
 * numbers are what reaches meta.tint and items.css, and nothing but the index
 * ties them together, which is exactly why the list has one home.
 */
/**
 * The tag fold on an item's menu: every tag the board knows, ticked where the
 * whole selection carries it, and a row for a new one.
 *
 * The board's tags rather than this item's, which is the decision that makes
 * the fold worth having: a list of the tags already on the card would be a
 * readout, and what somebody opening this menu wants is to put one of the tags
 * they have already invented onto this card too. The ticks are what turn the
 * same list into the readout as well.
 *
 * Counts are shown against each. On a board with forty tags the useful ones are
 * the ones already used a lot, which is exactly the order boardTags() returns
 * and exactly what the number says.
 */
function tagEntries(): MenuEntry[] {
  const tags = cmds!.boardTags();
  const rows: MenuEntry[] = tags.map(({ tag, count }) => ({
    label: `${tag}  (${count})`,
    icon: 'i-tag',
    check: cmds!.selectionHasTag(tag),
    action: () => cmds!.toggleSelectionTag(tag),
  }));
  // The separator only where there is something above it to separate from. A
  // board with no tags yet opens this fold on one row, which is the whole of
  // what it can offer and reads as an invitation rather than as an empty list.
  if (rows.length) rows.push({ sep: true });
  rows.push({ label: 'New tag…', icon: 'i-plus', action: () => cmds!.addTag() });
  return rows;
}

/**
 * The filter fold on the canvas menu: every tag, ticked where it is filtering.
 *
 * Two rows at the foot that the item fold has no equivalent of, and both exist
 * because a filter is a state you can get lost in: one says how much of the
 * board is currently showing, and one takes the filter off. The count is a
 * disabled row rather than a heading because ui/menu.ts has no heading - and a
 * row that says "showing 4 of 61" is worth more than the tidiness.
 */
function filterEntries(): MenuEntry[] {
  const tags = cmds!.boardTags();
  const rows: MenuEntry[] = tags.map(({ tag, count }) => ({
    label: `${tag}  (${count})`,
    icon: 'i-tag',
    check: cmds!.isTagFiltered(tag),
    action: () => cmds!.toggleTagFilter(tag),
  }));
  if (!rows.length) {
    return [{ label: 'Nothing on this board is tagged yet', icon: 'i-tag', disabled: true }];
  }
  if (cmds!.hasTagFilter()) {
    const { shown, all } = cmds!.filterCounts();
    rows.push({ sep: true });
    rows.push({ label: `Showing ${shown} of ${all}`, icon: 'i-find', disabled: true });
    rows.push({ label: 'Select those', icon: 'i-select-all', action: () => cmds!.selectFiltered() });
    rows.push({ label: 'Show everything', icon: 'i-close', action: () => cmds!.clearTagFilter() });
  }
  return rows;
}

function stickerTintEntries(id: string): MenuEntry[] {
  const now = cmds!.stickerTintOf(id);
  return STICKER_TINT_NAMES.map((text, i) => ({
    label: text,
    icon: 'i-swatch',
    check: now === i + 1,
    action: () => cmds!.setStickerTint(id, i + 1),
  }));
}

/**
 * The colours a line may be given, and the one fold in this file whose rows are
 * a palette rather than a list of behaviours.
 *
 * Names, not values - see connMeta() in board-model.js. What each name looks
 * like is one rule in canvas.css, which is what keeps a board file from being
 * able to name a colour the stylesheet did not choose. The board's own grey is
 * first because it is the default and the way back to it.
 */
function connectionColorEntries(conn: { a: string, b: string }, color: string): MenuEntry[] {
  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  // Typed against ConnColor rather than left as string: these five names are
  // the same closed list board-model.ts holds connMeta() to, and a sixth spelled
  // wrong here would previously have travelled all the way to a stroke that
  // silently did nothing.
  const options: [ConnColor, string][] = [
    ['line', 'Board grey'], ['accent', 'Accent'], ['warm', 'Warm'],
    ['leaf', 'Green'], ['danger', 'Red'],
  ];
  return options.map(([name, text]) => ({
    label: text, icon: 'i-swatch', check: color === name, action: () => set({ color: name }),
  }));
}

/** How heavy a line is drawn, relative to the board's own weight. */
function connectionWeightEntries(conn: { a: string, b: string }, weight: string): MenuEntry[] {
  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  const options: [ConnWeight, string][] = [['fine', 'Fine'], ['normal', 'Normal'], ['bold', 'Bold']];
  return options.map(([name, text]) => ({
    label: text, icon: 'i-line-solid', check: weight === name, action: () => set({ weight: name }),
  }));
}

function canvasEntries(at: Point): MenuEntry[] {
  // A press inside a region falls through to the board - the fence's face takes
  // no pointer, which is what keeps panning and banding working inside one - so
  // this menu is what a right-click *in* a region opens, and the board is not
  // what it is about. "Rearrange board" would be the loudest possible reading of
  // a click aimed at one shelf, so the two are one row that swaps: inside a
  // region it is the region's, and only on empty ground is it the board's.
  //
  // ── What is not here, and why ──
  //
  // Add a note, Add files, Find, Zoom to fit and Back to 0,0 were all on this
  // menu and are all still one press away on the toolbar, the zoom cluster or
  // the keyboard. Five of twelve rows, every one of them a second copy of a
  // control already sitting on screen unprompted. A menu that reprints the
  // chrome behind it teaches that right-click is where everything is, which is
  // the reading that made this list twelve rows long.
  //
  // The test for a row here is not "would this be handy" - everything is handy
  // - it is whether the row reaches something no resting surface can. `at` is
  // what usually earns it: a scope, a shelf, a point under the cursor. Rows
  // that pass and stayed: the tag filter, the fence, the two board marks.
  const fence = cmds!.fenceUnder(at);
  return [
    // Paste, and it passes the test above rather than being let off it: the
    // point under the cursor is where a paste lands, and no resting surface in
    // the app has a point. It is also the half of copy/paste that has to be
    // reachable from empty ground - a copy is made on a card and put down where
    // there is no card, so an item-menu-only Paste would be a Paste you can
    // never press where you mean it.
    //
    // Absent on an empty clipboard, like its twin on the item menu, which is
    // also what keeps this menu at six rows for anyone who has not copied
    // anything.
    { label: 'Paste', icon: 'i-paste', accel: 'Ctrl V', hidden: !cmds!.canPaste(),
      action: () => cmds!.paste(at) },
    { label: 'Select all', icon: 'i-select-all', accel: 'Ctrl A',
      action: () => cmds!.selectAll() },
    // Beside Select all, which is the other half of the same sentence: all of
    // them, or the ones you point at. Absent on a mouse - see multiSelectEntry.
    ...multiSelectEntry(),
    // The filter, beside Select all because the two are the same idea at
    // opposite ends: everything, or only what carries a tag.
    // Ticked in the label when one is up, so the state is visible from the row
    // above the fold rather than only inside it - a filter you cannot see is
    // the failure mode this whole feature has to avoid.
    { label: cmds!.hasTagFilter() ? `Filter by tag (${cmds!.tagFilter().length})` : 'Filter by tag',
      icon: 'i-tag', check: cmds!.hasTagFilter() || undefined, sub: filterEntries() },
    // One row, two scopes, and `at` is what picks between them: a right-click
    // inside a region lays out that region, a right-click on empty ground lays
    // out the board. Both readings are the point under the cursor answering a
    // question no resting surface can be asked - the toolbar's Arrange button
    // has no position, so it can only ever mean everything, and it cannot mean
    // *this shelf* at all.
    //
    // Never both at once. A menu offering "Rearrange fence" and "Rearrange
    // board" a row apart is a menu asking which of two irreversible-looking
    // sweeps you meant, over ground where the difference is invisible until
    // after the press.
    fence
      ? { label: 'Rearrange fence', icon: 'i-rearrange',
        action: () => cmds!.rearrangeFence(fence) }
      : { label: 'Rearrange board', icon: 'i-rearrange',
        action: () => cmds!.rearrange() },
    { label: 'Reload board', icon: 'i-reload', action: () => cmds!.reload() },
    { sep: true },
    // The tour, alone in its band now that Zoom to fit and Back to 0,0 have
    // gone to the zoom cluster where they were already drawn. It is the one way
    // of moving the view that no button on the chrome offers, which is exactly
    // why it survived the cut its two neighbours did not.
    //
    // One row that flips rather than a pair, the same shape Lock/Unlock uses on an item
    // - a tour is running or it is not, and only one of the two sentences can
    // be true. Absent entirely on a board with no stops on it yet, which is the
    // schema's own "absence, not disabling" rule: a row offering to start a tour
    // of nothing is a row that can only apologise.
    { label: cmds!.inTour() ? 'End the tour' : `Take the tour (${cmds!.tourLength()})`,
      icon: 'i-zoom-to', hidden: !cmds!.tourLength(),
      action: () => (cmds!.inTour() ? cmds!.tourStop() : cmds!.tourStart()) },
    { sep: true },
    // The board's own two marks: the lattice, and the lattice with a card
    // locked onto it. The tick that says which way they are set is a separate
    // mark on the other edge of the row - see render().
    { label: 'Snap to grid', icon: 'i-snap', check: cmds!.getSetting('snap'),
      action: () => cmds!.toggleSetting('snap') },
    { label: 'Show grid', icon: 'i-grid', check: cmds!.getSetting('grid'),
      action: () => cmds!.toggleSetting('grid') },
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Replace the open menu's contents in place, keeping the same anchor and the
 * same owed-keyboard. The drill-down's one primitive: `render` builds a fresh
 * node, so the old one is dropped first - but without close()'s focus hand-back,
 * because the menu is not closing, it is turning a page.
 */
function swap(entries: MenuEntry[]) {
  // A page turn keeps whatever the outgoing page had. It matters for the one
  // caller that opens without the keyboard: a flyout drilled into by hand
  // should not suddenly start swallowing arrow keys, and one drilled into from
  // the keyboard must not drop them.
  const held = !!node && node.contains(document.activeElement);
  // The hover child goes with the page it was flown out of. close() does this
  // first for the same reason and this did not: `node.remove()` left the
  // submenu on screen hanging off nothing, with `childRow` pointing at a
  // detached button and `childFrom` at a detached panel - and since the only
  // thing that clears those is `childFrom === panel` against a panel that no
  // longer exists, the orphan stayed until something else closed the menu
  // outright. Hover Edit, arrow to Tags, press Enter, and the Edit fold was
  // still there over the new page.
  closeChild();
  if (node) { node.remove(); node = null; }
  render(entries, lastX, lastY, { ...lastOpts, focus: lastOpts.focus || held });
}

/** A child menu, fronted by the row that walks back to its parent. */
function subMenu(sub: MenuEntry[], parent: MenuEntry[]): MenuEntry[] {
  return [{ label: 'Back', icon: 'i-chevron-left', to: parent }, { sep: true }, ...sub];
}

/**
 * Where a panel is hung: inside the open modal, if there is one, and on the body
 * otherwise.
 *
 * A modal `<dialog>` is drawn in the **top layer**, which is a different thing
 * from a high z-index and beats every one of them. `showModal()` puts the dialog
 * and its backdrop above the whole page, so a panel appended to the body renders
 * *behind* the dimming - it was there, at the right coordinates, under 42% ink.
 * The note editor's own font button is how this was found: the composer is a
 * modal, and choosing a face meant pressing something you could not see.
 *
 * z-index cannot answer it. Only being in the top layer can, and the way to be
 * in it without becoming a dialog of your own is to be inside the element that
 * already is.
 *
 * Two more things come right with it, both of which were bugs waiting rather
 * than luck. The panel can take focus: a modal makes everything outside itself
 * inert, so `focus: true` on a panel out on the body was a request the browser
 * was entitled to refuse. And the note editor's focusout guard - which asks
 * whether focus is still somewhere inside its surface - now says yes to a press
 * on a menu row, where before a font row was a press *outside* the dialog and
 * ended the edit it was formatting.
 *
 * `position: fixed` inside the dialog still resolves against the viewport, so
 * the placement below needs no adjusting - the one thing that would break that
 * is a transform on the dialog, and #compose's entry animation has ended long
 * before any menu can be opened in it.
 */
function panelHost(): HTMLElement {
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  // Backwards: the last one opened is the one on top, and document order is the
  // best statement of that available without tracking every showModal() in the
  // app from here.
  for (let i = open.length - 1; i >= 0; i--) {
    // :modal is the only way to ask whether a dialog is *modal* rather than
    // merely open, and matches() throws on a selector the engine has not heard
    // of. Treating an unknown answer as modal is the safe half: a non-modal
    // dialog hosting the panel places it exactly where the body would have.
    try { if (open[i].matches(':modal')) return open[i]; } catch { return open[i]; }
  }
  return document.body;
}

function render(entries: MenuEntry[], clientX: number, clientY: number, opts: MenuOpts = {}) {
  lastX = clientX;
  lastY = clientY;
  lastOpts = opts;
  node = document.createElement('div');
  node.id = 'ctx-menu';
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', opts.label || 'Board actions');
  // No variant class here any more. A hover flyout used to wear one that
  // squared the corners on the edge it hung off; there is one panel shape now,
  // whatever opened it - see the block at the head of the menu rules.
  // Focusable but not tabbable: the menu takes the keyboard when it opens, so
  // a screen reader announces it and Escape and the arrows have somewhere to
  // land. The entries themselves are what Tab and the arrows then walk.
  node.tabIndex = -1;

  fillPanel(node, entries);

  // Measure off-screen, then place - the menu's size depends on its entries.
  // The height read here is already capped by the max-height in overlays.css,
  // so a menu with more entries than the window is tall scrolls rather than
  // running off the bottom: the flip below can only work with a box that fits.
  node.style.visibility = 'hidden';
  placeRoot(node, clientX, clientY, opts);
}

/**
 * The rows of one panel, from one list of entries.
 *
 * Lifted out of render() so that a hover submenu is *the same rows* rather than
 * a second row builder - which is the rule CLAUDE.md states about menus, one
 * level down. A child panel that drew its own buttons would have its own idea
 * of what a tick is inside a quarter.
 *
 * `panel` is the root menu or a child of it, and nothing here knows which.
 */
function fillPanel(panel: HTMLElement, entries: MenuEntry[]) {
  for (const entry of entries) {
    if (entry.hidden) continue;
    if (entry.sep) {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      panel.append(hr);
      continue;
    }
    // A dial rather than an action, and the one row here that is not a button.
    // It has to stay put while it is being dragged - a slider that closed the
    // menu on its first pointerdown would be unusable - so it is not in the
    // arrow-key walk and it does not close anything. Live: the value is written
    // on every input event, because a spacing you cannot see change is a
    // spacing you set by guessing.
    if (entry.range) {
      panel.append(rangeRow(entry));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'ctx-item';
    if (entry.danger) btn.classList.add('is-danger');
    // Greyed and inert. `disabled` on the button is what actually stops the
    // press; the class is only the dressing, and the arrow-key walk skips it
    // because that walk collects .ctx-item and a disabled button cannot take
    // focus.
    if (entry.disabled) { btn.disabled = true; btn.classList.add('is-inert'); }
    if (entry.check != null) {
      btn.classList.add('is-toggle');
      btn.classList.toggle('is-checked', !!entry.check);
      btn.setAttribute('role', 'menuitemcheckbox');
      btn.setAttribute('aria-checked', String(!!entry.check));
    }

    // The icon first, and always - the row is a grid of three columns and this
    // is the first of them, so an entry that somehow had none would still line
    // its label up with the others rather than sliding under their icons.
    //
    // A `swatch` takes that column instead, for the rows whose subject *is* a
    // colour. The sticker tints get away with a grey i-swatch on all eight
    // because each one is named - Red, Amber, Terracotta - and the word does the
    // work. Four sheets of note paper have no such names, and "Yellow" beside a
    // grey icon is a menu asking you to take its word for it.
    if (entry.swatch) btn.append(chip(entry.swatch));
    else if (entry.icon) btn.append(icon(entry.icon));

    const label = document.createElement('span');
    // Asserted: the two rows that carry no label are the separator and the
    // slider, and both were dealt with above. The type keeps it optional
    // because those two are entries as well.
    label.textContent = entry.label!;
    btn.append(label);

    if (entry.accel) {
      const accel = document.createElement('kbd');
      accel.textContent = entry.accel;
      btn.append(accel);
    }
    // The tick, on the trailing edge rather than in front of the label.
    //
    // It used to be a ::before on the label, holding a 15px column open so a
    // toggle's words did not jump sideways when it flipped on. That column is
    // the icon's now, and the two cannot share it: an icon that vanished when
    // its setting came on would be the noisiest thing in the menu. So the mark
    // moved to where the accel keys sit - which is free on both toggles, since
    // neither Snap to grid nor Show grid has a shortcut - and it is drawn from
    // the same sprite as everything else, rather than being the one glyph in
    // the row set in a typeface.
    if (entry.check != null) btn.append(icon('i-check', 'ctx-tick'));
    // And the specimen, outermost of all - the one column in the row that is
    // read *down* rather than across. See MenuEntry.swatchEnd.
    if (entry.swatchEnd) btn.append(chip(entry.swatchEnd, 'ctx-chip is-end'));
    // Three kinds of row. A `sub` opens a child menu in place; a `to` is the
    // Back row that returns to a parent menu; everything else runs its action
    // and closes. The two navigators re-render rather than fly a second panel
    // out - the flat renderer, the keyboard walk and the placement all already
    // work, and a drill-down reuses every bit of it.
    if (entry.sub || entry.to) {
      btn.setAttribute('aria-haspopup', 'menu');
      if (entry.sub) btn.append(icon('i-chevron-right', 'ctx-chevron'));
      // Both assertions are the branch this is inside: one of the two is set,
      // and each arm has just tested which.
      btn.addEventListener('click', e => {
        // Unless the list being asked for is already on screen. Hovering this
        // row flew it out beside the row a moment ago, and a press that lands
        // afterwards is a press asking for something it can already see - so
        // the honest answer to it is nothing at all. Drilling in on it took the
        // open panel away and put the same rows in the parent's place, which is
        // the menu flinching at being clicked: the thing you were pointing at
        // moved, and the row now under the pointer is a different one.
        //
        // The condition is *this row's child is up*, not *a mouse did it* -
        // with the one exception the claim below was wrong about.
        //
        // It used to say the keyboard "arrives here with nothing open", which
        // is only true when the pointer has since left the row. Leave the mouse
        // resting on the Edit fold, arrow back onto it and press Enter: the
        // child was open, `childRow` was this button, and the press did
        // nothing at all. A dead key on a focused row is the worst answer
        // available - there is no feedback to tell it from a menu that has
        // stopped listening.
        //
        // `detail === 0` is the keyboard, and it is the one thing about the
        // *route* that every engine agrees on: a click synthesized by Enter or
        // Space carries no click count, and a real one always carries at least
        // 1. Which pointer a pointer-click came from stays unasked, because
        // that is the question with four answers.
        const byKey = e.detail === 0;
        if (entry.sub && child && childRow === btn && !byKey) return;
        swap(entry.sub ? subMenu(entry.sub, entries) : entry.to!);
      });
      // And the other route into the same list: hover it open beside the row,
      // the way a desktop context menu has always done. The click above is kept
      // rather than replaced, because it is the only route a finger or a
      // keyboard has - see openChild for why hover cannot be the whole answer.
      if (entry.sub) {
        btn.addEventListener('pointerenter', e => {
          if (e.pointerType !== 'mouse') return;
          openChild(btn, entry.sub!, panel);
        });
      }
    } else {
      // A row with no children closes whatever child is up: sliding down the
      // column past Edit has to put Edit's panel away, or the menu ends up
      // showing a submenu belonging to a row the pointer left three rows ago.
      // Only rows of the panel the child came *from* - a row of the child
      // itself must not shut the panel it is in.
      btn.addEventListener('pointerenter', e => {
        if (e.pointerType === 'mouse' && childFrom === panel) closeChild();
      });
      btn.addEventListener('click', () => {
        close();
        // Everything that is not a separator, a slider, a fold or a Back row is
        // an action row - which is the whole of what this branch is.
        entry.action!();
      });
    }
    panel.append(btn);
  }
}

// ---------------------------------------------------------------------------
// The child panel
// ---------------------------------------------------------------------------

/**
 * A submenu flown out beside its row, and the drill-down it does not replace.
 *
 * The card menu had grown to a dozen rows and the picture edits were most of
 * them, so they are a fold now - and a fold you have to *press*, which then
 * takes the menu away and puts a different list in its place, is a worse way to
 * reach a row than the long menu was. This is the other behaviour: hover the
 * row, the list appears next to it, press what you came for.
 *
 * **It is a second node, not a second implementation.** The rows are built by
 * fillPanel(), the same function that fills the root, and the panel wears
 * #ctx-menu's own rules (menu.css names both ids in one selector). What is new
 * here is where the box goes and when it goes away.
 *
 * **The drill-down stays, for the two routes that have no hover.** A finger has
 * none and a keyboard has none, so pressing a fold on either still turns the
 * page the way it always did - which is what keeps the phone and the arrow keys
 * working, and the two panels cannot both be up at once because opening either
 * closes the other.
 *
 * What a press does *not* do is turn the page on a row whose list is already
 * flown out beside it. See the click handler in fillPanel(): the press has
 * arrived after the hover has answered it.
 *
 * The close is deferred by a beat. A submenu that vanished the instant the
 * pointer left its row could not be reached at all: the way to it crosses the
 * gap between the two panels, and in that gap the pointer is over neither.
 */
let child: HTMLElement | null = null;
/** The panel a live child was opened from - see the pointerenter above. */
let childFrom: HTMLElement | null = null;
/** The row it belongs to, so a re-hover of the same row is not a re-open. */
let childRow: HTMLElement | null = null;
let childTimer = 0;

/** How long the pointer may be over neither panel before the child gives up. */
const CHILD_GRACE_MS = 220;

function closeChild() {
  clearTimeout(childTimer);
  childTimer = 0;
  child?.remove();
  child = null;
  childFrom = null;
  childRow?.classList.remove('is-open');
  childRow = null;
}

/** Let go of the child after the grace period, unless something asks again. */
function fadeChild() {
  clearTimeout(childTimer);
  childTimer = setTimeout(closeChild, CHILD_GRACE_MS);
}

function openChild(row: HTMLElement, entries: MenuEntry[], from: HTMLElement) {
  // Already this row's: the pointer came back inside the grace period, which is
  // the ordinary case of travelling to the panel and is not a reopen.
  if (childRow === row && child) { clearTimeout(childTimer); childTimer = 0; return; }
  closeChild();
  child = document.createElement('div');
  child.id = 'ctx-child';
  child.setAttribute('role', 'menu');
  child.setAttribute('aria-label', row.textContent?.trim() || 'More');
  child.tabIndex = -1;
  fillPanel(child, entries);
  child.style.visibility = 'hidden';
  panelHost().append(child);

  const pad = 8;
  const r = row.getBoundingClientRect();
  const box = child.getBoundingClientRect();
  // Beside the row, overlapping the parent's padding by the same amount the
  // panel pads its rows - so the two read as one object hinged at the row
  // rather than as two panels that happen to touch.
  const parent = from.getBoundingClientRect();
  const right = parent.right - 4;
  // Flip to the other side when there is no room, and only then: a submenu that
  // opened to the left by preference would cross back over the list it came
  // from every time the menu was near the middle of the window.
  const x = right + box.width + pad > innerWidth
    ? Math.max(pad, parent.left - box.width + 4)
    : right;
  // Top-aligned with its row, then lifted just enough to fit. Aligning to the
  // row is what says which row it belongs to; the clamp is what stops a long
  // list running off the bottom of the window.
  const y = Math.max(pad, Math.min(r.top - 5, innerHeight - box.height - pad));
  child.style.left = `${Math.round(x)}px`;
  child.style.top = `${Math.round(y)}px`;
  child.style.visibility = '';

  childRow = row;
  childFrom = from;
  row.classList.add('is-open');
  row.addEventListener('pointerleave', fadeChild);
  child.addEventListener('pointerenter', () => { clearTimeout(childTimer); childTimer = 0; });
  child.addEventListener('pointerleave', fadeChild);
}

/** Where the root panel goes, once its rows are in and it can be measured. */
function placeRoot(node: HTMLElement, clientX: number, clientY: number, opts: MenuOpts) {
  const pad = 8;
  // How tall a hung panel may be, measured off its own anchor rather than off
  // the top toolbar.
  //
  // It was a stylesheet rule counting down from --toolbar-h, which is the height
  // of the bar at the *top* of the window - correct while the three desktop
  // hover flyouts were the only callers, and wrong for the phone's More button,
  // which is on a bar pinned to the bottom. There the cap was computed against a
  // bar the menu has nothing to do with, so a panel that should have been capped
  // at the room above it was allowed to be nearly the whole window tall, could
  // not fit either way, and hung off the screen.
  //
  // Set before the measurement below, or the height read back is the uncapped
  // one and the flip is decided on a number that will never be true.
  if (opts.anchor) {
    const room = Math.max(innerHeight - opts.anchor.bottom, opts.anchor.top) - pad * 2;
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`;
  }
  panelHost().append(node);
  const { width, height } = node.getBoundingClientRect();
  let x, y;
  if (opts.anchor) {
    // Hung off a button, so the horizontal rule the cursor case uses is wrong:
    // it *clamps* rather than flips, because a flyout that jumped to the far
    // side of its button would leave the pointer outside itself and close again
    // on the way in. Clamping to the bar keeps that argument whole rather than
    // trading it - 208px of panel against 694px of bar still lands under the
    // button it belongs to.
    //
    // Two containers, intersected, and neither is optional. The bar is what the
    // panel has to look attached to (see MenuAnchor.bounds); the window is what
    // it has to remain visible in, and a bar wider than the viewport would push
    // the panel off-screen if the bar were trusted alone.
    //
    // The Math.max(lo, hi) is not decoration. A container narrower than the
    // panel gives hi < lo, and clamping between an inverted pair snaps to the
    // wrong edge; this degrades it to "align to the container's left edge",
    // which is the only sensible answer when the panel does not fit.
    const bounds = opts.anchor.bounds;
    const lo = Math.max(pad, Math.min(bounds ? bounds.left : pad, innerWidth - width - pad));
    const hi = Math.min(bounds ? bounds.right - width : Infinity, innerWidth - width - pad);
    x = Math.min(Math.max(lo, clientX), Math.max(lo, hi));
    // Vertically it hangs below and flips above when below will not fit.
    //
    // It used to hang below unconditionally, on the argument that the toolbar is
    // pinned to the top of the window so below is the only side there is. That
    // was true while the desktop bar's three hover flyouts were the only
    // callers. The phone's More button is on a bar pinned to the *bottom*, and
    // a menu hung under it went off the screen - the third row was simply not
    // there. The panel is adjacent to its button either way, so the pointer-path
    // argument above is untouched by this.
    //
    // The anchor's own box, not clientY, is what it flips about: above means
    // above the *button*, and hanging a panel over the thing it belongs to is
    // how you lose track of which one it belongs to.
    const above = opts.anchor.top - height - pad;
    const up = clientY + height + pad > innerHeight && above >= pad;
    y = up ? above : clientY;
    // Which side the flip landed on used to change the panel's *shape* - a
    // squared, borderless edge against whichever bar it was attached to, with
    // the two cases written out separately. It does not any more: there is one
    // panel shape, and the flip is now only about where the box goes. See the
    // head of the menu rules in menu.css.
  } else {
    // Flip rather than clamp when there isn't room: a menu pinned to the edge
    // ends up under the cursor, and the first entry gets clicked by accident.
    x = clientX + width + pad > innerWidth ? Math.max(pad, clientX - width) : clientX;
    y = clientY + height + pad > innerHeight ? Math.max(pad, clientY - height) : clientY;
  }
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  node.style.visibility = '';
  // A hover must not take the keyboard - see openAnchored. Everything else
  // does, and the default is the context menu's because that is the caller
  // that has always been here.
  if (opts.focus !== false) node.focus({ preventScroll: true });
}

/**
 * A slider row. `entry.range` is `{min, max, step, unit, get, set}`.
 *
 * A <label> and not a menuitem: it is a dial, and announcing it as one of a
 * menu's actions would be a lie to a screen reader and would put it in the
 * arrow-key walk, where Left and Right belong to the slider itself.
 */
function rangeRow(entry: MenuEntry) {
  // Asserted: the only caller is render(), on the branch that just tested it.
  const { min, max, step, unit = '', get, set } = entry.range!;
  const row = document.createElement('label');
  row.className = 'ctx-range';

  const name = document.createElement('span');
  // A dial is named or it is a mystery - the same assertion the button rows make.
  name.textContent = entry.label!;
  row.append(name);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(get());
  row.append(slider);

  const read = document.createElement('output');
  read.textContent = slider.value + unit;
  row.append(read);

  slider.addEventListener('input', () => {
    read.textContent = slider.value + unit;
    set(Number(slider.value));
  });
  return row;
}

/**
 * A colour, drawn as a colour, in the column the icons use.
 *
 * A <span> with a background rather than a filled i-swatch, because the sprite
 * symbol is a drawing of a paint chip and the drawing is not the point - the
 * colour is. Sized to the icons beside it so the column stays a column.
 */
function chip(color: string | string[], className = 'ctx-chip') {
  const dot = document.createElement('span');
  dot.className = className;
  // One colour fills the chip; several split it into equal vertical bands, which
  // is a linear-gradient with hard stops rather than N child elements - the chip
  // is 13px, and three nested spans to paint three stripes inside it would be
  // three layout boxes for something the background can say in one string.
  if (Array.isArray(color)) {
    const step = 100 / color.length;
    const stops = color.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
    dot.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  } else {
    dot.style.background = color;
  }
  return dot;
}

/**
 * One icon from assets/icons.svg, as the same wrapper index.html uses.
 *
 * Exported for ui/fence-prompt.js, which borrows this menu's row and now
 * borrows its icons too - the offer under the band and the `Fence these 5`
 * entry are one action met in two places, and this is what keeps them one
 * drawing rather than two that have to be remembered together.
 *
 * createElementNS and not innerHTML: SVG elements are not HTML elements, and an
 * <svg> written into innerHTML on an HTML parent is parsed into the HTML
 * namespace, where it is markup that looks right and draws nothing.
 *
 * The path is relative to the document, which is safe here in a way it would
 * not be in an app that routes: nothing in this codebase calls pushState, and a
 * fragment cannot move the base a relative URL is resolved against.
 */
// Annotated ahead of the rest of this module: every other file in ui/ builds
// its icons through here, and an unannotated `extra` reads to tsc as a
// parameter they all forgot to pass.
export function icon(name: string, extra?: string) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', extra ? `ico ${extra}` : 'ico');
  // The label beside it already says what it is. An icon that announced itself
  // as well would have a screen reader read every entry twice.
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function moveFocus(step: number) {
  const items = focusRows();
  if (!items.length) return;
  const at = items.findIndex(row => row === document.activeElement);
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}
