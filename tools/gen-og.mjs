/**
 * Draw web/assets/img/og.png - the 1200x630 card every chat app shows when
 * somebody pastes a link to mbrd.
 *
 *   node tools/gen-og.mjs            # needs devDependencies + `npx playwright install chromium`
 *
 * Why a script and not a hand-made image. The card is the app's own paper,
 * pigment and display face, and all three of those live in tokens.css and
 * assets/fonts. An exported PNG made once in a drawing tool is a copy of them
 * frozen at a date, and the day the palette moves the card is quietly wrong in
 * every thread it was ever pasted into. This reads the real values, so
 * regenerating is the fix and there is only one place to change.
 *
 * The output is committed. Nothing at run time or in CI depends on this file;
 * it is here so the PNG is reproducible rather than mysterious.
 *
 * The dimensions are not a preference. 1200x630 is the size Facebook, LinkedIn,
 * Slack and Discord all size their large card to, and 1.91:1 is the ratio X
 * crops summary_large_image to. Change it and every one of them re-crops.
 *
 * Cropping is also why the layout keeps clear of the edges: a small unfurl in
 * Slack and the square thumbnail in a WhatsApp reply both take a centre crop,
 * so anything that has to survive lives inside the middle band. The wordmark
 * and the sentence under it do; the cards drift outward on purpose and are the
 * part that is meant to be cut.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const OUT = path.join(WEB, 'assets', 'img', 'og.png');

const WIDTH = 1200;
const HEIGHT = 630;

/** An absolute file: URL for something under web/, since the card is rendered
 *  from a temp file and nothing relative would resolve. */
const asset = rel => pathToFileURL(path.join(WEB, rel)).href;

/*
 * The tokens, copied deliberately rather than read.
 *
 * tokens.css states these inside `:root` alongside nine other looks and a
 * whimsy axis that rewrites half of them; picking the default set back out of
 * it needs a CSS parser, and a card generator is not the place for one. What is
 * here is the middle of the axis in the default palette - the look a first
 * visitor sees, which is the only look the card can honestly show.
 *
 * The cost of copying is that they can drift, so: if the terracotta or the
 * paper changes in tokens.css, change them here and re-run. Nothing will tell
 * you.
 */
const T = {
  paper: '#faf8f3',
  ink: '#31261b',
  ink2: '#615141',
  ink3: '#968371',
  rule: '#dad7cd',
  accent: '#b94900',
  displayWeight: 300,
};

const card = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* The two faces of the default look, loaded from the repo's own files. Only
     the latin subsets - every glyph on this card is ASCII. */
  @font-face {
    font-family: 'Fraunces';
    font-weight: 100 900;
    src: url('${asset('assets/fonts/fraunces-latin.woff2')}') format('woff2-variations');
  }
  @font-face {
    font-family: 'Geist';
    font-weight: 100 900;
    src: url('${asset('assets/fonts/geist-latin.woff2')}') format('woff2-variations');
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    background: ${T.paper};
    color: ${T.ink};
    font-family: 'Geist', sans-serif;
    position: relative;
    overflow: hidden;
  }

  /* The sheet, in the same three layers base.css builds it from: two soft
     blooms, a vignette, and the stock's own tooth on top. Without the grain the
     card reads as a flat swatch of beige, which is the one thing the app's
     surface is not. */
  #paper {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(120% 90% at 18% 8%, #fffdf8 0%, transparent 55%),
      radial-gradient(100% 80% at 88% 96%, #f3eee2 0%, transparent 60%),
      ${T.paper};
  }
  #grain {
    position: absolute;
    inset: 0;
    background-image: url('${asset('assets/img/paper-grain.webp')}');
    background-size: 512px 512px;
    mix-blend-mode: multiply;
    opacity: 0.5;
  }
  /* Darkened corners, so the light reads as falling on the sheet rather than
     being painted into it. */
  #vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(120% 100% at 50% 45%, transparent 55%, rgba(49, 38, 27, 0.09) 100%);
  }

  /* --- the board ------------------------------------------------------- */
  /* Three cards and the threads between them: the app's signature, and the
     same figure the splash animates. Static here, and arranged so the run of
     them leads the eye from the wordmark out toward the right edge - where the
     crop will take the last one, which is the point. A board that ends inside
     the frame looks finite. */
  #board { position: absolute; inset: 0; }
  .card {
    position: absolute;
    background: #fffdf7;
    border: 1px solid ${T.rule};
    border-radius: 3px;
    box-shadow:
      0 1px 2px rgba(49, 38, 27, 0.07),
      0 10px 26px rgba(49, 38, 27, 0.10);
  }
  /* Something on each card, or they read as blank rectangles rather than as
     things somebody put there. Ruled lines and one image block - the two
     commonest items on a real board. */
  .lines { position: absolute; inset: 16px; display: flex; flex-direction: column; gap: 9px; }
  .lines i { display: block; height: 6px; border-radius: 3px; background: ${T.rule}; }
  .lines i:nth-child(2) { width: 78%; }
  .lines i:nth-child(3) { width: 90%; }
  .lines i:nth-child(4) { width: 62%; }
  .swatch { position: absolute; inset: 14px; border-radius: 2px; }

  .thread {
    position: absolute;
    height: 2px;
    background: ${T.accent};
    opacity: 0.8;
    transform-origin: 0 50%;
    border-radius: 2px;
  }
  /* The pin at each end of a thread. Small, and the reason the threads do not
     look like stray rules. */
  .thread::before, .thread::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 9px; height: 9px;
    margin-top: -4.5px;
    border-radius: 50%;
    background: ${T.accent};
  }
  .thread::before { left: -4px; }
  .thread::after { right: -4px; }

  /* --- the words ------------------------------------------------------- */
  #words {
    position: absolute;
    left: 88px;
    top: 50%;
    transform: translateY(-50%);
    width: 620px;
  }
  h1 {
    font-family: 'Fraunces', serif;
    font-weight: ${T.displayWeight};
    font-size: 148px;
    line-height: 0.9;
    letter-spacing: 0.02em;
    color: ${T.ink};
  }
  /* The full stop is the mark's, and it is terracotta for the same reason the
     app's is: it is the only pigment on an otherwise monochrome page. */
  h1 span { color: ${T.accent}; }
  .sub {
    margin-top: 22px;
    font-size: 17px;
    font-weight: 500;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: ${T.ink3};
  }
  .say {
    margin-top: 20px;
    font-size: 30px;
    line-height: 1.32;
    font-weight: 400;
    color: ${T.ink2};
    max-width: 17ch;
  }
