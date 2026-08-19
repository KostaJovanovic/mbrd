// Enough XML to read a model out of one, and no more.
//
// Three of the formats in this family are XML - 3MF, AMF and Collada - and none
// of them may go through `DOMParser`. Two reasons, and either alone would be
// enough:
//
// - **There is no DOM here.** Every parser in mesh/ is testable against real
//   bytes under node with nothing installed, which is the property that makes a
//   hand-written binary reader trustworthy at all. A reader that needs a browser
//   to run cannot be fed a broken file in a test.
// - **These files are foreign documents.** CLAUDE.md's rule is that nothing
//   reading one may touch `innerHTML`, and the reason generalises: the less of a
//   document model a foreign file gets to build, the less there is to get wrong.
//   What comes out of here is numbers and names, never nodes.
//
// So: a scanner, not a parser. `scanXML()` walks tags in document order and
// calls back; `parseXML()` builds a small tree on top of it for the places that
// genuinely need one. The distinction matters for size - a 3MF writes one
// `<vertex>` element *per vertex*, so a half-million-vertex part is a
// half-million elements, and a tree of objects for that is a hundred megabytes
// of book-keeping to read nine megabytes of floats. The scanner reads it
// without allocating anything per vertex.
//
// **DOCTYPE is skipped, not processed.** No entity declarations are read and no
// external entity is ever fetched, so the classic expansion attack ("billion
// laughs") has nothing to expand and an XXE has nothing to include. The five
// built-in entities and numeric character references are all that decode.
//
// Namespace prefixes are dropped from element and attribute names. Every format
// here uses one vocabulary per document plus an extension namespace or two, and
// the extensions do not collide with the core names - so `p:triangle` and
// `triangle` answering to the same lookup is what a reader of these files
// actually wants.

import { MeshError } from './shared.ts';

/** The most elements a model document may contain, tags and all. A 3MF's
 *  per-vertex elements make this the count that grows, so it is generous - past
 *  it the document is not a model but a way of spending a minute. */
const MAX_ELEMENTS = 8_000_000;

export type XmlAttrs = Record<string, string>;

export type XmlHandlers = {
  /** A start tag, or the start half of a self-closing one. `attrs` is reused
   *  between calls, so a handler that keeps it must copy it. */
  open?: (name: string, attrs: XmlAttrs, selfClosing: boolean) => void;
  /** An end tag, and also the close of a self-closing element - so every
   *  `open` is matched by exactly one `close` and a handler can count depth. */
  close?: (name: string) => void;
  /** Character data between tags, entity-decoded, only where it is not blank.
   *  Not accumulated: a run split by a comment arrives as two calls. */
  text?: (value: string) => void;
};

/**
 * Walk an XML document, calling back per tag.
 *
 * Deliberately forgiving about what it is not reading: processing
 * instructions, comments, CDATA and DOCTYPE are stepped over rather than
 * reported, and an unmatched end tag closes what it can. A model file written
 * by a slicer is not going to be well-formed by luck, and the reader's job is to
 * find the geometry rather than to be an XML conformance suite.
 *
 * What it is *not* forgiving about is running off the end. Every one of the
 * skip cases below is bounded, and a start delimiter with no end is the end of
 * the document rather than an index that keeps going.
 */
export function scanXML(text: string, on: XmlHandlers) {
  const len = text.length;
  let i = 0;
  let elements = 0;
  // Reused across every open tag. Documented on `open` above: a handler that
  // wants to keep the attributes copies them. Rebuilding this object per element
  // is the single biggest allocation in reading a 3MF.
  let attrs: XmlAttrs = {};

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;

    if (lt > i && on.text) {
      const raw = text.slice(i, lt);
      // Blank runs are the indentation between tags and are the overwhelming
      // majority of the text nodes in any of these documents.
      if (raw.trim()) on.text(decodeEntities(raw));
    }

    const next = text[lt + 1];

    if (next === '!') {
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt + 4);
        i = end < 0 ? len : end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt + 9);
        const body = text.slice(lt + 9, end < 0 ? len : end);
        // CDATA is literal by definition - no entity decoding.
        if (on.text && body.trim()) on.text(body);
        i = end < 0 ? len : end + 3;
        continue;
      }
      // DOCTYPE, and anything else beginning `<!`. Skipped whole, internal
      // subset included: the bracketed part may contain `>` so the scan for the
      // end has to know about it, and nothing inside is ever read.
      i = skipDeclaration(text, lt);
      continue;
    }

    if (next === '?') {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }

    if (next === '/') {
      const gt = text.indexOf('>', lt + 2);
      if (gt < 0) break;
      if (on.close) on.close(localName(text.slice(lt + 2, gt).trim()));
      i = gt + 1;
      continue;
    }

    // An ordinary start tag. Find its `>`, honouring quotes - an attribute value
    // may contain one, and `<part name="a>b"/>` is legal and does occur.
    const gt = tagEnd(text, lt + 1);
    if (gt < 0) break;
    if (++elements > MAX_ELEMENTS) throw new MeshError('This document has more elements than a model has');
    let body = text.slice(lt + 1, gt);
    let selfClosing = false;
    if (body.endsWith('/')) { selfClosing = true; body = body.slice(0, -1); }

    const sp = body.search(/[\s/]/);
    const name = localName(sp < 0 ? body : body.slice(0, sp));
    if (on.open) {
      attrs = {};
      if (sp >= 0) readAttrs(body, sp, attrs);
      on.open(name, attrs, selfClosing);
    }
    if (selfClosing && on.close) on.close(name);
    i = gt + 1;
  }
}

