// The credits sheet, and the one way it goes quietly wrong.
//
// There are two lists of what this app is standing on. THIRD-PARTY.md is for a
// licence audit: it says which files each notice covers and where the notice
// lives. The fold inside #credits is for a person: it says what was borrowed
// and why, in a sentence each.
//
// Two lists of the same thing drift, and this one drifts in a particular
// direction. Vendoring something new means touching the audit file - the
// licence test in tests/stickers-license.test.js sees to that - and it does not
// mean touching index.html, so the sheet a person reads is the copy that falls
// behind. Nothing else would notice: the panel keeps opening, the two names
// keep showing, and the new thing is simply absent from the screen that exists
// to say what is there.
//
// So: every source THIRD-PARTY.md names has to be reachable from the sheet. Not
// the other way round - the fold is allowed to mention things that carry no
// third-party notice at all, and does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { WEB, ROOT, read } from './helpers.js';

const html = read(join(WEB, 'index.html'));
const manifest = read(join(ROOT, 'THIRD-PARTY.md'));

/** The fold, and nothing else on the page. */
const fold = html.match(/<details class="credits-more">([\s\S]*?)<\/details>/)?.[1] ?? '';

test('the credits sheet has a fold that lists what ships', () => {
  // Guards the guard: a renamed class would make every assertion below vacuous.
  assert.ok(fold, 'no <details class="credits-more"> in index.html');
  assert.match(fold, /<summary>/, 'the fold has no summary to open it by');
  assert.match(fold, /class="credits-deps"/, 'the fold lists nothing');
});

test('every source THIRD-PARTY.md names is linked from the sheet', () => {
  // Whole URLs out of the manifest's tables, deduped. Trailing punctuation is
  // trimmed because these sit in prose as well as in table cells.
  const sources = [...new Set(
    [...manifest.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)].map(m => m[0]),
  )];
  assert.ok(sources.length >= 4, `only ${sources.length} sources found - has the table moved?`);

  const missing = sources.filter(url => !fold.includes(url));
  assert.deepEqual(missing, [], `named in THIRD-PARTY.md but not in the credits sheet:\n  ${missing.join('\n  ')}`);
});

test('every link in the fold opens safely', () => {
  // Same rule the two credit links above it follow. A target="_blank" without
  // rel="noopener" hands the opened page a handle on this one.
  const links = [...fold.matchAll(/<a\s[^>]*>/g)].map(m => m[0]);
  assert.ok(links.length >= 4, `only ${links.length} links in the fold`);
  for (const tag of links) {
    assert.match(tag, /href="https:\/\//, `not an absolute https link: ${tag}`);
    assert.match(tag, /target="_blank"/, `no target: ${tag}`);
    assert.match(tag, /rel="noopener noreferrer"/, `no rel=noopener: ${tag}`);
  }
});

test('the fold does not claim a licence the manifest disagrees with', () => {
  // The chip beside each name is a two-word fact and the manifest is where the
  // long version lives, so the words have to be the manifest's. "borrowed data"
  // is the one that is deliberately not a licence - see file-analyser, which
  // carries no third-party notice because it is not third-party.
  const chips = [...fold.matchAll(/class="credits-lic">([^<]+)</g)].map(m => m[1].trim());
  assert.ok(chips.length >= 3, `only ${chips.length} licence chips`);
  for (const chip of chips) {
    if (chip === 'borrowed data') continue;
    assert.ok(
      manifest.includes(chip) || manifest.includes(chip.replace('OFL 1.1', 'Open Font License 1.1')),
      `the sheet says "${chip}" and THIRD-PARTY.md never does`,
    );
  }
});
