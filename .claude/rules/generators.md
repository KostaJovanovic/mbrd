---
paths:
  - "tools/**"
  - "web/assets/img/**"
  - "desktop/icons/**"
---

# Generators

Moved out of the root `CLAUDE.md`, which points here.

Generators, run when their source changes:
`node tools/gen-formats.mjs` (→ `import/formats.ts`), `tools/gen-stickers.mjs`
(→ `stickers.svg`), `node tools/gen-wallpaper.mjs [name...]` (→ the Softish
wallpaper pieces in `web/assets/img/wallpaper/`, all but green-1, -4 and -5,
which are drawn by hand), `node tools/gen-patch-page.mjs` (→ `web/patch.html`),
`node tools/gen-desktop-icons.mjs` (`icon.svg` → `desktop/icons/`, the `.ico`,
`.icns` and PNG the three installers want), `node tools/gen-og.mjs`
(`tools/og.html` → `web/assets/img/og.png`, the link-preview card), `node
tools/gen-screenshots.mjs` (a demo board it packs itself → the two
`screenshot-*.png` that `manifest.json` and the JSON-LD name). Those last three
are the only generators that need an install, and it is `desktop/`'s: they go
through the sharp the shell already depends on, and the last two also need a
local Edge or Chrome. The screenshots are of the real app, so they need the dev
server up and a fresh `npm run build`. Their output is committed so nobody else
runs them.

The other `.mjs` under `tools/` are not build steps. `preset-oklch.mjs` and
`gen-tier-palettes.mjs` print numbers that were pasted into `tokens.css` by
hand; nothing regenerates from them and nothing should. `bench-compare.mjs`
and `grime-shots.mjs` are benches; each file's header says how to run it.
