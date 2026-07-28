// Live theming. Every control here writes a CSS custom property straight onto
// :root, so the change is immediate and nothing needs re-rendering.
//
// Three things make up a look, in increasing order of how much they change:
//
//   whimsy   0-2, how playful the whole interface is. Moves shape, type,
//            motion, elevation, ornament and contrast at once.
//   palette  a named set of pigments. Same personality, different colour.
//   vars     per-token overrides on top of both. Written inline on :root, so
//            they beat any stylesheet rule and survive a change to either of
//            the above.
//
// The result is stored in two places on purpose:
//   localStorage  - "my app looks like this", follows the user across boards
//   board.settings.appearance - "this board looks like this", travels in the
//                   .mbrd, so opening someone else's board shows their look.
// Opening a board applies its appearance; editing a control updates both.
//
// Everything here is a plain setter over that one `current` object, which is
// what will let the board set its own look later: reading the pictures dropped
// on it, extracting their pigments into `vars` and parking `whimsy` where
// their contrast and sharpness say it belongs.

import {
  board, bus, setAppearance, setSetting, MOBILE_APPEARANCE_VARS,
} from '../state.js';
import { appearanceControlVisible, whimsyControlsSnap } from '../layout-settings.js';
import { clamp, readPrefJSON, toast, writePref } from '../util.js';
import { assetURL } from '../storage/assets.js';
import {
  extractPalette, oklch, paletteFromAccent, samplePixels, MAX_SOURCES, PALETTE_TOKENS,
} from './pigments.js';
// What a board is allowed to ask for. Kept in its own module because this one
// touches document at import time and that one must stay testable - see look.js.
import { safeVars } from './look.js';
import { customFaces } from './fonts.js';

const STORE_KEY = 'mbrd.appearance';

/**
 * The stops on the whimsy slider. The index is the value written to :root, and
 * the names are the ones printed under the track in index.html - what each
 * stop *does* is visible the moment you move it, so nothing here is captioned.
 */
export const WHIMSY = ['Softish', 'Middle', 'Harsh.'];

/** Where a board starts: the middle, which is also the bare stylesheet. */
const DEFAULT_WHIMSY = 1;

/**
 * The plain end of the axis, named because two things key off it rather than
 * off "the last stop": snapping, below, and the shape of the grid's marks,
 * which canvas/grid.js reads straight off data-whimsy. That file holds the same
 * number as a string; they are not shared through an import because the canvas
 * has no business importing from ui/, and both are really keyed to the
 * attribute this module writes rather than to each other.
 */
const HARSH = 2;

/**
 * Tokens the whimsy axis owns. A hand-set value beats any stylesheet, which is
 * what you want for a pigment - but not for these: leaving a hand-picked 13px
 * radius inline would keep the corners round in a mode whose whole point is
 * that they are square. So sliding the axis drops them back to the stylesheet.
 *
 * The grid pair belongs here for the same reason - each level sets its own
 * weight and strength, and touching either slider once would otherwise pin the
 * grid for good and leave it ignoring the axis from then on.
 *
 * The snap setting is owned in exactly this spirit without being a token at
 * all; see axisMoved() for why it is, and for what it costs.
 */
const AXIS_TOKENS = ['--radius', '--grid-alpha', '--grid-dot'];

/**
 * Faces the board can be set in, live.
 *
 * Here to settle an argument by looking at it rather than by discussing it:
 * the display serif is the loudest decision on the whole board and the only
 * honest way to choose one is to put real names, real note titles and a real
 * wordmark in it and see. A comparison page cannot do that, because the thing
 * being judged is how a face sits among photographs at three sizes.
 *
 * Every stack here is either shipped with the app (Fraunces, Geist - see
 * fonts.css) or already named as a fallback in tokens.css, so nothing is
 * fetched to try one on. That constraint is the offline-first promise, and it
 * is also why the list is short: these are the faces a board can actually be
 * set in today, not a catalogue.
 *
 * The choice itself is made: **Fraunces is the display serif**, settled on
 * 2026-07-26 after a whole build's worth of boards in it at all three stops of
 * the whimsy axis. The list stays because trying another one is the point - the
 * four operating-system serifs below it are there to be compared against, and a
 * face dropped onto the board joins them. Shipping a different one is an entry
 * here, an @font-face in fonts.css, the files themselves and a line in sw.js's
 * SHELL; nothing else in this module changes.
 *
 * '' is not a face. It removes the inline property and lets the whimsy level
 * have the type back, which is the state every board starts in - so trying
 * something on is always undoable without a reset.
 *
 * Kept under SAFE_VALUE's 160 characters (see ui/look.js), because these end up
 * in `settings.appearance.vars` and travel inside a .mbrd like any other token.
 */
const DISPLAY_FACES = [
  { label: 'Default', value: '' },
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
  // The soft end of the axis does exactly this. Offered at every level so the
  // one-voice setting can be tried without moving the slider to get it.
  { label: 'Same as display',      value: 'var(--font-display)' },
];

