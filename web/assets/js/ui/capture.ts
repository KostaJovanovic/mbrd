// Export from the board's own cards (research/export-from-dom-2026-09-21.md):
// each card built detached, settled in a hidden mount, frozen - every picture,
// canvas and sprite made a data: URL - dressed in the app's cascade, and drawn
// through a data: SVG foreignObject. Chromium only (Chrome, Edge, both shells):
// Safari and Firefox taint the canvas, canCapture() finds that once a session,
// and ui/snapshot.ts then draws every card with its painters, as it does the
// shelf thumbnail everywhere.

import { buildItem } from '../canvas/item-dom.ts';
import { board, bus } from '../state.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import {
  CAPTURE_CSS, cardSvg, familiesOf, inlineFace, inlineURLs, plainFamily, splitSheet, svgURL, urlsIn,
} from './capture-css.ts';
import type { Face } from './capture-css.ts';
import type { Item, ItemType } from '../board-model.ts';

/** Kinds the painters keep: a model is a WebGL frame no capture can read. */
const PAINTED: ReadonlySet<ItemType> = new Set<ItemType>(['model', 'ghost', 'gone']);
export const capturable = (it: Item) => !PAINTED.has(it.type);

/** How long a card is given to finish drawing itself before it is taken as it is. */
const SETTLE_MS = 2500;
/** The longest edge a picture inside a card is inlined at, whatever the export asks. */
const MAX_PICTURE = 4096;

const decode = async (url: string) => {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
};

const frame = () => new Promise<void>(ok => requestAnimationFrame(() => ok()));
const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));

const asData = (blob: Blob) => new Promise<string>((ok, no) => {
  const r = new FileReader();
  r.onload = () => (typeof r.result === 'string' ? ok(r.result) : no(new Error('not a data URL')));
  r.onerror = () => no(r.error);
  r.readAsDataURL(blob);
});

let probe: Promise<boolean> | null = null;

/**
 * Whether this engine leaves a canvas readable after drawing a foreignObject
 * SVG from a data: URL. One four-pixel draw, once a session. False on Safari
 * and Firefox (a SecurityError, or nothing drawn), and the export uses the
 * painters there - the one branch, in renderBoardCanvas().
 */
export function canCapture(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const img = await decode(svgURL('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">'
        + '<style>div{width:4px;height:4px;background:#00ff00}</style><foreignObject width="4" height="4">'
        + '<div xmlns="http://www.w3.org/1999/xhtml"></div></foreignObject></svg>'));
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(img, 0, 0);
      const [r, g, , a] = ctx.getImageData(1, 1, 1, 1).data;
      return g > 200 && r < 60 && a > 200;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** The cascade, read once per page: every sheet's faces, and the rest as one string. */
let cascade: Promise<{ faces: Face[], css: string }> | null = null;
function readCascade() {
  cascade ??= (async () => {
    const faces: Face[] = [];
    let css = '';
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const text = await (await fetch(link.href)).text();
      const cut = splitSheet(text, link.href);
      faces.push(...cut.faces);
      css += cut.rest + '\n';
    }
    return { faces, css: css + CAPTURE_CSS };
  })();
  return cascade;
}

/** Files already made data: URLs - fonts and sprites - by address. */
const inlined = new Map<string, Promise<string>>();
const inlineURL = (url: string) => {
  let p = inlined.get(url);
  if (!p) {
    p = fetch(url).then(r => r.blob()).then(asData);
    inlined.set(url, p);
  }
  return p;
};

const sprites = new Map<string, Promise<Document>>();
const spriteDoc = (url: string) => {
  let p = sprites.get(url);
  if (!p) {
    p = fetch(url).then(r => r.text()).then(t => new DOMParser().parseFromString(t, 'image/svg+xml'));
    sprites.set(url, p);
  }
  return p;
};

/**
 * The cascade one card is drawn in: the @font-face rules its text is set in,
 * the app's and the board's own, then the sheets with the pictures it shows
 * (a fence's cork, a sheet's grain) inlined and every other address emptied.
 */
async function dressFor(node: Element, faces: Face[], css: string): Promise<string> {
  const used = new Set<string>();
  const pictures = new Map<string, string>();
  for (const el of [node, ...node.querySelectorAll('*')]) {
    // The pseudo-elements too: a fence's cork is its ::before.
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      for (const f of familiesOf(cs.fontFamily)) used.add(f);
      for (const u of [...urlsIn(cs.backgroundImage), ...urlsIn(cs.maskImage)]) {
        if (!pictures.has(u)) pictures.set(u, await inlineURL(u).catch(() => ''));
      }
    }
  }
  const rules: string[] = [];
  for (const face of faces.filter(f => used.has(f.family))) {
    const urls = new Map<string, string>();
    try {
      for (const u of face.urls) urls.set(u, await inlineURL(u));
    } catch { continue; }
    const rule = inlineFace(face, urls);
    if (rule) rules.push(rule);
  }
  for (const spec of Array.isArray(board.settings.fonts) ? board.settings.fonts : []) {
    if (!used.has(plainFamily(spec.family))) continue;
    const blob = getAsset(spec.hash)?.blob;
    if (!blob) continue;
    const weight = spec.axes?.find(a => a.tag === 'wght');
    const range = weight ? `font-weight:${Math.max(1, weight.min)} ${Math.min(1000, weight.max)};`
      : spec.variable ? 'font-weight:1 1000;' : '';
    rules.push(`@font-face{font-family:${JSON.stringify(spec.family)};src:url("${await asData(blob)}");${range}}`);
  }
  for (const [u, data] of pictures) if (!data) pictures.delete(u);
  return rules.join('\n') + '\n' + inlineURLs(css, pictures);
}

