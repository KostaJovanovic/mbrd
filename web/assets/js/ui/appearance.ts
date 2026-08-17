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
} from '../state.ts';
import { autoPaletteReady, whimsyControlsSnap, AXIS_TOKENS } from '../layout-settings.ts';
import { readToken } from '../util.ts';
import { oklch, parseHex } from '../color.ts';
import { toast } from '../notify.ts';
import { readPrefJSON, writePref } from '../prefs.ts';
import { assetURL, getAsset } from '../storage/assets.ts';
import {
  extractPalette, paletteFromAccent, samplePixels, MAX_SOURCES, PALETTE_TOKENS,
} from './pigments.ts';
// What a board is allowed to ask for, and what a look *is*. Kept in its own
// module because this one touches document at import time and that one must
// stay testable - see look.ts. The model half moved there in the same spirit:
// clone, the two provenance flags and the equality are arithmetic over a plain
// object, and none of them has any business needing a browser.
import {
  safeVars, cloneLook, sameLook, hasLook, autoOn, clampWhimsy, WHIMSY, DEFAULT_WHIMSY,
} from './look.ts';

import {
  initAppearanceControls, buildControls, syncControls, syncControlVisibility,
  syncPaletteMode, syncPaletteSources, wirePaletteSources,
  wireWhimsy, wirePalette, inputs, toHex,
} from './appearance-controls.ts';
import { legacyBlends } from './legacy-color.ts';
import type { ControlSpec, Look } from './appearance-controls.ts';

// Re-exported under its old name because this is where the rest of the app has
// always asked for it, and moving the declaration is not a reason to make every
// caller say so. The stops themselves are a property of the look model, not of
// the panel that draws them.
export { WHIMSY };

const STORE_KEY = 'mbrd.appearance';

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
  // The two bundled serifs, in the order the axis reaches for them: Playfair is
  // the middle's display face, Fraunces the soft end's. Both are offered at
  // every level for the reason given below - comparing one serif across all
  // three tiers is the point - and offering only whichever the current tier
  // already resolves to would make "Default" and one entry the same choice.
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
  // The soft end of the axis does exactly this. Offered at every level so the
  // one-voice setting can be tried without moving the slider to get it.
  { label: 'Same as display',      value: 'var(--font-display)' },
];

/**
 * The curated set of tokens worth exposing. Everything else stays internal.
 *
 * `host` files each control into one of three places in the panel:
 *
 *   type      the paired row of face menus, side by side. Above the fold, with
 *             Whimsy and Palette - the display serif is the loudest decision on
 *             a board, and a face dropped onto the board itself lands in this
 *             menu, which made a working feature unfindable while it was hidden.
 *   main      the pigment, which moves the whole sheet. Inside the fold.
 *   advanced  the sliders, for the ones you set once and then leave. Also inside.
 *
 * Whimsy, Palette and the faces are the section above the fold, and nothing else
 * here joins them. Between those three they already move every token this list
 * sets one at a time - which is the argument for the split: the rest are the
 * controls for when the dials did not land where you wanted, not the ones you
 * start with.
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
const CONTROLS: ControlSpec[] = [
  // "Display font" and "Body font", not "Display" and "Body". The two sit side
  // by side in one .field-pair and the shorter words read as a pair of
  // categories - display *what*, body *what* - where the panel around them is
  // otherwise a list of nouns you set. The extra word costs nothing: the pair
  // is a grid of two equal minmax(0, 1fr) columns, so the <select> under each
  // label sets the column width and a longer label cannot push it.
  { var: '--font-display', label: 'Display font', type: 'font', options: DISPLAY_FACES, host: 'type' },
  { var: '--font-body',    label: 'Body font',    type: 'font', options: BODY_FACES,    host: 'type' },
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

  // Hand the panel what it borrows from this module. First, before anything
  // below can call into it. `current` goes through as a getter rather than by
  // value because the four sites below reassign it - a board arriving replaces
  // the whole look - and a captured reference would go stale on the first open.
  initAppearanceControls({
    CONTROLS, HOSTS, WHIMSY, ALL_SOURCES_STOP,
    current: () => current,
    setVar, setWhimsy, setPalette, goDynamic, sourceCount, dynamicOn,
  });

  // The other half of the throttled preference write - see storeLook(). pagehide
  // rather than beforeunload, which iOS Safari does not reliably fire, and
  // visibilitychange as well, because a tab discarded in the background never
  // gets either of the unload events.
  addEventListener('pagehide', flushLook);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLook();
  });

  const stored = readStored();
  // A board's own look wins when it brought one; otherwise fall back to the
  // user's saved preferences.
  const fromBoard = board.settings.appearance;
  current = hasLook(fromBoard) ? cloneLook(fromBoard) : stored;
  apply(current);

  buildControls();
  wirePalette();
  wirePaletteSources();
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

  // While the extraction is allowed, the palette follows whatever is on the
  // board rather than staying at whatever the pictures said the first time.
  // Every way that set can change goes through 'items': a picture arriving, a
  // picture deleted, the undo of either, and everything the bin does. Deleting
  // used to be the gap - a colour thrown off the board went on tinting the board
  // it was thrown off, which is the one case where the palette is demonstrably
  // not a representation of the pictures any more.
  bus.on('items', autoRecolour);

  // Turning the "how many pictures" dial changes which pictures the palette is a
  // representation of, so it re-derives - on the same terms as an edit.
  // syncPaletteSources() keeps the slider itself in step; this is the colour
  // half of the same change.
  bus.on('settings', key => {
    if (key !== 'paletteSources') return;
    syncPaletteSources();
    autoRecolour();
  });

  // A face arrived, or a board load changed which ones are registered. The
  // menus are built from a list that just changed under them, so they are built
  // again - syncControls() at the end of buildControls() puts the current
  // choice back, including a choice the new list has just made selectable.
  bus.on('fonts', () => buildControls());

  const syncFromBoard = () => {
    const look = board.settings.appearance;
    const next = hasLook(look) ? cloneLook(look) : readStored();
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

/**
 * Slide the whole interface along the playful-to-plain axis. 0, 1 or 2.
 *
 * Exported so main.js can hang it on `cmds`, which is how the dial on the
 * fourth ghost card reaches it: that card is built under canvas/, which may not
 * import this module (the layering test), so it goes through the command
 * surface like every other user-facing action.
 */
