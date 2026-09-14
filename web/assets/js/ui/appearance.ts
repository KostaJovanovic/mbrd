// Live theming via CSS custom properties on :root.
// A look = whimsy (0-2 playfulness axis) + palette (named colour set) +
// vars (per-token overrides). Stored in both localStorage and the board.

import {
  board, bus, setAppearance, setSetting, MOBILE_APPEARANCE_VARS,
} from '../state.ts';
import { autoPaletteReady, whimsyControlsSnap, AXIS_TOKENS } from '../layout-settings.ts';
import { readToken, toHex } from '../util.ts';
import { oklch, parseHex } from '../color.ts';
import { toast } from '../notify.ts';
import { readPrefJSON, writePref } from '../prefs.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import { shownHash } from '../board-model.ts';
import {
  extractPalette, paletteFromAccent, samplePixels, MAX_SOURCES, PALETTE_TOKENS,
} from './pigments.ts';
// Pure look arithmetic — in its own module so it stays testable without a browser.
import {
  safeVars, cloneLook, sameLook, hasLook, autoOn, clampWhimsy, WHIMSY, DEFAULT_WHIMSY,
} from './look.ts';

import {
  initAppearanceControls, buildControls, syncControls, syncControlVisibility,
  syncPaletteMode, syncPaletteSources, wirePaletteSources,
  wireWhimsy, wirePalette, inputs,
} from './appearance-controls.ts';
import { legacyBlends } from './legacy-color.ts';
import { refitEmbedMarks } from '../canvas/renderers.ts';
import type { ControlSpec, Look } from './appearance-controls.ts';

export { WHIMSY };

const STORE_KEY = 'mbrd.appearance';

const HARSH = 2;


