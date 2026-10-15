// Live theming via CSS custom properties on :root.
// A look = whimsy (0-2 playfulness axis) + palette (named colour set) +
// vars (per-token overrides). Stored in both localStorage and the board.

import {
  board, bus, setAppearance, setSetting, commitAppearance, snapMove, MOBILE_APPEARANCE_VARS,
  claimLook, type SnapMove,
} from '../state.ts';
import { whimsyControlsSnap, AXIS_TOKENS } from '../layout-settings.ts';
import { DEFAULT_PALETTE_SOURCES } from '../board-schema.ts';
import { cssMs, readToken, reducedMotion, toHex } from '../util.ts';
import { readPrefJSON, writePref } from '../prefs.ts';
import { paletteFromAccent, darkSheet, PALETTE_TOKENS } from './pigments.ts';
import { markScheme, isDarkShown, setDarkHandler } from './scheme.ts';
// Dynamic, the palette from the board's pictures, lives there and borrows the
// look through initPicturePalette(), as the panel borrows it below.
import {
  initPicturePalette, autoRecolour, recolourFromBoard, forgetSources,
  sourceCount, dynamicOn, ALL_SOURCES_STOP, ALL_SOURCES_MAX,
} from './picture-palette.ts';
// Pure look arithmetic — in its own module so it stays testable without a browser.
import {
  safeVars, cloneLook, sameLook, hasLook, autoOn, clampWhimsy, WHIMSY, DEFAULT_WHIMSY,
  PLAYFAIR_STACK, FRAUNCES_STACK,
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
/** The dark twin of the stored pigments, for the pre-paint script, which cannot work it out. */
const DARK_KEY = 'mbrd.appearance.dark';

const HARSH = 2;


// Display faces. '' means "let whimsy decide". All stacks must be shipped or
// system fonts (offline-first). Values travel in .mbrd — keep under 160 chars.
const DISPLAY_FACES = [
  { label: 'Default', value: '' },
  { label: 'Playfair',             value: PLAYFAIR_STACK },
  { label: 'Fraunces',             value: FRAUNCES_STACK },
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
/** Whether `current` is the last look used here, standing in for a board that
 *  has none, and not yet written to it. See syncFromBoard in initAppearance(). */
let fromPrefs = false;
let onChange: () => void = () => {};

export function initAppearance(handlers: { onChange?: () => void } = {}) {
  onChange = handlers.onChange || (() => {});

  initPicturePalette({
    current: () => current,
    setPigments, dropPigments, syncControls,
    persist: () => persist(),
  });
  initAppearanceControls({
    CONTROLS, HOSTS, WHIMSY, ALL_SOURCES_STOP, ALL_SOURCES_MAX,
    current: () => current,
    setVar, previewWhimsy, settleWhimsy, setPalette, goDynamic, sourceCount, dynamicOn,
    handPicked,
  });

  // Flush pending pref writes on tab close (pagehide for iOS, visibility for discard).
  addEventListener('pagehide', flushLook);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLook();
  });

  const stored = readStored();
  const fromBoard = board.settings.appearance;
  current = hasLook(fromBoard) ? cloneLook(fromBoard) : stored;
  fromPrefs = !hasLook(fromBoard);
  setDarkHandler(setDark);
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

  // A board arriving (`load`) with no look takes the last look used here.
  // Otherwise the board's look wins, the default one included: that is what an
  // undo or a Timeline trip back past a look change lands on. The exception is
  // the fallback itself, while it is on screen and not yet written to the board.
  const syncFromBoard = (load = false) => {
    const look = board.settings.appearance;
    const fallback = !hasLook(look) && (load || fromPrefs);
    const next = fallback ? readStored() : cloneLook(look);
    fromPrefs = fallback;
    if (sameLook(next, current)) return;
    current = next;
    apply(current);
    syncControls();
  };
  bus.on('board', () => syncFromBoard());
  // Apply on 'board:load' too — 'board' fires after consumers that need the resolved face.
  bus.on('board:load', () => syncFromBoard(true));
  // Advanced overrides are layout-local; reconcile on profile switch.
  bus.on('layout', () => {
    syncFromBoard();
    syncControlVisibility();
  });
}

