// The module layering, as executable policy rather than prose.
//
// research/docs/architecture.md draws the intended graph, and CLAUDE.md carries
// the same line:
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
// leaf-helpers and half orchestrators, and it is a button. This used to be the
// test declining to invent a tier the guide had no opinion about; CLAUDE.md now
// states the exclusion and the reason for it in the layering bullet, so the two
// agree rather than one being silent. The acyclicity check still covers it,
// which is the part that actually matters.

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
  // Specifiers in this codebase carry the real extension of the file they
  // name - './foo.ts' for a converted module, './foo.js' for one not yet -
  // because that is what lets Node run the suite with nothing installed
  // (tsconfig.json says why). The append below is the extensionless case,
  // which should not occur and is kept so a stray one resolves rather than
  // vanishing from the graph unnoticed.
  if (!/\.(js|ts)$/.test(target)) target += '.js';
  return target;
}

/** Static import specifiers in one module, resolved to module-relative paths. */
function importsOf(mod) {
  const src = readFileSync(join(JS, mod), 'utf8');
  const out = [];
  // `import ... from './x'`, `export ... from './x'`, and side-effect
  // `import './x'`. Dynamic import() is counted separately, below.
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
 *
 * They are excluded from the cycle check on purpose - a dynamic import is the
 * seam that legitimately breaks a cycle, which is how optimize/ and the
 * worst-case media paths hang off the graph without inverting it. What they were
 * *also* excluded from was the direction check, and that part was a hole: the
 * rules below are about which way an arrow points, and an arrow does not stop
 * pointing that way for being deferred to a click. An inversion routed through
 * `await import()` was invisible to this file entirely.
 *
 * So they are ranked by the same `inverted()` and carry their own ledger. Being
 * a deliberate seam is a thing to write down, not a thing to be exempt from.
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
  for (const target of importsOf(mod)) edges.push([mod, target]);
  for (const target of dynamicImportsOf(mod)) dynamicEdges.push([mod, target]);
}

