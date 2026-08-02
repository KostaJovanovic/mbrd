// Editing a sticky note, and keeping it big enough to hold what it says.
//
// A note is a short run of formatted blocks - a heading, a subheading,
// paragraphs - each a line with its own alignment, over a note-level font, size
// and vertical placement. The blocks live in `meta.rich`; `meta.text` is the
// Markdown-flavoured plaintext they flatten to, kept for search, linkify and
// older readers. canvas/renderers.js owns that model (normalizeNoteRich /
// flattenNoteRich / buildNoteLine); this file is the editor over it.
//
// Editing turns the `.note-rich` column into a plaintext-only contenteditable
// whose children are the block lines, and floats a small toolbar above the note
// for the things typing cannot say: alignment, vertical placement, font and
// size. Kind is set from the toolbar too, or by typing `# `/`## ` at the head of
// a line. The whole edit commits once, on the way out.
//
// Two rules keep the text and the box agreed with each other:
//
//   the text can never be longer than NOTE_MAX
//   the box can never be shorter than the text needs
//
// The second is enforced from both directions - the note grows as you type, and
// a resize drag stops at the height the text requires - so there is no state in
// which a note is hiding something.
//
// One note stops being a note. If what it says turns out to be an address and
// nothing else, it becomes a link item as the edit closes - see linkify() below.

import { byId, bus, markDirty, setNoteContent, retypeItem, board, NOTE_MAX } from '../state.js';
import { nodeFor, onViewChange, screenBoxOf, viewportClientRect } from './items.js';
import { linkURL, linkDraft } from './renderers.js';
// The model, from the model. This module is the note *editor*; reaching through
// the renderer for the shape both of them read was an arrow pointing the wrong
// way, and the split is what let it be straightened.
import {
  normalizeNoteRich, flattenNoteRich, buildNoteLine,
  NOTE_TAGS, NOTE_ALIGNS, NOTE_FONTS, NOTE_FONT_KEYS, NOTE_MARKER,
  NOTE_SIZE_MIN, NOTE_SIZE_MAX, NOTE_SIZE_STEP,
} from './note-model.js';

/**
 * Height this note needs, in world px, for its text at `width`.
 *
 * Wrapping depends on the width, so a resize has to ask about the width it is
 * *proposing*, not the one on screen. The measurement is destructive-then-
 * restored: the column is normally a flex child stretched to fill the card and
 * placed by justify-content, and a stretched element reports its box rather than
 * its content - so it is briefly released to its natural height, pinned to the
 * top, to be measured.
 */
export function noteHeight(id, width) {
  const el = nodeFor(id);
  const card = el?.querySelector('.card');
  const wrap = card?.querySelector('.note-rich');
  if (!card || !wrap) return 0;

  const prevWidth = el.style.width;
  if (width != null) el.style.width = width.toFixed(2) + 'px';
  const prevFlex = wrap.style.flex;
  const prevHeight = wrap.style.height;
  const prevJustify = wrap.style.justifyContent;
  wrap.style.flex = '0 0 auto';
  wrap.style.height = 'auto';
  wrap.style.justifyContent = 'flex-start';

  const cs = getComputedStyle(card);
  const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // offsetHeight is a rounded integer, so it can sit a fraction under the real
  // height; ceil plus a pixel keeps a descender off the edge.
  const need = Math.ceil(padding + wrap.offsetHeight) + 1;

  wrap.style.flex = prevFlex;
  wrap.style.height = prevHeight;
  wrap.style.justifyContent = prevJustify;
  if (width != null) el.style.width = prevWidth;
  return need;
}

/**
 * Grow a note to fit its text. Never shrinks: a note you deliberately made
 * roomy should stay roomy when you delete a line, and the resize floor below
 * already stops you from making one too small by hand.
 *
 * Not undoable, on purpose - the same reasoning as adoptAspect() in
 * renderers.js. It is part of the text arriving, not an edit of its own, and an
 * undo entry per keystroke would bury the edit it belongs to.
 */
