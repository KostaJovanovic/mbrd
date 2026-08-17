// The ceilings, and who decides them.
//
// consent.ts holds no numbers and parses nothing, so what there is to test here
// is the shape of a decision: how many times somebody is asked, what an answer
// covers, and what happens when there is nobody to ask. All three are things
// that go wrong invisibly - an app that asks twice about one file is merely
// irritating, and an app that asks once and then quietly does the opposite is
// worse than the refusal it replaced.
//
// No DOM anywhere, which is the point of the module being at the base of the
// graph: the prompt is injected, so a test is the same shape as main.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allow, lift, isAllowed, fileKey, explain, oversize, isOversize,
  setRiskPrompt, resetConsent, askingStopped, mb,
} from '../web/assets/js/consent.ts';

/** A prompt that answers the same way every time and counts how often it was asked. */
function stub(answer) {
  const asked = [];
  setRiskPrompt(async opts => { asked.push(opts); return answer; });
  return asked;
}

function fresh() {
  resetConsent();
  setRiskPrompt(null);
}

const REASON = { ceiling: 'file-bytes', what: 'This file is 700 MB.' };

// ---------------------------------------------------------------------------
// Unwired
// ---------------------------------------------------------------------------

test('unwired, everything is allowed', async () => {
  // The one default that had to be argued rather than picked, and the whole
  // premise of the change: a module with no interface attached to it must not
  // refuse anything on somebody's behalf. It is also what keeps import/, storage/
  // and mesh.ts loadable in a test with no browser, which their headers promise.
  fresh();
  assert.equal(await allow('k', 'f', [REASON]), true);
});

test('unwired, a ceiling is still lifted rather than swallowed', async () => {
  fresh();
  assert.equal(await lift(oversize('entry-bytes', 'big'), 'k', 'f'), true);
});

test('nothing to ask about is allowed without a prompt being reached', async () => {
  // An empty reason list is not "ask about nothing", it is "there is nothing
  // here" - and a caller that measures first and asks second will pass one
  // routinely. Asked, it would be a dialog with an empty body.
  fresh();
  const asked = stub('no');
  assert.equal(await allow('k', 'f', []), true);
  assert.equal(asked.length, 0);
});

// ---------------------------------------------------------------------------
// One warning per file
// ---------------------------------------------------------------------------

test('one file is asked about once, however many ceilings it crosses', async () => {
  // The rule the whole module exists to keep. A 700 MB PSD that then inflates to
  // 900 MB and declares eighty megapixels is one decision somebody has already
  // made, and asking three times is not three warnings - it is a queue with the
  // same answer at the end of it.
  fresh();
  const asked = stub('go');
  const key = fileKey({ name: 'scan.psd', size: 700e6 });

  assert.equal(await allow(key, 'scan.psd', [REASON]), true);
  assert.equal(await lift(oversize('inflated-bytes', 'unpacks to 900 MB'), key, 'scan.psd'), true);
  assert.equal(await lift(oversize('pixels', '80 megapixels'), key, 'scan.psd'), true);
  assert.equal(asked.length, 1);
});

test('every ceiling crossed at once goes into the one dialog', async () => {
  // The other half of asking once: the reasons known at the time all have to be
  // in the question. Two of three in the body and the third discovered after the
  // yes would be a decision made on a partial account of what it costs.
  fresh();
  const asked = stub('go');
  await allow('k', 'huge.psd', [
    REASON,
    { ceiling: 'pixels', what: 'This image declares 30000x30000.' },
  ]);
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /huge\.psd/);
  assert.match(asked[0].body, /700 MB/);
  assert.match(asked[0].body, /30000x30000/);
  // And the reasoning with each of them, which is the difference between a
  // warning and a refusal wearing a button.
  assert.match(asked[0].body, /run out of memory/);
  assert.match(asked[0].body, /four bytes a pixel/);
});

test('a no is not remembered as an answer', async () => {
  // Declining one file must not mark it decided: the same file dropped again is
  // the same question, and somebody who said no by accident has to be able to say
  // yes. Only a yes is remembered.
  fresh();
  const asked = stub('no');
  assert.equal(await allow('k', 'f', [REASON]), false);
  assert.equal(isAllowed('k'), false);
  assert.equal(await allow('k', 'f', [REASON]), false);
  assert.equal(asked.length, 2);
});

test('two different files are two questions', async () => {
  fresh();
  const asked = stub('go');
  await allow(fileKey({ name: 'a.mov', size: 700e6 }), 'a.mov', [REASON]);
  await allow(fileKey({ name: 'b.mov', size: 700e6 }), 'b.mov', [REASON]);
  assert.equal(asked.length, 2);
});