/** The index of the `>` that ends a start tag, skipping quoted regions. */
function tagEnd(text: string, from: number) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/** Past a `<!...>`, counting the brackets of an internal DTD subset so that a
 *  `>` inside one does not end the declaration early. */
function skipDeclaration(text: string, lt: number) {
  let depth = 0;
  for (let i = lt + 2; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') { if (depth > 0) depth--; }
    else if (c === '>' && !depth) return i + 1;
  }
  return text.length;
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function readAttrs(body: string, from: number, into: XmlAttrs) {
  ATTR.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(body))) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    into[localName(m[1])] = decodeEntities(value);
  }
}

/** `ns:thing` -> `thing`, lowercased. The argument for dropping the prefix is in
 *  the header; lowercasing is the same call every other reader in this family
 *  makes about extensions and tags, and no format here distinguishes two
 *  elements by case. */
function localName(raw: string) {
  const colon = raw.indexOf(':');
  return (colon < 0 ? raw : raw.slice(colon + 1)).toLowerCase();
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * The five built-in entities and numeric references. Nothing else.
 *
 * An `&foo;` that is not one of these is left exactly as written rather than
 * dropped: it came from a document that declared it in a DOCTYPE this reader
 * skipped, and in a filename or a material name the literal text is a better
 * answer than an empty string.
 */
export function decodeEntities(s: string) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points would throw out of
      // fromCodePoint, which is a crash rather than a bad name.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// A tree, for the one format that needs one
// ---------------------------------------------------------------------------

export type XmlNode = {
  name: string;
  attrs: XmlAttrs;
  kids: XmlNode[];
  /** The element's own character data, concatenated. Collada keeps its arrays
   *  here and they are the only reason this exists. */
  text: string;
};

/**
 * The whole document as a tree.
 *
 * Used by the Collada reader and by nothing else, because Collada is the one
 * format here whose geometry is reached by following references across the
 * document - a `<triangles>` names an `<input>` which names a `<source>` which
 * names a `<float_array>`, and the array may appear before or after the thing
 * that uses it. A scan cannot resolve that in one pass; a tree can, and
 * Collada's element count is small because its numbers live in text.
 *
 * 3MF and AMF do not use this, on purpose. See the header.
 */
export function parseXML(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, kids: [], text: '' };
  const stack: XmlNode[] = [root];
  scanXML(text, {
    open(name, attrs) {
      const node: XmlNode = { name, attrs: { ...attrs }, kids: [], text: '' };
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
    },
    close() {
      // Never past the root. An unbalanced end tag in a foreign document is
      // ordinary, and popping the root would leave every later element with no
      // parent at all.
      if (stack.length > 1) stack.pop();
    },
    text(value) {
      const top = stack[stack.length - 1];
      top.text = top.text ? top.text + ' ' + value : value;
    },
  });
  return root;
}

/** Every descendant with this name, in document order. */
export function findAll(node: XmlNode, name: string, into: XmlNode[] = []) {
  for (const kid of node.kids) {
    if (kid.name === name) into.push(kid);
    findAll(kid, name, into);
  }
  return into;
}

/** The first descendant with this name, or null. */
export function find(node: XmlNode, name: string): XmlNode | null {
  for (const kid of node.kids) {
    if (kid.name === name) return kid;
    const deep = find(kid, name);
    if (deep) return deep;
  }
  return null;
}

/** The immediate children with this name. */
export function children(node: XmlNode, name: string) {
  return node.kids.filter(k => k.name === name);
}

/**
 * Whitespace-separated numbers out of an element's text.
 *
 * `+Infinity` and `NaN` are what a malformed number produces here rather than a
 * throw, and every caller either bounds-checks the result or lets finish()'s
 * finiteness guard have it - which is the same treatment the OBJ and STL readers
 * give a bad coordinate.
 */
export function floats(text: string) {
  const out: number[] = [];
  for (const tok of text.split(/\s+/)) {
    if (tok) out.push(+tok);
  }
  return out;
}
