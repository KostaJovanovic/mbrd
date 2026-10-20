---
paths:
  - "web/lab*.html"
  - "web/assets/js/ui/pigments.ts"
  - "web/assets/js/ui/sound-lab.ts"
  - "web/assets/js/ui/clean/grime-lab.ts"
---

# `web/lab.html`, `web/lab-sound.html` and `web/lab-grime.html` are benches, not pages of the site

Moved out of the root `CLAUDE.md`.

Each has its own bundle (`npm run dev:lab`, `npm run dev:sound`,
`npm run dev:grime`), its own
colours, none of `tokens.css`, because a bench rendering at the current whimsy tier
makes a wrong colour and a warmly displayed one look identical. `noindex` rather
than a `robots.txt` Disallow (a Disallow stops the fetch, which stops the
directive being read), absent from `sitemap.xml` and from `SHELL`.
