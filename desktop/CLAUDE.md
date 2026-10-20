# desktop/CLAUDE.md

Loaded when working under `desktop/`. The root `CLAUDE.md` holds how to launch
and rebuild the shell; this is what breaks silently inside it.

**The title bar is a page of its own, and the package must carry it.**
`desktop/chrome/` holds the bar and its menus. `desktop/scripts/build.mjs`
builds them into `desktop/dist/chrome/`, and `desktop/protocol.ts` serves only
the names in `CHROME_FILES`, under `/__chrome/`. A package missing them opens
with no title bar, so `files:` in `desktop/electron-builder.yml` ships `dist/**`,
`tests/desktop-package.test.js` holds that and every name in `CHROME_FILES`
against a source the build turns into it, and the release job looks inside each
packed `app.asar` for `dist/chrome/titlebar.html`. A new chrome file is an entry
in `CHROME_FILES` and a source `build.mjs` builds or copies.

`desktop/portable/` is the unpacked app plus the `portable` marker
`installer.nsh`'s Portable branch writes. There is no portable *target*, only
that page inside the one Setup.exe. `main.ts` reads the marker before `ready` and
puts `userData` in `portable/data`, which is why **`portable/data/` survives a
rebuild and everything else in there does not**. Not `desktop/dist/`, which is
the two esbuild bundles. See `desktop/scripts/portable.mjs`.
