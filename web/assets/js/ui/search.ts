// Finding something on a board you cannot see all of.
//
// An infinite canvas has one failure mode that a list does not: a thing can be
// *on* the board, saved, intact, and still lost, because it is four screens up
// and eleven to the left at a zoom you last used a week ago. Zoom to fit shows
// you everything at once, which for a full board means everything too small to
// read. So the board needs a way to be asked a question.
//
// A palette over the canvas rather than a field in the sidebar, for two
// reasons. The sidebar is a drawer you have to open, and a search you have to
// open a drawer to reach is one you stop using; and the sidebar's own shape is
// still an open question (the roadmap's sidebar reform), so putting a new
// permanent thing in it would be building on a floor somebody is about to lift.
// A palette owns the top of the screen for as long as it is up and then gives
// it back.
//
// The answer to a query is a *place*, not a row. Picking a result selects the
// item and flies the viewport to it, because on a spatial board "where is it"
// and "what is it" are the same question - a list of names with no positions
// would tell you the thing exists, which you already suspected.

import { board, byId, itemTags, select } from '../state.ts';
import { travelMs } from '../canvas/viewport.ts';
import { extOf } from '../util.ts';
import { describeExt } from '../import/formats.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { Item } from '../board-model.ts';

/** Rows drawn at once. Past this the answer is "narrow it", not "scroll". */
const MAX_HITS = 12;
/** How much of a note's text a row shows around the match. */
const SNIPPET = 90;

/** What one item offers a query, flattened - see fields() below. */
type Fields = {
  name: string,
  text: string,
  url: string,
  kind: string,
  kindLabel: string,
  tags: string[],
};

/** One answer: the item, what was matched against, and how well. */
type Hit = { item: Item, f: Fields, s: number };

// The palette's three nodes exist exactly while it is open, and close() drops
// all three together. Everything below run() is only ever reached from an event
// on one of them or from open() itself, which is why they are read with `!`
// there rather than guarded a second time.
let vp: Viewport | null = null;
let node: HTMLElement | null = null;      // the palette, or null when closed
let field: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let hits: Hit[] = [];
let at = 0;           // index of the highlighted row

export function initSearch(viewport: Viewport) {
  vp = viewport;

  // Capture, so this beats the canvas's own key handling rather than racing
  // it - canvas/input.js binds Ctrl+A, Ctrl+D and the arrows on the same
  // window, and a search that only opened when the canvas happened not to
  // want the key would be a search that opened sometimes.
  addEventListener('keydown', e => {
    // Cmd on a Mac, Ctrl everywhere else. metaKey is not folded into one test
    // with ctrlKey, because Ctrl+K on a Mac is "delete to end of line" in every
    // text field on the system and taking it would be rude.
    const hotkey = e.key === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey;
    if (hotkey) {
      e.preventDefault();
      e.stopPropagation();
      node ? close() : open();
      return;
    }
    if (!node) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commit(hits[at]);
    }
  }, true);

  // Anything that makes the board move out from under the answers.
  addEventListener('pointerdown', e => {
    if (node && !node.contains(e.target as Node | null)) close();
  }, true);
  addEventListener('wheel', () => close(), { passive: true });
  addEventListener('blur', () => close());
}

export function open() {
  if (node) { field!.select(); return; }

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
  // A combobox that owns a listbox, which is what this is. Without the role
  // pair a screen reader announces a text field and then silently swaps the
  // rows underneath it.
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
  run('');
}

