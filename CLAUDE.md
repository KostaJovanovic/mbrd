# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Read these first

- **[`docs/architecture.md`](docs/architecture.md)** — the canonical description
  of how the app is put together: the layering graph, `state.js` as the only
  door, the command surface, coordinates and culling, the two layouts, assets
  and persistence, the stylesheet order, and the invariants the tests enforce.
  It is the single source of truth; this file does not repeat it.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to run it, how to test it, the
  five invariants that are easy to break by accident, and where a given kind of
  change belongs.
- **[`AGENTS.md`](AGENTS.md)** — style, naming, commit and PR conventions.

Module headers in this codebase carry the *why*, often at length. **Read the top
of a file before changing it**, and keep that convention when adding one.

## Commands

```bash
npm test                          # node --test over tests/ — no install, no deps
node --test tests/state.test.js   # one file
node --test --test-name-pattern "undo" tests/state.test.js   # one test
python serve.py [port]            # dev server on 6273; server.bat is the Windows launcher
node tools/gen-formats.mjs [path-to-file-analyser]   # regenerate import/formats.js
save.bat                          # bump version stamps, commit, optionally push
```

Syntax checks worth running on a change: `node --check` on touched `.js`,
`python -m py_compile` on `serve.py` / `qr.py`.

There is no bundler, no build step and no runtime dependency. The browser loads
the ES modules under `web/` directly — an edit is one refresh away.
`package.json` exists only to run the tests; nothing in `tests/` is served.

## Things worth saying twice

- **Do not edit `web/assets/js/version.js` or the `VERSION` line in
  `web/sw.js`.** `save.bat` stamps both by regex; reformatting either line
  breaks the stamp silently.
- **Do not hand-edit `web/assets/js/import/formats.js`.** It is generated.
- **Do not split `canvas/input.js`.** One pipeline, exactly one active gesture.
- **A new module must not touch `document` at import time** — export an
  `init*()`. Exactly three modules are exempt and `tests/imports.test.js` lists
  them.
- **A new user-facing action is an entry in `cmds`** (`commands.js`), not a
  second event listener. A new setting is one entry in `ui/settings-schema.js`.
- Call out `.mbrd` schema, generated-catalog or service-worker cache changes
  explicitly when reporting work.

## Where the reasoning lives

`docs/` holds the specifications: [`mbrd-format.md`](docs/mbrd-format.md),
[`layout-settings.md`](docs/layout-settings.md),
[`browser-support.md`](docs/browser-support.md).

`research/` holds why things are the way they are, in three tiers — open work at
the top level, carried-out work in `old/`, speculative work in `future/`. See
[`research/README.md`](research/README.md); nothing in `old/` is authoritative,
and if it disagrees with the code, the code is right.

`window.mbrd` is a deliberate console handle (`mbrd.board`, `mbrd.cmds.fit()`,
`mbrd.vp`).