export function growNote(id) {
  const it = byId(id);
  if (!it || it.type !== 'note') return;
  const need = noteHeight(id, it.w);
  if (!need || need <= it.h) return;
  it.h = need;
  bus.emit('geom', [id]);
  markDirty();
}

/** The shortest a note may be dragged at `width` - the height its text needs. */
export const noteFloor = (id, width) => noteHeight(id, width);

// ---------------------------------------------------------------------------
// Line helpers - the block model, read off the DOM
// ---------------------------------------------------------------------------

const lineTag = line => NOTE_TAGS.find(t => line.classList.contains('note-' + t)) || 'p';
const lineAlign = line => NOTE_ALIGNS.find(a => line.classList.contains('al-' + a)) || 'left';

function setLineTag(line, tag) {
  for (const t of NOTE_TAGS) line.classList.toggle('note-' + t, t === tag);
}
function setLineAlign(line, align) {
  for (const a of NOTE_ALIGNS) line.classList.toggle('al-' + a, a === align);
}

/** The block-line the caret is in, if any. */
function currentLine(wrap) {
  const sel = getSelection();
  const node = sel.anchorNode;
  if (!node || !wrap.contains(node)) return null;
  const el = node.nodeType === 3 ? node.parentElement : node;
  return el.closest('.note-line');
}

/** All block-lines the selection touches; the current one when it is collapsed. */
function selectedLines(wrap) {
  const sel = getSelection();
  const lines = [...wrap.querySelectorAll('.note-line')];
  if (!sel.rangeCount) { const l = currentLine(wrap); return l ? [l] : []; }
  const range = sel.getRangeAt(0);
  if (range.collapsed) { const l = currentLine(wrap); return l ? [l] : []; }
  const hit = lines.filter(line => range.intersectsNode(line));
  return hit.length ? hit : (currentLine(wrap) ? [currentLine(wrap)] : []);
}

/** How far into its line the caret sits, in characters. */
function caretOffset(line) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(line);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

