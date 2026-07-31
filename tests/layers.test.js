// The module layering, as executable policy rather than prose.
//
// CLAUDE.md draws the intended graph:
//
//   util/geometry <- state <- {import, storage, canvas} <- ui
//
// with canvas allowed to reach into import only for the generated format
// catalog. That direction is what keeps the dependency graph a DAG and keeps
// the lower modules loadable and testable without the ones above them. But a
// sentence in a guide is not enforced by anything, and AUD-12 found the arrows
// already bent in a handful of places - since fixed.
//
// This makes the two halves of that policy executable. First, the property the
// whole layering exists to protect: the import graph has no cycle. That one is
// objective and needs no judgement calls. Second, the directional rules the
// guide states plainly - state sits below the services, storage does not reach
// up into the interface, canvas touches import only through the generated
// catalog. The DEBT map below is the ledger of known inversions; AUD-12 cleared
// it to empty, and the two tests keep it honest - a *new* inversion must be
// entered there or the first fails, and an entry whose edge is already gone
// fails the second. The list can only shrink.
//
// optimize/ is deliberately not ranked here. It is dynamically imported, half
// leaf-helpers and half orchestrators (CLAUDE.md: "it is a button"), and
// CLAUDE.md's arrow never mentions it; inventing a tier for it would be this
// test asserting an opinion the guide does not hold. The acyclicity check still
// covers it, which is the part that actually matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JS, walk } from './helpers.js';

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

const modules = walk(JS, ['.js'], JS);

/** Static import specifiers in one module, resolved to module-relative paths. */
function importsOf(mod) {
  const src = readFileSync(join(JS, mod), 'utf8');
  const dir = mod.includes('/') ? mod.slice(0, mod.lastIndexOf('/')) : '';
  const out = [];
  // `import ... from './x'`, `export ... from './x'`, and side-effect
  // `import './x'`. Dynamic import() is intentionally not counted: it is the
  // seam the layering uses on purpose (optimize/, worst-case media paths).
  const withFrom = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
  const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
  for (const re of [withFrom, bare]) {
    let m;
    while ((m = re.exec(src))) {
      let spec = m[1];
      // Resolve './x' and '../y' against this module's directory.
      const parts = (dir ? dir.split('/') : []);
      for (const seg of spec.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      let target = parts.join('/');
      if (!target.endsWith('.js')) target += '.js';
      out.push(target);
    }
  }
  return out;
}

const edges = [];
for (const mod of modules) {
  for (const target of importsOf(mod)) edges.push([mod, target]);
}

test('every import resolves to a module that exists', () => {
  // A parser this small is only trustworthy if its targets are real files;
  // this also catches a rename that left a dangling specifier.
  const present = new Set(modules);
  const dangling = edges.filter(([, to]) => !present.has(to));
  assert.deepEqual(dangling.map(e => e.join(' -> ')), [], 'import target not found on disk');
});

// ---------------------------------------------------------------------------
// The property the layering exists to protect
// ---------------------------------------------------------------------------

test('the import graph has no cycle', () => {
  const adj = new Map(modules.map(m => [m, []]));
  for (const [from, to] of edges) if (adj.has(to)) adj.get(from).push(to);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map(modules.map(m => [m, WHITE]));
  const stack = [];

  function visit(node) {
    colour.set(node, GREY);
    stack.push(node);
    for (const next of adj.get(node)) {
      if (colour.get(next) === GREY) {
        const from = stack.indexOf(next);
        return [...stack.slice(from), next].join(' -> ');
      }
      if (colour.get(next) === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    colour.set(node, BLACK);
    return null;
  }

  for (const m of modules) {
    if (colour.get(m) === WHITE) {
      const cycle = visit(m);
      assert.equal(cycle, null, `import cycle: ${cycle}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The directional rules, and the debt against them
// ---------------------------------------------------------------------------

const BASE = new Set([
  'util.js', 'geometry.js', 'measure.js', 'layout-settings.js', 'version.js',
  // The quality dial's flags. Bottom of the graph on purpose: canvas/* reads
  // them and ui/quality.js writes them, and a setting canvas has to import
  // cannot sit in ui/ without inverting the whole graph.
  'quality.js',
  // The arrangement catalogue, which CLAUDE.md already names among the pure
  // modules at the bottom: no DOM, no state import, geometry.js and nothing
  // else. state.js reads mobileArrangement() from it to know which of the two
  // catalogues a stored id belongs to, and that read is downward.
  'arrange/arrangements.js',
  // The two pieces lifted out from under state.js. board-store.js holds the
  // bus, the selection and the dirty flag; history.js holds the undo/redo
  // engine over them. Both are below state by construction and neither may ever
  // import it - that is the whole reason they are separate files, since a
  // concern lifted out of state.js can only stay out if what it stands on is
  // lower than what it left.
  'board-store.js', 'history.js',
]);

/**
 * True when this edge points the wrong way through the declared layering.
 * Only the rules CLAUDE.md states outright are encoded; anything it leaves to
 * judgement is left to the cycle check above.
 */
function inverted(from, to) {
  if (to === 'main.js') return true;                       // nothing wires the wiring point
  if (BASE.has(from) && !BASE.has(to)) return true;        // the base layer depends on nothing above it
  if (from === 'state.js' && !BASE.has(to)) return true;   // state is below the services and the ui
  if (from.startsWith('storage/') && to.startsWith('ui/')) return true;   // storage must not open the interface
  if (from.startsWith('canvas/') && to.startsWith('import/') && to !== 'import/formats.js') return true; // canvas -> import: catalog only
  return false;
}

/**
 * Known inversions, each with the fix that would clear it. AUD-12 opened with
 * three - state importing the asset registry, storage opening the discard
 * dialog, and canvas decoding meshes through import/ - and all three are now
 * paid off: the mesh core moved to a neutral module, and state and storage take
 * their one interface dependency by injection (setAssetNameLookup, setPrompt)
 * rather than by import. So this map is empty, and the two tests below keep it
 * that way: a *new* inversion must be entered here or the first fails, and an
 * entry whose edge no longer exists fails the second. The direction is down.
 */
const DEBT = new Map([]);

test('the only layering inversions are the ones on record', () => {
  const found = edges
    .filter(([from, to]) => inverted(from, to))
    .map(([from, to]) => `${from} -> ${to}`)
    .sort();
  const recorded = [...DEBT.keys()].sort();
  assert.deepEqual(found, recorded);
});

test('no line of debt has already been paid off', () => {
  // A DEBT entry whose edge no longer exists is a rule guarding nothing and a
  // fix that went uncelebrated - the same drift the SHELL and TOKENS lists get
  // asserted against.
  const present = new Set(edges.map(([from, to]) => `${from} -> ${to}`));
  const stale = [...DEBT.keys()].filter(e => !present.has(e));
  assert.deepEqual(stale, [], 'listed as debt but the import is already gone');
});
