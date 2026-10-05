// Right-click menu and the renderer every other menu uses (via openAnchored).
// One menu at a time, built fresh on each open. World point captured at open
// so actions know "where". Entries carry an icon from icons.svg. One resting
// home per action — repeats only where they reach something the home cannot.

// Imported directly — renaming is the drawn name, so the affordance stays here.
import { canRenameItem, editItemName } from '../canvas/items.ts';
import { cue } from '../cuelume/engine.ts';
import { markClosed } from '../util.ts';
import { tickSlider } from './controls.ts';
import { STICKER_TINT_NAMES } from '../stickers/catalogue.ts';
import type { ConnMeta, ConnColor, ConnWeight } from '../board-model.ts';
import type { Point } from '../geometry.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** A slider row — `get`/`set` keep the value wherever it already lives. */
export type MenuRange = {
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Typed as number so a wrong get/set is caught here, not in rangeRow(). */
  get: () => number;
  set: (value: number) => void;
};

/** One row. Flat (not a union) so builders can hand conditional fields freely.
 * `check` is `unknown` because settings return opaque values; render() only
 * tests truthiness. */
export type MenuEntry = {
  label?: string;
  /** a <symbol> in assets/icons.svg, by name */
  icon?: string;
  accel?: string;
  check?: unknown;
  hidden?: boolean;
  danger?: boolean;
  sep?: boolean;
  /** Colour chip in the icon column. Array form draws split bands (palette picker). */
  swatch?: string | string[];
  /** Trailing-edge specimen chip. Tint chips go in the icon column (swatch);
   * palette specimens go here so they line up for comparison down the list. */
  swatchEnd?: string | string[];
  /** A font-family for the label - a face menu sets each row in its own face. */
  font?: string;
  /** Greyed readout row — shown but inert, skipped by arrow keys. */
  disabled?: boolean;
  /** a child menu, opened in place */
  sub?: MenuEntry[];
  /** where the Back row goes - the parent menu it was drilled into from */
  to?: MenuEntry[];
  range?: MenuRange;
  action?: () => void;
};

/** Anchor box for a hung panel. A DOMRect satisfies it. `bounds` constrains
 * the panel to a bar; defaults to the window. */
export type MenuAnchor = {
  left: number;
  /** Required so the panel's transform-origin centres on the anchor. */
  right: number;
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
  /** no entrance or exit - see .is-instant in menu.css */
  instant?: boolean;
};

/** Commands this menu needs. Declared here (not imported from commands.ts)
 * because flyout.ts imports this module — the arrow can only go one way. */
export interface MenuCommands {
  // Only the commands the menu actually calls — the rest stay in commands.ts.
  //
  // The canvas menu
  addNoteAt: (at: Point | null) => void;
  selectAll: () => void;
  rearrange: () => void;
  nudgeBoard: () => void;
  nudgeSelection: () => void;
  nudgeFence: (id: string) => void;
  fitFence: (id: string) => void;
  rearrangeFence: (id: string) => void;
  // The touch multi-select mode: whether it is on, and the one way in or out.
  multiSelect: () => boolean;
  toggleMultiSelect: () => void;
  reload: () => void;
  fenceUnder: (at: Point) => string | null;
  settingOn: (key: 'snap' | 'grid') => boolean;
  toggleSetting: (key: 'snap' | 'grid') => void;
  // One card, or the selection it is part of
  isTitleCard: (id: string) => boolean;
  isFenceItem: (id: string) => boolean;
  fenceTintOf: (id: string) => number;
  setFenceTint: (id: string, tint: number) => void;
  isRolledFence: (id: string) => boolean;
  setFenceRolled: (id: string, rolled: boolean) => void;
  canEditNote: (id: string) => boolean;
  canCoverItem: (id: string) => boolean;
  canClearCover: (id: string) => boolean;
  canSetFit: (id: string) => boolean;
  canEditPicture: (id: string) => boolean;
  canFlipUpAxis: (id: string) => boolean;
  canRotateModel: (id: string) => boolean;
  canExtractSwatches: (id: string) => boolean;
  canKeepFrame: (id: string) => boolean;
  canDemosaic: (id: string) => boolean;
  canTintSticker: (id: string) => boolean;
  canTintNote: (id: string) => boolean;
  noteTintOf: (id: string) => number;
  setNoteTint: (id: string, tint: number) => void;
  canViewItem: (id: string) => boolean;
  canEditDocument: (id: string) => boolean;
  editDocument: (id: string) => void;
  selectionLineCount: () => number;
  removeSelectionConnections: () => void;
  selectLike: (id: string) => void;
  canSelectFenceContents: (id: string) => boolean;
  selectFenceContents: (id: string) => void;
  canSelectJoined: (id: string) => boolean;
  selectJoined: (id: string) => void;
  canSaveItemFile: (id: string) => boolean;
  saveItemFile: (id: string) => void;
  canSendItemFile: (id: string) => boolean;
  sendItemFile: (id: string) => void;
  canReplaceItemFile: (id: string) => boolean;
  replaceItemFile: (id: string) => void;
  itemFileMissing: (id: string) => boolean;
  // Link cards: the address is the whole point, so its Properties row (edit the
  // name, edit or copy the address) sits at the top of the menu. linkURLOf
  // returns the address, or null for a non-link.
  linkURLOf: (id: string) => string | null;
  linkProps: (id: string) => void;
  /** "Open" on a link: the site in a new tab, or - for YouTube - the viewer
   *  with its player. Non-link items use openViewer instead. */
  openLink: (id: string) => void;
  canUnstick: () => boolean;
  canTag: () => boolean;
  boardTags: () => { tag: string, count: number }[];
  selectionHasTag: (tag: string) => boolean;
  toggleSelectionTag: (tag: string) => void;
  addTag: () => void;
  tagFilter: () => string[];
  hasTagFilter: () => boolean;
  isTagFiltered: (tag: string) => boolean;
  toggleTagFilter: (tag: string) => void;
  clearTagFilter: () => void;
  filterCounts: () => { shown: number, all: number };
  selectFiltered: () => void;
  // Tour playback only — building a tour is the Board tab's job.
  inTour: () => boolean;
  tourLength: () => number;
  tourAt: () => number;
  tourStep: (delta: number) => void;
  tourGo: (i: number) => void;
  tourStop: () => void;
  // Zoom to fit — only needed in tour mode, where the zoom cluster is hidden.
  fit: () => void;
  canLock: () => boolean;
  lockableCount: () => number;
  lockedCount: () => number;
  selectionHasStackOverlap: () => boolean;
  itemFit: (id: string) => string;
  stickerTintOf: (id: string) => number;
  openViewer: (id: string) => void;
  editNote: (id: string) => void;
  setCover: (id: string) => void;
  clearCover: (id: string) => void;
  setItemFit: (id: string, fit: string) => void;
  canSetBare: (id: string) => boolean;
  itemBare: (id: string) => boolean;
  setItemBare: (id: string, bare: boolean) => void;
  canSetFaded: (id: string) => boolean;
  itemFaded: (id: string) => boolean;
  setItemFaded: (id: string, faded: boolean) => void;
  editPicture: (id: string) => void;
  flipUpAxis: (id: string) => void;
  extractSwatches: (id: string) => void;
  // Async internally (decodes a frame); void here — menu fires and closes.
  keepFrame: (id: string) => void;
  // Async internally (develops the sensor in a worker); void here, as above.
  demosaic: (id: string) => void;
  rotateModel: (id: string) => void;
  setStickerTint: (id: string, tint: number) => void;
  raise: () => void;
  lower: () => void;
  unstick: () => void;
  lockSelection: (on: boolean) => void;
  resetSize: () => void;
  rearrangeSelection: () => void;
  fenceSelection: () => void;
  alignSelection: (edge: string) => void;
  distributeSelection: (axis: 'x' | 'y') => void;
  matchSizeSelection: (ref: string, axis: 'w' | 'h') => void;
  copy: () => void;
  paste: (at: Point | null) => void;
  canPaste: () => boolean;
  canCopy: () => boolean;
  zoomToSelection: () => void;
  deleteSelection: () => void;
  // The title card
  editTitle: () => void;
  resetTitlePosition: () => void;
  // A line between two cards
  connectionUnder: (at: Point) => { a: string, b: string } | null;
  connectionStyle: (a: string, b: string) => ConnMeta | null;
  setConnectionStyle: (a: string, b: string, patch?: ConnMeta | null) => void;
  editConnectionLabel: (a: string, b: string) => void;
  clearConnectionLabel: (a: string, b: string) => void;
  removeConnection: (a: string, b: string) => void;
}

