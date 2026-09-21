// Board inventory — what is here and what it weighs. Reports sizes from
// stored blob lengths, never decodes images. A row is the file a card
// arrived as, with the copies the board made of it folded underneath, so
// the count is the one a person recognises: two pictures dropped, two rows.
// Orphans are reported, never offered for deletion.

import {
  board, byId, select, timelineHashes, timelinePlaying, timelineAt, timelineSteps,
  discardOriginals, replaceOldVersions,
} from '../state.ts';
import { cue } from '../cuelume/engine.ts';
import { toast } from '../notify.ts';
import { allAssets, assetURL, getAsset, forgetAssets } from '../storage/assets.ts';
import { travelMs } from '../canvas/viewport.ts';
import { icon } from './menu.ts';
import { ask } from './dialog.ts';
import { itemHashes, el, clamp, formatBytes } from '../util.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item } from '../board-model.ts';

/**
 * What a stored file is to the card keeping it. The order below is the order
 * of the claim: a hash under two keys is named by the first one that wants it.
 *
 * `source` is the file that was dropped and `main` the picture the card shows,
 * and for a .heic or a camera RAW those are two different files - the card
 * carries the developed WebP at asset.hash and the original at meta.source
 * (see origName() in util.ts). For everything else there is no source and the
 * dropped file *is* main.
 */
export type FileRole = 'source' | 'main' | 'display' | 'still' | 'other';

/** What is keeping a file alive. Null is an orphan: nothing is. */
export type Holder = 'field' | 'drawer' | 'timeline';

/** One asset, as this sheet talks about it. */
export type InventoryAsset = {
  hash: string;
  name: string;
  ext: string;
  bytes: number;
  /** What the card keeping it made it for. 'other' for a file no card claims. */
  role: FileRole;
  /** The one holder with the strongest claim on it - see the walk below. */
  held: Holder | null;
  /** Nothing on the board or in the bin points at this one. `held === null`. */
  orphan: boolean;
  /**
   * The live cards using this file, in board order.
   *
   * Live only - a binned card keeps the file off the orphan list but there is
   * nowhere to fly to for it, and a history step is a moment, not a place.
   */
  cards: string[];
};

/**
 * One row of the list: a file and every copy the same card keeps of it.
 *
 * A picture is three or four stored blobs - the original, the picture it was
 * developed into, a ~1024px display copy, a thumbnail - and reporting those as
 * four rows answers a question nobody asked. They add up here instead, and the
 * row opens to show where its weight went.
 */
export type InventoryFile = {
  /** The file the row is named after: the one dropped, when there is one. */
  head: InventoryAsset;
  /** Head first, then its copies, heaviest first. */
  files: InventoryAsset[];
  /** What the whole group weighs - the number on the row. */
  bytes: number;
  /**
   * Which holder's list the row belongs in. One value for the group, not one
   * per file: a group is one card's files and a card is in one place.
   */
  held: Holder | null;
};