export function close() {
  node?.remove();
  node = null;
  field = null;
  list = null;
  hits = [];
  at = 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Everything about an item that is worth asking about, flattened.
 *
 * Built per query rather than kept as an index. A board is hundreds of items,
 * not hundreds of thousands, and a stale index is a class of bug this does not
 * need to have: items are renamed, notes are typed into, links are pasted and
 * covers are set, and every one of those would have to remember to invalidate.
 * Rebuilding is a few hundred string reads against a keystroke's worth of time.
 */
function fields(item: Item): Fields {
  const name = item.name || '';
  const meta = item.meta || {};
  // A note's name *is* its first line, so searching both would score it twice
  // for one match. The body is what the name does not already cover.
  // `meta` is open, so a note's body is narrowed here rather than trusted.
  const body = typeof meta.text === 'string' ? meta.text : '';
  const text = item.type === 'note' ? afterFirstLine(body) : '';
  const url = typeof meta.url === 'string' ? meta.url : '';
  const kind = describeExt(extOf(name));
  return {
    name,
    text,
    url,
    // "what is this" in words: the item type, plus what the catalogue calls
    // the extension - so "solidworks", "raw" and "subtitles" find things whose
    // names say none of that.
    kind: [item.type, kind?.label, kind?.categoryLabel, extOf(name)].filter(Boolean).join(' '),
    // The same knowledge said out loud. Kept apart from `kind` because that
    // one is a bag of words to match against and reads like one - "audio
    // Waveform audio Sound" is a fine haystack and a terrible caption.
    kindLabel: kind ? [kind.label, kind.categoryLabel].filter(Boolean).join(' · ') : '',
    // Already lowercased and already clean - itemTags() does both - so nothing
    // here has to fold case the way the four fields above do.
    tags: itemTags(item),
  };
}

const afterFirstLine = (s: string) => {
  const i = s.indexOf('\n');
  return i < 0 ? '' : s.slice(i + 1);
};

/**
 * Score one item against a lowercased query, or 0 for no match.
 *
 * Ordered by how much the match tells you it is the thing you meant. A name
 * that starts with what you typed is almost certainly it; a name that merely
 * contains it is probably it; a word buried in a note is a maybe; and the file
 * kind is last, because "image" matches half the board and is a filter rather
 * than an identification.
 *
 * A tag scores second, above everything but the name, and that placing is the
 * whole argument for tags being searchable at all: a tag is the one field on an
 * item that somebody typed *in order to find it again*. An exact one beats a
 * name that merely contains the query, because typing a whole tag is a
 * deliberate act and nothing else in the list is.
 */
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
    draw(q);
    return;
  }

  hits = board.items
    .map(item => {
      const f = fields(item);
      return { item, f, s: score(f, q) };
    })
    .filter(h => h.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_HITS);

  draw(q);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw(q: string) {
  list!.replaceChildren();
  field!.setAttribute('aria-expanded', String(hits.length > 0));

  if (!q) {
    list!.append(note('Type to find anything on the board — a name, a note, an address, a kind of file.'));
    return;
  }
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
    kind.textContent = h.item.type;

    const name = document.createElement('span');
    name.className = 'search-name';
    name.textContent = h.f.name || '(unnamed)';

    const where = document.createElement('span');
    where.className = 'search-where';
    where.textContent = context(h.f, q);

    row.append(kind, name, where);
    // Selecting on hover would fight the keyboard: an arrow key moves the
    // highlight, the pointer happens to be resting over row four, and the
    // highlight jumps back the moment anything reflows.
    row.addEventListener('click', () => commit(h));
    list!.append(row);
  });

  field!.setAttribute('aria-activedescendant', 'search-hit-' + at);
}

/** The line under a name: where the match actually was. */
function context(f: Fields, q: string) {
  if (f.name.toLowerCase().includes(q)) return '';
  if (f.url.toLowerCase().includes(q)) return f.url;
  const i = f.text.toLowerCase().indexOf(q);
  if (i >= 0) {
    // Windowed on the match rather than taken from the start, so searching a
    // word that appears on line nine of a note shows line nine.
    const from = Math.max(0, i - SNIPPET / 3);
    const cut = f.text.slice(from, from + SNIPPET).replace(/\s+/g, ' ').trim();
    return (from > 0 ? '…' : '') + cut + (from + SNIPPET < f.text.length ? '…' : '');
  }
  // Only reachable when the match was on the kind, so this line is the answer
  // to "why is this here" rather than a repeat of the badge beside it.
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

/**
 * Take the answer: select the item and go there.
 *
 * The palette closes first. It sits over the top of the canvas, and flying to
 * an item only to leave it underneath the thing you searched from would be a
 * strange kind of arrival.
 *
 * byId() again rather than trusting the item captured at query time, because a
 * board can change between typing and pressing Enter - an autosave sweep, an
 * undo, a delete from the other end of a rename. A result that no longer names
 * anything simply does nothing.
 */
function commit(hit: Hit | undefined) {
  if (!hit) return;
  const id = hit.item.id;
  close();
  const item = byId(id);
  if (!item) return;
  select([id]);
  vp!.fit([item], 120, travelMs());
}