// Display faces. '' means "let whimsy decide". All stacks must be shipped or
// system fonts (offline-first). Values travel in .mbrd — keep under 160 chars.
const DISPLAY_FACES = [
  { label: 'Default', value: '' },
  { label: 'Playfair',             value: '"Playfair", Georgia, serif' },
  { label: 'Fraunces',             value: '"Fraunces", Georgia, serif' },
  { label: 'Iowan Old Style',      value: '"Iowan Old Style", Palatino, serif' },
  { label: 'Palatino',             value: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
  { label: 'Georgia',              value: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman',      value: '"Times New Roman", Times, serif' },
  { label: 'Geist (sans)',         value: '"Geist", system-ui, sans-serif' },
];

const BODY_FACES = [
  { label: 'Default', value: '' },
  { label: 'Geist',                value: '"Geist", system-ui, sans-serif' },
  { label: 'System sans',          value: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: 'Helvetica',            value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Georgia',              value: 'Georgia, "Times New Roman", serif' },
  { label: 'Same as display',      value: 'var(--font-display)' },
];

// Exposed controls. host = panel section: type (above fold), main, advanced.
// Fonts survive whimsy moves (not in AXIS_TOKENS). No --paper (derived from accent).
const CONTROLS: ControlSpec[] = [
  { var: '--font-display', label: 'Display font', type: 'font', options: DISPLAY_FACES, host: 'type' },
  { var: '--font-body',    label: 'Body font',    type: 'font', options: BODY_FACES,    host: 'type' },
  { var: '--accent',      label: 'Pigment',       type: 'color', host: 'main' },
  // Floored above zero — invisible grid would be a hidden "off" switch.
  { var: '--grid-alpha',  label: 'Grid strength', type: 'range', min: 0.04, max: 0.4, step: 0.01, host: 'advanced' },
  { var: '--grid-dot',    label: 'Grid weight',   type: 'range', min: 0.5, max: 4,   step: 0.1,  unit: 'px', host: 'advanced' },
  { var: '--radius',      label: 'Corner radius', type: 'range', min: 0,   max: 28,  step: 1,    unit: 'px', host: 'advanced' },
  { var: '--sidebar-w',   label: 'Panel width',   type: 'range', min: 260, max: 460, step: 4,    unit: 'px', host: 'advanced' },
];

const HOSTS: Record<string, string> = {
  type: 'appearance-type',
  main: 'appearance-vars',
  advanced: 'appearance-advanced-vars',
};

const root = document.documentElement;
const themeColour = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
let current: Look = { whimsy: DEFAULT_WHIMSY, palette: '', vars: {} };
let onChange: () => void = () => {};

export function initAppearance(handlers: { onChange?: () => void } = {}) {
  onChange = handlers.onChange || (() => {});

  initAppearanceControls({
    CONTROLS, HOSTS, WHIMSY, ALL_SOURCES_STOP, ALL_SOURCES_MAX,
    current: () => current,
    setVar, setWhimsy, setPalette, goDynamic, sourceCount, dynamicOn,
  });

  // Flush pending pref writes on tab close (pagehide for iOS, visibility for discard).
  addEventListener('pagehide', flushLook);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLook();
  });

  const stored = readStored();
  const fromBoard = board.settings.appearance;
  current = hasLook(fromBoard) ? cloneLook(fromBoard) : stored;
  apply(current);

  buildControls();
  wirePalette();
  wirePaletteSources();
  wireWhimsy();

  // Board without a look falls back to stored prefs; guarded on sameLook()
  // because 'board' also fires on title/dirty changes.
  bus.on('board:new', () => resetAppearance());

  // Re-derive palette when pictures change (add, delete, undo).
  bus.on('items', autoRecolour);
  // A single item can gain a picture without an 'items' event: a link card
  // storing its fetched album cover emits 'item' (state.ts setEmbedMeta). The
  // source-set dedupe (sourceKey) makes this a no-op unless the picture set
  // actually changed, so listening to every single-item change costs nothing.
  bus.on('item', autoRecolour);

  // Source count changed — re-derive palette.
  bus.on('settings', key => {
    if (key !== 'paletteSources') return;
    syncPaletteSources();
    autoRecolour();
  });

  // Font list changed — rebuild the menus, and refit the embed watermarks: an
  // imported face can resolve the current display stack to new metrics, and
  // fitMark re-measures once document.fonts.ready settles the new load.
  bus.on('fonts', () => { buildControls(); refitEmbedMarks(); });

  const syncFromBoard = () => {
    const look = board.settings.appearance;
    const next = hasLook(look) ? cloneLook(look) : readStored();
    if (sameLook(next, current)) return;
    current = next;
    apply(current);
    syncControls();
  };
  bus.on('board', syncFromBoard);
  // Apply on 'board:load' too — 'board' fires after consumers that need the resolved face.
  bus.on('board:load', syncFromBoard);
  // Advanced overrides are layout-local; reconcile on profile switch.
  bus.on('layout', () => {
    syncFromBoard();
    syncControlVisibility();
  });
}

/** Set the whimsy level (0-2). Exported for cmds (canvas/ cannot import ui/). */
export function setWhimsy(level: number | string) {
  const n = clampWhimsy(level);
  if (n === current.whimsy) return;
  // Drop inline overrides for axis-owned tokens so the new level takes effect.
  for (const key of AXIS_TOKENS) {
    delete current.vars[key];
    root.style.removeProperty(key);
  }
  current.whimsy = n;
  apply(current);
  persist();
  syncControls();          // computed radii, fonts and durations all moved
  reshade();
  axisMoved(n);
}

// Re-derive the sheet at the new whimsy level (paper varies by tier).
function reshade() {
  if (!PALETTE_TOKENS.some(key => key in current.vars)) return;
  if (autoOn(current)) {
    recolourFromBoard({ silent: true }).catch(() => {});
    return;
  }
  // Manual accent: rebuild the sheet around the hand-picked colour.
  const sheet = current.vars['--accent']
    ? paletteFromAccent(current.vars['--accent'], { tier: current.whimsy })
    : null;
  if (!sheet) return;
  for (const [key, value] of Object.entries(sheet)) {
    current.vars[key] = value;
    root.style.setProperty(key, value);
    applied.add(key);
  }
  paintThemeColour();
  persist();
  followFade();
}

// Announce the axis move for grid shape (canvas/grid.ts) and Desktop snap toggle.
function axisMoved(level: number) {
  if (whimsyControlsSnap(board.layoutMode)) setSetting('snap', level === HARSH);
  bus.emit('settings', 'appearance');
}

/** Replace pigment tokens wholesale (for picture-derived palettes). */
export function setPigments(vars: Record<string, string>) {
  // Named palette left standing underneath — fallback when Dynamic is turned off.
  const clean = safeVars(vars);
  for (const [key, value] of Object.entries(clean)) {
    current.vars[key] = value;
    root.style.setProperty(key, value);
    applied.add(key);
  }
  // Mark as machine-derived only if something was actually written.
  if (Object.keys(clean).length) current.derived = true;
  paintThemeColour();
  persist();
  syncControls();
  followFade();
}

const FADE_MS = 700;

let fadeEnd = 0, fading = false;

// Drive per-frame canvas repaint during palette fade (canvas caches colours).
function followFade() {
  if (typeof requestAnimationFrame !== 'function') return;
  const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const raw = readToken('--dur-palette');
  const ms = raw.endsWith('ms') ? parseFloat(raw)
    : raw.endsWith('s') ? parseFloat(raw) * 1000 : NaN;
  fadeEnd = performance.now() + (still ? 0 : Number.isFinite(ms) ? ms : FADE_MS);
  if (fading) return;
  fading = true;
  // .is-fading suppresses other transitions to prevent colour flashing.
  if (!still) root.classList.add('is-fading');
  const step = () => {
    // try/finally: a throw must not leave fading stuck on.
    try {
      onChange();
      paintPigment();
    } finally {
      if (performance.now() < fadeEnd) requestAnimationFrame(step);
      else {
        fading = false;
        root.classList.remove('is-fading');
        settle();
      }
    }
  };
  requestAnimationFrame(step);
}

// Re-read controls after the fade lands — getComputedStyle mid-transition
// returns the interpolated value, not the target.
function settle() {
  paintThemeColour();
  syncControls();
}

// Update the pigment swatch per-frame during the fade.
function paintPigment() {
  const entry = inputs.get('--accent');
  if (!entry) return;
  const now = toHex(readToken('--accent'));
  if (now) entry.input.style.background = now;
}

// User explicitly chose Dynamic — extract immediately, no minimum-picture floor.
function goDynamic() {
  delete current.auto;
  persist();
  syncControls();
  recolourFromBoard().catch(() => {});
}

// Switch to a named palette. Drops all pigment tokens (including hand-picked).
function setPalette(name: string) {
  dropPigments();
  current.auto = false;
  current.palette = name;
  apply(current);
  persist();
  syncControls();
}

// Remove all inline pigment tokens; the named palette shows through again.
function dropPigments() {
  if (!PALETTE_TOKENS.some(key => key in current.vars)) return false;
  for (const key of PALETTE_TOKENS) {
    delete current.vars[key];
    root.style.removeProperty(key);
  }
  delete current.derived;
  paintThemeColour();
  followFade();
  return true;
}

// Collect picture hashes (newest first) for palette extraction.
// Hashes, not URLs — minting blob URLs here would defeat lazy asset loading.
function pictureHashes() {
  const hashes = [];
  for (const it of [...board.items].reverse()) {
    // shownHash() returns the preview for PDFs/HEIC/RAW, not the raw document.
    const hash = it.type === 'image' ? shownHash(it) : null;
    // meta.art is a link card's fetched album cover (canvas/embed-meta.ts): a
    // real picture on the board, so it feeds the palette like any other.
    for (const h of [hash, it.meta?.cover, it.meta?.art]) {
      if (typeof h === 'string' && getAsset(h)) hashes.push(h);
    }
  }
  return hashes;
}

// How many pictures to sample. 0 means all (capped at ALL_SOURCES_MAX).
function sourceCount() {
  const n = board.paletteSources;
  if (n === 0) return ALL_SOURCES_MAX;
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_SOURCES, n)) : MAX_SOURCES;
}