/**
 * The curated set of tokens worth exposing. Everything else stays internal.
 *
 * `host` files each control into one of three places in the panel, all three of
 * which now sit inside the Advanced fold:
 *
 *   type      the paired row of face menus, side by side
 *   main      the pigment, which moves the whole sheet
 *   advanced  the sliders, for the ones you set once and then leave
 *
 * Whimsy and Palette are the section above the fold, and nothing here joins
 * them. Between those two they already move every token this list sets one at a
 * time - which is the argument for the split: these are the controls for when
 * the two dials did not land where you wanted, not the ones you start with.
 *
 * Deliberately not in AXIS_TOKENS, and that is the decision worth naming:
 * sliding whimsy drops a hand-set radius back to the stylesheet, but a chosen
 * face survives the move. Comparing one serif across all three tiers is the
 * whole reason to have this, and a control that reset itself every time you
 * looked at the other end of the axis could not do it.
 *
 * --font-mono is left out on purpose: it is spent on byte counts, coordinates
 * and the text card's body, where the question is "does it line up in columns"
 * rather than one of taste.
 *
 * There is no --paper control. Paper is derived from the pigment now - see
 * setVar() - because the two were a pair anybody could put out of tune, and
 * a sheet that does not belong to its accent is the one mistake this panel
 * made easiest to make.
 */
const CONTROLS = [
  { var: '--font-display', label: 'Display', type: 'font', options: DISPLAY_FACES, host: 'type' },
  { var: '--font-body',    label: 'Body',    type: 'font', options: BODY_FACES,    host: 'type' },
  { var: '--accent',      label: 'Pigment',       type: 'color', host: 'main' },
  // Floored well above zero. The bottom of this range used to be an invisible
  // grid, which is a second, hidden "off" switch sitting next to the real one
  // in View - and one that gives no hint of what turned the dots off.
  { var: '--grid-alpha',  label: 'Grid strength', type: 'range', min: 0.04, max: 0.4, step: 0.01, host: 'advanced' },
  { var: '--grid-dot',    label: 'Grid weight',   type: 'range', min: 0.5, max: 4,   step: 0.1,  unit: 'px', host: 'advanced' },
  { var: '--radius',      label: 'Corner radius', type: 'range', min: 0,   max: 28,  step: 1,    unit: 'px', host: 'advanced' },
  { var: '--sidebar-w',   label: 'Panel width',   type: 'range', min: 260, max: 460, step: 4,    unit: 'px', host: 'advanced' },
];

/** Where each `host` renders. Missing element = that group is simply not built. */
const HOSTS = {
  type: 'appearance-type',
  main: 'appearance-vars',
  advanced: 'appearance-advanced-vars',
};

const root = document.documentElement;
const themeColour = document.querySelector('meta[name="theme-color"]');
let current = { whimsy: DEFAULT_WHIMSY, palette: '', vars: {} };
let onChange = () => {};

export function initAppearance(handlers = {}) {
  onChange = handlers.onChange || (() => {});

  const stored = readStored();
  // A board's own look wins when it brought one; otherwise fall back to the
  // user's saved preferences.
  const fromBoard = board.settings.appearance;
  current = hasLook(fromBoard) ? clone(fromBoard) : stored;
  apply(current);

  buildControls();
  wirePalette();
  wireAutoPalette();
  wireWhimsy();

  // A board's look on the way in, and the user's own back again on the way out.
  //
  // The early return this replaces meant "no look" was read as "no change",
  // so opening a plain board after someone else's heavily styled one left
  // their look on screen indefinitely - the board had nothing to say and so
  // nothing was said. Falling back to the stored preference is what makes a
  // board without a look mean something rather than nothing.
  //
  // Guarded on the look actually differing, because 'board' also fires for a
  // title change and for every dirty-flag flip, and persist() emits it on the
  // way through - so an unguarded handler would re-apply the current look on
  // every keystroke that renames a board.
  // A new board starts where a first-run board starts - Papyrus, the middle of
  // the axis, no overrides, the extraction on. The stored preference goes with
  // it, because these two are one value kept in two places and letting them
  // disagree is what the whole of readStored()/persist() exists to avoid.
  bus.on('board:new', () => resetAppearance());

  // While the switch is on, the palette follows whatever is on the board rather
  // than staying at whatever the pictures said the first time. Every way that
  // set can change goes through 'items': a picture arriving, a picture deleted,
  // the undo of either, and everything the bin does. Deleting used to be the
  // gap - a colour thrown off the board went on tinting the board it was thrown
  // off, which is the one case where the palette is demonstrably not a
  // representation of the pictures any more.
  //
  // Guarded on the *sampled* pictures actually differing, which is stricter
  // than "something happened": 'items' also fires for a note, a drag, a
  // duplicate, a text file, a board load - and for the thirteenth picture on a
  // board where only twelve are ever read. Re-running the extraction to arrive
  // at the same palette would repaint the whole interface and mark the board
  // dirty for nothing.
  //
  // Not awaited and its rejection swallowed: this is a decoration on an edit
  // that has already succeeded, and it has no business turning into an
  // unhandled rejection in somebody's console because one PNG would not decode.
  bus.on('items', () => {
    if (!autoOn(current)) return;
    if (sourceKey() === lastSources) return;
    recolourFromBoard({ silent: true }).catch(() => {});
  });

  // A face arrived, or a board load changed which ones are registered. The
  // menus are built from a list that just changed under them, so they are built
  // again - syncControls() at the end of buildControls() puts the current
  // choice back, including a choice the new list has just made selectable.
  bus.on('fonts', () => buildControls());

  const syncFromBoard = () => {
    const look = board.settings.appearance;
    const next = hasLook(look) ? clone(look) : readStored();
    if (sameLook(next, current)) return;
    current = next;
    apply(current);
    syncControls();
  };
  bus.on('board', syncFromBoard);
  // And on the load itself, ahead of the 'board' that trails it - loadBoard()
  // emits 'board:load' then 'board' (state.js), so a look left to the second
  // event lands a tick too late: every 'board:load' consumer that reads the
  // resolved type - the Mobile masthead building its weight slider off
  // --font-display is the one that showed it - rebuilds against the *previous*
  // whimsy's face and is a face behind until something forces it again. This
  // module is wired before those consumers (main.js init order), so applying the
  // look here means the display font is already the board's own by the time they
  // run. Idempotent with the trailing 'board': sameLook() makes the second a
  // no-op.
  bus.on('board:load', syncFromBoard);
  // Color and whimsy are shared, while advanced overrides are layout-local.
  // Switching profiles therefore needs the same reconciliation as opening one.
  bus.on('layout', () => {
    syncFromBoard();
    syncControlVisibility();
  });
}

