// Vomit Mode's lock, as rules over the document rather than over keys: a
// boundary that only moves forward, and nothing before it may change however
// the change arrived - a key, a paste, a phone keyboard's own replacement.
// DOM-free, so node --test reaches it; view.ts asks these and enforces the answers.

import { cmpPos, isText, sliceRuns, sameMarks, blockLen, blockText } from './model.ts';
import type { Block, Doc, Pos, Run } from './model.ts';

/** How long Super waits after a word's last keystroke before locking it, mid-word or not. */
export const SUPER_MS = 10_000;
/** The durations the bar offers, in minutes. */
export const VOMIT_MINUTES = [5, 10, 15, 25, 60] as const;

/** Where the lock sits when a session starts: the end, everything before it locked, the typewriter way. */
export function lockAtEnd(doc: Doc): Pos {
  const b = doc.blocks.length - 1;
  return { b, o: blockLen(doc.blocks[b]) };
}

/** A position moved up to the lock if it was behind it. */
export const clampToLock = (lock: Pos, p: Pos): Pos => (cmpPos(p, lock) < 0 ? lock : p);

const sameRuns = (x: Run[], y: Run[]) =>
  x.length === y.length && x.every((r, n) => r.text === y[n].text && !!r.raw === !!y[n].raw && sameMarks(r, y[n]));

/** The same kind of block with the same settings, its words aside. The blank lines above it are spacing, not text. */
function sameShape(a: Block, z: Block): boolean {
  if (a.kind !== z.kind) return false;
  if (a.kind === 'h' && z.kind === 'h') return a.level === z.level;
  if (a.kind === 'li' && z.kind === 'li') return a.list === z.list && a.depth === z.depth && a.checked === z.checked;
  if (a.kind === 'code' && z.kind === 'code') return a.lang === z.lang;
  return true;
}

function sameBlock(a: Block | undefined, z: Block | undefined): boolean {
  if (a === z) return true;
  if (!a || !z || !sameShape(a, z)) return false;
  if (isText(a) && isText(z)) return sameRuns(a.runs, z.runs);
  return blockText(a) === blockText(z) && (a.kind !== 'raw' || z.kind !== 'raw' || a.text === z.text);
}

/**
 * Does `next` keep everything before `lock` in `prev` as it was - every block
 * above the lock's, and the lock's own block up to the lock, words and looks?
 * Asked of every change, however it was made, which is what makes the rule
 * hold for a paste or an autocorrection as well as for a key.
 */
export function keepsLocked(prev: Doc, next: Doc, lock: Pos): boolean {
  if (prev === next) return true;
  if (next.blocks.length <= lock.b) return false;
  for (let n = 0; n < lock.b; n++) if (!sameBlock(prev.blocks[n], next.blocks[n])) return false;
  // At a block's start nothing of it is locked: a heading typed as `# ` after Enter may change its kind.
  if (lock.o === 0) return true;
  const a = prev.blocks[lock.b], z = next.blocks[lock.b];
  if (a === z) return true;
  if (!sameShape(a, z)) return false;
  if (isText(a) && isText(z)) return sameRuns(sliceRuns(a.runs, 0, lock.o), sliceRuns(z.runs, 0, lock.o));
  return blockText(a).slice(0, lock.o) === blockText(z).slice(0, lock.o);
}

/**
 * The lock after a change: moved up to the caret once the caret has finished a
 * word - just after a space or a line break, or at the start of a block, which
 * only Enter reaches. Never backwards. A phone keyboard's correction arrives
 * with its space, so it is behind the caret before the lock moves, and commits.
 */
export function advance(doc: Doc, lock: Pos, caret: Pos): Pos {
  if (cmpPos(caret, lock) <= 0) return lock;
  const block = doc.blocks[caret.b];
  if (!block) return lock;
  const before = caret.o === 0 ? '\n' : blockText(block)[caret.o - 1];
  return before !== undefined && /\s/.test(before) ? caret : lock;
}

/** Super: the lock moved up to the caret after a pause, mid-word or not. */
export const superLock = (lock: Pos, caret: Pos): Pos => (cmpPos(caret, lock) > 0 ? caret : lock);

/** Minutes and seconds left, as the bar shows them. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
