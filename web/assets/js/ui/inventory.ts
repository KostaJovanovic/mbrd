// What is in this board, and what it weighs.
//
// `.mbrd` files get heavy and nothing in the app would say why. The optimizer
// has existed for a while and works, and it is a button you have to already
// know about - there is nowhere that gives you a *reason* to press it. *This
// photograph is 12 MB* is that reason, so the two sit together: this sheet
// reports, and hands off to Optimize.
//
// It is now the only way to Optimize from the settings panel. The standalone
// row that used to sit under this one is gone, on the argument this module was
// written to make: the button is worth pressing when you have just been told
// what it is for, and two doors into it - one of them beside the room that
// explains it - was the same offer made twice, once without the explanation.
// `cmds.optimize` is untouched, so the console still has it.
//
// ── A report, not a setting ──
//
// Which is why it is a sheet beside ui/credits.ts rather than a section in
// ui/settings-schema.ts. That schema is for things that change the app; every
// row in it is a control with a value. Nothing here has a value - it is the
// board described back to you - and a panel section full of read-only rows
// would be the first thing in that schema that is not a setting.
//
// ── Two rules it may not break ──
//
// **Sizes come from the stored blobs, never from re-reading an original.** An
// Asset carries `size`, which is the blob's own length, so the whole report is
// arithmetic over a Map that is already in memory.
//
// **Building the report may not decode an image.** That is the load-bearing
// one. A board with two thousand cards is exactly the board somebody opens
// this on, and a panel that measured pictures by decoding them would stall the
// tab at the precise moment the question was being asked - turning the tool
// for diagnosing a heavy board into another reason it feels heavy. So there
// are no thumbnails: the list is a name, a kind and a number, and it costs one
// pass over a Map however heavy the board is.
//
// It used to say *nothing here may decode an image*, full stop, and the peek
// below is the deliberate narrowing of that. Hovering one row draws one
// picture, on demand, after the report is already on screen - it is bounded by
// the pointer rather than by the size of the board, which is the property the
// rule was protecting. The URL it draws is assetURL()'s own cached one, the
// same object URL the card on the board is already using, so a peek mints
// nothing that was not going to exist and there is nothing here to revoke: the
// registry revokes the lot on pagehide.
//
// ── A row is a way to the card ──
//
// The rows are *files, by content hash*, and cards are what somebody can
// actually go and look at - one file can be under several cards and an orphan
// is under none. So the report carries the ids using each hash, and a row with
// a card behind it is a button that goes to the first of them - saying how many
// there are when there is more than one, because a file under three cards is
// also a file that deleting one card frees nothing of. A row with no card is
// not a button at all: an orphan has nothing to show, and a control that greys
// or does nothing would be the report offering to take somebody somewhere that
// is not there.
//
// ── "Unreferenced" has three meanings, and they all count ──
//
// An asset is unreferenced when nothing on the live board, nothing in the bin,
// and **no step of the history** points at it. The third is the one that is
// easy to forget: a step names cards the board no longer has, which is the
// whole of what a step is for, so an asset only a step wants is live.
//
// The orphan list is reported and **not** offered for deletion. That was a
// decision taken when the union had two members - on the grounds that a *remove
// unused* button written against a two-class union would become a data-loss bug
// the day a third class arrived - and a third class then arrived, twice over,
// in the two batches after it. The button would have been wrong for exactly the
// predicted reason. It stays a report.

import { board, byId, select, timelineHashes } from '../state.ts';
import { cue } from '../cuelume/engine.ts';
import { allAssets, assetURL, getAsset } from '../storage/assets.ts';
import { travelMs } from '../canvas/viewport.ts';
import { itemHashes, el, clamp, formatBytes } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';

/** One asset, as this sheet talks about it. */
export type InventoryAsset = {
  hash: string;
  name: string;
  ext: string;
  bytes: number;
  /** Nothing on the board or in the bin points at this one. */
  orphan: boolean;
  /**
   * The live cards using this file, in board order.
   *
   * Live only: a card in the bin keeps the file off the orphan list, which is
   * the whole point of the bin, but there is nowhere to fly to for one. Nor is
   * a step of the history a place - it is a moment. So this is the narrower of
   * the two questions the report asks about a hash, and both are asked in the
   * same pass.
   */
  cards: string[];
};

export type Inventory = {
  /** How many cards of each kind, biggest count first. */
  kinds: { type: string; count: number }[];
  items: number;
  binned: number;
  /** Every stored blob, and what they add up to. */
  bytes: number;
  assets: number;
  /** The heaviest first, capped - see TOP. */
  largest: InventoryAsset[];
  orphans: { count: number; bytes: number };
};

