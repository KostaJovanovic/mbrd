// Documents, read into a tree the viewer can show.
//
// The second half of what import/document.js started. That one finds the picture
// a document already carries of itself, which is what a card needs; this one
// reads the document's actual content, which is what somebody who has just
// opened it wants. Both work the same way and for the same reason: every format
// here is a ZIP with XML inside it, and this app already owns a bounds-checking
// ZIP reader (storage/zip.js) and the browser owns an XML parser. There is no
// library in any of this.
//
// What is read:
//
//   .docx and friends   word/document.xml - paragraphs, headings, runs, tables,
//                       lists. Inline pictures are resolved through the
//                       relationship file and drawn.
//   .odt / .ods / .odp  content.xml, whose vocabulary is different from OOXML's
//                       and whose structure is the same shape.
//   .pptx               one section per slide, in presentation order.
//   .xlsx               each sheet as a table, through the shared-string table.
//   .csv / .tsv         a table, with the delimiter sniffed.
//   .svg                drawn, after everything that can execute is taken out.
//   .cbz                the pages, in name order.
//
// Three rules run through all of it, and they are the same three the rest of
// this app's readers follow:
//
//   Nothing is trusted. Every count is capped before it is looped on, every
//   path is looked up rather than constructed from something the file said, and
//   any failure at all comes back as a thrown Error the viewer turns into one
//   line of text. A document that cannot be read is a card that could not be
//   opened, which is where the user was anyway.
//
//   Nothing becomes markup. Every string out of a document lands in the page as
//   a text node. Nothing here touches innerHTML - not once - so there is no
//   escaping to get right and no way for a .docx off somebody's disk to run
//   anything. SVG is the exception that proves it and is handled explicitly
//   below.
//
//   Nothing goes to the network. Every picture shown comes out of the file
//   itself, as a blob URL this module mints and hands back for release.
//
// Layout, not typesetting. A .docx is a flow of styled runs and this shows it as
// a flow of styled runs; it is not Word, it does not paginate, and a document
// whose meaning is in its page geometry will not read the same here. That is a
// deliberate stop: reproducing the page is a typesetting engine, and the thing
// people want from a moodboard is to read the words.

import { readZip } from '../storage/zip.ts';

/** How large a document this will open. See MAX_CONTAINER in import/document.js. */
const MAX_CONTAINER = 96 * 1024 * 1024;

/** Caps. None is a correctness bound; all are "this file is lying to us" stops. */
const MAX_BLOCKS = 20000;      // paragraphs, rows, slides - anything emitted
const MAX_CELLS = 40000;       // table cells across one document
const MAX_PAGES = 400;         // comic pages, slides
const MAX_IMAGES = 300;        // pictures drawn out of one document

/**
 * An archive as readZip() answers it: the entry name, and the bytes.
 *
 * Named because half the functions below take one and nothing else does.
 */
// The buffer is named because storage/zip.ts names it: a Uint8Array over an
// ArrayBuffer rather than over ArrayBufferLike, which is what lets the bytes go
// straight into a Blob without being copied first.
type Entries = Map<string, Uint8Array<ArrayBuffer>>;

/** rId -> target path, as a _rels part gives it - see relationships(). */
type Rels = Map<string, string>;

/**
 * What every reader in the table below is.
 *
 * The two that draw pictures take the URL list to record what they minted; the
 * four that cannot are written without it, which is a narrower function and so
 * still one of these.
 */
type DocReader = (blob: Blob, urls: string[]) => Promise<DocumentFragment>;

/** ext -> the reader that opens it. The whole of what this module supports. */
const READERS: Record<string, DocReader> = {
  docx: ooxmlText, docm: ooxmlText, dotx: ooxmlText, dotm: ooxmlText,
  pptx: ooxmlSlides, pptm: ooxmlSlides, ppsx: ooxmlSlides, potx: ooxmlSlides,
  xlsx: ooxmlSheets, xlsm: ooxmlSheets, xltx: ooxmlSheets,
  odt: odfText, ott: odfText, odp: odfText, otp: odfText,
  ods: odfSheets, ots: odfSheets,
  csv: delimited, tsv: delimited,
  svg: svgDoc,
  cbz: comic,
};

