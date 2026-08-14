// What is in this board, and what it weighs.
//
// `.mbrd` files get heavy and nothing in the app would say why. The optimizer
// has existed for a while and works, and it is a button you have to already
// know about - there is nowhere that gives you a *reason* to press it. *This
// photograph is 12 MB* is that reason, so the two sit together: this sheet
// reports, and hands off to Optimize.
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
// **Nothing here may decode an image.** That is the load-bearing one. A board
// with two thousand cards is exactly the board somebody opens this on, and a
// panel that measured pictures by decoding them would stall the tab at the
// precise moment the question was being asked - turning the tool for
// diagnosing a heavy board into another reason it feels heavy. So there are no
// thumbnails in here and no previews: a name, a kind, and a number.
//
// ── "Unreferenced" has three meanings, and they all count ──
//
// An asset is unreferenced when nothing on the live board, nothing in the bin,
// and **no stored version** points at it. The third arrived with the version
// history and is the one that is easy to forget: a version names cards the
// board no longer has, which is the whole of what a version is for, so an asset
// only a version wants is live.
//
// The orphan list is reported and **not** offered for deletion. That was a
// decision taken before versions existed - on the grounds that a *remove
// unused* button written against a two-class union would become a data-loss bug
// the day a third class arrived - and the third class then arrived, in the very
// next batch. The button would have been wrong for exactly the predicted
// reason. It stays a report.

import { board, versionHashes } from '../state.ts';
import { allAssets } from '../storage/assets.ts';
import { itemHashes, el, formatBytes } from '../util.ts';

/** One asset, as this sheet talks about it. */
export type InventoryAsset = {
  hash: string;
  name: string;
  ext: string;
  bytes: number;
  /** Nothing on the board or in the bin points at this one. */
  orphan: boolean;
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
  for (const item of board.items) for (const h of itemHashes(item)) referenced.add(h);
  for (const t of board.trash) for (const h of itemHashes(t.item)) referenced.add(h);
  // The third class. Asked of board-schema.ts rather than walked here, because
  // that module owns the shape of a stored version and this one has no business
  // knowing it - and because a second copy of this walk is exactly how the two
  // would come to disagree about what is rubbish.
  for (const h of versionHashes(board.versions)) referenced.add(h);

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

/** Open the inventory sheet. Idempotent; safe without a document. */
export function openInventory(): void {
  if (typeof document === 'undefined') return;
  const dlg = el('inventory') as HTMLDialogElement | null;
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
    el('inventory-close')?.addEventListener('click', () => dlg.close());
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
    for (const asset of inv.largest) {
      const row = document.createElement('li');
      row.className = 'inv-row';
      const name = document.createElement('span');
      name.className = 'inv-name';
      // The stored name, else the extension, else the first of the hash - a
      // pasted picture has no filename and a row reading "" is a row that looks
      // broken rather than one that says there was never a name.
      name.textContent = asset.name || (asset.ext ? `.${asset.ext}` : asset.hash.slice(0, 8));
      const size = document.createElement('span');
      size.className = 'inv-size';
      size.textContent = formatBytes(asset.bytes);
      row.append(name, size);
      if (asset.orphan) row.dataset.orphan = '';
      list.append(row);
    }
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