/** How many of the heaviest to name. */
const TOP = 10;

/**
 * The whole report, as arithmetic over what is already in memory.
 *
 * Pure and exported so it can be tested without a document - the sheet below
 * touches `document` inside its own call, but this does not touch it at all.
 */
export function boardInventory(): Inventory {
  // The reference union, and it is the same one packBoard() writes with: a card
  // in the bin still owns its bytes, because the whole point of the bin is that
  // the card can come back.
  const referenced = new Set<string>();
  // The live half of the union is walked into a map rather than a set, because
  // the sheet's jump needs to know *which* card and not only that there is
  // one. Same walk, one more line, and no second pass over the items.
  const users = new Map<string, string[]>();
  for (const item of board.items) {
    for (const h of itemHashes(item)) {
      referenced.add(h);
      const list = users.get(h);
      if (list) list.push(item.id);
      else users.set(h, [item.id]);
    }
  }
  for (const t of board.trash) for (const h of itemHashes(t.item)) referenced.add(h);
  // And the third. Asked of timeline.js, which owns the shape of a step, rather
  // than walked here - a second copy of that walk is exactly how the two would
  // come to disagree about what is rubbish. Called with no argument, so it
  // reads the live ledger rather than a document: this sheet is a report on the
  // session in front of the reader, not on a file. Getting it wrong would not
  // delete anything; it would list somebody's history as rubbish.
  for (const h of timelineHashes()) referenced.add(h);

  const counts = new Map<string, number>();
  for (const item of board.items) {
    counts.set(item.type, (counts.get(item.type) || 0) + 1);
  }

  let bytes = 0;
  let orphanBytes = 0;
  let orphanCount = 0;
  const all: InventoryAsset[] = [];
  for (const [hash, asset] of allAssets()) {
    const orphan = !referenced.has(hash);
    bytes += asset.size;
    if (orphan) { orphanCount++; orphanBytes += asset.size; }
    all.push({
      hash,
      name: asset.name || '',
      ext: asset.ext || '',
      bytes: asset.size,
      orphan,
      cards: users.get(hash) || [],
    });
  }
  // Sorted by weight, then by hash so the order is stable between two opens of
  // an unchanged board - two assets of identical size would otherwise swap
  // places on the whim of Map iteration order.
  all.sort((a, b) => b.bytes - a.bytes || (a.hash < b.hash ? -1 : 1));

  return {
    kinds: [...counts].map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
    items: board.items.length,
    binned: board.trash.length,
    bytes,
    assets: all.length,
    largest: all.slice(0, TOP),
    orphans: { count: orphanCount, bytes: orphanBytes },
  };
}

// Bytes are written by util.ts's formatBytes, not by one of this module's own.
// It was written twice for about ten minutes - the second one decimal, on the
// argument that a file manager says 12 MB for 12,000,000 bytes and this number
// gets compared against one. That argument is fine and it is not worth two
// spellings of a size inside one app: the trash panel and the optimiser already
// say binary, and a sheet that disagreed with the panel two rows away about how
// big the same picture is would be a worse fault than either convention.

/** The plural of a card kind, for the counts row. */
function kindLabel(type: string, count: number): string {
  const one: Record<string, string> = {
    image: 'picture', video: 'clip', audio: 'sound', note: 'note',
    text: 'text file', link: 'link', model: 'model', embed: 'embed',
    sticker: 'sticker', fence: 'fence', title: 'title card', ghost: 'hint',
    generic: 'file',
  };
  const word = one[type] || type;
  return count === 1 ? word : `${word}s`;
}

// Wired on first open rather than at init - the same bargain ui/credits.ts
// makes, and for the same reason: two listeners on a sheet most sessions never
// open do not need to exist before it is asked for.
let wired = false;

/** The inventory sheet, or null on a page that does not carry one. */
// SAFETY: #inventory is a <dialog> in index.html. The null is kept and every
// caller either duck-types showModal() before using it or reaches it through
// `?.`, so a page without the sheet - the changelog, a stripped build - gets a
// no-op rather than a throw.
const sheetEl = () => el('inventory') as HTMLDialogElement | null;

/**
 * The camera, handed in rather than imported, the same shape ui/search.ts
 * takes it in.
 *
 * The sheet needed nothing at all until a row became a way to the card - it
 * read the board and the asset store and was opened by id, which is what the
 * head of ui/viewer.ts says about itself and what this module used to be able
 * to say. Flying somewhere is the one thing that cannot be done without the
 * viewport, and a module-scope import of the live one does not exist: there is
 * one Viewport and main.ts owns it.
 *
 * Null until then, and every use below is optional-chained, so a report opened
 * before the wiring still reports and simply does not fly.
 */