</style>
</head>
<body>
  <div id="paper"></div>
  <div id="grain"></div>

  <div id="board">
    <!-- Angles and offsets are hand-placed. An arrangement function would be
         the app's job; this is one picture, and the numbers below are what
         looked right at 1200x630. -->
    <!-- Both threads run card-edge to card-edge and the cards paint over them,
         so each one emerges from under one card and disappears under the next.
         That is the only reason the endpoints are where they are: a pin that
         lands in open paper reads as a stray dot rather than as a fixing, which
         is exactly what the first pass of this card did. Move a card and the
         thread that reaches it has to move with it. -->
    <div class="thread" style="left: 792px; top: 236px; width: 132px; transform: rotate(15deg);"></div>
    <div class="thread" style="left: 800px; top: 470px; width: 141px; transform: rotate(-22.9deg);"></div>

    <div class="card" style="left: 690px; top: 118px; width: 172px; height: 212px; transform: rotate(-5.5deg);">
      <div class="lines"><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="card" style="left: 900px; top: 262px; width: 196px; height: 150px; transform: rotate(3.2deg);">
      <div class="swatch" style="background: ${T.accent}; opacity: 0.85;"></div>
    </div>
    <div class="card" style="left: 770px; top: 456px; width: 164px; height: 168px; transform: rotate(-2.4deg);">
      <div class="lines"><i></i><i></i><i></i><i></i></div>
    </div>
    <!-- The fourth is mostly outside the frame. It is the one that says the
         board keeps going. -->
    <div class="card" style="left: 1082px; top: 62px; width: 180px; height: 150px; transform: rotate(6deg);">
      <div class="lines"><i></i><i></i><i></i></div>
    </div>
  </div>

  <div id="vignette"></div>

  <div id="words">
    <h1>mbrd<span>.</span></h1>
    <div class="sub">Plan it, see it. Sorted.</div>
    <div class="say">An infinite freeform moodboard in your browser.</div>
  </div>
</body>
</html>
`;

const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mbrd-og-')), 'card.html');
await fs.writeFile(tmp, card, 'utf8');

const browser = await chromium.launch();
try {
  // deviceScaleFactor 1: the card is authored at its final size, and a 2x
  // render downsampled by the platform is softer than one drawn at 1x. The
  // scrapers do not want a retina asset, they want 1200x630.
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
  // Both faces are `font-weight: 100 900` variable files with no font-display,
  // so the block period applies and text would screenshot in the fallback if we
  // shot immediately. This is the wait that matters.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT, type: 'png' });
} finally {
  await browser.close();
  await fs.rm(path.dirname(tmp), { recursive: true, force: true });
}

const { size } = await fs.stat(OUT);
console.log(`wrote ${path.relative(process.cwd(), OUT)} - ${WIDTH}x${HEIGHT}, ${(size / 1024).toFixed(1)} KB`);
// Nothing enforces this, so it is said rather than checked: several scrapers
// give up above 5 MB and X above 5 MB for PNG. A card this flat has no business
// coming anywhere near it, and a sudden jump means the grain layer changed.
if (size > 1024 * 1024) console.warn('warning: over 1 MB, which is large for a flat card - check the grain layer');
