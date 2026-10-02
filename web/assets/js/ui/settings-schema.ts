// Sidebar settings schema. Data only — no DOM, no document access.
// ui/panel.ts builds controls from this; get/set closures reach state.ts.
// `when` false → hidden (not disabled). `needsBoard` → greyed on /patch.
// `advanced` → inside the section fold. `external` → another module wires it.

import {
  board, setSetting, setArrangement, selection,
} from '../state.ts';

const selectionSize = () => selection.size;
const tourStops = () => board.tour.length;
import { ARRANGEMENTS, MOBILE_ARRANGEMENTS } from '../arrange/arrangements.ts';
import { currentLens } from './board-view.ts';
import { setMediaFit } from './board-actions.ts';
import { timelineShown, toggleTimeline } from './timeline-view.ts';
import { paletteSwatches } from './palettes.ts';
import { itemBounds } from '../geometry.ts';
import { toUnits, formatLength, paperMm, PAPERS } from '../measure.ts';
import {
  QUALITY_LEVELS, quality, qualityLevel, setQualityLevel, setQualityOverride,
  SHARPNESS_STEPS, BUILD_STEPS,
} from '../quality.ts';
import { SOUND_STOPS, cueLogOn, soundLevel, setSoundLevel } from '../cuelume/engine.ts';
import {
  wheelMode, setWheelMode, zoomReversed, setZoomReversed,
} from '../controls.ts';
import { canShareLink } from '../storage/cloud/provider.ts';
import { syncedNow } from '../storage/cloud/sync.ts';
import { anyConnected, cloudProviders } from '../storage/cloud/cloud.ts';
import { isDesktop, updateOffer } from '../platform/platform.ts';
import type { UpdateOffer } from '../platform/platform.ts';

// ---------------------------------------------------------------------------
// What a control is
// ---------------------------------------------------------------------------

export type Ctx = {
  mobile: boolean,
  patch: boolean,
};

export type Option = { value: string, label: string };

/** The Update row's word for what the phone's updater offers. */
function updateWord(offer: UpdateOffer | null): string {
  if (offer?.state === 'downloading') return `Downloading ${Math.round(offer.progress * 100)}%`;
  if (offer?.state === 'failed') return 'Retry update';
  return 'Update';
}