test('a file is the name and the size together', async () => {
  // Neither alone. Two files of the same size are not one file, and the same name
  // at a different size is a different file - which is what somebody re-exporting
  // and dropping again has.
  assert.notEqual(fileKey({ name: 'a', size: 1 }), fileKey({ name: 'b', size: 1 }));
  assert.notEqual(fileKey({ name: 'a', size: 1 }), fileKey({ name: 'a', size: 2 }));
  assert.equal(fileKey({ name: 'a', size: 1 }), fileKey({ name: 'a', size: 1 }));
});

// ---------------------------------------------------------------------------
// Allow everything
// ---------------------------------------------------------------------------

test('allowing everything stops the asking for the session', async () => {
  // The third answer, and the reason the dialog has room for one. On a folder of
  // forty large files the useful answer is not forty answers.
  fresh();
  const asked = stub('all');
  assert.equal(await allow('one', 'a', [REASON]), true);
  assert.equal(askingStopped(), true);
  assert.equal(await allow('two', 'b', [REASON]), true);
  assert.equal(await allow('three', 'c', [REASON]), true);
  assert.equal(asked.length, 1);
  // And it covers files nobody has seen yet, which is what "everything" means.
  assert.equal(isAllowed('never-asked-about'), true);
});

test('resetting forgets both kinds of answer', async () => {
  fresh();
  stub('all');
  await allow('k', 'f', [REASON]);
  resetConsent();
  assert.equal(askingStopped(), false);
  assert.equal(isAllowed('k'), false);
});

// ---------------------------------------------------------------------------
// The thrown form
// ---------------------------------------------------------------------------

test('a ceiling is told apart from a broken file by its class', async () => {
  // What every call site in the app branches on. The readers throw both kinds and
  // a message is not a contract - somebody rewording a sentence must not turn a
  // corruption check into a question.
  assert.equal(isOversize(oversize('entry-ratio', 'expands 4000 times over')), true);
  assert.equal(isOversize(new Error('Corrupt archive')), false);
  assert.equal(isOversize(null), false);
  assert.equal(isOversize('Oversize'), false);
});

test('lift refuses to ask about something that is not a ceiling', async () => {
  // A corrupt archive reaching lift() must come back false so the caller rethrows
  // it. Answering true would turn "this file is damaged" into a retry that fails
  // the same way, and the dialog would be asking somebody to consent to a bug.
  fresh();
  const asked = stub('go');
  assert.equal(await lift(new Error('Corrupt archive'), 'k', 'f'), false);
  assert.equal(asked.length, 0);
});

test('a thrown ceiling carries the numbers, not just a name', async () => {
  const e = oversize('mesh-triangles', 'This model has 6,000,000 triangles.');
  assert.equal(e.ceiling, 'mesh-triangles');
  assert.match(e.what, /6,000,000/);
  assert.match(e.message, /6,000,000/);   // readable if it ever reaches a console
});

// ---------------------------------------------------------------------------
// The prose
// ---------------------------------------------------------------------------

test('every ceiling has a risk sentence behind it', async () => {
  // The registry is a Record over the id union, so a missing entry is a type
  // error rather than a test failure - but an id reaching explain() from a
  // reader's string literal would produce "undefined" on screen, in a dialog
  // whose whole purpose is to say what the risk is.
  const ids = [
    'file-bytes', 'batch-bytes', 'pixels', 'file-count', 'archive-bytes',
    'archive-entries', 'entry-bytes', 'inflated-bytes', 'entry-ratio',
    'container-bytes', 'embedded-jpeg', 'cover-art', 'mesh-triangles',
    'mesh-buffer', 'font-bytes',
  ];
  for (const ceiling of ids) {
    const text = explain({ ceiling, what: 'measured.' });
    assert.ok(text.startsWith('measured.\n'), `${ceiling}: measurement first`);
    assert.ok(text.length > 60, `${ceiling}: has a risk sentence`);
    assert.ok(!/undefined/.test(text), `${ceiling}: no gap in the table`);
  }
});

test('the bomb warning says it is not about a large file', async () => {
  // The one entry in the table that is not like the others. Every other ceiling
  // is a file being honestly big; this one is a file lying about what it holds,
  // and somebody weighing it needs to know which of the two they are looking at.
  const text = explain({ ceiling: 'entry-ratio', what: 'It expands 4000 times over.' });
  assert.match(text, /not about a file being large/);
});

test('megabytes are whole', async () => {
  assert.equal(mb(0), '0 MB');
  assert.equal(mb(1024 ** 2), '1 MB');
  assert.equal(mb(512 * 1024 ** 2), '512 MB');
});
