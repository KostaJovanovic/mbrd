// Fountain screenplays (.fountain) to the editor's document and back, and the
// rules a screenplay is typed by. Each line of the file is one block of kind
// 'sp' holding its element; the marks Fountain forces an element with are
// taken off on reading and written back only where the element would not be
// recognised without one. Round trip is the contract, as in markdown.ts: a line
// no edit has replaced is written back exactly as it was read. DOM-free.

import { unwrap } from './markdown.ts';
import { runsText, splitBlock, blockLen, ordered, samePos, isText } from './model.ts';
import type { Block, Doc, Edit, Pos, Run, SceneEl, Screen } from './model.ts';

/** The line each block was read from. Absent for a block an edit made. */
const SOURCE = new WeakMap<Block, string>();

/** A line that opens a scene, as Fountain reads one: the marker in any case, then a dot or a space. */
export const SCENE = /^(?:int\.?\/ext|int\/ext|i\/e|int|ext|est)[. ]/i;
/** The same marker just typed, ended by its space: `int. ` or `ext `. */
const SCENE_TYPED = /^(?:int\.?\/ext|int\/ext|i\/e|int|ext|est)\.? $/i;
const NOTE = /^\s*\[\[.*\]\]\s*$/;
const PAGE_BREAK = /^={3,}\s*$/;
const TITLE_KEY = /^[A-Za-z][A-Za-z ]*:/;