/** Whether the viewer has a reader for this file. */
// `unknown` rather than string, and that is the call site's shape: the viewer
// asks with item.meta?.ext, and ItemMeta is unknown per key on purpose. The
// String() below is what has always answered for that.
export const canReadDocument = (ext: unknown) => !!READERS[String(ext || '').toLowerCase()];

/**
 * Read `blob` as `ext`, into `{ node, release }`.
 *
 * `node` is a DocumentFragment ready to be appended. `release` revokes every
 * blob URL the read minted and must be called when the node comes down - the
 * viewer does it in its teardown.
 *
 * Throws on anything it cannot read, which the caller shows as one line.
 */
export async function readDocument(blob: Blob, ext: unknown) {
  const read = READERS[String(ext || '').toLowerCase()];
  if (!read) throw new Error('No reader for that file');
  if (blob.size > MAX_CONTAINER) throw new Error('That file is too large to open here');
  const urls: string[] = [];
  const node = await read(blob, urls);
  return { node, release: () => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; } };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const dec = new TextDecoder();
/**
 * Generic over the tag, so a caller that asks for an 'img' is handed something
 * with a `src` on it. The three callers that build a heading name from a number
 * cast, and say why where they do it.
 */
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

/**
 * One entry of an archive as a parsed XML document.
 *
 * DOMParser and not a hand-rolled XML reader, because the browser has one and it
 * is the same one the rest of the platform uses. It parses into a *detached*
 * document with no browsing context - nothing in it loads, runs or navigates -
 * which is what makes it safe to point at a file the app did not write. The tree
 * is then walked and copied into real elements; the parsed document itself never
 * reaches the page.
 */
function xmlOf(entries: Entries, path: string) {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`That file is missing ${path}`);
  const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file could not be parsed');
  return doc;
}

/** Every element with this local name, whatever namespace prefix it carries. */
const byLocal = (root: Document | Element, name: string) =>
  [...root.getElementsByTagName('*')].filter(n => n.localName === name);

/** The first child element with this local name, or null. */
const childOf = (node: Element, name: string) =>
  [...node.children].find(n => n.localName === name) || null;

/** A blob URL for an archive entry, remembered so it can be released. */
function urlFor(entries: Entries, path: string, urls: string[], mime?: string) {
  const bytes = entries.get(path);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || guessMime(path) }));
  urls.push(url);
  return url;
}

function guessMime(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  })[ext] || 'application/octet-stream';
}

/**
 * A table from rows of strings, with the first row as the head if asked.
 *
 * The cells are `string | null` because that is what a DOM textContent answers
 * and what the readers hand over untouched - and because textContent is also
 * what they are written back into, which takes null as the empty cell it is.
 */
function tableOf(rows: (string | null)[][], { head = true } = {}) {
  const t = el('table', 'doc-table');
  let cells = 0;
  const wrap = el('div', 'doc-table-wrap');
  const body = el('tbody');
  rows.forEach((row, n) => {
    if (cells > MAX_CELLS) return;
    const tr = el('tr');
    for (const value of row) {
      const cell = el(head && n === 0 ? 'th' : 'td');
      cell.textContent = value;
      tr.append(cell);
      cells++;
    }
    if (head && n === 0) {
      const thead = el('thead');
      thead.append(tr);
      t.append(thead);
    } else {
      body.append(tr);
    }
  });
  t.append(body);
  wrap.append(t);
  return wrap;
}

/** A heading for a section of a multi-part document (a slide, a sheet, a page). */
function partHead(text: string) {
  const h = el('h2', 'doc-part');
  h.textContent = text;
  return h;
}

// ---------------------------------------------------------------------------
// OOXML: Word
// ---------------------------------------------------------------------------

/**
 * A Word document as a flow of blocks.
 *
 * `word/document.xml` is a body of `w:p` (paragraph) and `w:tbl` (table). A
 * paragraph carries a style name in `w:pStyle`, which is how a heading says it
 * is one, and a numbering reference in `w:numPr`, which is how a list item says
 * it is one. Inside it are `w:r` runs, each a span of text with its own bold,
 * italic and underline flags, and `w:drawing` blocks that reference a picture by
 * relationship id.
 *
 * Lists are the one place this simplifies: Word stores the *numbering
 * definition* in a separate part and a list item only points at it, so knowing
 * whether a bullet is a bullet or a number means reading numbering.xml and
 * resolving an abstract level. This reads the indent level and emits a nested
 * unordered list, which is right for the shape and wrong for the marker on a
 * numbered list. Stated rather than hidden.
 */
