// Every control in the sidebar, written down once.
//
// The panel used to be markup in index.html and wiring in ui/sidebar.js, which
// meant a setting existed in two places that had to be kept in step by hand -
// and the panel grew, section by section, into an order nobody chose: two view
// *actions* and the board's audio volume filed under "View", the paper sheet in
// one section and the scale it sets in another, "Board layout" and "Arrange"
// describing one idea under two headings.
//
// So the panel is described here and built by ui/panel.js. This file is data:
// no DOM, no document, nothing that runs at import time beyond building arrays.
// The `get`/`set` closures reach into state.js, but only when a control is
// painted or moved - which is after boot, the same as the old bindCheck().
//
// Three rules the shape encodes:
//
//   Absence, not disabling. A control whose `when(ctx)` is false is hidden
//   outright. Mobile has no paper sheet and no spacing, and a greyed-out row
//   for one is a promise the layout cannot keep.
//
//   `needsBoard: true` is the one deliberate inversion of that rule, and it
//   applies on exactly one page. /patch is this app showing the changelog, with
//   this panel over it and no board underneath - and there the point of the
//   sidebar is that it is *the* sidebar, the real tabs with the real sections
//   in them, not a likeness. Hiding two thirds of it would make it a likeness
//   again. So the rows that would act on a board a reader has not got are shown
//   and greyed: Save, Export, Add files, the arrangement, the grid, the paper
//   sheet, Optimize, Clear everything. The whimsy dial and the palette are not
//   among them, because the changelog is printed by the same tokens the board
//   is and moving that dial moves the page in front of you.
//
//   The View row is the one part of the Board tab a reader can still press, and
//   it does the only thing it can mean there: goHome() in page.ts takes them to
//   the board, showing the face they pressed.
//
//   `advanced: true` sinks a control into its section's fold. The rule for
//   which side of the fold something belongs on is whether a board is worse
//   for never touching it: Whimsy and Palette move every token the fold sets
//   one at a time, so the fold is where you go when those two landed wrong.
//
//   `external: true` means another module owns the control's behaviour and
//   this file only asks for the element - by exactly the id that module looks
//   up. ui/appearance.js wires the whimsy slider and the palette menu,
//   canvas/audio.js wires the volume; each of them predates the panel builder
//   and none of them should have to learn about it.
//
// The `slot` type is the escape hatch for controls a table cannot describe -
// the paired face menus, the generated token sliders. The builder makes the
// empty host with today's id and the owning module fills it exactly as before.

import {
  board, setSetting, setArrangement,
} from '../state.ts';
import { ARRANGEMENTS, MOBILE_ARRANGEMENTS } from '../arrange/arrangements.ts';
import { currentLens } from './board-view.ts';
// The palette row's chips, read out of tokens.css at the moment the menu opens.
// Its own leaf module rather than ui/appearance-controls.ts, where the rest of
// that row lives: this table, the panel builder and the controls form a ring if
// the function sits with its neighbours. See the header of ui/palettes.ts.
import { paletteSwatches } from './palettes.ts';
import { itemBounds } from '../geometry.ts';
import { toUnits, formatLength, paperMm, PAPERS } from '../measure.ts';
import {
  QUALITY_LEVELS, quality, qualityLevel, setQualityLevel, setQualityOverride,
  clearQualityOverrides, SHARPNESS_STEPS, BUILD_STEPS,
} from '../quality.ts';

// ---------------------------------------------------------------------------
// What a control is
// ---------------------------------------------------------------------------

/**
 * What the panel knows about the board while it paints: the one fact every
 * `when`, `options`, `pressed` and `text` closure below is asked against.
 */
export type Ctx = {
  mobile: boolean,
  /** The changelog: this panel, over a document, with no board under it. */
  patch: boolean,
};

/** One entry of a <select>. */
export type Option = { value: string, label: string };

/** One button in a `buttons` row. See buildButtons() in ui/panel.js. */
export type ButtonSpec = {
  label: string,
  /** Answered by the delegated listener in ui/sidebar.js. */
  cmd?: string,
  id?: string,
  className?: string,
  /** The paper pair, which ui/sidebar.js wires itself - see buildButtons(). */
  orient?: string,
  /** A starting value for a button whose own command writes the attribute after. */
  ariaPressed?: string,
  pressed?: (ctx: Ctx) => boolean,
  title?: (ctx: Ctx) => string,
};

/** The keys every control may carry, whatever kind it is. */
type Common = {
  id?: string,
  className?: string,
  /** False and the control is not on screen at all - absence, not disabling. */
  when?: (ctx: Ctx) => boolean,
  /**
   * The control acts on a board, so it is greyed where there is none. Set on a
   * section it covers every control in it. See the head of this file: this is
   * the single exception to absence-not-disabling, and it applies on /patch.
   */
  needsBoard?: true,
  /** Sinks the control into its section's one fold. */
  advanced?: boolean,
  /** Another module owns the behaviour; this file only asks for the element. */
  external?: boolean,
  /** Its owner decides when it shows, for a reason this table does not know. */
  ownVisibility?: boolean,
};