export type Inventory = {
  /** How many cards of each kind, biggest count first. */
  kinds: { type: string; count: number }[];
  items: number;
  binned: number;
  /** Every stored blob, and what they add up to. */
  bytes: number;
  assets: number;
  /**
   * Every stored file, and its weight, under the one holder keeping it alive.
   * With `orphans` these four add up to `assets` and to `bytes`, which is the
   * point: the file count is always larger than the card count and this is
   * where the difference goes.
   */
  held: Record<Holder, { count: number; bytes: number }>;
  /**
   * How many files a person would say the board has: one per group on the
   * field, the copies folded in. What the headline counts.
   */
  files: number;
  /** The heaviest group on the field first, capped - see TOP. */
  largest: InventoryFile[];
  /**
   * The same, for the two holders that are not the board itself. Kept apart
   * rather than sorted into one list because they answer a different question:
   * these are not the board's files, they are what undo would need to put
   * back. After an Optimize they are most of the weight and none of the board.
   */
  kept: Record<'drawer' | 'timeline', InventoryFile[]>;
  /**
   * Every hash the past alone is keeping - uncapped, unlike `kept.timeline`,
   * because this is not a list to read but the list to free. Nothing on the
   * field or in the drawer is in it: the holder walk gives each file to the
   * strongest claim, so what is left here is wanted by the Timeline and by
   * meta.was, and by nothing a card can still show.
   */
  freeable: string[];
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
  // The reference union, same one packBoard() writes with: a card in the
  // drawer still owns its bytes, since the whole point of the drawer is that
  // it can come back. Kept as three sets rather than one so the report can
  // name which holder is keeping each file alive.
  const onField = new Set<string>();
  // Walked into a map, not a set - the jump needs to know *which* card, not
  // only that there is one. Same walk, one more line, no second pass.
  const users = new Map<string, string[]>();
  for (const item of board.items) {
    for (const h of itemHashes(item)) {
      onField.add(h);
      const list = users.get(h);
      if (list) list.push(item.id);
      else users.set(h, [item.id]);
    }
  }
  const inDrawer = new Set<string>();
  for (const t of board.trash) for (const h of itemHashes(t.item)) inDrawer.add(h);
  // The third holder: asked of timeline.ts rather than walked here, so the
  // two cannot disagree about what is rubbish. No argument, so it reads the
  // live ledger - this is a report on the session, not on a file. It carries
  // both sides of every step, so a picture deleted an hour ago is still
  // stored and still not rubbish, which is usually the whole of the gap
  // between the card count and the file count.
  const inTimeline = timelineHashes();
  // The fourth reference and the one itemHashes() does not carry: the picture
  // an Optimize replaced, pinned at meta.was so undoing it can put the old one
  // back. The autosave sweep keeps those bytes (referencedHashes,
  // storage/session.ts), so calling them rubbish here would be the report
  // being wrong about the one thing it is for. They are the Timeline's kind of
  // weight - what the past is holding - and counted with it.
  for (const item of [...board.items, ...board.trash.map(t => t.item)]) {
    for (const key of ['was', 'wasCover']) {
      const hash = item.meta?.[key];
      if (typeof hash === 'string' && hash) inTimeline.add(hash);
    }
  }

  const counts = new Map<string, number>();
  for (const item of board.items) {
    counts.set(item.type, (counts.get(item.type) || 0) + 1);
  }

  let bytes = 0;
  let orphanBytes = 0;
  let orphanCount = 0;
  const held: Record<Holder, { count: number; bytes: number }> = {
    field: { count: 0, bytes: 0 },
    drawer: { count: 0, bytes: 0 },
    timeline: { count: 0, bytes: 0 },
  };
  const all: InventoryAsset[] = [];
  for (const [hash, asset] of allAssets()) {
    // One file, one holder, strongest claim first. A picture on the field is
    // also inside half the Timeline's steps, so counting it under both would
    // make the three numbers add up to more than there are files. Attributing
    // it to the field instead leaves `timeline` meaning what a reader wants it
    // to mean: the files nothing on screen is using any more.
    const where: Holder | null = onField.has(hash) ? 'field'
      : inDrawer.has(hash) ? 'drawer'
      : inTimeline.has(hash) ? 'timeline'
      : null;
    if (where) { held[where].count++; held[where].bytes += asset.size; }
    const orphan = !where;
    bytes += asset.size;
    if (orphan) { orphanCount++; orphanBytes += asset.size; }
    all.push({
      hash,
      name: asset.name || '',
      ext: asset.ext || '',
      bytes: asset.size,
      // Rewritten below for every file a card claims. A file no card points at
      // keeps this one and stands on its own row.
      role: 'other',
      held: where,
      orphan,
      cards: users.get(hash) || [],
    });
  }
  // Sorted by weight, then by hash, so the order is stable between two opens
  // of an unchanged board rather than at the whim of Map iteration order.
  all.sort((a, b) => b.bytes - a.bytes || (a.hash < b.hash ? -1 : 1));

  // Split by holder rather than listed together. An Optimize leaves the
  // Timeline holding every original it replaced, and those rows arriving in
  // the middle of the board's own files is the report that made no sense: a
  // 27 MB board with 470 KB on it.
  const groups = groupFiles(all);
  const of = (holder: Holder) => groups.filter(g => g.held === holder).slice(0, TOP);
  const field = groups.filter(g => g.held === 'field');

  return {
    kinds: [...counts].map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
    items: board.items.length,
    binned: board.trash.length,
    bytes,
    assets: all.length,
    held,
    files: field.length,
    largest: field.slice(0, TOP),
    kept: { drawer: of('drawer'), timeline: of('timeline') },
    freeable: all.filter(a => a.held === 'timeline').map(a => a.hash),
    orphans: { count: orphanCount, bytes: orphanBytes },
  };
}

