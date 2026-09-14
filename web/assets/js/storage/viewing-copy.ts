// The viewing copy a share link can send instead of the whole board: each
// photograph as its ~1024 px display copy, each clip as its poster frame, and
// no bin and no history. Pure over a serialised board. The packer then carries
// only the bytes the copy still names, which is where the saving comes from.

import type { Item } from '../board-model.ts';
import type { PackedBoard } from './mbrd.ts';

/** An asset hash out of `meta`, or '' for anything that is not one. */
const hashIn = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The board as a recipient would view it (research/old/done-2026-09-15.md,
 * R13). `held` says whether this machine has the bytes for a hash: a card is
 * only pointed at a smaller picture that will actually be in the file.
 *
 * - A photograph with a baked display copy (`meta.display`) shows that copy.
 *   Its crop, turn and cut-out still apply: `crop` is fractions of the source,
 *   so it is the same region of a smaller picture.
 * - A clip with a poster (`meta.cover`) becomes a picture of that poster. A
 *   clip is most of the weight of most heavy boards, and a frame of it is what
 *   a viewer sees before they press play anyway.
 * - The bin and the history go: both hold originals the copy leaves out.
 *
 * Everything else rides as it is. Nothing given is changed.
 */
export function viewingCopy<T extends PackedBoard>(data: T, held: (hash: string) => boolean): T {
  const copy: T = { ...data, items: data.items.map(item => lighter(item, held)), trash: [] };
  delete copy.timeline;
  return copy;
}

function lighter(item: Item, held: (hash: string) => boolean): Item {
  const meta = item.meta || {};
  const own = item.asset?.hash;
  if (item.type === 'image') {
    const display = hashIn(meta.display);
    if (!display || display === own || !held(display)) return item;
    return { ...item, asset: { hash: display }, meta: { ...meta } };
  }
  if (item.type === 'video') {
    const poster = hashIn(meta.cover);
    if (!poster || !held(poster)) return item;
    return { ...item, type: 'image', asset: { hash: poster }, meta: { ...meta } };
  }
  return item;
}