let node: HTMLElement | null = null;
let vp: Viewport | null = null;
let cmds: MenuCommands | null = null;

/** Whether a menu is up. Android's Back (main.ts) closes one before a dialog,
 *  since a menu over a dialog is inside it. */
export const isMenuOpen = () => !!node;

/** Panels animating out. They are logically closed (no keyboard, no hit-test,
 * not in insideMenu()) — only the DOM removal is deferred for the exit
 * animation. A set because root and child can leave together. */
const leaving = new Set<HTMLElement>();

/** Fallback timeout for exit animation. Fires only when animationend never
 * does (hidden tab, missing sheet). Timer, not rAF — rAF stalls when occluded. */
const LEAVE_MS = 400;

/** Remove any still-animating panels immediately. Keeps the "at most one
 * #ctx-menu" invariant — new panels flush before building. */
function flushLeaving() {
  for (const el of leaving) el.remove();
  leaving.clear();
}

function dismiss(el: HTMLElement) {
  // Nothing to play out, and no animationend would come - see .is-instant.
  if (el.classList.contains('is-instant')) { el.remove(); return; }
  leaving.add(el);
  el.classList.add('is-leaving');
  // `inert` blocks keyboard, hit-testing and screen reader during exit anim.
  // Falls back to menu.css's pointer-events on engines that lack it.
  el.setAttribute('inert', '');
  const done = () => {
    clearTimeout(timer);
    el.remove();
    leaving.delete(el);
  };
  const timer = setTimeout(done, LEAVE_MS);
  el.addEventListener('animationend', done, { once: true });
}
// Whatever had the keyboard when the menu opened, so it can be given back.
let opener: HTMLElement | null = null;

// SAFETY: activeElement is always an HTMLElement on this page; focus() is all we call.
const focusedNow = () => document.activeElement as HTMLElement | null;
// Kept so a drill-down re-renders at the same anchor, not wherever the pointer drifted.
let lastX = 0, lastY = 0;
let lastOpts: MenuOpts = {};

/** True when a finger opened this menu — only multiSelectEntry() reads it. */
let byTouch = false;

/** Close hook — one subscriber (flyout.ts) writes aria-expanded back. */
let onClose: (() => void) | null = null;
export function setMenuCloseHook(fn: (() => void) | null) { onClose = fn; }

/** Tracks which press dismissed the menu so that the same button's click can
 * decline to reopen. Timestamped — stale records expire after DISMISS_MS. */
type Dismissal = { by: EventTarget | null, at: number, owner: Element | null };

let dismissed: Dismissal = { by: null, at: -Infinity, owner: null };
const DISMISS_MS = 400;

/** Which button owns this menu. Scopes justDismissed() so pressing button B
 * while A's menu is up does not make B think *it* just dismissed its own. */
let menuOwner: Element | null = null;

/** True when this element's press just dismissed the menu — caller should not
 * reopen. Consumed on read. */
export function justDismissed(el: Element | null): boolean {
  if (!el || !dismissed.by) return false;
  if (performance.now() - dismissed.at > DISMISS_MS) return false;
  // SAFETY: dismissed.by is an EventTarget from a pointerdown on this page — always a Node.
  if (!el.contains(dismissed.by as Node)) return false;
  // Must be this button's own menu — see menuOwner.
  if (!dismissed.owner || !el.contains(dismissed.owner)) return false;
  dismissed = { by: null, at: -Infinity, owner: null };
  return true;
}

// vp/cmds are `!`-asserted — initMenu() runs before any menu can open.
/** Checks both root and child panel — child is a sibling, not a descendant. */
// SAFETY: target from a pointer/focus event on this document is a Node or null.
const insideMenu = (target: EventTarget | null) =>
  !!node?.contains(target as Node | null) || !!child?.contains(target as Node | null);

/** Does the menu own the keyboard? False for hover flyouts (they never take focus). */
const ownsKeyboard = () =>
  !!lastOpts.focus || insideMenu(document.activeElement);

export function initMenu(viewport: Viewport, commands: MenuCommands) {
  vp = viewport;
  cmds = commands;

  // Close on anything that invalidates the anchor. Pointer/wheel let the menu's
  // own scroller through.
  addEventListener('pointerdown', e => {
    if (!node || insideMenu(e.target)) return;
    // Recorded before close() clears the state — see justDismissed().
    dismissed = { by: e.target, at: performance.now(), owner: menuOwner };
    close();
  }, true);
  addEventListener('wheel', e => {
    if (node && !insideMenu(e.target)) close();
  }, { passive: true, capture: true });
  // Capture — scroll does not bubble.
  addEventListener('scroll', e => {
    if (node && !insideMenu(e.target)) close();
  }, true);
  // Press, drag, release - see followPress().
  addEventListener('pointerdown', e => { down = { id: e.pointerId, x: e.clientX, y: e.clientY }; }, true);
  // Which hand the next menu comes from - see byKeys.
  addEventListener('keydown', () => { byKeys = true; }, true);
  addEventListener('pointerdown', () => { byKeys = false; }, true);
  addEventListener('pointermove', () => { byKeys = false; }, true);
  addEventListener('pointermove', followPress, true);
  addEventListener('pointerup', releasePress, true);
  addEventListener('pointercancel', () => { down = null; press = null; }, true);
  addEventListener('resize', close);
  addEventListener('blur', close);
  addEventListener('keydown', e => {
    if (!node) return;
    // Escape closes regardless of focus - the menu alone. Prevented too, or the
    // browser turns the same press into a cancel for a <dialog> under the menu
    // (the viewer, the editor) and closes that as well. Nothing below sees it
    // anyway: propagation stops here.
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); markClosed(e); close(); return; }
    // Navigation keys only when the menu owns the keyboard — otherwise typing
    // in a field behind a hover flyout would be swallowed by typeAhead().
    if (!ownsKeyboard()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Jump to first/last row.
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusEnd(e.key === 'Home' ? 1 : -1);
      return;
    }
    // Type-ahead — single printable chars only; modifiers stay out.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (typeAhead(e.key)) e.preventDefault();
    }
  }, true);
}

// ---------------------------------------------------------------------------
// Press, drag, release
// ---------------------------------------------------------------------------

/** The pointer that is down now, so a menu opened under a press can follow it. */
let down: { id: number, x: number, y: number } | null = null;
/** The last input was a key, not a pointer: a menu it opens has nothing to animate from. */
let byKeys = false;
/** The press a menu was opened under, and whether it has become a drag. */
let press: { id: number, x: number, y: number, at: number, moved: boolean } | null = null;
/** Travel that makes a press a drag rather than a click. */
const DRAG_PX = 6;
/** A press held this long picks on release without moving, as a drag does. */
const HOLD_MS = 350;

/**
 * The row under a point, in either panel, if it can be pressed. Asked of the
 * point rather than the event target: a finger's pointer is captured by
 * whatever it first touched, so its events never name the row under it.
 */
function rowAt(x: number, y: number): HTMLElement | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.ctx-item');
  if (!row || !insideMenu(row) || row.matches(':disabled')) return null;
  return row;
}

/**
 * A menu opened by a press follows that pointer, as on iOS: a move lights the
 * row under it, and a release on a row after a move or a hold picks it. A
 * mouse lights rows by :hover already - `is-hot` is for the finger.
 */
function followPress(e: PointerEvent) {
  const p = press;
  if (!p || p.id !== e.pointerId || !node) return;
  if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
  p.moved = true;
  const row = rowAt(e.clientX, e.clientY);
  for (const hot of document.querySelectorAll('.ctx-item.is-hot')) {
    if (hot !== row) hot.classList.remove('is-hot');
  }
  row?.classList.add('is-hot');
}

