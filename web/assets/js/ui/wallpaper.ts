// The wallpaper (research/wallpaper-graphics-2026-10-20.md): pieces that come
// in from the window's left and right edges, chosen and toned by the board's
// palette, fixed to the window under the paper grain. On at Softish unless
// turned off, off at Middle and Harsh unless turned on. The arithmetic is
// wallpaper-pieces.ts; this reads the page, owns #wallpaper, and takes a board's
// own picture in. initWallpaper() wires it; nothing touches document at import.

import { board, bus, commit, setSetting, notUsersBoard } from '../state.ts';
import { oklch, type OKLCh } from '../color.ts';
import { toast } from '../notify.ts';
import { addFile, assetURL, derivedFile, getAsset } from '../storage/assets.ts';
import { currentBoardId } from '../storage/storage.ts';
import { surface, surfaceToPicture, type Surface } from '../canvas/surface.ts';
import { cutout, matteAvailable } from '../canvas/matte.ts';
import { ask } from './dialog.ts';
import { edgeShare, familyOf, pieceByName, tierSwitch, pieceFor, pieceURL, wallpaperTones, PIECES, TONES, type Family } from './wallpaper-pieces.ts';
import type { Wallpaper } from '../board-model.ts';
import { BASE_ZOOM, onSmallScreen, type Viewport } from '../canvas/viewport.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** How long a side takes to leave; matches .wp-side.is-leaving in wallpaper.css. */
const LEAVE_MS = 520;
/** The id of the filter that tones a board's own picture (see paintTones()). */
const TONE_FILTER = 'wp-tone';
/** The long edge an upload is kept at. An edge piece never needs more. */
const KEEP_EDGE = 1600;
/** Alpha below this is background, when an upload is cropped to its subject. */
const CROP_ALPHA = 16;

let host: HTMLElement | null = null;
let funcs: SVGElement[] = [];
/** What is on the edges now, as a key: `green-3`, `own:<hash>:<tone>`, or ''. */
let shown = '';
/** The sides on screen, so a swap can send exactly those out. */
let sides: HTMLElement[] = [];
/** The board's seed for the pick, read from its library id on each load. */
let seed = '';
let queued = 0;
/** Counts refreshes, so one that awaited a fetch does not undo a newer one. */
let gen = 0;
/** A picture being decided on, shown in place of the board's while it is asked about. */
let trial: { url: string, tone: boolean } | null = null;
const markup = new Map<string, Promise<SVGSVGElement | null>>();

/** One piece chosen by hand over the palette's pick, as `pink-1`, or '' for
 *  the palette's: under Settings → Debug, and the board's, in its wallpaper
 *  record, so a new board starts from the palette's pick. It was per device,
 *  and every board opened after a choice wore it. A name this version has no
 *  piece for reads as the palette's. The tones stay the palette's either way. */
export function chosenWallpaper(): string {
  const name = board.wallpaper.piece ?? '';
  return pieceByName(name) ? name : '';
}

/** The 'settings' event this sends is what repaints. */
export function setChosenWallpaper(name: string) {
  setSetting('wallpaper', { ...board.wallpaper, piece: pieceByName(name) ? name : null });
}