let vp: Viewport | null = null;

export function initInventory(viewport: Viewport): void { vp = viewport; }

/** Open the inventory sheet. Idempotent; safe without a document. */
export function openInventory(): void {
  if (typeof document === 'undefined') return;
  const dlg = sheetEl();
  // The duck type is the runtime half of the claim that this is a <dialog> in
  // index.html, and is what makes a browser without one fall out here rather
  // than throw. Same shape as openCredits().
  if (!dlg || typeof dlg.showModal !== 'function') return;

  const body = el('inventory-body');
  if (body) body.replaceChildren(...report(boardInventory()));

  if (!wired) {
    wired = true;
    // Click outside to close: the sheet fills its own dialog, so a press whose
    // target is the dialog itself landed on the backdrop. Same test dialog.ts
    // and credits.ts make.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('inventory-close')?.addEventListener('click', () => { cue('pick'); dlg.close(); });
    // Escape closes a modal dialog without any of the buttons above being
    // pressed, and a peek is a fixed box that would be left hanging over the
    // board with nothing under it. `close` catches every way out at once.
    dlg.addEventListener('close', hidePeek);
    // Wired by hand, and *not* left to the app's delegated data-cmd listener,
    // which is the trap this button walked into first. That listener is bound to
    // the sidebar, and a <dialog> is in the top layer and is not inside it - so
    // a data-cmd in here looks exactly like every other button in the app and
    // does nothing at all. The same dynamic import cmds.optimize uses, so the
    // optimiser is still not loaded until somebody asks for it.
    //
    // The sheet closes first. The optimiser raises its own progress and its own
    // result, and both would land behind a modal that is still up.
    el('inventory-optimize')?.addEventListener('click', () => {
      cue('pick');
      dlg.close();
      void import('../optimize/ui.ts').then(m => m.optimizeBoard());
    });
  }
  if (!dlg.open) dlg.showModal();
}

/**
 * The sheet's contents, built through createElement.
 *
 * No innerHTML anywhere, which here is not about a foreign document - every
 * string in this report came out of this app - but about the rule holding
 * everywhere rather than in the places somebody remembered. A file name is the
 * one thing in here that a stranger wrote, and it arrives on a `.mbrd`.
 */
function report(inv: Inventory): HTMLElement[] {
  const out: HTMLElement[] = [];

  out.push(line('inv-total', `${formatBytes(inv.bytes)} in ${inv.assets} `
    + `${inv.assets === 1 ? 'file' : 'files'}`));

  const kinds = inv.kinds.map(k => `${k.count} ${kindLabel(k.type, k.count)}`).join(', ');
  out.push(line('inv-kinds', kinds || 'Nothing on this board yet'));

  if (inv.binned) {
    out.push(line('inv-binned',
      `${inv.binned} in the bin, still carrying ${inv.binned === 1 ? 'its' : 'their'} bytes`));
  }

  if (inv.largest.length) {
    out.push(heading('The heaviest'));
    const list = document.createElement('ul');
    list.className = 'inv-list';
    for (const asset of inv.largest) list.append(assetRow(asset));
    out.push(list);
  }

  if (inv.orphans.count) {
    // Reported, never offered for deletion. See the head of this file for why,
    // and read it before adding a button here.
    out.push(line('inv-orphans',
      `${inv.orphans.count} stored ${inv.orphans.count === 1 ? 'file is' : 'files are'} `
      + `no longer used by any card - ${formatBytes(inv.orphans.bytes)}. `
      + 'They are dropped the next time this board is saved to a file.'));
  }

  return out;
}

/**
 * One file, as a row: what it is called, how many cards want it, what it
 * weighs - and, when a card wants it, a way to go there.
 *
 * The control is the whole row rather than a chevron at the end of it, because
 * a row that does something and a row that does not have to be told apart at a
 * glance, and a hit target the width of the sheet is the version of that which
 * also works with a thumb.
 */
