// JSON Canvas (jsoncanvas.org, Obsidian's .canvas) to and from a board. Pure:
// the bytes of a picture are the caller's to fetch or store, through the two
// callbacks, so this runs in a test with no browser.
//
// The two spaces differ in two ways. A canvas node is placed by its top-left
// corner with y running down; a board item by its centre with y running up
// (geometry.ts). Text nodes are notes, file nodes are the card for that file,
// link nodes are links, groups are fences, edges are connections.
//
// The import parses a file the app did not write, so every field is checked
// where it is read and the whole is capped (MAX_NODES), and an unreadable file
// is a plain Error: nothing here is a size somebody could agree to lift.

import type { Connection, ConnMeta, Item, ItemType } from '../board-model.ts';
import { NOTE_MAX } from '../board-model.ts';
import { flattenNoteRich } from '../canvas/note-model.ts';
import type { NoteRichInput } from '../canvas/note-model.ts';
import { isRecord } from '../util.ts';

export type CanvasNode = {
  id: string,
  type: 'text' | 'file' | 'link' | 'group',
  x: number,
  y: number,
  width: number,
  height: number,
  color?: string,
  text?: string,
  file?: string,
  url?: string,
  label?: string,
};

export type CanvasEdge = {
  id: string,
  fromNode: string,
  toNode: string,
  fromEnd?: 'none' | 'arrow',
  toEnd?: 'none' | 'arrow',
  color?: string,
  label?: string,
};

export type JsonCanvas = { nodes: CanvasNode[], edges: CanvasEdge[] };

/** More nodes than any canvas a person drew; past it the file is not one. */
export const MAX_NODES = 5000;
export const MAX_EDGES = 10000;

/** The six preset colours of the format, by the connection colour nearest each. */
const EDGE_COLOUR: Record<string, string> = { danger: '1', warm: '2', leaf: '4', accent: '5' };
const PRESET_TO_CONN: Record<string, ConnMeta['color']> = { 1: 'danger', 2: 'warm', 3: 'warm', 4: 'leaf', 5: 'accent', 6: 'accent' };

/** The card types a board has that a canvas has no node for and nothing to carry. */
const SKIPPED = new Set<string>(['title', 'ghost', 'gone']);

const round = (n: number) => Math.round(n);

/** A note's text as Markdown, which is what a canvas text node holds. */
function noteText(item: Item): string {
  if (typeof item.meta?.text === 'string') return item.meta.text;
  // SAFETY: a record is a NoteRichInput; normalizeNoteRich() inside checks every field.
  return isRecord(item.meta?.rich) ? flattenNoteRich(item.meta.rich as NoteRichInput) : '';
}

/**
 * The board as a canvas. `fileFor` answers with the path a card's file will
 * have beside the .canvas, or null for a card with no file to write.
 */
export function boardToCanvas(
  items: readonly Item[], connections: readonly Connection[],
  fileFor: (item: Item) => string | null,
): JsonCanvas {
  const nodes: CanvasNode[] = [];
  const kept = new Set<string>();
  // Groups first, so a canvas app draws them under what they hold.
  const ordered = [...items].sort((a, b) =>
    Number(b.type === 'fence') - Number(a.type === 'fence') || a.z - b.z);
  for (const item of ordered) {
    if (SKIPPED.has(item.type)) continue;
    const box = {
      id: item.id,
      x: round(item.x - item.w / 2),
      y: round(-(item.y + item.h / 2)),
      width: round(item.w),
      height: round(item.h),
    };
    let node: CanvasNode;
    if (item.type === 'note') node = { ...box, type: 'text', text: noteText(item) };
    else if (item.type === 'fence') {
      node = { ...box, type: 'group' };
      if (item.name) node.label = item.name;
    } else if (item.type === 'link' && typeof item.meta?.url === 'string') node = { ...box, type: 'link', url: item.meta.url };
    else if (item.type === 'swatch' && typeof item.meta?.hex === 'string') {
      node = { ...box, type: 'text', text: item.meta.hex.toUpperCase(), color: item.meta.hex };
    } else {
      const file = fileFor(item);
      node = file ? { ...box, type: 'file', file } : { ...box, type: 'text', text: item.name || item.type };
    }
    nodes.push(node);
    kept.add(item.id);
  }
  const edges: CanvasEdge[] = [];
  connections.forEach(([a, b, meta], i) => {
    if (!kept.has(a) || !kept.has(b)) return;
    const dir = meta?.dir ?? 'none';
    const edge: CanvasEdge = {
      id: `edge-${i}`, fromNode: a, toNode: b,
      // The format's default is an arrow at the far end, so each end is said.
      fromEnd: dir === 'back' || dir === 'both' ? 'arrow' : 'none',
      toEnd: dir === 'fwd' || dir === 'both' ? 'arrow' : 'none',
    };
    const colour = meta?.color && EDGE_COLOUR[meta.color];
    if (colour) edge.color = colour;
    if (meta?.label) edge.label = meta.label;
    edges.push(edge);
  });
  return { nodes, edges };
}