export function initWallpaper(viewport: Viewport) {
  host = document.getElementById('wallpaper');
  if (!host) return;
  view = viewport;
  view.onChange(() => placeSides());
  host.append(toneFilter());
  const root = document.documentElement;
  new MutationObserver(schedule).observe(root, {
    attributes: true,
    attributeFilter: ['data-whimsy', 'data-palette', 'data-scheme', 'data-board-mode', 'style', 'class'],
  });
  bus.on('settings', (key: unknown) => { if (key === 'wallpaper' || key === 'appearance') schedule(); });
  bus.on('board:load', () => { seed = ''; schedule(); });
  // A swap held while the sidebar covered the screen (swap()) runs once it has
  // slid away, so the pieces come in where they can be seen.
  const panel = document.getElementById('sidebar');
  if (panel) {
    new MutationObserver(() => {
      if (!panel.classList.contains('is-open')) setTimeout(schedule, slideOutMs(panel));
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  addEventListener('resize', () => { placePivots(); placeSides(true); }, { passive: true });
  phoneShaped();
  phoneQuery?.addEventListener('change', schedule);
  schedule();
}

/** One refresh per frame, however many changes asked for it. */
function schedule() {
  if (queued) return;
  queued = requestAnimationFrame(() => { queued = 0; refresh().catch(() => {}); });
}

/**
 * A window the shape of a phone, either way up: taller than 3:5, or wider than
 * 5:3 and no more than 500px high. No wallpaper there at all, and no rows for
 * it in the panel: the edges are the board's. Matches wallpaper.css.
 */
const PHONE_SHAPE = '(max-aspect-ratio: 3/5), (min-aspect-ratio: 5/3) and (max-height: 500px)';
let phoneQuery: MediaQueryList | null = null;

export function phoneShaped(): boolean {
  if (typeof matchMedia !== 'function') return false;
  phoneQuery ??= matchMedia(PHONE_SHAPE);
  return phoneQuery.matches;
}

/** Whether the pieces belong on screen at all: the current tier's switch is on. */
function wanted(w: Wallpaper) {
  const root = document.documentElement;
  const key = tierSwitch(root.dataset.whimsy);
  return !!key && w[key] && root.dataset.boardMode !== 'mobile' && !phoneShaped();
}

async function refresh() {
  if (!host) return;
  const mine = ++gen;
  const w = board.wallpaper;
  // A look change cross-fades the page's colours for --dur-palette (.is-fading,
  // tokens.css; .is-reshaping for a new tier). The tones follow the fade frame
  // by frame, and the pieces swap at its start, as the colours begin to move:
  // wallpaper.css exempts their transitions from the rule that holds every
  // other one at 0s for the length of it.
  const { classList } = document.documentElement;
  const fading = classList.contains('is-fading') || classList.contains('is-reshaping');
  if (phoneShaped() || (!wanted(w) && !trial)) { swap('', null); return; }
  const tones = readTones();
  if (!tones) return;
  paintTones(tones.values);
  if (fading) followFade();
  // A board's own picture, or the one being asked about, wins over the pieces.
  const own = trial ?? (w.asset && getAsset(w.asset) ? { url: assetURL(w.asset) || '', tone: w.tone } : null);
  if (own?.url) {
    const key = `own:${own.url}:${own.tone}`;
    if (key !== shown) swap(key, [{ el: ownPicture(own.url, own.tone), pivot: null }]);
    return;
  }
  if (!seed) seed = await currentBoardId().catch(() => 'board');
  if (mine !== gen) return;
  const chosen = pieceByName(chosenWallpaper());
  const piece = chosen ? await firstPiece(chosen.family, chosen.n) : await firstPiece(tones.family, pieceFor(seed, tones.family));
  if (mine !== gen) return;
  if (!piece) { swap('', null); return; }
  if (piece.key !== shown) swap(piece.key, partsOf(piece.svg));
}

let following = 0;

/**
 * The tones, every frame of a look change: the colours move without an
 * attribute saying so. A loop of its own rather than a refresh a frame, which
 * would start a new pick each frame and drop the one waiting on its file.
 */
function followFade() {
  if (following) return;
  const step = () => {
    const { classList } = document.documentElement;
    if (!classList.contains('is-fading') && !classList.contains('is-reshaping')) { following = 0; return; }
    const tones = readTones();
    if (tones) paintTones(tones.values);
    following = requestAnimationFrame(step);
  };
  following = requestAnimationFrame(step);
}

/** The board's pick, or the next arrangement in its family that loads. */
async function firstPiece(family: Family, n: number) {
  const count = PIECES[family];
  for (let i = 0; i < count; i++) {
    const at = ((n - 1 + i) % count) + 1;
    const svg = await pieceSVG(pieceURL(family, at));
    if (svg) return { key: `${family}-${at}`, svg };
  }
  return null;
}

/** One arrangement's markup, fetched once a session and parsed detached. */
function pieceSVG(url: string): Promise<SVGSVGElement | null> {
  let got = markup.get(url);
  if (!got) {
    got = fetch(url).then(r => (r.ok ? r.text() : '')).then(parsePiece).catch(() => null);
    markup.set(url, got);
  }
  return got;
}

/**
 * The file as an <svg> this document can hold. Our own files, but held to their
 * contract anyway (tests/wallpaper.test.js): no script, no foreign content, no
 * style, no handlers, no reference out of the file.
 */
function parsePiece(text: string): SVGSVGElement | null {
  if (!text) return null;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!(svg instanceof SVGSVGElement) || doc.querySelector('parsererror')) return null;
  // style goes too: a piece's own is preview colours, and would paint the whole page.
  for (const el of svg.querySelectorAll('script, foreignObject, style, image, a')) el.remove();
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    // A copy: `attributes` is live, and removing from it mid-walk skips the next one.
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || name === 'style' || (/href$/i.test(name) && !value.startsWith('#'))) el.removeAttribute(name);
    }
  }
  svg.setAttribute('preserveAspectRatio', 'xMinYMid slice');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return document.importNode(svg, true);
}

