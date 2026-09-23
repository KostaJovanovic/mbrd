// The text editor on screen: the document model (model.ts) rendered into a
// contenteditable page, a fixed bar of formatting above it, and a find bar.
// Typing is done on the model and patched into the page; only an IME or a
// phone keyboard mid-word types into the page itself, and that is read back
// when the word ends. Vomit Mode's lock (vomit.ts) is asked of every change
// however it arrived. Built from createElement and createTextNode alone - the
// file is foreign - and nothing touches the document at import time.

import {
  insertText, deleteRange, splitBlock, joinBackward, joinForward, toggleMark, hasMark, setHeading,
  toggleList, indent, toggleTask, blockShortcut, fenceShortcut, inlineShortcut, insertBlocks, sliceDoc,
  findAll, replaceMatch, replaceAll, wordCount, marksAt, sameMarks, tidy, isText, isAtom, blockLen,
  blockText, ordered, samePos, cmpPos, clampPos, para, withRoom, outlineOf, MATCH_MAX,
} from './model.ts';
import type { Block, Doc, Edit, ListKind, Level, MarkKey, Marks, Match, OutlineEntry, Pos, Run, SceneEl } from './model.ts';
import { parseDoc, parseMarkdown, serializeDoc, posAtSource } from './markdown.ts';
import {
  parseFountain, serializeFountain, screenEnter, screenShortcut, setElement, toggleDual, cycleElement,
  screenStats, ELEMENTS, CAPS,
} from './fountain.ts';
import { keepsLocked, advance, superLock, lockAtEnd, clampToLock, clock, SUPER_MS, VOMIT_MINUTES } from './vomit.ts';
import { makeEditable, markClosed } from '../../util.ts';
import { menuButton, openAnchored } from '../menu.ts';
import type { MenuEntry } from '../menu.ts';

export type EditorOptions = {
  text: string,
  /** A .txt: lines, no formatting. */
  plain: boolean,
  /** A .fountain screenplay: its elements, and the keys that type them. */
  screen?: boolean,
  /** What the page is called, for a screen reader. */
  label: string,
  /** Where the caret starts: a place in the source, or an end. */
  caret?: { line: number, col: number } | 'start' | 'end',
  /** After every change to the document. */
  onChange?: () => void,
  /** Ctrl+S. */
  onSave?: () => void,
};

export type Editor = {
  el: HTMLElement,
  /** The document as the file's text. */
  text: () => string,
  focus: () => void,
  /** Words typed at the caret as if from the keyboard, a newline being Enter. */
  type: (text: string) => void,
  /** Close the find bar if it is open, and say whether it was. */
  closeFind: () => boolean,
  destroy: () => void,
};

/** How long a pause splits one run of typing into two undo steps. */
const TYPING_GAP_MS = 1200;
/** Undo steps the editor keeps. Each is a whole document, shared where unchanged. */
const UNDO_MAX = 500;
/** Matches painted at once. Past this the bar still counts them all. */
const PAINT_MAX = 2000;

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A run as nodes: its words, wrapped once per mark, the link outermost. */
function runNode(r: Run): Node {
  if (r.raw) {
    const s = h('span', 'ed-raw-run', r.text);
    s.contentEditable = 'false';
    return s;
  }
  let node: Node = document.createTextNode(r.text);
  const wrap = (el: HTMLElement) => { el.append(node); node = el; };
  if (r.code) wrap(h('code'));
  if (r.s) wrap(h('s'));
  if (r.i) wrap(h('em'));
  if (r.b) wrap(h('strong'));
  if (r.href) {
    // A link is shown, never followed from here: no href, the address in the title.
    const a = h('span', 'ed-link');
    a.dataset.href = r.href;
    a.title = r.href;
    wrap(a);
  }
  return node;
}

/** A block as one element, the only child of the page that stands for it. */
function buildBlock(b: Block, plain: boolean): HTMLElement {
  let el: HTMLElement;
  switch (b.kind) {
    case 'p': el = h(plain ? 'div' : 'p'); break;
    case 'h': el = h(b.level === 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3'); break;
    case 'quote': el = h('blockquote'); break;
    case 'li':
      el = h('div', 'ed-li');
      el.dataset.list = b.list;
      el.style.setProperty('--depth', String(b.depth));
      if (b.list === 'task') {
        if (b.checked) el.dataset.checked = '';
        const box = h('span', 'ed-box');
        box.contentEditable = 'false';
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(b.checked));
        box.setAttribute('aria-label', 'Done');
        el.append(box);
      }
      break;
    case 'code':
      el = h('pre', 'ed-code');
      if (b.lang) el.dataset.lang = b.lang;
      if (b.text) el.append(document.createTextNode(b.text));
      break;
    case 'rule':
      el = h('div', 'ed-rule');
      el.contentEditable = 'false';
      el.append(h('hr'));
      break;
    case 'raw':
      el = h('pre', 'ed-raw', b.text);
      el.contentEditable = 'false';
      el.title = 'Kept as written';
      break;
    case 'sp':
      // A screenplay's line: its element sets where it sits on the page (editor.css).
      el = h('div', 'ed-sp');
      el.dataset.el = b.el;
      if (b.before.length) el.dataset.gap = '';
      if (b.dual) el.dataset.dual = '';
      if (b.el === 'section') el.dataset.level = String(b.level);
      break;
  }
  el.classList.add('ed-b');
  if (isText(b)) el.append(...b.runs.map(runNode));
  // An empty block needs something to hold its height and the caret, and a
  // block ending in a line break needs one more for that line to show.
  const words = blockText(b);
  if (b.kind !== 'rule' && b.kind !== 'raw' && (!words || words.endsWith('\n'))) el.append(h('br', 'ed-tail'));
  return el;
}

/**
 * Make `a` look like `b` by changing as little of it as possible - a text
 * node's words, an attribute - so the spellchecker and the caret keep their
 * nodes. False when the two are different kinds of node and `a` must be replaced.
 */
