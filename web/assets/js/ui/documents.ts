// Document reader — .docx/.pptx/.xlsx/.odt/.csv/.svg/.cbz into a tree
// the viewer shows. ZIP + browser XML parser, no library. No innerHTML
// (SVG is the one exception), no network — pictures are blob URLs.
// Layout, not typesetting.

import { readZip } from '../storage/zip.ts';
import { makeEl as el } from '../util.ts';
import { lift, allow, mb, nameOf } from '../consent.ts';
// The container walk itself, shared with import/slide.ts, which composites a
// deck's first slide into a card. It lives down there because the importer
// may not reach into ui/ - see the header of import/ooxml.ts.
import {
  byLocal, childOf, relationships, resolveFrom, slideNo,
  type Entries, type Rels,
} from '../import/ooxml.ts';

/** How large a document this will open. See MAX_CONTAINER in import/document.ts. */
const MAX_CONTAINER = 96 * 1024 * 1024;

/**
 * What "this document" means when the same one is opened twice: the blob's
 * size, since a viewer has no name or hash to key by. Coarse on purpose -
 * worst case is a collision skips one re-ask, not a repeated one.
 */
const docKey = (blob: Blob) => `doc:${blob.size}`;

/**
 * Every reader's way in, so the archive's own ceilings are asked about once.
 * Used to be six call sites to readZip(), each surfacing an inflate ceiling
 * as an unhelpful "could not be read". The retry contract lives in consent.ts.
 */
async function openDoc(blob: Blob): Promise<Entries> {
  try {
    return await readZip(blob);
  } catch (err) {
    if (!await lift(err, docKey(blob), nameOf(blob, 'This document'), 'Open it')) throw err;
    return await readZip(blob, { lift: true });
  }
}

/** Caps. None is a correctness bound; all are "this file is lying to us" stops. */
const MAX_BLOCKS = 20000;      // paragraphs, rows, slides - anything emitted
const MAX_CELLS = 40000;       // table cells across one document
const MAX_PAGES = 400;         // comic pages, slides
const MAX_IMAGES = 300;        // pictures drawn out of one document

/**
 * What every reader in the table below is. The four that draw pictures take
 * the URL list to record what they minted; the rest are written without it.
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
// `unknown`, not string: the call site is item.meta?.ext, and ItemMeta is
// unknown per key on purpose.
export const canReadDocument = (ext: unknown) => !!READERS[String(ext || '').toLowerCase()];

/**
 * Read `blob` as `ext`, into `{ node, release }`. `node` is a DocumentFragment
 * ready to be appended; `release` revokes every blob URL the read minted and
 * must be called when the node comes down (the viewer does, in teardown).
 * Throws on anything unreadable, which the caller shows as one line.
 */