export type ButtonSpec = {
  label: string,
  cmd?: string,
  id?: string,
  className?: string,
  orient?: string,
  // true → close panel on press. 'if-done' → close only when command resolves truthy.
  closesPanel?: boolean | 'if-done',
  ariaPressed?: string,
  pressed?: (ctx: Ctx) => boolean,
  title?: (ctx: Ctx) => string,
  /** False and this one button is not on screen. For a button that comes and
   *  goes inside a row that stays, where a row's own `when` would take its
   *  neighbours too. */
  when?: (ctx: Ctx) => boolean,
  /** The label now, for a button whose word follows a state. `label` is the
   *  word it is built with. */
  says?: (ctx: Ctx) => string,
  /** True and the button shows but cannot be pressed. */
  idle?: (ctx: Ctx) => boolean,
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
  /** True and the control shows, greyed, but cannot be changed: the look in
   *  force already decides it. Tilt cards at Harsh is the case. */
  idle?: (ctx: Ctx) => boolean,
  /**
   * The run of rows carrying this is drawn inside one box, and the box slides
   * open and shut as their `when` turns over rather than snapping. Same
   * movement a fold makes and the same code doing it - see slideBox() in
   * ui/panel.ts.
   *
   * A run, not a set: they must be consecutive in `controls`, because what is
   * being animated is a height, and a height only carries what is under it if
   * the rows growing into it are one box. Their `when` should agree for the
   * same reason - the box is open when any of them is, so a row that comes and
   * goes on its own inside it would change the height without the movement.
   */
  reveal?: boolean,
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
 * optional, because the kinds differ: only a range has a step, only a picker
 * has a list, only a buttons row has buttons. It also makes the table below
 * check itself - a `min` on a checkbox is a mistake the typechecker catches
 * rather than a key nothing ever reads.
 */
export type TextControl = Common & {
  type: 'text', maxlength?: number, placeholder?: string, ariaLabel?: string,
};
export type CheckControl = Common & {
  type: 'check', label: string, get?: () => boolean, set?: (value: boolean) => void,
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
  set?: (value: number) => void,
};
/**
 * Every dropdown in the panel: a button and ui/menu.ts's anchored panel.
 *
 * `swatches` answers, for one option value, the colours to draw beside it. An
 * empty array is legal and draws a row with a label and no chips - the fallback
 * for a palette whose block cannot be read. Drawn on the row's trailing edge
 * (MenuEntry.swatchEnd): a palette chip is a specimen compared down a column,
 * not an icon for the word beside it.
 *
 * ── Why there is no native <select> here any more ──
 *
 * The rule used to be that a dropdown stopped being native only when there was
 * something a native one could not do - the palette, since no browser paints
 * inside an <option>, and the note toolbar's face (canvas/notes.ts), since a
 * native list takes focus from the editor under it. The rest stayed native for
 * the listbox a screen reader announces and the phone's own wheel.
 *
 * The rule now is one kind of dropdown in the panel, because two kinds read as
 * two apps: a native list is drawn by the system in the system's type, at the
 * system's size, over a panel set at the whimsy tier. The menu carries what the
 * native list gave: type-ahead (typing jumps to the first match), Home, End and
 * the arrow keys, and press, drag and release. What is given up is the
 * listbox role - the menu announces itself as a menu - and the phone's wheel.
 * The board's faces (ui/appearance-controls.ts) are the same button, built
 * there, with each row set in its own face.
 */
export type PickerControl = Common & {
  type: 'picker', label: string, fieldId?: string,
  options?: (ctx: Ctx) => Option[],
  swatches?: (value: string) => string[],
  /**
   * The word for a value no option names: a state the control can be *in* but
   * cannot be put into. The palette's Custom is the only one - a pigment
   * chosen by hand is not a palette, and offering it as a row would be an
   * entry that picks the colour it is already showing. Without this a picker
   * handed such a value draws an empty box.
   */
  unlisted?: (value: string) => string,
  get?: () => string,
  set?: (value: string) => void,
};
export type ButtonsControl = Common & {
  type: 'buttons', group?: boolean, ariaLabel?: string, buttons: ButtonSpec[],
};
export type SlotControl = Common & { type: 'slot' };
/**
 * A line of prose under a row - or, with `tip`, folded behind a (?) at the end
 * of the row above it.
 *
 * `tip` is the button's accessible name, since its face is one character. The
 * row it joins is the control built immediately before it (buildSection, in
 * ui/panel.ts), so the two must be in the same half of the section: a tip
 * marked `advanced` after a row that is not would pull that row into the fold.
 */
export type HintControl = Common & {
  type: 'hint', html?: string, text?: (ctx: Ctx) => string, tip?: string,
};
/** One legend row: its keys, what they do, and - for a key only one build
 *  answers - where it shows. */
type KeyRow = readonly [keys: readonly string[], text: string, when?: (ctx: Ctx) => boolean];
export type KeysControl = Common & {
  type: 'keys', keys: readonly KeyRow[],
};
export type Control =
  | TextControl | CheckControl | RangeControl | PickerControl
  | ButtonsControl | SlotControl | HintControl | KeysControl;

/** One heading's worth of controls, and which tab it lives in. */
export type Section = {
  id?: string,
  tab: string,
  title?: string,
  /** The label on the section's one fold, and the id a stylesheet reaches it by. */
  fold?: string,
  foldId?: string,
  /** A titled section's fold label, where "Advanced" is the wrong word. `fold`
   *  cannot say it: that one means the whole section is the fold. */
  foldLabel?: string,
  when?: (ctx: Ctx) => boolean,
  /** Every control under this heading acts on a board. See Common.needsBoard. */
  needsBoard?: true,
  controls: Control[],
};

/**
 * One Connect button per provider this build carries.
 *
 * Written from the provider table rather than by hand, so the section's shape
 * follows what the app can do. The command name derives from the provider id
 * the way every `data-cmd` resolves - kebab in the markup, camel in the object
 * - which lets a second provider arrive without this file learning its name.
 *
 * Built once at module load. Whether a provider is *configured* is two
 * constants and cannot change while the tab is open; whether it is *connected*
 * changes on every sign-in, so that is a predicate on the row, not baked in.
 */
const CONNECT_BUTTONS: ButtonSpec[] = cloudProviders().map(p => ({
  cmd: `connect-${p.id}`,
  label: `Connect ${p.label}`,
  title: () => `Sign in, so boards can be kept in your own ${p.label}`,
}));

/** The three tabs, in order. The first is the one the panel always opens on. */
export const TABS = [
  { id: 'board',  label: 'Board' },
  { id: 'look',   label: 'Look' },
  { id: 'system', label: 'System' },
];

/**
 * The keyboard legend, which is a table and was sixteen rows of markup.
 *
 * A bare '+' between two keys is a joiner rather than a key: `ctrl+C X V` is
 * one chord and then two more letters that take the same modifier, and spacing
 * them all alike would read as five keys pressed in a row. First in a row,
 * last, or straight after a joiner, it is the plus key itself.
 */
const inBrowser = () => !isDesktop();

const KEYS: readonly KeyRow[] = [
  [['drag'], 'pan the board'],
  [['shift', '+', 'drag'], 'select a region'],
  [['space', '+', 'drag'], 'pan from anywhere'],
  [['wheel'], 'zoom to the cursor'],
  // Not a key, nor the wheel above it or the drag at the top: this is the
  // gesture legend as much as the keyboard one, and a touchpad is how most
  // readers will be moving around the board.
  [['two fingers'], 'scroll to pan, pinch to zoom'],
  // The escape from the platform's axis rail, which is the one thing about
  // panning on a touchpad that nobody guesses - see readWheel() in
  // canvas/input.ts.
  [['shift', '+', 'scroll'], 'pan sideways'],
  // Its vertical twin, and not a pinch, which readWheel() tells apart.
  [['ctrl', '+', 'scroll'], 'pan up and down'],
  [['shift', '+', 'click'], 'add to the selection'],
  // Not a zoom any more - see the dblclick listener in canvas/input.ts.
  [['dbl-click'], 'open or edit an item'],
  [['dbl-click'], 'label a line'],
  // While Join is out: the pair joins and the tool stays armed for the next.
  [['shift', '+', 'click'], 'join, and keep joining'],
  [['drag', '+', 'shift'], 'move along one axis'],
  [['+', '-'], 'zoom in, out'],
  [['0', 'F'], 'recenter, fit'],
  [['shift', '+', 'F'], 'zoom to the selection'],
  [['1'], '100% where you are'],
  [['←↑→↓'], 'nudge (+shift a step)'],
  [['esc'], 'cancel a drag, deselect, close'],
  [['?'], 'this list'],
  [['space'], 'play, pause a track'],
  // The desktop's Find (desktop/menu.ts) opens the same search.
  [['ctrl', '+', 'K'], 'search the board', inBrowser],
  [['ctrl', '+', 'K', 'F'], 'search the board', isDesktop],
  [['ctrl', '+', 'A'], 'select all'],
  [['ctrl', '+', 'C', 'X', 'V'], 'copy, cut, paste'],
  [['ctrl', '+', 'D'], 'duplicate selection'],
  [['F2'], 'rename'],
  [['del', 'backspace'], 'delete selection, or a marked line'],
  [['ctrl', '+', 'Z', 'Y'], 'undo, redo'],
  [['ctrl', '+', 'shift', '+', 'Z'], 'redo'],
  [['ctrl', '+', 'S', 'O'], 'save, open'],
  // Save is the file on the desktop, so the deliberate one asks where.
  [['ctrl', '+', 'shift', '+', 'S'], 'export a .mbrd', inBrowser],
  [['ctrl', '+', 'shift', '+', 'S'], 'save as', isDesktop],
  // The desktop menu's own accelerators (desktop/menu.ts).
  [['ctrl', '+', 'N'], 'new board', isDesktop],
  [['ctrl', '+', 'B'], 'your boards', isDesktop],
  [['ctrl', '+', '0', '-', '+'], 'page zoom', isDesktop],
  [['F11'], 'full screen', isDesktop],
  [['ctrl', '+', 'R'], 'reload', isDesktop],
  [['ctrl', '+', 'W'], 'close window', isDesktop],
  [['ctrl', '+', 'shift', '+', 'I'], 'developer tools', isDesktop],
];

const desktop = (ctx: Ctx) => !ctx.mobile;

/** The long side of the box round every item - the board's own extent. */
function spread() {
  const box = itemBounds(board.items);
  return box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) : 0;
}

/**
 * The sheet's size in board units, the sentence that makes the scale legible: a
 * factor-of-ten mistake shows up as a sheet that swallows the board rather than
 * hiding in a decimal nobody was going to check.
 */
function paperHint() {
  const s = board.settings;
  // The row is only on screen with a sheet up (`when: paperUp`), so this asks
  // about the size alone and never about whether it is drawn.
  const mm = paperMm(s.paper, s.paperLandscape);
  // The invitation to drag prints only when dragging is armed: a hint
  // describing a gesture the corners will not answer is worse than no hint.
  const drag = s.paperResize
    ? ' Drag a corner to match it against the board - that is what sets the scale.'
    : '';
  return mm
    ? `${Math.round(toUnits(mm.w, s.scale))} × ${Math.round(toUnits(mm.h, s.scale))} px, centred on 0,0.${drag}`
    : '';
}

/**
 * There is a sheet. Every row in the section but the button that raises one
 * asks this, and they are absent rather than greyed when the answer is no -
 * which is this panel's ordinary rule, the one `idle` is the exception to.
 *
 * The whole section, the scale half included: the sheet is what the board is
 * measured against, so with it down there is nothing for Units to name or for
 * a reset to put back.
 *
 * Mobile can never answer yes - setSetting refuses the keys and
 * activateLayoutSettings pins the flag false - so the section comes down there
 * altogether, which sectionVisible() does on its own once every row is hidden.
 * That costs a phone nothing: the scale bar is display:none on Mobile
 * (canvas.css), the readout is Desktop-only, and the sheet's own caption is
 * Desktop by construction, so no Mobile surface reads `settings.units` and the
 * picker for it was changing the wording of one sentence in this panel.
 */
const paperUp = (ctx: Ctx) => !ctx.mobile && board.settings.paperShow;


/**
 * Every section, in the order it appears inside its tab.
 *
 * `controls` is flat: the builder lifts everything marked `advanced` out into
 * one fold at the foot of the section, so a section reads here in the order it
 * reads on screen and the fold is not a nesting level in the data.
 */
