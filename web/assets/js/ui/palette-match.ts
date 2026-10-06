// How the S box (ui/palette.ts) finds and orders its rows. Pure - menu rows and
// words in, rows out - so tests/palette.test.js holds the ranking with no page.
// A row matches when every word typed starts a word of its name, of where it
// lives, or of what that word is also called; or when the letters typed are
// its initials. Never a loose subsequence: "sg" is Snap to grid, not every row
// with an s before a g.

import type { MenuEntry } from './menu.ts';

/** One row the box can show: the entry, where it lives, and how near the context it is. */
export type Row = {
  entry: MenuEntry,
  /** Where it lives, outermost first: ["Selection", "Picture"]. */
  path: string[],
  /** How close to what is in hand: the selection's rows above the app's. */
  weight: number,
  /** Words it answers to that are on screen elsewhere, a tool's short name. */
  also?: string,
  /** One of a set of choices inside its parent (a colour, a layout), not a command of its own. */
  choice?: boolean,
  /** Stable across opens, for the recent list: labels with their counts taken out. */
  key: string,
};

/** Lower case, accents off, `&` as "and", everything else that is not a letter or digit a space. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const words = (text: string) => (text ? fold(text).split(' ').filter(Boolean) : []);

export const rowKey = (path: string[], label: string) => fold([...path, label].join(' ')).replace(/\d+/g, '#');

/**
 * Every row of a menu, folds laid out flat - the search menu has no page to
 * drill into, so a fold's rows carry its name in their path instead. What a
 * menu hides, a rule, a readout and a Back row are left out.
 */
export function flatten(entries: MenuEntry[], path: string[], weight: number, choice = false): Row[] {
  const out: Row[] = [];
  for (const e of entries) {
    if (e.hidden || e.sep || e.disabled || e.to || !e.label) continue;
    if (e.sub) { out.push(...flatten(e.sub, [...path, e.label], weight, true)); continue; }
    if (!e.action && !e.range) continue;
    out.push({ entry: e, path, weight, choice, key: rowKey(path, e.label) });
  }
  return out;
}

/**
 * What a word typed is also called in the labels, for the words people reach
 * for that this app does not use: a fence is its group, an anchor its lock, a
 * line its connection. American spellings too, since the labels are British.
 * Each alternative is a phrase, and every word of it has to be in the name.
 */
const ALSO: Record<string, string[]> = {
  group: ['fence'], ungroup: ['remove fence'], frame: ['fence'], region: ['fence'], area: ['fence'],
  lock: ['anchor'], unlock: ['unanchor'], pin: ['anchor'], unpin: ['unanchor'],
  connect: ['join', 'connection'], link: ['join', 'connection'], arrow: ['arrow', 'connection'],
  line: ['connection', 'join'], wire: ['join'], edge: ['connection'],
  delete: ['delete', 'remove'], remove: ['delete', 'remove'], erase: ['delete'], trash: ['delete'], bin: ['delete'],
  crop: ['edit picture'], adjust: ['edit picture'], grade: ['edit picture'], filter: ['edit picture', 'filter'],
  rotate: ['rotate', 'edit picture'], turn: ['rotate', 'upright'], flip: ['edit picture', 'upright'],
  color: ['colour'], colors: ['colour', 'palette'], center: ['centre'], gray: ['grey'],
  optimize: ['optimise'], organize: ['arrange'], organise: ['arrange'], tidy: ['arrange', 'nudge'],
  theme: ['palette', 'whimsy'], style: ['style', 'palette', 'whimsy'], dark: ['palette'], light: ['palette'],
  look: ['palette', 'whimsy'], font: ['type', 'face'], typeface: ['type'],
  layout: ['arrange', 'layout'], sort: ['arrange'], grid: ['grid'], masonry: ['masonry'],
  spread: ['distribute'], space: ['spacing', 'distribute'], overlap: ['nudge'], separate: ['nudge'],
  sticky: ['note'], postit: ['note'], memo: ['note'], text: ['note', 'text'],
  image: ['picture'], photo: ['picture'], img: ['picture'], pic: ['picture'],
  zoom: ['zoom', 'fit'], home: ['0 0', 'recentre'], reset: ['reset'],
  download: ['save', 'export'], export: ['export', 'save'], print: ['pdf'],
  share: ['share', 'send'], send: ['send', 'share'], clone: ['duplicate'], copy: ['copy', 'duplicate'],
  search: ['find'], label: ['label', 'tag'], tags: ['tag'],
  hide: ['roll up', 'hide'], collapse: ['roll up'], fold: ['roll up'], expand: ['roll down'],
  view: ['open'], preview: ['open'], show: ['show', 'open'], rename: ['rename', 'name'],
  raise: ['front'], top: ['front', 'top'], lower: ['back'], bottom: ['back', 'bottom'],
  tex: ['latex'], math: ['latex'], equation: ['latex'],
  audio: ['sound', 'player', 'playlist'], volume: ['volume', 'sound'], mute: ['sound'], music: ['playlist', 'player'],
  speed: ['quality'], performance: ['quality'], slow: ['quality'], fast: ['quality'],
  slideshow: ['tour'], present: ['tour'], presentation: ['tour'],
  history: ['timeline', 'undo'], version: ['timeline', 'patch notes'], changelog: ['patch notes'],
  resize: ['size'], scale: ['scale', 'size'], measure: ['units', 'paper'], ruler: ['units'], page: ['paper'],
  settings: ['settings'], preferences: ['settings'], options: ['settings'], help: ['shortcuts'], keys: ['shortcuts'],
  select: ['select'], pick: ['select'], everything: ['all'],
};