/**
 * A control, as one of the eight kinds the builder knows.
 *
 * A discriminated union on `type` rather than one shape with everything
 * optional, because the kinds genuinely differ: only a range has a step, only a
 * select has a list, and only a buttons row has buttons. It is also what makes
 * the table below check itself - a `min` on a checkbox is now a mistake the
 * typechecker catches rather than a key nothing ever reads.
 */
export type TextControl = Common & {
  type: 'text', maxlength?: number, placeholder?: string, ariaLabel?: string,
};
export type CheckControl = Common & {
  type: 'check', label: string, get?: () => boolean, set?: (value: boolean) => unknown,
};
export type RangeControl = Common & {
  type: 'range', label: string,
  min?: number, max?: number, step?: number, unit?: string, value?: number,
  /** A dial whose stops are named underneath rather than printed as a number. */
  silent?: boolean,
  stops?: readonly string[],
  stopsId?: string,
  fieldId?: string,
  outText?: string,
  format?: (value: number) => string,
  get?: () => number,
  set?: (value: number) => unknown,
};
export type SelectControl = Common & {
  type: 'select', label: string, fieldId?: string,
  options?: (ctx: Ctx) => Option[],
  get?: () => string,
  set?: (value: string) => unknown,
};
/**
 * A select whose options are worth *seeing* rather than only reading.
 *
 * The same shape as SelectControl above - same `options`, same `get`/`set`,
 * same `external` - and it exists because a native <option> cannot paint
 * anything. No browser lets a stylesheet inside a dropdown list, so a palette
 * row that wants to show its own colours has to stop being a <select>. The
 * builder opens ui/menu.ts's anchored panel instead, which is the app's one
 * menu and already draws a colour chip per row.
 *
 * `swatches` answers, for one option value, the colours to draw beside it. An
 * empty array is a legal answer and draws a row with a label and no chips -
 * which is what a palette whose block cannot be read falls back to.
 */
export type PickerControl = Common & {
  type: 'picker', label: string, fieldId?: string,
  options?: (ctx: Ctx) => Option[],
  swatches?: (value: string) => string[],
  get?: () => string,
  set?: (value: string) => unknown,
};
export type ButtonsControl = Common & {
  type: 'buttons', group?: boolean, ariaLabel?: string, buttons: ButtonSpec[],
};
export type SlotControl = Common & { type: 'slot' };
export type HintControl = Common & {
  type: 'hint', html?: string, text?: (ctx: Ctx) => string,
};
export type KeysControl = Common & {
  type: 'keys', keys: readonly (readonly [readonly string[], string])[],
};
export type Control =
  | TextControl | CheckControl | RangeControl | SelectControl | PickerControl
  | ButtonsControl | SlotControl | HintControl | KeysControl;

/** One heading's worth of controls, and which tab it lives in. */
export type Section = {
  id?: string,
  tab: string,
  title?: string,
  /** The label on the section's one fold, and the id a stylesheet reaches it by. */
  fold?: string,
  foldId?: string,
  when?: (ctx: Ctx) => boolean,
  /** Every control under this heading acts on a board. See Common.needsBoard. */
  needsBoard?: true,
  controls: Control[],
};

/** The three tabs, in order. The first is the one the panel always opens on. */
export const TABS = [
  { id: 'board',  label: 'Board' },
  { id: 'look',   label: 'Look' },
  { id: 'system', label: 'System' },
];

/**
 * The keyboard legend, which is a table and was sixteen rows of markup.
 *
 * A bare '+' is a joiner rather than a key: `ctrl+C X V` is one chord and then
 * two more letters that take the same modifier, and spacing them all alike
 * would read as five keys pressed in a row.
 */
const KEYS: (readonly [readonly string[], string])[] = [
  [['drag'], 'pan the board'],
  [['shift', '+', 'drag'], 'select a region'],
  [['space', '+', 'drag'], 'pan from anywhere'],
  [['wheel'], 'zoom to the cursor'],
  // Not a key, and neither is the wheel above it or the drag at the top: this
  // is the gesture legend as much as the keyboard one, and a touchpad is how
  // most people reading it will be moving around the board.
  [['two fingers'], 'scroll to pan, pinch to zoom'],
  // The escape from the platform's axis rail, which is the one thing about
  // panning on a touchpad that nobody guesses - see readWheel() in
  // canvas/input.js.
  [['shift', '+', 'scroll'], 'pan sideways'],
  [['dbl-click'], 'zoom to an item'],
  [['0', 'F'], 'recenter, fit'],
  [['←↑→↓'], 'nudge (+shift a step)'],
  [['ctrl', '+', 'A'], 'select all'],
  [['ctrl', '+', 'C', 'X', 'V'], 'copy, cut, paste'],
  [['ctrl', '+', 'D'], 'duplicate selection'],
  [['F2'], 'rename'],
  [['del'], 'delete selection'],
  [['ctrl', '+', 'Z', 'Y'], 'undo, redo'],
  [['ctrl', '+', 'S', 'O'], 'save, open'],
  [['ctrl', '+', 'shift', '+', 'S'], 'export a .mbrd'],
];

const mobile = (ctx: Ctx) => ctx.mobile;
const desktop = (ctx: Ctx) => !ctx.mobile;

/** The long side of the box round every item - the board's own extent. */
function spread() {
  const box = itemBounds(board.items);
  return box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) : 0;
}