function assetRow(asset: InventoryAsset): HTMLElement {
  const row = document.createElement('li');
  row.className = 'inv-row';
  if (asset.orphan) row.dataset.orphan = '';

  const name = document.createElement('span');
  name.className = 'inv-name';
  // The stored name, else the extension, else the first of the hash - a
  // pasted picture has no filename and a row reading "" is a row that looks
  // broken rather than one that says there was never a name.
  name.textContent = asset.name || (asset.ext ? `.${asset.ext}` : asset.hash.slice(0, 8));
  const size = document.createElement('span');
  size.className = 'inv-size';
  size.textContent = formatBytes(asset.bytes);

  const to = asset.cards[0];
  if (!to) {
    const still = document.createElement('div');
    still.className = 'inv-line';
    still.append(name, size);
    row.append(still);
    return row;
  }

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'inv-line';
  go.append(name);
  // The count is drawn only when it is news. "used by 1" on nine rows out of
  // ten is a column of noise that makes the one row saying 3 harder to see,
  // which is the opposite of what a badge is for.
  if (asset.cards.length > 1) {
    const used = document.createElement('span');
    used.className = 'inv-used';
    used.textContent = `used by ${asset.cards.length}`;
    go.append(used);
  }
  go.append(size);
  go.title = asset.cards.length > 1
    ? `Go to the first of ${asset.cards.length} cards using this file`
    : 'Go to the card using this file';
  go.addEventListener('click', () => { cue('pick'); jump(to); });
  // Only a picture has anything to show. A clip's own bytes are not an image
  // and the still that stands in for it is a different row of this report, so
  // a video row goes somewhere and shows nothing on the way.
  if (getAsset(asset.hash)?.mime.startsWith('image/')) {
    go.addEventListener('pointerenter', () => showPeek(go, asset.hash));
    go.addEventListener('pointerleave', hidePeek);
    // And by keyboard, because the row is a button and a button is arrived at
    // by Tab as often as by pointer.
    go.addEventListener('focus', () => showPeek(go, asset.hash));
    go.addEventListener('blur', hidePeek);
  }
  row.append(go);
  return row;
}

/**
 * Take the row: select the card and fly to it.
 *
 * The sheet closes first, and not as a tidiness - it is a modal, so the flight
 * would land behind it and the backdrop would be the only thing anybody saw
 * move.
 *
 * byId() after the close rather than the item captured when the report was
 * built, for the reason ui/search.ts gives about the same two lines: a board
 * can change between the sheet opening and a row being pressed, and a row that
 * no longer names anything should do nothing rather than throw.
 */
function jump(id: string): void {
  hidePeek();
  sheetEl()?.close();
  const item = byId(id);
  if (!item) return;
  select([id]);
  vp?.fit([item], 120, travelMs());
}

// ── The peek ──────────────────────────────────────────────────────────────
//
// One box, made on the first hover and kept, so moving down a list of ten rows
// is ten src assignments and not ten elements. It lives inside the <dialog>
// on purpose: a modal dialog is in the top layer and its backdrop paints over
// everything that is not, so a peek appended to <body> would be a picture
// behind a tinted sheet of glass.
//
// Its box is square and the picture is contained inside it, which is what lets
// the placement below be arithmetic on one number instead of a measurement
// that is only correct after the image has loaded.

/** The peek's side, in px. Must agree with .inv-peek in dialog.css. */
const PEEK = 168;
/** Clearance from the sheet and from the edge of the window. */
const PEEK_GAP = 12;

let peek: HTMLElement | null = null;
let peekImg: HTMLImageElement | null = null;

function showPeek(row: HTMLElement, hash: string): void {
  const dlg = sheetEl();
  const url = assetURL(hash);
  if (!dlg || !url) return;

  if (!peek) {
    peek = document.createElement('div');
    peek.className = 'inv-peek';
    peekImg = document.createElement('img');
    // Decorative: the row beside it already names the file, and a screen
    // reader announcing the filename twice is worse than not announcing the
    // picture at all.
    peekImg.alt = '';
    peek.append(peekImg);
  }
  if (peek.parentNode !== dlg) dlg.append(peek);
  if (peekImg!.src !== url) peekImg!.src = url;
  peek.hidden = false;

  // Beside the sheet, on whichever side has room, and over it when neither
  // does - which on a phone is every time. A peek that hung off the edge of
  // the window would be the one thing in this report that cannot be read.
  const r = row.getBoundingClientRect();
  const box = dlg.getBoundingClientRect();
  const right = box.right + PEEK_GAP;
  const left = box.left - PEEK_GAP - PEEK;
  const x = right + PEEK <= innerWidth - PEEK_GAP ? right
    : left >= PEEK_GAP ? left
      : clamp(r.left, PEEK_GAP, innerWidth - PEEK - PEEK_GAP);
  const y = clamp(r.top + r.height / 2 - PEEK / 2, PEEK_GAP, innerHeight - PEEK - PEEK_GAP);
  // CSSOM rather than a style attribute: style-src carries no 'unsafe-inline'
  // and a hash covers an element, never an attribute. See web/_headers.
  peek.style.left = `${Math.round(x)}px`;
  peek.style.top = `${Math.round(y)}px`;
}

function hidePeek(): void {
  if (peek) peek.hidden = true;
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.className = 'inv-head';
  h.textContent = text;
  return h;
}

function line(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}
