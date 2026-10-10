// Module layering enforced as tests - acyclicity and the directional rules
// from architecture.md (util/geometry <- state <- {import, storage, canvas}
// <- ui, canvas reaching import only for the generated catalog). The DEBT
// map ledgers known inversions; it is empty and may only shrink. optimize/
// is deliberately unranked but still covered by the acyclicity check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JS, walk } from './helpers.js';

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

// Both extensions, for as long as both exist: layering is a property of the
// graph, not of the language a module happens to be written in.
const modules = walk(JS, ['.js', '.ts'], JS);

/** Resolve one './x' or '../y' specifier against the module that wrote it. */
function resolveSpec(mod, spec) {
  const dir = mod.includes('/') ? mod.slice(0, mod.lastIndexOf('/')) : '';
  const parts = (dir ? dir.split('/') : []);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let target = parts.join('/');
  // Specifiers carry the real extension of the file they name, which is what
  // lets Node run the suite with nothing installed. The append below is the
  // extensionless fallback - should not occur, kept so a stray specifier
  // resolves instead of vanishing from the graph. `.mjs` counts as an
  // extension too, since it is what a vendored ES module carries.
  if (!/\.(js|mjs|ts)$/.test(target)) target += '.js';
  return target;
}

/**
 * Whether a resolved target is a module of this app at all. A specifier
 * that climbs out of web/assets/js names a vendored library (e.g.
 * canvas/matte-worker.js importing ONNX Runtime) with no layer of its own,
 * excluded from the graph rather than held to a naming convention. Vendor
 * presence, pin and licence are checked separately, by matte-vendor.test.js
 * and pdf-vendor.test.js.
 */
const ours = target => !target.startsWith('vendor/') && !target.startsWith('../');

/** Static import specifiers in one module, resolved to module-relative paths. */
function importsOf(mod) {
  const src = readFileSync(join(JS, mod), 'utf8');
  const out = [];
  // Static import/export/side-effect forms. Dynamic import() is separate, below.
  const withFrom = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
  const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
  for (const re of [withFrom, bare]) {
    let m;
    while ((m = re.exec(src))) out.push(resolveSpec(mod, m[1]));
  }
  return out;
}

/**
 * Dynamic `import('./x')` specifiers, kept apart from the static ones.
 * Excluded from the cycle check on purpose - it's the seam that legitimately
 * breaks a cycle - but not from the direction check: an arrow doesn't stop
 * pointing the wrong way for being deferred to a click. Ranked by the same
 * `inverted()`, with its own ledger.
 */
function dynamicImportsOf(mod) {
  const src = readFileSync(join(JS, mod), 'utf8');
  const out = [];
  const re = /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) out.push(resolveSpec(mod, m[1]));
  return out;
}

const edges = [];
const dynamicEdges = [];
for (const mod of modules) {
  for (const target of importsOf(mod).filter(ours)) edges.push([mod, target]);
  for (const target of dynamicImportsOf(mod).filter(ours)) dynamicEdges.push([mod, target]);
}