/** Set the whimsy level (0-2) as one Timeline step. Exported for cmds (canvas/ cannot import ui/). */
export function setWhimsy(level: number | string) {
  previewWhimsy(level);
  settleWhimsy();
}

/** Dark or light, the board's own and one Timeline step, as the palette is. */
function setDark(on: boolean) {
  if ((current.dark === true) === on) return;
  const from = cloneLook(current);
  if (on) current.dark = true;
  else delete current.dark;
  apply(current);
  persist();
  syncControls();
  commitAppearance(cloneLook(current), from);
}

/** The look before the whimsy slider in hand moved, or null between drags. */
let whimsyFrom: Look | null = null;

/** The snap sweeps this drag has made, in order, for settleWhimsy() to commit with the look. */
let whimsyMoves: SnapMove[] = [];

/** The slider moving: the page takes each level as it passes. settleWhimsy() records where it stops. */
function previewWhimsy(level: number | string) {
  const n = clampWhimsy(level);
  if (n === current.whimsy) return;
  whimsyFrom ??= cloneLook(current);
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
  // The grid's shape follows at once.
  bus.emit('settings', 'appearance');
  // And so does the snap, which is what a level *means* on Desktop: Harsh is a
  // board on the lattice, and a slider that changes every other thing about the
  // page as it passes and leaves the cards where they were until it is let go
  // was showing two halves of one level at two different moments. The sweep is
  // made here and committed at the release, inside the whimsy's own step: as a
  // step of its own it put two on the Timeline for every crossing of Harsh.
  //
  // Only on the crossing into or out of Harsh, however many levels the slider
  // passes through on the way.
  const snap = n === HARSH;
  if (whimsyControlsSnap(board.layoutMode) && !!board.settings.snap !== snap) {
    whimsyMoves.push(snapMove(snap));
  }
}

/** The slider let go: one step from the look before the drag, the snap inside it. */
function settleWhimsy() {
  if (!whimsyFrom) return;
  const from = whimsyFrom;
  const moves = whimsyMoves;
  whimsyFrom = null;
  whimsyMoves = [];
  // Back where it started: any sweeps made on the way have undone each other.
  if (sameLook(from, current)) return;
  commitAppearance(cloneLook(current), from, 'Whimsy', moves);
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
  paintScheme();
  paintThemeColour();
  persist({ chosen: false });
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
  paintScheme();
  paintThemeColour();
  persist({ chosen: false });
  syncControls();
  followFade();
}

const FADE_MS = 700;

let fadeEnd = 0, fading = false;

