// The icon inside a Windows program.
//
// An .exe and a .dll carry their picture in a resource directory - the same one
// Explorer reads to draw the file in a folder - and it is reachable with
// arithmetic and no decoding at all. That makes it the same bargain every other
// reader in import/ strikes: a program on a board is a grey card saying "exe"
// today, and the thing that would make it recognisable is already inside it.
//
// ── The walk, and why it is two resources rather than one ──
//
// An icon in a PE file is stored split, which is the part that surprises people:
//
//   RT_GROUP_ICON (14)  A directory. One record per size the icon comes in -
//                       the pixel dimensions, the colour depth, and the *id* of
//                       the resource holding that member's bytes.
//   RT_ICON (3)         The members themselves, each a lone image with no
//                       directory in front of it, one per id.
//
// So picking an icon means reading the group to choose a member, then finding
// the RT_ICON whose id the group named, then putting a directory back in front
// of the bytes - which is import/winimage.ts's wrapAsIco(). Reading RT_ICON
// alone would find bytes but not their size, and a lone RT_ICON record is not a
// file of any type a browser knows.
//
// Getting there is four hops, each of which is a length or an offset written by
// a linker: MZ header -> e_lfanew -> PE signature -> optional header -> data
// directory entry 2 -> the section table, which is what turns the directory's
// *virtual* address into a file offset. The last one is the step that is easy to
// forget: every offset inside the resource tree is an RVA, an address the file
// would have once loaded into memory, and subtracting the section's own RVA is
// what maps it back to bytes on disk.
//
// ── Two departures from the obvious reading ──
//
// **A PNG member is preferred over a larger DIB.** Since Vista the 256-pixel
// member of an icon group is a PNG rather than a bitmap, and a PNG needs no
// wrapper and decodes in every engine, while an ICO wrapped around a DIB is a
// format some engines decode reluctantly. Ranking on pixels alone - which is the
// obvious rule, and what the sibling analyser does - hands the fussiest engines
// the fussiest bytes. So a PNG member at a usable size wins, and the DIB path is
// the fallback rather than the default.
//
// **The lowest-numbered group, not the first in the tree.** A program with
// several icons has several RT_GROUP_ICON resources, and Windows takes the one
// with the lowest id as the application's own. Tree order is not id order - the
// directory is sorted with named entries before numbered ones - so "the first
// one" is a different icon from "the program's icon" often enough to matter.
//
// ── What it does not do ──
//
// No RT_VERSION, no imports, no section characteristics: this reads a picture
// and nothing else. A .NET assembly with no unmanaged resource section, a packed
// binary whose resources are compressed, and a 16-bit NE executable all come back
// null and stay the grey card they were.

import { wrapAsIco, isPng, isDrawablePng } from './winimage.ts';
import { oversize, isOversize, mb } from '../consent.ts';

/** A view whose buffer is named, so a subarray of it stays a legal BlobPart. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The extensions worth looking inside. Every one of these is a PE container. */
const PE_EXTS = new Set(['exe', 'dll', 'scr', 'cpl', 'ocx', 'mun', 'ax', 'efi']);

/** Whether this file is one this module will open. */
export const isExecutable = (ext: string) => PE_EXTS.has(ext);

/**
 * How much of the file the headers are allowed to live in.
 *
 * Everything up to and including the section table sits within the first few
 * kilobytes of every real PE; 1 MB is far past that and bounds the one read that
 * happens before anything has been validated.
 */
const HEAD = 1024 * 1024;

/**
 * How large a resource section this will read.
 *
 * The whole `.rsrc` section is pulled in one slice, because the tree is a graph
 * of offsets into itself and walking it against a Blob would be a read per node.
 * Icons and version data put this in the low megabytes; a program that ships its
 * artwork as resources can be much larger, and past this the allocation is worth
 * asking about.
 *
 * Asked rather than refused, per the ceiling contract in consent.ts: this throws
 * an Oversize the caller can put to whoever dropped the file, and `lift` is that
 * answer coming back. An installer whose resources are a hundred megabytes may
 * well hold a perfectly good icon; what it will certainly do is spend that memory
 * to find out, and that is not this module's call to make.
 */
const MAX_RSRC = 24 * 1024 * 1024;