async function ooxmlText(blob: Blob, urls: string[]) {
  const entries = await readZip(blob);
  const doc = xmlOf(entries, 'word/document.xml');
  const rels = relationships(entries, 'word/_rels/document.xml.rels');
  const body = byLocal(doc, 'body')[0];
  if (!body) throw new Error('That document has no body');

  const frag = document.createDocumentFragment();
  const out = el('div', 'doc-flow');
  frag.append(out);
  let list = null;
  let images = 0;
  let n = 0;
  for (const node of body.children) {
    if (n++ > MAX_BLOCKS) break;
    if (node.localName === 'tbl') {
      list = null;
      out.append(wordTable(node));
      continue;
    }
    if (node.localName !== 'p') continue;
    const level = listLevel(node);
    const block = wordParagraph(node, entries, rels, urls, () => images++ < MAX_IMAGES);
    if (level === null) { list = null; out.append(block); continue; }
    // A run of list paragraphs becomes one list. Nesting is by the level Word
    // recorded, one <ul> deep per level, which is the shape without the markers.
    if (!list) { list = el('ul', 'doc-list'); out.append(list); }
    // Element rather than the <ul> it starts as: the walk down the levels below
    // steps onto whatever nested list it finds, which the DOM answers as one.
    let host: Element = list;
    for (let d = 0; d < Math.min(level, 6); d++) {
      const last = host.lastElementChild;
      const nested = last && childOf(last, 'ul');
      if (nested) { host = nested; continue; }
      const deeper = el('ul');
      (last || host).append(deeper);
      host = deeper;
    }
    const li = el('li');
    li.append(...block.childNodes);
    host.append(li);
  }
  if (!out.childNodes.length) throw new Error('That document has nothing in it to show');
  return frag;
}

/** rId -> target path, from a _rels part. Missing is an empty map, not an error. */
function relationships(entries: Entries, path: string): Rels {
  const map: Rels = new Map();
  const bytes = entries.get(path);
  if (!bytes) return map;
  try {
    const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
    for (const r of byLocal(doc, 'Relationship')) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      if (id && target) map.set(id, target);
    }
  } catch { /* a document with no usable relationships still has its words */ }
  return map;
}

/** The list level of a paragraph, or null if it is not a list item. */
function listLevel(p: Element) {
  const props = childOf(p, 'pPr');
  const num = props && childOf(props, 'numPr');
  if (!num) return null;
  const ilvl = childOf(num, 'ilvl');
  const v = ilvl && Number(ilvl.getAttribute('w:val') ?? ilvl.getAttribute('val'));
  return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
}

function wordParagraph(p: Element, entries: Entries, rels: Rels, urls: string[],
  mayDrawImage: () => boolean) {
  const props = childOf(p, 'pPr');
  const style = props && childOf(props, 'pStyle');
  const name = (style?.getAttribute('w:val') || style?.getAttribute('val') || '').toLowerCase();
  // Heading1..Heading9, and the aliases Word itself writes for a title page.
  const heading = /^heading([1-9])$/.exec(name);
  // The cast is the clamp above read as a type: h1 through h6 are all tag names,
  // and Math.min(6, …) on a digit matched by the pattern cannot leave that set.
  const tag = (heading ? 'h' + Math.min(6, Number(heading[1]))
    : name === 'title' ? 'h1'
    : name === 'subtitle' ? 'h2'
    : 'p') as keyof HTMLElementTagNameMap;
  const block = el(tag, name === 'quote' || name === 'intensequote' ? 'doc-quote' : '');

  for (const child of p.children) {
    if (child.localName === 'r') {
      block.append(...wordRun(child, entries, rels, urls, mayDrawImage));
    } else if (child.localName === 'hyperlink') {
      // The address is in the relationship the id points at. Not made live: an
      // address out of a document somebody sent is exactly the link this app
      // should show rather than offer, and the run below still carries the words.
      const span = el('span', 'doc-link');
      for (const r of [...child.children].filter(c => c.localName === 'r')) {
        span.append(...wordRun(r, entries, rels, urls, mayDrawImage));
      }
      block.append(span);
    }
  }
  if (!block.childNodes.length) block.append(document.createElement('br'));
  return block;
}

