# Issues to open on the day the repository goes public

Not a roadmap and not a backlog — this is the **first page**. A repository whose
Issues tab is empty tells a visitor either that nothing needs doing or that
nobody is home, and both are wrong.

Each entry below is one issue: paste the body, apply the labels, and delete this
file once they exist. They are ordered so that the top four are genuinely
approachable by somebody who has never seen the code, which is what
`good first issue` is supposed to mean and usually does not.

Labels to create first: `good first issue`, `help wanted`, `enhancement`,
`bug`, `format`, `performance`, `docs`, `design`.

---

## 1. Add an arrangement

**Labels:** `good first issue`, `enhancement`

The single best first change in this codebase. `arrange/arrangements.js` is
pure: every arrangement is `(items, opts) => [{x, y}]` in input order, no DOM,
no state, no viewport. A fresh import and "Rearrange all" share the one code
path, so anything you add works in both immediately.

Read the module header first — `spacing` always means edge-to-edge gap, and
passing a `seed` is what makes a layout move its slots, so seedless calls stay
reproducible.

Ideas, in rough order of difficulty: **columns** (newspaper, fixed count),
**diagonal**, **circle/radial**, **golden spiral**, **by colour** (needs a
pigment read, so more involved), **by size**.

Add your entry to `ARRANGEMENTS`, add a case to `tests/layout.test.js`, and post
a screenshot of thirty photos under it.

---

## 2. Support a file format

**Labels:** `good first issue`, `format`, `help wanted`

A branch in `classify()` plus an entry in `RENDERERS`, both in
`canvas/renderers.js`. Nothing else in the app needs to know the type exists.

The rule is that a new format is a few hundred lines of header reading in the
same style as `mesh.js` (STL/OBJ/GLB) or `import/artwork.js` (ID3v2, MP4 atoms,
FLAC blocks) — **not an npm package**. That constraint is what makes this
project what it is, and it is also why these are fun.

Open today: **PDF** (first page as a thumbnail), **PSD** (the composite preview
is right there in the header), **HEIC/RAW**, **archives** (`.zip` contents as a
listing — `storage/zip.js` already reads the central directory), **DXF**.

Use the "Support a file format" issue template and say up front whether the
browser can decode it, because that is the whole question.

---

## 3. Add a setting

**Labels:** `good first issue`

One entry in `ui/settings-schema.js` — `id`, `tab`, `section`, `type`,
`get`/`set`, and `when` if it only applies to one layout. `ui/panel.js` builds
the row; you do not touch it. `tests/settings-panel.test.js` will tell you if
the entry is inconsistent.

If the setting is about how a board *looks*, read `docs/layout-settings.md`
first: you have to decide whether it travels with the board or stays with the
device, and that decision is the interesting part of the change.

---

## 4. Improve a palette, or add one

**Labels:** `good first issue`, `design`

`web/lab.html` is a ready-made bench for the palette extractor — it imports the
real `ui/pigments.js`, so what you see is what the app does. Drop pictures in,
watch the OKLCh derivation and the contrast repair, and tune.

`tools/preset-oklch.mjs` prints the OKLCh ranges the existing `SHEET`/`PIGMENT`
tables were built from. Analysis only; it writes nothing.

---

## 5. Measure the memory budget on a real phone

**Labels:** `help wanted`, `performance`

`research/future/lod-and-memory-budget.md` holds two designs that are
deliberately **not started**, because both are gated on a measurement nobody has
taken: a level-of-detail proxy, and an explicit memory budget behind it.

The history matters. Framing a whole board of fifty items used to kill the tab
on an iPhone. Three fixes shipped for that and it is no longer the headline —
`canvas/display.js` caps a mounted copy at ~1200px, `canvas/stills.js` freezes
animated GIFs past a zoom threshold, and `canvas/spatial.js` made the cull cheap.
Whether anything further is *needed* is now an open question rather than an
obvious yes, and building an LOD system to answer it would be backwards.

So the contribution wanted here is **a number, not a feature**: open a large
board on a real device, arm `mbrd.perf.on()` (or `#perf` in the URL, which is
how you do it on a phone with no console), and post the readout. `decodedImgMB`
and `mountedNodes` are the two that decide this.

---

## 6. Tauri readiness

**Labels:** `help wanted`, `enhancement`

`research/future/code-audit-tauri-readiness-2026-07-26.md` is a full audit
against wrapping the app for Windows, macOS, Linux, Android and iOS. It is
not started and its own findings note that some of its assumptions are stale.

The interesting property is that mbrd is already most of the way there: no
server, no runtime dependency, no build step, and every path that touches the
outside world is already isolated to three modules. The work is in the seams —
the File System Access API paths in `storage/storage.js`, the file handlers in
`manifest.json`, and the service worker, which a native shell does not need.

Read the audit first, then open one issue per finding rather than treating it as
a single task.

---

## 7. Widen the typecheck

**Labels:** `good first issue`, `help wanted`

`npm run typecheck` runs `tsc --noEmit` over plain JavaScript, reading types out
of JSDoc. No TypeScript ships, nothing is emitted, there is still no build step.
`jsconfig.json` currently scopes it to the pure layer.

Widening that `include` **one module at a time**, with the run clean at each
step, is a genuinely useful contribution that can be done in small pieces. Good
next candidates: `mesh.js`, `storage/zip.js`, `storage/mbrd.js`,
`import/artwork.js` — the modules that parse untrusted bytes, where a wrong type
is a real bug.

It has already paid for itself once: the first run found `web-graph.js` calling
`corners()` and `pointInItem()` without importing either, which threw out of
`threads()` and had silently stopped the relationship web drawing past its
spanning tree.

---

## 8. Grow the end-to-end set

**Labels:** `help wanted`

`tests/e2e/board.spec.js` has four cases: pan/zoom, add-select-delete-undo,
save → refresh → recover, and boots-with-a-clean-console. They are optional and
not in CI, deliberately.

Worth adding: **import by drag-and-drop**, **marquee select then drag**,
**Mobile layout on a phone viewport**, **export a `.mbrd` and open it again**.
That last one would be the first automated test of the format round-trip through
the real browser code path.

---

## 9. The audit's medium and low findings

**Labels:** `help wanted`, `performance`

`research/scalability-readability-audit-2026-07-27.md` closed all eight of its
high-leverage items. What remains is the medium/low list at the foot of it —
each is small, self-contained and already reasoned about.

Somebody should read that list and open one issue per finding, which is itself a
useful first contribution.

---

## 10. One decision that is not code

**Labels:** `docs`

**The `.mbrd` format is free to implement** (see `docs/mbrd-format.md`), and
there is an open question in that document about whether a board may ever
reference bytes it does not contain rather than embedding them. Three options
are written out and the trade is real: option 3 is the only one that keeps
"a board is one file you can email" true rather than usually true. None should be
built until the call is made — but the discussion is worth having in the open.

*(The licence question is settled: GPL-3.0-or-later. The reasoning is in the
README, and it is not up for re-litigation in an issue.)*