export const SECTIONS: Section[] = [
  // What the Android app's updater offers (MbrdUpdate.java), first of all and
  // only while it has something. The phone has no title bar to put the
  // desktop's Update button in, and no pop-up either: every step is said on
  // this row (research/old/done-2026-09-15.md, R7). A press saves the
  // board, then installs, at once when the update has downloaded and after
  // downloading it otherwise. The panel stays open so the row can count.
  {
    id: 'update', tab: 'board',
    controls: [
      { type: 'buttons', when: () => !!updateOffer(), buttons: [
        { cmd: 'install-update', label: 'Update', className: 'primary',
          says: () => updateWord(updateOffer()),
          idle: () => updateOffer()?.state === 'downloading',
          title: () => updateOffer()?.note ?? '' },
      ] },
    ],
  },
  // --- Board -------------------------------------------------------------
  {
    // Every row here names the board or produces a file out of it, down to the
    // title in the field at the top, so the whole heading comes down together
    // where there is no board to name.
    id: 'name', tab: 'board', title: 'Board', foldLabel: 'More', needsBoard: true,
    controls: [
      // A real input rather than a <p> you can click into, so it is reachable
      // by tab and by touch without inventing a role. Empty rather than
      // carrying "Untitled board": that is the placeholder, and setTitle()
      // falls back to it. ui/board-title.ts owns the typing - wireTitleField().
      { id: 'board-title', type: 'text', external: true, className: 'board-title',
        maxlength: 32, placeholder: 'Untitled board', ariaLabel: 'Board name' },
      // Save alone in the open. It is the only button on this tab with a
      // deadline attached, so it carries `primary`. Save As and Export are
      // rarer, and wait in the fold below with the other rows that make a file.
      { type: 'buttons', buttons: [
        { cmd: 'save', label: 'Save', className: 'primary', closesPanel: true },
      ] },
      // Which board you are on. Three verbs, one row, none of them about the
      // board's contents.
      //
      // Merging two boards is *not* a fourth button here. It is reached by
      // dropping a .mbrd on a board that already has something on it, which
      // asks whether to open it or fold it in - see importFiles() in
      // import/drop.ts. A row here would be a second door onto a question that
      // only comes up when a file arrives, and would open a picker to ask what
      // the drop has already answered.
      { type: 'buttons', buttons: [
        { cmd: 'new', label: 'New', closesPanel: true },
        { cmd: 'open', label: 'Open', closesPanel: true },
        { cmd: 'library', label: 'Boards', closesPanel: true },
      ] },
      // The style tile is not a file: it is a card you add to the board - the
      // palette, the faces and a few of the pictures. The title says what it
      // draws from, because the answer changes with the selection.
      //
      // Below the fold, decided by how often the row is wanted rather than by
      // what it acts on: as rarely as the three below it. What is left above
      // the fold is the whole of what this section is for - the board's name,
      // what happens to it, and which board you are on.
      //
      // Save As and Export head the fold. Two rows written out rather than one
      // row with a button appearing in the middle of it, because `when` is a
      // control's and not a button's. The desktop's is the longer one, the
      // shape a document application has: Save As asks where, Export makes a
      // copy that is not the file.
      { type: 'buttons', advanced: true, when: () => !isDesktop(), buttons: [
        { cmd: 'export', label: 'Export', closesPanel: true },
      ] },
      { type: 'buttons', advanced: true, when: isDesktop, buttons: [
        { cmd: 'saveAs', label: 'Save As…', closesPanel: true },
        { cmd: 'export', label: 'Export', closesPanel: true },
      ] },
      { type: 'buttons', advanced: true, needsBoard: true, buttons: [
        { cmd: 'add-style-tile', label: 'Add style tile', closesPanel: true,
          title: () => (selectionSize()
            ? 'The palette, the faces and the cards you have selected'
            : 'The palette, the faces and a few of the pictures') },
      ] },
      // And the three that produce a file which is not this board - one idea,
      // make something to send somebody, stated three ways. Behind the same
      // fold as the style tile rather than one of their own: a section may have
      // exactly one fold (buildSection, ui/panel.ts). So the fold is named for
      // how often its rows are wanted, which is what lets a row that makes no
      // file sit at the top of it.
      //
      // Share keeps its own row and guard: it shows only where the engine can
      // put a file into the share sheet, hidden outright otherwise, the rule
      // the paper sheet follows - a Share that quietly turned into a download
      // would be a promise the phone could not read. See shareBoard().
      //
      // **Share link is not here.** That other kind of share - upload the board
      // and hand out a URL - sits in the Sync section with the account it
      // needs, argued there. The labels are what stop the two being confused:
      // this one is **Send file** and that one is **Share link**.
      { type: 'buttons', advanced: true,
        when: () => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',
        buttons: [{ cmd: 'share', label: 'Send file', closesPanel: true }] },
      // A picture of the board, for showing rather than reopening - a JPEG to
      // send or a PDF to print. Derived artefacts, not board files; see
      // exportPicture() in commands/file.ts. The ellipsis is the box each
      // opens first (ui/export-options.ts).
      { type: 'buttons', advanced: true, buttons: [
        { cmd: 'export-image', label: 'Save image…', closesPanel: true },
        { cmd: 'export-pdf', label: 'Save PDF…', closesPanel: true },
      ] },
    ],
  },
  // No Add section. Its two buttons - Add files, Write a note - are the
  // toolbar's leftmost two, on screen unprompted at all times and named there
  // in fewer words. A panel you open to reach a button already in view teaches
  // that the button in view is not the real one. This tab is the file, where it
  // goes, how it is laid out; putting things *on* the board is the toolbar's.
  {
    // Board layout and Arrange were one idea under two headings: which of the
    // two arrangements you are in, how wide it is, and how things are placed
    // within it are the same question asked three times.
    id: 'arrange', tab: 'board', title: 'Arrange',
    controls: [
      // How the board is shown, above how it is laid out: the same question at
      // two scales - which of the board's three faces you are looking at, and
      // how things are placed within it. On a phone this row is the navigation,
      // so it stays on the first tab, above the fold.
      //
      // Three segments, not two, with exactly one lit - the shape the zoom
      // cluster and the history pair already have. With two, nothing said "you
      // are on the canvas": Feed and Playlist were ways off it, so on a Desktop
      // board neither was pressed and the row said nothing about the state.
      //
      // The commands underneath are unchanged. Playlist pressed on the canvas
      // opens the floating player rather than taking the board over, so Canvas
      // stays lit through it: you are still on the canvas, with a player open.
      { type: 'buttons', buttons: [
        { id: 'view-canvas', cmd: 'canvas', label: 'Canvas', closesPanel: true,
          pressed: ctx => !ctx.mobile,
          title: () => 'The freeform board' },
        { id: 'view-feed', cmd: 'feed', label: 'Feed', closesPanel: true,
          pressed: ctx => ctx.mobile && currentLens() === 'feed',
          title: ctx => (ctx.mobile
            ? 'Back to the canvas'
            : 'Show everything on the board as a scrollable feed') },
        // Only once music has been on the board (board.hadMusic): before that
        // it opened an empty player. Shown on the Playlist lens whatever the
        // flag says, since it is the button that is lit there.
        { id: 'view-playlist', cmd: 'playlist', label: 'Playlist', closesPanel: true,
          when: ctx => board.hadMusic || (ctx.mobile && currentLens() === 'playlist'),
          pressed: ctx => ctx.mobile && currentLens() === 'playlist',
          title: ctx => (ctx.mobile
            ? 'Back to the canvas'
            : 'Open the board’s audio as a player') },
      ] },
      // The Feed's column count is derived from the screen width, not chosen -
      // a phone gets two, a wide screen more - so there is no Grid width select.
      // Two catalogues, because the layouts answer different questions: Desktop
      // picks a shape; Mobile packs a column and throws every computed position
      // away, so it can only pick the order the packer meets things in. Six of
      // Desktop's seven meant nothing here. From here down the section is about
      // a board's contents rather than which face of it you see, so these four
      // grey where the View row above does not - that row is the only thing on
      // this tab a changelog reader can press, and pressing it is how they leave.
      { id: 'arrangement', type: 'picker', label: 'Layout', needsBoard: true,
        options: ctx => (ctx.mobile ? MOBILE_ARRANGEMENTS : ARRANGEMENTS)
          .map(a => ({ value: a.id, label: a.label })),
        get: () => board.arrangement,
        set: v => setArrangement(v) },
      // Spacing and Snap sit in the open, not behind a fold: an arrangement is
      // picked by name and these two tune how it packs, the everyday dials of
      // the section. Spacing stays edge-to-edge world px - see
      // arrange/arrangements.ts.
      //
      // Spacing is a rule the next Rearrange will use. All three are the
      // canvas's: the Feed packs its wall by order, at a fixed gap, with no
      // grid, so on a phone none of them changed anything and they are absent.
      { type: 'buttons', needsBoard: true, when: desktop,
        buttons: [{ cmd: 'rearrange', label: 'Rearrange everything', closesPanel: true }] },
      { id: 'spacing', type: 'range', label: 'Spacing', needsBoard: true, when: desktop,
        min: 0, max: 200, step: 4, unit: 'px',
        get: () => board.settings.spacing,
        set: v => setSetting('spacing', v) },
      { id: 'opt-snap', type: 'check', label: 'Snap to grid', needsBoard: true, when: desktop,
        get: () => !!board.settings.snap,
        set: v => setSetting('snap', v) },
    ],
  },

  // --- Sync ---------------------------------------------------------------
  //
  // Its own section rather than two more rows in the Board fold, because it
  // answers a different question. Everything in that fold *makes something to
  // send somebody* - a picture, a summary, a file, a link - and each leaves and
  // is finished with. This is where the board *lives*, Save and Export's
  // question, the one thing on this tab still true after you close the lid.
  //
  // Under Arrange, putting the sections in the order they are wanted: what this
  // board is called and where it goes, then how it is laid out, then this. Tour
  // follows it - two ways of handing the whole screen to the board, wanted last.
  //
  // Called Sync and not Cloud, the same choice the buttons make: the provider
  // is an implementation detail that will be two providers soon enough, and
  // what somebody opening this is looking for is the verb.
  //
  // On the Board tab and not System, for the reason the Tour section gives:
  // System is the app, this is about this board. Two boards open in two tabs
  // have two different answers to every row here.
  //
  // Absent outright where the build carries no cloud identifiers - the schema's
  // rule applied to a capability rather than a control. See the header of
  // storage/cloud/config.ts for what filling those two strings in involves. A
  // heading with nothing under it is checked for by tests/settings-panel.test.js,
  // so the guard has to be on the section rather than on each row - which is
  // also why the Share link row below carries no `canShareLink` of its own.
  {
    id: 'cloud', tab: 'board', title: 'Sync', needsBoard: true, when: canShareLink,
    controls: [
      // **The account comes first and the board comes second.** Nothing below
      // this row can mean anything without somewhere to sync *to*, so until
      // there is an account connected this section is one row of Connect
      // buttons and nothing else - not a greyed-out board control in sight,
      // which is the schema's absence rule applied to a whole section's worth of
      // furniture.
      //
      // One button per provider the build carries, written from the table rather
      // than by hand: a provider with no identifiers has no button, and the day
      // OneDrive's module and its two strings land, its button appears here with
      // no edit to this file. See cloudProviders().
      //
      // Computed once, at module load, which is correct for exactly this
      // question and would be wrong one line down: whether a provider is
      // *configured* is two constants and cannot change while the tab is open,
      // where whether it is *connected* changes on every sign-in and is asked
      // through a predicate below.
      { type: 'buttons', when: () => !anyConnected(), buttons: CONNECT_BUTTONS },
      // **No status line here, and there was one.** It said when this board last
      // went up - "Kept in Google Drive, last sent a moment ago" - and it came
      // out for the same reason the sentence before it did: the section is four
      // buttons, and a paragraph over four buttons is a caption people learn to
      // scroll past. The state is already legible from which buttons are
      // standing there, which is what the `when` predicates below are doing.
      //
      // It was also never quite honest. paintPanel() repaints on `board`,
      // `settings`, `layout` and `lens` and on nothing else, so the reading was
      // a snapshot as of the last paint rather than a clock - "a moment ago" sat
      // there saying so an hour later. **If a status line ever comes back it
      // needs a repaint trigger first**, not just a sentence.
      //
      // Two rows that are never both present. The schema's rule is absence
      // rather than disabling, and "Save to cloud" on a board that is already
      // being kept is a button that lies about what it does.
      //
      // **No `primary` on either.** Save carries it on this tab and the section
      // above argues why - it is the only button here with a deadline attached -
      // so a second one would be two answers to "what is the obvious thing to
      // press", which is the same as none.
      //
      // **Save to cloud / Load from cloud**, which is a deliberate borrowing.
      // The pair above them on this tab is Save and Open, and these do the same
      // two things one place further away - so they are named for the verbs
      // everybody already has rather than for the machinery underneath. "Keep
      // this board" described the arrangement accurately and told nobody what
      // pressing it would do.
      //
      // Sync now keeps its own name and is not a third "Save to cloud", because
      // it is the one of the three that is not a decision: the board is already
      // going up on its own, and this is the button for somebody who does not
      // want to wait for the next autosave to do it.
      { type: 'buttons', when: () => anyConnected() && !syncedNow(), buttons: [
        { cmd: 'cloud-sync', label: 'Save to cloud',
          title: () => 'Copy it to your connected account and keep it up to date' },
        { cmd: 'cloud-open', label: 'Load from cloud',
          title: () => 'Open a board this app has put in your account, from any machine' },
      ] },
      { type: 'buttons', when: () => anyConnected() && !!syncedNow(), buttons: [
        { cmd: 'cloud-push', label: 'Sync now',
          title: () => 'Send whatever has changed since the last sync' },
        { cmd: 'cloud-open', label: 'Load from cloud',
          title: () => 'Open a board this app has put in your account, from any machine' },
      ] },
      // Sharing a link, which lived in File → Advanced until it came here.
      //
      // It moved because of what it actually needs. Every other row in File
      // writes a file, or asks the engine to hand one over, and needs nothing
      // beyond this machine; this one uploads the board to the same Google
      // account the two rows above sync to, using the same sign-in and the same
      // token. Sitting under Save and Export made it look like a third kind of
      // export, and the first thing it did when pressed was open a sign-in
      // window nothing on that screen had mentioned.
      //
      // **Its own row, and not a third button beside Sync now.** The pair above
      // is one board's copy going up and coming back; this hands a URL to
      // somebody else, which is the only row in the section that involves
      // another person. Three buttons in a line would read as three degrees of
      // the same thing.
      //
      // Guarded on being connected, like everything else below the Connect
      // buttons. The command signs in on its own if it has to - see
      // cmds.shareLink, which keeps that path for the share arriving from
      // anywhere else - but a section whose first rule is "the account comes
      // first" should not carry one row that quietly disagrees.
      //
      // The upload is a **separate copy** from the synced one and deliberately
      // so: a share is a board as it was the moment it was sent, and a sync is a
      // board as it is now. Pointing a link at the syncing folder would mean
      // every later edit rewriting what somebody was already looking at.
      //
      // Shared links beside it: the links already handed out, each to copy
      // again or take back. The same person, the same account, the other end
      // of the same act. It opens a menu over the panel, so it leaves the
      // panel open.
      { type: 'buttons', when: () => anyConnected(), buttons: [
        { cmd: 'share-link', label: 'Share link', closesPanel: true,
          title: () => 'Upload a copy and copy a link to it — whoever you send it to needs no account' },
        { cmd: 'shared-links', label: 'Shared links',
          title: () => 'The links you have shared: copy one again, or stop sharing it' },
      ] },
      // Behind the fold, and not dressed as a danger: it stops the syncing and
      // leaves the stored copy exactly where it is. The other reading of it -
      // "take my board out of my Drive" - is the row below, which is a
      // different button saying a different sentence. See forgetSync().
      { type: 'buttons', advanced: true, when: () => anyConnected() && !!syncedNow(), buttons: [
        { cmd: 'cloud-stop', label: 'Stop syncing',
          title: () => 'Leaves the stored copy where it is; nothing is removed' },
      ] },
      // The only row in this section that takes something away, and the fold is
      // the right place for exactly that reason - this one *is* rarely wanted,
      // which is the test Log out failed. Last, under everything it undoes.
      //
      // Guarded on the account rather than on this board, because it is not
      // about this board: it clears every board mbrd has put in that Drive, and
      // the shared files besides. A row that appeared only on a synced board
      // would hide the button on the machine most likely to want it - the one
      // signed in with nothing of its own up there.
      //
      // `danger` on the dialog and not on the button. The panel has no red
      // button and should not grow one here: a control that looks alarming on
      // every visit stops being read, and the alarming thing is the question,
      // which is where cmds.cloudPurge puts it.
      { type: 'buttons', advanced: true, when: () => anyConnected(), buttons: [
        { cmd: 'cloud-purge', label: 'Remove all from Drive',
          title: () => 'Move every board and shared file mbrd has put there to your Drive trash' },
      ] },
      // **Not behind the fold, and it was for one revision.** The argument for
      // putting it there was that logging out is rare - which is true and is
      // not what the fold is for. The fold holds rows that are rarely *wanted*;
      // a Log out is wanted seldom and then urgently, by somebody on a shared
      // machine or signed in as the wrong account, and that is the worst kind
      // of row to make somebody open a disclosure triangle to find. Rarity is
      // not the test. Being able to find it under pressure is.
      //
      // Last of the visible rows, after Share link, because it undoes the
      // Connect button at the top: the section reads down from attaching an
      // account to letting it go.
      { type: 'buttons', when: () => anyConnected(), buttons: [
        { cmd: 'cloud-sign-out', label: 'Log out',
          title: () => 'Forget the sign-in in this browser. Nothing in your Drive is touched' },
      ] },
    ],
  },
  // --- Other --------------------------------------------------------------
  //
  // The tour, the Timeline and the board's contents: three ways of looking at
  // this board that are not its settings. Last on the tab, under Sync. Called
  // Other since the Timeline and Board contents joined the tour here from the
  // System tab (R32, 2026-09-14): both are about the board, not the browser.
  //
  // The whole of the tour, and the only place in the app that says anything
  // about one: the item menu's ticked row and the board menu's "Take the tour"
  // both went when this section arrived (see ui/menu.ts). A tour is an order,
  // and an order needs a list - a panel, never a menu. A tour is not a way the
  // board is dressed, it is a thing the board *is*. It travels in the .mbrd
  // beside the connections and the playlist order, which are board data for
  // that reason.
  {
    id: 'tour', tab: 'board', title: 'Other', needsBoard: true,
    controls: [
      // Shows the Timeline bar, or puts it away. A box and not a button, as
      // Show grid is, because it is on or off. First in the section, so the
      // gear's "Hide timeline" toast points at a row that is easy to find.
      // ui/timeline-view.ts ticks it when the bar goes up some other way,
      // since the panel repaints on nothing the bar announces.
      //
      // *Earlier versions* stood beside this until v0.198 and is gone. The
      // two answered the same question at two grains - "take me back" by
      // named copy and "take me back" by step - and once a step could be
      // named, the copies were a second, coarser, more expensive answer.
      { id: 'opt-timeline', type: 'check', label: 'Show timeline',
        get: () => timelineShown(),
        set: v => { if (v !== timelineShown()) toggleTimeline(); } },
      // Two verbs, one row - the whole of the tour in this panel. Take the tour
      // carries the weight: it is the answer on a board that already has stops,
      // where the editor is where you go once.
      //
      // Both close the panel, unlike every other pair on this tab: neither is a
      // setting, they are two ways of handing the whole screen to the board.
      // The editor lives on the board itself - see the head of ui/tour-edit.ts
      // - and a panel left open under it is hidden anyway (:root.is-tour-edit
      // in chrome.css), so a row that did not close it would close it invisibly.
      //
      // A board with no tour has one row, Create tour: there is nothing to take
      // and nothing to edit yet, and two dead buttons said so less clearly.
      { type: 'buttons', buttons: [
        { cmd: 'tour-edit', label: 'Create tour', className: 'primary',
          closesPanel: true, when: () => !tourStops(),
          title: () => 'Number the cards on the board, in the order they are seen' },
        { cmd: 'tour-start', label: 'Take the tour', className: 'primary',
          closesPanel: true, when: () => tourStops() > 0,
          title: () => `${tourStops()} stops, in order` },
        // `ariaPressed` as a starting value rather than a `pressed` predicate,
        // which is why this table does not import ui/tour-edit: the panel
        // repaints on `board`, `settings`, `layout` and `lens`, and opening the
        // editor is none of those - a predicate would be read once and then be
        // wrong until something unrelated repainted. The module writes the
        // attribute itself, the shape `debug-grips` uses one tab over.
        { cmd: 'tour-edit', label: 'Edit the tour', ariaPressed: 'false',
          closesPanel: true, when: () => tourStops() > 0,
          title: () => 'Number the cards on the board, in the order they are seen' },
      ] },
      // The only way to Optimize from this panel, and that is the whole of the
      // arrangement: the sheet says what the board is made of and what the
      // heaviest thing in it weighs, and its own footer offers Optimize as the
      // next step. A label rather than a question - the sheet keeps "What is in
      // this board" as its own heading, where a heading is allowed to be one.
      { type: 'buttons', buttons: [
        { cmd: 'inventory', label: 'Board contents', closesPanel: true,
          title: () => 'Counts, weights and the heaviest files. A row takes you to the card' },
      ] },
    ],
  },

  // --- Look --------------------------------------------------------------
  {
    id: 'appearance', tab: 'look', title: 'Appearance', foldId: 'appearance-advanced',
    controls: [
      // The whimsy axis. One dial from scrapbook to spec sheet - it moves shape,
      // type, motion, elevation, ornament and contrast together. Wired by
      // ui/appearance.ts; the three names below are the stops, and they are
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
      // 'dynamic' is DYNAMIC in ui/appearance-controls.ts, which owns what the
      // menu does with it; this file is data and imports no panel module, so
      // tests/settings-panel.test.js holds the two strings together.
      // Each row carries its palette's own paper, accent and ink as a split
      // chip, so you can see what you are choosing between. See buildPicker()
      // in ui/panel.ts.
      //
      // `swatches` reads the colours out of the live tokens.css rather than from
      // a table here - see paletteSwatches() in ui/appearance-controls.ts, which
      // explains why a copy in JS would be a second definition that drifts.
      { id: 'opt-palette', type: 'picker', label: 'Palette', external: true,
        swatches: paletteSwatches,
        // Set by hand from the Pigment row below, never from this menu, and
        // dropped the moment a palette is picked (setPalette drops every
        // pigment token). 'custom' is CUSTOM in ui/appearance-controls.ts,
        // which owns the state; this file is data and imports no panel module,
        // so tests/settings-panel.test.js holds the two strings together - the
        // same arrangement Dynamic has.
        unlisted: value => (value === 'custom' ? 'Custom' : ''),
        options: () => [
          { value: 'dynamic', label: 'Dynamic' },
          { value: '', label: 'Papyrus' },
          { value: 'absinthe', label: 'Absinthe' },
          { value: 'tearose', label: 'Tea rose' },
          { value: 'orca', label: 'Orca' },
        ] },
      // The two face menus, in the fold with everything else that sets one
      // token at a time. They stood above it for a year on the argument that a
      // dropped face appears in them and a feature nobody can find is a feature
      // that does not work - which the (?) below now answers instead: the way
      // in is named where the menus are, and the two dials that move the whole
      // look are what the tab opens on.
      { id: 'appearance-type', type: 'slot', className: 'field-pair', advanced: true },
      // The one tip in the panel, and the shape the argument above settled into:
      // a line nobody needs twice, at the end of the row it is about rather than
      // under it. Both wordings in one control - a phone cannot drop, so there
      // the way in is the Add button's file picker, which sends a font down the
      // same path a drop does. `text` and not `html`, so the two codes are read
      // as the words they are; a popover is prose, not a row.
      { id: 'type-hint', type: 'hint', advanced: true, tip: 'Adding your own typeface',
        text: ctx => (ctx.mobile
          ? 'Add your own face with Add, then Files: a .woff2, .ttf or .otf.'
          : 'Drop a .woff2, .ttf or .otf on the board to add your own face.') },
      // The board's own dropped faces, each with a way to take it back off - filled
      // and shown/hidden by ui/fonts.ts, empty (and gone) until one is dropped.
      // In the fold with the menus it fills: a list of faces over a pair of
      // menus that were not there would be an answer to nothing.
      { id: 'appearance-fonts', type: 'slot', advanced: true },
      // Everything below the fold. The three above it between them move every
      // token these set one at a time, which is what makes the rest advanced
      // rather than merely secondary.
      { id: 'appearance-vars', type: 'slot', advanced: true },
      // How many of the board's pictures the palette is read from, newest first.
      // `ownVisibility` because ui/appearance.ts takes this row down whenever the
      // palette is not Dynamic - the dial means nothing while no picture is being
      // read - and a panel repaint that put it back would fight it every time
      // any setting changed.
      // 25 stops, and the last one is not a count: it reads "Every photo" and is
      // stored as 0. ui/appearance.ts owns the mapping and rewrites `max` from
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
        buttons: [{ cmd: 'reset-appearance', label: 'Reset' }] },
    ],
  },
  {
    id: 'board-grid', tab: 'look', title: 'Board & grid', needsBoard: true,
    controls: [
      // The lean each card rests at on Softish and Middle. Greyed at Harsh,
      // which stands every card square whatever this says (quality.css), so
      // the box there would change nothing. Desktop only: the Feed does not
      // tilt its tiles.
      { id: 'opt-tilt', type: 'check', label: 'Tilt cards', when: desktop,
        idle: () => board.settings.appearance.whimsy === 2,
        get: () => board.settings.tilt !== false, set: v => setSetting('tilt', v) },
      // The grid, the axes and the readout are drawn over the canvas only, so
      // the Feed has nothing for them to show or hide.
      { id: 'opt-grid', type: 'check', label: 'Show grid', when: desktop,
        get: () => !!board.settings.grid, set: v => setSetting('grid', v) },
      { id: 'opt-axes', type: 'check', label: 'Show axes', when: desktop,
        get: () => !!board.settings.axes, set: v => setSetting('axes', v) },
      { id: 'opt-hud', type: 'check', label: 'Show readout', when: desktop,
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
      // On the grid only, since off it a card is its picture's shape: checked =
      // photos and videos fill their cells and crop; unchecked = the whole
      // picture fits inside and letterboxes. Board-wide default; a single item
      // overrides it from its right-click menu.
      { id: 'opt-mediafit', type: 'check', label: 'Crop photos to the grid',
        when: ctx => desktop(ctx) && !!board.settings.snap,
        get: () => board.mediaFit !== 'contain',
        set: v => setMediaFit(v) },
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
    // Called Paper rather than Real size because the sheet is what somebody is
    // looking for when they come here.
    //
    // A heading and not a fold. It was one whole section behind one word, on
    // the argument that a board which never puts a sheet up never needs a
    // millimetre either - which is true of the board and not of the person,
    // who has to know the section exists before the argument can apply to
    // them. The two sheet rows are the ones anybody comes to this tab for; a
    // summary reading "Paper" hid the paper.
    id: 'real-size', tab: 'look', title: 'Paper', needsBoard: true,
    controls: [
      // The sheet is up or it is down, and that is a button rather than an
      // entry in the size list. "None" made "no sheet" one of the sizes: it
      // put raising a sheet and choosing A4 into the same act, it left the
      // three rows under it live over nothing, and a board that put its sheet
      // away forgot which one it had been holding. One word, and the word is
      // what pressing it does.
      //
      // A sheet is a Desktop question throughout: Mobile is a narrow strip
      // with a fixed width and no page to fit anything onto, and setSetting()
      // refuses all four of these keys there.
      { id: 'paper-show', type: 'buttons', when: desktop, buttons: [
        { cmd: 'toggle-paper', label: 'Show paper',
          says: () => (board.settings.paperShow ? 'Hide paper' : 'Show paper') },
      ] },
      // Everything below drops in with the sheet and goes with it - see
      // paperUp() above. They were greyed for a while instead, on the argument
      // that a row you can see is a row you know is there; what that actually
      // built was a section of eight dead controls under one live button, which
      // is worse than a short section that grows.
      { id: 'opt-paper', type: 'picker', label: 'Paper outline', when: paperUp, reveal: true,
        options: () => PAPERS.map(p => ({ value: p.id, label: p.label })),
        get: () => board.settings.paper, set: v => setSetting('paper', v) },
      // Orientation is a radio group in behaviour, drawn with aria-pressed:
      // both states are equally ordinary, and a checkbox saying "landscape"
      // would make one of them the deviation.
      { id: 'paper-orient', type: 'buttons', when: paperUp, reveal: true,
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
        when: paperUp, reveal: true,
        get: () => !!board.settings.paperResize, set: v => setSetting('paperResize', v) },
      { id: 'paper-hint', type: 'hint', when: paperUp, reveal: true, text: paperHint },
      // Below the sheet rather than above them, which is where it was. Units
      // decide no geometry - they pick the words the two readouts underneath
      // are said in, so they belong with those rather than at the head of a
      // block about paper, where the first thing the section asked was a
      // question nobody had come for.
      { id: 'opt-units', type: 'picker', label: 'Units', when: paperUp, reveal: true,
        options: () => [
          { value: 'metric', label: 'Millimetres, centimetres, metres' },
          { value: 'imperial', label: 'Inches and feet' },
        ],
        get: () => board.settings.units, set: v => setSetting('units', v) },
      // Dragging the sheet's corners is how the scale gets set - never by
      // typing a units-per-millimetre figure, which is the same fact said in a
      // language nobody thinks in. It is also, being the only way, how the
      // scale gets lost, and no setting is on the undo stack.
      { type: 'buttons', when: paperUp, reveal: true, buttons: [
        // "Reset scale", not "Reset size". The item menu already ships a row
        // called Reset size (menu.ts) and it does something else entirely:
        // that one puts a card back to its intrinsic size, this one throws
        // away the board's units-per-millimetre. Two different acts under one
        // word, a settings panel and a right-click apart.
        { cmd: 'reset-scale', label: 'Reset scale' },
      ] },
      { id: 'scale-hint', type: 'hint', when: paperUp, reveal: true,
        text: () => (board.items.length
          ? `Everything on this board fits in ${formatLength(spread(), board.settings.scale, board.settings.units)}.`
          : 'Drop something in, then measure the board from it.') },
    ],
  },

  // --- System ------------------------------------------------------------
  {
    // The one section that is not about a board at all. See quality.ts: it is
    // per device and never travels inside a .mbrd, because how hard someone
    // else's phone should work is not a property of your moodboard.
    // "More settings" rather than "Advanced": the fold now opens with the sound
    // dial, which is not an advanced anything - it is an ordinary choice that
    // happens to be off by default. The word has to cover both it and the
    // quality overrides under it.
    id: 'quality', tab: 'system', title: 'Quality', foldLabel: 'More settings',
    controls: [
      { id: 'opt-quality', type: 'range', label: 'Quality',
        min: 0, max: 2, step: 1, silent: true,
        stops: QUALITY_LEVELS.map(l => l.label),
        get: () => QUALITY_LEVELS.findIndex(l => l.id === qualityLevel()),
        set: v => setQualityLevel(QUALITY_LEVELS[v]?.id) },
      // In this section rather than in Appearance, and that is the same line
      // the section's own note draws: how loud somebody else's laptop should be
      // is not a property of your moodboard, so it never travels inside a
      // .mbrd. It is stored under mbrd.sound like every other per-device
      // choice - which means "Clear everything" sweeps it and /patch cannot
      // change it, both for free (prefs.ts).
      //
      // One four-stop dial rather than a checkbox and a volume beside it: two
      // controls can disagree with each other, and "Off" is a stop on this one.
      // Defaults to Off: the sounds are experimental, and the hint under the
      // dial says so whenever it is on.
      //
      // The quality dial deliberately does not touch it. Sound costs nothing to
      // draw, and muting it on a tired phone would be tidying rather than
      // helping.
      //
      // Behind the fold, which is where a row that defaults to Off and says
      // "experimental" of itself belongs: somebody who wants the sounds goes
      // looking for them once, and everybody else was reading past a dial for a
      // feature that is not on. It heads the fold rather than joining the
      // overrides below, because it is a dial of its own and not one of the
      // quality flags Reset puts back.
      { id: 'opt-sound', type: 'range', label: 'Sounds (experimental)',
        min: 0, max: 3, step: 1, silent: true, advanced: true,
        stops: SOUND_STOPS,
        get: () => soundLevel(),
        set: v => setSoundLevel(v) },
      { id: 'sound-hint', type: 'hint', when: () => soundLevel() > 0, advanced: true,
        text: () => 'Experimental feature. Might suck.' },
      // The overrides. Each reads the resolved flag - so moving the dial moves
      // every one of these - and writes an override that outranks the dial from
      // then on. "Reset" at the foot is the way back, the same as
      // Appearance's.
      // "Animated GIFs" and not "Animate GIFs": the checkboxes in this row are
      // things the app has - shadows, backdrops, animations, paper texture -
      // and a command among them would read as a button rather than a state.
      { id: 'q-motion', type: 'check', label: 'Animated GIFs', advanced: true,
        get: () => quality.motion, set: v => setQualityOverride('motion', v) },
      { id: 'q-shadows', type: 'check', label: 'Card shadows', advanced: true,
        get: () => quality.shadows, set: v => setQualityOverride('shadows', v) },
      { id: 'q-blur', type: 'check', label: 'Blurred backdrops', advanced: true,
        get: () => quality.blur, set: v => setQualityOverride('blur', v) },
      { id: 'q-anim', type: 'check', label: 'Animations', advanced: true,
        get: () => quality.anim, set: v => setQualityOverride('anim', v) },
      // The two that cost most on a phone. "Paper texture" is the window-sized
      // grain layer and not a fence's or the Mobile sheet's, which are drawn
      // inside the board's own transform and cost nothing per frame.
      { id: 'q-grain', type: 'check', label: 'Paper texture', advanced: true,
        get: () => quality.grain, set: v => setQualityOverride('grain', v) },
      // Named for what is given up rather than for the mechanism: with it off a
      // photograph is drawn from its display copy however far you zoom in.
      { id: 'q-hires', type: 'check', label: 'Full-size photos when zoomed in', advanced: true,
        get: () => quality.hires, set: v => setQualityOverride('hires', v) },
      { id: 'q-sharpness', type: 'picker', label: 'Picture sharpness', advanced: true,
        options: () => SHARPNESS_STEPS.map(s => ({ value: String(s.px), label: s.label })),
        get: () => String(quality.sharpness),
        set: v => setQualityOverride('sharpness', +v) },
      // The one lever here that is a trade rather than a reduction: a smaller
      // batch is a smoother zoom and a slower fill-in. See BUILD_BUDGET's note
      // in canvas/items.ts.
      { id: 'q-build', type: 'picker', label: 'Cards built per frame', advanced: true,
        options: () => BUILD_STEPS.map(s => ({ value: String(s.n), label: s.label })),
        get: () => String(quality.build),
        set: v => setQualityOverride('build', +v) },
      { type: 'buttons', advanced: true,
        buttons: [{ cmd: 'reset-quality', label: 'Reset' }] },
    ],
  },
  {
    // The wheel, and so far nothing else. Both rows are per device and stored
    // in localStorage (controls.ts) rather than in the board: which mouse is on
    // the desk is not a property of a moodboard, and a board that arrived with
    // somebody else's zoom reversed would be a board that broke your hand.
    //
    // Between Quality and This browser on purpose - all three are about this
    // copy of the app - and Canvas only, because the Feed has one axis and
    // everything that arrives moves it along that axis, so neither row has
    // anything to change there.
    id: 'controls', tab: 'system', title: 'Controls', when: desktop,
    controls: [
      // A picker rather than a checkbox called "Ctrl to zoom": the two answers
      // are two conventions, both ordinary, and a checkbox would make one of
      // them the deviation - the same argument Paper orientation is drawn with.
      { id: 'opt-wheel', type: 'picker', label: 'Mouse wheel',
        options: () => [
          { value: 'zoom', label: 'Zooms the board' },
          { value: 'scroll', label: 'Pans the board, Ctrl zooms' },
          // For a wheel the app keeps taking for a touchpad - a hi-res one on
          // Linux, where the two send the same numbers (readWheel()).
          { value: 'zoom-all', label: 'Always zooms, touchpad too' },
        ],
        get: () => wheelMode(), set: v => setWheelMode(v) },
      // No line under these about the trackpad, though both rows leave it
      // alone bar the third option, which names it: two fingers pan and a
      // pinch zooms whatever else the wheel is set to,
      // and somebody holding a trackpad finds that out by using it. The rule
      // is written where it is enforced - readWheel(), in canvas/input.ts.
      { id: 'opt-wheel-reverse', type: 'check', label: 'Reverse zoom direction',
        get: () => zoomReversed(), set: v => setZoomReversed(v) },
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
    // A getter, read when the panel is built, which is after main.ts has wired
    // the shell: in the apps there is no browser to name.
    id: 'browser', tab: 'system', get title() { return isDesktop() ? 'This app' : 'This browser'; },
    needsBoard: true,
    controls: [
      // Board contents and Timeline stood here until R32 (2026-09-14), and went
      // to the Board tab's Other section: both are about the board.
      //
      // Feed | Playlist used to live here, next to Clear everything; it is the
      // board's own navigation, so it moved to the top of the Board tab (the
      // 'views' section above). What is left here is genuinely about this copy of
      // the app in this browser: read what it is holding, reload it, wipe it.
      // The refresh gesture this app takes away: pull-to-refresh is off because
      // every downward swipe on the board is a pan, and on a home screen there
      // is no address bar either. It saves first - which is why the label says
      // reload and not restart: nothing is lost and nothing starts over, the
      // page just comes back.
      { type: 'buttons', buttons: [
        { cmd: 'restart', label: 'Reload mbrd', closesPanel: true,
          title: () => 'Save and load the page again' },
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
        // The hint used to end "Opens in a new tab" and no longer can: the trip
        // is a navigation now (see patchNotes in commands/view.ts). What it says
        // instead is the thing somebody about to press it wants to know - that
        // the board is saved on the way out and is still there on the way back.
        { cmd: 'patch-notes', label: 'Patch notes', closesPanel: true,
          title: () => 'Every version since the first. Your board is saved and waiting when you come back' },
      ] },
      // Where the apps are, on the web, and the update check, in the app. Two
      // rows for the reason the Save pair is two: `when` belongs to a row.
      { type: 'buttons', when: () => !isDesktop(), buttons: [
        { cmd: 'get-app', label: 'Get the app', closesPanel: true,
          title: () => 'mbrd for Windows, macOS, Linux and Android, on GitHub. Opens in a new tab' },
      ] },
      { type: 'buttons', when: isDesktop, buttons: [
        // The answer is not in this panel - the desktop puts it in the title
        // bar, the phone in a toast and in the Update row at the top of the
        // Board tab - so the hint says an answer is coming rather than naming
        // a place that depends on which app this is.
        { cmd: 'check-updates', label: 'Check for updates', closesPanel: true,
          title: () => 'Ask for a newer mbrd. The answer comes back in a moment, and an update to install waits as a button' },
      ] },
    ],
  },
  {
    // Folded, and closed on arrival. Every row is a keyboard row: read once,
    // learned, then scrolled past forever - on a phone, where there is no
    // keyboard to read it for, scrolled past on the first visit.
    id: 'keys', tab: 'system', fold: 'Shortcuts', foldId: 'keys-fold',
    controls: [{ type: 'keys', keys: KEYS, advanced: true }],
  },
  {
    // Development aids, last of all: none of this is part of using a board. The
    // grip overlay paints the resize grab zones, corners and sides - invisible by design -
    // so their reach can be seen. Grips only show on a selected card.
    //
    // Folded, like the keyboard rows two sections up, and for a stronger version
    // of the same reason: a keyboard row is read once and scrolled past forever,
    // and these three are not read at all by anybody using a board. Three
    // permanent rows at the foot of the tab, none of which is about the board,
    // is the panel ending on a footnote. `fold` with no `title` is what makes the
    // summary stand where the heading did rather than hang off a list above it -
    // see buildFold() and the is-head class in ui/panel.ts.
    id: 'debug', tab: 'system', fold: 'Debug', foldId: 'debug-fold', needsBoard: true,
    controls: [
      { type: 'buttons', advanced: true, buttons: [
        // No `pressed` here on purpose: cmds.debugGrips writes aria-pressed
        // itself - the #grips URL and mbrd.debugGrips() drive the same toggle -
        // and a painted value would put the button back to false behind it.
        { cmd: 'debug-grips', label: 'Highlight resize grips', ariaPressed: 'false',
          closesPanel: true },
        // The frame profiler, which until now had no way in from the interface
        // at all - a console call or a URL fragment, on a tool whose whole point
        // is the device with neither. Writes its own aria-pressed for the reason
        // the grips row does: the fragment drives the same toggle.
        { cmd: 'debug-perf', label: 'Profile the frame', ariaPressed: 'false' },
        // Its own row rather than something the toggle prints on the way off:
        // the useful sequence is arm, drive the board, read, drive some more,
        // and turning it off to see the numbers would reset them.
        { cmd: 'debug-perf-report', label: 'Print the frame report' },
        // The profiler's scripted twin: the same preset moves on every device,
        // written out as a file (perf/bench.ts). It asks which board and then
        // either reloads onto the standard one or runs where it stands, so the
        // panel goes out of the way either way.
        { cmd: 'run-benchmark', label: 'Run benchmark', closesPanel: true,
          title: () => 'About two minutes of preset zooms and pans, then a file of the timings' },
        // The interface sounds, and the one row in this fold that is about
        // something you cannot see. Every cue that reaches cuelume/engine.ts,
        // with the reason where it made no sound - and the point of it is the
        // presses that produce *no line at all*, which are call sites that never
        // asked rather than sounds the engine dropped.
        //
        // `pressed` here, unlike the two rows above, and that difference is the
        // whole of the difference between the toggles: this one is remembered
        // across a reload, so a button that assumed it started off would be
        // wrong on every load after the first. cueLogOn() is askable, which is
        // what makes painting it right rather than a guess; the command writes
        // aria-pressed too, for the repaints in between.
        { cmd: 'debug-sound', label: 'Log interface sounds',
          pressed: () => cueLogOn() },
        { cmd: 'debug-sound-report', label: 'Print the cue log' },
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
        // In the apps a board is a file, so the question is where they are.
        { cmd: 'storage-state', label: 'Storage', when: () => !isDesktop() },
        { cmd: 'storage-state', label: 'Boards folder', when: isDesktop },
        { cmd: 'board-weight', label: 'What this board weighs' },
        // Not "Undo history", which is what it said and which reads as a
        // button that will do something to your undo history - close to the
        // opposite of what it does. A bare noun phrase in a panel where the
        // row above it toggles an overlay and the one below wipes the browser
        // is read as an action, so this one is phrased as the question it
        // answers, the way "Is my work safe?" three rows up is.
        { cmd: 'history-state', label: 'How much can be undone' },
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
        { cmd: 'clear-data', label: 'Clear everything', className: 'danger', closesPanel: 'if-done' },
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
 * this is true of everything, and ui/panel.ts writes no attribute at all.
 */
export const controlEnabled = (c: Control, section: Section, ctx: Ctx) =>
  !(ctx.patch && (c.needsBoard || section.needsBoard)) && !c.idle?.(ctx);

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

