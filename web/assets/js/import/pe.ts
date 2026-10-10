// Extract the icon from a Windows PE (.exe/.dll). Walks the resource tree:
// RT_GROUP_ICON picks the best member, RT_ICON holds its bytes, wrapAsIco()
// reassembles them. PNG members preferred over DIB; lowest-numbered group (not
// tree-first) matches Explorer. All offsets are RVAs — section base subtracted.
// No RT_VERSION, no .NET, no NE: picture only.

import { wrapAsIco, isPng, isDrawablePng } from './winimage.ts';
import { le16, le32 } from '../bytes.ts';
import type { Bytes } from '../bytes.ts';
import { oversize, isOversize, mb } from '../consent.ts';

/** The extensions worth looking inside. Every one of these is a PE container. */
const PE_EXTS = new Set(['exe', 'dll', 'scr', 'cpl', 'ocx', 'mun', 'ax', 'efi']);

/** Whether this file is one this module will open. */
export const isExecutable = (ext: string) => PE_EXTS.has(ext);

/** Header budget — the section table is always in the first few KB. */
const HEAD = 1024 * 1024;

/** Resource section budget. Whole .rsrc is pulled in one slice (graph of
 * self-offsets). Throws Oversize past this — caller decides via `lift`. */
const MAX_RSRC = 24 * 1024 * 1024;

/** Caps on the tree itself. Each is "this file is lying", not a correctness bound. */
const MAX_ENTRIES = 4096;
const MAX_GROUPS = 64;
const MAX_MEMBERS = 64;

/**
 * Directory entries one exeIcon() run may read, across the whole tree. The
 * offsets are the file's own, so N entries that all point back at their own
 * directory make the two-level walk under each member read N x N entries -
 * N³ in all, a quarter of an hour at N = 4096. An honest tree reads each
 * entry about once: MAX_ENTRIES icons, each over a one-entry language level,
 * is under a tenth of this.
 */
const MAX_WORK = 1 << 17;

/** What is left of MAX_WORK for this run. */
type Walk = { left: number };

/** Resource type ids, from the format. */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/** The smallest icon worth showing on a card. Below this a card is better off blank. */
const MIN_EDGE = 16;

/** A PNG member at least this wide is taken in preference to any bitmap. */
const PNG_ENOUGH = 48;

/** A leaf's bytes, as the resource tree addresses them. */
type Leaf = { rva: number, size: number };

/** One member of an icon group, as its 14-byte directory record states it. */
type Member = { w: number, h: number, planes: number, bits: number, id: number };