/** Slide the whole interface along the playful-to-plain axis. 0, 1 or 2. */
function setWhimsy(level) {
  const n = clampWhimsy(level);
  if (n === current.whimsy) return;
  // Hand-set values for tokens this axis owns would outrank the new level
  // (they are inline), so they go back to the stylesheet.
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

/**
 * Take the sheet again at the level the axis has just moved to.
 *
 * The paper is a function of the axis as well as of the pictures - the plain
 * end wants a nearly white sheet whatever the photographs said, see PLAIN_PAPER
 * in pigments.js - and these tokens are written inline, so no stylesheet rule
 * can answer for them. Without this, moving the slider changed the shapes and
 * the type and left the board wearing the sheet the old level asked for.
 *
 * A board on a named palette has nothing inline and needs nothing done: the
 * [data-whimsy] blocks in tokens.css are the whole story there.
 */
function reshade() {
  if (!PALETTE_TOKENS.some(key => key in current.vars)) return;
  if (autoOn(current)) {
    recolourFromBoard({ silent: true }).catch(() => {});
    return;
  }
  // Off, with a colour somebody picked by hand: the pick stands and the sheet
  // is rebuilt around it, exactly as picking it did.
  const sheet = current.vars['--accent']
    ? paletteFromAccent(current.vars['--accent'], { plain: current.whimsy === HARSH })
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

/**
 * The two things a move along the axis changes that a custom property cannot.
 *
 * The first is the grid. canvas/grid.js draws a cross at the plain end where
 * the other levels get a dot, and it composes that in JS on view change rather
 * than leaving it to the stylesheet - so the marks would keep their old shape
 * until the next pan unless the move is announced. 'settings' is the event
 * main.js already repaints the grid on, and the payload is honest rather than
 * invented: persist() has just rewritten board.settings.appearance.
 *
 * The second is Desktop snapping. Harsh is the level where the Desktop board
 * stops being a scrapbook and starts being a drawing, and things landing on
 * the lattice is part of that. Mobile begins snapped independently and, once
 * created, only its own checkbox may change that setting.
 *
 * Worth naming the straddle, because it is the one place this module reaches
 * outside appearance: whimsy follows the *user* across boards, while `snap` is
 * board state and travels inside someone else's .mbrd. Crossing that line is
 * reserved for a deliberate move of the slider, which is why this is called
 * from the two places the user moves it and never from apply() - applying a
 * look on boot, or when a loaded board brings its own, must leave the snap
 * setting that arrived with that board exactly as saved, and must not mark a
 * board dirty before it has been touched.
 */
function axisMoved(level) {
  if (whimsyControlsSnap(board.layoutMode)) setSetting('snap', level === HARSH);
  // setSetting is silent when the value already matches, and it often will:
  // whenever the checkbox was hand-toggled to where the new level wants it, or
  // the move was between two levels that agree about snapping. So the repaint
  // is signalled in its own right rather than left riding on snap changing.
  bus.emit('settings', 'appearance');
}

/**
 * Replace the pigments wholesale - the hook for palettes derived from the
 * pictures on the board. Pass any subset of the pigment tokens.
 */
export function setPigments(vars) {
  // The named palette is deliberately left alone, field and attribute both.
  //
  // PALETTE_TOKENS covers every token the [data-palette] blocks in tokens.css
  // declare - checked, not assumed: the blocks set thirteen, and SHEET plus
  // PIGMENT plus --leafy are those same thirteen. So an extraction overrides the
  // named palette completely and nothing leaks through from underneath, which
  // is what makes it safe to leave standing. And leaving it standing is what
  // gives the switch something to fall back to: turning the extraction off hands
  // the sheet back to the palette that was chosen, rather than to Papyrus.
  //
  // Through the same filter as anything else, because the eventual caller is
  // pigments read out of whatever pictures were dropped on the board.
  for (const [key, value] of Object.entries(safeVars(vars))) {
    current.vars[key] = value;
    root.style.setProperty(key, value);
    applied.add(key);
  }
  // Marked as the machine's work, which is what lets the next import replace it
  // without asking. Set after the loop rather than before, so a call that
  // filtered down to nothing does not claim a look it did not write.
  if (Object.keys(current.vars).length) current.derived = true;
  paintThemeColour();
  persist();
  syncControls();
  followFade();
}

/** How long a fade lasts if --dur-palette cannot be read. */
const FADE_MS = 700;

let fadeEnd = 0, fading = false;

/**
 * Repaint the board for the length of a palette fade.
 *
 * The panel and the sheet fade on their own - they are CSS, reading registered
 * custom properties that the engine now interpolates, see tokens.css. The board
 * is a canvas and cannot: canvas/grid.js resolves its ink once and holds it,
 * because reading computed style per frame is the thing that function exists to
 * avoid. So the fade is the one time it has to be asked repeatedly, and this
 * asks - onChange() is what drops the cached ink and repaints.
 *
 * Re-entrant on purpose: a second change part-way through the first simply
 * pushes the end back rather than starting a second loop.
 */
function followFade() {
  if (typeof requestAnimationFrame !== 'function') return;
  // Nothing to follow when the reader asked for less motion - app.css cuts every
  // duration to a hundredth of a millisecond - but the loop is still entered for
  // one frame, because the settle at the end of it is not decoration. See below.
  const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const raw = getComputedStyle(root).getPropertyValue('--dur-palette').trim();
  const ms = raw.endsWith('ms') ? parseFloat(raw)
    : raw.endsWith('s') ? parseFloat(raw) * 1000 : NaN;
  fadeEnd = performance.now() + (still ? 0 : Number.isFinite(ms) ? ms : FADE_MS);
  if (fading) return;
  fading = true;
  // Everything else stops animating for the length of this - see .is-fading in
  // tokens.css. A button with a transition of its own is a second animation
  // reading the same colour, and the two crossing is what flashes.
  if (!still) root.classList.add('is-fading');
  const step = () => {
    onChange();
    // The swatch travels with the board rather than jumping at either end of
    // the fade, which costs one assignment a frame and is the honest picture:
    // the value it is showing really is the value the interface is painted in
    // at that instant.
    paintPigment();
    if (performance.now() < fadeEnd) requestAnimationFrame(step);
    else {
      fading = false;
      root.classList.remove('is-fading');
      settle();
    }
  };
  requestAnimationFrame(step);
}

/**
 * Read the finished look back into the panel and the title bar.
 *
 * This exists because of one property of the fade, and it is the kind of thing
 * that is obvious only once it has cost you an afternoon: the pigment tokens
 * are registered with @property and transitioned on :root, so
 * getComputedStyle() does not report what they were *set* to - it reports where
 * the animation has got to. Every caller here changes a colour and then
 * immediately reads it back, which is the one moment in the whole 700ms when
 * the answer is still the previous palette.
 *
 * So the swatch under "Pigment" showed the colour you had just left, the theme
 * bar of an installed PWA wore the paper before last, and both stayed that way
 * until the next change pushed them one step further behind. Reading again once
 * the transition has landed is the fix, and there is no synchronous way to ask
 * for the target value instead.
 *
 * Every caller keeps its own immediate syncControls(): radii, faces, durations
 * and the menus are not animated and want to be right now, not in 700ms.
 */
function settle() {
  paintThemeColour();
  syncControls();
}

/** The pigment swatch alone, which is the only animated control in the panel. */
function paintPigment() {
  const entry = inputs.get('--accent');
  if (!entry) return;
  // Never onto an input somebody is inside: a colour picker being assigned to
  // while its own dialog is open is how a value jumps back under the pointer.
  // A hand-picked colour is not a fade anyway - setVar() writes it straight.
  if (document.activeElement === entry.input) return;
  const now = toHex(getComputedStyle(root).getPropertyValue('--accent').trim());
  if (now) entry.input.value = now;
}

/**
 * Turn the extraction on or off.
 *
 * This is the whole gate. It used to be inferred - "has anybody been in here by
 * hand?" - which meant the honest answer to "will importing a photograph
 * repaint my board?" was a paragraph about provenance. A switch the user can
 * see is a better answer than a rule they have to be told, and it also settles
 * the case the inference got wrong in both directions: somebody who wants their
 * hand-tuned board recoloured anyway can now say so, and somebody who never
 * wanted it is not relying on having happened to touch a slider.
 *
 * Turning it on extracts immediately. Waiting for the next import would mean
 * the switch appeared to do nothing, which is indistinguishable from broken.
 *
 * Turning it off hands the sheet back to the palette named in the menu above.
 * It used to leave the extracted colours standing on the grounds that they were
 * the board's colours by then - which left the switch looking broken from the
 * other direction: unticking "take colours from the pictures" and watching the
 * board go on wearing the pictures' colours is not an answer anybody reads as
 * "off", and the way back was a menu the user had to know to go and use.
 *
 * Every pigment goes, not only the ones this module can prove it wrote. The
 * `derived` flag was the obvious guard and the wrong one: a look carried in
 * from an older version, or from somebody else's .mbrd, holds pigment tokens
 * with no flag on them at all - and on exactly those boards the switch did
 * nothing, which is the report that found this. "Return to the palette in the
 * menu" has to mean that on every board or it means nothing on any of them.
 * Type, radius and the rest of the look are untouched; this is a colour switch.
 */
function setAutoPalette(on) {
  if (on) delete current.auto;
  else {
    current.auto = false;
    dropPigments();
  }
  persist();
  syncControls();
  if (on) recolourFromBoard().catch(() => {});
}

/**
 * Take every extracted pigment back off and let the named palette answer again.
 *
 * The named palette is still on :root as [data-palette] and has been underneath
 * the whole time - so removing the inline tokens is the whole of the way back,
 * and paintThemeColour() re-reads the sheet that is now showing. Returns
 * whether anything was actually there to remove.
 */
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

/**
 * The pictures the palette is taken from, newest first.
 *
 * Newest first because a board that grows past MAX_SOURCES should follow what
 * is being added to it rather than stay pinned to whatever was dropped first.
 *
 * The covers count as pictures. A board of audio cards is a board full of album
 * art, and reading the sleeve of every record on it is exactly what somebody
 * pressing the button means.
 */
function pictureURLs() {
  const urls = [];
  for (const it of [...board.items].reverse()) {
    // Pictures only, named explicitly rather than taken from itemHashes(): that
    // helper also returns a video's or an audio file's asset, and handing those
    // to an <img> costs a decode that fails and a source slot that produced no
    // vote. A video's cover art is still wanted, and is picked up below.
    const hash = it.type === 'image' ? it.asset?.hash : null;
    for (const h of [hash, it.meta?.cover]) {
      const url = h && assetURL(h);
      if (url) urls.push(url);
    }
  }
  return urls;
}

/**
 * The pictures an extraction would actually read, as one comparable string.
 *
 * Sliced to MAX_SOURCES, because the question this answers is "would running
 * the extraction again give a different answer?" and a picture past the cap is
 * never read. Order is part of it: the same twelve pictures reordered so that a
 * different one falls off the end are a different twelve.
 */
function sourceKey() {
  return pictureURLs().slice(0, MAX_SOURCES).join('\n');
}

/** The pictures the palette standing on screen was taken from - see sourceKey(). */
let lastSources = null;

/** The last reason an automatic run gave up, so it is said once and not on loop. */
let lastFailure = null;

/**
 * Take the colours off the board's own pictures.
 *
 * Quiet about *success* when it fires itself after the board changes, loud when
 * the switch asks for it: an edit that repaints the board has already shown you
 * what it did, while the switch was turned on by somebody waiting for an answer.
 *
 * Failure is announced either way, which it was not, and that cost an evening:
 * a switch sitting on with nothing happening looks identical to a switch that
 * is on and working on a board whose palette happens to be stable. Said once
 * per reason - `lastFailure` - so a board that genuinely has no colour in it
 * does not nag on every single edit.
 */
async function recolourFromBoard({ silent = false } = {}) {
  const urls = pictureURLs();
  // Recorded before the pixels are read, not after: the answer to "which
  // pictures is the palette standing on" is these, whatever they turn out to
  // say. Recording it afterwards would leave a board whose pictures have no
  // colour in them re-running the whole extraction on every subsequent edit.
  lastSources = sourceKey();
  const failed = why => {
    if (!silent || lastFailure !== why) toast(why);
    lastFailure = why;
    return false;
  };
  // One picture is enough now, where the silent version of this wanted three.
  // That floor existed because the feature fired unasked and a whole interface
  // turning over on a single dropped file reads as a fault; asked for by a
  // switch, it is the thing that was asked for, and refusing until the third
  // photograph arrives is the fault.
  // An empty board has no colours of its own, so it stops wearing the ones it
  // used to have. Leaving them standing was defensible while they were "the
  // board's colours now" - but on a board you have just cleared they are the
  // colours of pictures that are not there, which is the one case where the
  // palette is provably not a representation of anything.
  if (!urls.length) {
    if (dropPigments()) {
      persist();
      syncControls();
      return failed('No pictures left - back to the chosen palette');
    }
    return failed('No pictures on the board to take colours from');
  }

  const pixels = await samplePixels(urls);
  // One line per attempt, in the house style of main.js's "ready". This is a
  // feature whose every failure mode is a picture quietly not being read, and
  // the count of pictures found against pictures actually decoded is the whole
  // diagnosis - without it the answer to "why has nothing changed?" is a
  // browser-by-browser guess, which is exactly what it was.
  console.info(`[mbrd] palette: ${urls.length} picture${urls.length === 1 ? '' : 's'} on the board, ${pixels.length} read`);
  // Told apart from "no colour in them" on purpose. Pictures that are on the
  // board and cannot be read at all is a fault in this app, not a fact about
  // the photographs, and the two failures used to arrive as one message.
  if (!pixels.length) return failed(`Could not read ${urls.length === 1 ? 'the picture' : 'any of the pictures'} on the board`);

  const vars = extractPalette(pixels, { plain: current.whimsy === HARSH });
  if (!vars) return failed('No colour to take from these pictures');
  lastFailure = null;
  // The hues, not only the swatches: "is this the colour of my photographs?" is
  // the question this feature is actually judged on, and two hex codes do not
  // answer it. Read back off the palette rather than passed out of the
  // extractor, so it costs nothing and cannot disagree with what was applied.
  const hueOf = c => Math.round(oklch(...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))).h);
  console.info(`[mbrd] palette: sheet ${vars['--paper']} (hue ${hueOf(vars['--paper'])}), `
    + `accent ${vars['--accent']} (hue ${hueOf(vars['--accent'])}), `
    + `wash ${vars['--leafy']} (hue ${hueOf(vars['--leafy'])})`);
  // Nothing written when the answer has not moved. Deleting one of twelve
  // pictures usually leaves the same hues standing, and setPigments() persists
  // - which marks the board dirty - so an extraction that agrees with what is
  // already on screen would flag a board as edited for having been recounted.
  const moved = Object.entries(vars).some(([k, v]) => current.vars[k] !== v);
  if (moved) setPigments(vars);
  if (!silent) toast('Palette taken from the pictures');
  return true;
}

