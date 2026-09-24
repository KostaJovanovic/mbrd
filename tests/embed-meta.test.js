// The one network fetch that decorates a card: a player's title from its
// oembed. Two things it must not do - ask again on every mount after a
// failure, and store one page's title on a card that now points elsewhere.
// fetch is a stand-in; nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { byId } from '../web/assets/js/state.ts';
import { enrichEmbed } from '../web/assets/js/canvas/embed-meta.ts';
import { fresh } from './state-fixtures.js';

const A = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const B = 'https://www.youtube.com/watch?v=9bZkp7q19f0';
const C = 'https://www.youtube.com/watch?v=kJQP7kiw5Fk';

const link = (id, url) => ({ id, type: 'link', x: 0, y: 0, w: 320, h: 200, meta: { url } });

function stubFetch(t, answer) {
  const saved = globalThis.fetch;
  const asked = [];
  globalThis.fetch = (url) => { asked.push(url); return answer(url); };
  t.after(() => { globalThis.fetch = saved; });
  return asked;
}

test('a failed title is not asked for again on the next mount', async (t) => {
  fresh([link('l1', C)]);
  const asked = stubFetch(t, async () => ({ ok: false }));
  await enrichEmbed(byId('l1'));
  await enrichEmbed(byId('l1'));
  assert.equal(asked.length, 1);
  assert.equal(byId('l1').meta.title, undefined);
});

test('a title that arrives after the link changed is dropped', async (t) => {
  fresh([link('l2', A)]);
  let reply;
  stubFetch(t, () => new Promise(r => { reply = r; }));
  const job = enrichEmbed(byId('l2'));
  const it = byId('l2');
  it.meta = { ...it.meta, url: B };
  reply({ ok: true, json: async () => ({ title: 'Page A' }) });
  await job;
  assert.equal(byId('l2').meta.title, undefined, 'the title of A landed on B');
});

test('a title for the address still on the card is stored', async (t) => {
  fresh([link('l3', A)]);
  stubFetch(t, async () => ({ ok: true, json: async () => ({ title: 'Page A' }) }));
  await enrichEmbed(byId('l3'));
  assert.equal(byId('l3').meta.title, 'Page A');
});