/** A board's own picture as the piece on one side. */
function ownPicture(url: string, tone: boolean): HTMLElement {
  const img = document.createElement('img');
  img.className = 'wp-own';
  img.alt = '';
  img.decoding = 'async';
  img.src = url;
  if (tone) img.classList.add('is-toned');
  return img;
}

/** One piece of an arrangement: what is drawn, and the point it turns about. */
type Part = { el: Node, pivot: [number, number] | null };

/**
 * An arrangement as the pieces that move on their own: each top-level
 * `g.wp-item` in a copy of the file holding only it and the shared <defs>, so
 * each is a layer of its own the compositor can slide and turn. A file with
 * none moves as one.
 */
function partsOf(svg: SVGSVGElement): Part[] {
  const items = [...svg.children].filter(el => el.localName === 'g' && el.classList.contains('wp-item'));
  // A copy either way: the parsed file is kept for the next board that wants it.
  if (!items.length) return [{ el: svg.cloneNode(true), pivot: null }];
  return items.map(item => {
    const copy = document.createElementNS(SVG_NS, 'svg');
    for (const { name, value } of svg.attributes) copy.setAttribute(name, value);
    for (const child of svg.children) if (child.localName === 'defs') copy.append(child.cloneNode(true));
    copy.append(item.cloneNode(true));
    const [x, y] = (item.getAttribute('data-pivot') || '').split(/[\s,]+/).map(Number);
    return { el: copy, pivot: Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null };
  });
}

let copies = 0;

/**
 * Ids of its own for one copy of a piece. The same file is in the page once
 * per piece and per side, and a leaving copy can overlap the arriving one, so
 * a shared id would resolve every url(#…) to whichever copy came first, and
 * lose its gradient when that one is removed.
 */