/** Best icon from the PE resource tree, or null. */
export async function exeIcon(
  file: Blob,
  lift = false,
): Promise<{ blob: Blob, ext: string } | null> {
  try {
    const rsrc = await resourceSection(file, lift);
    if (!rsrc) return null;

    const { bytes, rva } = rsrc;
    const walk: Walk = { left: MAX_WORK };
    const root = readDirectory(bytes, 0, walk);
    if (!root) return null;

    const groupsAt = root.find(e => e.id === RT_GROUP_ICON && e.isDir)?.off;
    const iconsAt = root.find(e => e.id === RT_ICON && e.isDir)?.off;
    if (iconsAt === undefined) return null;

    // Every RT_ICON leaf by its id, which is the key the group records name.
    const members = new Map<number, Leaf>();
    for (const entry of readDirectory(bytes, iconsAt, walk) || []) {
      if (!entry.isDir || members.size >= MAX_ENTRIES) continue;
      const leaf = firstLeaf(bytes, entry.off, 1, walk);
      if (leaf) members.set(entry.id, leaf);
    }
    if (!members.size) return null;

    const picked = groupsAt === undefined
      // No group — fall back to biggest lone PNG member (e.g. icon-only DLLs).
      ? bestLoose(bytes, rva, members)
      : bestFromGroups(bytes, rva, groupsAt, members, walk);
    return picked;
  } catch (err) {
    if (isOversize(err)) throw err;
    console.warn('[mbrd] exe: no icon came out of the resource tree', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Getting to the resource section
// ---------------------------------------------------------------------------

/** The .rsrc section bytes + its base RVA (needed to map tree offsets to buffer positions). */
async function resourceSection(
  file: Blob,
  lift: boolean,
): Promise<{ bytes: Bytes, rva: number } | null> {
  const head = new Uint8Array(await file.slice(0, Math.min(HEAD, file.size)).arrayBuffer());
  if (head.length < 64 || head[0] !== 0x4D || head[1] !== 0x5A) return null;   // 'MZ'

  const peAt = le32(head, 0x3C);
  if (peAt <= 0 || peAt + 24 > head.length) return null;
  // 'PE\0\0'
  if (head[peAt] !== 0x50 || head[peAt + 1] !== 0x45 || head[peAt + 2] || head[peAt + 3]) return null;

  const sections = le16(head, peAt + 6);
  const optSize = le16(head, peAt + 20);
  const optAt = peAt + 24;
  if (!sections || sections > 96 || optSize < 2 || optAt + optSize > head.length) return null;

  // PE32 data directory at +96, PE32+ at +112 — magic distinguishes them.
  const magic = le16(head, optAt);
  const dirAt = magic === 0x20B ? optAt + 112 : magic === 0x10B ? optAt + 96 : -1;
  if (dirAt < 0) return null;
  // Index 2 = resource directory.
  const count = le32(head, dirAt - 4);
  if (count < 3 || dirAt + 24 > head.length) return null;

  const wantRva = le32(head, dirAt + 16);
  const wantSize = le32(head, dirAt + 20);
  if (!wantRva || !wantSize) return null;
  if (!lift && wantSize > MAX_RSRC) {
    throw oversize(
      'container-bytes',
      `This program's resources are ${mb(wantSize)}, past the ${mb(MAX_RSRC)} they are read at to find its icon.`,
    );
  }

  // Section table: 40 bytes each, maps virtual → file offsets.
  const tableAt = optAt + optSize;
  for (let i = 0; i < sections; i++) {
    const at = tableAt + i * 40;
    if (at + 40 > head.length) return null;
    const va = le32(head, at + 12);
    const rawSize = le32(head, at + 16);
    const rawAt = le32(head, at + 20);
    if (wantRva < va || wantRva >= va + Math.max(rawSize, le32(head, at + 8))) continue;

    // Raw size may exceed virtual size due to file alignment — take the smaller.
    const start = rawAt + (wantRva - va);
    const length = Math.min(wantSize, Math.max(0, rawSize - (wantRva - va)));
    if (!length || start + length > file.size) return null;
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    return bytes.length ? { bytes, rva: wantRva } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The resource tree
// ---------------------------------------------------------------------------

/** One entry of an IMAGE_RESOURCE_DIRECTORY. */
type Entry = { id: number, named: boolean, isDir: boolean, off: number };

/** Directory entries at `at`. Both named and id entries walked (skipping named
 * entries would misalign the subsequent reads). */
function readDirectory(b: Bytes, at: number, walk: Walk): Entry[] | null {
  if (at < 0 || at + 16 > b.length) return null;
  const named = le16(b, at + 12);
  const ids = le16(b, at + 14);
  const total = named + ids;
  if (!total || total > MAX_ENTRIES) return null;
  if (at + 16 + total * 8 > b.length) return null;
  // A plain Error, not an Oversize: past this the tree loops, it is not large.
  walk.left -= total;
  if (walk.left < 0) throw new Error('the resource tree points back into itself');

  const out: Entry[] = [];
  for (let i = 0; i < total; i++) {
    const p = at + 16 + i * 8;
    const name = le32(b, p);
    const to = le32(b, p + 4);
    out.push({
      // High bit = named entry (offset to string); clear = numeric id.
      id: name & 0x80000000 ? -1 : name,
      named: !!(name & 0x80000000),
      // High bit of second word = subdirectory, else leaf.
      isDir: !!(to & 0x80000000),
      off: to & 0x7FFFFFFF,
    });
  }
  return out;
}

/** First leaf under `at`, descending up to `depth` levels. Walks the left edge
 * — language level is irrelevant (same icon in every locale). */
function firstLeaf(b: Bytes, at: number, depth: number, walk: Walk): Leaf | null {
  if (depth < 0) return null;
  const entries = readDirectory(b, at, walk);
  if (!entries) {
    // Leaf: IMAGE_RESOURCE_DATA_ENTRY (RVA + size).
    if (at + 8 > b.length) return null;
    const rva = le32(b, at);
    const size = le32(b, at + 4);
    return rva && size ? { rva, size } : null;
  }
  for (const entry of entries) {
    const found = entry.isDir
      ? firstLeaf(b, entry.off, depth - 1, walk)
      : leafAt(b, entry.off);
    if (found) return found;
  }
  return null;
}

/** An IMAGE_RESOURCE_DATA_ENTRY read directly. */
function leafAt(b: Bytes, at: number): Leaf | null {
  if (at < 0 || at + 8 > b.length) return null;
  const rva = le32(b, at);
  const size = le32(b, at + 4);
  return rva && size && size <= b.length ? { rva, size } : null;
}

/** A leaf's bytes, mapping its image-relative address back into the section. */
function payload(b: Bytes, rva: number, leaf: Leaf): Bytes | null {
  const at = leaf.rva - rva;
  if (at < 0 || at + leaf.size > b.length) return null;
  return b.subarray(at, at + leaf.size);
}

// ---------------------------------------------------------------------------
// Choosing which icon
// ---------------------------------------------------------------------------

/** Best member across all groups, lowest id first (matches Windows behaviour —
 * tree order differs because named entries sort before numbered). */
function bestFromGroups(
  b: Bytes,
  rva: number,
  groupsAt: number,
  members: Map<number, Leaf>,
  walk: Walk,
): { blob: Blob, ext: string } | null {
  const groups = (readDirectory(b, groupsAt, walk) || [])
    .filter(e => !e.named)
    .sort((x, y) => x.id - y.id)
    .slice(0, MAX_GROUPS);

  for (const group of groups) {
    const leaf = group.isDir ? firstLeaf(b, group.off, 1, walk) : leafAt(b, group.off);
    const dir = leaf && payload(b, rva, leaf);
    if (!dir) continue;
    const picked = pick(b, rva, readGroup(dir), members);
    if (picked) return picked;
  }
  return null;
}

/** Parse GRPICONDIR: 6-byte header + 14 per member. 0 in w/h means 256. */
function readGroup(dir: Bytes): Member[] {
  if (dir.length < 6) return [];
  const count = Math.min(le16(dir, 4), MAX_MEMBERS);
  const out: Member[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 14;
    if (at + 14 > dir.length) break;
    out.push({
      w: dir[at] || 256,
      h: dir[at + 1] || 256,
      planes: le16(dir, at + 4),
      bits: le16(dir, at + 6),
      id: le16(dir, at + 12),
    });
  }
  return out;
}

/** Pick the best member. PNG preferred (universal decode); DIB fallback
 * goes through wrapAsIco(). */
function pick(
  b: Bytes,
  rva: number,
  members: Member[],
  leaves: Map<number, Leaf>,
): { blob: Blob, ext: string } | null {
  const usable = members
    .filter(m => m.w >= MIN_EDGE && m.h >= MIN_EDGE && leaves.has(m.id))
    .sort((x, y) => y.w * y.h - x.w * x.h || y.bits - x.bits);

  let fallback: { m: Member, bytes: Bytes } | null = null;
  for (const m of usable) {
    const bytes = payload(b, rva, leaves.get(m.id)!);
    if (!bytes || !bytes.length) continue;
    if (isPng(bytes)) {
      // CgBI impossible here, but isDrawablePng is the standard PNG gate.
      if (m.w >= PNG_ENOUGH && isDrawablePng(bytes)) {
        return { blob: new Blob([bytes], { type: 'image/png' }), ext: 'png' };
      }
      continue;
    }
    fallback ||= { m, bytes };
  }

  if (!fallback) return null;
  const ico = wrapAsIco(fallback.bytes, fallback.m.w, fallback.m.h, fallback.m.planes, fallback.m.bits);
  return ico ? { blob: new Blob([ico], { type: 'image/x-icon' }), ext: 'ico' } : null;
}

/** Biggest RT_ICON with no group. PNG only — bare DIB members lack true
 * dimensions (BITMAPINFOHEADER height is doubled for the AND mask). */
function bestLoose(
  b: Bytes,
  rva: number,
  leaves: Map<number, Leaf>,
): { blob: Blob, ext: string } | null {
  let best: Bytes | null = null;
  for (const leaf of leaves.values()) {
    const bytes = payload(b, rva, leaf);
    if (!bytes || !isDrawablePng(bytes)) continue;
    if (!best || bytes.length > best.length) best = bytes;
  }
  return best ? { blob: new Blob([best], { type: 'image/png' }), ext: 'png' } : null;
}