test('every import resolves to a module that exists', () => {
  // A parser this small is only trustworthy if its targets are real files;
  // also catches a rename that left a dangling specifier. Dynamic specifiers
  // need this most, since esbuild only resolves them in CI's build leg,
  // which reports after the push.
  const present = new Set(modules);
  const dangling = [...edges, ...dynamicEdges].filter(([, to]) => !present.has(to));
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
  // Which page of the site this is. Read by main.ts, ui/panel.ts and
  // commands/view.ts alike, so it has to sit under all three.
  'page.ts',
  // The quality dial's flags: canvas/* reads them, ui/quality.ts writes
  // them, so they can't sit in ui/ without inverting the graph.
  'quality.ts',
  // What the wheel means, for the same reason and read the same way round:
  // canvas/input.ts asks on every wheel event, the sidebar writes.
  'controls.ts',
  // The arrangement catalogue: pure, no DOM, no state import. state.ts reads
  // mobileArrangement() from it, which is a downward read.
  'arrange/arrangements.ts',
  // Shortest-column-first packing, below the catalogue since ui/feed.ts also
  // packs by the same rule and needs it under both callers.
  'arrange/columns.ts',
  // Overlap removal for Nudge board: pure, over the catalogue's Point type only.
  'arrange/nudge.ts',
  // Folding one board into another - pure, over board-model.ts, geometry.ts
  // and util.ts only. state.ts imports its type to declare mergeBoard(),
  // which is downward.
  'merge.ts',
  // The sticker catalogue, hand-written and importing nothing - the lowest
  // module in the graph. state.ts reads stickerTint() from it, downward.
  'stickers/catalogue.ts',
  // The floor state.ts is being split onto: board-store.ts (bus, selection,
  // dirty flag), board-model.ts (shape, defaults, id index), history.ts
  // (undo/redo). None may ever import state.ts back.
  'board-store.ts', 'board-model.ts', 'history.ts', 'sticky.ts', 'layout.ts', 'stacking.ts',
  // The step ledger, below history.ts: history keeps changes as closures and
  // calls in here to keep the same change as data, an arrow that can't
  // reverse. Knows nothing about the file format, so board-schema.ts imports it.
  'timeline.ts',
  // The .mbrd format, both directions. Below state.ts because reading a file
  // is a pure transform and only the swap-in is a mutation - the reader must
  // be reachable without the mutation door.
  'board-schema.ts',
  // The boards inside the board, as documents by id, and the path to the one
  // on screen. Data only: board-schema.ts writes the tree out, state.ts walks it.
  'board-tree.ts',
  // The cards an empty board puts on itself - hydration, no commit, no
  // history, so the wrong tenant for the mutation door.
  'onboarding.ts',
  // The internal clipboard: not board state, never saved, nothing to undo.
  // Cut and paste stay in state.ts and call into this.
  'clipboard.ts',
  // Every write to board.connections - the mutation half beside commit();
  // board-model.ts already owns a connection's shape.
  'connections.ts',
  // The bin: delete and restore, two directions of one door. The limit
  // itself lives in board-model.ts since the file reader checks it too.
  'trash.ts',
  // Fence membership, beside sticky.ts: a question about where things are,
  // not a mutation. Reads board.layouts directly to avoid a cycle with layout.ts.
  'fences.ts',
  // The web's graph and its governor: pure arithmetic over points, no DOM,
  // no viewport.
  'web-graph.ts',
  // The router, beside it for the same reason: obstacles are handed in, so
  // it never reaches for the spatial index or the board.
  'web-route.ts',
  // The four modules util.ts split into - imported from every tier,
  // importing nothing themselves.
  //
  //   crypto.ts             the content id, needed by storage/ alone
  //   prefs.ts               all localStorage access, below everything since
  //                          canvas/, ui/ and quality.ts each remember something
  //   notify.ts               toast()/busy(), agnostic of how either renders;
  //                          rendering is injected back by main.ts via
  //                          setOverlays() so mutation/clipboard/packer/importer
  //                          don't have to import ui/
  //   media/transport.ts     the scrubber's wave, built as SVG with no
  //                          `document` access, shared by three ui/canvas players
  'crypto.ts', 'prefs.ts', 'notify.ts', 'media/transport.ts',
  // A picture's dimensions from its header, importing nothing: import/ asks
  // before a decode, canvas/display.ts before deciding a copy is worth it.
  'image-header.ts',
  // The byte readers every hand-written parser shares, importing nothing.
  'bytes.ts',
  // The interface's own sounds: read from four tiers, so must sit under all
  // of them. recipes.ts imports nothing; the engine touches `document` only
  // inside a function. ui/sound-lab.ts, the bench, stays in ui/.
  'cuelume/recipes.ts', 'cuelume/engine.ts',
  // Colour as arithmetic, out of ui/pigments.ts: imports nothing, knows
  // nothing app-specific, and is read from three ui/ modules that would
  // otherwise each copy the hex parse by hand.
  'color.ts',
  // The handler of last resort, beside notify.ts: must be installed before
  // any layer above it exists. boardSafety() is injected via
  // setBoardProbe(), the same shape as setOverlays().
  'errors.ts',
  // Every size ceiling in the app. import/, storage/ and mesh.ts hit
  // ceilings from the base; ui/dialog.ts asks the question via
  // setRiskPrompt(). Imports nothing.
  'consent.ts',
  // The seven questions a browser tab used to answer on its own, and the
  // shell that may answer differently - storage/, import/, canvas/ and
  // main.ts all ask, so it sits under all four. electron.ts is a function
  // of the bridge object main.ts hands it, not a reader of one, so it stays beside it.
  'platform/platform.ts', 'platform/electron.ts',
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
  // storage/ is closed to canvas/ except note-model.ts, the format's own
  // Markdown flavour (pure string functions, no DOM) that storage/mbrd.ts
  // needs for note sidecars - the alternative duplicates what `# ` means.
  if (from.startsWith('storage/') && to.startsWith('canvas/') && to !== 'canvas/note-model.ts') return true;
  // The service layer must not reach up into the interface - architecture.md
  // has called this "a layering regression" all along, enforced here for the
  // first time. canvas/ reaches ui/ only through commands.ts (and import/
  // through drop.ts), the sanctioned seams. optimize/ stays unranked, as
  // elsewhere, since optimize/ui.ts genuinely opens a dialog.
  if (from.startsWith('canvas/') && to.startsWith('ui/')) return true;
  if (from.startsWith('import/') && to.startsWith('ui/')) return true;
  return false;
}

/**
 * Known inversions, each with the fix that would clear it. Empty: the three
 * AUD-12 opened with are paid off (mesh core moved to a neutral module,
 * state/storage take interface dependencies by injection). The two tests
 * below keep it that way - only new debt or already-paid debt fails them.
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
  // A DEBT entry whose edge no longer exists is a rule guarding nothing and
  // a fix that went uncelebrated.
  const present = new Set(edges.map(([from, to]) => `${from} -> ${to}`));
  const stale = [...DEBT.keys()].filter(e => !present.has(e));
  assert.deepEqual(stale, [], 'listed as debt but the import is already gone');
});

/**
 * The same ledger for edges taken through `await import()`. Empty: none of
 * the tree's thirty dynamic imports invert. A separate map from DEBT because
 * the two are different admissions - a static inversion shouldn't exist, a
 * dynamic one is a deferred wire somebody argued for.
 */
const DYNAMIC_DEBT = new Map([]);

test('no layering inversion hides behind a dynamic import', () => {
  const found = dynamicEdges
    .filter(([from, to]) => inverted(from, to))
    .map(([from, to]) => `${from} -> ${to}`)
    .sort();
  assert.deepEqual(found, [...DYNAMIC_DEBT.keys()].sort());
});

test('no line of dynamic debt has already been paid off', () => {
  const present = new Set(dynamicEdges.map(([from, to]) => `${from} -> ${to}`));
  const stale = [...DYNAMIC_DEBT.keys()].filter(e => !present.has(e));
  assert.deepEqual(stale, [], 'listed as debt but the dynamic import is already gone');
});

test('the dynamic walk found the seams it is supposed to be watching', () => {
  // The guard on the guard: a regex matching nothing would make both tests
  // above pass while proving nothing. Eight is a floor, not the real count
  // (thirty), so removing the last dynamic import is a deliberate edit.
  assert.ok(dynamicEdges.length >= 8,
    `the dynamic import walk found ${dynamicEdges.length} edges - the tree has at least eight`);
});