/**
 * Back to how the app ships: Middle, Papyrus, no overrides, extraction on.
 *
 * The look object is replaced rather than edited, so every key goes with it -
 * including `auto` and `derived`, which is what puts the extraction switch back
 * on, since autoOn() reads an absent flag as on.
 *
 * And on is a promise the board then has to keep. Leaving it there would say
 * "colours come from the pictures" over a Papyrus sheet taken from none of
 * them, and it would stay that way until the next import happened to move the
 * source list - the extraction remembers what it last read, so the same twelve
 * pictures are not counted twice. That memory is part of what is being reset,
 * so it goes too, and the count runs again. On a board with no pictures there
 * is nothing to run and Papyrus is the answer already.
 *
 * Silent because this is a button about the whole look rather than about
 * colour: somebody straightening the shapes and the type does not need a toast
 * explaining that the photographs they have not added yet have no colours in
 * them.
 */
export function resetAppearance() {
  const was = current.whimsy;
  // apply() takes the previous look's properties back off - see `applied`.
  current = {
    whimsy: DEFAULT_WHIMSY,
    palette: '',
    vars: board.layoutMode === 'mobile' ? { ...MOBILE_APPEARANCE_VARS } : {},
  };
  apply(current);
  persist();
  syncControls();
  // Reset is the other way out of a level, so it owes the axis the same
  // announcement - but only when it actually moved. Guarded rather than
  // unconditional so that resetting the pigments while already at the middle
  // is not also a silent way to switch someone's snapping off.
  if (was !== DEFAULT_WHIMSY) axisMoved(DEFAULT_WHIMSY);
  lastSources = null;
  lastFailure = null;
  recolourFromBoard({ silent: true }).catch(() => {});
}