function ownIds(root: Node): Node {
  if (!(root instanceof Element)) return root;
  const tag = `-c${++copies}`;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) if (el.id) el.id += tag;
  for (const el of els) {
    // A copy, as in parsePiece(): setting an attribute mid-walk reorders the live list.
    for (const { name, value } of Array.from(el.attributes)) {
      if (name === 'id') continue;
      if (value.includes('url(#')) el.setAttribute(name, value.replace(/url\(#([^)]+)\)/g, `url(#$1${tag})`));
      else if (/href$/i.test(name) && value.startsWith('#')) el.setAttribute(name, value + tag);
    }
  }
  return root;
}

/** A small seeded generator, so a board's pieces rest the same way every time. */
function seeded(text: string) {
  let s = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) s = Math.imul(s ^ text.charCodeAt(i), 0x85ebca6b);
  return () => {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 | 0;
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Whether the sidebar is open over the whole screen, as it is on a phone. A
 * palette, a switch or a board changed from it would otherwise come in under
 * it, unseen, and the pieces wait for it to shut instead (initWallpaper()).
 * Read off the page rather than asked of ui/sidebar.ts, which reaches this
 * module back through the panel.
 */
function underSidebar() {
  return onSmallScreen() && !!document.getElementById('sidebar')?.classList.contains('is-open');
}

/** The sidebar's slide out, the first of its transitions (sidebar.css), in ms. */
function slideOutMs(panel: HTMLElement) {
  const first = getComputedStyle(panel).transitionDuration.split(',')[0]?.trim() ?? '';
  const n = parseFloat(first);
  return Number.isFinite(n) ? (first.endsWith('ms') ? n : n * 1000) : 0;
}

/** Send what is on the edges out, and bring `parts` in on both. */
function swap(key: string, parts: Part[] | null) {
  if (!host || key === shown) return;
  // Held, not dropped: refresh() asks again when the sidebar has shut. A
  // picture being decided on is not held - it is shown so it can be decided.
  if (underSidebar() && !trial) return;
  shown = key;
  for (const side of sides) {
    side.classList.add('is-leaving', 'is-out');
    setTimeout(() => side.remove(), LEAVE_MS + 200);
  }
  sides = [];
  if (!parts?.length) return;
  // Each piece's own rest angle, the angle it comes in at, how long it takes
  // and how it drifts: all start together, and they land one after another.
  const rand = seeded(seed + key);
  const motion = parts.map((_, i) => {
    const swing = parts.length > 1 ? 3.5 : 1.5;
    const rest = (rand() * 2 - 1) * swing;
    return {
      rest,
      from: rest - (5 + rand() * 6),
      dur: 1.1 + i * 0.32 + rand() * 0.2,
      floatDur: 15 + rand() * 9,
      floatDelay: -rand() * 12,
      leave: i * 0.05,
    };
  });
  for (const which of ['wp-left', 'wp-right']) {
    const side = document.createElement('div');
    side.className = `wp-side ${which} is-out`;
    parts.forEach((part, i) => {
      const m = motion[i];
      const item = document.createElement('div');
      // Not `wp-item`, which is what the file's own groups are called.
      item.className = 'wp-piece';
      item.style.setProperty('--wp-rest', `${m.rest.toFixed(2)}deg`);
      item.style.setProperty('--wp-from', `${m.from.toFixed(2)}deg`);
      item.style.setProperty('--wp-dur', `${m.dur.toFixed(2)}s`);
      item.style.setProperty('--wp-leave', `${m.leave.toFixed(2)}s`);
      const float = document.createElement('div');
      float.className = 'wp-float';
      float.style.animationDuration = `${m.floatDur.toFixed(1)}s`;
      float.style.animationDelay = `${m.floatDelay.toFixed(1)}s`;
      float.append(ownIds(part.el.cloneNode(true)));
      item.append(float);
      item.dataset.pivot = part.pivot ? part.pivot.join(' ') : '';
      side.append(item);
    });
    host.append(side);
    sides.push(side);
  }
  placePivots();
  measure(sides[0]);
  placeSides(true);
  // Two frames: the first lays the pieces out where they start, the second lets
  // them go, so the transition has a from to run from.
  const enter = sides;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const side of enter) side.classList.remove('is-out');
  }));
}

/**
 * Each piece turns about its own pivot, which the file gives in its viewBox's
 * units. The art is sliced to the side's box (xMinYMid slice, 600 by 1000), so
 * a unit is the larger of the two scales and the box is centred vertically.
 * A board's own picture, with no pivot, turns about where it crosses the edge.
 */