// Drive per-frame canvas repaint during palette fade (canvas caches colours).
function followFade() {
  if (typeof requestAnimationFrame !== 'function') return;
  const still = reducedMotion();
  fadeEnd = performance.now() + (still ? 0 : paletteMs());
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

/** --dur-palette in milliseconds: how long the sheet fades, and the corners travel. */
const paletteMs = () => cssMs('--dur-palette', FADE_MS);

let reshapeTimer = 0;
let reshapeFrame = 0;

/** The cards that ease with the interface. See reshapeCorners(). */
const SEEN = 'is-reshape-seen';

/**
 * Ease the corners into a new tier: .is-reshaping lets border-radius, and
 * nothing else, travel with the colours (tokens.css, 1c). On while they
 * travel and no longer, since for that time it overrules every other transition.
 *
 * Cards ease only when on screen and at 40% or closer; the rest change at once.
 * Called before the tier is written: the measure below flushes layout, and a
 * flush after the write would lay the new corners out with no transition.
 */
function reshapeCorners() {
  if (typeof window !== 'object' || reducedMotion()) return;
  clearTimeout(reshapeTimer);
  for (const el of document.querySelectorAll(`.${SEEN}`)) el.classList.remove(SEEN);
  const world = document.getElementById('world');
  // On Mobile the Feed covers the board, so only its tiles are seen.
  const cards = world && board.layoutMode !== 'mobile' && !world.classList.contains('zoom-far')
    ? [...world.querySelectorAll('.item')] : [];
  for (const el of [...cards, ...document.querySelectorAll('#mobile-feed .feed-tile')]) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) el.classList.add(SEEN);
  }
  root.classList.add('is-reshaping');
  cancelAnimationFrame(reshapeFrame);
  // The corners start with the tier write, but the rest of the tier change can
  // hold the page for a tenth of a second, and the first frame draws the whole
  // new tier, which can take longer again. The short run into Harsh was over
  // before either had passed. Restarted on the first frame and the second, so
  // all of it shows.
  const restart = () => {
    const now = document.timeline.currentTime;
    for (const a of document.getAnimations()) {
      if (a instanceof CSSTransition && a.transitionProperty.endsWith('radius')) a.startTime = now;
    }
  };
  // The longest run, the colours' own: into Harsh it is shorter, and the class
  // staying on for the rest of it changes nothing anybody can see. Timed from
  // now as well as from the restart: while the class is on it overrules every
  // other transition, so a frame that never comes must not leave it on.
  const settle = () => {
    root.classList.remove('is-reshaping');
    for (const el of document.querySelectorAll(`.${SEEN}`)) el.classList.remove(SEEN);
  };
  reshapeTimer = window.setTimeout(settle, paletteMs() + 100);
  reshapeFrame = requestAnimationFrame(() => {
    restart();
    reshapeFrame = requestAnimationFrame(() => {
      restart();
      clearTimeout(reshapeTimer);
      reshapeTimer = window.setTimeout(settle, paletteMs() + 100);
    });
  });
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

/**
 * Whether the colours on screen were chosen here, by hand.
 *
 * Derived rather than stored: a pigment token in `vars` that the picture
 * extraction did not write is one somebody picked, and that is the whole of
 * the state. Nothing has to be cleared when a palette is chosen, because
 * setPalette() drops the tokens themselves - so the question stops being true
 * the moment its evidence goes, and no second flag can disagree with the
 * colours. It travels in the .mbrd for free too: a board saved on a chosen
 * pigment opens on one.
 */
function handPicked() {
  return !current.derived && PALETTE_TOKENS.some(key => key in current.vars);
}

// Remove all inline pigment tokens; the named palette shows through again.
function dropPigments() {
  if (!PALETTE_TOKENS.some(key => key in current.vars)) return false;
  for (const key of PALETTE_TOKENS) {
    delete current.vars[key];
    root.style.removeProperty(key);
  }
  delete current.derived;
  darkShown = {};
  paintThemeColour();
  followFade();
  return true;
}

/**
 * The Look tab's Reset: whimsy, the faces and every override back to where a
 * board starts, and how many pictures a Dynamic palette reads - but not the
 * palette. The colours are the one choice here that is about this board, so
 * the named palette, the pigments and whether they come from the pictures all
 * stay. resetAppearance() is the whole reset a new board gets.
 */
export function resetLook() {
  setSetting('paletteSources', DEFAULT_PALETTE_SOURCES);
  const was = current.whimsy;
  const vars: Record<string, string> = board.layoutMode === 'mobile' ? { ...MOBILE_APPEARANCE_VARS } : {};
  for (const [key, value] of Object.entries(current.vars)) {
    if (PALETTE_TOKENS.includes(key)) vars[key] = value;
  }
  current = { ...current, whimsy: DEFAULT_WHIMSY, vars };
  apply(current);
  persist();
  syncControls();
  if (was !== DEFAULT_WHIMSY) axisMoved(DEFAULT_WHIMSY);
  // The paper is built for a tier, so the kept pigments are built again for this one.
  reshade();
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
  persist({ chosen: false });
  syncControls();
  if (was !== DEFAULT_WHIMSY) axisMoved(DEFAULT_WHIMSY);
  forgetSources();
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
  const tier = String(look.whimsy);
  // A new tier eases the corners into place. Not before one is written: the
  // first look arrives on a page nobody has seen change.
  if (root.dataset.whimsy !== undefined && root.dataset.whimsy !== tier) reshapeCorners();
  // Always written — level 0 has its own rules; absent would fall back to 1.
  root.dataset.whimsy = tier;
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
  // Before the pigments: paintScheme() asks the page which one it is.
  markScheme(look.dark === true);
  paintScheme();
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
  const write = () => {
    writePref(STORE_KEY, JSON.stringify(current));
    writePref(DARK_KEY, JSON.stringify(darkShown));
  };
  if (!soon) {
    if (prefTimer) { clearTimeout(prefTimer); prefTimer = 0; }
    write();
    return;
  }
  if (prefTimer) return;
  prefTimer = setTimeout(() => {
    prefTimer = 0;
    write();
  }, PREF_MS);
}