/** The picture an <img> should carry at this size: the original where the card has one, scaled. */
async function pictureAt(img: HTMLImageElement, live: HTMLImageElement | undefined, perUnit: number) {
  const hires = img.dataset.hiresHash;
  const src = (hires && assetURL(hires)) || live?.currentSrc || live?.src || img.src;
  if (!src || src.startsWith('data:')) return src || '';
  const box = live ?? img;
  const want = Math.min(MAX_PICTURE, Math.ceil(Math.max(box.offsetWidth, box.offsetHeight, 1) * perUnit));
  const pic = await decode(src);
  const k = Math.min(1, want / Math.max(pic.naturalWidth, pic.naturalHeight, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pic.naturalWidth * k));
  c.height = Math.max(1, Math.round(pic.naturalHeight * k));
  c.getContext('2d')?.drawImage(pic, 0, 0, c.width, c.height);
  // WebP keeps a cut-out's transparency at a fraction of a PNG's size.
  return c.toDataURL('image/webp', 0.92);
}

/**
 * A url(...) inside an inline style, made a small data: URL - the blurred
 * haze behind a picture. Property by property through the CSSOM: a `style`
 * attribute written from script is what the page's CSP refuses.
 */
async function inlineStyleURLs(el: HTMLElement) {
  for (const prop of el.style) {
    const value = el.style.getPropertyValue(prop);
    if (!/url\(/.test(value)) continue;
    let out = value;
    for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      if (m[2].startsWith('data:')) continue;
      let data = 'none';
      try {
        const pic = await decode(m[2]);
        const k = Math.min(1, 256 / Math.max(pic.naturalWidth, pic.naturalHeight, 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(pic.naturalWidth * k));
        c.height = Math.max(1, Math.round(pic.naturalHeight * k));
        c.getContext('2d')?.drawImage(pic, 0, 0, c.width, c.height);
        data = `url("${c.toDataURL('image/webp', 0.8)}")`;
      } catch { /* left as none */ }
      out = out.split(m[0]).join(data);
    }
    el.style.setProperty(prop, out, el.style.getPropertyPriority(prop));
  }
}

/** One element's inline style onto another, through the CSSOM - see inlineStyleURLs(). */
function copyStyle(from: HTMLElement, to: HTMLElement) {
  for (const prop of from.style) {
    to.style.setProperty(prop, from.style.getPropertyValue(prop), from.style.getPropertyPriority(prop));
  }
}

/**
 * The copy of a settled card that an image can hold: nothing in it loads
 * anything. `live` is the settled mount the copy was taken from, read for
 * canvases' pixels and pictures' drawn sizes.
 */
async function freeze(copy: HTMLElement, live: HTMLElement, perUnit: number) {
  // A field's value is a property, not an attribute, and a copy would show
  // the default - a swatch's colour well came out black.
  const liveFields = [...live.querySelectorAll('input, textarea')];
  for (const [i, field] of [...copy.querySelectorAll('input, textarea')].entries()) {
    const from = liveFields[i];
    if (field instanceof HTMLTextAreaElement && from instanceof HTMLTextAreaElement) field.textContent = from.value;
    else if (field instanceof HTMLInputElement && from instanceof HTMLInputElement) {
      field.setAttribute('value', from.value);
      if (from.checked) field.setAttribute('checked', '');
    }
  }
  const liveImgs = [...live.querySelectorAll('img')];
  for (const [i, img] of [...copy.querySelectorAll('img')].entries()) {
    try { img.src = await pictureAt(img, liveImgs[i], perUnit); } catch { img.removeAttribute('src'); }
    for (const a of ['srcset', 'loading', 'decoding']) img.removeAttribute(a);
  }
  const liveCanvases = [...live.querySelectorAll('canvas')];
  for (const [i, canvas] of [...copy.querySelectorAll('canvas')].entries()) {
    const img = document.createElement('img');
    img.className = canvas.className;
    try { img.src = liveCanvases[i]?.toDataURL() ?? ''; } catch { /* a tainted canvas stays empty */ }
    canvas.replaceWith(img);
  }
  const liveVideos = [...live.querySelectorAll('video')];
  for (const [i, video] of [...copy.querySelectorAll('video')].entries()) {
    const img = document.createElement('img');
    img.className = video.className;
    const source = liveVideos[i];
    try {
      if (source && source.readyState >= 2) {
        const c = document.createElement('canvas');
        c.width = source.videoWidth;
        c.height = source.videoHeight;
        c.getContext('2d')?.drawImage(source, 0, 0);
        img.src = c.toDataURL('image/webp', 0.9);
      } else if (video.poster) {
        img.src = await inlineURL(video.poster);
      }
    } catch { /* no frame to hold */ }
    video.replaceWith(img);
  }
  for (const frameEl of copy.querySelectorAll('iframe')) frameEl.remove();
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) await inlineStyleURLs(el);
  for (const use of copy.querySelectorAll('use')) {
    const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    const at = href.indexOf('#');
    if (at <= 0) continue;
    const id = href.slice(at + 1);
    try {
      const sym = (await spriteDoc(new URL(href.slice(0, at), document.baseURI).href)).getElementById(id);
      const host = use.ownerSVGElement;
      if (!sym || !host) continue;
      let defs = host.querySelector(':scope > defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        host.prepend(defs);
      }
      if (!defs.querySelector(`#${CSS.escape(id)}`)) defs.append(document.importNode(sym, true));
      use.setAttribute('href', '#' + id);
    } catch { /* the icon is left out */ }
  }
}

