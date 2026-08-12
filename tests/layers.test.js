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

// Both extensions, for as long as both exist. The tree is being converted to
// TypeScript a layer at a time (see tsconfig.json), and the layering is a
// property of the graph rather than of the language it is written in - a module
// that moved to .ts is the same node with the same edges. When the last .js
// under web/assets/js is gone this goes back to one extension.
const modules = walk(JS, ['.js', '.ts'], JS);

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
      const spec = m[1];
      // Resolve './x' and '../y' against this module's directory.
      const parts = (dir ? dir.split('/') : []);
      for (const seg of spec.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      let target = parts.join('/');
      // Specifiers in this codebase carry the real extension of the file they
      // name - './foo.ts' for a converted module, './foo.js' for one not yet -
      // because that is what lets Node run the suite with nothing installed
      // (tsconfig.json says why). The append below is the extensionless case,
      // which should not occur and is kept so a stray one resolves rather than
      // vanishing from the graph unnoticed.
      if (!/\.(js|ts)$/.test(target)) target += '.js';
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
  'util.ts', 'geometry.ts', 'measure.ts', 'layout-settings.ts', 'version.js',
  // The quality dial's flags. Bottom of the graph on purpose: canvas/* reads
  // them and ui/quality.js writes them, and a setting canvas has to import
  // cannot sit in ui/ without inverting the whole graph.
  'quality.ts',
  // The arrangement catalogue, which research/docs/architecture.md already names among
  // the pure modules at the bottom: no DOM, no state import, geometry.js and
  // nothing else. state.js reads mobileArrangement() from it to know which of
  // the two catalogues a stored id belongs to, and that read is downward.
  'arrange/arrangements.ts',
  // The sticker catalogue, beside the arrangement catalogue and for the same
  // reason: it is a hand-written table and nothing else. It imports *nothing* -
  // not even geometry.js - which makes it the lowest module in the graph, and
  // state.js reads stickerTint() from it to hold an arriving tint to the
  // palette that exists. That read is downward.
  'stickers/catalogue.ts',
  // The floor state.js is being split onto. board-store.js holds the bus, the
  // selection and the dirty flag; board-model.js holds the board's shape, its
  // defaults and the id index; history.js holds the undo/redo engine over them.
  // None may ever import state.js back - that is the whole reason they are
  // separate files, since a concern lifted out of state.js can only stay out if
  // what it stands on is lower than what it left.
  'board-store.ts', 'board-model.ts', 'history.ts', 'sticky.ts', 'layout.ts', 'stacking.ts',
  // The .mbrd format, in both directions. Below state.js for the reason its own
  // header gives: reading a file is a pure raw -> clean transformation over
  // data, and only the assignment that swaps the result in is a mutation. The
  // reader must be reachable without the mutation door, or every change to the
  // format is a change to the door.
  'board-schema.ts',
  // The cards an empty board puts on itself. Content and policy rather than
  // mutation: every function in it is hydration - no commit, no history - which
  // is what made it the wrong tenant for the mutation door. It holds two
  // session latches, so it is a module with state and not a table of data, and
  // loadBoard() resets one of them on every board that arrives.
  'onboarding.ts',
  // The internal clipboard. Nothing in it touches the board - the clipboard is
  // not board state, is never saved and has nothing about it to undo - which is
  // what let it out. The two commands that do touch the board, cut and paste,
  // stayed in state.js and call into this.
  'clipboard.ts',
  // Every write to board.connections. board-model.js already owned the shape of
  // a connection - pairKey, the CONN_* tables, connMeta, normalizeConnections -
  // and board-schema.js owns the pruning at the file boundary; this is the
  // mutation half, which only ever needed to sit beside commit().
  'connections.ts',
  // The bin. Delete and restore are two directions of one door, and they sat
  // four hundred lines apart in state.js; the limit itself is in board-model.js,
  // because the file reader holds an arriving bin to it too.
  'trash.ts',
  // Fence membership, beside sticky.js and for the same reason: it is a question
  // about where two things are, and the mutations that act on the answer stay in
  // state.js. It reads board.layouts directly rather than layout.js's helper for
  // it, which is what keeps the two off a cycle - layout.js calls refence().
  'fences.ts',
  // The web's graph and its governor. Pure arithmetic over points - no DOM, no
  // viewport - which is what let it out of canvas/web.js at all.
  'web-graph.ts',
  // And the router, beside it for the same reason: the obstacles are handed in,
  // so it never reaches for the spatial index or the board. canvas/web.js is
  // the half that knows which cards are near and the half that draws.
  'web-route.ts',
  // The four modules util.js was split into, each of which is here for the same
  // reason util.js always was: they are imported from every tier and they
  // import nothing at all.
  //
  //   crypto.js    the content id. storage/ makes one on the way in and spells
  //                one into an archive on the way out; nobody else needs it,
  //                and nobody at all should have to carry FIPS 180-4 to reach
  //                clamp().
  //   prefs.js     every localStorage read and write in the app. Wrapped
  //                because touching storage in a private window throws, and
  //                below everything because canvas/, ui/ and quality.js all
  //                remember something.
  //   notify.js    the announcement channel - toast() and busy() with no idea
  //                how either is drawn. This one is load-bearing for the rule
  //                right below: the mutation door, the clipboard, the packer
  //                and the importer all have something to say, they all sit
  //                below ui/, and ui/overlays.js is what actually draws it. So
  //                the message travels down the graph and the rendering is
  //                injected back in by main.js through setOverlays(), the same
  //                shape as setAssetNameLookup() and setPrompt(). Without it,
  //                four modules in this list would import ui/ and this test
  //                would be a ledger of debt instead of an empty map.
  //   media/transport.js
  //                the scrubber's wave. Three players draw it - the now-playing
  //                bar, the playlist window and a video card - and they sit in
  //                ui/, ui/ and canvas/, so the only place all three can reach
  //                is the bottom. It builds SVG for elements it is handed and
  //                never reaches for `document`, which is what lets it be down
  //                here rather than in ui/.
  'crypto.ts', 'prefs.ts', 'notify.ts', 'media/transport.ts',
]);

/**
 * True when this edge points the wrong way through the declared layering.
 * Only the rules CLAUDE.md and research/docs/architecture.md state outright are encoded;
 * anything they leave to judgement is left to the cycle check above.
 */
function inverted(from, to) {
  if (to === 'main.ts') return true;                       // nothing wires the wiring point
  if (BASE.has(from) && !BASE.has(to)) return true;        // the base layer depends on nothing above it
  if (from === 'state.ts' && !BASE.has(to)) return true;   // state is below the services and the ui
  if (from.startsWith('storage/') && to.startsWith('ui/')) return true;   // storage must not open the interface
  if (from.startsWith('canvas/') && to.startsWith('import/') && to !== 'import/formats.ts') return true; // canvas -> import: catalog only
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