/** What paintScheme() last put on screen in the dark, and nothing in the light. */
let darkShown: Record<string, string> = {};

/**
 * The look's pigments as the screen wears them: as they are, or in the dark
 * their twin from darkSheet(). The look itself stays light - it is what the
 * board saves, with `dark` beside them - so this runs after every write of a
 * pigment and on every flip. A pigment darkSheet() cannot read comes off, and
 * the stylesheet's dark palette (tokens.css, 3c) shows under it.
 */
function paintScheme() {
  const pigments: Record<string, string> = {};
  for (const key of PALETTE_TOKENS) if (current.vars[key]) pigments[key] = current.vars[key];
  const dark = isDarkShown();
  darkShown = dark && Object.keys(pigments).length ? darkSheet(pigments, current.whimsy) : {};
  for (const [key, value] of Object.entries(pigments)) {
    const shown = dark ? darkShown[key] : value;
    if (shown) root.style.setProperty(key, shown);
    else root.style.removeProperty(key);
  }
}

/** Write a pending preference now. The tab is going away. */
function flushLook() {
  if (prefTimer) storeLook(false);
}

/** `chosen` is false for the writes the machine makes - pigments read off the
 *  pictures, a reset for a new board - and true for a choice in the panel,
 *  which makes the look this board's own (claimLook() in state.ts). */
function persist({ soon = false, chosen = true } = {}) {
  storeLook(soon);
  if (chosen) claimLook();
  setAppearance(cloneLook(current));
  fromPrefs = false;
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
  // The menu is repainted at the end of whichever path runs and not here: it
  // reads handPicked(), which is a question about `vars`, and asking before
  // the write would answer about the look one edit ago.
  const pigment = PALETTE_TOKENS.includes(name);
  if (pigment) {
    delete current.derived;
    current.auto = false;
  }
  // The embed watermark's viewBox is measured from the display face in JS; a
  // bare CSS var change here does not go through apply(), so refit it by hand.
  // Guarded to the one token that matters — setVar runs on every input of a
  // slider, and the marks read no pigment.
  const refitFace = name === '--font-display';
  if (value === '') {
    delete current.vars[name];
    root.style.removeProperty(name);
    applied.delete(name);
    if (pigment) paintScheme();
    persist();
    if (pigment) syncPaletteMode();
    if (refitFace) refitEmbedMarks();
    if (pigment) followFade();
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
  if (pigment) paintScheme();
  // The paper moved, so the installed-PWA title bar did too. No syncControls()
  // to go with it, deliberately: a slider calls this on every input, and the
  // only control whose value changed is the one under the pointer. Nothing
  // else in the panel reads a pigment.
  if (sheet) paintThemeColour();
  if (pigment) syncPaletteMode();
  if (refitFace) refitEmbedMarks();
  persist({ soon: true });
  // A pigment moves the whole sheet, so it fades as a palette change does:
  // the other transitions held still (.is-fading), the canvas repainted every
  // frame. Without it the buttons chased the sheet and the grid kept its old
  // colour until something else redrew it.
  if (pigment) followFade();
}

function readStored() {
  return cloneLook(readPrefJSON(STORE_KEY));
}

