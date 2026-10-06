// Board search palette (Ctrl+K). Picks a result → selects the item and flies to it.
// Built per query, no index. Items are renamed/edited constantly; rebuilding
// a few hundred string reads per keystroke is cheaper than invalidation bugs.

import { board, byId, isContent, itemTags, select, rolledAway, unrollFor } from '../state.ts';
import { cue } from '../cuelume/engine.ts';
import { toast } from '../notify.ts';
import { isDesktop } from '../platform/platform.ts';
import { travelMs } from '../canvas/viewport.ts';
import { extOf, markClosed } from '../util.ts';
import { describeExt, formatName } from '../import/formats.ts';
import { kindName, kindTag } from '../canvas/item-dom.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item } from '../board-model.ts';
import { shownName } from '../board-model.ts';

const MAX_HITS = 12;
const SNIPPET = 90;

type Fields = {
  name: string,
  text: string,
  url: string,
  kind: string,
  kindLabel: string,
  tags: string[],
};

type Hit = { item: Item, f: Fields, s: number };

let vp: Viewport | null = null;
/** revealInFeed() (ui/feed.ts), injected: the Feed reaches this module through
 *  its masthead, so an import back would close a cycle. */
let revealInFeed: ((id: string) => boolean) | null = null;
let node: HTMLElement | null = null;
let field: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let hits: Hit[] = [];
/** Every match, not only the MAX_HITS drawn - what "Select all" takes. */
let matched: Hit[] = [];
let at = 0;
/** What was last searched for, put back when Find opens again: the next hit
 *  for the same words was a retype away. */
let lastQuery = '';

export function initSearch(viewport: Viewport, reveal: ((id: string) => boolean) | null = null) {
  vp = viewport;
  revealInFeed = reveal;

  // Capture phase to beat the canvas key handling.
  addEventListener('keydown', e => {
    // Ctrl+K on Mac is "delete to end of line"; use Cmd+K there.
    const hotkey = e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey;
    if (hotkey) {
      e.preventDefault();
      e.stopPropagation();
      node ? close() : open();
      return;
    }
    // Ctrl+F too, on the board: the browser's find-in-page cannot see a card
    // that is culled or named only by its file, and the desktop app has bound
    // Ctrl+F to this from the start (desktop/menu.ts). Only where nothing else
    // wants it - in a field, a dialog or the viewer the page's find is what is
    // meant - and not in the app, where the menu's accelerator already opens it.
    if (e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && !isDesktop() && boardHasKeys(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      open();
      return;
    }
    if (!node) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); markClosed(e); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // Shift+Enter takes every match, not the one under the cursor.
      if (e.shiftKey) commitAll();
      else commit(hits[at]);
    }
  }, true);

  addEventListener('pointerdown', e => {
    // SAFETY: a pointerdown is dispatched at a node in the document, never at the window.
    if (!node || node.contains(e.target as Node | null)) return;
    // Record before close so open() can detect the same press (justDismissed pattern).
    // SAFETY: as above.
    dismissedBy = e.target as Node | null;
    dismissedAt = performance.now();
    close();
  }, true);
  addEventListener('wheel', () => close(), { passive: true });
  addEventListener('blur', () => close());
}

/** Whether a key press is the board's to answer: nobody is typing, and no
 *  dialog or menu sits over the board. */
function boardHasKeys(target: EventTarget | null) {
  if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return false;
  return !document.querySelector('dialog[open]') && !document.getElementById('ctx-menu');
}

let dismissedBy: Node | null = null;
let dismissedAt = -Infinity;
const DISMISS_MS = 400;

// `from`: the button, so a second tap toggles instead of rebuilding.
export function open(from: Element | null = null) {
  if (node) { field!.select(); return; }
  if (from && dismissedBy && performance.now() - dismissedAt <= DISMISS_MS
    && from.contains(dismissedBy)) {
    dismissedBy = null;
    dismissedAt = -Infinity;
    return;
  }

  node = document.createElement('div');
  node.id = 'search';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Find on this board');

  field = document.createElement('input');
  field.type = 'search';
  field.id = 'search-field';
  field.placeholder = 'Find a picture, a note, a link…';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-expanded', 'false');
  field.setAttribute('aria-controls', 'search-hits');
  field.setAttribute('aria-autocomplete', 'list');

  list = document.createElement('div');
  list.id = 'search-hits';
  list.setAttribute('role', 'listbox');

  field.addEventListener('input', () => run(field!.value));
  node.append(field, list);
  document.body.append(node);
  field.focus();
  // The last words, selected, so typing replaces them and Enter repeats them.
  field.value = lastQuery;
  field.select();
  run(lastQuery);
}