export async function readDocument(blob: Blob, ext: unknown) {
  const read = READERS[String(ext || '').toLowerCase()];
  if (!read) throw new Error('No reader for that file');
  // Goes through consent.ts rather than a fresh ask(): same question the
  // importer asks at the same ceiling, so a yes given at import still holds
  // when the viewer opens the document later.
  if (blob.size > MAX_CONTAINER && !await allow(
    docKey(blob),
    `${nameOf(blob, 'This document')} - ${mb(blob.size)}`,
    [{
      ceiling: 'container-bytes',
      what: `This document is ${mb(blob.size)}, past the ${mb(MAX_CONTAINER)} one is opened at here.`,
    }],
    'Open it',
  )) {
    throw new Error('That file is too large to open here');
  }
  const urls: string[] = [];
  const node = await read(blob, urls);
  return { node, release: () => { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; } };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const dec = new TextDecoder();

/**
 * One entry of an archive as a parsed XML document. DOMParser, not a
 * hand-rolled reader: it parses into a *detached* document with no browsing
 * context, so nothing in it loads or runs - safe for a file the app did not
 * write.
 */
function xmlOf(entries: Entries, path: string) {
  const bytes = entries.get(path);
  if (!bytes) throw new Error(`That file is missing ${path}`);
  const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file could not be parsed');
  return doc;
}

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
 * A table from rows of strings, with the first row as the head. Cells are
 * `string | null` because that's what DOM textContent answers and accepts.
 */
function tableOf(rows: (string | null)[][]) {
  const t = el('table', 'doc-table');
  let cells = 0;
  const wrap = el('div', 'doc-table-wrap');
  const body = el('tbody');
  rows.forEach((row, n) => {
    if (cells > MAX_CELLS) return;
    const tr = el('tr');
    for (const value of row) {
      // Checked per *cell*, not per row: a .csv of one line with 20M commas
      // (well under MAX_CONTAINER) survived as one row and created 20M
      // elements here - not a truncated read, the tab going down.
      if (cells > MAX_CELLS) break;
      const cell = el(n === 0 ? 'th' : 'td');
      cell.textContent = value;
      tr.append(cell);
      cells++;
    }
    if (n === 0) {
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
 * A Word document as a flow of blocks. `word/document.xml` is a body of `w:p`
 * (paragraph, with a `w:pStyle` name and `w:numPr` list reference) and `w:tbl`
 * (table); paragraphs hold `w:r` runs with bold/italic/underline flags and
 * `w:drawing` picture references.
 *
 * Lists simplify: resolving numbering.xml's abstract levels for a real
 * bullet-vs-number marker is skipped. This reads the indent level and emits a
 * nested `<ul>` - right shape, wrong marker on a numbered list.
 */
async function ooxmlText(blob: Blob, urls: string[]) {
  const entries = await openDoc(blob);
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
    // A run of list paragraphs becomes one list, nested one <ul> deep per level.
    if (!list) { list = el('ul', 'doc-list'); out.append(list); }
    // `Element`, not the `<ul>` it starts as: the walk below may step onto a
    // nested list.
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
  // SAFETY: the cast reads the clamp as a type - Math.min(6, 1-9) can't leave
  // h1..h6; the other two arms are literals.
  const tag = (heading ? 'h' + Math.min(6, Number(heading[1]))
    : name === 'title' ? 'h1'
    : name === 'subtitle' ? 'h2'
    : 'p') as keyof HTMLElementTagNameMap;
  const block = el(tag, name === 'quote' || name === 'intensequote' ? 'doc-quote' : '');

  for (const child of p.children) {
    if (child.localName === 'r') {
      block.append(...wordRun(child, entries, rels, urls, mayDrawImage));
    } else if (child.localName === 'hyperlink') {
      // Address is in the relationship the id points at, but not made live -
      // shown, not offered, for a link out of someone else's document.
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
  // One childOf per flag, not two: same scan, done once rather than twice.
  const on = (what: string) => {
    const flag = props && childOf(props, what);
    return !!(flag && (flag.getAttribute('w:val') ?? '') !== '0');
  };

  for (const child of r.children) {
    if (child.localName === 't') {
      // Only a document/doctype textContent answers null; neither is a child
      // of a run, so `!` is safe.
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
 * A picture inside a run: `r:embed` -> relationship -> archive entry. Every
 * step is a lookup, so a target like `../../etc/passwd` resolves to no entry
 * rather than reaching anywhere.
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
 * A deck, one section per slide, in presentation order - slide numbers are
 * compared numerically since slide10 sorts before slide2 as a string. Does
 * not read the real slide-id list, so a hidden slide is not handled.
 */
async function ooxmlSlides(blob: Blob, urls: string[]) {
  const entries = await openDoc(blob);
  const slides = [...entries.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => slideNo(a) - slideNo(b))
    .slice(0, MAX_PAGES);
  if (!slides.length) throw new Error('That presentation has no slides');

  const frag = document.createDocumentFragment();
  // Across the whole deck, not per slide - this path used to ignore MAX_IMAGES
  // entirely, so a 400-slide deck at 12 blips each minted 4,800 blob URLs,
  // 16x the documented ceiling.
  let images = 0;
  slides.forEach((path, n) => {
    const section = el('section', 'doc-slide');
    section.append(partHead(`Slide ${n + 1}`));
    const body = el('div', 'doc-flow');
    try {
      const doc = xmlOf(entries, path);
      const rels = relationships(entries, path.replace('slides/', 'slides/_rels/') + '.rels');
      // Each shape's text is a:p paragraphs of a:t runs. No title/body
      // distinction - "usually the first shape" isn't a rule any file states.
      for (const p of byLocal(doc, 'p')) {
        const text = byLocal(p, 't').map(t => t.textContent).join('');
        if (!text.trim()) continue;
        const line = el('p');
        line.textContent = text;
        body.append(line);
      }
      let drawn = 0;
      for (const blip of byLocal(doc, 'blip')) {
        if (drawn++ >= 12 || images >= MAX_IMAGES) break;
        const id = blip.getAttribute('r:embed') || blip.getAttribute('embed');
        const target = id && rels.get(id);
        if (!target) continue;
        const url = urlFor(entries, resolveFrom('ppt/slides/', target), urls);
        if (!url) continue;
        images++;
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

// ---------------------------------------------------------------------------
// OOXML: Excel
// ---------------------------------------------------------------------------

/**
 * A workbook, one table per sheet. Cell values are shared-string-table
 * indices when `t="s"`, literal numbers otherwise. Formulas aren't
 * evaluated - the cached value Excel stored is what's shown.
 */
async function ooxmlSheets(blob: Blob) {
  const entries = await openDoc(blob);
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
          // Bounded per row, like tableOf()'s .csv path: a <c> with no `r`
          // attribute falls through to a plain push, otherwise unbounded.
          if (cells.length > 4096) break;
          // Column letter in r="B7" is the position; without it a gap in the
          // middle would close up.
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
 * An ODF text or presentation document. content.xml holds `text:h`, `text:p`,
 * `text:list` and `table:table`; a presentation adds `draw:page` per slide.
 * One reader for both - the only difference is the container.
 */
async function odfText(blob: Blob, urls: string[]) {
  const entries = await openDoc(blob);
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
          // SAFETY: same clamp reasoning as wordParagraph() - always h1..h6
          // regardless of what the outline level claims.
          const h = el(('h' + Math.min(6, Math.max(1, level))) as keyof HTMLElementTagNameMap);
          h.textContent = child.textContent;
          into.append(h);
          break;
        }
        case 'p': {
          const p = el('p');
          p.textContent = child.textContent;
          // A paragraph can hold a frame with a picture inside it.
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
  const entries = await openDoc(blob);
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
        // ODF collapses identical cells into one with a repeat count, which
        // a trailing empty run can claim is in the thousands - capped here.
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
 * A delimited file as a table. Delimiter is sniffed from the first line, not
 * the extension - a locale where comma is the decimal point writes .csv
 * files that are actually semicolon-separated.
 */
async function delimited(blob: Blob) {
  const text = await blob.text();
  const head = text.slice(0, 4096).split('\n')[0] || '';
  const sep = [',', ';', '\t', '|']
    // `as const` so the pair is read as (delimiter, count), not two of either.
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
 * Exported only for its test - one of the few pieces here checkable without
 * a DOM.
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
 * An SVG, drawn - the one reader that puts a document's own markup on the
 * page rather than its text, which is why it's the only one that sanitises.
 * Parsed detached (nothing runs), then walked: anything off the allow-list
 * is dropped whole, every event-handler or off-document-reference attribute
 * is stripped, and what's left is imported.
 *
 * Allow-list, not block-list: a block-list promises the author thought of
 * everything, and SVG sanitiser history says that promise is usually wrong.
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

/**
 * How deep the allow-list walk will follow a tree. scrub() recurses per
 * nesting level, so 50,000 nested <g> elements threw a RangeError (shown as
 * a wrong-but-safe "could not be read"). Past this depth the subtree is
 * removed rather than kept unscrubbed - the only safe default.
 */
const MAX_SVG_DEPTH = 256;

/**
 * Strip one element's attributes down to what is safe to import. Split out
 * of the walk because the walk only scrubbed an element's *children*, not
 * the element it was given - so the root `<svg onload="...">` survived
 * untouched.
 */
function scrubAttrs(node: Element) {
  for (const attr of [...node.attributes]) {
    const name = attr.name.toLowerCase();
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const value = attr.value.trim().toLowerCase();
    // Every on* handler, and anything pointing outside this document, is
    // dropped - a fragment ref (#id) is kept since <use href="#thing"> needs
    // it. Matched on the *local* name: `xl:href` under a custom namespace
    // prefix used to slip past a test naming `xlink:href` literally. `style`
    // is on this list because it's a reference too:
    // `style="fill:url(//attacker/track.svg#a)"` made the request.
    const away = name.startsWith('on')
      || local === 'style'
      || (/^(href|src|from|to|values|begin|end)$/.test(local) && !value.startsWith('#'))
      || value.includes('javascript:')
      || value.includes('data:text/html');
    if (away) node.removeAttribute(attr.name);
  }
}

/**
 * Exported only for tests/documents.test.js. The app's one named exception to
 * "nothing that reads a foreign document may touch innerHTML" - and it had
 * no test in either direction, which is how three separate holes went
 * unnoticed. Not part of the module's interface.
 */
export function scrub(node: Element, depth = 0) {
  if (depth === 0) scrubAttrs(node);
  if (depth >= MAX_SVG_DEPTH) { node.replaceChildren(); return; }
  for (const child of [...node.children]) {
    if (!SVG_OK.has(child.localName)) { child.remove(); continue; }
    // A <style> element is a document stylesheet, not a scoped one - an
    // inline <style> anywhere in an SVG applies to the whole page, and
    // nothing here looked at text content, so a `<style>` that hid elements
    // and leaked data via `background:url(//x)` restyled and exfiltrated
    // from the entire app. Emptied rather than dropped, so a drawing that
    // leans on its own CSS renders unstyled rather than vanishing.
    if (child.localName === 'style') {
      child.textContent = '';
      scrubAttrs(child);
      continue;
    }
    scrubAttrs(child);
    scrub(child, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Comic archives
// ---------------------------------------------------------------------------

/** A CBZ: every picture in it, in the order its names sort. */
async function comic(blob: Blob, urls: string[]) {
  const entries = await openDoc(blob);
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