function releasePress(e: PointerEvent) {
  if (down?.id === e.pointerId) down = null;
  const p = press;
  if (!p || p.id !== e.pointerId) return;
  press = null;
  // A plain click leaves the menu up, which is what keeps clicking working.
  if (!node || (!p.moved && performance.now() - p.at < HOLD_MS)) return;
  // click() rather than the action: a fold drills in and a row closes the
  // menu exactly as a press on it would. The browser sends its own click to
  // the element the press started on and this row share an ancestor of,
  // never to the row.
  rowAt(e.clientX, e.clientY)?.click();
}

/**
 * Wire a button that opens a menu. A mouse opens it on the press, so the same
 * press can drag down the list and release on a row. A finger and the
 * keyboard open it on the click, so a finger can still scroll the panel past
 * the button. A second press closes it rather than reopening - the capture
 * listener above has shut the menu before either handler runs.
 */
export function menuButton(btn: HTMLButtonElement, open: () => void) {
  let byMouse = false;
  btn.addEventListener('pointerdown', e => {
    byMouse = e.pointerType === 'mouse';
    if (!byMouse || e.button !== 0 || btn.disabled) return;
    if (justDismissed(btn)) return;
    open();
  });
  // A mouse press would otherwise move focus onto the button, off the menu
  // it just opened.
  btn.addEventListener('mousedown', e => { if (e.button === 0) e.preventDefault(); });
  btn.addEventListener('click', e => {
    // The mouse press already answered. detail 0 is the keyboard.
    if (byMouse && e.detail !== 0) return;
    if (justDismissed(btn)) return;
    open();
  });
}

/** Jump to the first or last focusable row. */
function focusEnd(dir: 1 | -1) {
  const items = focusRows();
  if (items.length) items[dir > 0 ? 0 : items.length - 1].focus();
}

/** Focusable rows of whichever panel holds focus (root or child).
 * Follows focus, not the child pointer — hover must not steal the keyboard.
 * :not(:disabled) skips readout rows that cannot take focus. */
function focusRows(): HTMLElement[] {
  const panel = child?.contains(document.activeElement) ? child : node;
  return panel ? [...panel.querySelectorAll<HTMLElement>('.ctx-item:not(:disabled)')] : [];
}

/** Type-ahead buffer. Clears after TYPE_MS. Repeated same-char cycles through
 * matches; mixed chars search as a prefix. */
let typed = '';
let typedAt = -Infinity;
const TYPE_MS = 900;

function typeAhead(key: string): boolean {
  const now = performance.now();
  typed = now - typedAt > TYPE_MS ? key : typed + key;
  typedAt = now;
  const items = focusRows();
  if (!items.length) return false;
  // Whole button text (icon/accel included but harmless for prefix matching).
  const words = items.map(row => (row.textContent || '').trim().toLowerCase());
  const want = typed.toLowerCase();
  const repeat = want.length > 1 && [...want].every(c => c === want[0]);
  const needle = repeat ? want[0] : want;
  // Start after the focused row so repeated presses advance.
  const from = items.findIndex(row => row === document.activeElement);
  for (let i = 1; i <= items.length; i += 1) {
    const at = (Math.max(from, 0) + (repeat || typed.length === 1 ? i : i - 1)) % items.length;
    if (words[at].startsWith(needle)) { items[at].focus(); return true; }
  }
  return false;
}

export function close() {
  if (!node) return;
  closeChild();
  // Read before removal — we need to know if focus should return to the opener.
  const held = node.contains(document.activeElement);
  dismiss(node);
  node = null;
  // Reset type-ahead — it belonged to the menu that just closed.
  typed = '';
  typedAt = -Infinity;
  // Clear owner — `dismissed` already took its copy.
  menuOwner = null;
  const back = opener;
  opener = null;
  // Only return focus if the menu had it — a pointerdown close lets the browser decide.
  if (held && back?.isConnected) back.focus({ preventScroll: true });
  // Last — flyout driver reads this to write aria-expanded, after node is gone.
  onClose?.();
}

/** Open a menu hung under an anchor element. `focus` false for hover (must not
 * steal keyboard from whatever is being typed). */
export function openAnchored(rect: MenuAnchor, entries: MenuEntry[],
  { label = 'Menu', focus = false, owner = null, instant = false }:
    { label?: string, focus?: boolean, owner?: Element | null, instant?: boolean } = {}) {
  close();
  opener = focusedNow();
  // Set after close() which clears it — see menuOwner.
  menuOwner = owner;
  render(entries, rect.left, rect.bottom, { anchor: rect, label, focus, instant });
}

/** Open the context menu. `mobile` = Feed (drops spatial rows, no canvas menu).
 * `touch` = finger opened this (shown to multiSelectEntry). `lead` = rows of
 * the surface's own over the card's (the Playlist's order and hiding),
 * `rename` = its own in-place rename, where the card is not on screen,
 * `track` = a Playlist row, which has no use for Open, Copy or Tags, and
 * `selectAll` = the surface's Select all, over the cards it shows. */
export function openContextMenu(clientX: number, clientY: number, itemId: string | null,
  selectionSize: number,
  { mobile = false, touch = false, lead = [], rename, track = false, selectAll }:
    { mobile?: boolean, touch?: boolean, lead?: MenuEntry[], rename?: () => void,
      track?: boolean, selectAll?: () => void } = {}) {
  // Module field — only multiSelectEntry() reads it.
  byTouch = touch;
  if (mobile) {
    close();
    opener = focusedNow();
    // No `at` — Feed drops the spatial rows that use it.
    const own = withoutKeys(itemId
      ? itemEntries(itemId, selectionSize, null, true, rename, track)
      : sheetEntries(selectAll));
    render(lead.length ? [...lead, { sep: true }, ...own] : own, clientX, clientY);
    return;
  }
  // After close — the old menu's focus return is what gives us the right opener.
  close();
  opener = focusedNow();
  // During a tour, always show the tour menu — editing is off limits.
  if (cmds!.inTour()) { render(tourEntries(), clientX, clientY); return; }
  // Annotated — viewport.ts toWorld() returns `any` until fully typed.
  const at: Point = vp!.toWorld(clientX, clientY);
  // Connection line on bare board gets its own editor directly.
  const conn = !itemId ? cmds!.connectionUnder(at) : null;
  const entries = conn ? connectionEntries(conn)
    : !itemId ? canvasEntries(at)
    // Title card gets its own short menu when it is the sole selection.
    : selectionSize <= 1 && cmds!.isTitleCard(itemId) ? titleEntries(itemId, at)
    : itemEntries(itemId, selectionSize, at);
  render(entries, clientX, clientY);
}

/** The Feed's menu prints no key hints: a phone has no keyboard and no double-click. */
const withoutKeys = (entries: MenuEntry[]): MenuEntry[] =>
  entries.map(e => (e.accel ? { ...e, accel: '' } : e));

/** Title card menu — edit style, reset position, anchor, delete. No copy/stack.
 * Anchor is only reachable here (the card starts anchored, so drags pan). */
