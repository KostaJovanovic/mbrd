// Board inventory — what is here and what it weighs. Reports sizes from
// stored blob lengths, never decodes images. Rows are files by content
// hash; one file may be under several cards or none (orphan). Orphans
// are reported, never offered for deletion.

import { board, byId, select, timelineHashes } from '../state.ts';
import { cue } from '../cuelume/engine.ts';
import { allAssets, assetURL, getAsset } from '../storage/assets.ts';
import { travelMs } from '../canvas/viewport.ts';
import { itemHashes, el, clamp, formatBytes } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item } from '../board-model.ts';

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
   * Live only - a binned card keeps the file off the orphan list but there is
   * nowhere to fly to for it, and a history step is a moment, not a place.
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
  // The reference union, same one packBoard() writes with: a card in the bin
  // still owns its bytes, since the whole point of the bin is that it can
  // come back.
  const referenced = new Set<string>();
  // Walked into a map, not a set - the jump needs to know *which* card, not
  // only that there is one. Same walk, one more line, no second pass.
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
  // The third reference: asked of timeline.ts rather than walked here, so the
  // two cannot disagree about what is rubbish. No argument, so it reads the
  // live ledger - this is a report on the session, not on a file.
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
  // Sorted by weight, then by hash, so the order is stable between two opens
  // of an unchanged board rather than at the whim of Map iteration order.
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

// Bytes are formatted by util.ts's formatBytes, deliberately in binary units
// to agree with the trash panel and the optimiser rather than a file
// manager's decimal MB.

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

// Wired on first open rather than at init, the same bargain ui/credits.ts
// makes - listeners a most sessions never need don't need to exist yet.
let wired = false;

/** The inventory sheet, or null on a page that does not carry one. */
// SAFETY: #inventory is a <dialog> in index.html. The null is kept and every
// caller either duck-types showModal() or reaches through `?.`, so a page
// without the sheet gets a no-op rather than a throw.
const sheetEl = () => el('inventory') as HTMLDialogElement | null;

/**
 * The camera, handed in rather than imported - the same shape ui/search.ts
 * takes it in, since flying somewhere needs the one live Viewport main.ts
 * owns and there is no module-scope import of it.
 *
 * Null until wired, and every use below is optional-chained, so a report
 * opened before the wiring still reports and simply does not fly.
 */
let vp: Viewport | null = null;

export function initInventory(viewport: Viewport): void { vp = viewport; }

/** Open the inventory sheet. Idempotent; safe without a document. */
export function openInventory(): void {
  if (typeof document === 'undefined') return;
  const dlg = sheetEl();
  // The duck type is the runtime half of "this is a <dialog> in index.html" -
  // same shape as openCredits().
  if (!dlg || typeof dlg.showModal !== 'function') return;

  const body = el('inventory-body');
  if (body) body.replaceChildren(...report(boardInventory()));

  if (!wired) {
    wired = true;
    // Click outside to close: the sheet fills its own dialog, so a press
    // whose target is the dialog itself landed on the backdrop.
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('inventory-close')?.addEventListener('click', () => { cue('pick'); dlg.close(); });
    // Escape closes the dialog without any button pressed, and the peek is a
    // fixed box that would otherwise hang over the board. `close` catches
    // every way out at once.
    dlg.addEventListener('close', hidePeek);
    // Wired by hand, not through the delegated data-cmd listener - that one is
    // bound to the sidebar, and a <dialog> is in the top layer and outside it,
    // so a data-cmd here would silently do nothing. Same dynamic import
    // cmds.optimize uses, so the optimiser stays unloaded until asked for.
    //
    // Sheet closes first: the optimiser raises its own progress and result,
    // which would land behind a modal still up.
    el('inventory-optimize')?.addEventListener('click', () => {
      cue('pick');
      dlg.close();
      void import('../optimize/ui.ts').then(m => m.optimizeBoard());
    });
  }
  if (!dlg.open) dlg.showModal();
}

/**
 * The sheet's contents, built through createElement - no innerHTML anywhere,
 * as a rule applied everywhere rather than remembered case by case. A file
 * name is the one string here a stranger wrote, off a `.mbrd`.
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
    // Reported, never offered for deletion. See the header for why.
    out.push(line('inv-orphans',
      `${inv.orphans.count} stored ${inv.orphans.count === 1 ? 'file is' : 'files are'} `
      + `no longer used by any card - ${formatBytes(inv.orphans.bytes)}. `
      + 'They are dropped the next time this board is saved to a file.'));
  }

  return out;
}

/**
 * One file, as a row: name, how many cards want it, weight, and (when a card
 * wants it) a way to go there.
 *
 * The control is the whole row rather than a trailing chevron, so a row that
 * does something is told apart from one that does not at a glance, with a hit
 * target that works with a thumb too.
 */