function caretTo(line, offset) {
  const sel = getSelection();
  const range = document.createRange();
  const t = line.firstChild && line.firstChild.nodeType === 3 ? line.firstChild : null;
  if (t) range.setStart(t, Math.min(offset, t.length));
  else range.setStart(line, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The flattened length right now - what would land in meta.text. */
function flatLength(wrap) {
  const lines = [...wrap.querySelectorAll('.note-line')];
  return lines.reduce((n, line, i) =>
    n + NOTE_MARKER[lineTag(line)].length + line.textContent.length + (i ? 1 : 0), 0);
}

/** The rich model as the DOM currently stands, sanitised and capped. */
function readRich(wrap) {
  const blocks = [...wrap.querySelectorAll('.note-line')].map(line => ({
    tag: lineTag(line),
    align: lineAlign(line),
    text: line.textContent.replace(/\n/g, ' '),
  }));
  return normalizeNoteRich({
    font: wrap.dataset.font,
    size: parseFloat(wrap.style.getPropertyValue('--note-scale')) || 1,
    valign: wrap.dataset.valign,
    blocks,
  });
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/**
 * The little formatting bar over a note being edited. Its buttons must not steal
 * focus from the editor - a blur would commit the note out from under the click
 * - so every control cancels the mousedown that would move focus; the one
 * exception is the <select>, which the focusout guard lets through because it is
 * inside the item.
 */
function buildToolbar(api) {
  const bar = document.createElement('div');
  bar.className = 'note-toolbar';
  // The bar lives inside the .item, so a press on it would otherwise reach the
  // canvas and start dragging the note - most visibly after using the <select>,
  // whose native dropdown swallows the pointerup that would have ended the drag.
  // Stop the press at the bar; the buttons still get their click.
  bar.addEventListener('pointerdown', e => e.stopPropagation());
  bar.addEventListener('mousedown', e => {
    e.stopPropagation();
    // Keep focus in the editor for the buttons; the <select> needs it, so let
    // that one through.
    if (e.target.tagName !== 'SELECT') e.preventDefault();
  });

  const groups = {};
  const group = name => {
    const g = document.createElement('div');
    g.className = 'ntb-group';
    bar.append(g);
    groups[name] = g;
    return g;
  };
  // A button carrying either text (the headings) or a CSS-drawn icon (the
  // alignment and vertical-placement controls, whose glyphs no font can be
  // trusted to have). `icon` is a class suffix; the shape is painted in the CSS.
  const btn = (g, { text, icon, title, fn, key }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ntb-btn' + (icon ? ' ntb-icon' : '');
    if (icon) {
      const span = document.createElement('span');
      span.className = 'ntb-ico ntb-ico-' + icon;
      b.append(span);
    } else {
      b.textContent = text;
    }
    b.title = title;
    b.setAttribute('aria-label', title);
    if (key) b.dataset.key = key;
    b.addEventListener('click', fn);
    g.append(b);
    return b;
  };

  const gTag = group('tag');
  btn(gTag, { text: 'H1', title: 'Title', fn: () => api.setTag('h1'), key: 'tag:h1' });
  btn(gTag, { text: 'H2', title: 'Heading', fn: () => api.setTag('h2'), key: 'tag:h2' });
  btn(gTag, { text: '¶', title: 'Paragraph', fn: () => api.setTag('p'), key: 'tag:p' });

  const gAlign = group('align');
  btn(gAlign, { icon: 'al-left', title: 'Align left', fn: () => api.setAlign('left'), key: 'align:left' });
  btn(gAlign, { icon: 'al-center', title: 'Align centre', fn: () => api.setAlign('center'), key: 'align:center' });
  btn(gAlign, { icon: 'al-right', title: 'Align right', fn: () => api.setAlign('right'), key: 'align:right' });

  const gV = group('valign');
  btn(gV, { icon: 'va-top', title: 'Top', fn: () => api.setValign('top'), key: 'valign:top' });
  btn(gV, { icon: 'va-middle', title: 'Middle', fn: () => api.setValign('middle'), key: 'valign:middle' });
  btn(gV, { icon: 'va-bottom', title: 'Bottom', fn: () => api.setValign('bottom'), key: 'valign:bottom' });

  const gFont = group('font');
  const sel = document.createElement('select');
  sel.className = 'ntb-select';
  sel.title = 'Font';
  sel.setAttribute('aria-label', 'Font');
  const LABEL = { sheet: 'Sheet', sans: 'Sans', serif: 'Serif', mono: 'Mono' };
  for (const key of NOTE_FONT_KEYS) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = LABEL[key] || key;
    sel.append(opt);
  }
  sel.addEventListener('change', () => api.setFont(sel.value));
  gFont.append(sel);

  const gSize = group('size');
  btn(gSize, { text: 'A−', title: 'Smaller', fn: () => api.bumpSize(-NOTE_SIZE_STEP), key: 'size:down' });
  btn(gSize, { text: 'A+', title: 'Larger', fn: () => api.bumpSize(NOTE_SIZE_STEP), key: 'size:up' });

  /** Light up the controls that match the line the caret is in. */
  const reflect = (tag, align, valign, font) => {
    for (const b of bar.querySelectorAll('.ntb-btn[data-key]')) {
      const [k, v] = b.dataset.key.split(':');
      b.classList.toggle('is-active',
        (k === 'tag' && v === tag) || (k === 'align' && v === align) ||
        (k === 'valign' && v === valign));
    }
    sel.value = font;
  };

  return { el: bar, reflect };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/**
 * Turn a note into an editable column of blocks until focus leaves it.
 *
 * The note commits on focusout, not on blur, and the guard lets focus move
 * anywhere inside the item - between lines, and onto the toolbar's <select> -
 * without ending the edit. Only leaving the item entirely finishes it.
 */
export function editNote(id) {
  const item = byId(id);
  const node = nodeFor(id);
  if (!item || item.type !== 'note' || !node) return;
  const card = node.querySelector('.card');
  const wrap = card?.querySelector('.note-rich');
  if (!wrap) return;

  // Close any editor already open - including a stale one on this very note -
  // before starting, so an edit is never begun on top of another. Without this a
  // second open leaks the first's listeners and leaves its note contentEditable,
  // which then takes a plain click as an edit for the rest of the session.
  if (editing) editing.finish();

  node.classList.add('is-editing');
  // plaintext-only keeps pasted markup out of a note; not every engine has it.
  try { wrap.contentEditable = 'plaintext-only'; }
  catch { wrap.contentEditable = 'true'; }
  if (!wrap.isContentEditable) wrap.contentEditable = 'true';

  // How much room is left, shown only while the note is being written. A limit
  // you cannot see is indistinguishable from a broken keyboard.
  const counter = document.createElement('div');
  counter.className = 'note-count';
  node.append(counter);
  const refreshCount = () => {
    const left = NOTE_MAX - flatLength(wrap);
    counter.textContent = left + ' left';
    counter.classList.toggle('is-low', left <= 40);
  };

  const reflectNow = () => {
    const line = currentLine(wrap);
    toolbar.reflect(
      line ? lineTag(line) : 'p',
      line ? lineAlign(line) : 'left',
      wrap.dataset.valign || 'top',
      wrap.dataset.font || 'sheet');
  };

  const afterEdit = () => { growNote(id); refreshCount(); reflectNow(); placeToolbar(); };

  const api = {
    setTag(tag) { for (const l of selectedLines(wrap)) setLineTag(l, tag); afterEdit(); },
    // Alignment is a property of the note, not of one line: a sticky reads as one
    // sheet, so every line takes the alignment at once whatever the caret is in.
    setAlign(align) { for (const l of wrap.querySelectorAll('.note-line')) setLineAlign(l, align); afterEdit(); },
    setValign(v) { wrap.dataset.valign = v; afterEdit(); },
    setFont(key) {
      const font = NOTE_FONT_KEYS.includes(key) ? key : 'sheet';
      wrap.style.fontFamily = NOTE_FONTS[font];
      wrap.dataset.font = font;
      afterEdit();
    },
    bumpSize(delta) {
      let s = (parseFloat(wrap.style.getPropertyValue('--note-scale')) || 1) + delta;
      s = Math.min(NOTE_SIZE_MAX, Math.max(NOTE_SIZE_MIN, Math.round(s * 100) / 100));
      wrap.style.setProperty('--note-scale', s);
      afterEdit();
    },
  };

  const toolbar = buildToolbar(api);
  // The bar always lives in screen space (in #viewport), never in the item, so
  // it is never scaled by zoom and never clipped by the item box. Mobile pins it
  // to the top of a narrow board; desktop floats it just above the note and
  // clamps it to the viewport so an edge note's bar cannot fall off screen.
  const viewportEl = document.getElementById('viewport');
  // Pin the bar to the top of the screen on the Mobile board, and on any screen
  // too narrow to hold the floating bar without it running off an edge - which
  // is a phone showing a *Desktop* board, where layoutMode is still 'desktop'
  // but the viewport is a phone's. The float is a fixed run of five control
  // groups; below roughly a phone's width it cannot fit, so it takes the top
  // strip the same way the Mobile board's does. matchMedia is read here, in the
  // handler, never at module load - see tests/imports.test.js.
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
  const mobile = board.layoutMode === 'mobile' || narrow;
  if (mobile) {
    toolbar.el.classList.add('is-mobile');
    // The bar takes the foot of the screen for the duration of the edit, in
    // place of the add bar and the bin/undo/redo strip; the root class hides
    // those so the two never stack. Removed in finish().
    document.documentElement.classList.add('note-edit-mobile');
  } else {
    toolbar.el.classList.add('is-float');
  }
  (viewportEl || node).append(toolbar.el);

  // The bar's own size, measured once instead of on every frame.
  //
  // This runs on every view change for the whole length of an edit, so the four
  // measurements it used to take - the viewport's rect, the note's rect, and the
  // bar's width and height - were four reads landing immediately after the view
  // wrote #world's transform, which is a forced synchronous layout of the whole
  // page per frame of every pan. Three of the four are now computed from what
  // the viewport already knows (see screenBoxOf / viewportClientRect); this is
  // the fourth, and it is the only one that genuinely needs the DOM.
  //
  // It is also the one that holds still. The bar is a fixed run of five control
  // groups whose <select>s are sized by their widest option, so nothing a person
  // can do mid-edit changes its box - only a window resize can, by way of the
  // root font size, and that is where it is re-measured.
  let barW = 0, barH = 0;
  const measureBar = () => { barW = toolbar.el.offsetWidth; barH = toolbar.el.offsetHeight; };

  // Keep the bar over the note and inside the viewport, flipping below the note
  // when there is no room above. Desktop floats a compact bar centred on the
  // note; mobile spans the whole board width, a wrapped strip above the note.
  const placeToolbar = () => {
    // Mobile pins to the foot of the screen by CSS - nothing to compute.
    if (mobile || !viewportEl) return;
    const vpRect = viewportClientRect();
    const nRect = screenBoxOf(byId(id));
    if (!vpRect || !nRect) return;
    if (!barW) measureBar();
    const bar = toolbar.el;
    const gap = 12, pad = 8;
    let cx = nRect.cx;
    const minX = vpRect.left + pad + barW / 2;
    const maxX = vpRect.right - pad - barW / 2;
    cx = Math.min(maxX, Math.max(minX, cx));
    let top = nRect.top - gap - barH;           // above the note
    if (top < vpRect.top + pad) top = nRect.bottom + gap;   // no room -> below
    top = Math.min(vpRect.bottom - pad - barH, Math.max(vpRect.top + pad, top));
    bar.style.left = cx + 'px';
    bar.style.top = top + 'px';
  };
  measureBar();
  placeToolbar();
  const offView = onViewChange(placeToolbar);
  const onResize = () => { measureBar(); placeToolbar(); };
  addEventListener('resize', onResize);

  // beforeinput, not a check after the fact: refusing the keystroke leaves the
  // caret where it was, where truncating afterwards would move it and quietly
  // eat whatever the paste was meant to add.
  const onBeforeInput = e => {
    if (e.inputType.startsWith('delete') || e.inputType === 'historyUndo') return;
    if (e.inputType === 'insertFromPaste') return;         // handled by onPaste
    const adding = (e.data ?? '').length || 1;
    const selected = String(getSelection()).length;
    if (flatLength(wrap) - selected + adding > NOTE_MAX) e.preventDefault();
  };

  // Typing `# ` or `## ` at the head of a line promotes it and swallows the
  // marker, the way a Markdown editor does - a shortcut for the toolbar's H1/H2.
  const autoformat = () => {
    const line = currentLine(wrap);
    if (!line) return;
    const text = line.textContent;
    let strip = 0, tag = null;
    if (text.startsWith('## ')) { tag = 'h2'; strip = 3; }
    else if (text.startsWith('# ')) { tag = 'h1'; strip = 2; }
    // Strip whenever a marker is present, even if the line is already that kind:
    // the default first line is a title, and typing "# " on it should promote-
    // and-swallow like anywhere else rather than leaving a literal "# ".
    if (!tag) return;
    const off = caretOffset(line);
    setLineTag(line, tag);
    line.textContent = text.slice(strip);
    caretTo(line, Math.max(0, off - strip));
  };

  // Some edits - select-all then type, a few paste paths - leave raw text or a
  // bare <div>/<br> straight in the column, outside any line, where readRich
  // cannot see it. Fold every stray node back into a paragraph line so the
  // content is never lost, and there is always at least one line to type in.
  const normalizeStructure = () => {
    let changed = false;
    for (const node of [...wrap.childNodes]) {
      if (node.nodeType === 1 && node.classList.contains('note-line')) continue;
      if (node.nodeName === 'BR' || (node.nodeType === 3 && node.textContent === '')) {
        node.remove();
        changed = true;
        continue;
      }
      const line = buildNoteLine({ tag: 'p', align: 'left', text: node.textContent || '' });
      wrap.replaceChild(line, node);
      changed = true;
    }
    if (!wrap.querySelector('.note-line')) {
      wrap.append(buildNoteLine({ tag: 'h1', align: 'left', text: '' }));
      changed = true;
    }
    if (changed) {
      const lines = wrap.querySelectorAll('.note-line');
      const last = lines[lines.length - 1];
      caretTo(last, last.textContent.length);
    }
  };

  const onInput = () => { normalizeStructure(); autoformat(); afterEdit(); };

  const onKey = e => {
    e.stopPropagation();                    // the canvas must not see Delete/space
    if (e.key === 'Escape') { finish(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = currentLine(wrap);
      if (!line) return;
      if (flatLength(wrap) + 1 > NOTE_MAX) return;   // a new line is a newline char
      const off = caretOffset(line);
      const full = line.textContent;
      line.textContent = full.slice(0, off);
      const next = buildNoteLine({ tag: 'p', align: lineAlign(line), text: full.slice(off) });
      line.after(next);
      caretTo(next, 0);
      afterEdit();
      return;
    }
    if (e.key === 'Backspace') {
      const line = currentLine(wrap);
      const prev = line?.previousElementSibling;
      // Only intercept the join: a Backspace anywhere else is ordinary deletion.
      if (line && prev?.classList.contains('note-line') && caretOffset(line) === 0 &&
          getSelection().isCollapsed) {
        e.preventDefault();
        const at = prev.textContent.length;
        prev.textContent = prev.textContent + line.textContent;
        line.remove();
        caretTo(prev, at);
        afterEdit();
      }
    }
  };

  // Plaintext paste, split into block lines on its own newlines so a pasted
  // paragraph does not smuggle unaddressable lines into one block.
  const onPaste = e => {
    e.preventDefault();
    let text = e.clipboardData?.getData('text/plain') ?? '';
    const room = NOTE_MAX - flatLength(wrap) + String(getSelection()).length;
    if (room <= 0) return;
    text = text.slice(0, room);
    const sel = getSelection();
    if (sel.rangeCount && !sel.isCollapsed) sel.getRangeAt(0).deleteContents();
    const line = currentLine(wrap);
    if (!line) return;
    const parts = text.split('\n');
    const off = caretOffset(line);
    const full = line.textContent;
    const head = full.slice(0, off), tail = full.slice(off);
    line.textContent = head + parts[0];
    let cur = line;
    for (let i = 1; i < parts.length; i++) {
      const last = i === parts.length - 1;
      cur = insertAfter(cur, buildNoteLine({
        tag: 'p', align: lineAlign(line), text: last ? parts[i] + tail : parts[i],
      }));
    }
    if (parts.length === 1) caretTo(line, head.length + parts[0].length);
    else caretTo(cur, parts[parts.length - 1].length);
    afterEdit();
  };

  // focusout fires before the new element takes focus, so relatedTarget is where
  // focus is *going* - the one moment we can tell "moved within the note" from
  // "left it entirely". The toolbar counts as inside, wherever it is mounted: on
  // Mobile it lives in the viewport rather than the item, so its <select> would
  // otherwise read as leaving and commit the note out from under the tap.
  const onFocusOut = e => {
    if (node.contains(e.relatedTarget) || toolbar.el.contains(e.relatedTarget)) return;
    finish();
  };

  // A press anywhere outside the note and its toolbar commits and closes. This is
  // the reliable close: focusout does not fire when the press lands on something
  // the canvas refuses focus to (an empty spot, another card), which would leave
  // the note editable. Capture phase, so it runs before the canvas eats the press.
  const onDocPointerDown = e => {
    if (node.contains(e.target) || toolbar.el.contains(e.target)) return;
    finish();
  };

  const onSelect = () => reflectNow();

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    if (editing?.finish === finish) editing = null;
    wrap.removeEventListener('beforeinput', onBeforeInput);
    wrap.removeEventListener('input', onInput);
    wrap.removeEventListener('keydown', onKey);
    wrap.removeEventListener('paste', onPaste);
    wrap.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('selectionchange', onSelect);
    document.documentElement.classList.remove('note-edit-mobile');
    offView?.();
    removeEventListener('resize', onResize);
    wrap.contentEditable = 'false';
    counter.remove();
    toolbar.el.remove();
    node.classList.remove('is-editing');
    const rich = readRich(wrap);
    const text = flattenNoteRich(rich);
    if (linkify(id, text)) return;
    setNoteContent(id, rich, text);
    growNote(id);
  }

  wrap.addEventListener('beforeinput', onBeforeInput);
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('keydown', onKey);
  wrap.addEventListener('paste', onPaste);
  wrap.addEventListener('focusout', onFocusOut);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('selectionchange', onSelect);
  editing = { id, finish };
  refreshCount();
  // Caret at the end of the last line, ready to keep writing.
  const lines = wrap.querySelectorAll('.note-line');
  const last = lines[lines.length - 1];
  if (last) { last.focus?.(); caretTo(last, last.textContent.length); }
  wrap.focus();
  reflectNow();
}

/** Insert `el` after `ref` and return it. */
function insertAfter(ref, el) {
  ref.after(el);
  return el;
}

/**
 * The note currently being edited, if any, so it can be closed from outside.
 *
 * There is only ever one: opening an editor moves focus, which fires focusout on
 * any other and finishes it.
 */
let editing = null;

/**
 * Commit any note being edited right now, and say whether there was one.
 *
 * Until this existed, a note's text lived only in contenteditable DOM between
 * the first keystroke and the blur that ended the edit. Everything else about
 * the note was already state - typing calls growNote(), which changes the item's
 * height, which schedules a snapshot - so an autosave taken mid-edit recorded the
 * *new* height with the *old* text. And a teardown that never delivers a usable
 * focusout (a closed tab, a crash, a phone reclaiming the page) lost the edit
 * outright.
 *
 * Synchronous, so it can be called from pagehide, where nothing may await.
 */
export function flushNoteEdit() {
  if (!editing) return false;
  editing.finish();
  return true;
}

/**
 * A note written down to nothing but a URL is a link, and this is where it
 * becomes one. Returns whether it did.
 *
 * *When* matters more than what. The check runs from finish() - once, as the
 * edit is put away - and never from the input handler, because watching a note
 * dissolve into a link card as you type the last character of an address would
 * be the app taking the pen out of your hand mid-sentence. Waiting until you
 * have stepped away from the note makes the conversion something you finished
 * rather than something that happened to you, and one Ctrl+Z puts the sticky
 * back exactly as it was.
 *
 * It fires nowhere else, either. A note that already held nothing but a URL -
 * loaded from a .mbrd saved before links existed, or restored from the bin - is
 * left alone, because rewriting somebody's saved file on the way in is the same
 * surprise arriving at a worse moment. Only an edit you just made can convert the
 * thing you just edited.
 *
 * The typed text is never committed on its way past. One edit, one undo entry:
 * undoing the conversion gives back the note as it stood before the edit
 * started, not a half-way note that only ever existed in the DOM.
 *
 * The link takes the note's place, its position and its place in the stack - but
 * the link's own default size, because a sticky is square in order to hold a
 * paragraph and this holds two lines.
 *
 * Stickiness is read from live geometry rather than stored, so it needs no
 * repair: notes stuck *to* this one are stuck to a link now and go on travelling
 * with it, since a host may be anything. What does end is the other direction -
 * only notes stick, so a note that was riding on a photo stops riding on it the
 * moment it becomes a link. That is the honest outcome and not an oversight: it
 * is no longer a sticky, and a link card lying on a photo is a card lying on a
 * photo.
 */
function linkify(id, text) {
  const url = linkURL(text);
  if (!url) return false;
  retypeItem(id, linkDraft(url), 'Turn note into link');
  return true;
}
