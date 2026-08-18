// The OOXML container, read once for the two halves of the app that read it.
//
// A .docx, .pptx and .xlsx are all the same thing: a ZIP of XML parts that point
// at each other through a side table of relationships. Two places in this app
// walk that structure - import/slide.ts, which composites a deck's first slide
// into the picture a card draws, and ui/documents.ts, which reads a whole
// document into the viewer - and until there were two, all of this lived in the
// second one.
//
// It lives here rather than there because of which way the layering runs. The
// importer may not reach into ui/, and tests/layers.test.js says so outright; so
// the choice was a second copy of the relationship walk in import/, or one copy
// low enough for both. A file format with two answers to "where does this
// picture live" is the kind of disagreement that survives for a year, which is
// the whole argument for the module.
//
// Nothing here builds a node, mints a URL or touches the page. It takes bytes
// out of an archive and answers with an XML tree, a map and a path - what the
// caller does with those is the caller's business, and that is what lets the
// importer and the viewer share it without sharing anything else.
//
// **Nothing here throws on a document that is merely wrong.** A missing part, a
// tree that will not parse, a relationship table that is not there - all of them
// answer null or empty. The two callers want opposite things from a failure (a
// card falls back to grey, a viewer says a sentence), so the decision is theirs
// to make and neither is served by an exception thrown from down here.

/**
 * An archive as readZip() answers it: the entry name, and the bytes.
 *
 * The buffer is named because storage/zip.ts names it: a Uint8Array over an
 * ArrayBuffer rather than over ArrayBufferLike, which is what lets the bytes go
 * straight into a Blob without being copied first.
 */
export type Entries = Map<string, Uint8Array<ArrayBuffer>>;

/** rId -> target path, as a _rels part gives it - see relationships(). */
export type Rels = Map<string, string>;

const dec = new TextDecoder();

/**
 * An archive entry parsed as XML, or null.
 *
 * DOMParser and not a hand-rolled XML reader, because the browser has one and it
 * is the same one the rest of the platform uses. It parses into a *detached*
 * document with no browsing context - nothing in it loads, runs or navigates -
 * which is what makes it safe to point at a file the app did not write.
 *
 * `parsererror` is checked for rather than trusted to throw, because DOMParser
 * does not throw: a malformed document comes back as a well-formed tree
 * describing the error, and a caller that does not look for it walks that tree
 * instead of the one it asked for.
 */
export function xmlPart(entries: Entries, path: string): Document | null {
  const bytes = entries.get(path);
  if (!bytes) return null;
  try {
    const doc = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
    return doc.querySelector('parsererror') ? null : doc;
  } catch {
    return null;
  }
}

/**
 * Every element with this local name, whatever namespace prefix it carries.
 *
 * getElementsByTagNameNS('*', name) answers by local name across every
 * namespace natively - O(matches) - where scanning getElementsByTagName('*')
 * and filtering was O(every element in the part). Spread into an array here so
 * the return stays the snapshot every caller already treats it as, rather than a
 * live collection.
 */
export const byLocal = (root: Document | Element, name: string): Element[] =>
  [...root.getElementsByTagNameNS('*', name)];

/** The first child element with this local name, or null. */
export const childOf = (node: Element, name: string) =>
  [...node.children].find(n => n.localName === name) || null;

/** rId -> target path, from a _rels part. Missing is an empty map, not an error. */
export function relationships(entries: Entries, path: string): Rels {
  const map: Rels = new Map();
  const doc = xmlPart(entries, path);
  if (!doc) return map;
  for (const r of byLocal(doc, 'Relationship')) {
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * The number in slide7.xml or sheet12.xml, for ordering.
 *
 * Ordering matters and is not the order the entries happen to be in: slide10
 * sorts before slide2 as a string. Pulling the number out and comparing it as a
 * number is the whole of it - a real reading of the presentation part's slide id
 * list would also handle a hidden slide, and this does not.
 */
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
