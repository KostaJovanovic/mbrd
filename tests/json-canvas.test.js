// JSON Canvas to and from a board (storage/json-canvas.ts): the two coordinate
// spaces, every node and edge kind, and what a broken or hostile file gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardToCanvas, canvasToBoard, MAX_NODES } from '../web/assets/js/storage/json-canvas.ts';
import { NOTE_MAX } from '../web/assets/js/board-model.ts';
import { item } from './helpers.js';

const none = { file: async () => null, text: async () => null };

test('a board becomes a canvas placed by top-left corner with y running down', () => {
  const note = item({ id: 'n', type: 'note', x: 100, y: 50, w: 200, h: 100, meta: { text: '# Hello' } });
  const pic = item({ id: 'p', type: 'image', x: 0, y: -300, w: 400, h: 300, name: 'cat.png', asset: { hash: 'h'.repeat(64) } });
  const fence = item({ id: 'f', type: 'fence', x: 0, y: 0, w: 1000, h: 1000, name: 'Refs', z: 9 });
  const link = item({ id: 'l', type: 'link', x: 0, y: 0, w: 200, h: 80, meta: { url: 'https://example.com/' } });
  const title = item({ id: 't', type: 'title', x: 0, y: 0, w: 200, h: 80 });
  const canvas = boardToCanvas([note, pic, fence, link, title], [['n', 'p', { dir: 'fwd', label: 'see' }]],
    it => (it.id === 'p' ? 'files/cat.png' : null));
  assert.equal(canvas.nodes[0].type, 'group', 'a group comes first, so it is drawn under what it holds');
  const n = canvas.nodes.find(x => x.id === 'n');
  assert.deepEqual(n, { id: 'n', type: 'text', text: '# Hello', x: 0, y: -100, width: 200, height: 100 });
  assert.equal(canvas.nodes.find(x => x.id === 'p').file, 'files/cat.png');
  assert.equal(canvas.nodes.find(x => x.id === 'f').label, 'Refs');
  assert.equal(canvas.nodes.find(x => x.id === 'l').url, 'https://example.com/');
  assert.ok(!canvas.nodes.some(x => x.id === 't'), 'the title card has no node');
  assert.deepEqual(canvas.edges, [{ id: 'edge-0', fromNode: 'n', toNode: 'p', fromEnd: 'none', toEnd: 'arrow', label: 'see' }]);
});

test('a canvas comes back as the board it was, centre by centre', async () => {
  const note = item({ id: 'n', type: 'note', x: 100, y: 50, w: 200, h: 100, meta: { text: 'hi' } });
  const back = await canvasToBoard(boardToCanvas([note], [], () => null), none);
  assert.deepEqual(
    { x: back.items[0].x, y: back.items[0].y, w: back.items[0].w, h: back.items[0].h },
    { x: 100, y: 50, w: 200, h: 100 });
  assert.equal(back.items[0].meta.text, 'hi');
});

test('every node kind lands as its card, and an edge keeps its arrows', async () => {
  const raw = {
    nodes: [
      { id: 'a', type: 'text', text: 'note', x: 0, y: 0, width: 100, height: 60 },
      { id: 'b', type: 'file', file: 'Art/cat.png', x: 200, y: 0, width: 100, height: 60 },
      { id: 'c', type: 'link', url: 'https://example.com', x: 400, y: 0, width: 100, height: 60 },
      { id: 'g', type: 'group', label: 'Box', x: -50, y: -50, width: 600, height: 200 },
      { id: 'd', type: 'file', file: 'missing.pdf', x: 0, y: 200, width: 100, height: 60 },
    ],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'c', fromEnd: 'arrow', toEnd: 'none', color: '1' },
      { id: 'e3', fromNode: 'a', toNode: 'c', toEnd: 'none' },
      { id: 'e4', fromNode: 'a', toNode: 'nowhere' },
    ],
  };
  const { items, connections } = await canvasToBoard(raw, {
    file: async path => (path === 'Art/cat.png' ? { hash: 'h'.repeat(64), type: 'image', name: 'cat.png' } : null),
    text: async () => null,
  });
  assert.equal(items[0].type, 'fence', 'the group first, under the rest');
  const by = Object.fromEntries(items.map(i => [i.id, i]));
  assert.equal(by.a.type, 'note');
  assert.equal(by.b.type, 'image');
  assert.equal(by.b.asset.hash, 'h'.repeat(64));
  assert.equal(by.c.meta.url, 'https://example.com');
  assert.equal(by.g.name, 'Box');
  assert.equal(by.d.type, 'note', 'a file it could not find says what it was');
  assert.equal(by.d.meta.text, 'missing.pdf');
  assert.deepEqual(connections, [
    ['a', 'b', { dir: 'fwd' }],
    ['b', 'c', { dir: 'back', color: 'danger' }],
    ['a', 'c'],
  ]);
});

test('a text node longer than a note holds is stored as a document', async () => {
  const long = 'x'.repeat(NOTE_MAX + 1);
  const { items } = await canvasToBoard({ nodes: [{ id: 'a', type: 'text', text: long, x: 0, y: 0, width: 10, height: 10 }] }, {
    file: async () => null,
    text: async (body, name) => ({ hash: 'd'.repeat(64), type: 'text', name }),
  });
  assert.equal(items[0].type, 'text');
  assert.equal(items[0].name, 'a.md');
});

test('a broken or hostile canvas is refused or skipped, never half-trusted', async () => {
  await assert.rejects(canvasToBoard(null, none), /not a JSON Canvas/);
  await assert.rejects(canvasToBoard({ nodes: 'x' }, none), /not a JSON Canvas/);
  await assert.rejects(canvasToBoard({ nodes: new Array(MAX_NODES + 1).fill({}) }, none), /more than/);
  const { items, connections } = await canvasToBoard({
    nodes: [
      { id: 'a', type: 'text', text: 'ok', x: 0, y: 0, width: 10, height: 10 },
      { id: 'a', type: 'text', text: 'twin', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', type: 'text', text: 'no size', x: 0, y: 0 },
      { id: 'c', type: 'text', text: 'nan', x: NaN, y: 0, width: 10, height: 10 },
      { id: 'd', type: 'text', text: 'flat', x: 0, y: 0, width: 0, height: 10 },
      { id: 'e', type: 'script', x: 0, y: 0, width: 10, height: 10 },
      'not a node',
    ],
    edges: [{ fromNode: 'a', toNode: 'a' }, null],
  }, none);
  assert.deepEqual(items.map(i => i.meta?.text), ['ok'], 'one node for one id, and none without a real box');
  assert.deepEqual(connections, [], 'a line from a card to itself is not a connection');
});