export function close() {
  if (field) lastQuery = field.value.trim();
  node?.remove();
  node = null;
  field = null;
  list = null;
  hits = [];
  matched = [];
  at = 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function fields(item: Item): Fields {
  const name = shownName(item);
  const meta = item.meta || {};
  // Note body minus first line (name already covers it).
  const body = typeof meta.text === 'string' ? meta.text : '';
  const text = item.type === 'note' ? afterFirstLine(body) : '';
  const url = typeof meta.url === 'string' ? meta.url : '';
  const kind = describeExt(extOf(name));
  return {
    name,
    text,
    url,
    kind: [kindName(item), kind?.label, kind?.categoryLabel, extOf(name)].filter(Boolean).join(' '),
    kindLabel: [...new Set([formatName(extOf(name)), kind?.label, kind?.categoryLabel]
      .filter(Boolean))].join(' · '),
    tags: itemTags(item),
  };
}

const afterFirstLine = (s: string) => {
  const i = s.indexOf('\n');
  return i < 0 ? '' : s.slice(i + 1);
};

// name-starts > exact tag > name-contains > partial tag > url > note body > kind.
function score(f: Fields, q: string) {
  const name = f.name.toLowerCase();
  if (name.startsWith(q)) return 1000 - name.length;   // shortest exact-ish first
  if (f.tags.includes(q)) return 800;
  if (name.includes(q)) return 600 - name.length;
  if (f.tags.some(t => t.includes(q))) return 500;
  if (f.url.toLowerCase().includes(q)) return 400;
  if (f.text.toLowerCase().includes(q)) return 300;
  if (f.kind.toLowerCase().includes(q)) return 100;
  return 0;
}

function run(query: string) {
  const q = query.trim().toLowerCase();
  at = 0;

  if (!q) {
    hits = [];
    matched = [];
    draw(q);
    return;
  }

  matched = board.items
    .map(item => {
      const f = fields(item);
      return { item, f, s: score(f, q) };
    })
    .filter(h => h.s > 0)
    .sort((a, b) => b.s - a.s);
  hits = matched.slice(0, MAX_HITS);

  draw(q);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw(q: string) {
  list!.replaceChildren();
  field!.setAttribute('aria-expanded', String(hits.length > 0));

  // Empty until something is typed: the field's placeholder is the whole prompt.
  if (!q) return;
  if (!hits.length) {
    list!.append(note('Nothing on this board matches that.'));
    return;
  }

  hits.forEach((h, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-hit';
    row.setAttribute('role', 'option');
    row.id = 'search-hit-' + i;
    row.setAttribute('aria-selected', String(i === at));
    row.classList.toggle('is-at', i === at);

    const kind = document.createElement('span');
    kind.className = 'search-kind';
    kind.textContent = kindTag(h.item);

    const name = document.createElement('span');
    name.className = 'search-name';
    name.textContent = h.f.name || '(unnamed)';

    const where = document.createElement('span');
    where.className = 'search-where';
    where.textContent = context(h.f, q);

    row.append(kind, name, where);
    row.addEventListener('click', () => { cue('pick'); commit(h); });
    list!.append(row);
  });

  // The rest of the matches, which the list stops short of: said, and taken
  // whole by one press. Outside the arrow walk - it is an action, not a hit.
  if (matched.length > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'search-all';
    all.textContent = matched.length > hits.length
      ? `Select all ${matched.length} matches (${matched.length - hits.length} more not shown)  Shift+Enter`
      : `Select all ${matched.length} matches  Shift+Enter`;
    all.addEventListener('click', () => { cue('pick'); commitAll(); });
    list!.append(all);
  }

  field!.setAttribute('aria-activedescendant', 'search-hit-' + at);
}

function context(f: Fields, q: string) {
  if (f.name.toLowerCase().includes(q)) return '';
  if (f.url.toLowerCase().includes(q)) return f.url;
  const i = f.text.toLowerCase().indexOf(q);
  if (i >= 0) {
    const from = Math.max(0, i - SNIPPET / 3);
    const cut = f.text.slice(from, from + SNIPPET).replace(/\s+/g, ' ').trim();
    return (from > 0 ? '…' : '') + cut + (from + SNIPPET < f.text.length ? '…' : '');
  }
  return f.kindLabel;
}

function note(text: string) {
  const p = document.createElement('p');
  p.className = 'search-note';
  p.textContent = text;
  return p;
}

function move(step: number) {
  if (!hits.length) return;
  at = (at + step + hits.length) % hits.length;
  const rows = [...list!.querySelectorAll('.search-hit')];
  rows.forEach((r, i) => {
    r.classList.toggle('is-at', i === at);
    r.setAttribute('aria-selected', String(i === at));
  });
  rows[at]?.scrollIntoView({ block: 'nearest' });
  field!.setAttribute('aria-activedescendant', 'search-hit-' + at);
}

// Re-looks up the item; board may have changed between query and commit.
function commit(hit: Hit | undefined) {
  if (!hit) return;
  const id = hit.item.id;
  close();
  const item = byId(id);
  if (!item) return;
  // A card folded away in a rolled-up fence is what was asked for, so it opens.
  if (rolledAway(item)) unrollFor(id);
  select([id]);
  // On the Feed the canvas is hidden, so flying it moves nothing anybody sees.
  if (board.layoutMode === 'mobile' && revealInFeed?.(id)) return;
  vp!.fit([item], 120, travelMs());
}

/**
 * Every match selected, and the view fitted round them. A card folded away in
 * a rolled fence is left out, as Select all leaves it out: a selection is what
 * the next Delete takes, and it must not take what nobody can see. On the Feed
 * the selection is made and nothing flies - reveal there is for one card.
 */
function commitAll() {
  const ids = matched.map(h => h.item.id);
  close();
  // Content only: a match on the title card or a hint is a place to fly to,
  // not a card to sweep up with forty others.
  const items = ids.map(id => byId(id)).filter((i): i is Item => !!i && isContent(i) && !rolledAway(i));
  if (!items.length) return;
  select(items.map(i => i.id));
  toast(`Selected ${items.length} matches`);
  if (board.layoutMode !== 'mobile') vp!.fit(items, 120, travelMs());
}