// ---------------------------------------------------------------------------

/**
 * Everything this module has written inline on :root.
 *
 * Kept because applying a look has to *replace* one, not add to it. An inline
 * property beats every stylesheet rule and nothing takes it back off, so a look
 * that simply set its own tokens left the previous one's behind: a board with a
 * hand-picked --accent went on tinting the next board that never asked for one,
 * and the controls would show the palette's value while the stale inline
 * property was what you could actually see.
 */
let applied = new Set();

function apply(look) {
  // Always written, including the default: the stylesheet's base *is* the
  // middle, so an absent attribute already means 1 - but 0 is a real level
  // with its own rules, and leaving the attribute off for it would silently
  // land on the middle instead.
  root.dataset.whimsy = look.whimsy;
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
  // Every other way a look changes wholesale - the palette menu, the axis, a
  // board arriving with its own colours - and each of them is a change the
  // canvas has to be walked through as well. Free at boot: main.js has not
  // wired onChange() yet, so the loop runs against a no-op.
  followFade();
}

/**
 * Say whether the display face is a sans, for the one rule that cares.
 *
 * The wordmark is set as heavy as the face allows when it is a sans and left at
 * 400 when it is not - see `.wordmark h1` in app.css. CSS cannot ask what
 * family it ended up with, so the question is answered here and left on :root
 * as an attribute.
 *
 * The test is the *last* family in the stack, which is the one thing in a font
 * stack that is always a promise about the kind of face rather than the name of
 * one: every sans entry in the menus ends `sans-serif` and every serif entry
 * ends `serif`, and customFaces() appends `system-ui, sans-serif` to a dropped
 * face for exactly that reason. Read off the computed value rather than off
 * `current.vars`, because most of the time nobody has chosen a face at all and
 * the answer belongs to the whimsy level.
 *
 * Derived state, deliberately not a token: it is a fact *about* the look rather
 * than part of it, so it is recomputed on every change and never persisted,
 * never exported, and never carried inside somebody else's .mbrd.
 */