/**
 * The sheet's size in board units, which is the sentence that makes the scale
 * legible: a mistake of a factor of ten shows up as a sheet that swallows the
 * board rather than hiding in a decimal nobody was going to check.
 */
function paperHint() {
  const s = board.settings;
  const mm = paperMm(s.paper, s.paperLandscape);
  // The invitation to drag is only printed when dragging is switched on. A hint
  // describing a gesture the corners will not answer is worse than no hint.
  const drag = s.paperResize
    ? ' Drag a corner to match it against the board - that is what sets the scale.'
    : '';
  return mm
    ? `${Math.round(toUnits(mm.w, s.scale))} × ${Math.round(toUnits(mm.h, s.scale))} px, centred on 0,0.${drag}`
    : 'Outlines a sheet in the middle of the board, at the size it really is.';
}

/**
 * One line saying what the quality dial is currently doing, in the terms the
 * fold below it uses. A dial with three unnamed stops is a dial you move once
 * and never trust again.
 */
const QUALITY_HINT = {
  full: 'Everything on. The board as it was drawn.',
  balanced: 'Softer pictures, no panel blur, smaller batches. Nothing you can see standing still.',
  light: 'GIFs held still, no shadows, no blur, no animation. For a tired phone.',
};

/**
 * Every section, in the order it appears inside its tab.
 *
 * `controls` is flat: the builder lifts everything marked `advanced` out into
 * one fold at the foot of the section, so a section reads here in the order it
 * reads on screen and the fold is not a nesting level in the data.
 */