test('every import resolves to a module that exists', () => {
  // A parser this small is only trustworthy if its targets are real files;
  // this also catches a rename that left a dangling specifier.
  //
  // Dynamic specifiers are checked here too, and they are the ones that most
  // need it: esbuild resolves them in CI's build leg, which reports after the
  // push, and CLAUDE.md's warning about case-sensitive paths on the deployed
  // host applies to them exactly as much.
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
  // Which page of the site this is. It imports nothing at all and reads the URL
  // lazily, and three tiers apart ask it the same question: main.ts (restore a
  // session or not), ui/panel.ts (grey what needs a board) and
  // commands/view.ts (the changelog's way back). A fact that far-flung has to
  // be at the bottom or it is an inversion for two of the three.
  'page.ts',
  // The quality dial's flags. Bottom of the graph on purpose: canvas/* reads
  // them and ui/quality.js writes them, and a setting canvas has to import
  // cannot sit in ui/ without inverting the whole graph.
  'quality.ts',
  // The arrangement catalogue, which research/docs/architecture.md already names among
  // the pure modules at the bottom: no DOM, no state import, geometry.js and
  // nothing else. state.js reads mobileArrangement() from it to know which of
  // the two catalogues a stored id belongs to, and that read is downward.
  'arrange/arrangements.ts',
  // Shortest-column-first packing, one floor below the catalogue that reads it.
  // It imports nothing at all, like stickers/catalogue.js, and it is down here
  // rather than inside arrangements.js because the *Feed* is its other caller:
  // ui/feed.js packs its wall by the same rule, and a rule two tiers apart both
  // reach for has to be under both of them.
  'arrange/columns.ts',
  // Folding one board into another: the id remap and where the arrivals land.
  // Pure - board-model.js, geometry.js and util.js, and nothing above them - and
  // down here for a reason its own header gives at length: a collision handled
  // wrongly produces a board that looks right and has a note stuck to the wrong
  // photograph, so the only way to know it works is to hammer it in a test with
  // no board in scope. state.js imports its *type* to declare mergeBoard(),
  // which is downward.
  'merge.ts',
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
  // The step ledger, below history.js rather than beside it. history.js keeps
  // changes as closures and calls in here to keep the same change as data; the
  // arrow points that way and may never point back, because a closure can be
  // built out of a record and a record cannot be built out of a closure. It
  // stands on board-model.js and knows nothing about the file format - which is
  // why board-schema.js imports *it*, and not the reverse.
  'timeline.ts',
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
  // The interface's own sounds, and the same sentence as quality.js one more
  // time: state.js, canvas/, import/, ui/ and notify.js all say something
  // happened, which is four tiers, and a thing every tier reads has to be under
  // all of them or it is an inversion for most of them. The table half
  // (recipes.js) imports nothing at all; the engine imports prefs.js and the
  // table, and touches `document` only inside a function to read the whimsy
  // tier. ui/sound-lab.js is the bench and stays in ui/, because a page is
  // interface.
  'cuelume/recipes.ts', 'cuelume/engine.ts',
  // Colour as arithmetic, lifted out of ui/pigments.js's own "Colour" heading.
  // Here for the same reason as the four above: it imports nothing, it knows
  // nothing about this app - OKLab conversion, a gamut-safe hex, a WCAG ratio
  // are the same functions in any program - and it is reached from more than one
  // tier. ui/pigments.js, ui/appearance.js and ui/color-picker.js all read it,
  // and the last two had been copying the six-digit hex parse rather than
  // importing across a section comment. Everything that knows which colour does
  // which job stayed in ui/pigments.js, which is what keeps this one down here.
  'color.ts',
  // The handler of last resort, beside notify.js and importing nothing but it.
  // It is down here for two reasons that point the same way. It has to be
  // installed before anything else in the app can fail, which means before any
  // layer above it exists; and util.js's emitter reaches it from the catch that
  // stops one broken subscriber taking the bus down with it, which puts a base
  // module among its callers. Whether the board is safe is the one thing it
  // cannot work out for itself, so storage/session.js's boardSafety() is
  // injected by main.js through setBoardProbe() - the same shape as
  // setOverlays() above and for the same reason: the answer lives up the graph,
  // the question has to be askable from the bottom of it.
  'errors.ts',
  // Every size ceiling in the app, and the prose for asking about one instead of
  // refusing. Down here for exactly the reason errors.ts above is: the three
  // tiers that hit a ceiling are import/, storage/ and mesh.ts at the base, and
  // the thing that can put the question on screen is ui/dialog.js at the top -
  // so the question is injected through setRiskPrompt() and the module under all
  // three of them holds it. Imports nothing at all.
  'consent.ts',
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
  // The second peer edge, on the same terms as the first: one named module, and
  // the rest of canvas/ closed to storage/. storage/mbrd.ts reads and writes the
  // note sidecars a .mbrd carries, and canvas/note-model.ts is the format's own
  // Markdown flavour written down once - pure functions of a string, no DOM in
  // the two it takes. The alternative is twenty lines of block splitting copied
  // into the container, which would give the file format a second answer to what
  // `# ` means. This edge was argued in that module's header and checked by
  // nothing, which is the half that was wrong.
  if (from.startsWith('storage/') && to.startsWith('canvas/') && to !== 'canvas/note-model.ts') return true;
  // The service layer must not reach up into the interface. architecture.md has
  // called a ui/ import from canvas/ "a layering regression" - "a test failure
  // and not a style note" - for as long as it has existed, and until now nothing
  // checked it: the graph happened to be clean, so the claim was true by luck
  // rather than by enforcement. There are still zero such edges,
  // which is exactly why this is cheap to add - a rule written while the ledger
  // is empty costs nothing and can only be paid for later.
  //
  // canvas/ reaches ui/ through commands.ts, which is the sanctioned seam, and
  // import/ has drop.ts doing the same. optimize/ is deliberately left out of
  // this, as it is left out of the rest of the ranking - it is dynamically
  // imported and half of it is orchestration, and optimize/ui.ts genuinely does
  // open a dialog. Both guides now say the same, so leaving it out follows them
  // rather than dodging them.
  if (from.startsWith('canvas/') && to.startsWith('ui/')) return true;
  if (from.startsWith('import/') && to.startsWith('ui/')) return true;
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

/**
 * The same ledger for edges taken through `await import()`.
 *
 * Empty, and that is the point of writing it now: there are eight literal
 * dynamic imports in the tree and not one of them inverts, so this costs
 * nothing today and cannot be added to quietly tomorrow. It is a second map
 * rather than entries in DEBT because the two are different admissions - a
 * static inversion is a wire that should not exist, and a dynamic one is a wire
 * somebody argued was worth deferring.
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
  // The guard on the guard. A regex that matched nothing would make both tests
  // above pass while proving nothing at all - the same failure mode the module
  // walk in ts-debt.test.js has its own guard for. Eight is what the tree
  // carries; the number is here so that removing the last dynamic import is a
  // deliberate edit rather than a silent loss of coverage.
  assert.ok(dynamicEdges.length >= 8,
    `the dynamic import walk found ${dynamicEdges.length} edges - the tree has at least eight`);
});