function placePivots() {
  for (const side of sides) {
    const w = side.clientWidth, h = side.clientHeight;
    const scale = Math.max(w / 600, h / 1000);
    fit = { w, scale };
    const top = (h - 1000 * scale) / 2;
    for (const item of side.querySelectorAll<HTMLElement>('.wp-piece')) {
      const [x, y] = (item.dataset.pivot || '').split(' ').map(Number);
      const origin = item.dataset.pivot ? `${(x * scale).toFixed(1)}px ${(y * scale + top).toFixed(1)}px` : '0 70%';
      item.style.transformOrigin = origin;
      const float = item.firstElementChild;
      if (float instanceof HTMLElement) float.style.transformOrigin = origin;
    }
  }
}

let view: Viewport | null = null;
/** A side's width and the art's px per file unit, kept by placePivots() so a zoom frame reads no layout. */
let fit = { w: 0, scale: 1 };
/** How far the art on the edges reaches at rest, in the file's units, or null for a board's own picture. */
let extent: { far: number } | null = null;
/** Units past the drawn edge, for the shadows and the float, which the box leaves out. */
const EXTENT_PAD = 12;

/** The art's farthest x across its pieces, each turned to its rest angle about its pivot. */
function measure(side: HTMLElement | undefined) {
  let far = -Infinity;
  for (const item of side?.querySelectorAll<HTMLElement>('.wp-piece') ?? []) {
    const svg = item.querySelector('svg');
    if (!svg) continue;
    let box: DOMRect;
    try { box = svg.getBBox(); } catch { continue; }
    if (!box.width) continue;
    // A piece with no pivot turns about '0 70%' (placePivots()).
    const [px, py] = item.dataset.pivot ? item.dataset.pivot.split(' ').map(Number) : [0, 700];
    const turn = (parseFloat(item.style.getPropertyValue('--wp-rest')) || 0) * Math.PI / 180;
    const cos = Math.cos(turn), sin = Math.sin(turn);
    for (const x of [box.x, box.x + box.width]) {
      for (const y of [box.y, box.y + box.height]) {
        far = Math.max(far, px + (x - px) * cos - (y - py) * sin);
      }
    }
  }
  extent = Number.isFinite(far) ? { far: far + EXTENT_PAD } : null;
}

/**
 * Each side slid along so the art takes as much of the window as the zoom
 * gives it (edgeShare()): out past the edge as the board is zoomed in, back
 * in as it is zoomed out, but never further in than where the piece is drawn
 * to sit, so zoomed out each piece reaches as far as its own drawing does.
 * At Full the sides glide there; `snap` (new pieces, a resize) and every
 * other tier put them there at once.
 */
function placeSides(snap = false) {
  if (!view || !sides.length) return;
  const room = edgeShare(view.zoom / BASE_ZOOM) * innerWidth;
  const far = extent ? extent.far * fit.scale : fit.w;
  shiftTo = Math.min(room - far, 0);
  if (snap || !glides()) {
    cancelAnimationFrame(gliding);
    gliding = 0;
    shiftNow = shiftTo;
    paintShift();
    return;
  }
  if (!gliding) { lastFrame = performance.now(); gliding = requestAnimationFrame(glide); }
}

/** The shift on screen and the one the zoom asks for, in px; apart only during a glide. */
let shiftNow = 0, shiftTo = 0;
let gliding = 0;
let lastFrame = 0;
/**
 * The glide's time constant, in seconds. Each frame closes the same share of
 * what is left, so one wheel step eases out as the pieces' entrance does,
 * settling in about the same 1.2s, and a pinch or a trackpad, which move the
 * target every frame, are followed smoothly with no restart on each one.
 */
const GLIDE_TAU = 0.25;
let stillMotion: MediaQueryList | null = null;

function glides() {
  stillMotion ??= matchMedia('(prefers-reduced-motion: reduce)');
  return document.documentElement.dataset.quality === 'full' && !stillMotion.matches;
}

