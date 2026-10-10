// Write what index.html decides into the two files that repeat it:
// web/404.html, a byte copy of the page, and the stylesheet block of SHELL in
// web/sw.js, every sheet index.html links in its order. save.bat runs this on
// every save; tests/css-order.test.js and tests/notfound.test.js fail when a
// commit went round it. Pure Node, no dependencies.
//
//   node tools/gen-shell.mjs

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const BEGIN = '// Stylesheets: begin. Written by tools/gen-shell.mjs from the links in';
const END = '// Stylesheets: end.';

/** Every stylesheet the page links, in document order, comments dropped. */
export const linkedSheets = (html) => [...html
  .replace(/<!--[\s\S]*?-->/g, '')
  .matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
  .map(([tag]) => (/\bhref="assets\/css\/([^"]+\.css)"/.exec(tag) ?? [])[1])
  .filter(Boolean);

/** sw.js with the lines between the two markers replaced by `sheets`. */
export function shellWithSheets(sw, sheets) {
  const eol = sw.includes('\r\n') ? '\r\n' : '\n';
  const start = sw.indexOf(BEGIN);
  const stop = sw.indexOf(END, start);
  if (start < 0 || stop < 0) throw new Error('sw.js has lost the stylesheet markers in SHELL');
  const indent = sw.slice(sw.lastIndexOf('\n', start) + 1, start);
  const lines = [
    `${BEGIN}${eol}${indent}// index.html, in cascade order, so edit those and not these.`,
    ...sheets.map(name => `${indent}'./assets/css/${name}',`),
    `${indent}`,
  ];
  return sw.slice(0, start) + lines.join(eol) + sw.slice(stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = join(WEB, 'index.html');
  // Bytes, not text: tests/notfound.test.js fails on one differing byte.
  copyFileSync(index, join(WEB, '404.html'));
  const swPath = join(WEB, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  const next = shellWithSheets(sw, linkedSheets(readFileSync(index, 'utf8')));
  if (next !== sw) writeFileSync(swPath, next);
}