/** Caps on the tree itself. Each is "this file is lying", not a correctness bound. */
const MAX_ENTRIES = 4096;
const MAX_GROUPS = 64;
const MAX_MEMBERS = 64;

/** Resource type ids, from the format. */
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/** The smallest icon worth showing on a card. Below this a card is better off blank. */
const MIN_EDGE = 16;

/** A PNG member at least this wide is taken in preference to any bitmap. */
const PNG_ENOUGH = 48;

const le16 = (b: Bytes, i: number) => b[i] | (b[i + 1] << 8);
const le32 = (b: Bytes, i: number) =>
  ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000) >>> 0;

/** A leaf's bytes, as the resource tree addresses them. */
type Leaf = { rva: number, size: number };

/** One member of an icon group, as its 14-byte directory record states it. */
type Member = { w: number, h: number, planes: number, bits: number, id: number };

/**
 * The best icon inside `file`, as `{ blob, ext }`, or null.
 *
 * Shaped to be handed straight to a File the caller names, which is what
 * import/document.ts does with every other reader of this kind.
 */
export async function exeIcon(
  file: Blob,
  lift = false,
): Promise<{ blob: Blob, ext: string } | null> {
  try {
    const rsrc = await resourceSection(file, lift);
    if (!rsrc) return null;

    const { bytes, rva } = rsrc;
    const root = readDirectory(bytes, 0);
    if (!root) return null;

    const groupsAt = root.find(e => e.id === RT_GROUP_ICON && e.isDir)?.off;
    const iconsAt = root.find(e => e.id === RT_ICON && e.isDir)?.off;
    if (iconsAt === undefined) return null;

    // Every RT_ICON leaf by its id, which is the key the group records name.
    const members = new Map<number, Leaf>();
    for (const entry of readDirectory(bytes, iconsAt) || []) {
      if (!entry.isDir || members.size >= MAX_ENTRIES) continue;
      const leaf = firstLeaf(bytes, entry.off, 1);
      if (leaf) members.set(entry.id, leaf);
    }
    if (!members.size) return null;

    const picked = groupsAt === undefined
      // No group at all. Unusual, and the honest answer is still the biggest
      // lone member rather than nothing - a resource-only DLL of icons is a real
      // thing and its members are perfectly good pictures.
      ? bestLoose(bytes, rva, members)
      : bestFromGroups(bytes, rva, groupsAt, members);
    return picked;
  } catch (err) {
    // A ceiling goes past, for the caller to ask about. Same shape as slide.ts.
    if (isOversize(err)) throw err;
    // Every other reader of this kind says the same thing for the same reason:
    // the card is the grey one either way, and only the console can tell "this
    // program has no icon" from "the resource tree did not add up".
    console.warn('[mbrd] exe: no icon came out of the resource tree', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Getting to the resource section
// ---------------------------------------------------------------------------

/**
 * The `.rsrc` section's bytes and the virtual address they start at.
 *
 * The RVA is returned with them because every offset inside the tree is relative
 * to the *image*, not to the section, and subtracting this is the only way back
 * to a position in the buffer.
 */
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

  // PE32 puts the data directory at 96 bytes into the optional header; PE32+
  // widens five fields to 64 bits and puts it at 112. The magic is the only
  // thing that says which, and reading the wrong one lands in the middle of a
  // different field rather than failing.
  const magic = le16(head, optAt);
  const dirAt = magic === 0x20B ? optAt + 112 : magic === 0x10B ? optAt + 96 : -1;
  if (dirAt < 0) return null;
  // Index 2 is the resource directory. A file with fewer entries than that has
  // no resources at all, which is a fact rather than a fault.
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

  // The section table follows the optional header. Each entry is 40 bytes and
  // states both where the section lives in memory and where it lives on disk.
  const tableAt = optAt + optSize;
  for (let i = 0; i < sections; i++) {
    const at = tableAt + i * 40;
    if (at + 40 > head.length) return null;
    const va = le32(head, at + 12);
    const rawSize = le32(head, at + 16);
    const rawAt = le32(head, at + 20);
    if (wantRva < va || wantRva >= va + Math.max(rawSize, le32(head, at + 8))) continue;

    // A section is padded on disk to a file alignment, so its raw size can exceed
    // the virtual size it was given; the smaller of the two is what is really there.
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

/**
 * A directory's entries, at `at` bytes into the section.
 *
 * The header is 16 bytes and then two counts - names first, then ids. Both are
 * walked: a named type is not what an icon uses, but skipping the named block
 * would put every subsequent read 8 bytes out of step per entry.
 */
function readDirectory(b: Bytes, at: number): Entry[] | null {
  if (at < 0 || at + 16 > b.length) return null;
  const named = le16(b, at + 12);
  const ids = le16(b, at + 14);
  const total = named + ids;
  if (!total || total > MAX_ENTRIES) return null;
  if (at + 16 + total * 8 > b.length) return null;

  const out: Entry[] = [];
  for (let i = 0; i < total; i++) {
    const p = at + 16 + i * 8;
    const name = le32(b, p);
    const to = le32(b, p + 4);
    out.push({
      // The high bit of the first word marks a *name* rather than an id; the rest
      // of it is then an offset to a string nothing here needs.
      id: name & 0x80000000 ? -1 : name,
      named: !!(name & 0x80000000),
      // And the high bit of the second marks a subdirectory rather than a leaf.
      isDir: !!(to & 0x80000000),
      off: to & 0x7FFFFFFF,
    });
  }
  return out;
}

/**
 * The first leaf under `at`, descending at most `depth` more levels.
 *
 * The tree is type / name / language, and nothing here cares about the language -
 * a program with its icon in eleven locales has eleven identical pictures. So this
 * walks down the left edge until it finds data, which is the icon whatever locale
 * the linker happened to put first.
 */
function firstLeaf(b: Bytes, at: number, depth: number): Leaf | null {
  if (depth < 0) return null;
  const entries = readDirectory(b, at);
  if (!entries) {
    // Not a directory, so `at` is an IMAGE_RESOURCE_DATA_ENTRY: an RVA and a size.
    if (at + 8 > b.length) return null;
    const rva = le32(b, at);
    const size = le32(b, at + 4);
    return rva && size ? { rva, size } : null;
  }
  for (const entry of entries) {
    const found = entry.isDir
      ? firstLeaf(b, entry.off, depth - 1)
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

/**
 * The best member across every icon group, lowest group id first.
 *
 * Lowest rather than first, which is what Windows does: a program's own icon is
 * the lowest-numbered group, and tree order puts named entries ahead of numbered
 * ones, so the two orderings genuinely differ.
 */
function bestFromGroups(
  b: Bytes,
  rva: number,
  groupsAt: number,
  members: Map<number, Leaf>,
): { blob: Blob, ext: string } | null {
  const groups = (readDirectory(b, groupsAt) || [])
    .filter(e => !e.named)
    .sort((x, y) => x.id - y.id)
    .slice(0, MAX_GROUPS);

  for (const group of groups) {
    const leaf = group.isDir ? firstLeaf(b, group.off, 1) : leafAt(b, group.off);
    const dir = leaf && payload(b, rva, leaf);
    if (!dir) continue;
    const picked = pick(b, rva, readGroup(dir), members);
    if (picked) return picked;
  }
  return null;
}

/**
 * A GRPICONDIR's member records.
 *
 * Six bytes of header - reserved, type, count - then 14 per member. The two edge
 * fields are single bytes and 0 means 256, which is the format's way of fitting
 * the largest legal size into a byte.
 */
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

/**
 * The member worth drawing, and the bytes to draw it from.
 *
 * PNG first, for the reason in this file's header: a PNG member is already a file
 * every engine decodes, while an ICO around a bitmap is a format some decode
 * grudgingly. Only once no usable PNG is on offer does size alone decide, and
 * then the winner goes through wrapAsIco() to become something drawable.
 */
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
      // A CgBI PNG cannot appear in a PE file, but isDrawablePng is the one
      // question worth asking of anything claiming to be a PNG in this codebase.
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

/**
 * The biggest RT_ICON when there is no group to describe them.
 *
 * Only a PNG member can be used here and that is not a shortcut: a bare bitmap
 * member carries its size only in its own BITMAPINFOHEADER, where the height is
 * doubled to cover the AND mask, and a wrapper built from that number produces an
 * icon stretched to twice its height. The group record is what states the true
 * size, so without one the DIB members are honestly unreadable.
 */
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