/**
 * Every stored file, gathered into one group per card.
 *
 * Each file lands in exactly one group - claimed by the first card that names
 * it, live cards before binned ones - so the group weights add up to `bytes`
 * rather than counting a picture twice because two cards share it. What is
 * left is the Timeline's: steps are moments rather than cards, and there is
 * nothing to hang those files off, so each stands on its own row under its own
 * heading.
 */
function groupFiles(all: InventoryAsset[]): InventoryFile[] {
  const byHash = new Map(all.map(a => [a.hash, a]));
  const taken = new Set<string>();
  const groups: InventoryFile[] = [];

  for (const item of [...board.items, ...board.trash.map(t => t.item)]) {
    const mine: InventoryAsset[] = [];
    for (const [hash, role] of rolesOf(item)) {
      const asset = byHash.get(hash);
      if (!asset || taken.has(hash)) continue;
      taken.add(hash);
      asset.role = role;
      mine.push(asset);
    }
    if (mine.length) groups.push(gather(mine));
  }
  for (const asset of all) if (!taken.has(asset.hash)) groups.push(gather([asset]));

  // Heaviest group first, ties by hash - the same stable order the flat list
  // had, for the same reason: two opens of an unchanged board must agree.
  groups.sort((a, b) => b.bytes - a.bytes || (a.head.hash < b.head.hash ? -1 : 1));
  return groups;
}

/** One card's files, hash by hash, under the name of what each one is for. */
function rolesOf(item: Item): Map<string, FileRole> {
  const roles = new Map<string, FileRole>();
  const meta = item.meta;
  const put = (hash: unknown, role: FileRole) => {
    if (typeof hash === 'string' && hash && !roles.has(hash)) roles.set(hash, role);
  };
  put(meta?.source, 'source');
  put(item.asset?.hash, 'main');
  put(meta?.display, 'display');
  for (const key of ['thumb', 'cover', 'shot', 'poster']) put(meta?.[key], 'still');
  // The rest of what an item can own - preview, art, an archive, a folder's
  // listed files. Asked of itemHashes() rather than listed again here, which
  // is the one place that list is allowed to live.
  for (const hash of itemHashes(item)) put(hash, 'other');
  return roles;
}