/** One run: its text, its emphasis, and any picture drawn inside it. */
function wordRun(r: Element, entries: Entries, rels: Rels, urls: string[],
  mayDrawImage: () => boolean) {
  const out: Node[] = [];
  const props = childOf(r, 'rPr');
  // The second childOf is asserted because the first conjunct just called it and
  // got an element: the lookup is a scan of the same children for the same name.
  const on = (what: string) => !!(props && childOf(props, what)
    && (childOf(props, what)!.getAttribute('w:val') ?? '') !== '0');

  for (const child of r.children) {
    if (child.localName === 't') {
      // An element's textContent is a string; only a document or a doctype
      // answers null, and neither can be a child of a run.
      let node: Node = document.createTextNode(child.textContent!);
      // Innermost first, so bold-and-italic nests rather than fighting.
      if (on('i')) node = nest('em', node);
      if (on('b')) node = nest('strong', node);
      if (on('u')) node = nest('u', node);
      if (on('strike')) node = nest('s', node);
      out.push(node);
    } else if (child.localName === 'br') {
      out.push(document.createElement('br'));
    } else if (child.localName === 'tab') {
      out.push(document.createTextNode('\t'));
    } else if (child.localName === 'drawing' || child.localName === 'pict') {
      const img = wordImage(child, entries, rels, urls, mayDrawImage);
      if (img) out.push(img);
    }
  }
  return out;
}

const nest = (tag: keyof HTMLElementTagNameMap, child: Node) => {
  const n = document.createElement(tag);
  n.append(child);
  return n;
};

/**
 * A picture inside a run.
 *
 * The drawing points at a relationship id (`r:embed`), the relationship names a
 * target relative to `word/`, and the target is an entry in the archive. Every
 * step is a lookup: nothing here builds a path out of a string the document
 * supplied, so a target of `../../etc/passwd` resolves to no entry and draws
 * nothing rather than reaching anywhere.
 */
function wordImage(node: Element, entries: Entries, rels: Rels, urls: string[],
  mayDrawImage: () => boolean) {
  if (!mayDrawImage()) return null;
  const blip = byLocal(node, 'blip')[0];
  const id = blip?.getAttribute('r:embed') || blip?.getAttribute('embed');
  const target = id && rels.get(id);
  if (!target) return null;
  const url = urlFor(entries, 'word/' + target.replace(/^\/+/, ''), urls);
  if (!url) return null;
  const img = el('img', 'doc-image');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function wordTable(tbl: Element) {
  const rows: string[][] = [];
  for (const tr of [...tbl.children].filter(n => n.localName === 'tr')) {
    rows.push([...tr.children]
      .filter(n => n.localName === 'tc')
      .map(tc => byLocal(tc, 't').map(t => t.textContent).join('')));
  }
  return tableOf(rows);
}

// ---------------------------------------------------------------------------
// OOXML: PowerPoint
// ---------------------------------------------------------------------------

/**
 * A deck, one section per slide, in presentation order.
 *
 * Order matters and is not the order the entries happen to be in: slide10 sorts
 * before slide2 as a string. The numbers are pulled out and compared as numbers,
 * which is the whole of it - a real reading of the presentation part's slide id
 * list would also handle a hidden slide, and this does not.
 */
async function ooxmlSlides(blob: Blob, urls: string[]) {
  const entries = await readZip(blob);
  const slides = [...entries.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNo(a) - slideNo(b))
    .slice(0, MAX_PAGES);
  if (!slides.length) throw new Error('That presentation has no slides');

  const frag = document.createDocumentFragment();
  slides.forEach((path, n) => {
    const section = el('section', 'doc-slide');
    section.append(partHead(`Slide ${n + 1}`));
    const body = el('div', 'doc-flow');
    try {
      const doc = xmlOf(entries, path);
      const rels = relationships(entries, path.replace('slides/', 'slides/_rels/') + '.rels');
      // Each shape's text body is a stack of a:p paragraphs of a:t runs. The
      // first shape on a slide is usually its title, but "usually" is not a rule
      // any file states, so every paragraph is a paragraph.
      for (const p of byLocal(doc, 'p')) {
        const text = byLocal(p, 't').map(t => t.textContent).join('');
        if (!text.trim()) continue;
        const line = el('p');
        line.textContent = text;
        body.append(line);
      }
      let drawn = 0;
      for (const blip of byLocal(doc, 'blip')) {
        if (drawn++ >= 12) break;
        const id = blip.getAttribute('r:embed') || blip.getAttribute('embed');
        const target = id && rels.get(id);
        if (!target) continue;
        const url = urlFor(entries, resolveFrom('ppt/slides/', target), urls);
        if (!url) continue;
        const img = el('img', 'doc-image');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        body.append(img);
      }
    } catch {
      const bad = el('p', 'doc-missing');
      bad.textContent = 'This slide could not be read.';
      body.append(bad);
    }
    section.append(body);
    frag.append(section);
  });
  return frag;
}

export const slideNo = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] || 0);

