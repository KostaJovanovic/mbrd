<!-- Thanks. CONTRIBUTING.md has the full picture; this is the short version. -->

## What changes for the person using the board

<!-- The user-visible result, in a sentence or two. Not the diff. -->

## How I checked it

<!--
The suite is not a substitute for looking. Say what you actually exercised.
For canvas or storage changes that usually means pan/zoom, selection,
save/open, refresh recovery, and a clean browser console.
-->

- [ ] `npm test` passes
- [ ] `node --check` on each `.js` I changed
- [ ] Exercised in a browser (which one: )
- [ ] Checked on a phone via the LAN URL — *touch-facing or responsive changes*

## Screenshot or recording

<!-- Required for anything visual. A short clip beats four stills for a gesture. -->

## Things with consequences beyond the diff

Tick anything this touches, so it gets the right kind of review:

- [ ] The **`.mbrd` schema** — `docs/mbrd-format.md` updated, and older files still open
- [ ] The **generated format catalog** — regenerated with `node tools/gen-formats.mjs`, not hand-edited
- [ ] The service worker's **`SHELL`** — every new shipped asset is listed
- [ ] A **new bundled font** — licence file beside it, and a row in `THIRD-PARTY.md`
- [ ] A **new module** — placed in the layering graph and added to `tests/layers.test.js`
- [ ] Something that **reaches the network** — there are three such modules today; say why this is a fourth
- [ ] A **dev dependency** in `package.json` — the app itself still has none

## Not touched

- [ ] I have not edited `web/assets/js/version.js` or the `VERSION` line in `web/sw.js` — those are stamped at release
