/**
 * Generate web/assets/stickers.svg from the Phosphor icon set.
 *
 *   node tools/gen-stickers.mjs [path-to-phosphor-core]
 *
 * Fetches from a pinned revision (or reads a local checkout). Output is committed.
 *
 * Weights:
 *   duotone — body + outline (shapes with a body)
 *   bold    — chunky line only (cross, plus, arrows — duotone gives them a plate)
 *   fill    — solid silhouette (two shapes where bold reads as hollow)
 *
 * Paint convention (<use> shadow tree, so CSS cannot reach paths):
 *   no fill attr         -> inherits sticker-body token (paper)
 *   fill="currentColor"  -> inherits sticker-tint token (ink)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'web', 'assets', 'stickers.svg');

/**
 * The revision fetched when no local checkout is given.
 *
 * Pinned rather than `main`, so re-running this on a Tuesday cannot quietly
 * redraw a board somebody made on the Monday. Moving it is a deliberate edit
 * with a diff to read.
 */
const REV = '2b75f3ad12b420c9504ef05df8d2564a28f8500e';
const RAW = `https://raw.githubusercontent.com/phosphor-icons/core/${REV}/assets`;

/**
 * The catalogue, and the source of truth for it.
 *
 * `id` is mbrd's own, not Phosphor's, and that is deliberate: it is written
 * into a .mbrd as meta.shape (see docs/mbrd-format.md), so it is part of the
 * file format and may not move because an upstream icon was renamed. `from` is
 * the Phosphor name and `w` the weight, per the rule in the header.
 *
 * Keep this in the same order as STICKERS in web/assets/js/stickers/catalogue.ts.
 * Nothing enforces the order - tests/stickers.test.js enforces that the two
 * lists hold the same ids, which is the half that matters.
 */
const SHAPES = [
  // ---- marks ----
  { id: 's-star', from: 'star', w: 'duotone' },
  { id: 's-star-four', from: 'star-four', w: 'duotone' },
  { id: 's-sparkle', from: 'sparkle', w: 'duotone' },
  { id: 's-heart', from: 'heart', w: 'duotone' },
  { id: 's-heart-break', from: 'heart-break', w: 'duotone' },
  { id: 's-check', from: 'check-fat', w: 'duotone' },
  { id: 's-cross', from: 'x', w: 'bold' },
  { id: 's-plus', from: 'plus', w: 'bold' },
  { id: 's-asterisk', from: 'asterisk', w: 'bold' },
  // A dot is solid by definition; the bold weight of a circle is a ring, which
  // is a different mark and not one worth having twice.
  { id: 's-dot', from: 'circle', w: 'fill' },
  { id: 's-eye', from: 'eye', w: 'duotone' },

  // ---- punctuation ----
  { id: 's-exclamation', from: 'exclamation-mark', w: 'bold' },
  { id: 's-warning', from: 'warning', w: 'duotone' },
  { id: 's-question', from: 'question-mark', w: 'bold' },
  { id: 's-question-circle', from: 'question', w: 'duotone' },
  { id: 's-ellipsis', from: 'dots-three', w: 'bold' },

  // ---- arrows ----
  { id: 's-arrow', from: 'arrow-right', w: 'bold' },
  { id: 's-arrow-curved', from: 'arrow-bend-up-right', w: 'bold' },
  { id: 's-arrow-corner', from: 'arrow-elbow-right', w: 'bold' },
  { id: 's-arrow-double', from: 'arrows-left-right', w: 'bold' },
  { id: 's-arrow-circular', from: 'arrow-clockwise', w: 'bold' },

  // ---- flags and pins ----
  { id: 's-pin', from: 'map-pin', w: 'duotone' },
  { id: 's-pushpin', from: 'push-pin', w: 'duotone' },
  { id: 's-flag', from: 'flag', w: 'duotone' },
  { id: 's-ribbon', from: 'medal', w: 'duotone' },
  { id: 's-bookmark', from: 'bookmark-simple', w: 'duotone' },
  { id: 's-tag', from: 'tag', w: 'duotone' },

  // ---- faces and hands ----
  { id: 's-smile', from: 'smiley', w: 'duotone' },
  { id: 's-frown', from: 'smiley-sad', w: 'duotone' },
  { id: 's-wink', from: 'smiley-wink', w: 'duotone' },
  { id: 's-neutral', from: 'smiley-meh', w: 'duotone' },
  { id: 's-thumb-up', from: 'thumbs-up', w: 'duotone' },
  { id: 's-thumb-down', from: 'thumbs-down', w: 'duotone' },

  // ---- talk ----
  { id: 's-speech', from: 'chat-circle', w: 'duotone' },
  { id: 's-thought', from: 'chat-teardrop-dots', w: 'duotone' },
  { id: 's-banner', from: 'flag-banner', w: 'duotone' },

  // ---- weather and bits ----
  { id: 's-lightning', from: 'lightning', w: 'duotone' },
  { id: 's-flame', from: 'fire', w: 'duotone' },
  { id: 's-cloud', from: 'cloud', w: 'duotone' },
  { id: 's-sun', from: 'sun', w: 'duotone' },
  { id: 's-moon', from: 'moon', w: 'duotone' },
  { id: 's-crown', from: 'crown', w: 'duotone' },
  { id: 's-skull', from: 'skull', w: 'duotone' },
  { id: 's-gem', from: 'diamond', w: 'duotone' },
  { id: 's-leaf', from: 'leaf', w: 'duotone' },
];

