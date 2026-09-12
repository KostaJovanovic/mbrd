// OOXML container reader shared by import/slide.ts and ui/documents.ts.
// Bytes in, XML trees + relationship maps out. No DOM, no URLs, no page access.
// Never throws on a wrong document — missing/broken parts return null or empty,
// leaving error policy to callers.

/** Archive entries: name → bytes. Typed over ArrayBuffer (not ArrayBufferLike)
 * so bytes go into Blob without copying. */
export type Entries = Map<string, Uint8Array<ArrayBuffer>>;

/** rId -> target path, as a _rels part gives it - see relationships(). */
export type Rels = Map<string, string>;

const dec = new TextDecoder();

/** Parse an archive entry as XML, or null. DOMParser produces a detached
 * document (safe for untrusted files). Checks for parsererror — DOMParser
 * never throws, it returns a tree describing the error instead. */
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

/** All elements with this local name, any namespace. Spread to snapshot
 * (getElementsByTagNameNS returns a live collection). */
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

/** Numeric suffix from slide7.xml etc., for correct ordering (string sort
 * puts slide10 before slide2). */
export const slideNo = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] || 0);

/** Resolve a relationship target relative to its base part. Only `../` is
 * handled — climbing out of the package just finds nothing in the archive. */
export function resolveFrom(base: string, target: string) {
  const parts = base.replace(/\/$/, '').split('/');
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