function patch(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a instanceof Text && b instanceof Text) {
    if (a.data !== b.data) a.data = b.data;
    return true;
  }
  if (!(a instanceof Element) || !(b instanceof Element)) return true;
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  // A copy: removing from a live attribute list while walking it skips the next one.
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
  const ak = [...a.childNodes], bk = [...b.childNodes];
  bk.forEach((kid, i) => {
    const old = ak[i];
    if (old && patch(old, kid)) return;
    if (old) a.replaceChild(kid, old);
    else a.append(kid);
  });
  for (let i = bk.length; i < ak.length; i++) ak[i].remove();
  return true;
}

// ---------------------------------------------------------------------------
// Reading back what the browser typed
// ---------------------------------------------------------------------------

/** The runs a block element holds now, its looks read off the elements around each word. */
function scanRuns(el: HTMLElement): Run[] {
  const out: Run[] = [];
  const walk = (node: Node, m: Marks) => {
    for (const c of node.childNodes) {
      if (c instanceof Text) { if (c.data) out.push({ ...m, text: c.data }); continue; }
      if (!(c instanceof HTMLElement) || c.tagName === 'BR' || c.classList.contains('ed-box')) continue;
      if (c.classList.contains('ed-raw-run')) { out.push({ ...m, text: c.textContent ?? '', raw: true }); continue; }
      const next = { ...m };
      const tag = c.tagName;
      if (tag === 'STRONG' || tag === 'B') next.b = true;
      if (tag === 'EM' || tag === 'I') next.i = true;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.s = true;
      if (tag === 'CODE') next.code = true;
      if (c.classList.contains('ed-link') && c.dataset.href) next.href = c.dataset.href;
      walk(c, next);
    }
  };
  walk(el, {});
  return tidy(out);
}

const sameRuns = (x: Run[], y: Run[]) =>
  x.length === y.length && x.every((r, n) => r.text === y[n].text && !!r.raw === !!y[n].raw && sameMarks(r, y[n]));

/**
 * The block an element shows now. The same object when nothing in it moved,
 * which is what keeps an untouched block's source lines (markdown.ts).
 */