export const SECTIONS: Section[] = [
  // --- Board -------------------------------------------------------------
  {
    // Every row here names the board or produces a file out of it, down to the
    // title in the field at the top, so the whole heading comes down together
    // where there is no board to name.
    id: 'name', tab: 'board', title: 'Board', needsBoard: true,
    controls: [
      // A real input rather than a <p> you can click into, so it is reachable by
      // tab and by touch without inventing a role. Empty rather than carrying
      // "Untitled board": that is the placeholder, and setTitle() already falls
      // back to it. ui/sidebar.js owns the typing behaviour - see wireTitle().
      { id: 'board-title', type: 'text', external: true, className: 'board-title',
        maxlength: 32, placeholder: 'Untitled board', ariaLabel: 'Board name' },
      // Save alone on its row, and it is the only button on this tab with a
      // deadline attached to it. It used to sit second in a row of two, at the
      // same weight as Export - which is the panel saying that keeping your work
      // and producing a copy of it are the same size of decision.
      { type: 'buttons', buttons: [
        { cmd: 'save', label: 'Save', className: 'primary' },
      ] },
      // Which board you are on. Three verbs, one row, none of them about the
      // board's contents.
      //
      // Merging two boards is deliberately *not* a fourth button here. It is
      // reached by dropping a .mbrd on a board that already has something on it,
      // which asks whether to open it or fold it in - see importFiles() in
      // import/drop.ts. A row here would be a second door onto a question that
      // only ever comes up when a file arrives, and it would have to open a
      // picker to ask the same thing the drop has already answered.
      { type: 'buttons', buttons: [
        { cmd: 'new', label: 'New' },
        { cmd: 'open', label: 'Open' },
        { cmd: 'library', label: 'Boards' },
      ] },
      // And the four that produce a file which is not this board, behind one
      // fold. They were four rows of the five this section had, they are the four
      // least-pressed things on the tab, and they are one idea - make something
      // to send somebody - stated four ways. A section may have exactly one fold
      // (buildSection, ui/panel.js), which is the whole reason they group rather
      // than each getting its own heading.
      //
      // Export is in here with them and not beside Save, which is the arguable
      // half: it writes the real .mbrd and is the only one of the four that
      // round-trips. But what it writes is still a file you go and put somewhere,
      // where Save is the board keeping itself, and putting the two on one row
      // was what made Save look like an option rather than the answer.
      { type: 'buttons', advanced: true, buttons: [
        { cmd: 'export', label: 'Export' },
      ] },
      // Share keeps its own row and its own guard: it shows only where the engine
      // can actually put a file into the share sheet - hidden outright otherwise,
      // the same rule the paper sheet follows, because a Share that quietly
      // turned into a download would be a promise the phone could not read. See
      // shareBoard().
      { type: 'buttons', advanced: true,
        when: () => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',
        buttons: [{ cmd: 'share', label: 'Share' }] },
      // A picture of the board, for showing rather than reopening - a PNG to send
      // or a PDF to print. Derived artefacts, not board files; see cmds.exportImage.
      { type: 'buttons', advanced: true, buttons: [
        { cmd: 'export-image', label: 'Save image' },
        { cmd: 'export-pdf', label: 'Save PDF' },
      ] },
    ],
  },
  {
    // Named for the verb rather than for the noun. "Content" is what the two
    // buttons under it produce; Add is what pressing them does, and a heading
    // that says what the row does is the one you can find without reading it.
    id: 'add', tab: 'board', title: 'Add', needsBoard: true,
    controls: [
      { type: 'buttons', buttons: [
        { cmd: 'add-files', label: 'Add files' },
        { cmd: 'add-note', label: 'Write a note' },
      ] },
    ],
  },
  {
    // Board layout and Arrange were one idea under two headings: which of the
    // two arrangements you are in, how wide it is, and how things are placed
    // within it are the same question asked three times.
    id: 'arrange', tab: 'board', title: 'Arrange',
    controls: [
      // How the board is shown, above how it is laid out, because they are the
      // same question at two scales: which of the board's three faces you are
      // looking at, and how things are placed within it.
      //
      // This pair had a section of its own at the top of the tab, put there
      // because on a phone it is the navigation and it had been buried in System
      // next to Clear everything. Reaching it easily was the right instinct and
      // is kept - it is still on the first tab, above the fold, two rows down
      // instead of none. What it cost was a naked pair of buttons standing over
      // the board's own name, reading as a toolbar that had wandered in.
      //
      // Three segments now, not two, and that is the reason the move was worth
      // making. There was no button anywhere that said "you are on the canvas":
      // Feed and Playlist were two ways off it and nothing named the place you
      // left, so on a Desktop board neither was pressed and the row said nothing
      // about the current state. Three, with exactly one lit, is the same shape
      // the zoom cluster and the history pair already have.
      //
      // The commands underneath are unchanged, deliberately. Playlist pressed on
      // the canvas still opens the floating player rather than taking the board
      // over - a player, not a takeover - so Canvas stays lit through it, which
      // is the truth: you are still on the canvas, with a player window open.
      { type: 'buttons', buttons: [
        { id: 'view-canvas', cmd: 'canvas', label: 'Canvas',
          pressed: ctx => !ctx.mobile,
          title: () => 'The freeform board' },
        { id: 'view-feed', cmd: 'feed', label: 'Feed',
          pressed: ctx => ctx.mobile && currentLens() === 'feed',
          title: ctx => (ctx.mobile
            ? 'Back to the canvas'
            : 'Show everything on the board as a scrollable feed') },
        { id: 'view-playlist', cmd: 'playlist', label: 'Playlist',
          pressed: ctx => ctx.mobile && currentLens() === 'playlist',
          title: ctx => (ctx.mobile
            ? 'Back to the canvas'
            : 'Open the board’s audio as a player') },
      ] },
      // The Feed's column count is derived from the screen width now, not chosen -
      // a phone gets two, a wide screen more - so the old Grid width select is gone.
      // Two catalogues, because the two layouts are answering different
      // questions: Desktop picks a shape, and Mobile - which packs a column and
      // throws every computed position away - can only pick the order the
      // packer meets things in. Six of Desktop's seven meant nothing here.
      // From here down the section is about a board's contents rather than
      // about which face of it you are looking at, so these four grey where the
      // View row above them does not. The row is the only thing on this tab a
      // reader of the changelog can press, and pressing it is how they leave.
      { id: 'arrangement', type: 'select', label: 'Layout', needsBoard: true,
        options: ctx => (ctx.mobile ? MOBILE_ARRANGEMENTS : ARRANGEMENTS)
          .map(a => ({ value: a.id, label: a.label })),
        get: () => board.arrangement,
        set: v => setArrangement(v) },
      // Below the fold with the other set-once dials: an arrangement is picked
      // by name and the gap it packs at is a number you tune afterwards, if at
      // all. It stays edge-to-edge world px - see arrange/arrangements.js.
      //
      // On both layouts now. It reads differently on each: Desktop's is a rule
      // the next Rearrange will use, Mobile's moves the column the moment it is
      // touched, because on a phone the gap is baked into where the packer put
      // things. Mobile starts at zero and no saved board moves on its own.
      { id: 'spacing', type: 'range', label: 'Spacing', advanced: true, needsBoard: true,
        min: 0, max: 200, step: 4, unit: 'px',
        get: () => board.settings.spacing,
        set: v => setSetting('spacing', v) },
      { type: 'buttons', needsBoard: true,
        buttons: [{ cmd: 'rearrange', label: 'Rearrange everything' }] },
      { type: 'hint', when: desktop,
        html: 'New drops use this layout. <em>Free</em> leaves every position untouched.' },
      // The Mobile half of the same sentence, and it has to be a different one:
      // a column is always packed the same way, so what is being chosen is the
      // order things are packed in and not the shape they come out as.
      { type: 'hint', when: mobile,
        html: 'The column is always packed tight - this is the order it packs in. '
          + '<em>As placed</em> keeps the one it already has.' },
      { id: 'opt-snap', type: 'check', label: 'Snap to grid', advanced: true, needsBoard: true,
        get: () => !!board.settings.snap,
        set: v => setSetting('snap', v) },
    ],
  },

  // --- Look --------------------------------------------------------------
  {
    id: 'appearance', tab: 'look', title: 'Appearance', foldId: 'appearance-advanced',
    controls: [
      // The whimsy axis. One dial from scrapbook to spec sheet - it moves shape,
      // type, motion, elevation, ornament and contrast together. Wired by
      // ui/appearance.js; the three names below are the stops, and they are
      // legible in a way a <datalist>'s tick marks are not.
      { id: 'opt-whimsy', type: 'range', label: 'Whimsy', external: true,
        min: 0, max: 2, step: 1, value: 1, silent: true,
        // The one stops row a stylesheet knows by name: each of the three is a
        // specimen of the tier it names, set in that tier's own face.
        stopsId: 'whimsy-stop-labels',
        stops: ['Softish', 'Middle', 'Harsh.'] },
      // Five entries and one of them is not a colour: Dynamic is the board's own
      // pictures, and it replaced a "Take colours from pictures" checkbox that
      // sat below this menu inside the fold. The two were one decision written
      // down twice - a board is set in Papyrus, or in Absinthe, or in its own
      // photographs - and the checkbox spent most of its life ticked over a
      // palette it was quietly overruling. First in the list because it is the
      // one entry the board can reach on its own, three pictures in.
      //
      // 'dynamic' is DYNAMIC in ui/appearance-controls.js, which owns what the
      // menu does with it; this file is data and imports no panel module, so
      // tests/settings-panel.test.js holds the two strings together.
      // A picker rather than a select, and the difference is that you can see
      // what you are choosing between: each row carries its palette's own paper,
      // accent and ink as a split chip. A native <option> cannot paint anything
      // in any browser, which is the whole reason this one row is not a <select>
      // like every other list in the panel. See buildPicker() in ui/panel.ts.
      //
      // `swatches` reads the colours out of the live tokens.css rather than from
      // a table here - see paletteSwatches() in ui/appearance-controls.ts, which
      // explains why a copy in JS would be a second definition that drifts.
      { id: 'opt-palette', type: 'picker', label: 'Palette', external: true,
        swatches: paletteSwatches,
        options: () => [
          { value: 'dynamic', label: 'Dynamic' },
          { value: '', label: 'Papyrus' },
          { value: 'absinthe', label: 'Absinthe' },
          { value: 'tearose', label: 'Tea rose' },
          { value: 'orca', label: 'Orca' },
        ] },
      // The third dial, and above the fold with the other two. Type is not a
      // tweak to reach for when Whimsy landed wrong: the display serif is the
      // loudest decision on a board, it is the first thing anybody goes looking
      // for, and a face somebody dropped onto the board themselves appears in
      // this menu - which made a dropped font a feature that worked and could
      // not be found. Its hint travels with it for the same reason; a line about
      // dropping a .woff2 is no use in a fold you open after giving up.
      { id: 'appearance-type', type: 'slot', className: 'field-pair' },
      { type: 'hint',
        html: 'Drop a <code>.woff2</code>, <code>.ttf</code> or <code>.otf</code> on the board to add your own face.' },
      // The board's own dropped faces, each with a way to take it back off - filled
      // and shown/hidden by ui/fonts.js, empty (and gone) until one is dropped.
      { id: 'appearance-fonts', type: 'slot' },
      // Everything below the fold. The three above it between them move every
      // token these set one at a time, which is what makes the rest advanced
      // rather than merely secondary.
      { id: 'appearance-vars', type: 'slot', advanced: true },
      // How many of the board's pictures the palette is read from, newest first.
      // `ownVisibility` because ui/appearance.js takes this row down whenever the
      // palette is not Dynamic - the dial means nothing while no picture is being
      // read - and a panel repaint that put it back would fight it every time
      // any setting changed.
      // 25 stops, and the last one is not a count: it reads "Every photo" and is
      // stored as 0. ui/appearance.js owns the mapping and rewrites `max` from
      // MAX_SOURCES itself, so this is the shape of the element and not the
      // second place the number lives.
      // The one row of Appearance that is about the board rather than about the
      // look: it counts the board's own photographs. Everything above it - the
      // whimsy dial, the palette, the two faces, the tokens - moves the page
      // the reader is on, changelog included, which is why this section is not
      // greyed wholesale.
      { id: 'opt-palette-sources', type: 'range', label: 'Pictures used', needsBoard: true,
        external: true, ownVisibility: true, advanced: true, fieldId: 'palette-sources-field',
        min: 1, max: 25, step: 1, value: 12 },
      { id: 'appearance-advanced-vars', type: 'slot', advanced: true },
      { type: 'buttons', advanced: true,
        buttons: [{ cmd: 'reset-appearance', label: 'Start over' }] },
    ],
  },
  {
    id: 'board-grid', tab: 'look', title: 'Board & grid', needsBoard: true,
    controls: [
      { id: 'opt-grid', type: 'check', label: 'Show grid',
        get: () => !!board.settings.grid, set: v => setSetting('grid', v) },
      { id: 'opt-axes', type: 'check', label: 'Show axes',
        get: () => !!board.settings.axes, set: v => setSetting('axes', v) },
      { id: 'opt-hud', type: 'check', label: 'Show readout',
        get: () => !!board.settings.hud, set: v => setSetting('hud', v) },
      // A Desktop thing - Mobile is a reading feed with no spatial map to draw
      // them over - so it comes down rather than sitting there inert.
      //
      // On by default now, where the web it replaced was off. The two defaults
      // answer different questions: an automatic effect that appeared uninvited
      // over a board somebody had just made was an imposition, and a line you
      // drew yourself and cannot see is a bug. Still `settings.web` in the file,
      // and deliberately - the key is what an older build reads to decide
      // whether to draw anything between cards, and renaming it would leave
      // every board that had the web switched on opening blank.
      { id: 'opt-web', type: 'check', label: 'Show connections', when: desktop,
        get: () => board.settings.web !== false, set: v => setSetting('web', v) },
      // Checked = photos and videos fill their card and crop; unchecked = the
      // whole picture fits inside and letterboxes. Board-wide default; a single
      // item overrides it from its right-click menu.
      { id: 'opt-mediafit', type: 'check', label: 'Fill photos & videos',
        get: () => board.mediaFit !== 'contain',
        set: v => setSetting('mediaFit', v ? 'cover' : 'contain') },
      // Volume was the last row here and is not any more, for a reason that has
      // outlived one move: in the panel it was a control you had to go and find,
      // two clicks from the sound it was about, and it sat there the rest of the
      // time as a dial for a board with nothing to hear on it. It went to the
      // now-playing bar and has since gone on to the playlist window, which is
      // where the rest of the transport lives - the bar is down to what is
      // playing, play/pause, and the way to that window.
    ],
  },
  {
    // Paper and Real size were one idea filed twice: dragging the sheet's
    // corners *is* how settings.scale gets set, and a heading stood between the
    // gesture and the number it writes.
    //
    // The whole section is a fold - no h2 of its own, only the summary - and it
    // is called Paper rather than Real size because the sheet is what somebody
    // is looking for when they come here. A board that never puts one up never
    // needs a millimetre either, so all of it is behind one word. Same
    // arrangement the keyboard legend has, and the reason `fold` exempts a
    // section from the "keep something above the fold" rule.
    id: 'real-size', tab: 'look', fold: 'Paper', needsBoard: true,
    controls: [
      { id: 'opt-units', type: 'select', label: 'Units', advanced: true,
        options: () => [
          { value: 'metric', label: 'Millimetres, centimetres, metres' },
          { value: 'imperial', label: 'Inches and feet' },
        ],
        get: () => board.settings.units, set: v => setSetting('units', v) },
      // A sheet is a Desktop question: Mobile is a narrow strip with a fixed
      // width and no page to fit anything onto, and setSetting() refuses these
      // three keys there.
      { id: 'opt-paper', type: 'select', label: 'Paper outline', when: desktop, advanced: true,
        options: () => [{ value: '', label: 'None' },
          ...PAPERS.map(p => ({ value: p.id, label: p.label }))],
        get: () => board.settings.paper, set: v => setSetting('paper', v) },
      // Orientation is a radio group in behaviour, drawn with aria-pressed:
      // both states are equally ordinary, and a checkbox saying "landscape"
      // would make one of them the deviation.
      { id: 'paper-orient', type: 'buttons', when: desktop, advanced: true,
        ariaLabel: 'Paper orientation', group: true,
        buttons: [
          { orient: 'portrait', label: 'Portrait',
            pressed: () => !board.settings.paperLandscape },
          { orient: 'landscape', label: 'Landscape',
            pressed: () => !!board.settings.paperLandscape },
        ] },
      // Off by default: what the corners drag is not the sheet but the whole
      // board's scale, and a sheet put up to check a layout against should not
      // arrive with that armed on its corners.
      { id: 'opt-paper-resize', type: 'check', label: 'Resize by its corners',
        when: desktop, advanced: true,
        get: () => !!board.settings.paperResize, set: v => setSetting('paperResize', v) },
      { id: 'paper-hint', type: 'hint', when: desktop, advanced: true, text: paperHint },
      // The scale is set by matching something, never by typing a
      // units-per-millimetre figure: drag the sheet above, or point at an item
      // whose real size you already know.
      { type: 'buttons', advanced: true, buttons: [
        { cmd: 'scale-from-item', label: 'Set from selection…' },
      ] },
      // Dragging the corners is how the scale gets set, which means it is also
      // how the scale gets lost - and no setting is on the undo stack.
      { type: 'buttons', when: desktop, advanced: true, buttons: [
        { cmd: 'reset-scale', label: 'Reset size' },
      ] },
      { id: 'scale-hint', type: 'hint', advanced: true,
        text: () => (board.items.length
          ? `Everything on this board fits in ${formatLength(spread(), board.settings.scale, board.settings.units)}.`
          : 'Drop something in, then measure the board from it.') },
    ],
  },

  // --- System ------------------------------------------------------------
  {
    // The one section that is not about a board at all. See quality.js: it is
    // per device and never travels inside a .mbrd, because how hard someone
    // else's phone should work is not a property of your moodboard.
    id: 'quality', tab: 'system', title: 'Quality',
    controls: [
      { id: 'opt-quality', type: 'range', label: 'Quality',
        min: 0, max: 2, step: 1, silent: true,
        stops: QUALITY_LEVELS.map(l => l.label),
        get: () => QUALITY_LEVELS.findIndex(l => l.id === qualityLevel()),
        set: v => setQualityLevel(QUALITY_LEVELS[v]?.id) },
      { id: 'quality-hint', type: 'hint', text: () => QUALITY_HINT[qualityLevel()] },
      // The overrides. Each reads the resolved flag - so moving the dial moves
      // every one of these - and writes an override that outranks the dial from
      // then on. "Start over" at the foot is the way back, the same as
      // Appearance's.
      { id: 'q-motion', type: 'check', label: 'Animate GIFs', advanced: true,
        get: () => quality.motion, set: v => setQualityOverride('motion', v) },
      { id: 'q-shadows', type: 'check', label: 'Card shadows', advanced: true,
        get: () => quality.shadows, set: v => setQualityOverride('shadows', v) },
      { id: 'q-blur', type: 'check', label: 'Blurred backdrops', advanced: true,
        get: () => quality.blur, set: v => setQualityOverride('blur', v) },
      { id: 'q-anim', type: 'check', label: 'Animations', advanced: true,
        get: () => quality.anim, set: v => setQualityOverride('anim', v) },
      { id: 'q-sharpness', type: 'select', label: 'Picture sharpness', advanced: true,
        options: () => SHARPNESS_STEPS.map(s => ({ value: String(s.px), label: s.label })),
        get: () => String(quality.sharpness),
        set: v => setQualityOverride('sharpness', +v) },
      // The one lever here that is a trade rather than a reduction: a smaller
      // batch is a smoother zoom and a slower fill-in. See BUILD_BUDGET's note
      // in canvas/items.js.
      { id: 'q-build', type: 'select', label: 'Cards built per frame', advanced: true,
        options: () => BUILD_STEPS.map(s => ({ value: String(s.n), label: s.label })),
        get: () => String(quality.build),
        set: v => setQualityOverride('build', +v) },
      { type: 'buttons', advanced: true,
        buttons: [{ cmd: 'reset-quality', label: 'Start over' }] },
    ],
  },
  {
    // Housekeeping on the copy kept in this browser, done once in a while and
    // not while you are working - and the way out, which belongs at the far end
    // of the panel where it cannot be hit on the way to Save.
    //
    // Which of the two presentations this machine works in is in here too, rather
    // than beside them under a heading of its own. It is not a property of the
    // board: `board.layoutMode` is deliberately not persisted in the .mbrd, so
    // each machine remembers its own choice. That makes it the same kind of
    // decision as everything else in this section - about this copy of the app,
    // and about nobody else's.
    //
    // The board has three faces and two of them are here: the Canvas (the freeform
    // infinite board) is the default, and the Feed (a scrollable masonry of
    // everything on it) and the Playlist (its audio, as a player) are the mobile
    // pair. "Mobile" is the internal name still - board.layoutMode, data-board-mode,
    // the .mbrd profile - but nothing the user reads says it any more: it stopped
    // being about a device the moment it became a way to browse rather than a
    // cramped canvas.
    // Greyed on the changelog, all three of it, and Clear everything is the one
    // that matters: the whole promise of that page is that nothing a reader
    // does while they are on it can touch what they own, and a live button
    // there that wipes every board they have would be that promise broken in
    // the loudest way available. Optimize needs a board to trim. Reload saves
    // before it reloads, which on a page whose writer is deliberately suspended
    // is a button that would have to explain itself.
    id: 'browser', tab: 'system', title: 'This browser', needsBoard: true,
    controls: [
      { type: 'buttons', buttons: [{ cmd: 'optimize', label: 'Optimize' }] },
      // Feed | Playlist used to live here, next to Clear everything; it is the
      // board's own navigation, so it moved to the top of the Board tab (the
      // 'views' section above). What is left here is genuinely about this copy of
      // the app in this browser: optimise its assets, reload it, wipe it.
      // The refresh gesture this app takes away: pull-to-refresh is off because
      // every downward swipe on the board is a pan, and on a home screen there
      // is no address bar either. It saves first - which is why the label says
      // reload and not restart: nothing is lost and nothing starts over, the
      // page just comes back.
      { type: 'buttons', buttons: [
        { cmd: 'restart', label: 'Reload mbrd', title: () => 'Save and load the page again' },
      ] },
      // The changelog, directly under Reload rather than in a section of its
      // own. It had one, two headings up, on the argument that a thing to read
      // is not housekeeping - which was true and did not earn a heading: one
      // button and one line of hint under a title of their own made the tab read
      // as three sections where there are two things to do. Under Reload it is
      // where the rest of "this copy of the app" already is, and the version
      // number the notes are keyed to is a few rows below it in the same panel.
      //
      // A button and a command, not an anchor. The whole panel reaches the app
      // through one delegated data-cmd listener - see the credit in the footer
      // of index.html, which is a link dressed as a button for exactly this
      // reason - and a lone <a> in here would be the first row in the panel
      // that works a different way from every other row.
      { type: 'buttons', buttons: [
        { cmd: 'patch-notes', label: 'Patch notes', title: () => 'Every version since the first. Opens in a new tab' },
      ] },
    ],
  },
  {
    // Folded, and closed on arrival. Every row is a keyboard row: read once,
    // learned, then scrolled past forever - on a phone, where there is no
    // keyboard to read it for, scrolled past on the first visit.
    id: 'keys', tab: 'system', fold: 'By hand', foldId: 'keys-fold',
    controls: [{ type: 'keys', keys: KEYS, advanced: true }],
  },
  {
    // Development aids, last of all: none of this is part of using a board. The
    // grip overlay paints the resize corner grab zones - invisible by design -
    // so their reach can be seen. Grips only show on a selected card.
    //
    // Folded, like the keyboard rows two sections up, and for a stronger version
    // of the same reason: a keyboard row is read once and scrolled past forever,
    // and these three are not read at all by anybody using a board. Three
    // permanent rows at the foot of the tab, none of which is about the board,
    // is the panel ending on a footnote. `fold` with no `title` is what makes the
    // summary stand where the heading did rather than hang off a list above it -
    // see buildFold() and the is-head class in ui/panel.js.
    id: 'debug', tab: 'system', fold: 'Debug', foldId: 'debug-fold', needsBoard: true,
    controls: [
      { type: 'buttons', advanced: true, buttons: [
        // No `pressed` here on purpose: cmds.debugGrips writes aria-pressed
        // itself - the #grips URL and mbrd.debugGrips() drive the same toggle -
        // and a painted value would put the button back to false behind it.
        { cmd: 'debug-grips', label: 'Highlight resize grips', ariaPressed: 'false' },
        // The frame profiler, which until now had no way in from the interface
        // at all - a console call or a URL fragment, on a tool whose whole point
        // is the device with neither. Writes its own aria-pressed for the reason
        // the grips row does: the fragment drives the same toggle.
        { cmd: 'debug-perf', label: 'Profile the frame', ariaPressed: 'false' },
        // Its own row rather than something the toggle prints on the way off:
        // the useful sequence is arm, drive the board, read, drive some more,
        // and turning it off to see the numbers would reset them.
        { cmd: 'debug-perf-report', label: 'Print the frame report' },
        // Every line between cards, in one press. Here rather than beside the
        // Join tool because it is a demolition and not a drawing tool: the way
        // to remove *a* connection is to draw over it, and a board-wide clear is
        // the thing you want after trying the generator on a board you did not
        // mean to. Undoable like anything else, which is what keeps it out of
        // the danger dressing the clear-everything button wears.
        { cmd: 'clear-connections', label: 'Remove all connections' },
      ] },
      // Four readouts. Buttons rather than live rows, and that is forced rather
      // than chosen: paintPanel() repaints on `board`, `settings`, `layout` and
      // `lens`, and on none of the events these four would have to follow - not
      // `items`, not `history`, and not on the panel being opened. A hint
      // showing the undo depth would be stale the moment anybody read it, and a
      // wrong number reads as a fact where a button reads as a question.
      //
      // Each answers into a toast and into the console: the toast for whoever
      // pressed it, the console line for whoever is reading it back off a bug
      // report. See the four commands in commands/file.ts.
      { type: 'buttons', advanced: true, buttons: [
        // The one question here that is not a developer's - "if I close this
        // tab, is my board still here tomorrow?" - and until now it was
        // answerable only after a crash, because errors.ts was the only reader
        // of boardSafety().
        { cmd: 'board-safe', label: 'Is my work safe?' },
        { cmd: 'storage-state', label: 'Storage' },
        { cmd: 'board-weight', label: 'What this board weighs' },
        { cmd: 'history-state', label: 'Undo history' },
      ] },
      // The way out, and it lives in here now rather than at the foot of "This
      // browser". It used to sit at the far end of the tab on the argument that
      // a destructive control belongs where it cannot be hit on the way to
      // something else - which is the right instinct and this is a stronger
      // version of it: a fold that is closed on arrival is further from an
      // accidental press than any amount of distance down an open panel, and it
      // puts the button among the other things nobody needs while using a
      // board.
      //
      // It keeps the danger dressing and it keeps the three-press arming behind
      // it (see armClear in ui/board-actions.ts). Being harder to reach is not a
      // reason to make it easier to fire.
      //
      // `advanced` is what actually puts it *in* the fold rather than under it:
      // this section has no heading, so a control without the flag is appended
      // to the section body and lands below the closed <details> - which would
      // have left the one button here that must not be pressed by accident as
      // the only one on permanent display. See buildFold() in ui/panel.ts.
      { type: 'buttons', advanced: true, buttons: [
        { cmd: 'clear-data', label: 'Clear everything', className: 'danger' },
      ] },
    ],
  },
];