function assetRow(asset: InventoryAsset): HTMLElement {
  const row = document.createElement('li');
  row.className = 'inv-row';
  if (asset.orphan) row.dataset.orphan = '';

  const name = document.createElement('span');
  name.className = 'inv-name';
  // Stored name, else extension, else the first of the hash - a pasted
  // picture has no filename and an empty row looks broken rather than nameless.
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
  // Drawn only when it is news - "used by 1" on nine rows out of ten is noise
  // that buries the one row saying 3.
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
  // A picture shows itself. A clip plays in the peek, muted, over its card's
  // still. It used to show only that still, read from `cover` or `poster`,
  // and a clip the browser plays carries neither - its card decodes the frame
  // live - so an ordinary mp4 peeked as nothing (R32).
  const mime = getAsset(asset.hash)?.mime || '';
  const shown: Peek | null = mime.startsWith('image/') ? { still: asset.hash, clip: null }
    : mime.startsWith('video/') ? { still: stillOf(byId(to)?.meta), clip: asset.hash }
    : null;
  if (shown) {
    go.addEventListener('pointerenter', () => showPeek(go, shown));
    go.addEventListener('pointerleave', hidePeek);
    // And by keyboard, since the row is a button and Tab reaches it too.
    go.addEventListener('focus', () => showPeek(go, shown));
    go.addEventListener('blur', hidePeek);
  }
  row.append(go);
  return row;
}

/**
 * Take the row: select the card and fly to it. The sheet closes first - it
 * is modal, so the flight would otherwise land behind it.
 *
 * byId() after the close rather than the item captured at build time, same
 * reason ui/search.ts gives: the board can change between open and press, and
 * a row naming nothing should do nothing rather than throw.
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
// One box, made on first hover and kept, so moving down a list of ten rows is
// ten src assignments, not ten elements. It lives inside the <dialog> because
// a modal's backdrop paints over anything appended to <body> instead.
//
// Its box is square and the picture is contained inside it, which lets the
// placement below be arithmetic rather than a measurement only correct after
// load.

/** The peek's side, in px. Must agree with .inv-peek in dialog.css. */
const PEEK = 168;
/** Clearance from the sheet and from the edge of the window. */
const PEEK_GAP = 12;

/** What a row peeks: a picture's own hash, or a clip and its still. */
type Peek = { still: string | null, clip: string | null };

let peek: HTMLElement | null = null;
let peekImg: HTMLImageElement | null = null;
let peekClip: HTMLVideoElement | null = null;

/**
 * A clip's still: the keys canvas/renderers.ts reads for a video's poster, in
 * its order, so the peek and the card agree. Null when the clip has none,
 * which is the usual case for one the browser can play.
 */
function stillOf(meta: Item['meta'] | undefined): string | null {
  for (const key of ['cover', 'poster', 'shot', 'thumb']) {
    const hash = meta?.[key];
    if (typeof hash === 'string' && hash && getAsset(hash)) return hash;
  }
  return null;
}

function showPeek(row: HTMLElement, shown: Peek): void {
  const dlg = sheetEl();
  const still = shown.still ? assetURL(shown.still) : null;
  const clip = shown.clip ? assetURL(shown.clip) : null;
  if (!dlg || (!still && !clip)) return;

  if (!peek) {
    peek = document.createElement('div');
    peek.className = 'inv-peek';
    peekImg = document.createElement('img');
    // Decorative: the row beside it already names the file.
    peekImg.alt = '';
    peekClip = document.createElement('video');
    // Muted, so it may play without a press. Inline, so a phone does not take
    // it full screen. Looped, since a peek is a glance and not a playback.
    peekClip.muted = true;
    peekClip.loop = true;
    peekClip.playsInline = true;
    peekClip.setAttribute('aria-hidden', 'true');
    peek.append(peekImg, peekClip);
  }
  if (peek.parentNode !== dlg) dlg.append(peek);
  peekImg!.hidden = !!clip;
  peekClip!.hidden = !clip;
  if (clip) {
    peekClip!.poster = still || '';
    if (peekClip!.src !== clip) peekClip!.src = clip;
    // A clip this browser cannot decode refuses, and its poster stays up.
    void peekClip!.play().catch(() => {});
  } else {
    stopClip();
    if (still && peekImg!.src !== still) peekImg!.src = still;
  }
  peek.hidden = false;

  // Beside the sheet, on whichever side has room, over it when neither does -
  // which on a phone is every time.
  const r = row.getBoundingClientRect();
  const box = dlg.getBoundingClientRect();
  const right = box.right + PEEK_GAP;
  const left = box.left - PEEK_GAP - PEEK;
  const x = right + PEEK <= innerWidth - PEEK_GAP ? right
    : left >= PEEK_GAP ? left
      : clamp(r.left, PEEK_GAP, innerWidth - PEEK - PEEK_GAP);
  const y = clamp(r.top + r.height / 2 - PEEK / 2, PEEK_GAP, innerHeight - PEEK - PEEK_GAP);
  // CSSOM rather than a style attribute: style-src carries no 'unsafe-inline'.
  // See web/_headers.
  peek.style.left = `${Math.round(x)}px`;
  peek.style.top = `${Math.round(y)}px`;
}

function hidePeek(): void {
  if (peek) peek.hidden = true;
  stopClip();
}

/** Let go of the clip: a <video> that keeps its source keeps its decoder. */
function stopClip(): void {
  if (!peekClip?.getAttribute('src')) return;
  peekClip.pause();
  peekClip.removeAttribute('src');
  peekClip.load();
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