function titleEntries(_id: string, _at: Point): MenuEntry[] {
  // Guard on canLock() — both counts are zero when unselected.
  const lockable = cmds!.canLock();
  const anchored = lockable && cmds!.lockedCount() === cmds!.lockableCount();
  return [
    { label: 'Edit style', icon: 'i-style', action: () => cmds!.editTitle() },
    { label: 'Reset position', icon: 'i-reset-position', action: () => cmds!.resetTitlePosition() },
    { label: 'Anchor', icon: 'i-anchor', hidden: !lockable || anchored,
      action: () => cmds!.lockSelection(true) },
    { label: 'Unanchor', icon: 'i-anchor-off', hidden: !lockable || !anchored,
      action: () => cmds!.lockSelection(false) },
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

/** Card menu. `mobile` (Feed) hides spatial rows (z-order, zoom, fence, etc.)
 * that have no meaning on a packed wall. One list with flags, not two lists. */
function itemEntries(id: string, count: number, at: Point | null, mobile = false,
  rename?: () => void, track = false): MenuEntry[] {
  const many = count > 1;
  const what = many ? `${count} items` : 'item';
  // Single-item edits — no caret target for a group.
  const editable = !many && cmds!.canEditNote(id);
  const renamable = !many && canRenameItem(id);
  // Single-item — file dialog answers with one file.
  const coverable = !many && cmds!.canCoverItem(id);
  // Separate from coverable — a card that cannot receive a cover may still have one.
  const covered = !many && cmds!.canClearCover(id);
  // Per-card fill/fit override. Single-item.
  const fittable = !many && cmds!.canSetFit(id);
  const fills = fittable && cmds!.itemFit(id) === 'cover';
  const bareable = !many && cmds!.canSetBare(id);
  const bare = bareable && cmds!.itemBare(id);
  const fadeable = !many && cmds!.canSetFaded(id);
  const faded = fadeable && cmds!.itemFaded(id);
  // Crop/grade — non-spatial, so offered on Feed too.
  const croppable = !many && cmds!.canEditPicture(id);
  // Single RAW card, until it is developed — on Feed too, like crop.
  const demosaicable = !many && cmds!.canDemosaic(id);
  // Selection-wide — content items only (not fences/furniture).
  const taggable = !track && cmds!.canTag();
  const flippable = !many && cmds!.canFlipUpAxis(id);
  // Single-item — you turn one model over.
  const turnable = !many && cmds!.canRotateModel(id);
  // Z-order only meaningful when layers overlap. Never on Feed (packed, not stacked).
  const stackable = !mobile && cmds!.selectionHasStackOverlap();
  // Selection-wide — taking nine stickies off is the same act as taking one off.
  const unstickable = !mobile && cmds!.canUnstick();
  // Not on Feed — an anchor holds a place, and the Feed packs by order.
  const lockable = !mobile && cmds!.canLock();
  const allLocked = lockable && cmds!.lockedCount() === cmds!.lockableCount();
  // Single-item — extracts one image's palette.
  const swatchable = !many && cmds!.canExtractSwatches(id);
  // Single-item — tint is an edit to one sticker.
  const tintable = !many && cmds!.canTintSticker(id);
  // And a note's sheet, on the same terms. On the Feed too: colour is not spatial.
  const noteTintable = !many && cmds!.canTintNote(id);
  // Single fence, canvas only — its colour and its roll-up.
  const fenceItem = !many && !mobile && cmds!.isFenceItem(id);
  const rolled = fenceItem && cmds!.isRolledFence(id);
  // Single-item — viewer shows one thing at a time. A track plays in its row.
  const viewable = !track && !many && cmds!.canViewItem(id);
  const writable = viewable && cmds!.canEditDocument(id);
  // Single-item, not on Feed — "the current frame" is per-clip.
  const freezable = !many && !mobile && cmds!.canKeepFrame(id);
  // ── Picture edits fold ──
  // How the picture sits/looks: crop, fill/fit, palette, keep-frame. Item-level
  // edits (rename, cover, upright, rotate) stay in the main column.
  const pictureEdits: MenuEntry[] = [
    // Ellipsis — opens a surface, decides nothing on its own.
    { label: 'Edit picture…', icon: 'i-crop', hidden: !croppable,
      action: () => cmds!.editPicture(id) },
    // Radio pair — tick shows current, pressing the other switches.
    { label: 'Fill the cells', icon: 'i-fill', check: fills, hidden: !fittable,
      action: () => cmds!.setItemFit(id, 'cover') },
    { label: 'Fit in the cells', icon: 'i-fit-card', check: fittable && !fills,
      hidden: !fittable, action: () => cmds!.setItemFit(id, 'contain') },
    // Last — the only row here that adds something new to the board.
    { label: 'Extract palette', icon: 'i-swatch', hidden: !swatchable,
      action: () => cmds!.extractSwatches(id) },
    // Irreversible (unlike the rest of this fold) — at the bottom, away from
    // the fit pair. Phrased as "keep" not "delete" to avoid reading as destructive.
    { label: 'Keep this frame', icon: 'i-still', hidden: !freezable,
      action: () => cmds!.keepFrame(id) },
  ];
  // Hide the fold row if every entry inside it is hidden.
  const editable_picture = pictureEdits.some(e => !e.hidden);
  // A link card leads its menu with Properties: the one box where its name and
  // address are edited or the address copied. Single-item only - a group has no
  // one address. Above everything else because the address is why the card exists.
  const linkURL = !many ? cmds!.linkURLOf(id) : null;
  const linkTop: MenuEntry[] = linkURL ? [
    { label: 'Properties', icon: 'i-link', action: () => cmds!.linkProps(id) },
    { sep: true },
  ] : [];
  return [
    ...linkTop,
    // First row on notes — the most common reason to right-click a sticky.
    { label: 'Edit text', icon: 'i-edit-text', accel: 'dbl-click', hidden: !editable,
      action: () => cmds!.editNote(id) },
    // Above Open — unsticking a rider is nearly always why you right-click it.
    // Hidden on non-stickies so it costs other types no row.
    { label: many ? 'Unstick these' : 'Unstick', icon: 'i-lock-open',
      hidden: !unstickable, action: () => cmds!.unstick() },
    // Duplicated from canvas menu — a hold on a card is how touch starts collecting.
    // The Feed too, now that it draws the selection (ui/feed.ts).
    ...multiSelectEntry(),
    // Sets the board can already name, from the card that names them. Single-
    // card: "like this" needs one this. Only the kind row on the Feed, which
    // has no fences to look inside and no lines drawn.
    { label: 'Select', icon: 'i-select-all', hidden: many || track,
      sub: !many && !track ? selectEntries(id, mobile) : undefined },
    // No accel on notes — double-click belongs to Edit text there.
    // A link opens its site (or, for YouTube, the viewer's player) - see
    // openLink. Every other viewable item opens in the viewer.
    { label: 'Open', icon: 'i-expand', accel: editable ? '' : 'dbl-click',
      hidden: !viewable && !linkURL,
      action: () => linkURL ? cmds!.openLink(id) : cmds!.openViewer(id) },
    // Open reads a document; this writes in it.
    { label: 'Edit', icon: 'i-edit-text', hidden: !writable,
      action: () => cmds!.editDocument(id) },
    // The card's own file, given back - beside Open, the other thing done to a
    // file as a file. Single-item: a group is the board's export.
    { label: 'Save the file', icon: 'i-download', hidden: many || !cmds!.canSaveItemFile(id),
      action: () => cmds!.saveItemFile(id) },
    { label: 'Send the file', icon: 'i-share', hidden: many || !cmds!.canSendItemFile(id),
      action: () => cmds!.sendItemFile(id) },
    // The card stays - its place, width, tags and lines - and holds another file.
    // On a card whose file is gone the same picker is the way to find it: the
    // file it lost heals the card (import/drop.ts), and any other replaces it.
    { label: cmds!.itemFileMissing(id) ? 'Find the file…' : 'Replace file…', icon: 'i-swap',
      hidden: many || !cmds!.canReplaceItemFile(id), action: () => cmds!.replaceItemFile(id) },
    // Copy/Paste instead of Duplicate — paste lands where the cursor is, on any
    // board. Ctrl+D still duplicates. i-duplicate icon on Copy deliberately.
    // Hidden when nothing picked may be copied - the cleaned board's card.
    { label: many ? `Copy ${count} items` : 'Copy', icon: 'i-duplicate', accel: 'Ctrl C',
      hidden: track || !cmds!.canCopy(), action: () => cmds!.copy() },
    // Hidden (not greyed) on empty clipboard.
    { label: 'Paste', icon: 'i-paste', accel: 'Ctrl V', hidden: !cmds!.canPaste(),
      action: () => cmds!.paste(at) },
    // Shift+F, not dbl-click: double-click stopped zooming (canvas/input.ts).
    { label: 'Zoom to it', icon: 'i-zoom-to', accel: 'Shift F',
      action: () => cmds!.zoomToSelection(), hidden: mobile || many },
    { label: 'Zoom to them', icon: 'i-zoom-to', accel: 'Shift F',
      action: () => cmds!.zoomToSelection(), hidden: mobile || !many },
    // ── What the card is ──
    { sep: true, hidden: !coverable && !covered && !editable_picture && !demosaicable
      && !flippable && !turnable && !tintable && !noteTintable && !fenceItem && !taggable },
    { label: covered ? 'Change picture' : 'Set a picture', icon: 'i-picture',
      hidden: !coverable, action: () => cmds!.setCover(id) },
    { label: 'Remove picture', icon: 'i-picture-off', hidden: !covered,
      action: () => cmds!.clearCover(id) },
    // Picture edits fold — "Picture" not "Edit" because adjacent rows rename/delete the item.
    { label: 'Picture', icon: 'i-crop', hidden: !editable_picture,
      sub: editable_picture ? pictureEdits : undefined },
    // A RAW card draws its camera's preview. This develops the sensor itself.
    { label: 'Demosaic', icon: 'i-demosaic', hidden: !demosaicable,
      action: () => cmds!.demosaic(id) },
    // Outside the fold — "No card" is about the item, not the picture.
    // Also avoids a confusing double-tick alongside the Fill/Fit radio pair.
    { label: 'No card', icon: 'i-cut-out', check: bare, hidden: !bareable,
      action: () => cmds!.setItemBare(id, !bare) },
    // A sticky's answer in the same place: the paper stays, see-through.
    { label: 'Low opacity', icon: 'i-low-opacity', check: faded, hidden: !fadeable,
      action: () => cmds!.setItemFaded(id, !faded) },
    // OBJ up-axis is ambiguous — per-item, not in Appearance.
    { label: 'Turn it upright', icon: 'i-upright', hidden: !flippable,
      action: () => cmds!.flipUpAxis(id) },
    // Below upright — the ordinary gesture, not the rare fix.
    { label: 'Rotate model', icon: 'i-rotate', hidden: !turnable,
      action: () => cmds!.rotateModel(id) },
    // Full palette — every shape takes every tint. Tick shows the current one.
    { label: 'Colour', icon: 'i-swatch', hidden: !tintable,
      sub: tintable ? stickerTintEntries(id) : undefined },
    // A fence's colour, washed over the whole region.
    { label: 'Colour', icon: 'i-swatch', hidden: !fenceItem,
      sub: fenceItem ? fenceTintEntries(id) : undefined },
    // A note's sheet, changed after the fact rather than retyped on another.
    { label: 'Colour', icon: 'i-swatch', hidden: !noteTintable,
      sub: noteTintable ? noteTintEntries(id) : undefined },
    // Tags fold — selection-wide, on Feed too (tags are about the card, not position).
    { label: 'Tags', icon: 'i-tag', hidden: !taggable,
      sub: taggable ? tagEntries() : undefined },
    // ── How it sits on the board ──
    { sep: true, hidden: mobile && !lockable && !many },
    // Mirrored pair — front/back.
    { label: 'Bring to front', icon: 'i-front', accel: ']', hidden: !stackable, action: () => cmds!.raise() },
    { label: 'Send to back', icon: 'i-back', accel: '[', hidden: !stackable, action: () => cmds!.lower() },
    // Mirrored pair — Anchor until all locked, then Unanchor. Two rows (not
    // conditional icon) so tests/icons.test.js can grep for every icon literal.
    // "Anchor" not "Lock" — only geometry is fixed; stored key stays isLocked().
    { label: many ? 'Anchor these' : 'Anchor', icon: 'i-anchor', accel: 'L',
      hidden: !lockable || allLocked, action: () => cmds!.lockSelection(true) },
    { label: many ? 'Unanchor these' : 'Unanchor', icon: 'i-anchor-off', accel: 'L',
      hidden: !lockable || !allLocked, action: () => cmds!.lockSelection(false) },
    // Works on groups. Not on Feed — tile sizes are the packer's.
    { label: many ? `Reset ${count} sizes` : 'Reset size', icon: 'i-reset-size',
      hidden: mobile, action: () => cmds!.resetSize() },
    // Single-item — arranges contents of the fence under the cursor.
    { label: 'Rearrange fence', icon: 'i-rearrange',
      hidden: mobile || many || !cmds!.isFenceItem(id),
      action: () => cmds!.rearrangeFence(id) },
    { label: 'Nudge fence', icon: 'i-nudge',
      hidden: mobile || many || !cmds!.isFenceItem(id),
      action: () => cmds!.nudgeFence(id) },
    { label: 'Fit to contents', icon: 'i-fence',
      hidden: mobile || many || !cmds!.isFenceItem(id),
      action: () => cmds!.fitFence(id) },
    // Mirrored pair — a fence folds down to its name bar, its cards out of sight.
    { label: 'Roll up', icon: 'i-arrow-up', hidden: !fenceItem || rolled,
      action: () => cmds!.setFenceRolled(id, true) },
    { label: 'Roll down', icon: 'i-expand', hidden: !fenceItem || !rolled,
      action: () => cmds!.setFenceRolled(id, false) },
    // Group only — relays the selection about its own centre.
    { label: `Rearrange these ${count}`, icon: 'i-rearrange', hidden: !many,
      action: () => cmds!.rearrangeSelection() },
    // Group only — pushed apart where they stand, the rest of the board kept.
    { label: `Nudge these ${count}`, icon: 'i-nudge', hidden: mobile || !many,
      action: () => cmds!.nudgeSelection() },
    // Group only — eight alignment options stay in a fold to keep the menu short.
    // Canvas only: the Feed's column has no edges to line up.
    { label: 'Align & distribute', icon: 'i-align-center', hidden: mobile || !many,
      sub: alignDistributeEntries(id) },
    // Group only. Also reachable via rubber-band prompt — this covers shift-click
    // selections where there is no band. The Feed has no fences.
    { label: many ? `Fence these ${count}` : 'Fence it', icon: 'i-fence', accel: 'Ctrl G',
      hidden: mobile || (!many && cmds!.isFenceItem(id)),
      action: () => cmds!.fenceSelection() },
    // Every line touching the selection, gone in one step. Canvas only, where
    // lines are drawn; hidden when there are none to take.
    ...lineRemoval(mobile),
    // ── The board, from here ──
    { sep: true, hidden: mobile },
    // Feed has no "here" — the packer decides placement.
    { label: 'Add a note here', icon: 'i-pen', accel: 'N', hidden: mobile,
      action: () => cmds!.addNoteAt(at) },
    // Not on Feed — there the tile menu is the only menu, and a board action
    // on it reads as something done to the tile.
    { label: 'Reload board', icon: 'i-reload', hidden: mobile, action: () => cmds!.reload() },
    // ── Rename & delete ──
    // Rename at the foot — the last thing you do to a card you are keeping.
    // F2 accelerator for anyone who prefers the keyboard.
    { sep: true },
    { label: 'Rename', icon: 'i-rename', accel: 'F2', hidden: !renamable,
      action: rename ?? (() => editItemName(id)) },
    // A fence is not a card, and "Delete item" read as if it took its cards too.
    { label: !many && cmds!.isFenceItem(id) ? 'Remove fence' : `Delete ${what}`,
      icon: 'i-delete', accel: 'Del', danger: true,
      action: () => cmds!.deleteSelection() },
  ];
}

/** Align/distribute fold — six edges + two axes, one undo step each. */
/** Touch multi-select toggle. Only shown when a finger opened this menu (mouse
 * has Shift). Stays visible once the mode is on, regardless of pointer type.
 * `always` shows it to a mouse as well (sheetEntries). */
function multiSelectEntry(always = false): MenuEntry[] {
  const on = cmds!.multiSelect();
  if (!byTouch && !on && !always) return [];
  return [{
    label: on ? 'Done selecting' : 'Select multiple',
    icon: 'i-select-all',
    check: on,
    action: () => cmds!.toggleMultiSelect(),
  }];
}

/** "Remove its connections" / "Remove their N connections", or nothing. */
function lineRemoval(mobile: boolean): MenuEntry[] {
  const n = mobile ? 0 : cmds!.selectionLineCount();
  if (!n) return [];
  return [{
    label: n === 1 ? 'Remove its connection' : `Remove ${n} connections`,
    icon: 'i-connect',
    action: () => cmds!.removeSelectionConnections(),
  }];
}

/** The card menu's Select fold - see selectLike in commands.ts. */
function selectEntries(id: string, mobile: boolean): MenuEntry[] {
  return [
    { label: 'All like this', icon: 'i-select-all', action: () => cmds!.selectLike(id) },
    { label: 'What is in it', icon: 'i-fence',
      hidden: mobile || !cmds!.canSelectFenceContents(id), action: () => cmds!.selectFenceContents(id) },
    { label: 'What it is joined to', icon: 'i-connect',
      hidden: mobile || !cmds!.canSelectJoined(id), action: () => cmds!.selectJoined(id) },
  ];
}

function alignDistributeEntries(id: string): MenuEntry[] {
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
    { sep: true },
    // The card the menu was opened on is the measure - "make these like this one".
    // Pictures keep their proportion (matchSizeTargets in geometry.ts).
    { label: 'Same width', icon: 'i-same-width', action: () => cmds!.matchSizeSelection(id, 'w') },
    { label: 'Same height', icon: 'i-same-height', action: () => cmds!.matchSizeSelection(id, 'h') },
  ];
}

/** Connection editor. Direction/style as radio rows; label is prompted.
 * Each row files one undo step via setConnectionStyle. */
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
    // Colour/weight in a fold — otherwise this would be the longest menu in the app.
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

/** Sticker tint palette — names from the catalogue, indices reach items.css. */
/** Tag fold — all board tags (not just this item's), ticked where the selection
 * carries them. Counts shown; boardTags() sorts by usage. */
function tagEntries(): MenuEntry[] {
  const tags = cmds!.boardTags();
  const rows: MenuEntry[] = tags.map(({ tag, count }) => ({
    label: `${tag}  (${count})`,
    icon: 'i-tag',
    check: cmds!.selectionHasTag(tag),
    action: () => cmds!.toggleSelectionTag(tag),
  }));
  // Separator only when there are tags above it.
  if (rows.length) rows.push({ sep: true });
  rows.push({ label: 'New tag…', icon: 'i-plus', action: () => cmds!.addTag() });
  return rows;
}

/** Filter fold — all tags, ticked where filtering. Footer shows count and a
 * "show everything" escape so the user never gets lost in a filter. */
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

/** Fence colour — None for the plain well, then the four note sheets under the
 *  names the Note flyout gives them (noteEntries() in ui/flyout.ts). */
const SHEET_NAMES = ['Warm', 'Accent', 'Green', 'Pale'];

function fenceTintEntries(id: string): MenuEntry[] {
  const now = cmds!.fenceTintOf(id);
  const NAMES = SHEET_NAMES;
  return [
    // The icon is for rows drawn without a chip; the chip takes its column.
    { label: 'None', icon: 'i-swatch', swatch: 'var(--paper-2)', check: now === 0,
      action: () => cmds!.setFenceTint(id, 0) },
    ...NAMES.map((label, i) => ({
      label,
      icon: 'i-swatch',
      swatch: `var(--note-${i + 1})`,
      check: now === i + 1,
      action: () => cmds!.setFenceTint(id, i + 1),
    })),
  ];
}

/** A note's sheet - the four the fence row offers, without its None. */
function noteTintEntries(id: string): MenuEntry[] {
  const now = cmds!.noteTintOf(id);
  return SHEET_NAMES.map((label, i) => ({
    label,
    icon: 'i-swatch',
    swatch: `var(--note-${i + 1})`,
    check: now === i + 1,
    action: () => cmds!.setNoteTint(id, i + 1),
  }));
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

/** Connection colour palette. Names map to canvas.css rules, not raw values. */
function connectionColorEntries(conn: { a: string, b: string }, color: string): MenuEntry[] {
  const set = (patch: ConnMeta) => cmds!.setConnectionStyle(conn.a, conn.b, patch);
  // Typed as ConnColor so a misspelled name is caught at compile time.
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

/** Tour menu — next/prev/first/fit/end. Steps are greyed at the ends (not
 * hidden) so the layout stays stable. "Show the whole board" does not end
 * the tour. */
function tourEntries(): MenuEntry[] {
  const at = cmds!.tourAt();
  const last = cmds!.tourLength() - 1;
  return [
    { label: 'The next stop', icon: 'i-chevron-right', accel: 'Right',
      disabled: at >= last, action: () => cmds!.tourStep(1) },
    { label: 'The stop before', icon: 'i-chevron-left', accel: 'Left',
      disabled: at <= 0, action: () => cmds!.tourStep(-1) },
    { sep: true },
    { label: 'Back to the first stop', icon: 'i-home',
      disabled: at <= 0, action: () => cmds!.tourGo(0) },
    { label: 'Show the whole board', icon: 'i-fit', action: () => cmds!.fit() },
    { sep: true },
    { label: 'End the tour', icon: 'i-close', accel: 'Esc', action: () => cmds!.tourStop() },
  ];
}

function canvasEntries(at: Point): MenuEntry[] {
  // Inside a fence, Rearrange targets that fence; on empty ground, the board.
  // Only rows that reach something no toolbar button can (a point, a scope).
  const fence = cmds!.fenceUnder(at);
  return [
    // Paste needs bare-ground access (the cursor is where it lands). Hidden on empty clipboard.
    { label: 'Paste', icon: 'i-paste', accel: 'Ctrl V', hidden: !cmds!.canPaste(),
      action: () => cmds!.paste(at) },
    { label: 'Select all', icon: 'i-select-all', accel: 'Ctrl A',
      action: () => cmds!.selectAll() },
    // Touch multi-select — see multiSelectEntry.
    ...multiSelectEntry(),
    // Filter count in the label so the state is visible without opening the fold.
    { label: cmds!.hasTagFilter() ? `Filter by tag (${cmds!.tagFilter().length})` : 'Filter by tag',
      icon: 'i-tag', check: cmds!.hasTagFilter() || undefined, sub: filterEntries() },
    // One row, two scopes — `at` picks between fence and board. Never both.
    fence
      ? { label: 'Rearrange fence', icon: 'i-rearrange',
        action: () => cmds!.rearrangeFence(fence) }
      : { label: 'Rearrange board', icon: 'i-rearrange',
        action: () => cmds!.rearrange() },
    // The same switch as Rearrange: inside a fence, that fence's contents.
    fence
      ? { label: 'Nudge fence', icon: 'i-nudge', action: () => cmds!.nudgeFence(fence) }
      : { label: 'Nudge board', icon: 'i-nudge', action: () => cmds!.nudgeBoard() },
    { label: 'Reload board', icon: 'i-reload', action: () => cmds!.reload() },
    { sep: true },
    // Board marks — tick on the trailing edge shows current state.
    { label: 'Snap to grid', icon: 'i-snap', check: cmds!.settingOn('snap'),
      action: () => cmds!.toggleSetting('snap') },
    { label: 'Show grid', icon: 'i-grid', check: cmds!.settingOn('grid'),
      action: () => cmds!.toggleSetting('grid') },
  ];
}

/**
 * The Feed's and the Playlist's menu off any card: the rows of canvasEntries()
 * a list can show. The tag filter and Rearrange act on what only the canvas
 * draws (a dimmed card, a position), so they stay there. Select all is the
 * surface's own, because the board holds cards the list does not show (the
 * title, the stickers, every card but the tracks) and a group it cannot see
 * is a group a Delete takes by surprise. The pick mode is offered to a mouse
 * too: off a card there is no Shift-click to reach for instead.
 */
function sheetEntries(selectAll?: () => void): MenuEntry[] {
  return [
    { label: 'Paste', icon: 'i-paste', accel: 'Ctrl V', hidden: !cmds!.canPaste(),
      action: () => cmds!.paste(null) },
    { label: 'Select all', icon: 'i-select-all', hidden: !selectAll, action: () => selectAll?.() },
    ...multiSelectEntry(true),
    { sep: true },
    { label: 'Reload board', icon: 'i-reload', action: () => cmds!.reload() },
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Replace menu contents in place (drill-down). Same anchor, no focus hand-back. */
function swap(entries: MenuEntry[]) {
  // Inherit focus state from the outgoing page.
  const held = !!node && node.contains(document.activeElement);
  // Close child first or it outlives its parent as an orphaned panel.
  closeChild(false);
  // Removed outright (no exit animation) — a page turn must not flinch.
  if (node) { node.remove(); node = null; }
  render(entries, lastX, lastY, { ...lastOpts, focus: lastOpts.focus || held, instant: true });
}

/** A child menu, fronted by the row that walks back to its parent. */
function subMenu(sub: MenuEntry[], parent: MenuEntry[]): MenuEntry[] {
  return [{ label: 'Back', icon: 'i-chevron-left', to: parent }, { sep: true }, ...sub];
}

/** Append inside the topmost modal (top layer beats z-index) or the body.
 * Fixes: panel visible over backdrop, focus allowed inside modal, focusout
 * guard sees the menu as inside the dialog. */
function panelHost(): HTMLElement {
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  // Last opened = topmost; document order is the best proxy.
  for (let i = open.length - 1; i >= 0; i--) {
    // :modal may throw on old engines — treat unknown as modal (safe fallback).
    try { if (open[i].matches(':modal')) return open[i]; } catch { return open[i]; }
  }
  return document.body;
}

function render(entries: MenuEntry[], clientX: number, clientY: number, opts: MenuOpts = {}) {
  // Single entry point — flush any animating-out panels to keep one #ctx-menu.
  flushLeaving();
  lastX = clientX;
  lastY = clientY;
  lastOpts = opts;
  node = document.createElement('div');
  node.id = 'ctx-menu';
  if (opts.instant || byKeys) node.classList.add('is-instant');
  node.setAttribute('role', 'menu');
  node.setAttribute('aria-label', opts.label || 'Board actions');
  // Focusable but not tabbable — screen reader announces it, Escape has a target.
  node.tabIndex = -1;

  fillPanel(node, entries);

  // Measure hidden, then place. max-height in menu.css caps tall menus to scroll.
  node.style.visibility = 'hidden';
  placeRoot(node, clientX, clientY, opts);
  // Opened under a press: follow it. A page turn happens on a release, so it
  // never inherits one.
  press = down ? { ...down, at: performance.now(), moved: false } : null;
}

/** Fill a panel (root or child) with entry rows. Shared so the hover submenu
 * uses the same row builder — one implementation for all menus. */
function fillPanel(panel: HTMLElement, entries: MenuEntry[]) {
  for (const entry of entries) {
    if (entry.hidden) continue;
    if (entry.sep) {
      // Rows hidden between two rules would leave them touching: one is enough,
      // and none is wanted at the top.
      const prev = panel.lastElementChild;
      if (!prev || prev.classList.contains('ctx-sep')) continue;
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      panel.append(hr);
      continue;
    }
    // Slider row — stays put on drag (not in the arrow-key walk, does not close).
    if (entry.range) {
      panel.append(rangeRow(entry));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.className = 'ctx-item';
    if (entry.danger) btn.classList.add('is-danger');
    // `disabled` stops the press; arrow-key walk skips it (cannot take focus).
    if (entry.disabled) { btn.disabled = true; btn.classList.add('is-inert'); }
    if (entry.check != null) {
      btn.classList.toggle('is-checked', !!entry.check);
      btn.setAttribute('role', 'menuitemcheckbox');
      btn.setAttribute('aria-checked', String(!!entry.check));
    }

    // Icon column (first of three). A swatch takes this column instead when the
    // row's subject is a colour.
    if (entry.swatch) btn.append(chip(entry.swatch));
    else if (entry.icon) btn.append(icon(entry.icon));

    const label = document.createElement('span');
    // Asserted — separator and slider (handled above) are the only label-less rows.
    label.textContent = entry.label!;
    if (entry.font) label.style.fontFamily = entry.font;
    btn.append(label);

    if (entry.accel) {
      const accel = document.createElement('kbd');
      accel.textContent = entry.accel;
      btn.append(accel);
    }
    // Tick on the trailing edge (where accel keys sit), drawn from the icon sprite.
    if (entry.check != null) btn.append(icon('i-check', 'ctx-tick'));
    // Trailing specimen — see MenuEntry.swatchEnd.
    if (entry.swatchEnd) btn.append(chip(entry.swatchEnd, 'ctx-chip is-end'));
    // sub = child menu in place; to = Back to parent; else = action + close.
    if (entry.sub || entry.to) {
      btn.setAttribute('aria-haspopup', 'menu');
      if (entry.sub) btn.append(icon('i-chevron-right', 'ctx-chevron'));
      btn.addEventListener('click', e => {
        // If this row's child is already open (from hover), a pointer click is
        // a no-op — the user can already see the list. Keyboard (detail === 0)
        // always drills in, since the child may not be visible.
        const byKey = e.detail === 0;
        if (entry.sub && child && childRow === btn && !byKey) return;
        // Sound only when something actually happens.
        cue('pick');
        swap(entry.sub ? subMenu(entry.sub, entries) : entry.to!);
      });
      // Hover also opens the child — click is kept for touch/keyboard. From
      // nothing open it waits a beat, so a pointer running down the menu does
      // not pop every fold it crosses; from another fold it swaps at once, with
      // no entrance, since one panel replacing another has nowhere to arrive from.
      if (entry.sub) {
        btn.addEventListener('pointerenter', e => {
          if (e.pointerType !== 'mouse') return;
          clearTimeout(dwellTimer);
          if (child) { openChild(btn, entry.sub!, panel, entry.label, childRow !== btn); return; }
          dwellTimer = setTimeout(() => {
            if (btn.isConnected) openChild(btn, entry.sub!, panel, entry.label);
          }, DWELL_MS);
        });
        btn.addEventListener('pointerleave', () => clearTimeout(dwellTimer));
      }
    } else {
      // Hovering past a fold's row closes its child (only from the parent
      // panel) - unless the pointer is crossing it on the way to the child,
      // where the row's grace decides instead.
      btn.addEventListener('pointerenter', e => {
        if (e.pointerType !== 'mouse' || childFrom !== panel) return;
        if (aimingAtChild(e.clientX, e.clientY)) return;
        closeChild();
      });
      btn.addEventListener('click', () => {
        close();
        // Cue before the action so both sounds play (press + result).
        cue('pick');
        // This branch is all action rows — sep/slider/fold/back handled above.
        entry.action!();
      });
    }
    panel.append(btn);
  }
  // Nor at the foot.
  if (panel.lastElementChild?.classList.contains('ctx-sep')) panel.lastElementChild.remove();
}

// ---------------------------------------------------------------------------
// The child panel
// ---------------------------------------------------------------------------

/** Hover submenu beside its row. Same rows via fillPanel(), same CSS rules.
 * Drill-down (swap) stays for touch/keyboard. Close is deferred by
 * CHILD_GRACE_MS so the pointer can cross the gap between panels. */
let child: HTMLElement | null = null;
/** The panel a live child was opened from - see the pointerenter above. */
let childFrom: HTMLElement | null = null;
/** The row it belongs to, so a re-hover of the same row is not a re-open. */
let childRow: HTMLElement | null = null;
let childTimer = 0;
/** Where the pointer left the open child's row: the apex of the aim triangle. */
let leftAt: { x: number, y: number } | null = null;

/** How long the pointer may be over neither panel before the child gives up. */
const CHILD_GRACE_MS = 220;

/** How long a fold row is hovered before its child opens from a closed state:
 *  long enough to pass over, short enough to read as a response (macOS). */
const DWELL_MS = 90;
let dwellTimer = 0;

/** `animate` false for page turns (swap) — no exit animation on drill-down. */
function closeChild(animate = true) {
  clearTimeout(childTimer);
  childTimer = 0;
  clearTimeout(dwellTimer);
  if (child) {
    if (animate) dismiss(child); else child.remove();
  }
  child = null;
  childFrom = null;
  childRow?.classList.remove('is-open');
  childRow = null;
  leftAt = null;
}

/** Let go of the child after the grace period, unless something asks again. */
function fadeChild() {
  clearTimeout(childTimer);
  // Wrapped — closeChild has a defaulted arg; bare ref would break if setTimeout changed.
  childTimer = setTimeout(() => closeChild(), CHILD_GRACE_MS);
}

/** The pointer left the child's row: remember where, then start the grace. */
function onRowLeave(e: PointerEvent) {
  leftAt = { x: e.clientX, y: e.clientY };
  fadeChild();
}

/**
 * Whether a point lies between where the pointer left the row and the near
 * edge of the child - the pointer on its way there, as macOS reads it. The
 * child is top-aligned with its row, so reaching its lower rows means crossing
 * the siblings below the fold, and each used to close it on contact.
 */
function aimingAtChild(x: number, y: number): boolean {
  if (!child || !leftAt) return false;
  const c = child.getBoundingClientRect();
  const nearX = c.left >= leftAt.x ? c.left : c.right;
  const a = leftAt;
  const b = { x: nearX, y: c.top - 8 };
  const d = { x: nearX, y: c.bottom + 8 };
  const side = (p: { x: number, y: number }, q: { x: number, y: number }) =>
    (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
  const s1 = side(a, b), s2 = side(b, d), s3 = side(d, a);
  return !((s1 < 0 || s2 < 0 || s3 < 0) && (s1 > 0 || s2 > 0 || s3 > 0));
}

/** `instant` for a swap from another open fold: the old one goes and the new one
 *  is there, with no exit or entrance between them (.is-instant, menu.css). */
function openChild(row: HTMLElement, entries: MenuEntry[], from: HTMLElement, label?: string, instant = false) {
  // Pointer came back within grace period — cancel the close, not a reopen.
  if (childRow === row && child) { clearTimeout(childTimer); childTimer = 0; return; }
  closeChild(!instant);
  // Grace period can leave a child animating out while a new one opens — flush it.
  flushLeaving();
  child = document.createElement('div');
  child.id = 'ctx-child';
  child.setAttribute('role', 'menu');
  // Entry label, not row text — row may include a <kbd> accelerator.
  child.setAttribute('aria-label', label || row.textContent?.trim() || 'More');
  child.tabIndex = -1;
  if (instant) child.classList.add('is-instant');
  fillPanel(child, entries);
  child.style.visibility = 'hidden';
  panelHost().append(child);

  const pad = 8;
  const r = row.getBoundingClientRect();
  const box = child.getBoundingClientRect();
  // Overlap parent padding so the two read as one hinged object.
  const parent = from.getBoundingClientRect();
  const right = parent.right - 4;
  // Flip left only when there is no room on the right.
  const x = right + box.width + pad > innerWidth
    ? Math.max(pad, parent.left - box.width + 4)
    : right;
  // Top-aligned with its row, clamped to fit the window.
  const y = Math.max(pad, Math.min(r.top - 5, innerHeight - box.height - pad));
  child.style.left = `${Math.round(x)}px`;
  child.style.top = `${Math.round(y)}px`;
  // Flipped to the parent's left: it slides out leftwards, away from its row.
  child.classList.toggle('is-left', x !== right);
  // Grow from the edge nearest the parent, vertically from the row's centre.
  child.style.transformOrigin =
    originPercent((x === right ? 0 : box.width) , box.width) + ' ' +
    originPercent((r.top + r.bottom) / 2 - y, box.height);
  child.style.visibility = '';

  childRow = row;
  childFrom = from;
  row.classList.add('is-open');
  row.addEventListener('pointerleave', onRowLeave);
  child.addEventListener('pointerenter', () => { clearTimeout(childTimer); childTimer = 0; });
  child.addEventListener('pointerleave', fadeChild);
}

/** Offset as clamped %. Clamp keeps origin inside the box even when the anchor
 * is outside (pushed to fit). Zero extent returns 0 (not NaN). */
const originPercent = (offset: number, extent: number) =>
  (extent > 0 ? Math.round(Math.max(0, Math.min(100, (offset / extent) * 100))) : 0) + '%';

/** Where the root panel goes, once its rows are in and it can be measured. */
function placeRoot(node: HTMLElement, clientX: number, clientY: number, opts: MenuOpts) {
  const pad = 8;
  // Max-height from anchor room, not --toolbar-h, so bottom-bar menus cap correctly.
  // Set before measurement or the flip reads the uncapped height.
  if (opts.anchor) {
    const room = Math.max(innerHeight - opts.anchor.bottom, opts.anchor.top) - pad * 2;
    node.style.maxHeight = `${Math.max(120, Math.round(room))}px`;
  }
  panelHost().append(node);
  const { width, height } = node.getBoundingClientRect();
  let x, y;
  if (opts.anchor) {
    // Clamp, not flip: a flyout on the far side of its button would close on entry.
    // Intersect bar bounds with viewport. max(lo, hi) degrades gracefully when panel > container.
    const bounds = opts.anchor.bounds;
    const lo = Math.max(pad, Math.min(bounds ? bounds.left : pad, innerWidth - width - pad));
    const hi = Math.min(bounds ? bounds.right - width : Infinity, innerWidth - width - pad);
    x = Math.min(Math.max(lo, clientX), Math.max(lo, hi));
    // Flip above when below won't fit (bottom-bar menus need this).
    // Flip about the anchor box, not clientY — panel stays adjacent to its button.
    const above = opts.anchor.top - height - pad;
    const up = clientY + height + pad > innerHeight && above >= pad;
    y = up ? above : clientY;
    // One panel shape regardless of flip direction — see menu.css.
  } else {
    // Flip, not clamp: a menu pinned to the edge lands under the cursor.
    x = clientX + width + pad > innerWidth ? Math.max(pad, clientX - width) : clientX;
    y = clientY + height + pad > innerHeight ? Math.max(pad, clientY - height) : clientY;
  }
  node.style.left = Math.round(x) + 'px';
  node.style.top = Math.round(y) + 'px';
  // Above its anchor, the entrance's few pixels of travel run the other way,
  // so the panel still comes out of its button rather than into it.
  node.classList.toggle('is-above', y < (opts.anchor ? opts.anchor.top : clientY));
  // Grow from the anchor (centre x, attached edge). Computed after the flip.
  // Set via script, not style=, because style-src has no unsafe-inline.
  const srcX = opts.anchor ? (opts.anchor.left + opts.anchor.right) / 2 : clientX;
  const srcY = opts.anchor ? (y < opts.anchor.top ? opts.anchor.top : opts.anchor.bottom) : clientY;
  node.style.transformOrigin = originPercent(srcX - x, width) + ' ' + originPercent(srcY - y, height);
  node.style.visibility = '';
  // Hover menus must not take focus — see openAnchored.
  if (opts.focus !== false) node.focus({ preventScroll: true });
}

/** Slider row. <label> not menuitem — keeps arrow keys on the slider, not the menu walk. */
function rangeRow(entry: MenuEntry) {
  // Asserted: the only caller is render(), on the branch that just tested it.
  const { min, max, step, unit = '', get, set } = entry.range!;
  const row = document.createElement('label');
  row.className = 'ctx-range';

  const name = document.createElement('span');
  // Every row must have a visible label.
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

  tickSlider(slider);
  slider.addEventListener('input', () => {
    read.textContent = slider.value + unit;
    set(Number(slider.value));
  });
  return row;
}

/** Colour chip in the icon column. Background, not SVG — the actual colour matters, not the shape. */
function chip(color: string | string[], className = 'ctx-chip') {
  const dot = document.createElement('span');
  dot.className = className;
  // Multiple colours: hard-stop gradient bands instead of child elements.
  if (Array.isArray(color)) {
    const step = 100 / color.length;
    const stops = color.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`);
    dot.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  } else {
    dot.style.background = color;
  }
  return dot;
}

/** SVG icon from icons.svg. createElementNS required — innerHTML would parse into HTML namespace.
 * Exported: fence-prompt.ts reuses menu icons for the same actions. */
export function icon(name: string, extra?: string) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', extra ? `ico ${extra}` : 'ico');
  // Label already names it — icon announcing itself would double-speak.
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