/**
 * A relationship target resolved against the part that referenced it.
 *
 * Only `../` is honoured, and only by popping - the result is still looked up in
 * the archive's own key set, so a target that climbs out of the package simply
 * finds nothing.
 */
export function resolveFrom(base: string, target: string) {
  const parts = base.replace(/\/$/, '').split('/');
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// OOXML: Excel
// ---------------------------------------------------------------------------

/**
 * A workbook, one table per sheet.
 *
 * Cell values are indices into a shared string table when the cell says
 * `t="s"`, and literal numbers otherwise - which is the one thing about the
 * format that will surprise anybody reading a sheet XML for the first time.
 * Formulas are not evaluated: the cached value Excel stored is what is shown,
 * which is what the file says the answer was.
 */
async function ooxmlSheets(blob: Blob) {
  const entries = await readZip(blob);
  const shared = sharedStrings(entries);
  const sheets = [...entries.keys()]
    .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => slideNo(a) - slideNo(b));
  if (!sheets.length) throw new Error('That workbook has no sheets');
  const names = sheetNames(entries);

  const frag = document.createDocumentFragment();
  sheets.forEach((path, n) => {
    const section = el('section', 'doc-sheet');
    section.append(partHead(names[n] || `Sheet ${n + 1}`));
    try {
      const doc = xmlOf(entries, path);
      const rows: (string | null)[][] = [];
      for (const row of byLocal(doc, 'row')) {
        if (rows.length > MAX_BLOCKS) break;
        const cells: (string | null)[] = [];
        for (const c of [...row.children].filter(x => x.localName === 'c')) {
          // The column letter in r="B7" is the position; without it a row of
          // three values with a gap in the middle would close up.
          const at = colIndex(c.getAttribute('r') || '');
          const value = cellValue(c, shared);
          if (at >= 0 && at < 512) {
            while (cells.length < at) cells.push('');
            cells[at] = value;
          } else {
            cells.push(value);
          }
        }
        rows.push(cells);
      }
      section.append(tableOf(rows));
    } catch {
      const bad = el('p', 'doc-missing');
      bad.textContent = 'This sheet could not be read.';
      section.append(bad);
    }
    frag.append(section);
  });
  return frag;
}

function sharedStrings(entries: Entries) {
  const out: string[] = [];
  if (!entries.has('xl/sharedStrings.xml')) return out;
  try {
    const doc = xmlOf(entries, 'xl/sharedStrings.xml');
    for (const si of byLocal(doc, 'si')) {
      out.push(byLocal(si, 't').map(t => t.textContent).join(''));
    }
  } catch { /* a workbook with no readable strings still has its numbers */ }
  return out;
}

function sheetNames(entries: Entries) {
  try {
    const doc = xmlOf(entries, 'xl/workbook.xml');
    return byLocal(doc, 'sheet').map(s => s.getAttribute('name') || '');
  } catch {
    return [];
  }
}

function cellValue(c: Element, shared: string[]) {
  const type = c.getAttribute('t');
  if (type === 'inlineStr') return byLocal(c, 't').map(t => t.textContent).join('');
  const v = childOf(c, 'v');
  if (!v) return '';
  if (type === 's') {
    const i = Number(v.textContent);
    return Number.isInteger(i) && shared[i] !== undefined ? shared[i] : '';
  }
  return v.textContent;
}

