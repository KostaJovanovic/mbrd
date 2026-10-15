// Every meta key itemHashes() reads as a content id must also be one that
// makeItem() drops when it holds no hash. The packer trusts itemHashes() and
// throws on a malformed id before allowMissing is asked, so a key the reader
// misses turned a crafted .mbrd or share link into a board that no Open, New,
// Switch or Export could leave.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemHashes, heldHashes, META_HASH_KEYS, ORIGINAL_HASH_KEYS } from '../web/assets/js/util.ts';
import { makeItem } from '../web/assets/js/board-model.ts';
import { packBoard } from '../web/assets/js/storage/mbrd.ts';

/** The meta keys itemHashes() reads, found by watching it read them. */
function keysRead() {
  const seen = new Set();
  const meta = new Proxy({}, { get(_, key) { if (typeof key === 'string') seen.add(key); return undefined; } });
  itemHashes({ asset: null, meta });
  // A folder's list, whose entries makeItem() filters on its own.
  seen.delete('files');
  return [...seen];
}

test('the walk reads the keys it is known to read', () => {
  const keys = keysRead();
  for (const key of ['cover', 'preview', 'art', 'display', 'source']) {
    assert.ok(keys.includes(key), `itemHashes() no longer reads meta.${key}`);
  }
});

test('the walk reads META_HASH_KEYS and nothing else', () => {
  assert.deepEqual(keysRead().sort(), [...META_HASH_KEYS].sort());
});

test('heldHashes() adds the optimiser originals and itemHashes() does not', () => {
  const h = (c) => c.repeat(64);
  const meta = Object.fromEntries(ORIGINAL_HASH_KEYS.map((k, i) => [k, h(String(i))]));
  const item = { asset: { hash: h('a') }, meta };
  assert.deepEqual(itemHashes(item), [h('a')]);
  assert.deepEqual(heldHashes(item), [h('a'), ...Object.values(meta)]);
});

for (const key of keysRead()) {
  test(`a malformed meta.${key} does not survive makeItem()`, () => {
    const it = makeItem({ type: 'image', meta: { [key]: '../not-a-hash' } });
    assert.deepEqual(itemHashes(it), [], `meta.${key} reached the packer`);
  });
}

test('a board with a malformed meta.art still packs', async () => {
  const it = makeItem({ type: 'link', meta: { url: 'https://example.com', art: 'nope' } });
  await packBoard({ title: 't', items: [it], trash: [], settings: {} }, { allowMissing: true });
});
