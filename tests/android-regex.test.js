// Regex syntax Android's engine refuses, in the phone's Java. Android runs
// java.util.regex on ICU, which throws on a few things the desktop JVM
// accepts, so the JVM unit tests under mobile/android pass and the phone
// fails. The (?U) flag in MbrdNames.plainName() stopped every board write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT, read } from './helpers.js';

const JAVA = join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'java');
const skip = !existsSync(JAVA) && 'mobile/ is absent from this checkout';

/** As it is written in Java source, with each backslash doubled. */
const REFUSED = [
  [/\(\?[a-zA-Z]*U/, 'the (?U) flag'],
  [/UNICODE_CHARACTER_CLASS/, 'Pattern.UNICODE_CHARACTER_CLASS'],
];

function javaFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? javaFiles(join(dir, e.name)) : e.name.endsWith('.java') ? [join(dir, e.name)] : []);
}

test('the phone\'s Java uses no regex syntax Android refuses', { skip }, () => {
  const found = [];
  for (const file of javaFiles(JAVA)) {
    read(file).split(/\r?\n/).forEach((line, i) => {
      for (const [re, what] of REFUSED) {
        if (re.test(line)) found.push(`${relative(ROOT, file)}:${i + 1} ${what}`);
      }
    });
  }
  assert.deepEqual(found, []);
});