// Hard cap on "all photos" — beyond ~120 the hues converge and the cost grows.
const ALL_SOURCES_MAX = 120;

// Slider stop for "all photos" — one past MAX_SOURCES; stored as 0.
const ALL_SOURCES_STOP = MAX_SOURCES + 1;

// Comparable key for "would re-extraction give a different answer?"
function sourceKey(hashes = pictureHashes()) {
  return hashes.slice(0, sourceCount()).join('\n');
}

let lastSources: string | null = null;

let lastFailure: string | null = null;

// True when the board is actually wearing extracted pigments (auto + inline tokens).
const dynamicOn = () => autoOn(current) && PALETTE_TOKENS.some(key => key in current.vars);

// Auto-recolour on item changes. Skips if source set unchanged.
function autoRecolour() {
  if (!autoOn(current)) return;
  const hashes = pictureHashes();
  if (!autoPaletteReady(hashes.length, dynamicOn())) return;
  if (sourceKey(hashes) === lastSources) return;
  recolourFromBoard({ silent: true, hashes }).catch(() => {});
}

// Extract palette from board pictures. Silent on auto-success, loud on user request.
async function recolourFromBoard(
  { silent = false, hashes = pictureHashes() }: { silent?: boolean, hashes?: string[] } = {},
) {
  // Slice before resolving URLs — only the sampled pictures get blob URLs.
  const urls = hashes.slice(0, Math.min(sourceCount(), MAX_SOURCES)).map(assetURL)
    .filter((u): u is string => !!u);
  // Record before reading — avoids re-running on boards with colourless pictures.
  lastSources = sourceKey(hashes);
  const failed = (why: string) => {
    if (!silent || lastFailure !== why) toast(why);
    lastFailure = why;
    return false;
  };
  // No minimum here (the floor is only for the auto path). Empty board drops pigments.
  if (!hashes.length) {
    if (dropPigments()) {
      persist();
      syncControls();
      return failed('The colours came from those pictures - back to your palette');
    }
    lastFailure = 'No pictures on the board to take colours from';
    if (!silent) toast(lastFailure);
    return false;
  }

  const pixels = await samplePixels(urls, sourceCount());
  console.info(`[mbrd] palette: ${hashes.length} picture${hashes.length === 1 ? '' : 's'} on the board, ${pixels.length} read`);
  if (!pixels.length) return failed(`Could not read ${urls.length === 1 ? 'the picture' : 'any of the pictures'} on the board`);

  const vars = extractPalette(pixels, { tier: current.whimsy });
  if (!vars) return failed('No colour to take from these pictures');
  lastFailure = null;
  const hueOf = (c: string) => Math.round(oklch(...parseHex(c)).h);
  console.info(`[mbrd] palette: sheet ${vars['--paper']} (hue ${hueOf(vars['--paper'])}), `
    + `accent ${vars['--accent']} (hue ${hueOf(vars['--accent'])}), `
    + `wash ${vars['--leafy']} (hue ${hueOf(vars['--leafy'])})`);
  // Skip if hues unchanged — avoids marking the board dirty for nothing.
  const moved = Object.entries(vars).some(([k, v]) => current.vars[k] !== v);
  if (moved) setPigments(vars);
  if (!silent) toast('Palette taken from the pictures');
  return true;
}