/** A word typed against one word on a row: 3 when it starts it, 1.5 inside it, else 0. */
function against(t: string, w: string): number {
  if (w.startsWith(t)) return w.length === t.length ? 3.5 : 3;
  return t.length >= 3 && w.includes(t) ? 1.5 : 0;
}

const best = (t: string, ws: string[]) => ws.reduce((m, w) => Math.max(m, against(t, w)), 0);

/** Every letter of `q` in `s`, in order. */
function inOrder(q: string, s: string): boolean {
  let at = 0;
  for (const ch of s) if (ch === q[at]) at += 1;
  return at >= q.length;
}

/** Every word of a phrase starts a word of `ws`. */
const phraseIn = (phrase: string, ws: string[]) => phrase.split(' ').every(p => ws.some(w => w.startsWith(p)));

/** One typed word against a row's name, then its other names, then its place. */
function token(t: string, name: string[], also: string[], place: string[]): number {
  const own = best(t, name);
  if (own) return own;
  if ((ALSO[t] ?? []).some(p => phraseIn(p, name))) return 2.5;
  const alt = best(t, also);
  if (alt) return alt * 0.8;
  const where = best(t, place);
  if (where) return where / 3;
  return (ALSO[t] ?? []).some(p => phraseIn(p, place)) ? 0.8 : 0;
}

/**
 * How well `query` names a row, 0 for not at all. Above zero only when every
 * word typed is accounted for. A plural is tried as its singular as well.
 */
export function score(query: string, label: string, path: string[] = [], alsoText = ''): number {
  const q = fold(query);
  if (!q) return 1;
  const name = words(label);
  const also = words(alsoText);
  const place = words(path.join(' '));
  let total = 0;
  for (const t of q.split(' ')) {
    const s = Math.max(token(t, name, also, place),
      t.length > 3 && t.endsWith('s') ? token(t.slice(0, -1), name, also, place) : 0);
    if (!s) { total = 0; break; }
    total += s;
  }
  // The letters typed as the name's initials, in order and from the first,
  // small words skippable: "stg" and "sg" for Snap to grid.
  if (!q.includes(' ') && q.length >= 2) {
    const initials = name.map(w => w[0]).join('');
    if (initials.startsWith(q)) total = Math.max(total, 2 + q.length);
    else if (q[0] === initials[0] && inOrder(q, initials)) total = Math.max(total, 1.5 + q.length * 0.8);
  }
  if (!total) return 0;
  const whole = fold(label);
  if (whole === q) total += 5;
  else if (whole.startsWith(q)) total += 3;
  // A short name says less else, so it is the better answer of two equal ones.
  return total - name.length * 0.05;
}

/**
 * The rows for `query`, best first. Context counts - the selection's rows
 * outrank the same match among the settings - and so does having been used:
 * `recent` is keys, most recent first. An empty query is the recent rows that
 * still apply, then the context's own rows in the order its menu gives them.
 */
export function rank(rows: Row[], query: string, recent: string[] = [], limit = 40): Row[] {
  const used = new Map(recent.map((k, i) => [k, i]));
  if (!fold(query)) {
    const again = rows.filter(r => used.has(r.key)).sort((a, b) => used.get(a.key)! - used.get(b.key)!);
    const top = Math.max(...rows.map(r => r.weight), 0);
    const here = rows.filter(r => r.weight === top && !used.has(r.key));
    return [...again, ...here].slice(0, limit);
  }
  const scored: { row: Row, s: number }[] = [];
  for (const row of rows) {
    const s = score(query, row.entry.label ?? '', row.path, row.also);
    if (!s) continue;
    const at = used.get(row.key);
    scored.push({ row, s: s * (1 + 0.2 * row.weight) + (at === undefined ? 0 : Math.max(0, 2 - at * 0.25)) });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.row);
}

/**
 * One row per command where several places offer it. A command of its own is
 * known by its name alone - Select all from the board's menu and from the
 * app's is one thing - and the nearer one wins. A choice keeps its parent with
 * it: Warm under a note's Colour and Warm under the Note tool are two acts.
 */
export function dedupe(rows: Row[]): Row[] {
  const kept = new Map<string, Row>();
  for (const row of rows) {
    const label = fold(row.entry.label ?? '');
    const id = row.choice ? `${label}|${fold(row.path[row.path.length - 1] ?? '')}` : label;
    const had = kept.get(id);
    if (!had || row.weight > had.weight) kept.set(id, row);
  }
  return [...kept.values()];
}