/** Capitals throughout, as a name and a transition are written. An extension in brackets, `(cont'd)`, may be in any case. */
const caps = (t: string) => {
  const name = t.replace(/\([^)]*\)/g, '');
  return /\p{L}/u.test(name) && name === name.toUpperCase();
};
const isTransition = (t: string) => caps(t) && /TO:$/.test(t.trim());
const isParen = (t: string) => /^\s*\(.*\)\s*$/.test(t);
/** A line that would open a character's speech if lines followed it with no blank between. */
const isCharacter = (line: string) =>
  line.startsWith('@') || (caps(line.replace(/\^\s*$/, '')) && !SCENE.test(line) && !isTransition(line) && !/^[!.>~=#[/]/.test(line));

/** The elements as the menu lists them, with their Ctrl+Alt digit. */
export const ELEMENTS: readonly { el: SceneEl, label: string, key?: string }[] = [
  { el: 'scene', label: 'Scene heading', key: '1' },
  { el: 'action', label: 'Action', key: '2' },
  { el: 'character', label: 'Character', key: '3' },
  { el: 'paren', label: 'Parenthetical', key: '4' },
  { el: 'dialogue', label: 'Dialogue', key: '5' },
  { el: 'transition', label: 'Transition', key: '6' },
  { el: 'centered', label: 'Centred', key: '7' },
  { el: 'section', label: 'Section', key: '8' },
  { el: 'synopsis', label: 'Synopsis' },
  { el: 'note', label: 'Note' },
  { el: 'lyric', label: 'Lyric' },
];

/** Elements written in capitals: what is typed into one is capitalised as it goes. */
export const CAPS: ReadonlySet<SceneEl> = new Set<SceneEl>(['scene', 'character', 'transition']);
const SPEECH: ReadonlySet<SceneEl> = new Set<SceneEl>(['paren', 'dialogue']);

export function sp(el: SceneEl, text = '', before: string[] = [''], extra: { dual?: boolean, level?: number } = {}): Screen {
  return { kind: 'sp', el, dual: extra.dual ?? false, level: extra.level ?? 0, before, runs: text ? [{ text }] : [] };
}

/** Whether `el` straight after `prev` is part of one speech, written with no blank line between. */
const inSpeech =(prev: Block | undefined, el: SceneEl) =>
  SPEECH.has(el) && prev?.kind === 'sp' && (prev.el === 'character' || SPEECH.has(prev.el));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function character(name: string): Screen {
  const dual = /\^\s*$/.test(name);
  return sp('character', name.replace(/\s*\^\s*$/, '').trim(), [''], { dual });
}

/** A line outside a speech: its forcing mark first, then what its words say it is. */
function readLine(line: string): Block {
  const t = line.trim();
  if (PAGE_BREAK.test(line)) return { kind: 'rule', before: [] };
  if (line.startsWith('!')) return sp('action', line.slice(1));
  if (/^\.[^.]/.test(line)) return sp('scene', line.slice(1));
  if (line.startsWith('@')) return character(line.slice(1));
  if (/^>.*<$/.test(t)) return sp('centered', t.slice(1, -1).trim());
  if (line.startsWith('>')) return sp('transition', line.slice(1).trim());
  if (line.startsWith('~')) return sp('lyric', line.slice(1));
  if (line.startsWith('=')) return sp('synopsis', line.slice(1).trim());
  const section = /^(#+)\s*(.*)$/.exec(line);
  if (section) return sp('section', section[2], [''], { level: section[1].length });
  if (NOTE.test(line)) return sp('note', t.slice(2, -2));
  if (SCENE.test(line)) return sp('scene', line);
  if (isTransition(line)) return sp('transition', t);
  return sp('action', line);
}

/**
 * A .fountain file as a document. A title page at the top and a boneyard
 * (`/* … *\/`) are kept as raw blocks, shown as written and never edited.
 * Emphasis and inline notes stay in the words as the characters they are.
 */
export function parseFountain(src: string): Doc {
  const { text, eol, bom } = unwrap(src);
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let before: string[] = [];
  const add = (b: Block, line: string) => {
    b.before = before;
    SOURCE.set(b, line);
    blocks.push(b);
    before = [];
  };
  let i = 0;
  if (TITLE_KEY.test(lines[0] ?? '') && !SCENE.test(lines[0])) {
    while (i < lines.length && lines[i].trim()) i++;
    const raw = lines.slice(0, i).join('\n');
    add({ kind: 'raw', before: [], text: raw }, raw);
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { before.push(line); i++; continue; }
    if (line.trimStart().startsWith('/*')) {
      let end = i;
      while (end < lines.length - 1 && !lines[end].includes('*/')) end++;
      const raw = lines.slice(i, end + 1).join('\n');
      add({ kind: 'raw', before: [], text: raw }, raw);
      i = end + 1;
      continue;
    }
    // A paragraph: lines to the next blank one. Two spaces alone are a line inside it, not a break.
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() || lines[end] === '  ')) end++;
    const group = lines.slice(i, end);
    if (group.length > 1 && isCharacter(group[0])) {
      add(character(group[0].replace(/^@/, '')), group[0]);
      for (const l of group.slice(1)) add(isParen(l) ? sp('paren', l.trim()) : sp('dialogue', l), l);
    } else for (const l of group) add(readLine(l), l);
    i = end;
  }
  if (!blocks.length) blocks.push(sp('action', '', []));
  return { blocks, tail: before, eol, bom, plain: true };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * One edited line as Fountain, with a forcing mark only where the element
 * would not be recognised without it - where it is, and where the lines round
 * it are, being what Fountain reads an element from.
 */
function lineOf(blocks: Block[], n: number): string {
  const b = blocks[n];
  if (b.kind === 'rule') return '===';
  if (b.kind === 'raw') return b.text;
  if (b.kind !== 'sp') return isText(b) ? runsText(b.runs) : '';
  const t = runsText(b.runs);
  const next = blocks[n + 1];
  // The line under this one is written straight after it, in the same paragraph.
  const joined = !!next && !next.before.length;
  const opens = n === 0 || b.before.length > 0;
  switch (b.el) {
    case 'scene': return (SCENE.test(t) ? '' : '.') + t;
    case 'character': {
      const known = caps(t) && !SCENE.test(t) && !isTransition(t) && !/^[!@.>~=#[/]/.test(t) && joined;
      return (known ? '' : '@') + t + (b.dual ? ' ^' : '');
    }
    case 'paren': return isParen(t) ? t.trim() : `(${t.trim()})`;
    case 'dialogue': return t;
    case 'transition': return isTransition(t) && !joined ? t.trim() : '> ' + t.trim();
    case 'centered': return `> ${t.trim()} <`;
    case 'lyric': return '~' + t;
    case 'section': return '#'.repeat(Math.max(1, b.level)) + ' ' + t.trim();
    case 'synopsis': return '= ' + t.trim();
    case 'note': return `[[${t}]]`;
    case 'action': {
      const misread = SCENE.test(t) || isTransition(t) || /^[!@>~=#]/.test(t) || /^\.[^.]/.test(t)
        || NOTE.test(t) || PAGE_BREAK.test(t) || t.trimStart().startsWith('/*')
        || (opens && joined && caps(t))
        || (n === 0 && TITLE_KEY.test(t));
      return (misread ? '!' : '') + t;
    }
  }
}

/** The document as a .fountain file: kept lines as they were read, edited ones in the plainest spelling. */
export function serializeFountain(doc: Doc): string {
  const out: string[] = [];
  doc.blocks.forEach((b, n) => {
    const src = SOURCE.get(b);
    // A line emptied and left is not a line of the script.
    if (src === undefined && isText(b) && !runsText(b.runs)) return;
    out.push(...b.before, ...(src ?? lineOf(doc.blocks, n)).split('\n'));
  });
  out.push(...doc.tail);
  return (doc.bom ? '﻿' : '') + out.join(doc.eol);
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

/** What Enter at the end of an element makes next, the way screenwriting tools do it. */
export function nextElement(el: SceneEl): SceneEl {
  if (el === 'character' || el === 'paren') return 'dialogue';
  if (el === 'transition') return 'scene';
  if (el === 'lyric') return 'lyric';
  return 'action';
}

const TAB: Record<SceneEl, SceneEl> = {
  action: 'character', character: 'transition', transition: 'scene', scene: 'action',
  dialogue: 'paren', paren: 'dialogue', centered: 'action', lyric: 'action', section: 'action', synopsis: 'action', note: 'action',
};
const TAB_BACK: Record<SceneEl, SceneEl> = {
  action: 'scene', scene: 'transition', transition: 'character', character: 'action',
  dialogue: 'paren', paren: 'dialogue', centered: 'action', lyric: 'action', section: 'action', synopsis: 'action', note: 'action',
};
/** Tab and Shift+Tab: the element a line turns into next. */
export const cycleElement = (el: SceneEl, back: boolean): SceneEl => (back ? TAB_BACK : TAB)[el];

const upper = (runs: Run[]): Run[] => runs.map(r => ({ ...r, text: r.text.toUpperCase() }));

/** Line `n` made an `el`: its case and its spacing follow, and so does the line under it if that is speech. */
function retypeLine(doc: Doc, n: number, el: SceneEl): Doc {
  const b = doc.blocks[n];
  if (b?.kind !== 'sp') return doc;
  let runs = CAPS.has(el) ? upper(b.runs) : b.runs;
  if (el === 'paren' && !isParen(runsText(runs))) {
    const inner = runsText(runs).replace(/^\s*\(?/, '').replace(/\)?\s*$/, '');
    runs = [{ text: `(${inner})` }];
  }
  const before = n === 0 ? b.before : inSpeech(doc.blocks[n - 1], el) ? [] : b.before.length ? b.before : [''];
  const line: Screen = { ...b, el, runs, before, dual: el === 'character' && b.dual, level: el === 'section' ? Math.max(1, b.level) : 0 };
  const blocks = doc.blocks.slice();
  blocks[n] = line;
  const after = blocks[n + 1];
  if (after?.kind === 'sp' && SPEECH.has(after.el)) {
    const joins = inSpeech(line, after.el);
    if (joins === !!after.before.length) blocks[n + 1] = { ...after, before: joins ? [] : [''] };
  }
  return { ...doc, blocks };
}

/** Every line in the selection made an `el`. A line made a parenthetical gets its brackets, the caret inside them. */
export function setElement(doc: Doc, from: Pos, to: Pos, el: SceneEl): Edit {
  const [a, z] = ordered(from, to);
  let next = doc;
  for (let n = a.b; n <= z.b; n++) next = retypeLine(next, n, el);
  const was = doc.blocks[a.b];
  const now = next.blocks[a.b];
  // Brackets added: the caret moves in past the opening one and stays short of the closing one.
  const wrapped = !!was && !!now && el === 'paren' && blockLen(now) === blockLen(was) + 2;
  const clamp = (p: Pos): Pos => {
    const len = blockLen(next.blocks[p.b]);
    return p.b === a.b && wrapped ? { b: p.b, o: Math.min(p.o + 1, len - 1) } : { b: p.b, o: Math.min(p.o, len) };
  };
  return { doc: next, from: clamp(a), to: clamp(z) };
}

/**
 * Enter in a screenplay. At the end of a line it opens the element that comes
 * next - a character's name gives dialogue, dialogue gives action. A line of
 * capitals was a name; one ending `TO:` a transition. An empty line that is not
 * action steps out to action, as Enter on an empty list item leaves the list.
 * Shift+Enter, or Enter in the middle of a line, breaks it and keeps its element.
 */
export function screenEnter(doc: Doc, from: Pos, to: Pos, soft: boolean): Edit {
  const [a, z] = ordered(from, to);
  const b = doc.blocks[a.b];
  if (b?.kind !== 'sp') {
    if (!b || isText(b)) return splitBlock(doc, from, to);
    // After a title page, a boneyard or a page break: a line of action, not a paragraph of Markdown.
    const blocks = doc.blocks.slice();
    blocks.splice(a.b + 1, 0, sp('action'));
    const next = { b: a.b + 1, o: 0 };
    return { doc: { ...doc, blocks }, from: next, to: next };
  }
  const text = runsText(b.runs);
  if (!soft && !text && b.el !== 'action' && samePos(a, z)) return { doc: retypeLine(doc, a.b, 'action'), from: a, to: a };
  const atEnd = a.b === z.b && z.o >= text.length;
  let d = doc;
  let el = b.el;
  if (!soft && atEnd && el === 'action' && text.trim()) {
    if (isTransition(text)) el = 'transition';
    else if (caps(text) && !SCENE.test(text)) el = 'character';
    if (el !== 'action') d = retypeLine(d, a.b, el);
  }
  const e = splitBlock(d, a, z);
  if (soft || !atEnd) return e;
  const n = e.from.b;
  const made = e.doc.blocks[n];
  if (made?.kind !== 'sp') return e;
  const want = nextElement(el);
  const line: Screen = { ...made, el: want, dual: false, level: 0, runs: [], before: inSpeech(e.doc.blocks[n - 1], want) ? [] : [''] };
  const blocks = e.doc.blocks.slice();
  blocks[n] = line;
  return { doc: { ...e.doc, blocks }, from: { b: n, o: 0 }, to: { b: n, o: 0 } };
}

/**
 * A screenplay formatting itself as it is typed: `INT. ` or `EXT. ` opening an
 * action line makes it a scene heading, and `(` on an empty dialogue line a
 * parenthetical. Null when what was typed is neither.
 */
export function screenShortcut(doc: Doc, at: Pos): Edit | null {
  const b = doc.blocks[at.b];
  if (b?.kind !== 'sp') return null;
  const words = runsText(b.runs);
  if (b.el === 'action' && SCENE_TYPED.test(words.slice(0, at.o))) {
    return { doc: retypeLine(doc, at.b, 'scene'), from: at, to: at };
  }
  if (b.el === 'dialogue' && words === '(' && at.o === 1) {
    const inside = { b: at.b, o: 1 };
    return { doc: retypeLine(doc, at.b, 'paren'), from: inside, to: inside };
  }
  return null;
}

/** Ctrl+D: the speech the caret is in set beside the one before it, or back again. */
export function toggleDual(doc: Doc, at: Pos): Doc {
  let n = at.b;
  for (let b = doc.blocks[n]; b?.kind === 'sp' && SPEECH.has(b.el) && n > 0; b = doc.blocks[n]) n--;
  const b = doc.blocks[n];
  if (b?.kind !== 'sp' || b.el !== 'character') return doc;
  const blocks = doc.blocks.slice();
  blocks[n] = { ...b, dual: !b.dual };
  return { ...doc, blocks };
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Characters a line of each element holds on a standard page (Courier 12, ten to the inch). Zero: not printed. */
const WIDTH: Record<SceneEl, number> = {
  action: 61, scene: 61, transition: 61, centered: 61, character: 38, dialogue: 35, lyric: 35, paren: 26,
  section: 0, synopsis: 0, note: 0,
};
/** Lines on a standard screenplay page. */
const LINES_PER_PAGE =55;

/**
 * How long the script would print, as an estimate from the standard layout -
 * every element wrapped at its width, a blank line before each paragraph, 55
 * lines a page - and how many scenes it has. The title page is not counted.
 */
export function screenStats(doc: Doc): { pages: number, scenes: number } {
  let lines = 0;
  let scenes = 0;
  for (const b of doc.blocks) {
    if (b.kind === 'rule') { lines = Math.ceil(lines / LINES_PER_PAGE) * LINES_PER_PAGE; continue; }
    if (b.kind !== 'sp' || !WIDTH[b.el]) continue;
    if (b.el === 'scene') scenes++;
    if (b.before.length) lines++;
    lines += Math.max(1, Math.ceil(runsText(b.runs).length / WIDTH[b.el]));
  }
  return { pages: Math.max(1, Math.ceil(lines / LINES_PER_PAGE)), scenes };
}