function markDisplayFace() {
  const stack = getComputedStyle(root).getPropertyValue('--font-display');
  if (/sans-serif\s*$/i.test(stack.trim())) root.dataset.displaySans = '';
  else delete root.dataset.displaySans;
}

/**
 * The installed-PWA title bar takes the paper colour, which moves with the
 * palette, the axis and any hand-set override - so it is repainted from the
 * computed value rather than left at whatever Papyrus happened to be when
 * index.html was written.
 */
function paintThemeColour() {
  if (!themeColour) return;
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
  if (paper) themeColour.setAttribute('content', paper);
}

function persist() {
  writePref(STORE_KEY, JSON.stringify(current));
  setAppearance(clone(current));
  onChange();
}

function setVar(name, value) {
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
    syncAutoBox();
  }
  if (value === '') {
    delete current.vars[name];
    root.style.removeProperty(name);
    applied.delete(name);
    persist();
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
    ? paletteFromAccent(value, { plain: current.whimsy === HARSH }) : null;
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
  persist();
}

function readStored() {
  return clone(readPrefJSON(STORE_KEY));
}

// Compared against the default rather than tested for truthiness: whimsy 0 is
// Softish, a deliberate choice, and `!0` would file a board saved at that end of
// the axis as having brought no look at all.
const hasLook = look =>
  !!look && ((look.whimsy != null && +look.whimsy !== DEFAULT_WHIMSY) ||
             look.palette || Object.keys(look.vars || {}).length);