/** "B7" -> 1. Letters only, so a malformed reference answers -1. */
export function colIndex(ref: string) {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------------------
// OpenDocument
// ---------------------------------------------------------------------------

/**
 * An ODF text or presentation document.
 *
 * The vocabulary is different from OOXML's and the shape is the same: content.xml
 * holds `text:h` headings, `text:p` paragraphs, `text:list` lists and
 * `table:table` tables, and a presentation adds a `draw:page` per slide. One
 * reader for both, because the difference between them is which container the
 * blocks are inside and nothing else.
 */
async function odfText(blob: Blob, urls: string[]) {
  const entries = await readZip(blob);
  const doc = xmlOf(entries, 'content.xml');
  const pages = byLocal(doc, 'page');
  const frag = document.createDocumentFragment();

  if (pages.length) {
    pages.slice(0, MAX_PAGES).forEach((page, n) => {
      const section = el('section', 'doc-slide');
      section.append(partHead(page.getAttribute('draw:name') || `Slide ${n + 1}`));
      const body = el('div', 'doc-flow');
      odfBlocks(page, body, entries, urls);
      section.append(body);
      frag.append(section);
    });
    return frag;
  }

  const body = byLocal(doc, 'text')[0];
  if (!body) throw new Error('That document has no body');
  const out = el('div', 'doc-flow');
  odfBlocks(body, out, entries, urls);
  if (!out.childNodes.length) throw new Error('That document has nothing in it to show');
  frag.append(out);
  return frag;
}

function odfBlocks(root: Element, host: HTMLElement, entries: Entries, urls: string[]) {
  let n = 0;
  let images = 0;
  const walk = (node: Element, into: Element) => {
    for (const child of node.children) {
      if (n++ > MAX_BLOCKS) return;
      switch (child.localName) {
        case 'h': {
          const level = Number(child.getAttribute('text:outline-level') || 1);
          // Cast for the reason wordParagraph()'s does: the clamp on either side
          // of it is what makes the name one of h1..h6.
          const h = el(('h' + Math.min(6, Math.max(1, level))) as keyof HTMLElementTagNameMap);
          h.textContent = child.textContent;
          into.append(h);
          break;
        }
        case 'p': {
          const p = el('p');
          p.textContent = child.textContent;
          // A paragraph can hold a frame with a picture in it, which is the one
          // reason this is not a plain text read.
          for (const image of byLocal(child, 'image')) {
            if (images++ >= MAX_IMAGES) break;
            const href = image.getAttribute('xlink:href') || image.getAttribute('href');
            const url = href && urlFor(entries, href.replace(/^\.?\/+/, ''), urls);
            if (!url) continue;
            const img = el('img', 'doc-image');
            img.src = url;
            img.alt = '';
            img.loading = 'lazy';
            into.append(img);
          }
          if (p.textContent.trim()) into.append(p);
          break;
        }
        case 'list': {
          const ul = el('ul', 'doc-list');
          for (const item of [...child.children].filter(c => c.localName === 'list-item')) {
            const li = el('li');
            walk(item, li);
            ul.append(li);
          }
          into.append(ul);
          break;
        }
        case 'table': {
          const rows: (string | null)[][] = [];
          for (const tr of byLocal(child, 'table-row')) {
            rows.push([...tr.children]
              .filter(c => c.localName === 'table-cell')
              .map(c => c.textContent));
          }
          into.append(tableOf(rows));
          break;
        }
        default:
          // Frames, sections, text boxes: containers whose children are blocks.
          if (child.children.length) walk(child, into);
      }
    }
  };
  walk(root, host);
}

/** A spreadsheet is the same content.xml, and its tables are the whole of it. */
async function odfSheets(blob: Blob) {
  const entries = await readZip(blob);
  const doc = xmlOf(entries, 'content.xml');
  const tables = byLocal(doc, 'table').filter(t => t.localName === 'table');
  if (!tables.length) throw new Error('That workbook has no sheets');
  const frag = document.createDocumentFragment();
  tables.forEach((table, n) => {
    const section = el('section', 'doc-sheet');
    section.append(partHead(table.getAttribute('table:name') || `Sheet ${n + 1}`));
    const rows: (string | null)[][] = [];
    for (const tr of byLocal(table, 'table-row')) {
      if (rows.length > MAX_BLOCKS) break;
      const cells: (string | null)[] = [];
      for (const c of [...tr.children].filter(x => x.localName === 'table-cell')) {
        // ODF runs of identical cells are collapsed into one with a repeat
        // count, and a trailing run of empties can claim to repeat a thousand
        // times - so the count is capped rather than believed.
        const repeat = Math.min(64, Number(c.getAttribute('table:number-columns-repeated') || 1) || 1);
        for (let i = 0; i < repeat; i++) cells.push(c.textContent);
      }
      // Trailing empties, which every ODF sheet has a great many of.
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) rows.push(cells);
    }
    section.append(tableOf(rows));
    frag.append(section);
  });
  return frag;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A delimited file as a table.
 *
 * The delimiter is sniffed from the first line rather than taken from the
 * extension, because half the files named .csv in the world are semicolon- or
 * tab-separated - a .csv written by a spreadsheet in a locale where the comma is
 * the decimal point is a semicolon file.
 */
async function delimited(blob: Blob) {
  const text = await blob.text();
  const head = text.slice(0, 4096).split('\n')[0] || '';
  const sep = [',', ';', '\t', '|']
    // `as const` so the pair reads as a delimiter and a count rather than as two
    // of either - the sort below subtracts one half and the pick returns the
    // other.
    .map(c => [c, head.split(c).length] as const)
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = parseDelimited(text, sep).slice(0, MAX_BLOCKS);
  if (!rows.length) throw new Error('That file has no rows');
  const frag = document.createDocumentFragment();
  frag.append(tableOf(rows));
  return frag;
}

/**
 * RFC 4180 quoting: doubled quotes inside a quoted field, newlines allowed.
 *
 * Exported for its test and for no other caller - it is one of the four pieces
 * of this module that is a decision rather than a walk, and the only four that
 * can be checked without a DOM.
 */
export function parseDelimited(text: string, sep: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_BLOCKS) return rows;
      continue;
    }
    field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * An SVG, drawn - and the one place in this module that puts a document's own
 * markup on the page rather than its text.
 *
 * That is why it is the only one that sanitises. An SVG is a document format
 * that can carry script, external references and event handlers, and this app
 * opens files it did not write. So the file is parsed detached (where nothing in
 * it runs), then walked: every element not on the allow-list is dropped whole,
 * every attribute that is an event handler or a reference to somewhere else is
 * dropped, and what is left is imported into the page.
 *
 * An allow-list and not a block-list, deliberately. A block-list is a promise
 * that the author thought of everything, and the history of SVG sanitisers is
 * the history of that promise being wrong.
 */