/** What a canvas file node turned into, once the caller has found its bytes. */
export type Resolved = { hash: string, type: ItemType, name: string };

/** A board item before normalizeBoard() fills in the rest. */
export type Incoming = Partial<Item> & { id: string, type: ItemType, x: number, y: number, w: number, h: number };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * A parsed .canvas as board items and connections. `file` finds the bytes of
 * a file node by its path; `text` stores a text node too long for a note as a
 * Markdown document. A node either cannot answer becomes a note saying what it
 * was, so nothing in the canvas goes missing without a trace.
 */
export async function canvasToBoard(
  raw: unknown,
  { file, text }: {
    file: (path: string) => Promise<Resolved | null>,
    text: (body: string, name: string) => Promise<Resolved | null>,
  },
): Promise<{ items: Incoming[], connections: Connection[] }> {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) throw new Error('that is not a JSON Canvas file');
  if (raw.nodes.length > MAX_NODES) throw new Error(`that canvas has more than ${MAX_NODES} nodes`);
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawEdges.length > MAX_EDGES) throw new Error(`that canvas has more than ${MAX_EDGES} edges`);

  const items: Incoming[] = [];
  const ids = new Set<string>();
  let z = 0;
  // Groups first, then the rest, so a fence is under what it holds.
  const nodes = [...raw.nodes].filter(isRecord)
    .sort((a, b) => Number(b.type === 'group') - Number(a.type === 'group'));
  for (const n of nodes) {
    const id = str(n.id);
    const x = num(n.x), y = num(n.y), w = num(n.width), h = num(n.height);
    if (!id || ids.has(id) || x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
    ids.add(id);
    const box = { id, x: x + w / 2, y: -(y + h / 2), w, h, z: z++ };
    const note = (body: string): Incoming => ({ ...box, type: 'note', meta: { text: body } });
    if (n.type === 'group') {
      items.push({ ...box, type: 'fence', name: str(n.label).slice(0, 200) });
    } else if (n.type === 'link' && str(n.url)) {
      items.push({ ...box, type: 'link', name: '', meta: { url: str(n.url) } });
    } else if (n.type === 'file' && str(n.file)) {
      const found = await file(str(n.file));
      items.push(found
        ? { ...box, type: found.type, name: found.name, asset: { hash: found.hash } }
        : note(str(n.file)));
    } else if (n.type === 'text') {
      const body = str(n.text);
      if (body.length <= NOTE_MAX) { items.push(note(body)); continue; }
      const doc = await text(body, `${id}.md`);
      items.push(doc
        ? { ...box, type: doc.type, name: doc.name, asset: { hash: doc.hash } }
        : note(body.slice(0, NOTE_MAX)));
    }
  }

  const connections: Connection[] = [];
  for (const e of rawEdges) {
    if (!isRecord(e)) continue;
    const a = str(e.fromNode), b = str(e.toNode);
    if (!ids.has(a) || !ids.has(b) || a === b) continue;
    const atTo = (e.toEnd ?? 'arrow') === 'arrow';
    const atFrom = e.fromEnd === 'arrow';
    const meta: ConnMeta = {};
    if (atTo || atFrom) meta.dir = atTo && atFrom ? 'both' : atTo ? 'fwd' : 'back';
    const colour = PRESET_TO_CONN[str(e.color)];
    if (colour) meta.color = colour;
    if (str(e.label)) meta.label = str(e.label);
    connections.push(Object.keys(meta).length ? [a, b, meta] : [a, b]);
  }
  return { items, connections };
}