const local = process.argv[2] || null;

async function source(shape) {
  const file = `${shape.from}-${shape.w}.svg`;
  if (local) return fs.readFileSync(path.join(local, 'assets', shape.w, file), 'utf8');
  const res = await fetch(`${RAW}/${shape.w}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Turn one Phosphor file into one <symbol>.
 *
 * The <svg> wrapper goes, its viewBox is asserted rather than copied (a shape
 * on a different grid would arrive at a different weight from every other one),
 * and each <path> is rewritten to mbrd's paint convention. Only `d` and
 * `fill-rule` survive from the source attributes - everything else Phosphor
 * writes is paint we are replacing.
 */
function symbolFor(shape, svg) {
  const box = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (box !== '0 0 256 256') throw new Error(`${shape.from}: viewBox is ${box}`);

  const paths = [...svg.matchAll(/<path\b([^>]*?)\/?>/g)].map(([, attrs]) => ({
    d: attrs.match(/\bd="([^"]+)"/)?.[1] || '',
    rule: attrs.match(/\bfill-rule="([^"]+)"/)?.[1] || null,
    // How Phosphor marks the duotone background layer. It is the only thing
    // that distinguishes the two paths, and it is why this cannot simply take
    // the first path as the body: a few duotone icons carry more than two.
    back: /\bopacity="0\.2"/.test(attrs),
  })).filter(p => p.d);
  if (!paths.length) throw new Error(`${shape.from}: no paths`);

  const out = paths.map(p => {
    const rule = p.rule ? ` fill-rule="${p.rule}"` : '';
    // A background layer inherits the paper. Everything else is ink - which
    // covers the single-path weights too, where there is no background and the
    // whole glyph is the mark.
    const fill = p.back ? '' : ' fill="currentColor"';
    return `  <path${fill}${rule} d="${p.d}"/>`;
  });

  return `<symbol id="${shape.id}" viewBox="0 0 256 256">\n${out.join('\n')}\n</symbol>`;
}

const HEADER = `<!--
  The sticker shapes. GENERATED - do not hand-edit.

    node tools/gen-stickers.mjs [path-to-phosphor-core]

  Drawn by Phosphor (MIT), vendored at the revision pinned in that script. The
  licence ships beside this file as phosphor-LICENSE.txt and is named in
  THIRD-PARTY.md; tests/stickers-license.test.js holds the door shut.

  A second sprite, deliberately not assets/icons.svg. tests/icons.test.js checks
  that one in both directions - every <use href> resolves, and every <symbol> is
  referenced by one - and forty-five shapes that no reference in index.html
  mentions would fail the second half. These are content, not chrome: they are
  picked from a window at runtime, so nothing static can reference them.

  ═════ The paint ═════

  A 256 grid, and every shape a filled path - Phosphor draws even its outline
  weights that way, as a closed path tracing the outline of a line. Nothing here
  is stroked, so the line weight is Phosphor's and items.css sets stroke: none.

  A <use> renders its symbol into a shadow tree that inherited properties cross
  and selectors do not, so no rule in items.css can reach a path in here. The
  paint arrives by inheritance and is opted out of by attribute:

      no fill attribute      the paper body, from the sticker-body token
      fill="currentColor"    the ink, from the sticker-tint token via color

  (Custom properties are named without their leading dashes above. Two hyphens
  in a row inside an XML comment is a parse error that takes down the whole
  file - every shape on every board draws nothing at once, with no console
  warning and no failed request to say why. It has happened here once.
  tests/stickers.test.js guards it.)
-->`;

const parts = [];
for (const shape of SHAPES) parts.push(symbolFor(shape, await source(shape)));

fs.writeFileSync(
  OUT,
  `<svg xmlns="http://www.w3.org/2000/svg">\n${HEADER}\n\n${parts.join('\n\n')}\n\n</svg>\n`,
);
console.log(`web/assets/stickers.svg: ${parts.length} shapes`);
