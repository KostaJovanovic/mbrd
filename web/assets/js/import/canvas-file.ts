// JSON Canvas files in and out; storage/json-canvas.ts is the format itself.
// In: a dropped .canvas is merged into the board as one undo step, its file
// nodes found among the files dropped with it (a vault folder, or the pictures
// beside it). Out: a zip of the .canvas and a folder of its files, laid out to
// be unpacked at the top of an Obsidian vault.

import { board, mergeBoard, select } from '../state.ts';
import { normalizeBoard } from '../board-schema.ts';
import { planMerge } from '../merge.ts';
import { toast, busy } from '../notify.ts';
import { addFile, getAsset } from '../storage/assets.ts';
import { saveBlob } from '../storage/storage.ts';
import { writeZip } from '../storage/zip.ts';
import type { ZipEntry } from '../storage/zip.ts';
import { boardToCanvas, canvasToBoard } from '../storage/json-canvas.ts';
import type { Resolved } from '../storage/json-canvas.ts';
import { classify } from '../canvas/renderers.ts';
import type { Item } from '../board-model.ts';

export const looksLikeCanvas = (f: File) => /\.canvas$/i.test(f.name);

/** A path compared as Obsidian writes one: forward slashes, no case. */
const plain = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
const leaf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Merge a .canvas into the board. `companions` are the other files of the same
 * drop, where its file nodes are looked for: by vault path first, then by name
 * alone. A file node with no match comes in as a note naming the file.
 */
export async function importCanvas(file: File, companions: File[]): Promise<boolean> {
  const job = busy('Reading ' + file.name);
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error('that file is not JSON');
    }
    const byPath = companions.map(c => ({ file: c, path: plain(c.webkitRelativePath || c.name) }));
    const stored = new Map<File, Resolved>();
    const keep = async (c: File, type = classify(c)): Promise<Resolved> => {
      const known = stored.get(c);
      if (known) return known;
      const out = { hash: await addFile(c), type, name: c.name };
      stored.set(c, out);
      return out;
    };
    let unmatched = 0;
    const { items, connections } = await canvasToBoard(raw, {
      file: async path => {
        const want = plain(path);
        const hit = byPath.find(c => c.path === want || c.path.endsWith('/' + want))
          ?? byPath.find(c => leaf(c.path) === leaf(want));
        if (!hit) unmatched++;
        return hit ? keep(hit.file) : null;
      },
      text: async (body, name) => keep(new File([body], name, { type: 'text/markdown' }), 'text'),
    });
    const incoming = normalizeBoard({ items, connections });
    const taken = new Set([...board.items.map(i => i.id), ...board.trash.map(t => t.item.id)]);
    const plan = planMerge(incoming, taken, board.items);
    const n = mergeBoard(plan, 'Import ' + file.name);
    if (!n) { toast('There was nothing on that canvas to bring in'); return false; }
    select(plan.items.map(i => i.id));
    toast(`Brought in ${n} card${n === 1 ? '' : 's'} from ${file.name}`
      + (unmatched
        ? `. ${unmatched} of its files ${unmatched === 1 ? 'was' : 'were'} not in the drop and came in as `
          + 'notes naming them: drop the canvas together with its files to bring them in'
        : ''));
    return true;
  } catch (err) {
    toast('Could not read that canvas: ' + (err instanceof Error ? err.message : String(err)), 'error');
    return false;
  } finally {
    job.end();
  }
}

/** A name that is a file name on every system. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'file';

/**
 * The board as `<title>.canvas` and a `<title> files/` folder beside it, in
 * one zip. A card whose bytes are not in memory is written as a text node
 * with its name, so the canvas still says it was there.
 */
export async function exportCanvas(): Promise<boolean> {
  const base = safeName(board.title || 'board');
  const folder = `${base} files`;
  const entries: ZipEntry[] = [];
  const byHash = new Map<string, string>();
  const taken = new Set<string>();
  const fileFor = (item: Item): string | null => {
    const hash = item.asset?.hash;
    const asset = hash ? getAsset(hash) : null;
    if (!hash || !asset) return null;
    const had = byHash.get(hash);
    if (had) return had;
    const name = safeName(item.name || asset.name || hash.slice(0, 12));
    let path = `${folder}/${name}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) {
      const dot = name.lastIndexOf('.');
      path = `${folder}/${dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`}`;
    }
    taken.add(path.toLowerCase());
    byHash.set(hash, path);
    entries.push({ name: path, data: asset.blob });
    return path;
  };
  const canvas = boardToCanvas(board.items, board.connections, fileFor);
  if (!canvas.nodes.length) { toast('There is nothing on the board to export yet'); return false; }
  const job = busy('Writing the canvas');
  try {
    const json = new TextEncoder().encode(JSON.stringify(canvas, null, '\t'));
    const zip = await writeZip([{ name: `${base}.canvas`, data: json }, ...entries], { mime: 'application/zip' });
    await saveBlob(zip, `${base} (JSON Canvas).zip`);
    toast('Saved the board as a JSON Canvas. Unpack it at the top of an Obsidian vault');
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return false;
    toast('Could not export the canvas: ' + (err instanceof Error ? err.message : String(err)), 'error');
    return false;
  } finally {
    job.end();
  }
}