/** Whether a control belongs on screen in this layout mode. */
export const controlVisible = (c: Control, ctx: Ctx) =>
  (typeof c.when === 'function' ? !!c.when(ctx) : true);

/**
 * Whether a control may be touched, which is a different question from whether
 * it is on screen and is asked on exactly one page.
 *
 * A control is inert when it acts on a board and there is none - either because
 * it says so itself or because its whole heading does. Everywhere but /patch
 * this is true of everything, and ui/panel.js writes no attribute at all.
 */
export const controlEnabled = (c: Control, section: Section, ctx: Ctx) =>
  !(ctx.patch && (c.needsBoard || section.needsBoard));

/**
 * Whether a section has anything left to show.
 *
 * Pure, and separately exported, because it is the one piece of this file with
 * a decision in it: a section whose every control is hidden must come down with
 * them, or the panel grows an empty heading over a rule.
 */
export function sectionVisible(section: Section, ctx: Ctx) {
  if (typeof section.when === 'function' && !section.when(ctx)) return false;
  return section.controls.some(c => controlVisible(c, ctx));
}

/** The sections of one tab that have something to show. */
export const sectionsFor = (tab: string, ctx: Ctx) =>
  SECTIONS.filter(s => s.tab === tab && sectionVisible(s, ctx));

/** Reset every quality override, leaving the dial where it is. */
export const resetQuality = () => clearQualityOverrides();
