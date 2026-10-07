// A dropped PureRef .pur, merged into the board as one undo step; the reading
// is import/pureref.ts. Every picture is stored as a file of its own, placed,
// sized, turned, cropped and mirrored as PureRef had it, and PureRef's text as
// notes. A picture PureRef only linked to comes in as a note naming it.

import { board, mergeBoard, select, NOTE_MAX } from '../state.ts';
import { normalizeBoard } from '../board-schema.ts';
import { planMerge } from '../merge.ts';
import { toast, busy } from '../notify.ts';
import { addFile } from '../storage/assets.ts';
import { lift, fileKey } from '../consent.ts';
import { readPur } from './pureref.ts';
import type { PurRead } from './pureref.ts';
import type { Incoming } from '../storage/json-canvas.ts';

export const looksLikePur = (f: File) => /\.pur$/i.test(f.name);

const base = (name: string) => name.replace(/\.pur$/i, '') || 'PureRef';

export async function importPur(file: File): Promise<boolean> {
  const job = busy('Reading ' + file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let read: PurRead;
    try {
      read = readPur(bytes);
    } catch (err) {
      if (!await lift(err, fileKey(file), file.name)) throw err;
      read = readPur(bytes, { lift: true });
    }
    const hashes = new Map<number, string>();
    const items: Incoming[] = [];
    const order = [...read.placed].sort((a, b) => a.z - b.z);
    for (const [z, p] of order.entries()) {
      // PureRef's y runs down and its turns run clockwise; the board's do neither.
      const box = { id: `pur-${z}`, x: p.x, y: -p.y, w: Math.max(8, p.w), h: Math.max(8, p.h), rot: -p.rot, z };
      if (p.kind === 'image') {
        let hash = hashes.get(p.picture);
        if (!hash) {
          const pic = read.pictures[p.picture];
          const ext = pic.mime === 'image/png' ? 'png' : 'jpg';
          const named = p.name && !/\.[a-z0-9]{2,5}$/i.test(p.name) ? `${p.name}.${ext}` : p.name;
          hash = await addFile(new File([pic.bytes.slice()], named || `${base(file.name)} ${p.picture + 1}.${ext}`,
            { type: pic.mime }));
          hashes.set(p.picture, hash);
        }
        const meta: Record<string, unknown> = {};
        if (p.crop) meta.crop = p.crop;
        if (p.flip) meta.flip = p.flip;
        items.push({ ...box, type: 'image', name: p.name, asset: { hash }, meta });
      } else if (p.kind === 'text') {
        items.push({ ...box, type: 'note', meta: { text: p.text.slice(0, NOTE_MAX) } });
      } else {
        items.push({ ...box, type: 'note', meta: { text: `Linked in PureRef, not saved in the file: ${p.name || 'a picture'}`.slice(0, NOTE_MAX) } });
      }
    }
    const incoming = normalizeBoard({ items, connections: [] });
    const taken = new Set([...board.items.map(i => i.id), ...board.trash.map(t => t.item.id)]);
    const plan = planMerge(incoming, taken, board.items);
    const n = mergeBoard(plan, 'Import ' + file.name);
    if (!n) { toast('There was nothing in that PureRef file to bring in'); return false; }
    select(plan.items.map(i => i.id));
    toast(`Brought in ${n} card${n === 1 ? '' : 's'} from ${file.name}`
      + (read.laidOut ? '' : '. Its layout could not be read, so its pictures are in a grid'));
    return true;
  } catch (err) {
    toast('Could not read that PureRef file: ' + (err instanceof Error ? err.message : String(err)), 'error');
    return false;
  } finally {
    job.end();
  }
}