function glide(now: number) {
  // A frame's stamp can come before the performance.now() that started the glide.
  const dt = Math.min(0.064, Math.max(0, now - lastFrame) / 1000);
  lastFrame = now;
  shiftNow += (shiftTo - shiftNow) * (1 - Math.exp(-dt / GLIDE_TAU));
  // The last pixel lands at once: an exponential's tail creeps on for seconds unseen.
  if (Math.abs(shiftTo - shiftNow) < 0.75) shiftNow = shiftTo;
  paintShift();
  gliding = shiftNow === shiftTo ? 0 : requestAnimationFrame(glide);
}

/** Written as each side's own transform, not a variable, so a frame restyles two boxes and not the art inside them. */
function paintShift() {
  const x = `translateX(${shiftNow.toFixed(1)}px)`;
  for (const side of sides) side.style.transform = side.classList.contains('wp-right') ? `scaleX(-1) ${x}` : x;
}

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

let probeCanvas: CanvasRenderingContext2D | null = null;

/**
 * Where a look change is taking a token: the end of the transition fading it
 * on :root (its colours are registered, tokens.css, so the fade is a
 * CSSTransition of its own), or '' when none is running or it cannot be read.
 */
function headingTo(token: string): string {
  for (const anim of document.documentElement.getAnimations()) {
    if (!(anim instanceof CSSTransition) || anim.transitionProperty !== token) continue;
    if (!(anim.effect instanceof KeyframeEffect)) continue;
    const frames = anim.effect.getKeyframes();
    const end = frames[frames.length - 1]?.[token];
    if (typeof end === 'string' && end) return end;
  }
  return '';
}

/**
 * A token as OKLCh, whatever syntax the sheet wrote it in: the canvas resolves
 * it. `settled` asks for where a running fade is going rather than where it is.
 */
function readColour(token: string, settled = false): OKLCh | null {
  let css = settled ? headingTo(token) : '';
  if (!css) {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    css = getComputedStyle(probe).color;
    probe.remove();
  }
  probeCanvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probeCanvas || !css) return null;
  probeCanvas.clearRect(0, 0, 1, 1);
  probeCanvas.fillStyle = '#000';
  probeCanvas.fillStyle = css;
  probeCanvas.fillRect(0, 0, 1, 1);
  try {
    const [r, g, b] = probeCanvas.getImageData(0, 0, 1, 1).data;
    return oklch(r, g, b);
  } catch {
    return null;
  }
}

function readTones() {
  const paper = readColour('--paper');
  const accent = readColour('--accent');
  if (!paper || !accent) return null;
  const dark = document.documentElement.dataset.scheme === 'dark';
  // The tones follow the fade frame by frame; the family is the one it is
  // heading for, so the pieces can swap as it starts rather than as it ends.
  const family = familyOf(readColour('--accent', true) ?? accent);
  return { family, values: wallpaperTones(paper, accent, dark) };
}

/** The tones onto #wallpaper, where the pieces' classes read them, and into the filter. */
function paintTones(values: Record<string, string>) {
  if (!host) return;
  for (const [name, value] of Object.entries(values)) host.style.setProperty(`--wp-${name}`, value);
  // Dark to light, so a picture's shadows land on tone 5 and its highlights on hi.
  const ramp = [...TONES].reverse().map(t => values[t]);
  for (const [i, fn] of funcs.entries()) {
    fn.setAttribute('tableValues', ramp.map(h => (parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255).toFixed(3)).join(' '));
  }
}