/** Reset to default look: Middle, Papyrus, no overrides, extraction re-enabled. */
export function resetAppearance() {
  const was = current.whimsy;
  current = {
    whimsy: DEFAULT_WHIMSY,
    palette: '',
    vars: board.layoutMode === 'mobile' ? { ...MOBILE_APPEARANCE_VARS } : {},
  };
  apply(current);
  persist();
  syncControls();
  if (was !== DEFAULT_WHIMSY) axisMoved(DEFAULT_WHIMSY);
  lastSources = null;
  lastFailure = null;
  autoRecolour();
}

// ---------------------------------------------------------------------------

// Track what is inline on :root so apply() can remove the previous look's leftovers.
// Seeded from what the pre-paint guard in index.html already wrote.
let applied = new Set<string>(
  typeof document === 'object'
    ? [...document.documentElement.style].filter(name => name.startsWith('--'))
    : [],
);

function apply(look: Look) {
  // Always written — level 0 has its own rules; absent would fall back to 1.
  root.dataset.whimsy = String(look.whimsy);
  if (look.palette) root.dataset.palette = look.palette;
  else delete root.dataset.palette;   // no attribute = the default, Papyrus

  const vars = look.vars || {};
  for (const key of applied) {
    if (!(key in vars)) root.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  applied = new Set(Object.keys(vars));
  paintThemeColour();
  markDisplayFace();
  // Polyfill colour mixes for WebKit < 16.2.
  legacyBlends(root);
  followFade();
  // The embed watermark's viewBox is measured from the display face in JS, so a
  // pure CSS var change does not refit it - the mark would keep the old face's
  // box and mis-fill. Cheap: a no-op unless a player card is mounted.
  refitEmbedMarks();
}

// Set data-display-sans on :root so the wordmark can adjust weight for sans faces.
function markDisplayFace() {
  const stack = readToken('--font-display');
  if (/sans-serif\s*$/i.test(stack)) root.dataset.displaySans = '';
  else delete root.dataset.displaySans;
}

// Sync the PWA title-bar colour with --paper.
function paintThemeColour() {
  if (!themeColour) return;
  const paper = readToken('--paper');
  if (paper) themeColour.setAttribute('content', paper);
}

// Throttle for pref writes during drags.
const PREF_MS = 200;
let prefTimer = 0;

// Write the look to localStorage. soon=true throttles (for mid-drag calls).
function storeLook(soon: boolean) {
  if (!soon) {
    if (prefTimer) { clearTimeout(prefTimer); prefTimer = 0; }
    writePref(STORE_KEY, JSON.stringify(current));
    return;
  }
  if (prefTimer) return;
  prefTimer = setTimeout(() => {
    prefTimer = 0;
    writePref(STORE_KEY, JSON.stringify(current));
  }, PREF_MS);
}

/** Write a pending preference now. The tab is going away. */
function flushLook() {
  if (prefTimer) storeLook(false);
}

function persist({ soon = false } = {}) {
  storeLook(soon);
  setAppearance(cloneLook(current));
  onChange();
}

function setVar(name: string, value: string) {
  // An empty value is "stop overriding this", not "override it with nothing".
  // Setting a token to '' would leave an inline declaration that resolves to
  // the initial value and still beats the stylesheet, so the whimsy level
  // would never get its type back and the Default entry would be a one-way
  // door. Removal is the only thing that actually hands it back.
  // Picking a colour by hand is a decision about the same thing the extraction
  // decides, so it takes the switch off with it - otherwise the next imported
  // picture would quietly paint over the colour that was just chosen, and the
  // only clue would be a checkbox nobody was looking at. Scoped to the pigments
  // on purpose: choosing a display face or a corner radius says nothing about
  // colour, and used to switch the extraction off anyway.
  //
  // Cleared on the way out as well as the way in, since taking an override back
  // off is still a decision about the look.
  if (PALETTE_TOKENS.includes(name)) {
    delete current.derived;
    current.auto = false;
    syncPaletteMode();
  }
  // The embed watermark's viewBox is measured from the display face in JS; a
  // bare CSS var change here does not go through apply(), so refit it by hand.
  // Guarded to the one token that matters — setVar runs every frame of a colour
  // drag, and the marks read no pigment.
  const refitFace = name === '--font-display';
  if (value === '') {
    delete current.vars[name];
    root.style.removeProperty(name);
    applied.delete(name);
    persist();
    if (refitFace) refitEmbedMarks();
    return;
  }
  // The pigment carries the whole sheet with it. Paper, its three shades, the
  // ink, the rules and the two other pigments are all built from the hue that
  // was just picked, so the board stays one palette instead of an accent and a
  // sheet that were chosen at different times.
  //
  // Written straight rather than through setPigments(), which would mark the
  // look `derived` - the machine's to overwrite. This is the opposite: it is
  // the most deliberate colour decision the panel offers.
  const sheet = name === '--accent'
    ? paletteFromAccent(value, { tier: current.whimsy }) : null;
  // See the same loop in setPalette() for what the assertion that used to be
  // here was standing in for, and why it is not needed.
  for (const [key, hue] of Object.entries(sheet || {})) {
    current.vars[key] = hue;
    root.style.setProperty(key, hue);
    applied.add(key);
  }

  current.vars[name] = value;
  root.style.setProperty(name, value);
  applied.add(name);
  // The paper moved, so the installed-PWA title bar did too. No syncControls()
  // to go with it, deliberately: this runs on every frame of a colour drag, and
  // the only control whose value changed is the one under the pointer. Nothing
  // else in the panel reads a pigment.
  if (sheet) paintThemeColour();
  if (refitFace) refitEmbedMarks();
  persist({ soon: true });
}

function readStored() {
  return cloneLook(readPrefJSON(STORE_KEY));
}