async function svgDoc(blob: Blob) {
  const doc = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('That file is not an SVG this app can read');
  }
  scrub(root);
  const holder = el('div', 'doc-svg');
  holder.append(document.importNode(root, true));
  const frag = document.createDocumentFragment();
  frag.append(holder);
  return frag;
}

const SVG_OK = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feMerge',
  'feMergeNode', 'feFlood', 'feComposite', 'feDropShadow',
  'marker', 'switch', 'style',
]);

function scrub(node: Element) {
  for (const child of [...node.children]) {
    if (!SVG_OK.has(child.localName)) { child.remove(); continue; }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      // Every on* handler, and anything pointing anywhere but inside this
      // document - a fragment reference (#id) is the one form kept, because
      // <use href="#thing"> is how an SVG refers to its own parts.
      const away = name.startsWith('on')
        || (/^(href|xlink:href|src|from|to|values)$/.test(name) && !value.startsWith('#'))
        || value.includes('javascript:')
        || value.includes('data:text/html');
      if (away) child.removeAttribute(attr.name);
    }
    scrub(child);
  }
}

// ---------------------------------------------------------------------------
// Comic archives
// ---------------------------------------------------------------------------

/** A CBZ: every picture in it, in the order its names sort. */
async function comic(blob: Blob, urls: string[]) {
  const entries = await readZip(blob);
  const pages = [...entries.keys()]
    .filter(k => /\.(png|jpe?g|gif|webp|bmp)$/i.test(k) && !k.startsWith('__MACOSX'))
    // Natural order, so page10 comes after page9 rather than after page1.
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, MAX_PAGES);
  if (!pages.length) throw new Error('That archive has no pages in it');
  const frag = document.createDocumentFragment();
  const wall = el('div', 'doc-pages');
  for (const path of pages) {
    const url = urlFor(entries, path, urls);
    if (!url) continue;
    const img = el('img', 'doc-page');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    wall.append(img);
  }
  frag.append(wall);
  return frag;
}
