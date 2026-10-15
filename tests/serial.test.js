// serial() (util.ts): the one-at-a-time queue the file writes, the cloud
// pushes, the shelf index, the RAW developer, the CAD kernel, the matte and the
// display copies all run through. Order kept, outcome handed back, and a
// rejection never wedges what is queued behind it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serial } from '../web/assets/js/util.ts';

const tick = () => new Promise(r => setTimeout(r, 1));

test('work runs one piece at a time, in the order handed in', async () => {
  const inTurn = serial();
  const log = [];
  const job = (name) => async () => { log.push(`${name} in`); await tick(); log.push(`${name} out`); return name; };
  const got = await Promise.all([inTurn(job('a')), inTurn(job('b')), inTurn(job('c'))]);
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.deepEqual(log, ['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);
});

test('a rejection reaches its caller and not the work after it', async () => {
  const inTurn = serial();
  const failed = inTurn(async () => { throw new Error('nope'); });
  const after = inTurn(() => 'still runs');
  await assert.rejects(failed, /nope/);
  assert.equal(await after, 'still runs');
});