/** Name the group after the dropped file, then order the copies by weight. */
function gather(files: InventoryAsset[]): InventoryFile {
  const head = files.find(f => f.role === 'source') ?? files.find(f => f.role === 'main') ?? files[0];
  const rest = files.filter(f => f !== head)
    .sort((a, b) => b.bytes - a.bytes || (a.hash < b.hash ? -1 : 1));
  return {
    head,
    files: [head, ...rest],
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    // The head's holder speaks for the group: every file in it belongs to one
    // card, and that card is in one place. A binned card's files are all the
    // drawer's even where the Timeline also remembers them, because the walk
    // above gives each file to the strongest claim first.
    held: head.held,
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

  // Cards first, files second. The file count leads nowhere as a headline:
  // it is always the larger number and never the one asked about, because a
  // picture keeps an original, a display copy and a thumbnail, and because
  // the Timeline holds on to everything it would have to put back.
  out.push(line('inv-total', `${inv.items} ${inv.items === 1 ? 'card' : 'cards'}`));

  const kinds = inv.kinds.map(k => `${k.count} ${kindLabel(k.type, k.count)}`).join(', ');
  out.push(line('inv-kinds', kinds || 'Nothing on this board yet'));

  if (inv.binned) {
    out.push(line('inv-binned',
      `${inv.binned} more in the drawer, still ${inv.binned === 1 ? 'carrying its' : 'carrying their'} bytes`));
  }

  // The headline weighs the board, not the store: what is on the field, in the
  // files a person would say they put there, with each one's copies folded in.
  // Everything else is history, and history goes on the line below.
  out.push(line('inv-files', `${formatBytes(inv.held.field.bytes)} on the field, in `
    + `${inv.files} ${inv.files === 1 ? 'file' : 'files'}`));
  // The store, once, and only when it is a different number - each holder says
  // its own weight on its own row below, and a line here listing them again
  // was the same three figures twice over. What it is for: an Optimize can
  // leave nine tenths of a board's bytes behind the board, and a headline that
  // only added them up would look like the optimiser had done nothing.
  if (inv.bytes !== inv.held.field.bytes) {
    out.push(line('inv-where', `${formatBytes(inv.bytes)} stored in all`));
  }

  out.push(...section('The heaviest', inv.largest));
  // Named for what they are rather than listed with the board's own files, and
  // folded away: a reader looking for what a card costs must not have to tell a
  // live picture from the copy of it undo is holding, and mostly does not want
  // to see the second list at all.
  //
  // Neither heading says "Timeline" or "bin", and that is the point - they say
  // what the files are and why they are still here. The machinery has names of
  // its own and the reader of this sheet has not asked about them.
  out.push(...folded('Waiting in the drawer', inv.kept.drawer, inv.held.drawer));
  out.push(...folded('Kept in case you undo', inv.kept.timeline, inv.held.timeline,
    inv.freeable.length ? () => { void freeThePast(); } : undefined));

  if (inv.orphans.count) {
    // Reported, never offered for deletion. See the header for why.
    out.push(line('inv-orphans',
      `${inv.orphans.count} stored ${inv.orphans.count === 1 ? 'file is' : 'files are'} `
      + `no longer used by any card - ${formatBytes(inv.orphans.bytes)}. `
      + 'They are dropped the next time this board is saved to a file.'));
  }

  return out;
}

/** A heading and its list, or nothing at all when the holder holds nothing. */
function section(title: string, groups: InventoryFile[]): HTMLElement[] {
  if (!groups.length) return [];
  return [heading(title), listOf(groups)];
}

function listOf(groups: InventoryFile[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'inv-list';
  for (const group of groups) list.append(groupRow(group));
  return list;
}

/**
 * The same, closed: a twisty, the heading, what the holder weighs in all, and
 * - for the past, which is the one a reader may want rid of - a way to let it
 * go. Closed on arrival because these are not the board's files, and a reader
 * who has not asked about them is reading about the board.
 */
function folded(title: string, groups: InventoryFile[],
  held: { count: number; bytes: number }, free?: () => void): HTMLElement[] {
  if (!groups.length) return [];
  const list = listOf(groups);
  list.hidden = true;
  list.id = `inv-kept-${++seq}`;
  // The heaviest are shown, the rest are counted - the cap is TOP per holder.
  const shown = groups.reduce((sum, g) => sum + g.files.length, 0);
  if (held.count > shown) {
    const more = document.createElement('li');
    more.className = 'inv-more';
    more.textContent = `and ${held.count - shown} more`;
    list.append(more);
  }

  const bar = document.createElement('div');
  bar.className = 'inv-fold';
  const what = `${held.count} ${held.count === 1 ? 'file' : 'files'}`;
  bar.append(twisty(list, `${title}: show the ${what}`), heading(title),
    size(formatBytes(held.bytes)));
  if (free) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inv-free';
    btn.textContent = 'Delete';
    btn.title = 'Delete every earlier version. The timeline keeps its steps and'
      + ' draws them with the pictures the cards have now.';
    btn.addEventListener('click', free);
    bar.append(btn);
  }
  return [bar, list];
}

/**
 * Delete the bytes the past is holding, and keep the past.
 *
 * Three acts, in this order and not another. The live cards stop naming their
 * originals (`discardOriginals`), which is what lets the autosave sweep let go.
 * The ledger is rewritten to name today's files in place of the ones going
 * (`replaceOldVersions`), so every step still draws - a step from before an
 * Optimize shows the same board, with the optimised pictures on it. Only then
 * are the bytes freed, because until both of those have run something still
 * points at them.
 *
 * The sheet closes first (a second modal over a modal lands behind it) and
 * opens again on the numbers this leaves behind.
 */
async function freeThePast(): Promise<void> {
  // A replay puts the board at an earlier moment, and rewriting the ledger
  // under it would rewrite the moment being stood on. The strip's own rows go
  // inert while it plays (paintPlay); this one is outside that lock, so it
  // says so instead.
  if (timelinePlaying()) {
    toast('The timeline cannot be changed while it plays. Press Pause first.');
    return;
  }
  // Scrubbed back, the board *is* the past: the cards on it hold the older
  // pictures, so "what no card is using" names the newer ones and this would
  // delete the optimised copies and keep the originals - coherent, and exactly
  // backwards. The present is the only place the question means what it says.
  if (timelineAt() < timelineSteps().length) {
    toast('The timeline is standing in the past. Bring it to the end first.');
    return;
  }
  const held = boardInventory().held.timeline;
  sheetEl()?.close();
  const answer = await ask({
    title: 'Delete the earlier versions?',
    body: `${formatBytes(held.bytes)} of earlier versions goes. The timeline keeps every`
      + ' step: where a step showed an older copy of a picture, it shows the card\'s'
      + ' picture as it is now. Undo is emptied. There is no going back.',
    go: 'Delete them',
    danger: true,
  });
  if (answer !== 'go') { openInventory(); return; }

  // Read again rather than trusting the report the button was drawn from: a
  // board can change while a dialog is up, and freeing a hash a card has since
  // taken up would leave a card with a hole in it.
  const doomed = new Set(boardInventory().freeable);
  for (const hash of discardOriginals()) doomed.add(hash);
  replaceOldVersions(doomed);
  const freed = forgetAssets(doomed);
  let bytes = 0;
  for (const size of freed.values()) bytes += size;
  toast(freed.size
    ? `${formatBytes(bytes)} freed - ${freed.size} earlier ${freed.size === 1 ? 'version' : 'versions'} deleted`
    : 'There was nothing left to delete');
  openInventory();
}

/**
 * One group, as a row: the file it is named after, weighing what the whole
 * group weighs, and - when there are copies - a twisty that opens them
 * indented underneath.
 *
 * Two controls rather than one, because expanding and flying to the card are
 * two different answers. The line keeps the jump and stays the whole width of
 * the row, so a row that leads somewhere is told apart from one that does not
 * at a glance, with a hit target that works with a thumb too.
 */
function groupRow(group: InventoryFile): HTMLElement {
  const row = document.createElement('li');
  row.className = 'inv-row';
  if (group.head.orphan) row.dataset.orphan = '';

  const head = document.createElement('div');
  head.className = 'inv-group';
  let kids: HTMLElement | null = null;
  if (group.files.length > 1) {
    kids = document.createElement('ul');
    kids.className = 'inv-kept';
    kids.id = `inv-kept-${++seq}`;
    kids.hidden = true;
    // Every file, the head included, so the indented weights add up to the
    // number on the row. Leaving the original out left its 23 MB stated
    // nowhere and the reader subtracting to find it.
    for (const file of group.files) {
      const kid = document.createElement('li');
      kid.className = 'inv-kid';
      kid.append(fileLine(file, file.bytes, peekOf([file]), ROLE_LABEL[file.role]));
      kids.append(kid);
    }
    const copies = group.files.length - 1;
    head.append(twisty(kids, copies === 1 ? 'Show the copy this file keeps'
      : `Show the ${copies} copies this file keeps`));
  } else {
    // An empty slot where the twisty would be, so a row with no copies keeps
    // the same name column as the rows around it.
    const slot = document.createElement('span');
    slot.className = 'inv-slot';
    head.append(slot);
  }
  head.append(fileLine(group.head, group.bytes, peekOf(group.files)));
  row.append(head);
  if (kids) row.append(kids);
  return row;
}

/** Row ids for aria-controls. Rebuilt with the list on every open. */
let seq = 0;

/** The disclosure beside a row or a heading. Closed on arrival: what it hides
 * is the answer to a question, and the question is asked by opening it. */
function twisty(kids: HTMLElement, label: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inv-twisty';
  btn.setAttribute('aria-controls', kids.id);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(icon('i-chevron-right'));
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    kids.hidden = open;
    cue('pick');
  });
  return btn;
}