/** Mount a detached card where nobody sees it, and wait for it to finish drawing. */
async function settle(it: Item): Promise<HTMLElement | null> {
  const world = document.getElementById('world');
  if (!world) return null;
  const el = buildItem(it, '0', false);
  el.dataset.capture = '';
  el.style.cssText += `;position:absolute;left:-200000px;top:0;width:${it.w}px;height:${it.h}px;visibility:hidden;pointer-events:none`;
  el.style.setProperty('--half-min', `${Math.min(it.w, it.h) / 2}px`);
  el.style.setProperty('--half-w', `${it.w / 2}px`);
  el.style.setProperty('--half-h', `${it.h / 2}px`);
  world.append(el);
  // The title's typography is written onto the mounted card by
  // ui/mobile-header.ts; the board's own copy of it is taken as it stands.
  if (it.type === 'title') {
    const shown = document.querySelector<HTMLElement>(`#world .item[data-id="${CSS.escape(it.id)}"]:not([data-capture]) .title-name`);
    const mine = el.querySelector<HTMLElement>('.title-name');
    if (shown && mine) copyStyle(shown, mine);
  }
  const deadline = performance.now() + SETTLE_MS;
  await frame();
  for (;;) {
    const pending = [...el.querySelectorAll('img')].filter(i => !i.getAttribute('src') || !i.complete);
    if (!pending.length || performance.now() > deadline) break;
    await Promise.race([Promise.all(pending.map(i => i.decode().catch(() => {}))), sleep(150)]);
  }
  try { await document.fonts?.ready; } catch { /* no font manager */ }
  await frame();
  await frame();
  return el;
}

/** Decoded captures, by what the card is and how it is being drawn. An SVG draws at any size. */
const cache = new Map<string, HTMLImageElement>();
const CACHE_MAX = 400;
let cacheWired = false;

const keyOf = (it: Item, perUnit: number) => {
  const root = document.documentElement;
  const look = [...root.attributes].map(a => `${a.name}=${a.value}`).join(';');
  // Pictures are inlined at the export's resolution, so a much sharper export is a new capture.
  return `${JSON.stringify(it)}|${look}|${board.title}|${Math.ceil(Math.log2(Math.max(perUnit, 0.01)))}`;
};

/**
 * The card drawn from its own DOM, centred on the context's origin at `w` x
 * `h` pixels. False when it could not be, and the painter draws it instead.
 */
export async function drawCaptured(ctx: CanvasRenderingContext2D, it: Item, w: number, h: number): Promise<boolean> {
  if (!capturable(it) || !(it.w > 0) || !(it.h > 0) || !await canCapture()) return false;
  if (!cacheWired) {
    bus.on('board:load', () => cache.clear());
    cacheWired = true;
  }
  const perUnit = w / it.w;
  const key = keyOf(it, perUnit);
  let img = cache.get(key);
  if (!img) {
    const live = await settle(it);
    if (!live) return false;
    try {
      const { faces, css } = await readCascade();
      const copy = live.cloneNode(true);
      if (!(copy instanceof HTMLElement)) return false;
      copy.removeAttribute('data-capture');
      await freeze(copy, live, perUnit);
      const dressed = await dressFor(live, faces, css);
      const root = document.documentElement;
      const svg = cardSvg({
        w: it.w, h: it.h,
        rootAttrs: [...root.attributes].filter(a => a.name.startsWith('data-') || a.name === 'style' || a.name === 'lang')
          .map(a => [a.name, a.value]),
        bodyClass: document.body.className,
        css: dressed,
        card: new XMLSerializer().serializeToString(copy),
      });
      img = await decode(svgURL(svg));
    } catch {
      return false;
    } finally {
      live.remove();
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? '');
    cache.set(key, img);
  }
  try {
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return true;
  } catch {
    return false;
  }
}
