// The text half of the export-from-DOM capture (ui/capture-css.ts): what of
// the cascade a card carries, and the SVG it is drawn through. The drawing
// half needs a browser and is checked by research/export-trace/export.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitSheet, inlineFace, inlineURLs, urlsIn, familiesOf, plainFamily, cardSvg, svgURL, boardSvg,
} from '../web/assets/js/ui/capture-css.ts';

const BASE = 'https://mbrd.test/assets/css/fonts.css';

test('a sheet gives up its faces, with their files resolved, and keeps the rest', () => {
  const { faces, rest } = splitSheet(`
    /* a comment with url(nothing.png) */
    @font-face { font-family: "Fraunces"; src: url("../fonts/fraunces.woff2") format("woff2"); }
    @font-face { font-family: Inter; src: url(data:font/woff2;base64,AAAA); }
    .a { background: url("../img/cork-board.webp"); color: red; }
    #world { filter: url(#mbrd-sim-deutan); }
  `, BASE);
  assert.equal(faces.length, 2);
  assert.equal(faces[0].family, 'fraunces');
  assert.deepEqual(faces[0].urls, ['https://mbrd.test/assets/fonts/fraunces.woff2']);
  assert.deepEqual(faces[1].urls, []);
  assert.ok(!rest.includes('@font-face'));
  assert.ok(rest.includes('url("https://mbrd.test/assets/img/cork-board.webp")'));
  assert.ok(rest.includes('filter: none'));
  assert.ok(!rest.includes('nothing.png'));
});

test('a face is inlined only when every file it loads is to hand', () => {
  const { faces } = splitSheet('@font-face{font-family:X;src:url(a.woff2),url(b.woff2)}', BASE);
  const a = 'https://mbrd.test/assets/css/a.woff2', b = 'https://mbrd.test/assets/css/b.woff2';
  assert.equal(inlineFace(faces[0], new Map([[a, 'data:A']])), null);
  const rule = inlineFace(faces[0], new Map([[a, 'data:A'], [b, 'data:B']]));
  assert.ok(rule.includes('url("data:A")') && rule.includes('url("data:B")'));
});

test('a card carries the pictures it shows and no address it would fail to load', () => {
  const css = '.f{background:url("https://h/cork.webp")} .g{background:url("https://h/grain.webp")} .d{mask:url(data:x)}';
  const out = inlineURLs(css, new Map([['https://h/cork.webp', 'data:image/webp;base64,CC']]));
  assert.ok(out.includes('url("data:image/webp;base64,CC")'));
  assert.ok(out.includes('.g{background:none}'));
  assert.ok(out.includes('url(data:x)'));
});

test('the files a computed background reads, without data: or fragments', () => {
  assert.deepEqual(urlsIn('url("https://h/a.webp"), linear-gradient(red, blue), url(data:x), url(#f)'), ['https://h/a.webp']);
  assert.deepEqual(urlsIn('none'), []);
});

test('families are compared as the computed style and the descriptor both write them', () => {
  assert.deepEqual(familiesOf('"Playfair", Piazzolla, Georgia, serif'), ['playfair', 'piazzolla', 'georgia', 'serif']);
  assert.equal(plainFamily(" 'Fraunces' "), 'fraunces');
});

test('the SVG wears the document attributes and refuses a sheet that would end its CDATA', () => {
  const svg = cardSvg({
    w: 240, h: 180, rootAttrs: [['data-whimsy', '0'], ['style', '--accent: "a&b"']],
    bodyClass: 'is-x', css: '.a{}', card: '<div class="item"></div>',
  });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180"'));
  assert.ok(svg.includes(' data-whimsy="0"'));
  assert.ok(svg.includes(' style="--accent: &quot;a&amp;b&quot;"'));
  assert.ok(svg.includes('<![CDATA[.a{}]]>'));
  assert.ok(svg.includes('<div id="viewport"><div id="world"><div class="item"></div></div></div>'));
  assert.throws(() => cardSvg({ w: 1, h: 1, rootAttrs: [], bodyClass: '', css: 'a{content:"]]>"}', card: '' }));
  assert.ok(svgURL('<svg/>').startsWith('data:image/svg+xml;charset=utf-8,%3Csvg'));
});

test('a board SVG is sized in millimetres, drawn in world units, ground first and cards in order', () => {
  const svg = boardSvg({
    w: 1000, h: 500, mmW: 250, mmH: 125, rootAttrs: [['data-whimsy', '2']], bodyClass: '', css: '.a{}',
    ground: 'data:image/jpeg;base64,GG',
    cards: [
      { x: 100, y: 120, w: 200, h: 100, turn: 0, markup: '<div class="item" data-id="a"></div>' },
      { x: 500, y: 250, w: 80, h: 80, turn: -12.3456, picture: 'data:image/png;base64,PP' },
      { x: 0, y: 0, w: 10, h: 10, turn: 0 },
    ],
  });
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="250mm" height="125mm" viewBox="0 0 1000 500" data-whimsy="2">'));
  const ground = svg.indexOf('href="data:image/jpeg;base64,GG"');
  const first = svg.indexOf('data-id="a"');
  const second = svg.indexOf('href="data:image/png;base64,PP"');
  assert.ok(ground > 0 && ground < first && first < second);
  assert.ok(svg.includes('<g transform="translate(100 120)"><svg x="-100" y="-50" width="200" height="100" overflow="visible">'));
  assert.ok(svg.includes('<g transform="translate(500 250) rotate(-12.35)"><image x="-40" y="-40" width="80" height="80"'));
  assert.equal((svg.match(/<g /g) || []).length, 2, 'a card with neither markup nor picture is left out');
});