/**
 * A level the stylesheet actually answers to.
 *
 * Clamped, not trusted: this value arrives from localStorage, from the slider,
 * and from other people's .mbrd files, and an out-of-range one would set a
 * data-whimsy no rule matches - leaving the interface in whatever the base look
 * is while the slider claims otherwise. `|| 0` catches the non-number, since
 * clamping NaN only gives NaN back.
 */
const clampWhimsy = v => clamp(Math.round(+v) || 0, 0, WHIMSY.length - 1);

// Every look in this module - the user's stored one, the one a board brought,
// the one a control just edited - is built here, which is what makes this the
// one place the rules have to hold. `vars` is filtered rather than rejected
// wholesale: a board with one bad token should lose that token, not its look.
const clone = look => withProvenance(look, {
  whimsy: look?.whimsy == null ? DEFAULT_WHIMSY : clampWhimsy(look.whimsy),
  // Becomes an attribute value that stylesheet rules match on, so it is held to
  // the shape a palette name has rather than trusted to be one.
  //
  // The typeof guard is load-bearing, not defensive padding. RegExp.test()
  // coerces its argument to a string, and `String(undefined)` is "undefined" -
  // twenty-four lowercase letters, which this pattern happily matches. So a
  // `look` of null took the true branch and then threw on `look.palette`, and
  // clone(null) is not a hypothetical: readStored() calls it with whatever
  // readPrefJSON returns, which is null on any browser that has never saved a
  // preference. A fresh profile therefore threw inside initAppearance() before
  // it had built a single control - the palette menu, the whimsy slider and
  // every token control were dead on a first visit, and only a first visit.
  palette: typeof look?.palette === 'string' && /^[a-z0-9-]{1,24}$/i.test(look.palette)
    ? look.palette : '',
  vars: safeVars(look?.vars),
});

/**
 * The two fields of a look that are not tokens.
 *
 * Neither is ever applied to :root - they describe the look rather than being
 * part of it - but both have to survive clone(), because clone() is what every
 * look in this module passes through. A flag dropped here is dropped on every
 * save, every reload and every board that travels with an extracted palette.
 *
 *   derived  who wrote these pigments. Provenance, set by setPigments() and
 *            cleared the moment a pigment is set by hand. Only wirePalette()
 *            reads it, to decide whether switching palette drops two tokens or
 *            all fourteen.
 *   auto     whether to take the colours again on the next import. The user's
 *            setting, and the only thing the switch writes.
 *
 * `auto` is stored inverted - present and false means off, absent means on -
 * because on is the default. A board that has never been near this setting has
 * no field for it, and that has to mean the same thing as a board that was
 * switched on, or the default would only apply to boards made after it changed.
 * The only value written is `false`; turning it back on deletes the field.
 *
 * Both are held to an exact value, and `derived` additionally to there being
 * something for it to be true *of* - so a .mbrd claiming a derived look with no
 * pigments in it cannot make the palette menu throw away tokens it never wrote.
 */
function withProvenance(from, look) {
  if (from?.derived === true && Object.keys(look.vars).length) look.derived = true;
  if (from?.auto === false) look.auto = false;
  return look;
}

/** Whether the extraction is on. Absent means on - see withProvenance(). */
const autoOn = look => look?.auto !== false;

// Both sides put through clone() first, which is what makes a string compare
// safe here: it fixes the key order. `current` is mutated in place all over this
// module - setPigments() adds `derived` at the end, the switch adds `auto` -
// so two looks that are equal can serialise differently depending on which flag
// happened to be set second, and this would then re-apply a look identical to
// the one already on screen every time the board emitted an event.
const sameLook = (a, b) => JSON.stringify(clone(a)) === JSON.stringify(clone(b));

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const inputs = new Map();

function buildControls() {
  const hosts = {};
  for (const [name, id] of Object.entries(HOSTS)) {
    const node = document.getElementById(id);
    if (node) { node.replaceChildren(); hosts[name] = node; }
  }
  if (!Object.keys(hosts).length) return;

  for (const c of CONTROLS) {
    const host = hosts[c.host];
    if (!host) continue;
    const label = document.createElement('label');
    label.className = 'field';

    const head = document.createElement('span');
    const text = document.createElement('span');
    text.textContent = c.label;
    const out = document.createElement('output');
    head.append(text, out);

    // A <select> rather than an <input>, and 'change' rather than 'input',
    // because a face is a choice from a list and not a value on a scale.
    const input = c.type === 'font' ? document.createElement('select')
                                    : document.createElement('input');
    if (c.type === 'font') {
      // The board's own faces first, above the shipped list: a face somebody
      // went and dropped in is the one they are looking for, and burying it
      // under six they did not choose is how a feature reads as missing.
      const faces = [...c.options];
      const own = customFaces();
      if (own.length) faces.splice(1, 0, ...own);
      for (const f of faces) {
        const opt = document.createElement('option');
        opt.value = f.value;
        opt.textContent = f.label;
        // Each name set in the face it names, so the list is the comparison
        // rather than a legend for one. Costs nothing: every stack here is
        // already loaded or already on the machine.
        if (f.value && !f.value.startsWith('var(')) opt.style.fontFamily = f.value;
        input.append(opt);
      }
      input.addEventListener('change', () => setVar(c.var, input.value));
    } else {
      input.type = c.type === 'color' ? 'color' : 'range';
      if (c.type === 'range') {
        input.min = c.min; input.max = c.max; input.step = c.step;
      }
      input.addEventListener('input', () => {
        const value = c.type === 'color' ? input.value : input.value + (c.unit || '');
        out.textContent = c.type === 'color' ? '' : format(input.value, c);
        setVar(c.var, value);
      });
    }

    label.append(head, input);
    host.append(label);
    inputs.set(c.var, { input, out, label, spec: c });
  }
  syncControls();
}