/** Greyscale by luminance, then each channel mapped through the tones. */
function toneFilter(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wp-defs');
  svg.setAttribute('aria-hidden', 'true');
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = TONE_FILTER;
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const grey = document.createElementNS(SVG_NS, 'feColorMatrix');
  grey.setAttribute('type', 'matrix');
  const row = '0.2126 0.7152 0.0722 0 0';
  grey.setAttribute('values', `${row} ${row} ${row} 0 0 0 1 0`);
  const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
  funcs = ['feFuncR', 'feFuncG', 'feFuncB'].map(name => {
    const fn = document.createElementNS(SVG_NS, name);
    fn.setAttribute('type', 'table');
    transfer.append(fn);
    return fn;
  });
  filter.append(grey, transfer);
  svg.append(filter);
  return svg;
}

// ---------------------------------------------------------------------------
// The board's own picture
// ---------------------------------------------------------------------------

/** Ask for a picture, cut its subject out, show it on the edges, and ask whether to keep it. */
export async function addWallpaperPicture() {
  if (notUsersBoard() || phoneShaped()) return;
  const file = await pickPicture();
  if (!file) return;
  const face = await decode(file);
  if (!face) { toast('That picture could not be read'); return; }
  const whole = await encode(face.surface);
  let cut: Blob | null = null;
  if (matteAvailable()) {
    toast('Cutting out the subject…');
    const copy = surface(face.w, face.h);
    if (copy) {
      copy.ctx.drawImage(face.surface.canvas, 0, 0);
      if (await cutout(copy, face.w, face.h)) cut = await encode(cropToSubject(copy, face.w, face.h));
    }
  }
  if (!whole) { toast('That picture could not be read'); return; }
  const shownBlob = cut || whole;
  const url = URL.createObjectURL(shownBlob);
  trial = { url, tone: board.wallpaper.tone };
  schedule();
  const answer = await ask({
    title: cut ? 'Keep the cut-out?' : 'Use this picture?',
    body: cut
      ? 'The subject was cut out of its background and is on the edges now.'
      : matteAvailable()
        ? 'No subject could be cut out of it, so the whole picture is on the edges.'
        : 'This browser cannot cut a subject out, so the whole picture is on the edges.',
    go: cut ? 'Keep cut-out' : 'Use it',
    keep: cut ? 'Use whole picture' : '',
    cancel: 'Cancel',
    danger: false,
  });
  trial = null;
  URL.revokeObjectURL(url);
  if (answer === 'cancel') { schedule(); return; }
  const chosen = answer === 'keep' ? whole : shownBlob;
  const hash = await addFile(derivedFile(chosen, 'wallpaper'));
  setWallpaper({ ...board.wallpaper, show: true, asset: hash }, 'Set the wallpaper picture');
}

/** Back to the built-in pieces. */
export function removeWallpaperPicture() {
  if (!board.wallpaper.asset) return;
  setWallpaper({ ...board.wallpaper, asset: null }, 'Remove the wallpaper picture');
}

/** One undo step for any change to the record. */
export function setWallpaper(next: Wallpaper, label: string) {
  const prev = { ...board.wallpaper };
  commit(label, () => setSetting('wallpaper', next), () => setSetting('wallpaper', prev));
}

function pickPicture(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** The picture on a surface, at most KEEP_EDGE on its long side. */
async function decode(file: File): Promise<{ surface: Surface, w: number, h: number } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const scale = Math.min(1, KEEP_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  const face = surface(w, h);
  if (!face) { bitmap.close(); return null; }
  face.ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { surface: face, w, h };
}

/** The cut-out trimmed to the bounds of what the matte kept, with a little air. */
function cropToSubject(face: Surface, w: number, h: number): Surface {
  let data: Uint8ClampedArray;
  try {
    data = face.ctx.getImageData(0, 0, w, h).data;
  } catch {
    return face;
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < CROP_ALPHA) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return face;
  const pad = Math.round(Math.max(w, h) * 0.01);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = surface(x1 - x0 + 1, y1 - y0 + 1);
  if (!out) return face;
  out.ctx.drawImage(face.canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

/** WebP, keeping the alpha a cut-out is made of. */
const encode = (face: Surface) => surfaceToPicture(face, 0.9, { jpeg: false });