export function setWhimsy(level: number | string) {
  const n = clampWhimsy(level);
  if (n === current.whimsy) return;
  // Hand-set values for tokens this axis owns would outrank the new level
  // (they are inline), so they go back to the stylesheet.
  //
  // With one exception the axis cannot win, and it is worth naming rather than
  // leaving as a puzzle: on Mobile the grid pair comes back. normalizeSettings()
  // spreads MOBILE_APPEARANCE_VARS *under* a board's saved vars on every read,
  // so --grid-alpha and --grid-dot are re-injected as a floor the next time the
  // board is normalised. That is deliberate on the Mobile side -
  // whimsyControlsSnap() says the same thing about snapping, that Mobile's grid
  // is a layout setting with its own control - so the deletion here is a no-op
  // there rather than a fight. Removing them from AXIS_TOKENS would be worse:
  // Desktop does want the axis to own them.
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
  // Every pair is a token name and the colour to write.
  //
  // There was an `as [string, string][]` here and at the second copy of this
  // loop below, each under a comment saying ui/pigments.js "still carries its
  // migration pragma, so the token map it builds types as an empty object".
  // That pragma is gone - tests/ts-debt.js counted the migration to zero - and
  // the assertion it justified was doing nothing.
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
function axisMoved(level: number) {
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
export function setPigments(vars: Record<string, string>) {
  // The named palette is deliberately left alone, field and attribute both.
  //
  // PALETTE_TOKENS covers every token the [data-palette] blocks in tokens.css
  // declare - checked, not assumed: the blocks set thirteen, and SHEET plus
  // PIGMENT plus --leafy are those same thirteen. So an extraction overrides the
  // named palette completely and nothing leaks through from underneath, which
  // is what makes it safe to leave standing. And leaving it standing is what
  // gives the menu something to fall back to: a board that stops colouring
  // itself hands the sheet back to the palette that was chosen before Dynamic
  // was, rather than to Papyrus.
  //
  // Through the same filter as anything else, because the eventual caller is
  // pigments read out of whatever pictures were dropped on the board.
  const clean = safeVars(vars);
  for (const [key, value] of Object.entries(clean)) {
    current.vars[key] = value;
    root.style.setProperty(key, value);
    applied.add(key);
  }
  // Marked as the machine's work, which is what lets the next import replace it
  // without asking. Counted on what this call actually wrote, not on the whole
  // var map - which is what the line above was doing, and which made the test
  // unconditional on Mobile: MOBILE_APPEARANCE_VARS puts --grid-alpha and
  // --grid-dot into `current.vars` on every Mobile board, so a call that
  // filtered down to nothing claimed a look it had not written. The comment
  // already said this was the thing being prevented.
  if (Object.keys(clean).length) current.derived = true;
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
  // Nothing to follow when the reader asked for less motion - the CSS cuts every
  // duration to a hundredth of a millisecond - but the loop is still entered for
  // one frame, because the settle at the end of it is not decoration. See below.
  const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const raw = readToken('--dur-palette');
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
    // try/finally, because `fading` and `.is-fading` are cleared only on the
    // loop's normal exit. onChange() is injected by main.ts and walks the
    // canvas; a throw out of it left `fading` true - so no later palette change
    // could ever restart the loop - and left `.is-fading` on :root, which
    // suppresses every transition in the app. One bad frame and the interface
    // stopped animating for the session.
    try {
      onChange();
      // The swatch travels with the board rather than jumping at either end of
      // the fade, which costs one assignment a frame and is the honest picture:
      // the value it is showing really is the value the interface is painted in
      // at that instant.
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
  // `.style.background`, not `.value`. The pigment control has been a <button>
  // since it stopped being an `<input type="color">` - syncControls() paints it
  // by setting its background - and this went on assigning `value`, a property
  // a button carries and never renders. So the per-frame paint over
  // --dur-palette did nothing at all, and the swatch jumped once at settle()
  // instead of travelling with the board, which is the opposite of what the
  // note above this pair says happens.
  //
  // The activeElement guard went with it, and that is right rather than an
  // omission: it was there for a native picker's own mid-drag value, and the
  // picker is a modal now with nothing to jump under.
  const now = toHex(readToken('--accent'));
  if (now) entry.input.style.background = now;
}

/**
 * Dynamic, chosen from the palette menu.
 *
 * This used to be a checkbox in the fold, below the menu, and the two of them
 * were one decision described twice: a board is set in Papyrus or in Absinthe or
 * in its own photographs, and being asked to pick a named palette and then to
 * say whether it counts is a question with a wrong answer in it. Absence rather
 * than disabling, the same rule the panel keeps everywhere else - so the entry
 * is the state, and the state has one control.
 *
 * Extracts immediately, and with no three-picture floor - unlike the automatic
 * path, see autoPaletteReady(). Waiting would mean the entry appeared to do
 * nothing, which is indistinguishable from broken, and this is somebody asking
 * for it out loud. On a board with fewer pictures than it can read a colour
 * from, recolourFromBoard() says so; that is a better answer than an entry that
 * refuses to be selected.
 */
function goDynamic() {
  delete current.auto;
  persist();
  syncControls();
  recolourFromBoard().catch(() => {});
}

/**
 * A named palette, chosen from the same menu. Also the only way out of Dynamic.
 *
 * Every pigment comes off, whoever wrote it. That is what makes a palette switch
 * a palette switch rather than a tint over the last one: an extracted look is
 * thirteen inline tokens, and leaving eleven of them standing would leave the
 * named palette outvoted on its own sheet.
 *
 * And *every* pigment, not only the ones this module can prove it derived. The
 * `derived` flag was the obvious guard and the wrong one: a look carried in from
 * an older version, or from somebody else's .mbrd, holds pigment tokens with no
 * flag on them at all - and on exactly those boards the way back did nothing,
 * which is the report that found it. A hand-picked accent needs no special case
 * either, because it is two of those same thirteen keys and deleting all
 * thirteen deletes exactly those two: the branch this replaces dropped every key
 * in `vars` on a derived look, which took a chosen display face with it.
 *
 * Type, radius and the rest of the look are untouched. This is a colour control.
 */
function setPalette(name: string) {
  dropPigments();
  // Choosing a colour by name is a decision about the same thing the extraction
  // decides, so it takes the extraction with it - the same way picking a pigment
  // by hand does, see setVar().
  current.auto = false;
  current.palette = name;
  apply(current);
  persist();
  syncControls();
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
 * The pictures the palette is taken from, newest first, as content hashes.
 *
 * Newest first because a board that grows past MAX_SOURCES should follow what
 * is being added to it rather than stay pinned to whatever was dropped first.
 *
 * The covers count as pictures. A board of audio cards is a board full of album
 * art, and reading the sleeve of every record on it is exactly what somebody
 * pressing the button means.
 *
 * Hashes rather than object URLs, and that is the whole of the difference from
 * the version this replaced. assetURL() *mints* a URL on first use and holds it
 * for the session, so walking the board to answer "has the picture set changed?"
 * created one blob URL per picture on the board - four hundred of them on a
 * four-hundred-photo board, whether or not any of them was ever rendered,
 * sampled or mounted, which is exactly the laziness storage/assets.js exists to
 * preserve and defeats canvas/items.js's discard() bookkeeping for anything
 * culled. A hash is a stable identity and costs nothing; the URLs are resolved
 * in recolourFromBoard(), for the handful actually read.
 */
function pictureHashes() {
  const hashes = [];
  for (const it of [...board.items].reverse()) {
    // Pictures only, named explicitly rather than taken from itemHashes(): that
    // helper also returns a video's or an audio file's asset, and handing those
    // to an <img> costs a decode that fails and a source slot that produced no
    // vote. A video's cover art is still wanted, and is picked up below.
    // **The preview first, where there is one.** An item is type 'image' from
    // the moment something drew a picture of it, and for a PDF, a HEIC or a RAW
    // the asset behind that card is not a picture at all - it is the document or
    // the camera file, and `meta.preview` names the rendered page or the
    // embedded JPEG the card is actually showing. Handing the original here is
    // a decode that cannot succeed and a source slot spent on it, and on a board
    // of nothing but PDFs it is every slot: the palette then reports "could not
    // read any of the pictures on the board" about a board whose every card is
    // showing one. It is also simply the wrong question - the palette is meant
    // to be the colours of what is on screen, and what is on screen is the
    // preview.
    //
    // Held to being a string on the way past, like the cover below it: `meta` is
    // open, and a preview key holding a number would otherwise reach getAsset().
    const shown = it.meta?.preview;
    const hash = it.type !== 'image' ? null
      : typeof shown === 'string' && shown ? shown
        : it.asset?.hash;
    for (const h of [hash, it.meta?.cover]) {
      // Registered, but not resolved: getAsset() is the same "are the bytes
      // here?" test assetURL() returning null used to stand in for. A cover out
      // of the open `meta` is held to being a string on the way past, which is
      // the same thing getAsset() answering nothing already did for it.
      if (typeof h === 'string' && getAsset(h)) hashes.push(h);
    }
  }
  return hashes;
}

/**
 * How many pictures the palette is read from: the board's own setting.
 *
 * Zero is the stop past the top of the dial and means every picture on the
 * board, which is Infinity here - it flows into slice() and into samplePixels()
 * as a limit that limits nothing. Anything else is held inside the sampler's
 * default ceiling, and an unset setting reads as that ceiling.
 */
function sourceCount() {
  const n = board.paletteSources;
  if (n === 0) return ALL_SOURCES_MAX;
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_SOURCES, n)) : MAX_SOURCES;
}

/**
 * What "every photo" actually costs, at most.
 *
 * The stop used to return Infinity, which flowed into `hashes.slice(0,
 * sourceCount()).map(assetURL)` - so one `items` event on a 400-photo board
 * with Dynamic on minted a blob URL for all four hundred pictures, and
 * storage/assets.ts caches those for the session with no per-hash release. That
 * defeats canvas/items.ts's discard() bookkeeping outright, and samplePixels()
 * then fetched and full-resolution-decoded all four hundred, one after another.
 * pictureHashes()'s own header says this must never happen, and the slice was
 * written to stop it.
 *
 * A number rather than Infinity, and it is a judgement: a palette read from a
 * hundred and twenty photographs is the same palette as one read from four
 * hundred - the hues have long since converged - and the difference is whether
 * a phone survives it. The stop still means "far more than the dial offers",
 * which is what somebody choosing it is asking for; it no longer means "however
 * many there are, whatever that costs".
 */
const ALL_SOURCES_MAX = 120;

/**
 * The slider position that means "every picture".
 *
 * One past the highest count, so the dial reads low-to-high all the way: more
 * pictures, more pictures, all of them. The value stored is 0, not this - see
 * normalizePaletteSources() in state.js for why a number cannot say "all".
 */
const ALL_SOURCES_STOP = MAX_SOURCES + 1;

/**
 * The pictures an extraction would actually read, as one comparable string.
 *
 * Sliced to the source count, because the question this answers is "would
 * running the extraction again give a different answer?" and a picture past the
 * count is never read. Order is part of it, and so is the count itself: the same
 * pictures with the dial turned down are a different, shorter list - which is
 * what makes turning the dial re-derive the palette.
 *
 * Hashes, so the key survives a clearAssets() that re-registers the same bytes -
 * the identity is the content, not whichever URL happens to be standing.
 *
 * The walk is a parameter so autoRecolour() can count the pictures and build the
 * key off one pass rather than two - it needs both, and 'items' is an event that
 * fires on every edit a board ever receives.
 */
function sourceKey(hashes = pictureHashes()) {
  return hashes.slice(0, sourceCount()).join('\n');
}

/** The pictures the palette standing on screen was taken from - see sourceKey(). */
let lastSources: string | null = null;

/** The last reason an automatic run gave up, so it is said once and not on loop. */
let lastFailure: string | null = null;

/**
 * Whether the board is wearing colours taken from its own pictures right now.
 *
 * This is what the palette menu shows as Dynamic, and it is deliberately
 * neither of the two flags that look like it. `auto` is only whether the board
 * is *allowed* to colour itself: a fresh board is allowed and is wearing
 * Papyrus, and a menu claiming otherwise would be describing a permission
 * rather than a colour. `derived` is provenance, and is missing from every look
 * written before that flag existed - so a board carrying an extracted palette in
 * from an older version, or from somebody else's .mbrd, would show a palette
 * name it is demonstrably not set in, with no entry selected for what it is.
 *
 * Pigments inline, plus permission, is the honest test, and it is the same one
 * dropPigments() and reshade() already ask.
 */
const dynamicOn = () => autoOn(current) && PALETTE_TOKENS.some(key => key in current.vars);

/**
 * The board recolouring itself because something changed under it.
 *
 * Three gates, in increasing order of what they cost to ask. The extraction has
 * to be allowed at all; the board has to be holding enough pictures to be worth
 * reading, or already be reading them (see autoPaletteReady()); and the pictures
 * that would actually be sampled have to have moved.
 *
 * That last one is stricter than "something happened" on purpose: 'items' also
 * fires for a note, a drag, a duplicate, a text file, a board load - and for the
 * thirteenth picture on a board where only twelve are ever read. Re-running the
 * extraction to arrive at the same palette would repaint the whole interface and
 * mark the board dirty for nothing.
 *
 * Not awaited and its rejection swallowed: this is a decoration on an edit that
 * has already succeeded, and it has no business turning into an unhandled
 * rejection in somebody's console because one PNG would not decode.
 */
function autoRecolour() {
  if (!autoOn(current)) return;
  const hashes = pictureHashes();
  if (!autoPaletteReady(hashes.length, dynamicOn())) return;
  if (sourceKey(hashes) === lastSources) return;
  recolourFromBoard({ silent: true }).catch(() => {});
}

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
  const hashes = pictureHashes();
  // Sliced before the URLs are resolved, not after: a picture past the count is
  // never read, and minting a blob URL for it would hold the whole board's
  // pictures open for the session to sample twelve of them.
  // The predicate is spelled out because the list is what samplePixels() takes:
  // assetURL() answers null for a hash the store has lost, and those are what
  // this drops - the same filter as before, saying which type comes out of it.
  const urls = hashes.slice(0, sourceCount()).map(assetURL)
    .filter((u): u is string => !!u);
  // Recorded before the pixels are read, not after: the answer to "which
  // pictures is the palette standing on" is these, whatever they turn out to
  // say. Recording it afterwards would leave a board whose pictures have no
  // colour in them re-running the whole extraction on every subsequent edit.
  lastSources = sourceKey(hashes);
  const failed = (why: string) => {
    if (!silent || lastFailure !== why) toast(why);
    lastFailure = why;
    return false;
  };
  // One picture is enough here. The three-picture floor lives on the automatic
  // path alone - autoRecolour(), and autoPaletteReady() for why - because it is
  // a rule about firing unasked. By the time control reaches this function
  // either somebody chose Dynamic from the menu or the board is already
  // colouring itself, and in both cases refusing to read the one picture there
  // is would be the fault.
  // An empty board has no colours of its own, so it stops wearing the ones it
  // used to have. Leaving them standing was defensible while they were "the
  // board's colours now" - but on a board you have just cleared they are the
  // colours of pictures that are not there, which is the one case where the
  // palette is provably not a representation of anything.
  // Asked of the board, not of the slice: "no pictures here" is a fact about
  // the board, and a dial turned down is not an empty board.
  if (!hashes.length) {
    if (dropPigments()) {
      persist();
      syncControls();
      return failed('No pictures left - back to the chosen palette');
    }
    // Empty or picture-less board with no derived palette to shed: a fresh
    // board's resting state, not a fault. The automatic run (on load and on
    // every edit) keeps quiet - it would otherwise nag an empty board with a
    // message about pictures that were never there. Only the switch, turned on
    // by someone waiting for an answer, is told why nothing happened.
    lastFailure = 'No pictures on the board to take colours from';
    if (!silent) toast(lastFailure);
    return false;
  }

  const pixels = await samplePixels(urls, sourceCount());
  // One line per attempt, in the house style of main.js's "ready". This is a
  // feature whose every failure mode is a picture quietly not being read, and
  // the count of pictures found against pictures actually decoded is the whole
  // diagnosis - without it the answer to "why has nothing changed?" is a
  // browser-by-browser guess, which is exactly what it was.
  console.info(`[mbrd] palette: ${hashes.length} picture${hashes.length === 1 ? '' : 's'} on the board, ${pixels.length} read`);
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
  const hueOf = (c: string) => Math.round(oklch(...parseHex(c)).h);
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
 * including `auto` and `derived`, which is what allows the extraction again,
 * since autoOn() reads an absent flag as on.
 *
 * And allowed is a promise the board then has to keep, on a board holding enough
 * pictures for it: leaving it there would go back to Papyrus and stay there
 * until the next import happened to move the source list, since the extraction
 * remembers what it last read and the same twelve pictures are not counted
 * twice. That memory is part of what is being reset, so it goes too, and the
 * count runs again. Through the automatic gate rather than around it - starting
 * over is not a request for colour, so a board under the floor stays Papyrus,
 * which is where starting over has just put it anyway.
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
  autoRecolour();
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
 *
 * Seeded from what is already inline, not from nothing. The pre-paint guard in
 * index.html writes custom properties on :root before this module exists, and
 * its filter is *not* this one: it tests the key against `^--[a-z0-9-]+$` where
 * safeVars() tests it against TOKENS. So a saved look carrying a key the
 * allowlist has since dropped was written by the guard, rejected by cloneLook(),
 * and then never removed - the loop below iterated an empty set - and the
 * property survived every board load for the session with no control able to
 * clear it. Whatever the guard put there is this module's to take away.
 */
let applied = new Set<string>(
  typeof document === 'object'
    ? [...document.documentElement.style].filter(name => name.startsWith('--'))
    : [],
);

function apply(look: Look) {
  // Always written, including the default: the stylesheet's base *is* the
  // middle, so an absent attribute already means 1 - but 0 is a real level
  // with its own rules, and leaving the attribute off for it would silently
  // land on the middle instead.
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
  // Every colour in the app that is a mix of two pigments, for the engines that
  // cannot mix. A no-op on all of them but WebKit below 16.2, and it has to run
  // here rather than once at boot: the mixes are functions of --accent, and
  // this is the line after --accent has just moved. See ui/legacy-color.js.
  legacyBlends(root);
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
 * 400 when it is not - see `.wordmark h1` in base.css. CSS cannot ask what
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
  const stack = readToken('--font-display');
  if (/sans-serif\s*$/i.test(stack)) root.dataset.displaySans = '';
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
  const paper = readToken('--paper');
  if (paper) themeColour.setAttribute('content', paper);
}

/**
 * How long the stored copy of the look may lag behind the live one.
 *
 * Long enough that a drag writes about five times a second instead of sixty,
 * short enough that nothing a person could do between two writes loses
 * anything: the pending write reads `current` when it fires, not when it was
 * scheduled, so the value that lands is always the latest one.
 */
const PREF_MS = 200;
let prefTimer = 0;

/**
 * Mirror the look into the user's preferences.
 *
 * `soon` is for setVar(), and setVar() alone. localStorage is synchronous I/O -
 * the write blocks the thread and, in some engines, reaches the disk - and
 * setVar runs on every frame of a colour drag, where it was doing a
 * JSON.stringify of the whole look and a blocking write per pointermove. The
 * picture does not need it: the colour on screen comes from the inline
 * properties setVar has already written, and the board's own copy still goes
 * through setAppearance() below on every frame. Only the preference lags, and
 * only by a fifth of a second.
 *
 * A throttle with a trailing write rather than a plain debounce, so a drag that
 * never pauses still saves as it goes - a tab closed mid-gesture keeps the
 * colour it was showing a moment ago rather than the one it started from.
 */
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
  persist({ soon: true });
}

function readStored() {
  return cloneLook(readPrefJSON(STORE_KEY));
}

