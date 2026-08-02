# Third-party assets

Everything the app ships that someone else made, with where it came from and the
licence it carries. The app has no runtime dependencies and no build step, so
this list is fonts: the bundled `.woff2` faces under `web/assets/fonts/`. Each
family's full licence text sits beside the faces in that directory, and every
face is precached by `web/sw.js` (see `SHELL`), so the offline shell carries the
licence with the software it covers — which is condition 2 of the OFL.

| Family | Files | Source | Licence | Licence file |
| --- | --- | --- | --- | --- |
| Playfair | `playfair-latin.woff2`, `playfair-latin-ext.woff2`, `playfair-latin-italic.woff2`, `playfair-latin-ext-italic.woff2` | https://github.com/googlefonts/Playfair | SIL Open Font License 1.1 | `web/assets/fonts/playfair-OFL.txt` |
| Fraunces | `fraunces-latin.woff2`, `fraunces-latin-ext.woff2`, `fraunces-latin-italic.woff2`, `fraunces-latin-ext-italic.woff2` | https://github.com/undercasetype/Fraunces | SIL Open Font License 1.1 | `web/assets/fonts/fraunces-OFL.txt` |
| Geist | `geist-latin.woff2`, `geist-latin-ext.woff2` | https://github.com/vercel/geist-font | SIL Open Font License 1.1 | `web/assets/fonts/geist-OFL.txt` |
| Geist Mono | `geist-mono-latin.woff2` | https://github.com/vercel/geist-font | SIL Open Font License 1.1 | `web/assets/fonts/geist-OFL.txt` |

Geist and Geist Mono are one licence file because Vercel releases them from one
repository under one copyright statement, with both names reserved together.

Every face here is subset to Latin and Latin Extended rather than shipped whole,
and that is the only change made to any of them: all variation axes are intact,
including Playfair's `wdth`, which was briefly instanced out to save 312KB and
has been restored. Subsetting for a delivery format is what the OFL FAQ covers
under subsetting, and is how Google Fonts itself serves these families under
their own names. No outline was redrawn and no Reserved Font Name is used for
anything the original authors did not draw.