function readBlock(el: HTMLElement, was: Block | undefined): Block {
  if (!was) return para(scanRuns(el));
  if (isText(was)) {
    const runs = scanRuns(el);
    return sameRuns(runs, was.runs) ? was : { ...was, runs };
  }
  if (was.kind === 'code') {
    const text = [...el.childNodes].map(c => (c instanceof Text ? c.data : '')).join('');
    return text === was.text ? was : { ...was, text };
  }
  return was;
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export function mountEditor(opts: EditorOptions): Editor {
  const screen = !!opts.screen;
  let doc: Doc = screen ? parseFountain(opts.text) : withRoom(parseDoc(opts.text, opts.plain));
  const plain = opts.plain || screen;
  /** The document as its file says it. */
  const write = (d: Doc) => (screen ? serializeFountain(d) : serializeDoc(d));

  const root = h('div', 'ed');
  if (screen) root.classList.add('is-screen');
  else if (plain) root.classList.add('is-plain');
  const scroller = h('div', 'ed-scroll');
  const page = h('div', 'ed-page');
  makeEditable(page);
  page.spellcheck = true;
  page.setAttribute('role', 'textbox');
  page.setAttribute('aria-multiline', 'true');
  page.setAttribute('aria-label', opts.label);
  scroller.append(page);

  /** The block each child of the page was built for. */
  const shown = new WeakMap<Element, Block>();

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  const blockEl = (n: number) => {
    const el = page.children[n];
    return el instanceof HTMLElement ? el : undefined;
  };
  /** The page's children, each one block. */
  const blockEls = () => Array.from(page.children).filter(el => el instanceof HTMLElement);

  /** A DOM place as a document position, measured in the document `against`. */
  const posOf = (node: Node, off: number, against = doc): Pos => {
    if (node === page) {
      const n = Math.min(off, against.blocks.length - 1);
      return off >= against.blocks.length ? { b: n, o: blockLen(against.blocks[n]) } : { b: n, o: 0 };
    }
    let top: Node | null = node;
    while (top && top.parentNode !== page) top = top.parentNode;
    if (!(top instanceof HTMLElement)) return { b: 0, o: 0 };
    const b = Array.prototype.indexOf.call(page.children, top);
    const r = document.createRange();
    r.setStart(top, 0);
    r.setEnd(node, off);
    return clampPos(against, { b, o: r.toString().length });
  };

  /**
   * The DOM place for `o` characters into a block. Between two runs it takes
   * the end of the first; never inside a raw run, which cannot hold a caret.
   */
  const pointAt = (el: HTMLElement, o: number): [Node, number] => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let p = o;
    let last: Text | null = null;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!(text instanceof Text)) continue;
      const raw = text.parentElement?.closest('.ed-raw-run');
      if (raw) {
        const at = Array.prototype.indexOf.call(raw.parentNode!.childNodes, raw);
        if (p <= 0) return [raw.parentNode!, at];
        if (p <= text.length) return [raw.parentNode!, at + 1];
        p -= text.length;
        continue;
      }
      if (p <= text.length) return [text, p];
      p -= text.length;
      last = text;
    }
    if (last) return [last, last.length];
    const box = el.querySelector(':scope > .ed-box');
    return [el, box ? 1 : 0];
  };

  /** The selection as document positions, or null when it is not in the page. */
  const readSel = (against = doc): { anchor: Pos, focus: Pos } | null => {
    const s = getSelection();
    if (!s?.anchorNode || !s.focusNode || !page.contains(s.anchorNode) || !page.contains(s.focusNode)) return null;
    return { anchor: posOf(s.anchorNode, s.anchorOffset, against), focus: posOf(s.focusNode, s.focusOffset, against) };
  };

  /** Where the selection last was in the page - what a toolbar press acts on. */
  let lastSel: [Pos, Pos] = [{ b: 0, o: 0 }, { b: 0, o: 0 }];
  const range = (): [Pos, Pos] => {
    const s = readSel();
    if (s) lastSel = ordered(s.anchor, s.focus);
    return [clampPos(doc, lastSel[0]), clampPos(doc, lastSel[1])];
  };

  const setSel = (from: Pos, to: Pos = from) => {
    const a = blockEl(from.b), z = blockEl(to.b);
    if (!a || !z) return;
    const [an, ao] = pointAt(a, from.o);
    const [zn, zo] = pointAt(z, to.o);
    getSelection()?.setBaseAndExtent(an, ao, zn, zo);
    lastSel = ordered(from, to);
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * The page brought up to `doc`. A block the document still holds keeps its
   * element; a new one takes over the element of the block it replaced when
   * the two are the same kind, patched rather than rebuilt. True if anything moved.
   */
  const render = (): boolean => {
    let moved = false;
    const keep = new Set(doc.blocks);
    const kept = new Map<Block, HTMLElement>();
    const spare: HTMLElement[] = [];
    for (const el of blockEls()) {
      const b = shown.get(el);
      if (b && keep.has(b) && !kept.has(b)) kept.set(b, el);
      else spare.push(el);
    }
    let s = 0;
    const els = doc.blocks.map(b => {
      const have = kept.get(b);
      if (have) return have;
      const fresh = buildBlock(b, plain);
      const reuse = spare[s];
      if (reuse && reuse.tagName === fresh.tagName) {
        s++;
        if (!reuse.isEqualNode(fresh)) { patch(reuse, fresh); moved = true; }
        shown.set(reuse, b);
        return reuse;
      }
      moved = true;
      shown.set(fresh, b);
      return fresh;
    });
    els.forEach((el, n) => {
      if (page.children[n] !== el) { page.insertBefore(el, page.children[n] ?? null); moved = true; }
    });
    while (page.children.length > els.length) { page.lastElementChild!.remove(); moved = true; }
    numberItems();
    return moved;
  };

  /** Each numbered item's number, counted the way markdown.ts writes it. */
  const numberItems = () => {
    const at: number[] = [];
    const kind: (ListKind | undefined)[] = [];
    doc.blocks.forEach((b, n) => {
      if (b.kind !== 'li') { at.length = 0; kind.length = 0; return; }
      const same = kind[b.depth];
      at[b.depth] = b.list === 'number' ? (same === 'number' && at.length > b.depth ? at[b.depth] + 1 : b.start) : 0;
      kind[b.depth] = b.list;
      at.length = b.depth + 1;
      kind.length = b.depth + 1;
      const el = blockEl(n);
      const label = b.list === 'number' ? `${at[b.depth]}${b.delim}` : '';
      if (el && (el.dataset.n ?? '') !== label) {
        if (label) el.dataset.n = label;
        else delete el.dataset.n;
      }
    });
  };

  // -------------------------------------------------------------------------
  // History inside the editor
  // -------------------------------------------------------------------------

  type Snap = { doc: Doc, sel: [Pos, Pos] };
  const undos: Snap[] = [];
  const redos: Snap[] = [];
  let lastKind = '';
  let lastAt = 0;

  /** The document before a change of `kind`. Typing within a word, without a pause, is one step. */
  const remember = (kind: string, sel: [Pos, Pos] = lastSel) => {
    const now = Date.now();
    if (kind !== 'type' || lastKind !== 'type' || now - lastAt > TYPING_GAP_MS) {
      undos.push({ doc, sel });
      if (undos.length > UNDO_MAX) undos.shift();
    }
    redos.length = 0;
    lastKind = kind;
    lastAt = now;
  };

  const travel = (from: Snap[], to: Snap[]) => {
    // Undo would reach behind the lock, which is the one thing Vomit Mode forbids.
    if (vomit) return;
    const snap = from.pop();
    if (!snap) return;
    to.push({ doc, sel: range() });
    doc = snap.doc;
    render();
    setSel(...snap.sel);
    lastKind = '';
    changed();
  };

  // -------------------------------------------------------------------------
  // Applying edits
  // -------------------------------------------------------------------------

  /** Marks set with nothing selected, waiting for what is typed next, and where the caret was then. */
  let pending: Marks | null = null;
  let pendingAt: Pos | null = null;

  /** An edit made, or refused when it would change locked text. True if it was made. */
  const apply = (e: Edit | null, kind: string, before?: [Pos, Pos]): boolean => {
    if (!e) return false;
    if (vomit && !keepsLocked(doc, e.doc, vomit.lock)) {
      setSel(...range());
      return false;
    }
    if (e.doc !== doc) {
      remember(kind, before ?? range());
      doc = e.doc;
    }
    render();
    setSel(e.from, e.to);
    changed();
    return true;
  };

  let countTimer = 0;
  const changed = () => {
    opts.onChange?.();
    clearTimeout(countTimer);
    countTimer = window.setTimeout(paintCount, 250);
    if (!find.hidden) runFind(true);
    scheduleReflect();
    if (vomit) {
      paintLock();
      armSuper();
    }
  };

  /** A character or a word typed over the selection, then asked whether it was a shortcut. */
  const typeText = (text: string, a: Pos, z: Pos) => {
    // A scene heading, a name and a transition are written in capitals, whatever the keyboard sends.
    const line = doc.blocks[a.b];
    if (line?.kind === 'sp' && CAPS.has(line.el)) text = text.toUpperCase();
    const marks = pending && pendingAt && samePos(pendingAt, a) ? pending : undefined;
    const typed = insertText(doc, a, z, text, marks);
    if (!apply(typed, text === ' ' ? 'space' : 'type', [a, z])) return;
    if (marks) pendingAt = typed.from;
    afterTyping(text);
    settle();
  };

  /** Markdown typed out becomes what it means, as its own undo step so Ctrl+Z gives the characters back. */
  const afterTyping = (text: string) => {
    const at = range()[0];
    if (screen) {
      const made = screenShortcut(doc, at);
      if (made) apply(made, 'shortcut');
      return;
    }
    if (text.endsWith(' ')) {
      const block = blockShortcut(doc, at);
      if (block) { apply(block, 'shortcut'); return; }
    }
    const inline = inlineShortcut(doc, at);
    if (inline && apply(inline, 'shortcut')) {
      const b = doc.blocks[inline.from.b];
      const next = isText(b) ? marksAt(b.runs, inline.from.o) : {};
      delete next[inline.exit];
      pending = next;
      pendingAt = inline.from;
    }
  };

  const enter = (soft: boolean) => {
    const [a, z] = range();
    const b = doc.blocks[a.b];
    if (screen) apply(screenEnter(doc, a, z, soft), 'enter');
    else if (soft && !plain && (b.kind === 'p' || b.kind === 'li' || b.kind === 'quote')) apply(insertText(doc, a, z, '\n'), 'enter');
    else apply((samePos(a, z) && fenceShortcut(doc, a)) || splitBlock(doc, a, z), 'enter');
    settle();
  };

  /** The length of the character before or after `o`, a whole emoji or accented letter. */
  const charLen = (text: string, o: number, back: boolean): number => {
    // Firefox before 125 has no Segmenter; a code point is the fallback.
    if (typeof Intl.Segmenter === 'function') {
      const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
      for (const s of parts) {
        const end = s.index + s.segment.length;
        if (back ? end === o : s.index === o) return s.segment.length;
        if (back ? end > o : s.index > o) break;
      }
    }
    const cp = back ? text.codePointAt(o - 2) : text.codePointAt(o);
    return cp !== undefined && cp > 0xffff ? 2 : 1;
  };

  /** How far a word or line delete reaches from `o`. */
  const reach = (text: string, o: number, type: string): number => {
    const back = type.includes('Backward');
    if (type.includes('Line')) return back ? o - (text.lastIndexOf('\n', o - 1) + 1) : (text.indexOf('\n', o) + 1 || text.length + 1) - 1 - o;
    if (type.includes('Word')) {
      const m = back ? /[\p{L}\p{N}_]*[^\p{L}\p{N}_\n]*$/u.exec(text.slice(0, o)) : /^[^\p{L}\p{N}_\n]*[\p{L}\p{N}_]*/u.exec(text.slice(o));
      return Math.max(1, m?.[0].length ?? 1);
    }
    return charLen(text, o, back);
  };

  const erase = (type: string) => {
    const [a, z] = range();
    if (!samePos(a, z)) { apply(deleteRange(doc, a, z), 'delete'); return; }
    const b = doc.blocks[a.b];
    const back = type.includes('Backward');
    if (back && a.o === 0) { apply(joinBackward(doc, a), 'join'); return; }
    if (!back && a.o >= blockLen(b)) { apply(joinForward(doc, a), 'join'); return; }
    const text = blockText(b);
    const n = Math.min(reach(text, a.o, type), back ? a.o : text.length - a.o);
    const other = { b: a.b, o: back ? a.o - n : a.o + n };
    apply(deleteRange(doc, a, other), type.includes('Content') ? 'type' : 'delete');
  };

  const mark = (key: MarkKey) => {
    const [a, z] = range();
    if (plain) return;
    if (samePos(a, z)) {
      // Nothing selected: the look of what is typed next.
      const b = doc.blocks[a.b];
      const base = pending && pendingAt && samePos(pendingAt, a) ? pending : isText(b) ? marksAt(b.runs, a.o) : {};
      const next = { ...base };
      if (next[key]) delete next[key];
      else next[key] = true;
      pending = next;
      pendingAt = a;
      scheduleReflect();
      return;
    }
    apply(toggleMark(doc, a, z, key), 'format');
  };

  const heading = (level: Level) => { const [a, z] = range(); apply(setHeading(doc, a, z, level), 'format'); };
  const list = (kind: ListKind) => { const [a, z] = range(); apply(toggleList(doc, a, z, kind), 'format'); };
  const element = (el: SceneEl) => { const [a, z] = range(); apply(setElement(doc, a, z, el), 'format'); };
  const dual = () => { const [a, z] = range(); apply({ doc: toggleDual(doc, a), from: a, to: z }, 'format'); };
  /** The element the caret is in, in a screenplay. */
  const elementAt = (): SceneEl | null => {
    const b = doc.blocks[clampPos(doc, lastSel[0]).b];
    return b?.kind === 'sp' ? b.el : null;
  };

  // -------------------------------------------------------------------------
  // Reading back an IME's or a phone keyboard's typing
  // -------------------------------------------------------------------------

  let composing = false;
  /** The selection when the browser was last allowed to type, for the undo step it makes. */
  let typedFrom: [Pos, Pos] | null = null;
  let lastInput = '';

  const absorb = () => {
    const kids = blockEls();
    let next: Doc;
    if (kids.length !== doc.blocks.length || kids.some(el => !shown.has(el))) {
      // The browser changed the page's shape: every block read back.
      next = { ...doc, blocks: kids.map(el => readBlock(el, shown.get(el))) };
      if (!next.blocks.length) next = { ...doc, blocks: [para([], [])] };
    } else {
      const s = getSelection();
      const at = s?.focusNode && page.contains(s.focusNode) ? posOf(s.focusNode, s.focusOffset) : null;
      const blocks = doc.blocks.slice();
      for (const n of new Set([at?.b ?? 0, (typedFrom?.[0].b ?? 0)])) {
        if (kids[n]) blocks[n] = readBlock(kids[n], doc.blocks[n]);
      }
      next = blocks.every((b, n) => b === doc.blocks[n]) ? doc : { ...doc, blocks };
    }
    if (vomit && !keepsLocked(doc, next, vomit.lock)) {
      // A keyboard reached behind the lock - a correction undone, a word
      // replaced whole. The page is put back as the document still has it.
      const back = clampToLock(vomit.lock, typedFrom?.[0] ?? lastSel[0]);
      typedFrom = null;
      page.replaceChildren();
      render();
      setSel(back);
      return;
    }
    if (next !== doc) {
      remember('type', typedFrom ?? lastSel);
      doc = next;
      kids.forEach((el, n) => { if (doc.blocks[n]) shown.set(el, doc.blocks[n]); });
    }
    typedFrom = null;
    const sel = readSel();
    if (render() && sel) setSel(sel.anchor, sel.focus);
    else if (sel) lastSel = ordered(sel.anchor, sel.focus);
    if (lastInput.startsWith('insert')) afterTyping(lastInput === 'insertText' ? ' ' : '');
    changed();
    settle();
  };

  // -------------------------------------------------------------------------
  // Events on the page
  // -------------------------------------------------------------------------

  let shiftHeld = false;

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    lastInput = t;
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      if (t === 'historyUndo') travel(undos, redos);
      else travel(redos, undos);
      return;
    }
    if (t.startsWith('format') || t === 'insertFromDrop' || t === 'deleteByDrag') { e.preventDefault(); return; }
    if (composing || e.isComposing) return;
    const sel = readSel();
    if (!sel) return;
    const [a, z] = ordered(sel.anchor, sel.focus);
    lastSel = [a, z];
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      enter(t === 'insertLineBreak' && shiftHeld);
      return;
    }
    if (t === 'insertText' && e.cancelable) {
      e.preventDefault();
      typeText(e.data ?? '', a, z);
      return;
    }
    if (t.startsWith('delete') && e.cancelable) {
      e.preventDefault();
      erase(t);
      return;
    }
    // Everything else - a spelling suggestion taken, a keyboard's own
    // replacement, a paste the paste handler missed - the browser does, and
    // it is read back on `input`.
    typedFrom = [a, z];
  };

  const onInput = (e: Event) => {
    if (composing || (e instanceof InputEvent && e.isComposing)) return;
    absorb();
  };
  const onCompStart = () => {
    composing = true;
    const s = readSel();
    typedFrom = s ? ordered(s.anchor, s.focus) : lastSel;
  };
  const onCompEnd = () => {
    composing = false;
    lastInput = 'insertCompositionText';
    absorb();
  };

  const onKey = (e: KeyboardEvent) => {
    shiftHeld = e.shiftKey;
    if (composing || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let done = true;
    if (e.key === 'Enter' && !mod) enter(e.shiftKey);
    else if (screen && e.key === 'Tab' && !mod && !e.altKey) {
      const now = elementAt();
      if (now) element(cycleElement(now, e.shiftKey));
    } else if (screen && mod && e.altKey && /^Digit[1-8]$/.test(e.code)) {
      // Ctrl+Alt, not Ctrl alone: a browser keeps Ctrl+1 to 8 for its tabs.
      const pick = ELEMENTS.find(x => x.key === e.code.slice(5));
      if (pick) element(pick.el);
    } else if (screen && mod && !e.altKey && !e.shiftKey && key === 'd') dual();
    else if (e.key === 'Tab' && !mod && !e.altKey && doc.blocks[range()[0].b]?.kind === 'li') {
      const [a, z] = range();
      apply(indent(doc, a, z, e.shiftKey ? -1 : 1) ?? { doc, from: a, to: z }, 'format');
    } else if (!mod) done = false;
    else if (key === 'z' && !e.shiftKey) travel(undos, redos);
    else if ((key === 'z' && e.shiftKey) || key === 'y') travel(redos, undos);
    else if (key === 'b' && !e.shiftKey) mark('b');
    else if (key === 'i' && !e.shiftKey) mark('i');
    else if (key === 'x' && e.shiftKey) mark('s');
    else if (e.altKey && ['0', '1', '2', '3'].includes(e.key)) {
      const [a, z] = range();
      const b = doc.blocks[a.b];
      if (e.key === '0') { if (b.kind === 'h') apply(setHeading(doc, a, z, b.level), 'format'); }
      else heading(e.key === '1' ? 1 : e.key === '2' ? 2 : 3);
    } else if (e.shiftKey && e.code === 'Digit7') list('number');
    else if (e.shiftKey && e.code === 'Digit8') list('bullet');
    else if (e.shiftKey && e.code === 'Digit9') list('task');
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain')?.replace(/\r\n?/g, '\n');
    if (!text) return;
    const [a, z] = range();
    if (plain || doc.blocks[a.b]?.kind === 'code') apply(insertText(doc, a, z, text), 'paste');
    else apply(insertBlocks(doc, a, z, parseMarkdown(text).blocks), 'paste');
    settle();
  };

  /** The clipboard gets the selection's Markdown, which is what the file will say. */
  const copyOut = (e: ClipboardEvent, cut: boolean) => {
    const [a, z] = range();
    if (samePos(a, z) || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', write(sliceDoc(doc, a, z)));
    if (cut) apply(deleteRange(doc, a, z), 'delete');
  };
  const onCopy = (e: ClipboardEvent) => copyOut(e, false);
  const onCut = (e: ClipboardEvent) => copyOut(e, true);

  /** A task's box, ticked by a press on it rather than by the caret. */
  const onPointerDown = (e: PointerEvent) => {
    const box = e.target instanceof Element ? e.target.closest('.ed-box') : null;
    if (!box) return;
    e.preventDefault();
    const n = Array.prototype.indexOf.call(page.children, box.parentElement);
    if (n < 0) return;
    const [a, z] = range();
    apply({ doc: toggleTask(doc, n), from: a, to: z }, 'format');
  };

  const onSelect = () => {
    const s = readSel();
    if (!s) return;
    lastSel = ordered(s.anchor, s.focus);
    // The caret cannot go behind the lock: a click, an arrow or a drag there lands on it.
    if (vomit && cmpPos(lastSel[0], vomit.lock) < 0) {
      setSel(clampToLock(vomit.lock, lastSel[0]), clampToLock(vomit.lock, lastSel[1]));
      return;
    }
    if (pendingAt && !(samePos(lastSel[0], pendingAt) && samePos(lastSel[1], pendingAt))) {
      pending = null;
      pendingAt = null;
    }
    scheduleReflect();
  };

  page.addEventListener('beforeinput', onBeforeInput);
  page.addEventListener('input', onInput);
  page.addEventListener('compositionstart', onCompStart);
  page.addEventListener('compositionend', onCompEnd);
  page.addEventListener('keydown', onKey);
  page.addEventListener('paste', onPaste);
  page.addEventListener('copy', onCopy);
  page.addEventListener('cut', onCut);
  page.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('selectionchange', onSelect);

  // -------------------------------------------------------------------------
  // The bar
  // -------------------------------------------------------------------------

  const bar = h('div', 'ed-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  // No control may take focus from the page, or the selection it acts on goes with it.
  bar.addEventListener('mousedown', e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); });

  const NS = 'http://www.w3.org/2000/svg';
  const button = (label: string, run: () => void, face: { text?: string, icon?: string, cls?: string }) => {
    const b = h('button', 'ed-btn' + (face.cls ? ' ' + face.cls : ''));
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (face.icon) {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'ico');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(NS, 'use');
      use.setAttribute('href', face.icon);
      svg.append(use);
      b.append(svg);
    } else b.textContent = face.text ?? '';
    b.addEventListener('click', run);
    return b;
  };
  const group = (...kids: HTMLElement[]) => {
    const g = h('div', 'ed-group');
    g.append(...kids);
    return g;
  };

  const levels: Level[] = [1, 2, 3];
  const heads = levels.map(level =>
    button(`Heading ${level} (Ctrl+Alt+${level})`, () => heading(level), { text: `H${level}`, cls: 'ed-h' }));
  const marks: [MarkKey, HTMLButtonElement][] = [
    ['b', button('Bold (Ctrl+B)', () => mark('b'), { text: 'B', cls: 'ed-bold' })],
    ['i', button('Italic (Ctrl+I)', () => mark('i'), { text: 'I', cls: 'ed-italic' })],
    ['s', button('Strikethrough (Ctrl+Shift+X)', () => mark('s'), { text: 'S', cls: 'ed-strike' })],
  ];
  const lists: [ListKind, HTMLButtonElement][] = [
    ['bullet', button('Bulleted list (Ctrl+Shift+8)', () => list('bullet'), { icon: 'assets/icons.svg#i-ed-bullets' })],
    ['number', button('Numbered list (Ctrl+Shift+7)', () => list('number'), { icon: 'assets/icons.svg#i-ed-numbers' })],
    ['task', button('Checklist (Ctrl+Shift+9)', () => list('task'), { icon: 'assets/icons.svg#i-ed-tasks' })],
  ];
  const findBtn = button('Find and replace (Ctrl+F)', () => openFind(), { icon: 'assets/icons.svg#i-find' });
  const vomitBtn = button('Vomit Mode: write for a set time with no going back', () => {}, { text: 'Vomit', cls: 'ed-word ed-vomit' });
  vomitBtn.setAttribute('aria-pressed', 'false');
  vomitBtn.setAttribute('aria-haspopup', 'menu');
  menuButton(vomitBtn, () => openAnchored(vomitBtn.getBoundingClientRect(), vomitMenu(), { label: 'Vomit Mode', owner: vomitBtn, focus: true }));
  const timer = h('span', 'ed-timer');
  timer.setAttribute('role', 'timer');

  // A screenplay's one control: which element the line is, the menu listing them all with their keys.
  const elBtn = button('Element (Tab changes it)', () => {}, { text: 'Action', cls: 'ed-word ed-el' });
  elBtn.setAttribute('aria-haspopup', 'menu');
  const elementMenu = (): MenuEntry[] => {
    const now = elementAt();
    const b = doc.blocks[clampPos(doc, lastSel[0]).b];
    return [
      ...ELEMENTS.map((x): MenuEntry => {
        const row: MenuEntry = { label: x.label, check: now === x.el, action: () => element(x.el) };
        if (x.key) row.accel = `Ctrl+Alt+${x.key}`;
        return row;
      }),
      { sep: true },
      { label: 'Dual dialogue', accel: 'Ctrl+D', check: b?.kind === 'sp' && b.dual, action: dual },
    ];
  };
  menuButton(elBtn, () => openAnchored(elBtn.getBoundingClientRect(), elementMenu(), { label: 'Element', owner: elBtn, focus: true }));

  const outlineBtn = button('Outline', () => toggleOutline(), { icon: 'assets/icons.svg#i-ed-outline' });
  outlineBtn.setAttribute('aria-pressed', 'false');

  if (screen) bar.append(group(elBtn));
  else if (!plain) bar.append(group(...heads), group(...marks.map(m => m[1])), group(...lists.map(l => l[1])));
  bar.append(group(findBtn), group(vomitBtn, timer));
  if (!opts.plain || screen) bar.append(group(outlineBtn));

  // The foot of the room: words, and for a screenplay its pages and scenes.
  const status = h('div', 'ed-status');
  const count = h('span', 'ed-count');
  count.setAttribute('aria-live', 'polite');
  if (screen) count.title = 'Pages are an estimate from the standard layout: Courier 12, about 55 lines a page.';
  status.append(count);

  const paintCount = () => {
    const n = wordCount(doc);
    const words = `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;
    if (screen) {
      const { pages, scenes } = screenStats(doc);
      count.textContent = `≈ ${pages} ${pages === 1 ? 'page' : 'pages'} · ${scenes} ${scenes === 1 ? 'scene' : 'scenes'} · ${words}`;
    } else count.textContent = words;
    paintOutline();
  };

  // -------------------------------------------------------------------------
  // The outline: headings, or a screenplay's sections and scenes, to jump to
  // -------------------------------------------------------------------------

  const aside = h('nav', 'ed-outline');
  aside.hidden = true;
  aside.setAttribute('aria-label', 'Outline');
  let entries: OutlineEntry[] = [];

  const paintOutline = () => {
    if (aside.hidden) return;
    entries = outlineOf(doc);
    if (!entries.length) {
      aside.replaceChildren(h('p', 'ed-ol-empty', screen ? 'Scenes and sections show here.' : 'Headings show here.'));
      return;
    }
    aside.replaceChildren(...entries.map(o => {
      const item = h('button', 'ed-ol-item', o.text || 'Untitled');
      item.type = 'button';
      item.dataset.kind = o.kind;
      item.style.setProperty('--level', String(o.level));
      item.addEventListener('click', () => jump(o.b));
      return item;
    }));
    markHere();
  };

  /** The entry the caret is under, lit. */
  const markHere = () => {
    if (aside.hidden) return;
    const b = clampPos(doc, lastSel[0]).b;
    let here = -1;
    entries.forEach((o, n) => { if (o.b <= b) here = n; });
    [...aside.children].forEach((el, n) => el.classList.toggle('is-here', n === here));
  };

  /** To an entry: its line at the top of the view, the caret at its start. On a phone the outline gives way. */
  const jump = (n: number) => {
    const el = blockEl(n);
    if (!el) return;
    page.focus({ preventScroll: true });
    setSel({ b: n, o: 0 });
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
    if (matchMedia('(max-width: 600px)').matches) toggleOutline();
  };

  function toggleOutline() {
    aside.hidden = !aside.hidden;
    outlineBtn.classList.toggle('is-active', !aside.hidden);
    outlineBtn.setAttribute('aria-pressed', String(!aside.hidden));
    paintOutline();
  }

  let reflectQueued = false;
  const scheduleReflect = () => {
    if (reflectQueued) return;
    reflectQueued = true;
    requestAnimationFrame(() => { reflectQueued = false; reflect(); });
  };
  /** The bar lit to match the selection: its marks, and the kind of block the caret is in. */
  const reflect = () => {
    markHere();
    if (screen) {
      const now = elementAt();
      elBtn.textContent = ELEMENTS.find(x => x.el === now)?.label ?? 'Action';
      return;
    }
    if (plain) return;
    const [a, z] = [clampPos(doc, lastSel[0]), clampPos(doc, lastSel[1])];
    const b = doc.blocks[z.b];
    const at: Marks = samePos(a, z)
      ? (pending && pendingAt && samePos(pendingAt, a) ? pending : isText(b) ? marksAt(b.runs, a.o) : {})
      : {};
    for (const [key, btn] of marks) {
      const on = samePos(a, z) ? !!at[key] : hasMark(doc, a, z, key);
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    heads.forEach((btn, n) => btn.classList.toggle('is-active', b.kind === 'h' && b.level === n + 1));
    for (const [kind, btn] of lists) btn.classList.toggle('is-active', b.kind === 'li' && b.list === kind);
  };

  // -------------------------------------------------------------------------
  // Vomit Mode: a timed session in which nothing written can be taken back
  // -------------------------------------------------------------------------

  type Session = { lock: Pos, ends: number, tick: number, superTimer: number };
  let vomit: Session | null = null;
  /** Super as last chosen, kept for the next session in this opening. */
  let superOn = false;
  /** The menu slider's duration, in minutes. */
  let custom = 20;

  /** The lock moved up to the caret if a word has just been finished. */
  const settle = () => {
    if (!vomit) return;
    vomit.lock = advance(doc, vomit.lock, range()[1]);
    paintLock();
  };

  /** Everything behind the lock faded - a highlight, so the page itself is not touched. */
  const paintLock = () => {
    if (!highlights) return;
    const first = blockEl(0);
    const at = vomit ? blockEl(vomit.lock.b) : undefined;
    if (!vomit || !first || !at) { highlights.delete('ed-locked'); return; }
    const r = document.createRange();
    r.setStart(first, 0);
    r.setEnd(...pointAt(at, vomit.lock.o));
    highlights.set('ed-locked', new Highlight(r));
  };

  /** Super: each keystroke starts the wait again, and at its end the word so far locks. */
  const armSuper = () => {
    if (!vomit) return;
    clearTimeout(vomit.superTimer);
    if (!superOn) return;
    vomit.superTimer = window.setTimeout(() => {
      if (!vomit) return;
      vomit.lock = superLock(vomit.lock, clampPos(doc, lastSel[1]));
      paintLock();
    }, SUPER_MS);
  };

  const paintTimer = () => {
    if (!vomit) return;
    const left = vomit.ends - Date.now();
    if (left <= 0) endVomit();
    else timer.textContent = clock(left);
  };

  /** The caret brought into view if it is off the page's visible part. */
  const reveal = () => {
    const r = rangeOf({ b: lastSel[0].b, from: lastSel[0].o, to: lastSel[0].o });
    const box = r?.getClientRects()[0] ?? blockEl(lastSel[0].b)?.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box && (box.bottom > view.bottom || box.top < view.top)) scroller.scrollTop += box.top - view.top - view.height / 2;
  };

  /** A session begun: the caret to the end and everything before it locked, the typewriter way. */
  const startVomit = (minutes: number) => {
    if (vomit) return;
    closeFind();
    const lock = lockAtEnd(doc);
    vomit = { lock, ends: Date.now() + minutes * 60_000, tick: window.setInterval(paintTimer, 1000), superTimer: 0 };
    root.classList.add('is-vomit');
    findBtn.disabled = true;
    vomitBtn.classList.add('is-active');
    vomitBtn.setAttribute('aria-pressed', 'true');
    page.focus({ preventScroll: true });
    setSel(lock);
    reveal();
    paintTimer();
    paintLock();
    armSuper();
  };

  /** The time is up, or the editor closed: everything unlocks, with no cue and no summary. */
  const endVomit = () => {
    if (!vomit) return;
    clearInterval(vomit.tick);
    clearTimeout(vomit.superTimer);
    vomit = null;
    highlights?.delete('ed-locked');
    root.classList.remove('is-vomit');
    findBtn.disabled = false;
    vomitBtn.classList.remove('is-active');
    vomitBtn.setAttribute('aria-pressed', 'false');
    timer.textContent = '';
  };

  /** The durations, or while a session runs, how long is left. There is no way to end one early. */
  const vomitMenu = (): MenuEntry[] => {
    const superRow: MenuEntry = {
      label: 'Super: lock each word after 10 seconds',
      check: superOn,
      action: () => { superOn = !superOn; armSuper(); },
    };
    if (vomit) return [{ label: `Unlocks in ${clock(vomit.ends - Date.now())}`, disabled: true }, { sep: true }, superRow];
    return [
      ...VOMIT_MINUTES.map((m): MenuEntry => ({ label: `${m} minutes`, action: () => startVomit(m) })),
      { sep: true },
      { label: 'Custom', range: { min: 1, max: 180, step: 1, unit: ' min', get: () => custom, set: v => { custom = v; } } },
      { label: 'Start for the custom time', action: () => startVomit(custom) },
      { sep: true },
      superRow,
    ];
  };

  // -------------------------------------------------------------------------
  // Find and replace
  // -------------------------------------------------------------------------

  const find = h('div', 'ed-find');
  find.hidden = true;
  const q = h('input', 'ed-find-q');
  q.type = 'search';
  q.placeholder = 'Find';
  q.setAttribute('aria-label', 'Find');
  const rep = h('input', 'ed-find-r');
  rep.type = 'text';
  rep.placeholder = 'Replace with';
  rep.setAttribute('aria-label', 'Replace with');
  const tally = h('span', 'ed-find-n');
  tally.setAttribute('aria-live', 'polite');
  const prevBtn = button('Previous (Shift+Enter)', () => step(-1), { icon: 'assets/icons.svg#i-chevron-left' });
  const nextBtn = button('Next (Enter)', () => step(1), { icon: 'assets/icons.svg#i-chevron-right' });
  const oneBtn = button('Replace this one', () => replaceOne(), { text: 'Replace', cls: 'ed-word' });
  const allBtn = button('Replace every one', () => replaceEvery(), { text: 'All', cls: 'ed-word' });
  const shutBtn = button('Close find (Esc)', () => closeFind(), { icon: 'assets/icons.svg#i-close' });
  find.append(q, tally, prevBtn, nextBtn, rep, oneBtn, allBtn, shutBtn);

  let matches: Match[] = [];
  let current = -1;
  const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : null;

  const rangeOf = (m: Match): Range | null => {
    const el = blockEl(m.b);
    if (!el) return null;
    const r = document.createRange();
    r.setStart(...pointAt(el, m.from));
    r.setEnd(...pointAt(el, m.to));
    return r;
  };

  const paintMatches = () => {
    if (!highlights) return;
    const all = matches.slice(0, PAINT_MAX).map(rangeOf).filter((r): r is Range => !!r);
    highlights.set('ed-find', new Highlight(...all));
    const now = matches[current] ? rangeOf(matches[current]) : null;
    if (now) highlights.set('ed-find-now', new Highlight(now));
    else highlights.delete('ed-find-now');
  };

  /** Matches found again after the document or the query changed, staying near the one that was current. */
  const runFind = (keep = false) => {
    const was = matches[current];
    matches = findAll(doc, q.value);
    if (!matches.length) current = -1;
    else if (keep && was) {
      const i = matches.findIndex(m => m.b > was.b || (m.b === was.b && m.from >= was.from));
      current = i < 0 ? 0 : i;
    } else {
      const [a] = range();
      const i = matches.findIndex(m => m.b > a.b || (m.b === a.b && m.from >= a.o));
      current = i < 0 ? 0 : i;
    }
    paintTally();
    paintMatches();
  };

  const paintTally = () => {
    const more = matches.length >= MATCH_MAX ? '+' : '';
    tally.textContent = !q.value ? '' : matches.length ? `${current + 1} of ${matches.length}${more}` : 'No match';
    for (const b of [prevBtn, nextBtn, oneBtn, allBtn]) b.disabled = !matches.length;
  };

  const show = (m: Match | undefined) => {
    const r = m && rangeOf(m);
    if (!r) return;
    const box = r.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      scroller.scrollTop += box.top - view.top - view.height / 3;
    }
  };

  const step = (d: 1 | -1) => {
    if (!matches.length) return;
    current = (current + d + matches.length) % matches.length;
    paintTally();
    paintMatches();
    show(matches[current]);
  };

  const replaceOne = () => {
    const m = matches[current];
    if (!m) return;
    apply({ ...replaceMatch(doc, m, rep.value) }, 'replace');
    runFind(true);
    show(matches[current]);
  };

  const replaceEvery = () => {
    const { doc: next, count: n } = replaceAll(doc, q.value, rep.value);
    if (!n) return;
    const [a] = range();
    apply({ doc: next, from: clampPos(next, a), to: clampPos(next, a) }, 'replace');
    runFind();
    tally.textContent = `${n.toLocaleString()} replaced`;
  };

  function openFind() {
    // Replace would rewrite locked text, and a session has nothing to look back for.
    if (vomit) return;
    find.hidden = false;
    root.classList.add('is-finding');
    const [a, z] = range();
    // A selection within one block is what to look for.
    if (a.b === z.b && !samePos(a, z)) q.value = blockText(doc.blocks[a.b]).slice(a.o, z.o);
    q.focus();
    q.select();
    runFind();
    show(matches[current]);
  }

  function closeFind(): boolean {
    if (find.hidden) return false;
    find.hidden = true;
    root.classList.remove('is-finding');
    highlights?.delete('ed-find');
    highlights?.delete('ed-find-now');
    const m = matches[current];
    page.focus({ preventScroll: true });
    if (m) setSel({ b: m.b, o: m.from }, { b: m.b, o: m.to });
    else setSel(...range());
    return true;
  }

  q.addEventListener('input', () => { runFind(); show(matches[current]); });
  const onFindKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target === q) step(e.shiftKey ? -1 : 1); else replaceOne(); }
  };
  q.addEventListener('keydown', onFindKey);
  rep.addEventListener('keydown', onFindKey);

  // Escape closes find before it closes anything else; Ctrl+F and Ctrl+S are the editor's, not the browser's.
  root.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape' && closeFind()) { markClosed(e); e.preventDefault(); e.stopPropagation(); return; }
    if (mod && !e.altKey && (key === 'f' || key === 'h')) {
      e.preventDefault();
      e.stopPropagation();
      openFind();
      if (key === 'h') rep.focus();
    } else if (mod && !e.altKey && key === 's') {
      e.preventDefault();
      e.stopPropagation();
      opts.onSave?.();
    }
  });

  const body = h('div', 'ed-body');
  body.append(aside, scroller);
  root.append(bar, find, body, status);

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  render();
  paintCount();
  const start = (): Pos => {
    const c = opts.caret ?? 'start';
    const last = doc.blocks.length - 1;
    // The first line that takes a caret: a screenplay can open on its title page, which does not.
    if (c === 'start') return { b: Math.max(0, doc.blocks.findIndex(b => !isAtom(b))), o: 0 };
    if (c === 'end') return { b: last, o: blockLen(doc.blocks[last]) };
    return posAtSource(doc, c.line, c.col);
  };
  lastSel = [start(), start()];
  scheduleReflect();

  return {
    el: root,
    text: () => write(doc),
    focus: () => {
      page.focus({ preventScroll: true });
      setSel(...lastSel);
      reveal();
    },
    type: (text: string) => {
      for (const ch of text.replace(/\r\n?/g, '\n')) {
        if (ch === '\n') enter(false);
        else {
          const [a, z] = range();
          typeText(ch, a, z);
        }
      }
    },
    closeFind,
    destroy: () => {
      endVomit();
      clearTimeout(countTimer);
      document.removeEventListener('selectionchange', onSelect);
      highlights?.delete('ed-find');
      highlights?.delete('ed-find-now');
    },
  };
}