/**
 * What each file in an opened row is called: what it is for, in words, rather
 * than what it is called on disk. `display.webp` under a row already named
 * display.webp explains nothing, and the three copies a picture keeps have no
 * names a person chose. The filename is still there, in the row's title.
 *
 * Empty for `other` - a file no card explains is named after itself.
 */
const ROLE_LABEL: Record<FileRole, string> = {
  source: 'The file as it arrived',
  main: 'What the card shows',
  display: 'A screen-sized copy',
  still: 'A thumbnail',
  other: '',
};

/**
 * One line: name, how many cards want it, weight, and (when a card wants it)
 * a way to go there. `bytes` is passed rather than read off the asset, since a
 * group's line carries the group's weight and a copy's carries its own.
 */
function fileLine(asset: InventoryAsset, bytes: number, shown: Peek | null,
  label = ''): HTMLElement {
  // Stored name, else extension, else the first of the hash - a pasted
  // picture has no filename and an empty row looks broken rather than nameless.
  const filename = asset.name || (asset.ext ? `.${asset.ext}` : asset.hash.slice(0, 8));
  const name = document.createElement('span');
  name.className = 'inv-name';
  name.textContent = label || filename;
  const size = document.createElement('span');
  size.className = 'inv-size';
  size.textContent = formatBytes(bytes);

  const to = asset.cards[0];
  if (!to) {
    const still = document.createElement('div');
    still.className = 'inv-line';
    if (label) still.title = filename;
    still.append(name, size);
    return still;
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
  const where = asset.cards.length > 1
    ? `Go to the first of ${asset.cards.length} cards using this file`
    : 'Go to the card using this file';
  // The filename leads when the row is showing a label instead - it is the one
  // thing the words above cannot say, and hover is where it belongs.
  go.title = label ? `${filename} - ${where}` : where;
  go.addEventListener('click', () => { cue('pick'); jump(to); });
  if (shown) {
    go.addEventListener('pointerenter', () => showPeek(go, shown));
    go.addEventListener('pointerleave', hidePeek);
    // And by keyboard, since the row is a button and Tab reaches it too.
    // :focus-visible rather than focus, because showModal() hands the focus to
    // the first control in the dialog and that is the first row - so a plain
    // `focus` raised a peek the moment the sheet opened, beside a pointer that
    // was nowhere near it.
    go.addEventListener('focus', () => { if (go.matches(':focus-visible')) showPeek(go, shown); });
    go.addEventListener('blur', hidePeek);
  }
  return go;
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
 * The pictures a browser draws in an <img>, by MIME and by extension.
 *
 * A list rather than `image/*`: a .dng, a .heic and a .tiff are all image/*
 * and Windows hands Firefox that MIME for them, so the sheet offered a peek
 * and the <img> then decoded nothing - a white box beside the row. The
 * extension is the fallback for a file stored with no MIME at all.
 */
const DRAWABLE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;
const DRAWABLE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

/**
 * What a row shows in its peek, chosen across the whole group.
 *
 * This is what a group buys the reader beyond a shorter list: a camera RAW
 * cannot be drawn, but the display copy stored beside it can, so the row for a
 * .dng shows the picture instead of nothing. Preferred in that order - the
 * ~1024px display copy first, since it is what the card itself draws and it
 * decodes faster than a 23 MB original.
 *
 * A clip plays in the peek, muted, over whatever still the card kept. It used
 * to show only that still, and a clip the browser plays carries none - its
 * card decodes the frame live - so an ordinary mp4 peeked as nothing (R32).
 */
function peekOf(files: InventoryAsset[]): Peek | null {
  const ORDER: FileRole[] = ['display', 'still', 'main', 'source', 'other'];
  const mimeOf = (file: InventoryAsset) => getAsset(file.hash)?.mime || '';
  const still = files
    .filter(file => DRAWABLE.test(mimeOf(file)) || DRAWABLE_EXT.test(file.ext))
    .sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role))[0];
  const clip = files.find(file => mimeOf(file).startsWith('video/'));
  if (!still && !clip) return null;
  return { still: still?.hash ?? null, clip: clip?.hash ?? null };
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
    // An original no browser draws - a .dng, a .tiff, a .heic - is still
    // image/* to the row below, which offers a peek the <img> then decodes
    // nothing from. An empty box reads as broken; take the box away instead.
    peekImg.addEventListener('error', () => { if (peekImg && !peekImg.hidden) hidePeek(); });
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

/** A weight in the size column - the same face and figures as a row's. */
function size(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'inv-size';
  span.textContent = text;
  return span;
}