function syncControlVisibility() {
  for (const [name, { label }] of inputs) {
    label.hidden = !appearanceControlVisible(name, board.layoutMode);
  }
}

function syncControls() {
  syncControlVisibility();
  const computed = getComputedStyle(root);
  for (const [name, { input, out, spec }] of inputs) {
    const raw = (current.vars[name] ?? computed.getPropertyValue(name)).trim();
    if (spec.type === 'font') {
      // Read off `current.vars` alone, never off the computed value. The
      // computed one is whatever the whimsy level resolved to, which is a stack
      // that matches no option here and would select nothing - where '' is a
      // real state with a real entry: the level still has the type.
      input.value = current.vars[name] ?? '';
      out.textContent = '';
    } else if (spec.type === 'color') {
      input.value = toHex(raw) || '#000000';
      out.textContent = '';
    } else {
      const n = parseFloat(raw);
      input.value = Number.isFinite(n) ? n : spec.min;
      out.textContent = format(input.value, spec);
    }
  }
  const paletteSel = document.getElementById('opt-palette');
  if (paletteSel) paletteSel.value = current.palette || '';

  const whimsy = document.getElementById('opt-whimsy');
  if (whimsy) whimsy.value = current.whimsy;

  syncAutoBox();
}

/**
 * The switch on its own, because setVar() can turn it off and must not run the
 * full sync to say so.
 *
 * syncControls() writes every control's value back from the look, including the
 * colour input that is mid-drag when this fires - and a colour picker being
 * assigned to while the pointer is down is how you get a value that jumps back
 * a frame after each move. The checkbox is the only thing that changed, so the
 * checkbox is the only thing rewritten.
 */
function syncAutoBox() {
  const box = document.getElementById('opt-auto-palette');
  if (box) box.checked = autoOn(current);
}

function wireAutoPalette() {
  const input = document.getElementById('opt-auto-palette');
  if (!input) return;
  input.checked = autoOn(current);
  input.addEventListener('change', () => setAutoPalette(input.checked));
}

function wireWhimsy() {
  const input = document.getElementById('opt-whimsy');
  if (!input) return;
  input.max = WHIMSY.length - 1;
  input.value = current.whimsy;
  input.addEventListener('input', () => setWhimsy(input.value));
}

function format(value, spec) {
  const n = parseFloat(value);
  // Match the readout's precision to the slider's step, so a 0.1px grid weight
  // doesn't display as a flat "2px" through its whole range.
  const decimals = spec.step >= 1 ? 0 : String(spec.step).split('.')[1].length;
  return n.toFixed(decimals) + (spec.unit || '');
}

function wirePalette() {
  const sel = document.getElementById('opt-palette');
  if (!sel) return;
  sel.value = current.palette || '';
  sel.addEventListener('change', () => {
    // A palette switch replaces the pigments wholesale, so per-token colour
    // tweaks are dropped - otherwise the old accent would stick to the new
    // paper and every palette after the first would look muddy.
    //
    // Two of them when they were hand-picked, because those are the two the
    // panel offers and dropping more would throw away something the user cannot
    // see to put back. All thirteen when they were extracted from photographs,
    // because a derived look is not a set of tweaks to keep on top of a chosen
    // palette - it *is* a palette, and leaving eleven of its tokens inline
    // would leave the named one outvoted on its own sheet.
    for (const key of current.derived ? Object.keys(current.vars) : ['--accent', '--paper']) {
      delete current.vars[key];
      root.style.removeProperty(key);
    }
    delete current.derived;
    // Choosing a palette by name is a decision about colour, and it takes the
    // switch with it for the same reason picking a pigment by hand does - see
    // setVar(). This is also the way back from an extracted palette: it is the
    // one control that drops all fourteen tokens at once.
    current.auto = false;
    current.palette = sel.value;
    apply(current);
    persist();
    syncControls();   // computed colours changed under us
  });
}

/**
 * Normalise whatever the browser reports for a colour token into #rrggbb, which
 * is the only thing <input type="color"> accepts.
 */
function toHex(value) {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const [r, g, b] = m[1].split(/[\s,/]+/).map(Number);
    return '#' + [r, g, b].map(n => clamp255(n).toString(16).padStart(2, '0')).join('');
  }
  // color(), oklch(), a named colour: round-trip it through a canvas.
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillStyle = v;
    const out = ctx.fillStyle;
    return /^#[0-9a-f]{6}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

const clamp255 = n => clamp(Math.round(n || 0), 0, 255);
